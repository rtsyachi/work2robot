import { useMemo, useState } from 'react'
import type { JobItem, V2Run, V2State } from '../types'
import Level1Graph from '../components/Level1Graph'
import WorkflowGraph from '../components/WorkflowGraph'
import NodeDetail from '../components/NodeDetail'
import VideoPane from '../components/VideoPane'
import EvidenceChips, { type SegmentMap } from '../components/Evidence'
import { ITEM_NODE, L1_HELP, rulesByNode } from '../lib/level1'
import { toSeconds } from '../lib/videoSync'
import { EVIDENCE_LABEL } from '../lib/labels'
import { fmt } from '../lib/format'

const STATUS: Record<string, { text: string; cls: string }> = {
  applied: { text: '適用', cls: 'badge-ok' },
  not_applicable: { text: '未適用', cls: 'badge-warn' },
  unsupported: { text: '未対応', cls: 'badge-err' },
}

function attrText(it: JobItem, st: V2State): string {
  const o = st.objects.find((x) => x.object_id === it.object_id)
  const a = o?.attributes ?? {}
  const v = (k: string) => a[k]?.value
  const mat = v('material_class') === 'soft' ? '柔らかい' : v('material_class') === 'rigid' ? '硬い' : '材質不明'
  const dims = Array.isArray(v('dims_m')) ? (v('dims_m') as number[]).join('×') + 'm' : '寸法不明'
  return `${o?.description ?? ''}・${v('weight_kg') ?? '?'}kg・${mat}・${dims}（${EVIDENCE_LABEL[a.weight_kg?.source ?? ''] ?? '模擬荷物マスタ'}）`
}

/** ② ワークフロー生成・確認：業務全体（Level 1）と荷物1個の共通ワークフロー（Level 2）、荷物ごとの実行経路、根拠 */
export default function WorkflowStep({ st, logicRun, segments }: { st: V2State; logicRun: V2Run | null; segments: SegmentMap }) {
  const job = logicRun?.job ?? null
  const [l1, setL1] = useState<string>(ITEM_NODE)
  const [itemId, setItemId] = useState<string | null>(null)
  const [nodeId, setNodeId] = useState<string | null>(null)
  const [seek, setSeek] = useState<{ t: number; nonce: number } | null>(null)
  const onSeek = (ts: string) => setSeek({ t: toSeconds(ts), nonce: Date.now() })
  const rules = useMemo(() => rulesByNode(st.job, job?.rule_results ?? []), [st.job, job])
  const item = job?.items.find((i) => i.object_id === (itemId ?? job.order[0])) ?? null
  const trace = item?.item_trace ?? null
  const node = st.workflow.nodes.find((n) => n.id === nodeId) ?? null
  const step = trace?.steps.find((s) => s.node_id === nodeId) ?? null
  const ext = st.extraction
  const l1Label = st.level1.nodes.find((n) => n.id === l1)?.label ?? l1

  return (
    <div className="step-page workflow" data-testid="page-2">
      <section className="wf-l1">
        <div className="sec-title">
          業務全体（Level 1）：カゴ車1台分の積付
          <span className="muted small">　ノードを選ぶと、その工程の規則や、荷物1個のワークフロー（Level 2）を下に表示します</span>
        </div>
        <Level1Graph level1={st.level1} rules={rules} activeId={null} selectedId={l1} onSelect={(id) => { setL1(id); setNodeId(null) }} />
      </section>

      <div className="wf-main">
        {l1 === ITEM_NODE ? (
          <section className="wf-l2" data-testid="level2">
            <div className="sec-title">
              荷物1個の処理（Level 2）：全ての荷物で共通のワークフロー
              <span className="muted small">　荷物を選ぶと、その荷物が実際に通った分岐を強調します（定義は1つ、経路は荷物ごとの実行結果）</span>
            </div>
            <div className="item-chips" data-testid="item-chips">
              {job?.order.map((id) => {
                const it = job.items.find((i) => i.object_id === id)!
                return (
                  <button key={id} className={`chip ${id === item?.object_id ? 'is-on' : ''} ${it.outcome === 'handed_off' ? 'chip-hand' : ''} ${it.provisional ? 'chip-prov' : ''}`}
                    onClick={() => setItemId(id)} data-testid={`chip-${id}`}>{id}</button>
                )
              })}
              {!job && <span className="muted">実行経路を計算しています…</span>}
            </div>
            {item && (
              <div className="item-card" data-testid="item-card">
                <strong>荷物{item.object_id}</strong>：{attrText(item, st)}
                <div className="small">
                  結果：{item.outcome === 'placed'
                    ? `${item.seq + 1}番目に配置（${item.placement?.support ? item.placement.support + 'の上' : '床'}・高さ${item.placement?.base_height ?? 0}m${item.placement?.rotated ? '・向きを変える' : ''}）`
                    : `人へ引継ぎ：${item.handoff_reason}`}
                  {item.applied_rules && item.applied_rules.length > 0 && `・適用した規則：${item.applied_rules.join('、')}`}
                  {item.provisional && '・暫定動作'}
                </div>
                {(() => {
                  const subs = (st.tasks?.major_tasks ?? []).flatMap((m) => m.subtasks.filter((s) => s.objects.includes(item.object_id)).map((s) => ({ m, s })))
                  return subs.length > 0 ? (
                    <div className="small" data-testid="step1-link">
                      Step 1で観測した人の作業：{subs.map(({ m, s }) => (
                        <button key={s.id} className="link" onClick={() => setSeek({ t: s.start + 0.05, nonce: Date.now() })}>
                          {m.name} ＞ {s.name}（{fmt(s.start)}–{fmt(s.end)}）▶
                        </button>
                      ))}
                    </div>
                  ) : <div className="small muted">Step 1の観測では、この荷物を扱う場面は特定できていません。</div>
                })()}
                <div className="muted small">置き場所はカゴ車のその時点の状態で決まるため、同じ荷物でも積む順番やカゴ車の状態が違えば結果が変わります（ロボットの能力の制約なしで計算）。</div>
              </div>
            )}
            <div className="graph wf-graph">
              <WorkflowGraph key={ext?.created_at ?? 'fixture'} workflow={st.workflow} trace={trace} selectedId={nodeId} onSelect={setNodeId} />
            </div>
          </section>
        ) : (
          <section className="wf-l1detail" data-testid="l1-detail">
            <div className="sec-title">{l1Label}</div>
            <p>{L1_HELP[l1]}</p>
            {(rules[l1] ?? []).length === 0 && <p className="muted">この工程に対応づけた業務の規則はありません。</p>}
            {st.job.rules.filter((r) => rules[l1]?.some((x) => x.type === r.type)).map((r) => {
              const rr = job?.rule_results?.find((x) => x.type === r.type)
              return (
                <div key={r.type} className="rule" data-testid={`rule-${r.type}`}>
                  <div className="rule-head"><strong>{rr?.label ?? r.type}</strong>{rr && <span className={`badge ${STATUS[rr.status].cls}`}>{STATUS[rr.status].text}</span>}</div>
                  {r.note && <div className="note">{r.note}</div>}
                  {rr && <div className="small">実行結果：{rr.detail}{rr.notes.length ? `（${rr.notes.join('；')}）` : ''}</div>}
                  <EvidenceChips items={r.source_evidence} segments={segments} onSeek={onSeek} />
                </div>
              )
            })}
            {l1 === 'l1_final_check' && st.job.unsupported_rules.map((u) => (
              <div key={u.text} className="rule rule-unsupported" data-testid="rule-unsupported">
                <div className="rule-head"><strong>{u.text}</strong><span className="badge badge-err">未対応</span></div>
                <div className="small">実行器では扱えないため適用していません（人の確認・実機PoCへ）</div>
                <EvidenceChips items={u.source_evidence} segments={segments} onSeek={onSeek} />
              </div>
            ))}
            <button className="link" onClick={() => setL1(ITEM_NODE)}>荷物1個のワークフロー（Level 2）を開く</button>
          </section>
        )}

        <aside className="wf-side">
          <VideoPane src={st.video_url} muted={false} range={null} follow={false} missingNote={null} seek={seek} title="根拠の場面（元動画）" />
          <div className="wf-detail">
            {l1 === ITEM_NODE ? (
              <NodeDetail node={node} step={step} catalog={st.catalog} segments={segments} onSeek={onSeek} />
            ) : (
              <p className="muted small">規則の根拠の「▶ 動画」で、上の動画が該当の場面へ移動します。</p>
            )}
            {ext && ext.confirmation_items.length > 0 && (
              <details className="confirm">
                <summary>確認事項（Claudeが抽出・{ext.confirmation_items.length}件）</summary>
                <ul>{ext.confirmation_items.map((c) => <li key={c.id}><strong>{c.topic}</strong>：{c.detail}</li>)}</ul>
              </details>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
