import type { Trace, Workflow } from '../types'
import { EVIDENCE_LABEL, RESULT_LABEL, fieldLabel, paramsText } from '../lib/labels'

type Props = { trace: Trace; workflow: Workflow }

export default function TraceSummary({ trace, workflow }: Props) {
  const nodeOf = (id: string) => workflow.nodes.find((n) => n.id === id)
  const provisional = trace.provisional_actions.length > 0
  const items: string[] = [
    ...trace.unconfirmed_conditions.map((id) => {
      const n = nodeOf(id)
      return `要確認の条件「${n?.label ?? id}」：${n?.confirmation_note ?? ''}`
    }),
    ...trace.unknown_fields.map((f) => `属性が不明：${fieldLabel(f)}`),
    ...trace.provisional_actions.map((p) => {
      const kinds = p.evidence.map((e) => EVIDENCE_LABEL[e.type] ?? e.type).join('・')
      return `暫定動作：${p.note}（根拠：${kinds}）`
    }),
  ]

  return (
    <div className="summary" data-testid="trace-summary">
      <div className={`result result-${trace.result}${provisional ? ' result-provisional' : ''}`}>
        荷物 {trace.object_id}：{RESULT_LABEL[trace.result]}
        {provisional && '（暫定動作あり）'}
      </div>
      {trace.skill_events.map((e) => (
        <div key={e.seq} className="row">
          ロボット動作（模擬）：{paramsText(e.parameters)}に置く{e.provisional && '【暫定】'}
        </div>
      ))}
      {trace.handoffs.map((h) => (
        <div key={h.node_id} className="row">引継ぎ理由：{h.reason}</div>
      ))}
      {items.length > 0 && (
        <div className="confirm" data-testid="confirmation-items">
          <h4>確認事項（{items.length}件）</h4>
          <ul>{items.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
      )}
      <p className="muted small">
        仮想実行の結果です。作業ロジックの確認であり、実機の把持・安全性を保証するものではありません。
      </p>
    </div>
  )
}
