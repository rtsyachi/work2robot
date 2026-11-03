import type { Readiness } from '../types'

const SECTIONS: { key: keyof Readiness['categories']; title: string; cls: string }[] = [
  { key: 'workflow_checked', title: '論理的に確認できたこと', cls: 'ok' },
  { key: 'needs_information', title: '不足している情報・未定義の基準', cls: 'info' },
  { key: 'needs_physical_poc', title: '実機PoCで確かめること（ロボットの未検証能力）', cls: 'poc' },
  { key: 'requires_human', title: '人の確認・引継ぎが必要', cls: 'human' },
]

export default function ReadinessPanel({ readiness }: { readiness: Readiness }) {
  return (
    <div className="readiness" data-testid="readiness">
      <div className="rd-items">
        {readiness.items.map((i) => (
          <div key={i.object_id} className={`rd-item rd-${i.status}`} title={i.reasons.join('\n')}>
            <strong>{i.object_id}</strong> {i.label}
          </div>
        ))}
      </div>
      {SECTIONS.map((s) => (
        <section key={s.key} className={`rd-sec rd-${s.cls}`}>
          <h4>{s.title}（{readiness.categories[s.key].length}）</h4>
          <ul>{readiness.categories[s.key].map((x) => <li key={x}>{x}</li>)}</ul>
        </section>
      ))}
      <p className="muted small">{readiness.note}</p>
    </div>
  )
}
