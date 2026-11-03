import type { Extraction } from '../types'

const KIND_LABEL: Record<string, string> = {
  undefined_condition: '基準が未定義',
  missing_information: '不足情報',
  provisional_action: '暫定動作',
  physical_poc: '実機PoC',
}

type Props = { extraction: Extraction; onSelectNode: (id: string) => void }

export default function ExtractionPanel({ extraction, onSelectNode }: Props) {
  const tokens = extraction.meta.usage.reduce((a, u) => a + u.input_tokens + u.output_tokens, 0)
  return (
    <div className="extraction" data-testid="extraction-panel">
      <h2>Claudeによる抽出結果</h2>
      <p className="summary-text">{extraction.summary}</p>
      <p className="small">
        入力：{extraction.meta.observation_source === 'video_observation' ? '動画から作った観測テキスト' : '開発用の固定観測テキスト'}＋説明テキスト
        <br />
        業務全体：{extraction.job.order_rule.zones.map((z) => (z === 'bottom' ? '下段' : '上段')).join('→')}の順に積み、全ての荷物を処理したら終了
      </p>
      <p className="muted small">
        {extraction.source === 'live' ? '今回生成' : '保存済みの生成結果'}・{extraction.created_at}・
        {extraction.meta.model}・試行{extraction.meta.attempts}回・{tokens.toLocaleString()}トークン
        {extraction.meta.fallback_used && '・フォールバックあり'}
      </p>
      <h4>確認事項（{extraction.confirmation_items.length}件）</h4>
      <ul className="items">
        {extraction.confirmation_items.map((c) => (
          <li key={c.id}>
            <span className={`kind kind-${c.kind}`}>{KIND_LABEL[c.kind] ?? c.kind}</span>
            <strong>{c.topic}</strong>
            <div>{c.detail}</div>
            {c.related_node_ids.length > 0 && (
              <div className="links">
                {c.related_node_ids.map((id) => (
                  <button key={id} className="link" onClick={() => onSelectNode(id)}>{id}</button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
