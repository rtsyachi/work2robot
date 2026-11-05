import { describe, expect, it } from 'vitest'
import job from './__fixtures__/job_mixed.json'
import type { JobTrace } from '../types'
import { buildTimeline, elbow, sampleTimeline, solveArm } from './robotTimeline'

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

describe('Pick / Move / Place の段階', () => {
  const tl = buildTimeline(trace)
  const pick = tl.segments.find((s) => s.primitive.kind === 'pick')!
  const id = pick.primitive.object_id
  const inPick = tl.phases.filter((p) => p.start >= pick.start && p.end <= pick.end).map((p) => p.phase)

  it('接近 → 接触・把持 → 持ち上げ の順で、把持してから持ち上げる', () => {
    expect(inPick).toEqual(['approach', 'grasp', 'grasp', 'lift'])
    const lift = tl.phases.find((p) => p.start >= pick.start && p.phase === 'lift')!
    expect(sampleTimeline(tl, lift.start + 1e-3).grip).toBeGreaterThan(0.99)
    // 把持の前は荷物が動かない
    const before = sampleTimeline(tl, pick.start + 0.01).items[id].pos
    const atGrasp = sampleTimeline(tl, lift.start).items[id].pos
    before.forEach((v, k) => expect(v).toBeCloseTo(atGrasp[k], 6))
  })

  it('搬送中は荷物が手先と一体で動く（瞬間移動しない）', () => {
    const move = tl.segments.find((s) => s.primitive.kind === 'move' && s.primitive.object_id === id)!
    for (const u of [0.1, 0.4, 0.7, 0.95]) {
      const s = sampleTimeline(tl, move.start + (move.end - move.start) * u)
      const h = tl.items[id].dims[2]
      expect(s.items[id].pos[0]).toBeCloseTo(s.gripper[0], 6)
      expect(s.items[id].pos[1]).toBeCloseTo(s.gripper[1] - h / 2, 6)
      expect(s.items[id].pos[2]).toBeCloseTo(s.gripper[2], 6)
    }
  })

  it('置いてから把持を解除し、その後は荷物が配置位置から動かない', () => {
    const place = tl.segments.find((s) => s.primitive.kind === 'place' && s.primitive.object_id === id)!
    const rel = tl.phases.find((p) => p.start >= place.start && p.phase === 'release')!
    const placed = job.items.find((i) => i.object_id === id)!.placement!.position as [number, number, number]
    const atRelease = sampleTimeline(tl, rel.start)
    atRelease.items[id].pos.forEach((v, k) => expect(v).toBeCloseTo(placed[k], 6))
    expect(sampleTimeline(tl, rel.end).grip).toBeLessThan(0.01)
    sampleTimeline(tl, place.end).items[id].pos.forEach((v, k) => expect(v).toBeCloseTo(placed[k], 6))
  })

  it('能力の確認（check）では持ち上げない', () => {
    const fake = { ...trace, primitives: [trace.primitives[0], { seq: 1, object_id: trace.primitives[0].object_id, kind: 'check', reason: 'テスト' }, { seq: 2, object_id: trace.primitives[0].object_id, kind: 'handoff' }] } as JobTrace
    const t2 = buildTimeline(fake)
    const oid = trace.primitives[0].object_id
    const start = sampleTimeline(t2, 0).items[oid].pos
    for (let x = 0; x <= t2.duration; x += 0.1) {
      expect(sampleTimeline(t2, x).grip).toBe(0)
      sampleTimeline(t2, x).items[oid].pos.forEach((v, k) => expect(v).toBeCloseTo(start[k], 6))
    }
  })
})

describe('solveArm', () => {
  it('届く位置には手首が一致し、届かない位置は伸ばしきって止める', () => {
    const S: [number, number, number] = [0, 1, 0]
    const ok = solveArm(S, [0.5, 0.6, -0.6], 0.65, 0.65)
    expect(ok.reached).toBe(true)
    ok.wrist.forEach((v, k) => expect(v).toBeCloseTo([0.5, 0.6, -0.6][k], 5))
    const far = solveArm(S, [3, 1, 0], 0.65, 0.65)
    expect(far.reached).toBe(false)
    expect(Math.hypot(far.wrist[0] - S[0], far.wrist[1] - S[1], far.wrist[2] - S[2])).toBeLessThanOrEqual(1.3)
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
