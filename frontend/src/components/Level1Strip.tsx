import type { Level1Graph } from '../types'

type Props = { level1: Level1Graph; activeId: string | null; progress: string }

// Level 1（業務全体）の流れを1行で表示し、実行中のノードを光らせる。
export default function Level1Strip({ level1, activeId, progress }: Props) {
  const loop = new Set(['l1_take_next', 'l1_item_workflow', 'l1_check_space', 'l1_place', 'l1_handoff', 'l1_update', 'l1_more'])
  return (
    <div className="l1" data-testid="level1">
      <span className="l1-title">業務全体（Level 1）</span>
      {level1.nodes.map((n, i) => (
        <span key={n.id} className="l1-item">
          {i > 0 && <span className="l1-arrow">{n.id === 'l1_handoff' ? '／' : '→'}</span>}
          <span
            className={`l1-node ${loop.has(n.id) ? 'in-loop' : ''} ${n.id === activeId ? 'is-active' : ''}`}
            data-testid={`l1-${n.id}`}
          >
            {n.label}
          </span>
        </span>
      ))}
      <span className="l1-loop">↺ 荷物ごとに繰り返す</span>
      {progress && <span className="l1-progress">{progress}</span>}
    </div>
  )
}
