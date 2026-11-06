import type { ReactNode } from 'react'

export type FlowCard = {
  id: string
  label: string
  exception?: boolean               // 例外のタスク（人へ引き継ぐ など）
  detail?: string
  hypothesis?: boolean              // 動画・説明に根拠がなく Claude が補完したタスク
  confirms: number                  // 関係する確認事項の数
}
export type FlowEdge = { source: string; target: string; label: string }

/** 工程の詳細（Level 2）：タスクを番号つきで上から下へ並べる。各タスクの中に判断条件（body）を入れ、
 *  条件つきの分岐（↳）と繰り返し（↻）を辺から表示する。判断はノードにしない。 */
export default function TaskFlowList({ cards, edges, selectedId, activeId, onSelect, body, extra, testId = 'task-flow' }: {
  cards: FlowCard[]
  edges: FlowEdge[]
  selectedId: string | null
  activeId?: string | null
  onSelect: (id: string) => void
  body?: (id: string) => ReactNode    // タスクの中に入れる内容（判断条件）
  extra?: (id: string) => ReactNode   // タスクの下に広げる内容（荷物1個の判断の図など）
  testId?: string
}) {
  const index = Object.fromEntries(cards.map((c, i) => [c.id, i]))
  const label = (id: string) => cards[index[id]]?.label ?? id
  return (
    <ol className="tflow" data-testid={testId}>
      {cards.map((c, i) => {
        const out = edges.filter((e) => e.source === c.id)
        const back = out.filter((e) => (index[e.target] ?? 1e9) <= i)                    // 前のタスクへ戻る＝繰り返し
        const branch = out.filter((e) => !back.includes(e) && e.label)                    // 条件つきの分岐
        return (
          <li key={c.id} className="tflow-item">
            <div className={`tflow-card ${c.exception ? 'is-exception' : ''} ${c.id === selectedId ? 'is-on' : ''} ${c.id === activeId ? 'is-active' : ''}`}
              onClick={() => onSelect(c.id)} data-testid={`tcard-${c.id}`}>
              <div className="tflow-head">
                <span className="tflow-no">{String(i + 1).padStart(2, '0')}</span>
                <strong>{c.label}</strong>
                {c.exception && <span className="tflow-pill is-exc">例外</span>}
                {c.hypothesis && <span className="tflow-pill is-hyp" title="動画・説明に根拠がなく、Claudeが補完したタスク">補完</span>}
                {c.confirms > 0 && <span className="tflow-pill is-conf" title="関係する確認事項">確認 {c.confirms}</span>}
              </div>
              {c.detail && <div className="tflow-detail">{c.detail}</div>}
              <div data-testid={`hang-${c.id}`}>{body?.(c.id)}</div>
              {branch.map((e) => <div key={e.target} className="tflow-branch">↳ {e.label} → {label(e.target)}</div>)}
              {back.map((e) => <div key={e.target} className="tflow-loop" data-testid={`loop-${c.id}`}>↻ {e.label || '繰り返す'} → {label(e.target)}</div>)}
            </div>
            {extra?.(c.id)}
          </li>
        )
      })}
    </ol>
  )
}
