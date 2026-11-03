import { describe, expect, it } from 'vitest'
import job from './__fixtures__/job_mixed.json'
import type { JobTrace } from '../types'
import { buildTimeline, elbow, sampleTimeline } from './robotTimeline'

const trace = job as unknown as JobTrace

describe('buildTimeline / sampleTimeline', () => {
  const tl = buildTimeline(trace)

  it('基本動作の順番どおりに区間を並べる', () => {
    expect(tl.segments.map((s) => s.primitive.seq)).toEqual(trace.primitives.map((p) => p.seq))
    tl.segments.forEach((s, i) => {
      expect(s.end).toBeGreaterThan(s.start)
      if (i > 0) expect(s.start).toBe(tl.segments[i - 1].end)
    })
  })

  it('最後には全ての荷物が業務実行トレースの配置位置にある', () => {
    const end = sampleTimeline(tl, tl.duration + 1)
    for (const it of trace.items) {
      const s = end.items[it.object_id]
      expect(s.state).toBe(it.outcome)
      if (it.placement) {
        s.pos.forEach((v, k) => expect(v).toBeCloseTo(it.placement!.position[k], 6))
      }
    }
  })

  it('最初は全ての荷物が仮置き台（カゴ車の外）にあり、最初に処理する荷物だけが作業中', () => {
    const start = sampleTimeline(tl, 0)
    for (const [id, it] of Object.entries(start.items)) {
      expect(it.state).toBe(id === trace.order[0] ? 'active' : 'waiting')
      expect(it.pos[0]).toBeLessThan(-0.5)
    }
  })

  it('途中では現在の基本動作が分かる', () => {
    const seg = tl.segments.find((s) => s.primitive.kind === 'move')!
    const mid = sampleTimeline(tl, (seg.start + seg.end) / 2)
    expect(mid.current?.primitive.seq).toBe(seg.primitive.seq)
    expect(mid.items[seg.primitive.object_id].state).toBe('active')
  })

  it('押し込まない置き方は通常よりゆっくり', () => {
    const places = tl.segments.filter((s) => s.primitive.kind === 'place')
    const gentle = places.find((s) => s.primitive.press_mode === 'no_press')!
    const normal = places.find((s) => s.primitive.press_mode === 'normal')!
    expect(gentle.end - gentle.start).toBeGreaterThan(normal.end - normal.start)
  })
})

describe('elbow', () => {
  it('肩と把持位置からそれぞれリンク長の距離にある', () => {
    const sh: [number, number, number] = [0, 1.15, 0.85]
    const tg: [number, number, number] = [0, 0.4, 0.1]
    const e = elbow(sh, tg)
    expect(Math.hypot(e[1] - sh[1], e[2] - sh[2])).toBeCloseTo(0.75, 5)
    expect(Math.hypot(tg[1] - e[1], tg[2] - e[2])).toBeCloseTo(0.75, 5)
  })
})
