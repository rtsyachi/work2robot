import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { EditOp, Evidence } from '../types'
import EvidenceChips, { type SegmentMap } from './Evidence'
import { BASIS_LABEL, KIND_LABEL } from '../lib/process'

/** タスクの判断条件1つ（並び順＝優先度） */
export type Cond = {
  key: string
  name: string
  how: string
  kind?: 'must' | 'prefer' | 'logic'          // 積付の工程：必須・優先・分岐
  rules: { type: string; label: string; status?: string; selected: boolean; detail?: string; evidence?: Evidence[] }[]
  basis?: string
  evidence?: Evidence[]
}

const STATUS: Record<string, { text: string; cls: string }> = {
  applied: { text: '適用', cls: 'is-ok' }, not_applicable: { text: '未適用', cls: 'is-warn' }, unsupported: { text: '未対応', cls: 'is-err' },
}
type Saver = (ops: EditOp[], reason: string) => Promise<void>
type Crit = { name: string; how: string; rule_refs: string[] }

/** タスクの判断条件を優先度順に並べる。各条件の右に「修正」「削除」（抽出した工程は↑↓も）を出し、
 *  「修正」を押したときだけ入力欄を開く。保存するたびに新しい版になる。
 *  mode=criteria：Claudeが抽出した工程のタスク（基準名・使い方・並び順・追加・削除。タスクの条件の一覧ごと保存）
 *  mode=rules：積付の工程（実行器が使う業務の規則の使い方を修正／規則から外す。並び順は実行器の判断の順で固定） */
export default function TaskConditions({ conds, mode, task, active, testId, onSave: save0, segments, onSeek, slot, onEditing }: {
  conds: Cond[]
  mode: 'criteria' | 'rules'
  task?: { stage_id: string; node_id: string }   // mode=criteria で保存する先のタスク
  active: boolean                                 // このタスクを選んでいるか（入力欄・追加は選んだタスクだけ）
  testId: string
  onSave: Saver
  segments: SegmentMap
  onSeek: (t: string) => void
  slot?: HTMLElement | null                       // 入力欄を出す右の欄（なければ条件の下に出す）
  onEditing?: (on: boolean) => void              // 入力欄を開いた／閉じた
}) {
  const [edit0, setEdit] = useState<string | null>(null)         // 入力欄を開いている条件（'__new'＝追加）
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<{ key: string; text: string } | null>(null)
  const editing = active ? edit0 : null
  useEffect(() => { onEditing?.(editing != null) }, [editing, onEditing])
  // 入力欄は右の欄に出す（slot があるとき）
  const place = (node: React.ReactNode) => (slot ? createPortal(<div className="cond-side" data-testid="cond-side">{node}</div>, slot) : node)
  const onSave: Saver = (ops, reason) => save0(ops.map((o) => (o.op === 'criteria' && task ? { ...o, ...task } : o)), reason)
  const run = (key: string, ops: EditOp[], reason = '') => {
    setBusy(key); setErr(null)
    return onSave(ops, reason)
      .then(() => { setEdit(null); setConfirmDel(null) })
      .catch((e) => setErr({ key, text: e instanceof Error ? e.message : String(e) }))
      .finally(() => setBusy(null))
  }
  const list: Crit[] = conds.map((c) => ({ name: c.name, how: c.how, rule_refs: c.rules.map((r) => r.type) }))
  const critOp = (criteria: Crit[]): EditOp[] => [{ op: 'criteria', stage_id: '', node_id: '', criteria }]
  const move = (i: number, d: -1 | 1) => {
    const l = [...list]; const [x] = l.splice(i, 1); l.splice(i + d, 0, x)
    run(conds[i].key, critOp(l))
  }
  const remove = (i: number) => {
    const c = conds[i]
    if (mode === 'criteria') return run(c.key, critOp(list.filter((_, j) => j !== i)))
    return run(c.key, [{ op: 'rule', type: c.rules[0].type, enabled: false }])
  }

  if (conds.length === 0 && (mode === 'rules' || !active)) return null
  // 修正・削除は常に表示（押すとそのタスクを選んだ状態にする＝カードのクリックとして伝わる）
  return (
    <div className={`conds ${active ? 'is-active' : ''}`}>
      {conds.length > 0 && <div className="conds-h">判断条件<span>優先度順{mode === 'rules' ? '・順番は実行器で固定' : ''}</span></div>}
      <ol className={`conds-list ${conds.length === 0 ? 'is-empty' : ''}`} data-testid={testId}>
        {conds.map((c, i) => {
          const rule = c.rules[0]
          const off = c.rules.length > 0 && c.rules.every((r) => !r.selected)
          const isBusy = busy === c.key
          return (
            <li key={c.key} className={`cond ${editing === c.key ? 'is-open' : ''} ${off ? 'is-off' : ''}`} data-testid="criterion">
              <div className="cond-row" data-testid={`cond-${i}`}>
                <span className="cond-no">{i + 1}</span>
                {c.kind && <span className={`cond-kind k-${c.kind}`}>{KIND_LABEL[c.kind]}</span>}
                <span className="cond-name">{c.name}</span>
                <span className="cond-how">{c.how}</span>
                <span className="cond-meta">
                  {c.rules.map((r) => r.selected
                    ? <span key={r.type} className={`cond-rule ${STATUS[r.status ?? '']?.cls ?? ''}`} title={r.label}>規則{r.status && STATUS[r.status] ? `・${STATUS[r.status].text}` : ''}</span>
                    : <span key={r.type} className="cond-rule is-none" title={r.label}>規則なし</span>)}
                  {c.basis === 'ai_hypothesis' && <span className="cond-hyp" title={BASIS_LABEL[c.basis]}>補完</span>}
                  {c.basis === 'human_confirmed' && <span className="cond-human">人が確認</span>}
                </span>
                <span className="cond-ops">
                  {isBusy ? <span className="muted small">保存中…</span>
                    : c.kind === 'logic' ? <span className="muted small">下の分岐図で修正</span>
                    : confirmDel === c.key ? (
                      <>
                        <button className="op is-danger" onClick={() => remove(i)} data-testid="cond-del-ok">{mode === 'rules' ? '規則から外す' : '削除する'}</button>
                        <button className="op" onClick={() => setConfirmDel(null)}>やめる</button>
                      </>
                    ) : (
                      <>
                        {mode === 'criteria' && <>
                          <button className="op icon" disabled={!!busy || i === 0} onClick={() => move(i, -1)} title="優先度を上げる" data-testid="cond-up">↑</button>
                          <button className="op icon" disabled={!!busy || i === conds.length - 1} onClick={() => move(i, 1)} title="優先度を下げる" data-testid="cond-down">↓</button>
                        </>}
                        {mode === 'rules' && off
                          ? <button className="op" disabled={!!busy} onClick={() => setEdit(c.key)} title="業務の規則として使う" data-testid="cond-edit">使う</button>
                          : <>
                            <button className="op" disabled={!!busy} onClick={() => { setEdit(editing === c.key ? null : c.key); setConfirmDel(null) }} data-testid="cond-edit">修正</button>
                            <button className="op is-danger" disabled={!!busy} onClick={() => { setConfirmDel(c.key); setEdit(null) }}
                              title={mode === 'rules' ? `業務の規則「${rule?.label}」から外します（同じ規則を使うほかのタスクからも外れます）` : undefined}
                              data-testid="cond-del">削除</button>
                          </>}
                      </>
                    )}
                </span>
              </div>
              {editing === c.key && place(<>
                <div className="cond-side-h">判断条件の修正：{c.name}</div>
                <CondForm key={c.key} cond={c} withName={mode === 'criteria'} busy={isBusy} segments={segments} onSeek={onSeek}
                  onCancel={() => setEdit(null)}
                  onSave={(name, how, reason) => run(c.key, mode === 'criteria'
                    ? critOp(list.map((x, j) => (j === i ? { ...x, name, how } : x)))
                    : [{ op: 'rule', type: rule.type, enabled: true, note: how }], reason)} />
                {err?.key === c.key && <div className="cond-err">{err.text}</div>}
              </>)}
            </li>
          )
        })}
      </ol>
      {mode === 'criteria' && active && <button className="cond-add" onClick={() => setEdit('__new')} data-testid="cond-add">＋ 判断条件を追加</button>}
      {mode === 'criteria' && editing === '__new' && place(
        <div className="conds-new">
          <div className="cond-side-h">判断条件の追加</div>
          <CondForm key="__new" withName busy={busy === '__new'} segments={segments} onSeek={onSeek} onCancel={() => setEdit(null)}
            onSave={(name, how, reason) => run('__new', critOp([...list, { name, how, rule_refs: [] }]), reason)} />
          {err?.key === '__new' && <div className="cond-err">{err.text}</div>}
        </div>)}
    </div>
  )
}

/** 「修正」「追加」を押したときだけ開く入力欄 */
function CondForm({ cond, withName, busy, onSave, onCancel, segments, onSeek }: {
  cond?: Cond; withName: boolean; busy: boolean; onSave: (name: string, how: string, reason: string) => void; onCancel: () => void
  segments: SegmentMap; onSeek: (t: string) => void
}) {
  const [name, setName] = useState(cond?.name ?? '')
  const [how, setHow] = useState(cond?.how ?? '')
  const [reason, setReason] = useState('')
  const rule = cond?.rules[0]
  const changed = !cond || name.trim() !== cond.name || how.trim() !== cond.how || (rule != null && !rule.selected)
  return (
    <div className="cond-edit" data-testid="cond-editor">
      <div className="cond-edit-grid">
        {withName && <label>基準<input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：重量" disabled={busy} data-testid="cond-name" /></label>}
        <label>使い方<textarea rows={2} value={how} onChange={(e) => setHow(e.target.value)} placeholder="例：重い荷物から先に積む" disabled={busy} data-testid="cond-how" /></label>
        <label>確認した人・根拠<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="任意" disabled={busy} /></label>
      </div>
      {cond && (cond.rules.length > 0 || (cond.evidence?.length ?? 0) > 0) && (
        <div className="cond-src">
          {cond.rules.map((r) => <div key={r.type}>業務の規則：{r.label}{r.detail ? `（実行結果：${r.detail}）` : ''}</div>)}
          {!withName && rule && <div>使い方を直すと、この規則を使うほかのタスクにも反映されます。</div>}
          {(cond.evidence ?? rule?.evidence) && <EvidenceChips items={cond.evidence ?? rule?.evidence ?? []} segments={segments} onSeek={onSeek} />}
        </div>
      )}
      <div className="cond-actions">
        <button className="btn-primary" disabled={busy || (withName && !name.trim()) || !how.trim() || !changed}
          onClick={() => onSave(name.trim(), how.trim(), reason)} data-testid="cond-save">保存</button>
        <button className="btn-ghost" disabled={busy} onClick={onCancel}>キャンセル</button>
      </div>
    </div>
  )
}
