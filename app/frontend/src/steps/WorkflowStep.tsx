import { useCallback, useMemo, useState } from 'react'
import type { ConfirmationItem, EditOp, JobItem, ProcessNode, Stage, V2Run, V2State } from '../types'
import WorkflowGraph from '../components/WorkflowGraph'
import NodeDetail from '../components/NodeDetail'
import VideoPane from '../components/VideoPane'
import EvidenceChips, { type SegmentMap } from '../components/Evidence'
import TeachPanel from '../components/TeachPanel'
import { resolveConfirmation } from '../api'
import TaskFlowList, { type FlowCard } from '../components/TaskFlowList'
import TaskConditions, { type Cond } from '../components/TaskConditions'
import ContextBar, { scenarioField, workflowField } from '../components/ContextBar'
import { editWorkflow, revertWorkflow } from '../api'
import { RULE_LABEL } from '../lib/level1'
import { BASIS_LABEL, LOOP_DECIDE, LOOP_EDGES, LOOP_TASKS, criteriaOf, stageCounts, stagesOf } from '../lib/process'
import { toSeconds } from '../lib/videoSync'
import { EVIDENCE_LABEL } from '../lib/labels'
import { fmt } from '../lib/format'

function attrText(it: JobItem, st: V2State): string {
  const o = st.objects.find((x) => x.object_id === it.object_id)
  const a = o?.attributes ?? {}
  const v = (k: string) => a[k]?.value
  const mat = v('material_class') === 'soft' ? '柔らかい' : v('material_class') === 'rigid' ? '硬い' : '材質不明'
  const dims = Array.isArray(v('dims_m')) ? (v('dims_m') as number[]).join('×') + 'm' : '寸法不明'
  return `${o?.description ?? ''}・${v('weight_kg') ?? '?'}kg・${mat}・${dims}（${EVIDENCE_LABEL[a.weight_kg?.source ?? ''] ?? '模擬の商品・荷姿マスタ'}）`
}

/** 今の版と、1つ前の版に戻す */
function VersionBar({ st, onChanged }: { st: V2State; onChanged: () => void }) {
  const ext = st.extraction
  const [err, setErr] = useState<string | null>(null)
  if (!ext) return null
  const r = ext.meta.revision
  const text = !r ? '解析直後' : r.by === 'user' ? `直接編集${r.reason ? `（${r.reason}）` : ''}` : r.by === 'claude' ? 'Claudeが修正' : '前の版に戻した'
  return (
    <div className="wf-version" data-testid="wf-version" title={ext.record_file}>
      <span className="wf-version-dot" />版：{text}
      {r?.of && <button className="link" onClick={() => { setErr(null); revertWorkflow().then(onChanged).catch((e) => setErr(String(e instanceof Error ? e.message : e))) }}
        data-testid="wf-revert">1つ前に戻す</button>}
      {err && <span className="hw-ng">{err}</span>}
    </div>
  )
}

/** 確認事項の一覧。各項目を「消込」（対応済みにする）／「戻す」。対応済みは打ち消し線で下に回す */
type Resolved = Record<string, { at: string; note: string }>
function Confirmations({ items, title, open = false, resolved = {}, onToggle }: {
  items: ConfirmationItem[]; title: string; open?: boolean; resolved?: Resolved; onToggle?: (id: string, done: boolean) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  if (items.length === 0) return null
  const left = items.filter((c) => !resolved[c.id])
  const sorted = [...left, ...items.filter((c) => resolved[c.id])]
  const toggle = async (id: string, done: boolean) => {
    if (!onToggle) return
    setBusy(id)
    try { await onToggle(id, done) } finally { setBusy(null) }
  }
  return (
    <details className="wf-confirms" data-testid="related-confirmations" open={open}>
      <summary>{title}<span className="wf-count" data-testid="confirm-left">{left.length ? `未対応 ${left.length}／${items.length}` : `すべて対応済み（${items.length}）`}</span></summary>
      <ul>{sorted.map((c) => {
        const r = resolved[c.id]
        return (
          <li key={c.id} className={r ? 'is-resolved' : ''} data-testid={`confirm-${c.id}`}>
            <div className="wf-confirm-row">
              <span><strong>{c.topic}</strong>{c.detail}</span>
              {onToggle && (r
                ? <button className="op" disabled={busy === c.id} onClick={() => toggle(c.id, false)} data-testid="confirm-undo">戻す</button>
                : <button className="op is-primary" disabled={busy === c.id} onClick={() => toggle(c.id, true)} data-testid="confirm-resolve">消込</button>)}
            </div>
            {r && <div className="wf-confirm-done">✓ 対応済み（{r.at.slice(0, 16).replace('T', ' ')}）{r.note && `：${r.note}`}</div>}
          </li>
        )
      })}</ul>
    </details>
  )
}

/** ② ワークフロー確認：業務全体（工程）→ 工程のタスク（判断条件は優先度順にタスクの中）→ 根拠。
 *  判断条件はタスクの中の「修正」「削除」で直す（修正を押したときだけ入力欄を開く。保存すると新しい版）。 */
export default function WorkflowStep({ st, logicRun, segments, onChanged }: { st: V2State; logicRun: V2Run | null; segments: SegmentMap; onChanged: () => void }) {
  const job = logicRun?.job ?? null
  const ext = st.extraction
  const stages = useMemo(() => stagesOf(ext?.process, st.job), [ext, st.job])
  const [stageId, setStageId] = useState<string | null>(null)          // null＝業務全体
  const [taskId, setTaskId] = useState<string | null>(null)            // 選んだタスク
  const [itemId, setItemId] = useState<string | null>(null)
  const [nodeId, setNodeId] = useState<string | null>(null)            // 荷物1個の判断で選んだノード
  const [seek, setSeek] = useState<{ t: number; nonce: number } | null>(null)
  // 判断条件の修正欄（右の欄に入力欄を出す場所）と、開いているか
  const [editSlot, setEditSlot] = useState<HTMLElement | null>(null)
  const [editingCond, setEditingCond] = useState(false)
  const [nodeEdit, setNodeEdit] = useState<string | null>(null)        // 分岐図の判断ノードの「修正」を押したノード
  const onEditing = useCallback((on: boolean) => { if (on) setEditingCond(true); else setEditingCond(false) }, [])

  const onSeek = (ts: string) => setSeek({ t: toSeconds(ts), nonce: Date.now() })
  // 確認事項の消込（シナリオに記録。保存したら画面の状態を取り直す）
  const resolved = st.scenario.resolved_confirmations ?? {}
  const toggleConfirm = async (id: string, done: boolean) => { await resolveConfirmation(id, done); onChanged() }
  const results = job?.rule_results ?? []
  const item = job?.items.find((i) => i.object_id === (itemId ?? job.order[0])) ?? null
  const trace = item?.item_trace ?? null
  const node = st.workflow.nodes.find((n) => n.id === nodeId) ?? null
  const step = trace?.steps.find((s) => s.node_id === nodeId) ?? null
  const stage = stages.find((s) => s.id === stageId) ?? null
  const isLoop = stage?.role === 'item_loop'
  const pnode = !isLoop ? stage?.nodes.find((n) => n.id === taskId) ?? null : null
  const loopTask = isLoop ? LOOP_TASKS.find((x) => x.id === taskId) ?? null : null
  const confirms = ext?.confirmation_items ?? []
  const byId = (ids: string[]) => confirms.filter((c) => ids.includes(c.id))
  const itemConfirms = confirms.filter((c) => c.related_node_ids.length > 0)
  const goStage = (id: string | null) => { setStageId(id); setTaskId(null); setNodeId(null) }
  const save = (ops: EditOp[], reason: string) => editWorkflow(ops, reason).then(() => onChanged())

  // 規則1つの表示（選ばれているか・実行結果・根拠）
  const rule = (t: string) => {
    const jr = st.job.rules.find((r) => r.type === t)
    const rr = results.find((r) => r.type === t)
    return { type: t, label: rr?.label ?? RULE_LABEL[t] ?? t, selected: !!jr, status: jr ? rr?.status : undefined,
      detail: rr ? `${rr.detail}${rr.notes.length ? `（${rr.notes.join('；')}）` : ''}` : undefined, evidence: jr?.source_evidence }
  }
  // 積付の工程：判断条件は実行器の判断の順。使い方は業務の規則の注記（規則がなければ既定の説明）
  const loopConds = (tid: string): Cond[] => (LOOP_TASKS.find((t) => t.id === tid)?.criteria ?? []).map((c, i) => {
    const r = c.rule ? rule(c.rule) : null
    const note = c.rule ? st.job.rules.find((x) => x.type === c.rule)?.note : undefined
    return { key: `${tid}:${i}`, name: c.name, kind: c.kind, how: note || c.how, rules: r ? [r] : [] }
  })
  const nodeConds = (n: ProcessNode): Cond[] => criteriaOf(n).map((c, i) => ({
    key: `${n.id}:${i}:${c.name}`, name: c.name, how: c.how, basis: c.basis, evidence: c.source_evidence, rules: c.rule_refs.map(rule),
  }))

  const cards: FlowCard[] = !stage ? [] : isLoop
    ? LOOP_TASKS.map((t) => ({ id: t.id, label: t.label, detail: t.detail, exception: t.id === 't_handoff',
        confirms: t.id === LOOP_DECIDE ? itemConfirms.length : 0 }))
    : stage.nodes.map((n) => ({ id: n.id, label: n.label, detail: n.detail, hypothesis: n.basis === 'ai_hypothesis',
        confirms: (n.confirmation_refs ?? []).length }))
  const body = (id: string) => {
    if (!stage) return null
    if (isLoop) return <TaskConditions key={`${id}:${ext?.record_file}`} conds={loopConds(id)} mode="rules" active={taskId === id} testId={`conds-${id}`} onSave={save} segments={segments} onSeek={onSeek}
      slot={editSlot} onEditing={onEditing} />
    const n = stage.nodes.find((x) => x.id === id)!
    return <TaskConditions key={`${id}:${ext?.record_file}`} conds={nodeConds(n)} mode="criteria" active={taskId === id} task={{ stage_id: stage.id, node_id: n.id }}
      testId={`conds-${id}`} onSave={save} segments={segments} onSeek={onSeek} slot={editSlot} onEditing={onEditing} />
  }

  // 積付の工程：「配置位置・置き方を決定する」の下に、荷物1個の判断（分岐図）と荷物ごとの経路を広げる
  const itemWorkflow = (
    <div className="tflow-extra" data-testid="level2">
      <div className="tflow-extra-h">荷物1個の判断<span>荷物を選ぶと、その荷物が通った分岐が光ります</span></div>
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
          <strong>{item.object_id}</strong>　{attrText(item, st)}
          <div className="small">
            {item.outcome === 'placed'
              ? `${item.seq + 1}番目に配置（${item.placement?.support ? item.placement.support + 'の上' : '床'}・高さ${item.placement?.base_height ?? 0}m${item.placement?.rotated ? '・向きを変える' : ''}）`
              : `人へ引継ぎ：${item.handoff_reason}`}
            {item.applied_rules && item.applied_rules.length > 0 && `・規則：${item.applied_rules.map((t) => RULE_LABEL[t] ?? t).join('、')}`}
            {item.provisional && '・暫定動作'}
          </div>
          {(() => {
            const subs = (st.tasks?.major_tasks ?? []).flatMap((m) => m.subtasks.filter((s) => s.objects.includes(item.object_id)).map((s) => ({ m, s })))
            return subs.length > 0 && (
              <div className="small" data-testid="step1-link">
                動画の場面：{subs.map(({ m, s }) => (
                  <button key={s.id} className="link" onClick={() => setSeek({ t: s.start + 0.05, nonce: Date.now() })}>
                    {m.name} ＞ {s.name}（{fmt(s.start)}）▶
                  </button>
                ))}
              </div>
            )
          })()}
        </div>
      )}
      <div className="graph wf-graph">
        <WorkflowGraph key={ext?.created_at ?? 'fixture'} workflow={st.workflow} trace={trace} selectedId={nodeId} onSelect={setNodeId} />
      </div>
    </div>
  )
  const loopActive = taskId === LOOP_DECIDE && itemId && item ? (item.outcome === 'placed' ? 't_place' : 't_handoff') : null

  // ---- 業務全体：工程を縦に並べる ----
  if (!stage) {
    return (
      <div className="step-page workflow wf-overview" data-testid="page-2">
        <ContextBar caption="確認対象" testid="wf-ctx" fields={[scenarioField(st), workflowField(st)]}><VersionBar st={st} onChanged={onChanged} /></ContextBar>
        <section className="wf-main-col" data-testid="stage-overview">
          {/* 業務の要約（修正の対象ではない）：1行で端的に。折りたためる。下に確認事項の件数 */}
          {stages.length > 0 && (
            <div className="wf-summary" data-testid="wf-summary">
              <details open>
                <summary>業務の要約</summary>
                <p className="wf-summary-text">{briefOf(stages)}</p>
              </details>
              <div className="wf-summary-counts" data-testid="wf-summary-counts">
                現場への確認事項 未対応 <b>{confirms.filter((c) => !resolved[c.id]).length}</b>件／全{confirms.length}件<span className="muted">（各工程のタスクで消込）</span>
              </div>
            </div>
          )}
          <div className="wf-head">
            <div><div className="wf-crumb">業務全体</div><h2>工程の流れ</h2></div>
          </div>
          <ol className="stage-list" data-testid="stage-graph">
            {stages.map((s, i) => {
              const n = stageCounts(s)
              return (
                <li key={s.id} className="stage-li">
                  <div className="stage-row is-static" data-testid={`stage-card-${s.id}`}>
                    <span className="stage-no">{i + 1}</span>
                    <span className="stage-body">
                      <span className="stage-name">{s.name}</span>
                      <span className="stage-purpose">{s.purpose}</span>
                    </span>
                    <span className="stage-count"><b>{n.tasks}</b>タスク<b>{n.conds}</b>条件</span>
                    <button className="stage-check" onClick={() => goStage(s.id)} data-testid={`stage-check-${s.id}`} title="この工程のタスクと判断条件を確認・修正する">確認・修正 ›</button>
                  </div>
                </li>
              )
            })}
          </ol>
        </section>
      </div>
    )
  }

  // ---- 工程の詳細：左に工程、中央にタスク（判断条件つき）、右に動画・根拠・修正 ----
  const idx = stages.findIndex((s) => s.id === stage.id)
  const focus = isLoop
    ? node ? `荷物1個の判断のノード「${node.label ?? node.id}」（id: ${node.id}）` : loopTask ? `工程「${stage.name}」のタスク「${loopTask.label}」` : `工程「${stage.name}」`
    : pnode ? `工程「${stage.name}」のタスク「${pnode.label}」` : `工程「${stage.name}」`
  return (
    <div className="step-page workflow wf-drill" data-testid="page-2">
        <ContextBar caption="確認対象" testid="wf-ctx" fields={[scenarioField(st), workflowField(st)]}><VersionBar st={st} onChanged={onChanged} /></ContextBar>
      <nav className="wf-nav" data-testid="stage-bar">
        <button className="link back" onClick={() => goStage(null)} data-testid="back-overview">← 業務全体</button>
        <ol>
          {stages.map((s, i) => (
            <li key={s.id}>
              <button className={`wf-nav-item ${s.id === stage.id ? 'is-selected' : ''}`} onClick={() => goStage(s.id)} data-testid={`nav-${s.id}`}>
                <span className="stage-no">{i + 1}</span><span>{s.name}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <section className="wf-main-col" data-testid="stage-detail">
        <div className="wf-head">
          <div>
            <div className="wf-crumb">工程 {idx + 1} / {stages.length}</div>
            <h2>{stage.name}</h2>
            <p>{stage.purpose}</p>
          </div>
        </div>
        {cards.length === 0 && <p className="muted">この工程のタスクはありません。</p>}
        <TaskFlowList cards={cards} edges={isLoop ? LOOP_EDGES : stage.edges} testId={isLoop ? 'level1-graph' : 'pnode-list'}
          selectedId={taskId} activeId={loopActive} onSelect={(id) => { setTaskId(id); setNodeId(null) }} body={body}
          extra={(id) => (isLoop && id === LOOP_DECIDE && taskId === LOOP_DECIDE ? itemWorkflow : null)} />
      </section>

      <aside className="wf-side-col wf-side">
        <VideoPane src={st.video_url} muted={false} range={null} follow={false} missingNote={null} seek={seek} title="根拠の場面" />
        <div className="wf-detail" data-testid="wf-detail">
          {isLoop && node ? (
            <>
              <NodeDetail node={node} step={step} catalog={st.catalog} segments={segments} onSeek={onSeek} />
              <Confirmations items={confirms.filter((c) => c.related_node_ids.includes(node.id))} title="確認事項" open resolved={resolved} onToggle={toggleConfirm} />
            </>
          ) : loopTask ? (
            <div className="wf-card" data-testid="l1-detail">
              <div className="wf-card-h">{loopTask.label}</div>
              <p className="muted">実行器の固定の流れのタスクです。判断条件は各条件の「修正」（業務の規則の使い方）と「削除」（規則から外す）で直します。{loopTask.id === LOOP_DECIDE && '分岐図のノードを選ぶと、その判断の基準と根拠を表示します。'}</p>
              {loopTask.id === LOOP_DECIDE && <Confirmations items={itemConfirms} title="確認事項" resolved={resolved} onToggle={toggleConfirm} />}
            </div>
          ) : pnode ? (
            <div className="wf-card" data-testid="pnode-detail">
              <div className="wf-card-h">{pnode.label}<span className={`tflow-pill ${pnode.basis === 'ai_hypothesis' ? 'is-hyp' : ''}`}>{BASIS_LABEL[pnode.basis] ?? pnode.basis}</span></div>
              <div className="wf-sub">根拠</div>
              <EvidenceChips items={pnode.source_evidence} segments={segments} onSeek={onSeek} />
              <Confirmations items={byId(pnode.confirmation_refs ?? [])} title="確認事項" open resolved={resolved} onToggle={toggleConfirm} />
              {stage.role === 'final_check' && st.job.unsupported_rules.length > 0 && (
                <>
                  <div className="wf-sub">実行器では判定しない条件</div>
                  <ul className="wf-plain">{st.job.unsupported_rules.map((u) => <li key={u.text} data-testid="rule-unsupported">{u.text}</li>)}</ul>
                </>
              )}
            </div>
          ) : (
            <p className="muted small">タスクを選ぶと、根拠と確認事項を表示します。判断条件は各条件の「修正」「削除」で直せます。</p>
          )}
          {/* 修正欄：判断条件の「修正」を押したときだけ出す（入力欄とClaudeへの修正依頼） */}
          <div ref={setEditSlot} className={editingCond ? 'wf-edit-slot is-on' : 'wf-edit-slot'} data-testid="wf-edit-slot" />
          {ext && isLoop && node && !editingCond && nodeEdit !== node.id && (
            <button className="btn-ghost wf-node-edit" onClick={() => setNodeEdit(node.id)} data-testid="node-edit">この判断を修正</button>
          )}
          {ext && (editingCond || (isLoop && node && nodeEdit === node.id)) && <TeachPanel focus={focus} node={isLoop ? node : null} onChanged={onChanged} />}
        </div>
      </aside>
    </div>
  )
}

/** 業務の要約を1文で：中心の工程（タスクがいちばん多い工程）の目的の最後の句（「…ながら」「…、」の後ろ）。取れなければ工程名 */
function briefOf(stages: ReturnType<typeof stagesOf>): string {
  const main = [...stages].sort((a, b) => stageCounts(b).tasks - stageCounts(a).tasks)[0]
  const tail = (main.purpose ?? '').replace(/。$/, '').split(/、|ながら/).pop()?.trim() ?? ''
  return tail.length >= 6 ? tail : main.name
}

