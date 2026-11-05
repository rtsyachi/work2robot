import { useState } from 'react'
import type { CheckResult, CheckStatus, HardwareCheck, ProductConfig, Requirement, RobotSummary, V2Run, V2State } from '../types'
import EvidenceChips, { type SegmentMap } from '../components/Evidence'
import { PartIcon } from '../components/RobotFigure'
import ProductRender from '../components/ProductRender'
import {
  PART_TITLE, SHORT, STATUS, TYPE_LABEL, bestForProduct, comp, diffFromDefault, product, productDefault, relatedReqs,
  toParts, type PartKind,
} from '../lib/hwConfig'

const ORDER: CheckStatus[] = ['ok', 'partial', 'unknown', 'ng']
const WORST: CheckStatus[] = ['ng', 'partial', 'unknown', 'ok']
const KINDS: PartKind[] = ['end_effector', 'sensor', 'peripheral', 'arm', 'base']
const RULE_NAME: Record<string, string> = {
  order_by_weight_desc: '重い順に下から', no_stack_last: '上積み禁止は最後', brick_pattern: 'レンガ積み', balance_load: '偏荷重の回避',
  full_support: '底面の支持', load_limit: '積載上限', height_limit: '高さの上限', overhang_check: 'はみ出し確認', balance_check: '偏りの確認',
}
const OPT_KEY: Partial<Record<PartKind, 'end_effector' | 'sensors' | 'peripherals'>> = { end_effector: 'end_effector', sensor: 'sensors', peripheral: 'peripherals' }

function Badge({ s }: { s: CheckStatus | null }) {
  if (!s) return <span className="hb hb-none">関係</span>
  return <span className={`hb ${STATUS[s].cls}`} title={STATUS[s].meaning}>{STATUS[s].mark} {STATUS[s].text}</span>
}

/** ③ ロボット構成の仮選定：仮想メーカー3社の機種を選び、その機種が認めるオプションを選んで、業務要求との対応を確かめる */
export default function HardwareStep({ st, config, onConfig, check, profile, source, run, segments, onSeek }: {
  st: V2State
  config: ProductConfig
  onConfig: (c: ProductConfig) => void
  check: HardwareCheck | null
  profile: RobotSummary | null
  source: 'claude' | 'custom' | null
  run: V2Run | null
  segments: SegmentMap
  onSeek: (t: string) => void
}) {
  const [kind, setKindRaw] = useState<PartKind>('end_effector')
  const [touched, setTouched] = useState(false)
  const setKind = (k: PartKind) => { setKindRaw(k); setTouched(true) }
  const [focus, setFocus] = useState<string | null>(null)   // 逆引き中の業務要求
  const cat = st.hw_catalog
  const prod = product(cat, config.product_id)!
  const parts = toParts(cat, config)
  const results = check?.results ?? []
  const byId: Record<string, CheckResult> = Object.fromEntries(results.map((r) => [r.id, r]))
  const sel = st.selection
  const isClaude = source === 'claude' && sel
  const focusReq: Requirement | undefined = st.requirements.find((r) => r.id === focus)
  const diff = diffFromDefault(cat, config)
  const affected = [...new Set(results.filter((r) => r.status === 'ng' || r.status === 'partial').flatMap((r) => r.affected ?? []))]
  const locked: PartKind[] = ['base', 'arm']

  const equipped = (k: PartKind): string[] =>
    k === 'sensor' ? parts.sensors : k === 'peripheral' ? parts.peripherals : [parts[k as 'base' | 'arm' | 'end_effector']]
  const allowed = (k: PartKind): string[] =>
    k === 'end_effector' ? prod.options.end_effector : k === 'sensor' ? prod.options.sensors : k === 'peripheral' ? prod.options.peripherals : equipped(k)
  const partStatus = (k: PartKind): CheckStatus | null => {
    const ids = new Set(equipped(k).flatMap((id) => { const c = comp(cat, k, id); return c ? relatedReqs(k, c, st.requirements).map((x) => x.req.id) : [] }))
    if (k === 'sensor') st.requirements.filter((r) => r.id.startsWith('sense_')).forEach((r) => ids.add(r.id))
    const sts = [...ids].map((id) => byId[id]?.status).filter(Boolean) as CheckStatus[]
    return WORST.find((s) => sts.includes(s)) ?? null
  }
  const figStatus = Object.fromEntries(KINDS.map((k) => [k, partStatus(k)])) as Record<PartKind, CheckStatus | null>
  // 光らせる部位：開いているオプションの種類と、逆引き中の要求に関わる部位
  const focusKinds = focusReq
    ? KINDS.filter((k) => equipped(k).some((id) => { const c = comp(cat, k, id); return c && relatedReqs(k, c, [focusReq]).length > 0 }))
    : []
  // 通常時は製品画像らしく強調しない。部位・タブを選んだとき、要求で逆引きしたときだけ光らせる
  const highlight = focusReq ? focusKinds : touched ? [kind] : []
  const arm = comp(cat, 'arm', parts.arm)
  const eeComp = comp(cat, 'end_effector', parts.end_effector)

  const pick = (k: PartKind, id: string) => {
    if (k === 'end_effector') onConfig({ ...config, end_effector: id })
    else if (k === 'sensor' || k === 'peripheral') {
      const key = k === 'sensor' ? 'sensors' : 'peripherals'
      onConfig({ ...config, [key]: config[key].includes(id) ? config[key].filter((x) => x !== id) : [...config[key], id] })
    }
  }
  const reasons = (ids: string[]) => (isClaude ? sel.rationale.filter((r) => ids.includes(r.component)) : [])

  return (
    <div className="step-page hardware5" data-testid="page-3">
      {/* 左：メーカーと機種 */}
      <section className="h5-makers" data-testid="makers">
        <div className="sec-title">仮想メーカー・機種</div>
        {cat.manufacturers.map((m) => (
          <div key={m.id} className={`maker mk-${m.type}`} data-testid={`maker-${m.id}`}>
            <div className="maker-head"><strong>{m.name}</strong><span className="badge badge-info">{TYPE_LABEL[m.type]}</span></div>
            <div className="small muted">{m.philosophy}</div>
            {cat.products.filter((p) => p.maker_id === m.id).map((p) => {
              const arm = comp(cat, 'arm', p.fixed.arm)
              const fb = focusReq ? bestForProduct(cat, p, focusReq) : null
              return (
                <button key={p.id} className={`prod-card ${p.id === prod.id ? 'is-on' : ''}`} data-testid={`product-${p.id}`}
                  onClick={() => onConfig(st.selection?.config?.product_id === p.id && st.selection.config.end_effector
                    ? { product_id: p.id, end_effector: st.selection.config.end_effector, sensors: st.selection.config.sensors, peripherals: st.selection.config.peripherals }
                    : productDefault(p))}>
                  <span className="thumb-wrap"><ProductRender parts={toParts(cat, productDefault(p))} thumb /></span>
                  <span className="prod-body">
                    <strong>{p.name}</strong>
                    <span className="small">アーム可搬 {arm?.payload_kg}kg・リーチ {arm?.reach_m}m・{p.type === 'fixed' ? '移動しない' : p.type === 'mobile' ? '車輪で移動' : '二足で移動'}</span>
                    <span className="small muted">{p.use_case}</span>
                    {p.execution === 'concept' && <span className="hb st-unknown">概念プレビュー（実行器で動作を表現できない）</span>}
                    {fb && <span className={`hb ${STATUS[fb].cls}`} data-testid={`focus-${p.id}`}>この機種で「{focusReq!.label}」：{STATUS[fb].text}</span>}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </section>

      {/* 中央：選んだ機種とオプション */}
      <section className="h5-product" data-testid="product-col">
        <div className="prod-title">
          <div>
            <div className="small muted">{cat.manufacturers.find((m) => m.id === prod.maker_id)?.name}・{TYPE_LABEL[prod.type]}</div>
            <strong className="big-name">{prod.name}</strong>
            <div className="small">{prod.structure}</div>
          </div>
          {isClaude && <span className="badge badge-claude">Claudeの仮選定（保存済み）</span>}
        </div>
        {prod.execution === 'concept' && <div className="concept-note" data-testid="concept-note">⚠ {prod.execution_note}</div>}
        {reasons([prod.id]).map((r, i) => <div key={i} className="note claude-why">Claudeの選定理由：{r.text}</div>)}
        <div className={`hero mk-${prod.type}`} data-testid="hero">
          <ProductRender parts={parts} highlight={highlight} onPick={(k) => { setFocus(null); setKind(k) }} />
          <div className="hero-badge">{cat.manufacturers.find((m) => m.id === prod.maker_id)?.name.replace('（仮想）', '')}</div>
          <div className="hero-note">仮想製品の簡易モデル（実在の機種ではありません）・ドラッグで回転・部位をクリックでオプション</div>
        </div>
        <div className="spec-strip" data-testid="spec-strip">
          <div><span>実効可搬</span><strong>{profile?.payload_kg ?? '—'}kg</strong><em>アーム{arm?.payload_kg}kg − 手先{eeComp?.mass_kg}kg</em></div>
          <div><span>リーチ</span><strong>{arm?.reach_m}m</strong><em>肩の高さ {profile?.shoulder_height_m ?? '—'}m</em></div>
          <div><span>移動</span><strong>{prod.type === 'fixed' ? '固定' : prod.type === 'mobile' ? '車輪走行' : '二足歩行'}</strong><em>{prod.type === 'fixed' ? (parts.peripherals.length ? 'コンベヤで供給' : '供給設備なし') : prod.type === 'mobile' ? '仮置き場⇔カゴ車' : '未検証'}</em></div>
          <div><span>手先</span><strong>{eeComp?.label.replace('（模擬）', '')}</strong><em>つかめる幅 {eeComp?.max_object_m}m</em></div>
          <div><span>センサー</span><strong>{parts.sensors.length}種</strong><em>{parts.sensors.map((s) => comp(cat, 'sensor', s)?.label.replace(/（.*$/, '')).join('・') || 'なし'}</em></div>
        </div>
        <div className="cat-tabs">
          {KINDS.map((k) => (
            <button key={k} className={`cat-tab ${k === kind ? 'is-on' : ''}`} onClick={() => setKind(k)} data-testid={`tab-${k}`}>
              {locked.includes(k) ? '🔒' : figStatus[k] ? STATUS[figStatus[k]!].mark : ''} {SHORT[k]}
            </button>
          ))}
        </div>
        {locked.includes(kind) ? (
          <div className="locked" data-testid="locked">
            🔒 <strong>{PART_TITLE[kind]}はこの機種に固定</strong>（変更できません）：{comp(cat, kind, equipped(kind)[0])?.label}
            <div className="small muted">別の構造が必要なら、別の機種・メーカーを選んでください。</div>
          </div>
        ) : (
          <>
            <div className="sec-title small">{PART_TITLE[kind]}：この機種で選べるオプション{kind !== 'end_effector' ? '（複数可）' : ''}</div>
            {reasons(equipped(kind)).map((r, i) => <div key={i} className="note claude-why">Claudeの選定理由：{r.text}</div>)}
            <div className="cat-grid" data-testid={`catalog-${kind}`}>
              {allowed(kind).map((id) => {
                const c = comp(cat, kind, id)
                if (!c) return null
                const on = equipped(kind).includes(id)
                const rel = relatedReqs(kind, c, st.requirements)
                const hit = focus && rel.some((x) => x.req.id === focus)
                return (
                  <button key={id} className={`cat-card ${on ? 'is-on' : ''} ${hit ? 'is-focus' : ''}`} onClick={() => pick(kind, id)} data-testid={`card-${id}`}>
                    {on && <span className="equipped">装着中</span>}
                    <PartIcon kind={kind} id={id} />
                    <strong>{c.label}</strong>
                    {kind === 'end_effector' && <span className="small">つかめる幅 {c.max_object_m}m・重さ {c.mass_kg}kg（実効可搬 {(Number(comp(cat, 'arm', parts.arm)?.payload_kg) - Number(c.mass_kg)).toFixed(1)}kg）</span>}
                    <span className="opt-reqs">
                      {rel.map(({ req, status, note }) => (
                        <span key={req.id} className={`hb ${status ? STATUS[status].cls : 'hb-none'}`} title={note}>{status ? STATUS[status].mark : '・'} {req.label}</span>
                      ))}
                    </span>
                    {prod.option_notes?.[id] && <span className="muted small">{prod.option_notes[id]}</span>}
                  </button>
                )
              })}
              {allowed(kind).length === 0 && <div className="muted small">この機種には {SHORT[kind]} のオプションがありません。</div>}
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
      </section>

      {/* 右：業務要求との対応・逆引き */}
      <section className="h4-reqs" data-testid="req-col">
        <div className="sec-title">業務の要求との対応</div>
        <div className="counts" data-testid="counts">
          {ORDER.map((s) => <div key={s} className={`count ${STATUS[s].cls}`} title={STATUS[s].meaning}><div className="count-n">{check?.counts[s] ?? '—'}</div><div className="small">{STATUS[s].text}</div></div>)}
        </div>
        <div className="legend" data-testid="legend">
          {ORDER.map((s) => <span key={s}><span className={`hb ${STATUS[s].cls}`}>{STATUS[s].mark} {STATUS[s].text}</span> {STATUS[s].meaning}</span>)}
        </div>
        <div className="small muted">要求を選ぶと、関係する機種・オプションを強調します（逆引き）。</div>
        <ul className="req-list" data-testid="hw-check">
          {st.requirements.map((r) => {
            const res = byId[r.id]
            const c = sel?.capability_requirements.find((x) => x.capability === r.id)
            return (
              <li key={r.id} className={`${res ? STATUS[res.status].cls : ''} ${focus === r.id ? 'is-focus' : ''}`} data-testid={`req-${r.id}`}>
                <button className="req-head" onClick={() => setFocus(focus === r.id ? null : r.id)} data-testid={`focus-req-${r.id}`}>
                  <span className="req-st">{res && <Badge s={res.status} />}</span><strong>{r.label}</strong>
                </button>
                {res && res.status !== 'ok' && <div className="small">{res.detail}</div>}
                <details className="small">
                  <summary>由来・根拠</summary>
                  <div>{r.basis}</div>
                  {r.links && r.links.length > 0 && (
                    <div>Step 2：{r.links.map((l) => (
                      <span key={l.kind + l.id} className="chip static">{l.kind === 'rule' ? `規則：${RULE_NAME[l.id] ?? l.id}` : l.kind === 'node' ? `判断：${st.workflow.nodes.find((n) => n.id === l.id)?.label ?? l.id}` : `荷物：${l.id}`}</span>
                    ))}</div>
                  )}
                  {c && <><div>{c.reason}</div><EvidenceChips items={c.source_evidence} segments={segments} onSeek={onSeek} /></>}
                </details>
              </li>
            )
          })}
        </ul>
        {diff.length > 0 && (
          <div className="diff" data-testid="diff">
            <strong>{prod.name}の標準構成からの変更</strong>
            <ul>{diff.map((d) => <li key={d}>{d}</li>)}</ul>
            <button className="link" onClick={() => onConfig(productDefault(prod))}>標準構成に戻す</button>
          </div>
        )}
        <div className="impact" data-testid="impact">
          <strong>Step 4・5への影響</strong>
          <ul className="small">
            {affected.length > 0
              ? <li>荷物 {affected.join('、')} は、この構成では持ち上げずに人へ引継ぎになる見込み（実行で確定）</li>
              : <li>能力不足で引き継ぐ荷物は見込まれていません</li>}
            {byId.reach?.status === 'ng' && <li>リーチが足りず、カゴ車の奥・上段に置けない荷物が出る見込み</li>}
            {prod.execution === 'concept' && <li>この機種の動作は概念プレビュー。仮想実行で置けても、動作の成立は示しません</li>}
            <li>不足 {check?.counts.ng ?? 0}・一部対応 {check?.counts.partial ?? 0}・未確認 {check?.counts.unknown ?? 0} 件と機種固有の検証項目が、導入前評価に入ります</li>
            <li>{run ? `この構成は実行済み：配置 ${run.job.end.placed}/${run.job.items.length}個` : '構成を変えたら、Step 4で実行し直します'}</li>
          </ul>
        </div>
        {isClaude && (
          <details className="small">
            <summary>Claudeが検討した他の候補（{sel.alternatives.length}）・実機PoCで確かめる点</summary>
            <ul data-testid="hw-alternatives">{sel.alternatives.map((a, i) => <li key={i}><strong>{product(cat, a.component)?.name ?? a.component}</strong>：{a.reason}</li>)}</ul>
            <ul>{sel.unverified_points.map((u) => <li key={u}>{u}</li>)}</ul>
          </details>
        )}
        <p className="muted small">{cat.note}</p>
      </section>
    </div>
  )
}
