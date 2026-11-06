import type { ReactNode } from 'react'
import type { V2State } from '../types'

/** 画面上部の共通の帯：シナリオ・ワークフロー・（画面によっては）ロボット構成・出荷予定。Step 3〜6 で同じ見た目にする。
 *  選べる項目は select、引き継いだだけの項目は同じ枠の表示だけ。右側（children）に画面ごとの操作・件数を置く。 */
export type CtxField = {
  key: string
  label: string
  value: string                                   // 表示する値（選べない項目）
  options?: { value: string; label: string; disabled?: boolean }[]
  selected?: string
  onChange?: (v: string) => void
  title?: string                                  // マウスを合わせると出る補足
  id?: string | null                              // 薄く添える ID
  testid?: string
}

export const SCENARIO_TYPES = [
  { id: 'cage_cart_loading', label: 'カゴ車への混載荷物積付', active: true },
  { id: 'transport', label: '荷物の運搬', active: false },
  { id: 'sorting', label: '仕分け', active: false },
  { id: 'replenishment', label: '棚補充', active: false },
]

/** シナリオ（業務の種類は今回は積付だけ。ほかは「未評価」で選べない） */
export function scenarioField(st: V2State, testid = 'ctx-scenario'): CtxField {
  return {
    key: 'scenario', label: 'シナリオ', value: st.scenario.name, selected: st.scenario.type, onChange: () => undefined, testid,
    title: `シナリオID ${st.scenario.scenario_id}`, id: st.scenario.scenario_id,
    options: SCENARIO_TYPES.map((s) => ({ value: s.id, label: s.id === st.scenario.type ? st.scenario.name : `${s.label}（未評価）`, disabled: !s.active })),
  }
}
/** ワークフロー（Step 3 で確認した今の版） */
export function workflowField(st: V2State, testid = 'ctx-workflow'): CtxField {
  return {
    key: 'workflow', label: 'ワークフロー', testid,
    value: st.refs.workflow_id ? `確認済みの版（工程${st.extraction?.process?.stages?.length ?? '—'}）` : '手書きの業務定義（未生成）',
    title: `ワークフローID ${st.refs.workflow_id ?? '—'}`, id: st.refs.workflow_id,
  }
}
/** 出荷予定（Step 2 で選んだシナリオの対象） */
export function batchField(st: V2State, batchId: string, testid = 'ctx-batch'): CtxField {
  return { key: 'batch', label: '出荷予定', value: st.batches.find((b) => b.batch_id === batchId)?.label ?? batchId, title: `出荷予定ID ${batchId}`, testid }
}

export default function ContextBar({ caption, fields, children, testid }: { caption: string; fields: CtxField[]; children?: ReactNode; testid?: string }) {
  return (
    <section className="ctx-bar" data-testid={testid}>
      <span className="ctx-caption">{caption}</span>
      {fields.map((f) => (
        <label key={f.key} className="ctx-item" title={f.title}>
          <span className="ctx-label">{f.label}</span>
          {f.options
            ? <select value={f.selected} onChange={(e) => f.onChange?.(e.target.value)} data-testid={f.testid}>
                {f.options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
              </select>
            : <span className="ctx-value" data-testid={f.testid}>{f.value}</span>}
          {f.id && <span className="ctx-id" data-testid={f.testid ? `${f.testid}-id` : undefined}>{f.id}</span>}
        </label>
      ))}
      {children && <span className="ctx-right">{children}</span>}
    </section>
  )
}
