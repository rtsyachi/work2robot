import type { Evidence, Segment } from '../types'
import { EVIDENCE_LABEL } from '../lib/labels'

export type SegmentMap = Record<string, Segment & { kind: string; seconds?: number }>

/** 根拠の一覧。説明・観測のセグメントがあれば文と時刻を出し、動画のその場面へ移動できる。 */
export default function EvidenceChips({ items, segments, onSeek }: {
  items: Evidence[]
  segments: SegmentMap
  onSeek?: (t: string) => void
}) {
  if (!items.length) return null
  return (
    <ul className="evidence">
      {items.map((e, i) => {
        const seg = e.ref ? segments[e.ref] : undefined
        return (
          <li key={i}>
            <span className={`ev ev-${e.type}`}>{EVIDENCE_LABEL[e.type] ?? e.type}</span>
            {seg ? (
              <span className="ev-seg" data-testid={`seg-${seg.id}`}>
                {seg.id}（{seg.t}）「{seg.text}」
                {onSeek && <button className="link" onClick={() => onSeek(seg.t)} data-testid={`seek-${seg.id}`}>▶ 動画</button>}
              </span>
            ) : (
              e.note && <span className="ev-note">{e.note}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
