import { useState } from 'react'
import type { CheckResult, CheckStatus, HardwareCheck, ProductConfig, Requirement, RobotSummary, SavedRobotConfig, V2State } from '../types'
import { saveRobotConfig } from '../api'
import EvidenceChips, { type SegmentMap } from '../components/Evidence'
import { PartIcon } from '../components/RobotFigure'
import ProductRender from '../components/ProductRender'
import ContextBar, { scenarioField, workflowField } from '../components/ContextBar'
import {
  PART_TITLE, SHORT, STATUS, TYPE_LABEL, VERDICT, VERDICT_OF, bestForProduct, comp, product, productDefault, relatedReqs,
  toParts, type PartKind, type Verdict,
} from '../lib/hwConfig'

const WORST: CheckStatus[] = ['ng', 'partial', 'unknown', 'ok']
const KINDS: PartKind[] = ['end_effector', 'sensor', 'peripheral', 'arm', 'base']
const VERDICTS: Verdict[] = ['cannot', 'unknown', 'can']   // 一覧は対応不可 → 判断不可 → 対応可能の順
const RULE_NAME: Record<string, string> = {
  order_by_weight_desc: '重い順に下から', no_stack_last: '上積み禁止は最後', brick_pattern: 'レンガ積み', balance_load: '偏荷重の回避',
  full_support: '底面の支持', load_limit: '積載上限', height_limit: '高さの上限', overhang_check: 'はみ出し確認', balance_check: '偏りの確認',
}

// スペック表の項目名（部品の能力）と値。判定は変えず、表示の呼び方だけ
const CAP_NAME: Record<string, string> = {
  payload: '可搬質量', object_size: '把持サイズ', reach: 'リーチ', grasp_box: '箱物ハンドリング', grasp_soft_bag: '軟包装物ハンドリング',
  place_no_press: '力制御（低押圧配置）', rotate_90: 'ワーク姿勢変更（90°）', mobility: '搬送・移動', sense_id: 'ラベル・ID読取',
  sense_dims: '寸法・位置計測', sense_weight: '重量計測', sense_material: '材質判別',
}
const CAP_VAL: Record<CheckStatus, string> = { ok: '○ 対応', partial: '△ 一部対応', unknown: '△ 要検証', ng: '× 非対応' }
const mm = (m: number | undefined) => (m == null ? '—' : `${Math.round(m * 1000).toLocaleString()}mm`)

function Badge({ s }: { s: CheckStatus | null }) {
  if (!s) return <span className="hb hb-none">関係</span>
  return <span className={`hb ${STATUS[s].cls}`} title={STATUS[s].meaning}>{STATUS[s].mark} {STATUS[s].text}</span>
}

/** ③ ロボット構成の仮選定：機種を選ぶ → 中央のモデルで構成を確認 → 変更できる部位（●）を選ぶ → 右で部品を替える → 上の業務要求の対応を確認 */
export default function HardwareStep({ st, config, onConfig, check, profile, source, segments, onSeek, saved, onSaved, batchId, onGoStep }: {
  st: V2State
  batchId: string                       // 業務要件を導く出荷予定（シナリオの対象）
  onGoStep: (n: number) => void
  config: ProductConfig
  onConfig: (c: ProductConfig) => void
  check: HardwareCheck | null
  profile: RobotSummary | null
  source: 'claude' | 'custom' | null
  segments: SegmentMap
  onSeek: (t: string) => void
  saved: SavedRobotConfig[]
  onSaved: (c: SavedRobotConfig) => void
}) {
  // 構成名：初期値は機種名（機種を替えると機種名に戻す）。機種名の右で書き換えられる
  const [name, setName] = useState('')
  const [nameFor, setNameFor] = useState<string | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const doSave = () => {
    setSaveMsg(null)
    saveRobotConfig(name, config, batchId).then((c) => { setSaveMsg(`「${c.name}」を保存しました（このワークフローの版・出荷予定で選定したと記録）。Step 5 で選べます。`); onSaved(c) })
      .catch((e) => setSaveMsg(e instanceof Error ? e.message : String(e)))
  }
  const [kind, setKind] = useState<PartKind | null>(null)              // 右のパネルで開いている部位（null＝現在の構成）
  const [focus, setFocus] = useState<string | null>(null)              // 逆引き中の業務要求
  const [evalOpen, setEvalOpen] = useState(false)                       // 上の評価の詳細を開いているか
  const [evalFilter, setEvalFilter] = useState<Verdict | null>(null)
  const [infoOpen, setInfoOpen] = useState<string | null>(null)         // 左の機種の詳細
  const cat = st.hw_catalog
  const prod = product(cat, config.product_id)!
  const parts = toParts(cat, config)
  const results = check?.results ?? []
  const byId: Record<string, CheckResult> = Object.fromEntries(results.map((r) => [r.id, r]))
  const sel = st.selection
  const isClaude = source === 'claude' && sel
  const focusReq: Requirement | undefined = st.requirements.find((r) => r.id === focus)

  const equipped = (k: PartKind): string[] =>
    k === 'sensor' ? parts.sensors : k === 'peripheral' ? parts.peripherals : [parts[k as 'base' | 'arm' | 'end_effector']]
  const allowed = (k: PartKind): string[] =>
    k === 'end_effector' ? prod.options.end_effector : k === 'sensor' ? prod.options.sensors : k === 'peripheral' ? prod.options.peripherals : equipped(k)
  // 変更できる部位＝この機種が選択肢を認めている部位（手先は2つ以上、センサー・周辺設備は1つ以上）。アーム・移動方式は機種に固定
  const changeable = KINDS.filter((k) => (k === 'end_effector' ? allowed(k).length > 1 : k === 'sensor' || k === 'peripheral' ? allowed(k).length > 0 : false))
  const lockedKinds = KINDS.filter((k) => !changeable.includes(k) && (k === 'arm' || k === 'base'))
  const partStatus = (k: PartKind): CheckStatus | null => {
    const ids = new Set(equipped(k).flatMap((id) => { const c = comp(cat, k, id); return c ? relatedReqs(k, c, st.requirements).map((x) => x.req.id) : [] }))
    if (k === 'sensor') st.requirements.filter((r) => r.id.startsWith('sense_')).forEach((r) => ids.add(r.id))
    const sts = [...ids].map((id) => byId[id]?.status).filter(Boolean) as CheckStatus[]
    return WORST.find((s) => sts.includes(s)) ?? null
  }
  const focusKinds = focusReq
    ? KINDS.filter((k) => equipped(k).some((id) => { const c = comp(cat, k, id); return c && relatedReqs(k, c, [focusReq]).length > 0 }))
    : []
  const highlight = focusReq ? focusKinds : kind ? [kind] : []
  const arm = comp(cat, 'arm', parts.arm)
  const eeComp = comp(cat, 'end_effector', parts.end_effector)
  const batch = st.batches.find((b) => b.batch_id === batchId)
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, results.filter((r) => VERDICT_OF[r.status] === v).length])) as Record<Verdict, number>

  const pick = (k: PartKind, id: string) => {
    if (k === 'end_effector') onConfig({ ...config, end_effector: id })
    else if (k === 'sensor' || k === 'peripheral') {
      const key = k === 'sensor' ? 'sensors' : 'peripherals'
      onConfig({ ...config, [key]: config[key].includes(id) ? config[key].filter((x) => x !== id) : [...config[key], id] })
    }
  }
  const choose = (p: typeof prod) => onConfig(st.selection?.config?.product_id === p.id && st.selection.config.end_effector
    ? { product_id: p.id, end_effector: st.selection.config.end_effector, sensors: st.selection.config.sensors, peripherals: st.selection.config.peripherals }
    : productDefault(p))
  const reasons = (ids: string[]) => (isClaude ? sel.rationale.filter((r) => ids.includes(r.component)) : [])
  const openEval = (v: Verdict | null) => { setEvalFilter(v); setEvalOpen(true) }

  if (nameFor !== prod.id) { setNameFor(prod.id); setName(prod.name) }

  return (
    <div className="step-page hardware6" data-testid="page-3">
      {/* 上：業務要求との対応（普段は件数だけ。押すと詳細を展開） */}
      <section className={`h6-eval ${evalOpen ? 'is-open' : ''}`} data-testid="req-col">
        {/* 1行：選定対象の業務（前工程から引き継ぎ）＋ 業務要件との適合件数。ID・注記・要求ごとの評価は「詳細を見る」 */}
        <ContextBar caption="選定対象の業務" testid="hw-basis" fields={[scenarioField(st), workflowField(st)]} />
        {/* 選定対象の業務の下：業務要件との適合件数 */}
        <div className="h6-fit-row">
          <span className="h6-fit-label">業務要件との適合</span>
          <span className="h6-counts" data-testid="counts">
            {VERDICTS.map((v) => (
              <button key={v} className={`h6-count ${VERDICT[v].cls} ${evalOpen && evalFilter === v ? 'is-on' : ''}`} onClick={() => (evalOpen && evalFilter === v ? setEvalOpen(false) : openEval(v))}
                title={VERDICT[v].meaning} data-testid={`count-${v}`}>
                <span className="h6-count-n">{check ? counts[v] : '—'}</span>{VERDICT[v].text}
              </button>
            ))}
            <button className="link" onClick={() => (evalOpen ? setEvalOpen(false) : openEval(null))} data-testid="eval-toggle">{evalOpen ? '詳細を閉じる ▴' : '詳細を見る ▾'}</button>
          </span>
        </div>
        {evalOpen && (
          <div className="h6-eval-detail">
            <div className="h6-ids small muted" data-testid="hw-ids">
              シナリオID {st.scenario.scenario_id}・ワークフローID {st.refs.workflow_id ? st.refs.workflow_id.replace(/\.json$/, '') : '—'}・出荷予定 {batchId}。
              部品を替えるたびに照合し直します（Step 5 の判定と同じ照合。仕様・模擬条件に基づく目安で、実機での動作は保証しません）。
            </div>
            <div className="legend small" data-testid="legend">
              {(['can', 'cannot', 'unknown'] as Verdict[]).map((v) => <span key={v}><span className={`hb ${VERDICT[v].cls}`}>{VERDICT[v].mark} {VERDICT[v].text}</span> {VERDICT[v].meaning}</span>)}
              <span className="muted">要求を選ぶと、関係する部位と機種を強調します（逆引き）。</span>
            </div>
            <ul className="req-list" data-testid="hw-check">
              {VERDICTS.filter((v) => !evalFilter || v === evalFilter).flatMap((v) => st.requirements.filter((r) => byId[r.id] && VERDICT_OF[byId[r.id].status] === v)).map((r) => {
                const res = byId[r.id]
                const c = sel?.capability_requirements.find((x) => x.capability === r.id)
                return (
                  <li key={r.id} className={`${STATUS[res.status].cls} ${focus === r.id ? 'is-focus' : ''}`} data-testid={`req-${r.id}`}>
                    <button className="req-head" onClick={() => setFocus(focus === r.id ? null : r.id)} data-testid={`focus-req-${r.id}`}>
                      <span className="req-st"><Badge s={res.status} /></span><strong>{r.label}</strong>
                    </button>
                    {res.status !== 'ok' && <div className="small">{res.detail}{res.status === 'partial' ? '（一部の荷物・場面だけ満たす）' : ''}</div>}
                    <details className="small">
                      <summary>判断の根拠・由来</summary>
                      <div>必要：{r.basis}</div>
                      <div>この構成：{res.provided}</div>
                      {r.links && r.links.length > 0 && (
                        <div>Step 3：{r.links.map((l) => (
                          <span key={l.kind + l.id} className="chip static">{l.kind === 'rule' ? `規則：${RULE_NAME[l.id] ?? l.id}` : l.kind === 'node' ? `判断：${st.workflow.nodes.find((n) => n.id === l.id)?.label ?? l.id}` : `荷物：${l.id}`}</span>
                        ))}</div>
                      )}
                      {c && <><div>{c.reason}</div><EvidenceChips items={c.source_evidence} segments={segments} onSeek={onSeek} /></>}
                    </details>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </section>

      {/* 左：メーカー・機種（コンパクト） */}
      <section className="h6-makers" data-testid="makers">
        {cat.manufacturers.map((m) => (
          <div key={m.id} className={`maker mk-${m.type}`} data-testid={`maker-${m.id}`}>
            <div className="maker-head"><strong>{m.name}</strong><span className="badge badge-info">{TYPE_LABEL[m.type]}</span></div>
            {cat.products.filter((p) => p.maker_id === m.id).map((p) => {
              const a = comp(cat, 'arm', p.fixed.arm)
              const fb = focusReq ? bestForProduct(cat, p, focusReq) : null
              return (
                <div key={p.id} className={`h6-prod ${p.id === prod.id ? 'is-on' : ''}`}>
                  <button className="prod-card" onClick={() => choose(p)} data-testid={`product-${p.id}`}>
                    <span className="thumb-wrap"><ProductRender parts={toParts(cat, productDefault(p))} thumb /></span>
                    <span className="prod-body">
                      <strong>{p.name.split(' ')[0]}{st.selection?.config?.product_id === p.id && <span className="h6-star" title="Claudeの仮選定"> ★</span>}</strong>
                      <span className="small">{a?.payload_kg}kg・{a?.reach_m}m・{p.type === 'fixed' ? '固定' : p.type === 'mobile' ? '車輪' : '二足'}</span>
                      {p.execution === 'concept' && <span className="hb st-unknown">概念プレビュー</span>}
                      {fb && <span className={`hb ${STATUS[fb].cls}`} data-testid={`focus-${p.id}`}>「{focusReq!.label}」：{STATUS[fb].text}</span>}
                    </span>
                  </button>
                  <button className="link h6-info" onClick={() => setInfoOpen(infoOpen === p.id ? null : p.id)} title="詳細">ⓘ</button>
                  {infoOpen === p.id && <div className="small h6-info-body">{p.name}：{p.use_case}。{p.structure}。{m.philosophy}</div>}
                </div>
              )
            })}
          </div>
        ))}
      </section>

      {/* 中央（主役）：選んだ機種の構成 */}
      <section className="h6-product" data-testid="product-col">
        <div className="prod-title">
          <div>
            <div className="small muted">{cat.manufacturers.find((m) => m.id === prod.maker_id)?.name}・{TYPE_LABEL[prod.type]}{isClaude && <span className="badge badge-claude">Claudeの仮選定</span>}</div>
            <div className="prod-name-row">
              <strong className="big-name">{prod.name}</strong>
              <label className="cfg-name" title="保存する構成の名前（初期値は機種名。書き換えられます）">
                <span>構成名</span>
                <input value={name} onChange={(e) => setName(e.target.value)} data-testid="config-name" />
              </label>
            </div>
          </div>
        </div>
        {prod.execution === 'concept' && <div className="concept-note" data-testid="concept-note">⚠ {prod.execution_note}</div>}
        {/* モデルの左横に主要スペックの表（実効可搬・リーチ・移動・手先） */}
        <div className="h6-stage">
          <table className="spec-table" data-testid="spec-strip">
            <tbody>
              <tr><th>実効可搬質量</th><td>{profile?.payload_kg ?? '—'}kg</td></tr>
              <tr><th>最大リーチ</th><td>{mm(arm?.reach_m)}</td></tr>
              <tr><th>移動方式</th><td>{prod.type === 'fixed' ? '固定設置' : prod.type === 'mobile' ? '自律移動（AMR）' : '二足歩行'}</td></tr>
              <tr><th>エンドエフェクタ</th><td>{eeComp?.label}</td></tr>
            </tbody>
          </table>
          <div className={`hero mk-${prod.type}`} data-testid="hero">
            <ProductRender parts={parts} highlight={highlight} onPick={(k) => { setFocus(null); setKind(k) }}
              hotspots={{ changeable, locked: lockedKinds, active: kind }} />
            <div className="hero-note">● を押すと右に交換候補・🔒 機種に固定・ドラッグで回転（仮想製品の簡易モデル）</div>
          </div>
        </div>
        {/* ロボットの下：「構成を確定」（機種名の右の構成名で保存し、Step 5 で選ぶ） */}
        <div className="h6-save" data-testid="config-save">
          <button className="btn-primary" onClick={doSave} disabled={!name.trim()} data-testid="config-save-btn">構成を確定</button>
          {check && (counts.cannot > 0 || counts.unknown > 0) && !saveMsg && (
            <span className="small hw-unknown" data-testid="config-save-warn">
              {counts.cannot > 0
                ? `対応不可 ${counts.cannot}件：業務要件を満たさないため、この構成では Step 5 のシミュレーションを実行できません`
                : `判断不可 ${counts.unknown}件：確定できますが、Step 5 では未検証のまま実行します`}
            </span>
          )}
          {saveMsg && <span className="small" data-testid="config-save-msg">{saveMsg}</span>}
        </div>
      </section>

      {/* 右：部位の部品パネル（中央の●を押すと、その部位の候補を出す） */}
      <section className="h6-parts" data-testid="parts-panel">
        {/* 部位はモデル上の ● から選ぶ（同じ選択肢をタブで重ねて出さない）。未選択のときは現在の構成の概要 */}
        {kind === null ? (
          <div className="h6-config" data-testid="config-list">
            <div className="sec-title small">現在の構成</div>
            <ul>
              {KINDS.map((k) => {
                const ps = partStatus(k)
                const can = changeable.includes(k)
                return (
                  <li key={k} className={can ? '' : 'is-locked'}>
                    <span className="h6-k">{SHORT[k]}</span>
                    <span>{equipped(k).map((id) => comp(cat, k, id)?.label.replace('（模擬）', '')).join('・') || 'なし'}</span>
                    {can
                      ? <button className="link" onClick={() => setKind(k)} data-testid={`tab-${k}`}>{ps ? STATUS[ps].mark + ' ' : ''}変更</button>
                      : <span className="h6-lock" title="この機種に固定（変更できない）" data-testid={`fixed-${k}`}>🔒 固定</span>}
                  </li>
                )
              })}
            </ul>
            <div className="small muted">モデル上の ● を押すと、その部位の交換候補を表示します。</div>
          </div>
        ) : !changeable.includes(kind) ? (
          <div className="locked" data-testid="locked">
            🔒 <strong>{PART_TITLE[kind]}はこの機種に固定</strong>（変更できません）：{equipped(kind).map((id) => comp(cat, kind, id)?.label).join('・') || 'なし'}
            <div className="small muted">別の構造が必要なら、左で別の機種・メーカーを選んでください。</div>
          </div>
        ) : (
          <>
            <div className="h6-part-head">
              <button className="link" onClick={() => setKind(null)} data-testid="parts-back">← 現在の構成</button>
              <strong>{PART_TITLE[kind]}</strong><span className="small muted">この機種で選べる部品{kind !== 'end_effector' ? '（複数可）' : ''}</span>
            </div>
            {reasons(equipped(kind)).length > 0 && (
              <details className="small"><summary>Claudeの選定理由</summary>{reasons(equipped(kind)).map((r, i) => <div key={i}>{r.text}</div>)}</details>
            )}
            <div className="cat-grid" data-testid={`catalog-${kind}`}>
              {allowed(kind).map((id) => {
                const c = comp(cat, kind, id)
                if (!c) return null
                const on = equipped(kind).includes(id)
                const rel = relatedReqs(kind, c, st.requirements)
                const hit = focus && rel.some((x) => x.req.id === focus)
                // 部品のカード：名前、左にスペックの表・右に画像、下に選択ボタン
                const rows: [string, string][] = [
                  ...(kind === 'end_effector' ? [
                    ['最大把持サイズ', mm(c.max_object_m)], ['自重', `${c.mass_kg}kg`],
                    ['実効可搬質量', `${(Number(comp(cat, 'arm', parts.arm)?.payload_kg) - Number(c.mass_kg)).toFixed(1)}kg`],
                  ] as [string, string][] : []),
                  // 数値で示す項目（可搬・把持サイズ・リーチ）は上の行と重なるので出さない
                  ...rel.filter(({ req }) => CAP_NAME[req.id] && !['payload', 'object_size', 'reach'].includes(req.id)).map(({ req, status }): [string, string] => [CAP_NAME[req.id], status ? CAP_VAL[status] : '—']),
                ]
                return (
                  <div key={id} className={`cat-card part-card ${on ? 'is-on' : ''} ${hit ? 'is-focus' : ''}`} data-testid={`part-${id}`}>
                    <strong className="part-name">{c.label}</strong>
                    <div className="part-body">
                      <table className="spec-table part-spec"><tbody>
                        {rows.map(([k, val]) => <tr key={k}><th>{k}</th><td>{val}</td></tr>)}
                      </tbody></table>
                      <PartIcon kind={kind} id={id} />
                    </div>
                    <button className={on ? 'btn-ghost part-pick is-on' : 'btn-primary part-pick'} onClick={() => pick(kind, id)} data-testid={`card-${id}`}>
                      {on ? (kind === 'end_effector' ? '✓ 装着中' : '✓ 装着中（外す）') : '選択'}
                    </button>
                  </div>
                )
              })}
            </div>
            {(() => {
              const others = cat.components[kind].filter((c) => !allowed(kind).includes(c.id))
              return others.length > 0 && (
                <details className="small not-offered" data-testid="not-offered">
                  <summary>この機種では選べない{SHORT[kind]}（{others.length}）</summary>
                  <ul>{others.map((c) => <li key={c.id}>{c.label}：{prod.option_notes?.[c.id] ?? 'メーカーが対応オプションとして提供していない'}</li>)}</ul>
                </details>
              )
            })()}
          </>
        )}
        <details className="small muted h6-catnote"><summary>カタログについて</summary>{cat.note}</details>
      </section>
    </div>
  )
}
