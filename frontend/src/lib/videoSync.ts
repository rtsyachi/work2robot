// 観測テキスト（動画から作ったもの）から、荷物ごとに人が扱っている動画区間を求める。
import type { Segment } from '../types'

export function toSeconds(t: string): number {
  const [m, s] = t.split(':').map(Number)
  return (m || 0) * 60 + (s || 0)
}

/** 荷物IDごとの動画区間 [開始, 終了)（秒）。観測セグメントの objects（動画で読み取ったタグ）を使う。 */
export function objectRanges(segments: Segment[]): Record<string, { start: number; end: number }> {
  const ranges: Record<string, { start: number; end: number }> = {}
  segments.forEach((s, i) => {
    const start = toSeconds(s.t)
    const next = segments[i + 1] ? toSeconds(segments[i + 1].t) : start + 1.5
    for (const id of s.objects ?? []) {
      const r = ranges[id]
      ranges[id] = r ? { start: Math.min(r.start, start), end: Math.max(r.end, next) } : { start, end: next }
    }
  })
  return ranges
}
