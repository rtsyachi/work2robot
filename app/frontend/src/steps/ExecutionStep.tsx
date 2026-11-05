import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DemoObject, HwConfig, JobItem, Primitive, V2Run, V2State } from '../types'
import Robot3D, { type CamMode } from '../components/Robot3D'
import WorkflowGraph from '../components/WorkflowGraph'
import VideoPane from '../components/VideoPane'
import { PHASE_LABEL, buildTimeline, sampleTimeline } from '../lib/robotTimeline'
import { objectRanges } from '../lib/videoSync'

const KIND_LABEL: Record<string, string> = {
  recognize: '認識：荷物の属性を確認',
  check: '能力の確認：この構成では持ち上げない',
  pick: 'Pick：つかんで持ち上げる',
  move: 'Move：カゴ車へ運ぶ',
  place: 'Place：置く',
  handoff: '人へ引継ぎ',
}

// 業務全体（Level 1）を5つの工程にまとめて進捗を出す（詳細な流れ図は Step 2）
const L1_PHASES = ['準備', '荷物の確認・選択', '荷物ごとの判断と積付', 'カゴ車の状態更新', '終了判定']

const RULE_TEXT: Record<string, string> = {
  brick_pattern: 'レンガ積みの枠に置く（同じ寸法の箱をそろえる）',
  balance_load: '偏荷重を避ける位置を選ぶ',
  full_support: '下の箱で底面全体を支える',
  no_stack_last: '上積み厳禁の荷物は最後に置き、上に載せない',
}

function itemColor(o?: DemoObject): string {
  const a = o?.attributes ?? {}
  const id = o?.object_id ?? ''
  if (a.material_class?.value === 'soft') return id === 'S2' ? '#2f7a5a' : '#3f6ea5'
  if (a.material_class?.value === 'rigid') return ({ H: '#9a7448', M: '#c9a46b', W: '#b08955', L: '#e3cfa4' } as Record<string, string>)[id[0]] ?? '#c9a46b'
  return '#adb5bd'
}

/** 現在の荷物について、業務の規則から来た判断（表示用の言い換えだけ。判定は実行器の結果） */
function decisions(it: JobItem, total: number): string[] {
  const out: string[] = []
  if (it.outcome === 'handed_off') return [it.handoff_reason ?? '置き方・置き場所が決まらない']
  out.push(`積む順番：${it.seq + 1}／${total}番目`)
  if (it.zone === 'bottom') out.push('重い荷物のため下段（床面）に置く')
  if (it.zone === 'top') out.push('軽い荷物のため上段に置く')
  if (it.placement) out.push(it.placement.support ? `${it.placement.support}の上に置く（高さ${it.placement.base_height ?? 0}m）` : '床に置く（奥から詰める）')
  if (it.placement?.rotated) out.push('向きを変えて置く（カゴ車に収まる向き）')
  if (it.press_mode === 'no_press') out.push('押し込まずにそっと置く')
  if (it.stack_above === 'forbidden') out.push('上積み厳禁：この上には載せない')
  for (const r of it.applied_rules ?? []) if (RULE_TEXT[r] && !out.includes(RULE_TEXT[r])) out.push(RULE_TEXT[r])
  if (it.provisional) out.push('暫定動作（説明・動画に例がない。確認事項に残す）')
  return out
}

function ruleTags(it: JobItem, placed: boolean): string[] {
  if (!placed) return []
  const t: string[] = []
  if (it.stack_above === 'forbidden') t.push('上積み厳禁')
  return t
}

function l1Phase(p: Primitive | null, phase: string, finished: boolean, started: boolean): number {
  if (finished) return 4
  if (!p) return started ? 3 : 0
  if (p.kind === 'recognize') return 1
  if (p.kind === 'place' && phase === 'retreat') return 3
  return 2
}

/** 処理できなかった荷物の主な原因（能力の不足の項目を数える） */
function mainCause(items: JobItem[]): string {
  const count: Record<string, number> = {}
  for (const it of items) {
    const reason = it.handoff_reason ?? '不明'
    const keys = it.capability?.ng?.length
      ? it.capability.ng.map((s) => s.split(/[（(：:]/)[0])
      : [reason.startsWith('カゴ車に置ける場所がない') ? (reason.includes('リーチ') ? '届く範囲に置き場所がない（リーチ・支持などの条件）' : 'カゴ車に置き場所がない') : reason.split(/[（(]/)[0]]
    for (const k of new Set(keys)) count[k] = (count[k] ?? 0) + 1
  }
  return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${k}（${n}個）`).join('、')
}

/** ④ 仮想ロボット実行：選んだ構成で業務を実行し、3D・業務の進捗・判断を同じ実行トレースから連動させる */
export default function ExecutionStep({ st, run, config, running, onRun, onPlaying, onGoStep }: {
  st: V2State
  run: V2Run | null
  config: HwConfig | null
  running: boolean
  onRun: () => void
  onPlaying: (p: boolean) => void
  onGoStep: (n: number) => void
}) {
  const job = run?.job ?? null
  const tl = useMemo(() => (job ? buildTimeline(job) : null), [job])
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [compare, setCompare] = useState(false)
  const [cam, setCam] = useState<CamMode>('follow')
  const [showL2, setShowL2] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const concept = tl?.mode === 'concept'
  const blocked = !!job && (job.end.placed === 0 || concept)
  // 新しい実行結果が来たら最初から再生する（何も置けない構成・概念プレビューは自動再生しない）
  useEffect(() => { setT(0); setDismissed(false); setPlaying(!!job && !(job.end.placed === 0 || job.robot?.product?.execution === 'concept')) }, [job])
  useEffect(() => { onPlaying(playing) }, [playing, onPlaying])
  useEffect(() => () => onPlaying(false), [onPlaying])  // 画面を離れたら「実行中」を解除
  useEffect(() => {
    if (!playing || !tl) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      setT((prev) => {
        const next = Math.min(prev + dt * speed, tl.duration)
        if (next >= tl.duration) setPlaying(false)
        return next
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, tl, speed])

  const colors = useMemo(() => Object.fromEntries(st.objects.map((o) => [o.object_id, itemColor(o)])), [st.objects])
  const soft = useMemo(() => Object.fromEntries(st.objects.map((o) => [o.object_id, o.attributes?.material_class?.value === 'soft'])), [st.objects])
  const ranges = useMemo(() => objectRanges(st.extraction?.inputs?.observations.segments ?? []), [st.extraction])
  const starts = useMemo(() => {
    const out: { id: string; t: number }[] = []
    tl?.segments.forEach((s) => { if (!out.some((x) => x.id === s.primitive.object_id)) out.push({ id: s.primitive.object_id, t: s.start }) })
    return out
  }, [tl])
  const onCamUser = useCallback(() => setCam('free'), [])

  const sample = tl ? sampleTimeline(tl, t) : null
  const finished = !!tl && t >= tl.duration
  const current = sample?.current?.primitive ?? null
  const curId = current?.object_id ?? (finished ? job?.order[job.order.length - 1] ?? null : null)
  const curItem = job?.items.find((i) => i.object_id === curId) ?? null
  const done = job ? job.items.filter((i) => ['placed', 'handed_off'].includes(sample?.items[i.object_id]?.state ?? '')) : []
  const lastDone = done.length ? job!.items.find((i) => i.object_id === done[done.length - 1].object_id) : null
  const handed = job?.items.filter((i) => i.outcome === 'handed_off') ?? []
  const handedSoFar = done.filter((i) => i.outcome === 'handed_off').length
  const phaseIdx = job ? l1Phase(current, sample?.phase ?? 'idle', finished, t > 0) : -1
  const unsupported = (job?.rule_results ?? []).filter((r) => r.status === 'unsupported')
  const productName = job?.robot?.product?.name ?? job?.robot?.label ?? '選択した構成'

  let caption = ''
  if (concept && job) caption = '概念プレビュー：この機種の動作は表現しません（能力の照合結果のみ）'
  else if (current) {
    caption = `荷物${current.object_id}　${KIND_LABEL[current.kind]}`
    if (sample) caption += `　―　${PHASE_LABEL[sample.phase]}`
    if (current.kind === 'place') {
      if (current.rotated) caption += '（向きを変えて置く）'
      if (current.press_mode === 'no_press') caption += '（押し込まない）'
      if (current.unverified?.length) caption += '【この構成で未確認】'
    }
    if (current.kind === 'check' || current.kind === 'handoff') caption += `：${current.reason ?? ''}`
  } else if (finished && job) {
    caption = `積付を終了（仮想）：配置 ${job.end.placed}個・人へ引継ぎ ${job.end.handed_off}個`
  }
  const jump = (dir: 1 | -1) => {
    if (!starts.length) return
    const idx = starts.findIndex((s) => s.t > t + 0.01)
    const cur = idx === -1 ? starts.length - 1 : idx - 1
    const to = Math.max(0, Math.min(starts.length - 1, dir === 1 ? cur + 1 : cur - (t - (starts[cur]?.t ?? 0) < 0.5 ? 1 : 0)))
    setT(starts[to].t)
  }
  const range = curId ? ranges[curId] ?? null : null
  const motion = ['pick', 'move', 'place'] as const
  const cap = curItem?.capability
  const l2Path = (curItem?.item_trace.steps ?? []).filter((s) => s.node_type === 'decision' || s.skill_event || s.node_type === 'handoff')

  return (
    <div className="step-page execution" data-testid="page-4">
      <section className="ex-progress" data-testid="l1-progress">
        {L1_PHASES.map((p, i) => (
          <div key={p} className={`exp-chip ${i === phaseIdx ? 'is-active' : ''} ${i < phaseIdx ? 'is-done' : ''}`}>
            <span className="exp-n">{i + 1}</span>{p}
            {i === 2 && <span className="exp-loop" title="荷物ごとに繰り返す">↻ 荷物ごと</span>}
          </div>
        ))}
        <div className="exp-count">
          {job ? <>処理 <strong>{done.length}</strong>/{job.items.length}　配置 {done.length - handedSoFar}・<span className={handedSoFar ? 'hw-ng' : ''}>引継ぎ {handedSoFar}</span></> : '未実行'}
          <span className="muted small">　詳細なLevel 1はStep 2</span>
        </div>
      </section>
      <div className="ex-main">
        <div className={`ex-stage ${compare ? 'is-compare' : ''}`}>
          {compare && (
            <div className="ex-human" data-testid="compare-human">
              <VideoPane
                src={st.video_url} muted={false} range={range} follow={playing} seek={null}
                title={curId ? `人の作業：荷物${curId}を扱う場面（観測テキストのタグから特定）` : '人の作業'}
                missingNote={curId && !range ? `荷物${curId}を扱う場面は観測テキストから特定できないため、動画は同期しません` : null}
              />
            </div>
          )}
          <Robot3D job={job} sample={sample} tl={tl} colors={colors} soft={soft} caption={caption} camMode={cam} onCamUser={onCamUser} ruleTags={ruleTags} />
          {concept && job?.robot?.product && (
            <div className="concept-banner" data-testid="concept-banner">
              概念プレビュー：{job.robot.product.execution_note}。置けた荷物も、動作が成立することは示していません。
            </div>
          )}
          {blocked && !dismissed && job && (
            <div className="ex-blocked" data-testid="ex-blocked">
              <div className="exb-title">
                {job.end.placed === 0
                  ? <>選択した{productName}では、{job.items.length}個中{job.end.handed_off}個が処理対象外</>
                  : <>{productName}は概念プレビュー：配置{job.end.placed}個は能力の照合のみで、動作は表現しません</>}
              </div>
              {handed.length > 0 && <div>主な原因：<strong>{mainCause(handed)}</strong></div>}
              {concept && <div className="small">二足歩行・双腕での運搬はこのシミュレータで表現していないため、他の機体の動きを流用して動いたように見せません。</div>}
              <div className="exb-actions">
                <button className="run" onClick={() => onGoStep(3)} data-testid="back-step3">Step 3で構成を変更</button>
                <button className="secondary-btn" onClick={() => setDismissed(true)} data-testid="show-judgements">判定を1件ずつ見る</button>
              </div>
            </div>
          )}
          {!job && (
            <div className="ex-empty">
              <p>構成「{config?.source === 'claude' ? 'Claudeの推奨構成' : config?.label}」で、まだ実行していません。</p>
              <button className="run big" onClick={onRun} disabled={running} data-testid="run-job">{running ? '実行中…' : '▶ この構成で仮想ロボットに積ませる'}</button>
            </div>
          )}
        </div>
        <aside className="ex-side">
          <div className="ex-card ex-now" data-testid="ex-current">
            <div className="sec-title small">現在の作業</div>
            {curItem ? (
              <>
                <div className="exn-head">
                  荷物{curItem.object_id}
                  {curItem.outcome === 'placed' ? (curItem.zone === 'bottom' ? 'を下段に配置' : curItem.zone === 'top' ? 'を上段に配置' : 'をカゴ車に配置') : 'を人へ引継ぎ'}
                </div>
                <div className="small muted">{st.objects.find((o) => o.object_id === curItem.object_id)?.description}{curItem.weight_kg != null && `・${curItem.weight_kg}kg`}</div>
              </>
            ) : <div className="muted small">実行すると、作業中の荷物と動作が表示されます。</div>}
          </div>
          {curItem && (
            <div className="ex-card" data-testid="ex-decision">
              <div className="sec-title small">現在の判断</div>
              <ul className="exd-list">{decisions(curItem, job?.items.length ?? 0).map((d) => <li key={d}>{d}</li>)}</ul>
            </div>
          )}
          {curItem && (
            <div className="ex-card" data-testid="ex-motion">
              <div className="sec-title small">実行中の動作</div>
              {curItem.outcome === 'placed' ? (
                <div className="exm-row">
                  {motion.map((k, i) => (
                    <span key={k} className={`exm-chip ${current?.kind === k ? 'is-on' : ''}`}>{i > 0 && <em>→</em>}{k[0].toUpperCase() + k.slice(1)}</span>
                  ))}
                </div>
              ) : (
                <div className="exm-row"><span className={`exm-chip ${current?.kind === 'check' ? 'is-ng' : ''}`}>確認（持ち上げない）</span><em>→</em><span className={`exm-chip ${current?.kind === 'handoff' ? 'is-ng' : ''}`}>人へ引継ぎ</span></div>
              )}
              <div className="small muted">{sample && current ? PHASE_LABEL[sample.phase] : '—'}</div>
            </div>
          )}
          {curItem && (
            <div className="ex-card" data-testid="ex-judge">
              <div className="sec-title small">判定</div>
              {cap?.status === 'ng' && <div className="small hw-ng">× 不足：{cap.ng.join('、')}</div>}
              {cap?.status === 'unknown' && <div className="small hw-unknown">？ 未確認：{cap.unverified.join('、')}（実機PoCで確かめる）</div>}
              {(cap?.status === 'ok' || !cap) && curItem.outcome === 'placed' && <div className="small hw-ok">○ 仕様上対応（このカタログの仕様値で）</div>}
              {curItem.outcome === 'handed_off' && cap?.status !== 'ng' && <div className="small hw-ng">人へ引継ぎ：{curItem.handoff_reason}</div>}
              <div className="small muted">実機での把持・安定性は未検証</div>
            </div>
          )}
          {curItem && (
            <div className="ex-card" data-testid="ex-l2">
              <div className="sec-title small">判断経路（Level 2）：荷物{curItem.object_id}</div>
              <ol className="exl2-path" data-testid="l2-path">
                {l2Path.map((s) => (
                  <li key={s.index} className={s.node_type === 'handoff' ? 'hw-ng' : ''}>
                    {s.label ?? s.node_id}
                    {s.node_type === 'decision' && <span className="exl2-r">{s.result === 'true' ? 'はい' : s.result === 'false' ? 'いいえ' : s.result === 'unknown' ? '不明' : s.result ?? ''}</span>}
                  </li>
                ))}
              </ol>
              <button className="link-btn" onClick={() => setShowL2(true)} data-testid="open-l2">詳細ワークフローを見る</button>
            </div>
          )}
          <div className="ex-card" data-testid="ex-cart">
            <div className="sec-title small">カゴ車の状態（仮想）</div>
            <div className="small">
              {lastDone?.cart_after
                ? `${lastDone.cart_after.count}個・${lastDone.cart_after.load_kg}kg／上限${job?.cart.max_load_kg ?? '—'}kg・重心のずれ ${lastDone.cart_after.com_offset_m}m`
                : '空'}
            </div>
          </div>
          {unsupported.length > 0 && (
            <div className="ex-card" data-testid="ex-unsupported">
              <div className="sec-title small">実行器で未対応の規則（要確認）</div>
              <ul className="small">{unsupported.map((r, i) => <li key={i}>{r.label}</li>)}</ul>
            </div>
          )}
          {handed.length > 0 && (
            <details className="ex-card" open={handed.length <= 6} data-testid="ex-handed">
              <summary>この構成で実行できなかった荷物（{handed.length}個）</summary>
              <ul className="small">{handed.map((h) => <li key={h.object_id}><strong>{h.object_id}</strong>：{h.handoff_reason}</li>)}</ul>
            </details>
          )}
        </aside>
      </div>
      <div className="player-bar" data-testid="player">
        <button onClick={onRun} disabled={running} className="secondary-btn">{job ? '再実行' : '実行'}</button>
        <button onClick={() => { if (tl && t >= tl.duration) setT(0); setPlaying(!playing) }} disabled={!job} data-testid="play">{playing ? '❚❚ 一時停止' : '▶ 再生'}</button>
        <button onClick={() => jump(-1)} disabled={!job}>◀ 前の荷物</button>
        <button onClick={() => jump(1)} disabled={!job} data-testid="next-item">次の荷物 ▶</button>
        <button onClick={() => { if (tl) { setT(tl.duration); setPlaying(false) } }} disabled={!job} data-testid="to-end">最後へ</button>
        <span className="speed">
          速度
          {[0.5, 1, 2, 4].map((s) => <button key={s} className={speed === s ? 'is-on' : ''} onClick={() => setSpeed(s)} data-testid={`speed-${s}`}>{s}×</button>)}
        </span>
        <input type="range" min={0} max={tl?.duration ?? 1} step={0.05} value={t} disabled={!job}
          onChange={(e) => { setT(Number(e.target.value)); setPlaying(false) }} />
        <span className="speed">
          視点
          {([['follow', '追従'], ['overview', '全体'], ['cart', 'カゴ車'], ['free', '自由']] as [CamMode, string][]).map(([m, l]) => (
            <button key={m} className={cam === m ? 'is-on' : ''} onClick={() => setCam(m)} data-testid={`cam-${m}`}>{l}</button>
          ))}
        </span>
        <label className="compare-toggle"><input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} data-testid="compare" /> 人間と比較</label>
      </div>
      {showL2 && curItem && (
        <div className="modal-back" onClick={() => setShowL2(false)}>
          <div className="modal-l2" onClick={(e) => e.stopPropagation()} data-testid="l2-modal">
            <div className="modal-head">荷物1個の判断（Level 2）：荷物{curItem.object_id}の経路 <button onClick={() => setShowL2(false)}>閉じる</button></div>
            <div className="graph modal-graph"><WorkflowGraph workflow={st.workflow} trace={curItem.item_trace} selectedId={null} onSelect={() => {}} /></div>
          </div>
        </div>
      )}
    </div>
  )
}
