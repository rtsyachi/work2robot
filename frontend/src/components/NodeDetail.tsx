import type { Catalog, Segment, TraceStep, WfNode } from '../types'
import {
  EVIDENCE_LABEL,
  NODE_TYPE_LABEL,
  RESULT_LABEL,
  conditionText,
  fieldLabel,
  formatValue,
  paramsText,
} from '../lib/labels'

type Props = {
  node: WfNode | null
  step: TraceStep | null
  catalog: Catalog
  segments: Record<string, Segment & { kind: string }>
  onSeek?: (t: string) => void
}

function EvidenceList({ node, segments, onSeek }: { node: WfNode; segments: Props['segments']; onSeek?: Props['onSeek'] }) {
  return (
    <>
      <h4>根拠</h4>
      <ul className="evidence">
        {(node.source_evidence ?? []).map((e, i) => {
          const seg = e.ref ? segments[e.ref] : undefined
          return (
            <li key={i}>
              <span className={`ev ev-${e.type}`}>{EVIDENCE_LABEL[e.type] ?? e.type}</span>
              {e.note && <span className="ev-note">{e.note}</span>}
              {seg && (
                <span className="ev-seg" data-testid={`seg-${seg.id}`}>
                  {seg.kind} {seg.id}（{seg.t}）「{seg.text}」
                  {seg.kind === '動画で観測' && onSeek && (
                    <button className="link" onClick={() => onSeek(seg.t)} data-testid={`seek-${seg.id}`}>▶ 動画のこの場面</button>
                  )}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}

export default function NodeDetail({ node, step, catalog, segments, onSeek }: Props) {
  if (!node) {
    return <p className="muted">ノードを選ぶと、判断条件と根拠が表示されます。</p>
  }
  const skill = node.type === 'skill' ? catalog.skills.find((s) => s.name === node.skill_name) : undefined

  return (
    <div className="detail" data-testid="node-detail">
      <div className="detail-type">{NODE_TYPE_LABEL[node.type]}</div>
      <h3>{node.label ?? node.id}</h3>

      {node.type === 'decision' && (
        <>
          <dl>
            <dt>条件</dt>
            <dd className="mono">{conditionText(node)}</dd>
            <dt>定義状態</dt>
            <dd>
              {node.definition_status === 'defined' ? (
                <span className="badge badge-ok">定義済み</span>
              ) : (
                <>
                  <span className="badge badge-warn">要確認</span>
                  <div className="note">{node.confirmation_note}</div>
                  <div className="note">確定した分岐としては実行せず、「不明」の経路へ進みます。</div>
                </>
              )}
            </dd>
          </dl>
          <EvidenceList node={node} segments={segments} onSeek={onSeek} />
        </>
      )}

      {node.type === 'observe' && (
        <p>確認する属性：{(node.required_fields ?? []).map(fieldLabel).join('、')}</p>
      )}

      {node.type === 'skill' && (
        <>
          <dl>
            <dt>動作</dt>
            <dd>{skill?.description ?? node.skill_name}</dd>
            <dt>指定</dt>
            <dd>{paramsText(node.parameters ?? {})}</dd>
            <dt>実機での検証</dt>
            <dd><span className="badge badge-warn">未検証（模擬スキル）</span></dd>
            {node.provisional && (
              <>
                <dt>暫定動作</dt>
                <dd>
                  <span className="badge badge-warn">暫定・要確認</span>
                  <div className="note">{node.provisional_note}</div>
                </dd>
              </>
            )}
          </dl>
          {node.provisional && <EvidenceList node={node} segments={segments} onSeek={onSeek} />}
          {skill && (
            <>
              <h4>実機PoCで確かめる項目</h4>
              <ul>{skill.poc_checks.map((c) => <li key={c}>{c}</li>)}</ul>
            </>
          )}
        </>
      )}

      {node.type === 'handoff' && <p>理由：{node.reason}</p>}
      {node.type === 'end' && <p>結果：{RESULT_LABEL[node.result ?? ''] ?? node.result}</p>}

      {step && (
        <div className="this-run" data-testid="this-run">
          <h4>この荷物での実行結果</h4>
          {step.node_type === 'decision' && (
            <dl>
              <dt>使った値</dt>
              <dd>
                {step.input && step.input.value !== null && step.input.value !== undefined
                  ? `${formatValue(step.input.value)}（${EVIDENCE_LABEL[step.input.source] ?? step.input.source}）`
                  : '不明'}
              </dd>
              <dt>判定</dt>
              <dd><strong>{RESULT_LABEL[step.result ?? '']}</strong></dd>
              {step.reason && (<><dt>理由</dt><dd>{step.reason}</dd></>)}
            </dl>
          )}
          {step.node_type === 'observe' && step.missing_fields && step.missing_fields.length > 0 && (
            <p>不明な属性：{step.missing_fields.map(fieldLabel).join('、')}</p>
          )}
          {step.node_type !== 'decision' && step.node_type !== 'observe' && <p>この荷物はこのノードを通過しました。</p>}
        </div>
      )}
    </div>
  )
}
