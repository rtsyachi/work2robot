import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DemoObject, HardwareCheck, HwConfig, JobItem, Primitive, SavedRobotConfig, V2Run, V2State } from '../types'
import { VERDICT as FIT, VERDICT_OF } from '../lib/hwConfig'
import ContextBar, { scenarioField, workflowField } from '../components/ContextBar'
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

// 業務全体（Level 1）を5つの工程にまとめて進捗を出す（詳細な流れ図は Step 3）
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

/** ④ 仮想実行：選んだ構成で業務を実行し、3D・業務の進捗・判断を同じ実行トレースから連動させる */
const SCENARIOS = [
  { id: 'cage_cart_loading', label: 'カゴ車への混載荷物積付', active: true },
  { id: 'transport', label: '荷物の運搬', active: false },
  { id: 'sorting', label: '仕分け', active: false },
  { id: 'replenishment', label: '棚補充', active: false },
]
type Verdict = 'ok' | 'partial' | 'impossible'
const VERDICT: Record<Verdict, { text: string; cls: string; note: string }> = {
  ok: { text: '実行可能', cls: 'st-ok', note: 'すべての荷物を仮想環境で配置できた' },
  partial: { text: '部分実行可能', cls: 'st-unknown', note: '一部の荷物は持ち上げずに人へ引き継ぐ' },
  impossible: { text: '実行不可能', cls: 'st-ng', note: '1個も配置できない、または動作を表現できない構成（概念プレビュー）' },
}

/** ④ 仮想実行：シナリオと保存したロボット構成を選ぶ → 実行可否を判定 → 結果を確認 → 実行可能なら動画（3D再生）を生成して確認。
 *  判定は実行器の結果（仮想配置・引継ぎ）で決め、未確認の能力は区分を変えずに未検証事項として示す。模擬仕様に基づき、実機での実行を保証しない。 */
/** シミュレーション実行中の表示：段階を順に進め、終わると仮想動作のプレビューに切り替わる。
 *  プレビューは実行結果（実行トレース）から作る3D再生で、映像ファイルは生成しない */
const RUN_PHASES = ['ワークフローとロボット構成を読み込み中', '荷物ごとに判断・動作を計算中', '業務ルール・積付状態を確認中', '仮想動作のプレビューを作成中']
function RunProgress() {
  const [ms, setMs] = useState(0)
  useEffect(() => {
    const t0 = performance.now()
    const id = setInterval(() => setMs(performance.now() - t0), 100)
    return () => clearInterval(id)
  }, [])
  const per = RUN_MIN_MS / RUN_PHASES.length
  const cur = Math.min(RUN_PHASES.length - 1, Math.floor(ms / per))
  return (
    <section className="ex-running" data-testid="ex-running">
      <div className="ex-running-box">
        <div className="ex-spinner" />
        <div className="ex-running-title">シミュレーションを実行しています…</div>
        <div className="ex-running-bar"><span style={{ width: `${Math.min(97, (ms / RUN_MIN_MS) * 100)}%` }} /></div>
        <ol className="ex-running-steps">
          {RUN_PHASES.map((p, i) => <li key={p} className={i < cur ? 'is-done' : i === cur ? 'is-cur' : ''}>{i < cur ? '✓' : i === cur ? '…' : '・'} {p}</li>)}
        </ol>
        <div className="muted small">終わると、仮想ロボットの動作プレビューを自動で再生します</div>
      </div>
    </section>
  )
}
/** 実行ボタンを押してからプレビューを出すまでの最短の待ち時間（ミリ秒） */
export const RUN_MIN_MS = 2000

/** この画面で「シミュレーション実行」を押して得た結果（保存済みの結果を自動で読み込んだだけのものは、Step 5 では表示しない） */
const SHOWN = new WeakSet<V2Run>()

export default function ExecutionStep({ st, run: latestRun, config, running, onRun, onPlaying, onGoStep, saved, execId, onSelectExec, execCheck, batchId }: {
  st: V2State
  execCheck: HardwareCheck | null   // 選んだ構成の、今のワークフローの版・出荷予定の要件での照合（Step 4 と同じ）
  batchId: string
  run: V2Run | null
  config: HwConfig | null
  running: boolean
  onRun: () => void
  onPlaying: (p: boolean) => void
  onGoStep: (n: number) => void
  saved: SavedRobotConfig[]
  execId: string | null
  onSelectExec: (id: string) => void
}) {
  // 実行が終わった（running が true → false）ときの結果だけを表示対象にする
  const [, bump] = useState(0)
  const prevRunning = useRef(running)
  useEffect(() => {
    if (prevRunning.current && !running && latestRun) { SHOWN.add(latestRun); bump((n) => n + 1) }
    prevRunning.current = running
  }, [running, latestRun])
  const run = latestRun && SHOWN.has(latestRun) ? latestRun : null
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
  const verdict: Verdict | null = !job ? null : blocked ? 'impossible' : job.end.handed_off > 0 ? 'partial' : 'ok'
  // 「シミュレーション実行」が終わったら、実行できる範囲の3D再生を始める（実行不可能なら再生しない）。
  // 保存済みの結果を開いただけのときは自動では再生しない
  const wasRunning = useRef(false)
  useEffect(() => {
    setT(0); setDismissed(false)
    setPlaying(wasRunning.current && !!job && !(job.end.placed === 0 || buildTimeline(job).mode === 'concept'))
  }, [job])
  useEffect(() => { wasRunning.current = running || (wasRunning.current && !job) }, [running, job])
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

  // 判定結果：未検証事項（仕様照合で判断不可の能力・未確認の印の荷物・実行器で未対応の規則）
  const checkUnknown = (run?.check?.results ?? []).filter((r) => r.status === 'unknown' || r.status === 'partial')
  const unverifiedItems = (job?.items ?? []).filter((i) => i.outcome === 'placed' && (i.capability?.unverified.length ?? 0) > 0)
  const placedItems = (job?.items ?? []).filter((i) => i.outcome === 'placed')
  // 引継ぎの理由を、Step 4 の照合で分かっていた能力不足と、実行して初めて分かったもの（置き場所・積載上限など）に分ける
  const knownHanded = handed.filter((h) => h.capability?.status === 'ng')
  const newHanded = handed.filter((h) => h.capability?.status !== 'ng')
  // 選んだ構成の Step 4 の照合（今の要件で取り直したもの）と、保存時の版・出荷予定との違い
  const exec = saved.find((c) => c.id === execId) ?? null
  const vc = execCheck ? (['can', 'cannot', 'unknown'] as const).map((v) => [v, execCheck.results.filter((r) => VERDICT_OF[r.status] === v).length] as const) : []
  const basisDiff = exec?.basis ? [
    exec.basis.workflow_id && exec.basis.workflow_id !== st.refs.workflow_id ? 'ワークフローの版' : null,
    exec.basis.batch_id !== batchId ? '出荷予定' : null,
  ].filter(Boolean) : []
  const batch = st.batches.find((b) => b.batch_id === batchId)
  const wfLabel = st.refs.workflow_id ? `確認済みの版（工程${st.extraction?.process?.stages?.length ?? '—'}）` : '手書きの業務定義（未生成）'
  // 実行条件のバリデーション：シナリオ・ワークフローが決まっていて、選んだ構成がその業務要件を満たす（対応不可なし）ときだけ実行できる。
  // 判断不可（未検証の能力）は実行できるが、未検証のまま実行することを示す
  const cannot = (execCheck?.results ?? []).filter((r) => VERDICT_OF[r.status] === 'cannot')
  const unknownCaps = (execCheck?.results ?? []).filter((r) => VERDICT_OF[r.status] === 'unknown')
  const problems: string[] = [
    ...(!st.scenario ? ['シナリオが選ばれていません（Step 2 でシナリオを作成）'] : []),
    ...(!st.refs.workflow_id ? ['ワークフローが生成されていません（Step 2 で生成し、Step 3 で確認）'] : []),
    ...(!config ? ['ロボット構成が選ばれていません（Step 4 で構成を確定）'] : []),
    ...(cannot.length ? [`選んだロボット構成は、このワークフローの業務要件を満たしていません（対応不可 ${cannot.length}件：${cannot.map((r) => r.label).join('、')}）`] : []),
  ]
  const checking = !!config && !execCheck
  const canRun = problems.length === 0 && !checking && !running
  // ① 実行条件：シナリオ・ワークフロー・ロボット構成（それぞれ選択） → ② シミュレーション実行
  const setup = (
    <section className="ex-setup" data-testid="ex-setup">
      {/* 上部の共通の帯（Step 3〜6 と同じ）。ワークフローは判定・実行が今の版でだけ行えるため、選択肢は今の版だけ */}
      <ContextBar caption="実行条件" fields={[
        scenarioField(st, 'ex-scenario'),
        { ...workflowField(st, 'ex-workflow'), options: [{ value: 'current', label: wfLabel }], selected: 'current', onChange: () => undefined,
          title: `ワークフローID ${st.refs.workflow_id ?? '—'}。過去の版での実行は未対応（Step 3 で版を戻すと、その版で実行します）` },
        { key: 'config', label: 'ロボット構成', value: '', selected: execId ?? '', onChange: onSelectExec, testid: 'ex-config', id: execId,
          options: saved.length ? saved.map((c) => ({ value: c.id, label: c.name })) : [{ value: '', label: '保存した構成がありません（Step 4 で保存）' }] },
      ]}>
        <button className="btn-primary ex-run" onClick={onRun} disabled={!canRun} data-testid="run-job"
          title={problems.length ? '実行条件を満たしていません' : checking ? '業務要件との照合中' : ''}>{running ? '実行中…' : '▶ シミュレーション実行'}</button>
      </ContextBar>
      {problems.length > 0 && (
        <div className="ex-invalid" data-testid="ex-invalid">
          <strong>この条件ではシミュレーションを実行できません</strong>
          <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          {cannot.length > 0 && <button className="link" onClick={() => onGoStep(3)} data-testid="go-step4">Step 4 で構成を見直す</button>}
        </div>
      )}
      {problems.length === 0 && unknownCaps.length > 0 && (
        <div className="ex-warn" data-testid="ex-warn">判断不可 {unknownCaps.length}件（{unknownCaps.map((r) => r.label).join('、')}）は未検証のまま実行します。結果は実機での成功を示しません。</div>
      )}
      {execCheck && (
        <div className="ex-fit small" data-testid="ex-fit" title="Step 4 と同じ照合（今のワークフローの版・出荷予定の業務要件）">
          この構成の業務要件との適合：{vc.map(([v, n]) => <span key={v} className={`hb ${FIT[v].cls}`}>{FIT[v].text} {n}</span>)}
          {basisDiff.length > 0 && <span className="hw-unknown">　保存時と{basisDiff.join('・')}が違うため、今の要件で照合し直しました</span>}
          <button className="link" onClick={() => onGoStep(3)}>Step 4 で構成を変える</button>
        </div>
      )}
    </section>
  )
  // 実行結果サマリー（右）：総合判定と件数
  const unverifiedCount = checkUnknown.length + unverifiedItems.length + unsupported.length
  const summary = job && verdict && (
    <div className="ex-card ex-summary" data-testid="ex-summary">
      <div className={`ex-sum-verdict ${VERDICT[verdict].cls}`} data-testid="ex-verdict-badge">{VERDICT[verdict].text}</div>
      <div className="small muted">{VERDICT[verdict].note}</div>
      <table className="spec-table ex-sum-table"><tbody>
        <tr><th>対象荷物</th><td>{job.items.length}個</td></tr>
        <tr><th>仮想処理完了</th><td>{job.end.placed}個</td></tr>
        <tr><th>人への引継ぎ</th><td className={job.end.handed_off ? 'hw-ng' : ''} data-testid="ex-sum-handed">{job.end.handed_off}個</td></tr>
        <tr><th>未処理</th><td>{Math.max(0, job.items.length - job.end.placed - job.end.handed_off)}個</td></tr>
        <tr><th>未検証事項</th><td className={unverifiedCount ? 'hw-unknown' : ''}>{unverifiedCount}件</td></tr>
      </tbody></table>
      <div className="small muted">3D再生は、この実行の結果（実行トレース）から作った仮想ロボットの動きです（事前に用意した映像ではありません）。模擬仕様に基づく判定で、実機での実行は保証しません。</div>
    </div>
  )
  // 詳細結果（下・折りたたみ）
  const verdictPanel = (
    <div className="ex-verdict" data-testid="ex-verdict">
      {!job ? (
        <div className="ex-empty static">
          <p>実行条件を確認して「シミュレーション実行」を押してください。実行可否を判定し、実行できる範囲を3Dで再生します。{!saved.some((c) => c.source === 'saved') && '（Step 4 で構成を保存すると、ここで選べます）'}</p>
        </div>
      ) : (
        <details className="ex-details" data-testid="ex-details">
          <summary>詳細結果（実行できた荷物・できなかった荷物と理由・業務ルール・未検証事項）
            {run?.execution && <span className="small muted" data-testid="ex-execution">　実行ID {run.execution.execution_id}（保存済み・Step 6 で参照）</span>}</summary>
          <div className="ex-verdict-grid">
            <section className="ex-card">
              <div className="sec-title small">実行できる荷物（{placedItems.length}個）</div>
              <div className="small">{placedItems.map((i) => i.object_id).join('・') || 'なし'}</div>
              <div className="sec-title small">業務の規則（タスク）</div>
              <ul className="small">{(job.rule_results ?? []).map((r, i) => <li key={i}><span className={r.status === 'applied' ? 'hw-ok' : r.status === 'unsupported' ? 'hw-ng' : 'hw-unknown'}>{r.status === 'applied' ? '○ 実行' : r.status === 'unsupported' ? '× 実行器で未対応' : '− 対象なし'}</span> {r.label}</li>)}</ul>
            </section>
            <section className="ex-card" data-testid="ex-handed">
              <div className="sec-title small">実行できない荷物と理由（{handed.length}個）</div>
              {handed.length === 0 && <div className="small muted">なし</div>}
              {knownHanded.length > 0 && <>
                <div className="small muted" data-testid="ex-handed-known">Step 4 の照合で判明済み（能力不足）</div>
                <ul className="small">{knownHanded.map((h) => <li key={h.object_id}><strong>{h.object_id}</strong>：{h.handoff_reason}</li>)}</ul>
              </>}
              {newHanded.length > 0 && <>
                <div className="small hw-unknown" data-testid="ex-handed-new">実行して判明（置き場所・積載上限など）</div>
                <ul className="small">{newHanded.map((h) => <li key={h.object_id}><strong>{h.object_id}</strong>：{h.handoff_reason}</li>)}</ul>
              </>}
              {blocked && handed.length > 0 && <div className="small" data-testid="ex-blocked">主な原因：<strong>{mainCause(handed)}</strong>（{job.items.length}個中{job.end.handed_off}個が処理対象外）</div>}
            </section>
            <section className="ex-card" data-testid="ex-unverified">
              <div className="sec-title small">未検証事項（区分には含めず、実機PoCで確かめる）</div>
              <ul className="small">
                {checkUnknown.map((r) => <li key={r.id}>判断不可の能力：{r.label}</li>)}
                {unverifiedItems.map((i) => <li key={i.object_id}>荷物{i.object_id}：{i.capability!.unverified.join('・')}は未確認</li>)}
                {unsupported.map((r, i) => <li key={`u${i}`}>実行器で未対応の規則：{r.label}</li>)}
                <li>実機での把持・干渉・安定性・安全性（仮想実行では検証しない）</li>
              </ul>
            </section>
          </div>
        </details>
      )}
    </div>
  )

  return (
    <div className={`step-page execution ${job && problems.length === 0 ? 'is-video' : 'is-verdict'}`} data-testid="page-4">
      {setup}
      {/* 実行中は、結果の代わりに進み具合を出す（終わると仮想動作のプレビューを自動で再生） */}
      {running && problems.length === 0 ? <RunProgress /> :
      /* 実行条件を満たさないときは、以前の結果も出さない */
      !job || problems.length > 0 ? (problems.length > 0 ? null : verdictPanel) : (<>
      <section className="ex-progress" data-testid="l1-progress">
        {L1_PHASES.map((p, i) => (
          <div key={p} className={`exp-chip ${i === phaseIdx ? 'is-active' : ''} ${i < phaseIdx ? 'is-done' : ''}`}>
            <span className="exp-n">{i + 1}</span>{p}
            {i === 2 && <span className="exp-loop" title="荷物ごとに繰り返す">↻ 荷物ごと</span>}
          </div>
        ))}
        <div className="exp-count">
          {job ? <>処理 <strong>{done.length}</strong>/{job.items.length}　配置 {done.length - handedSoFar}・<span className={handedSoFar ? 'hw-ng' : ''}>引継ぎ {handedSoFar}</span></> : '未実行'}
          <span className="muted small">　詳細なLevel 1はStep 3</span>
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
                <button className="run" onClick={() => onGoStep(3)} data-testid="back-step3">Step 4で構成を変更</button>
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
          {summary}
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
            <details className="ex-card ex-now-more" data-testid="ex-now-more">
            <summary className="small">再生中の荷物の判断・動作・経路</summary>
            <div className="ex-card" data-testid="ex-decision">
              <div className="sec-title small">現在の判断</div>
              <ul className="exd-list">{decisions(curItem, job?.items.length ?? 0).map((d) => <li key={d}>{d}</li>)}</ul>
            </div>
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
            <div className="ex-card" data-testid="ex-judge">
              <div className="sec-title small">判定</div>
              {cap?.status === 'ng' && <div className="small hw-ng">× 不足：{cap.ng.join('、')}</div>}
              {cap?.status === 'unknown' && <div className="small hw-unknown">？ 未確認：{cap.unverified.join('、')}（実機PoCで確かめる）</div>}
              {(cap?.status === 'ok' || !cap) && curItem.outcome === 'placed' && <div className="small hw-ok">○ 仕様上対応（このカタログの仕様値で）</div>}
              {curItem.outcome === 'handed_off' && cap?.status !== 'ng' && <div className="small hw-ng">人へ引継ぎ：{curItem.handoff_reason}</div>}
              <div className="small muted">実機での把持・安定性は未検証</div>
            </div>
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
            </details>
          )}
          <div className="ex-card" data-testid="ex-cart">
            <div className="sec-title small">カゴ車の状態（仮想）</div>
            <div className="small">
              {lastDone?.cart_after
                ? `${lastDone.cart_after.count}個・${lastDone.cart_after.load_kg}kg／上限${job?.cart.max_load_kg ?? '—'}kg・重心のずれ ${lastDone.cart_after.com_offset_m}m`
                : '空'}
            </div>
          </div>
        </aside>
      </div>
      <div className="player-bar" data-testid="player">
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
      {verdictPanel}
      </>)}
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
