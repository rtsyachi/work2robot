import { useEffect, useState } from 'react'
import type { EditOp, Proposal, V2State, WfNode } from '../types'
import { applyProposal, discardProposal, editWorkflow, proposeRevision } from '../api'
import { fieldLabel } from '../lib/labels'

const OPS: Record<string, string> = { eq: '＝（一致）', ge: '≧（以上）', lt: '＜（未満）', is_known: '分かっているか' }

/** 右の列の「修正」：荷物1個の判断ノードを選んでいればその基準の直接編集、それ以外はClaudeへの修正指示（修正案を見て承認）。
 *  タスクの判断条件の書き換えは、中央のタスクの中で直接行う（TaskConditions）。
 *  どちらも検証に通ったものだけ新しい版として保存し、画面のデータを読み直す。 */
export default function TeachPanel({ focus, node, onChanged }: { st?: V2State; focus: string; node?: WfNode | null; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [proposal, setProposal] = useState<Proposal | null>(null)
  useEffect(() => { setErr(null); setMsg(null) }, [focus])

  const run = (label: string, p: Promise<unknown>, done: string) => {
    setBusy(label); setErr(null); setMsg(null)
    p.then(() => { setMsg(done); onChanged() })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null))
  }
  const save = (ops: EditOp[], reason: string) => run('save', editWorkflow(ops, reason), '保存しました（新しい版）。')

  const propose = () => {
    setBusy('propose'); setErr(null); setMsg(null); setProposal(null)
    proposeRevision(instruction, focus).then(setProposal)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e))).finally(() => setBusy(null))
  }

  return (
    <section className="teach" data-testid="teach-panel">
      {node?.type === 'decision' && (
        <div className="teach-sec" data-testid="teach-direct">
          <div className="teach-h">判断の基準</div>
          {/* 対象が変わったら作り直す（前の対象の入力状態のまま描かない） */}
          <DecisionEditor key={node.id} node={node} busy={!!busy} onSave={save} />
        </div>
      )}
      <div className="teach-sec" data-testid="teach-claude">
        <div className="teach-h">Claudeに修正を頼む</div>
        <textarea id="teach-instruction" rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} disabled={!!busy}
          placeholder="例：柔らかいバッグの上に重量物を置かない条件を追加して" data-testid="teach-instruction" />
        <div className="teach-row">
          <button className="btn-primary" disabled={!!busy || !instruction.trim()} onClick={propose} data-testid="teach-propose">修正案を作る</button>
          <span className="muted small">対象：{focus}・約$0.25</span>
        </div>
        {busy === 'propose' && <div className="ai-status is-running">Claudeが修正案を作っています…（1〜2分）</div>}
        {proposal && <ProposalView p={proposal} busy={!!busy}
          onApply={() => { run('apply', applyProposal(proposal.id), '修正案を反映しました（新しい版）。'); setProposal(null); setInstruction('') }}
          onDiscard={() => { discardProposal(proposal.id).catch(() => undefined); setProposal(null) }} />}
      </div>
      {err && <div className="ai-status is-error" data-testid="teach-error">{err}</div>}
      {msg && <div className="ai-status is-done" data-testid="teach-done">{msg}</div>}
    </section>
  )
}

/** 判断ノード：比較・基準値・定義状態。基準値を入れると人の確認を根拠として残す。 */
function DecisionEditor({ node, busy, onSave }: { node: WfNode; busy: boolean; onSave: (ops: EditOp[], reason: string) => void }) {
  const [reason, setReason] = useState('')
  const [op, setOp] = useState<string>(node.operator ?? 'eq')
  const [value, setValue] = useState(node.value == null ? '' : String(node.value))
  const [status, setStatus] = useState<'defined' | 'needs_confirmation'>(node.definition_status === 'needs_confirmation' ? 'needs_confirmation' : 'defined')
  const [note, setNote] = useState(node.confirmation_note ?? '')
  useEffect(() => {
    setOp(node.operator ?? 'eq'); setValue(node.value == null ? '' : String(node.value))
    setStatus(node.definition_status === 'needs_confirmation' ? 'needs_confirmation' : 'defined'); setNote(node.confirmation_note ?? '')
  }, [node])
  const numeric = op === 'ge' || op === 'lt'
  const parsed = op === 'is_known' ? null : numeric ? Number(value) : value === 'true' ? true : value === 'false' ? false : value
  const edit: EditOp = { op: 'decision', node_id: node.id, operator: op, definition_status: status,
    ...(status === 'defined' ? { value: parsed } : { confirmation_note: note }) }
  return (
    <div className="teach-form" data-testid="decision-editor">
      <div className="small">判断する属性：<strong>{fieldLabel(node.field)}</strong>（{node.field}）</div>
      <div className="teach-row small">
        <select value={status} disabled={busy} onChange={(e) => setStatus(e.target.value as typeof status)} data-testid="edit-status">
          <option value="defined">定義済み（基準を決める）</option>
          <option value="needs_confirmation">要確認（基準は未定義）</option>
        </select>
        {status === 'defined' && (
          <>
            <select value={op} disabled={busy} onChange={(e) => setOp(e.target.value)} data-testid="edit-op">
              {Object.entries(OPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {op !== 'is_known' && <input type={numeric ? 'number' : 'text'} value={value} disabled={busy} onChange={(e) => setValue(e.target.value)}
              placeholder={numeric ? '基準値' : '値'} data-testid="edit-value" />}
          </>
        )}
      </div>
      {status === 'needs_confirmation' && <input className="small" value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} placeholder="何が未定義か" />}
      <input className="small" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} placeholder="確認した人・根拠（任意）" data-testid="teach-reason" />
      <div className="teach-row">
        <button className="btn-primary" disabled={busy || (status === 'defined' && op !== 'is_known' && (value === '' || (numeric && !Number.isFinite(Number(value)))))}
          onClick={() => onSave([edit], reason)} data-testid="edit-save">保存</button>
        <span className="muted small">「人が確認」を根拠に加えます</span>
      </div>
    </div>
  )
}

function ProposalView({ p, busy, onApply, onDiscard }: { p: Proposal; busy: boolean; onApply: () => void; onDiscard: () => void }) {
  const d = p.diff
  const none = !d.rules_added.length && !d.rules_removed.length && !d.rules_changed.length && !d.nodes_added.length
    && !d.nodes_removed.length && !d.nodes_changed.length && !d.confirmations_resolved.length && !d.confirmations_added.length
  const li = (key: string, cls: string, text: React.ReactNode) => <li key={key} className={cls}>{text}</li>
  return (
    <div className="proposal" data-testid="proposal">
      <div className="small"><strong>修正案</strong>（Claude {p.model}・検証済み・まだ保存していません）</div>
      {none ? <p className="muted small">変更はありませんでした。</p> : (
        <ul className="small diff">
          {d.rules_added.map((r) => li(`ra${r.type}`, 'is-add', <>規則を追加：{r.label}（{r.note}）</>))}
          {d.rules_removed.map((r) => li(`rr${r.type}`, 'is-del', <>規則を削除：{r.label}</>))}
          {d.rules_changed.map((r) => li(`rc${r.type}`, 'is-mod', <>規則の注記：{r.label}「{r.before}」→「{r.after}」</>))}
          {d.nodes_added.map((n) => li(`na${n.id}`, 'is-add', <>判断・動作を追加：{n.label}</>))}
          {d.nodes_removed.map((n) => li(`nr${n.id}`, 'is-del', <>判断・動作を削除：{n.label}</>))}
          {d.nodes_changed.map((n) => li(`nc${n.id}`, 'is-mod', <>変更：{n.label}<span className="muted">（{Object.keys(n.after).filter((k) => JSON.stringify(n.after[k]) !== JSON.stringify(n.before[k])).join('・')}）</span></>))}
          {d.confirmations_resolved.map((t) => li(`cr${t}`, 'is-del', <>確認事項を解消：{t}</>))}
          {d.confirmations_added.map((t) => li(`ca${t}`, 'is-add', <>確認事項を追加：{t}</>))}
          {JSON.stringify(d.unsupported_before) !== JSON.stringify(d.unsupported_after) && li('un', 'is-mod', <>未対応の規則：{d.unsupported_after.join('、') || 'なし'}</>)}
          {(d.stages_added ?? []).map((s) => li(`sa${s}`, 'is-add', <>工程を追加：{s}</>))}
          {(d.stages_removed ?? []).map((s) => li(`sr${s}`, 'is-del', <>工程を削除：{s}</>))}
          {(d.stages_changed ?? []).map((s) => li(`sc${s.stage}`, 'is-mod', <>工程「{s.stage}」：{[
            ...s.added.map((x) => `追加 ${x}`), ...s.removed.map((x) => `削除 ${x}`), ...s.changed.map((x) => `変更 ${x}`)].join('、')}</>))}
        </ul>
      )}
      <div className="muted small">要約：{p.summary}</div>
      <div className="teach-row">
        <button className="btn-primary" disabled={busy || none} onClick={onApply} data-testid="proposal-apply">反映する</button>
        <button className="link" disabled={busy} onClick={onDiscard} data-testid="proposal-discard">破棄</button>
      </div>
    </div>
  )
}
