// 業務実行トレースの基本動作（primitives）→ 3Dの動き。判断はせず、トレースを時間軸に並べるだけ。
import type { JobTrace, Primitive, Vec3 } from '../types'

export const RAIL_Z = 0.85        // ロボットが走る直線レールの位置（カゴ車の手前）
export const SHOULDER_Y = 1.15
export const HOVER = 0.3          // 荷物の上で待つ高さ
const REST: Vec3 = [-0.5, 0.95, 0.6]
const DEFAULT_DIMS: Vec3 = [0.3, 0.3, 0.3]

export const DURATION: Record<Primitive['kind'], number> = {
  recognize: 0.8,
  pick: 1.2,
  move: 1.4,
  place: 1.0,
  handoff: 1.2,
}
const GENTLE_PLACE = 1.8 // 押し込まない置き方はゆっくり下ろす

export type Segment = { start: number; end: number; primitive: Primitive }
type Key<T> = [number, T]

export type Timeline = {
  duration: number
  segments: Segment[]
  gripper: Key<Vec3>[]
  items: Record<string, { dims: Vec3; pos: Key<Vec3>[]; rot: Key<number>[] }>
}

export type Sample = {
  gripper: Vec3
  items: Record<string, { pos: Vec3; rotY: number; state: 'waiting' | 'active' | 'placed' | 'handed_off' }>
  current: Segment | null
}

const ease = (u: number) => u * u * (3 - 2 * u)
const lerp3 = (a: Vec3, b: Vec3, u: number): Vec3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]

function sample<T>(keys: Key<T>[], t: number, mix: (a: T, b: T, u: number) => T): T {
  if (t <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i]
    if (t <= t1) {
      const [t0, v0] = keys[i - 1]
      return t1 === t0 ? v1 : mix(v0, v1, ease((t - t0) / (t1 - t0)))
    }
  }
  return keys[keys.length - 1][1]
}

export function buildTimeline(job: JobTrace): Timeline {
  const dims: Record<string, Vec3> = {}
  job.items.forEach((it) => (dims[it.object_id] = it.dims ?? DEFAULT_DIMS))
  const items: Timeline['items'] = {}
  const center: Record<string, Vec3> = {}
  const rot: Record<string, number> = {}
  for (const p of job.primitives) {
    if (p.kind === 'recognize' && p.at && !(p.object_id in items)) {
      const d = dims[p.object_id]
      center[p.object_id] = [p.at[0], d[2] / 2, p.at[2]]
      rot[p.object_id] = 0
      items[p.object_id] = { dims: d, pos: [[0, center[p.object_id]]], rot: [[0, 0]] }
    }
  }

  const gripper: Key<Vec3>[] = [[0, REST]]
  const segments: Segment[] = []
  let g: Vec3 = REST
  let t = 0
  const go = (dt: number, to: Vec3, carry?: string, rotTo?: number) => {
    const t0 = t
    t += dt
    gripper.push([t0, g], [t, to])
    g = to
    if (carry) {
      const h = items[carry].dims[2]
      const c: Vec3 = [to[0], to[1] - h / 2, to[2]]
      items[carry].pos.push([t0, center[carry]], [t, c])
      center[carry] = c
      const r = rotTo ?? rot[carry]
      items[carry].rot.push([t0, rot[carry]], [t, r])
      rot[carry] = r
    }
  }
  const top = (id: string): Vec3 => {
    const c = center[id]
    return [c[0], c[1] + items[id].dims[2] / 2, c[2]]
  }

  for (const p of job.primitives) {
    const start = t
    const id = p.object_id
    if (p.kind === 'recognize') {
      const tp = top(id)
      go(DURATION.recognize, [tp[0], tp[1] + HOVER, tp[2]])
    } else if (p.kind === 'pick') {
      const tp = top(id)
      go(DURATION.pick / 2, tp)
      go(DURATION.pick / 2, [tp[0], tp[1] + HOVER, tp[2]], id)
    } else if (p.kind === 'move' && p.to) {
      go(DURATION.move, [p.to[0], p.to[1] + items[id].dims[2], p.to[2]], id, p.rotated ? Math.PI / 2 : 0)
    } else if (p.kind === 'place' && p.position) {
      const h = items[id].dims[2]
      const dur = p.press_mode === 'no_press' ? GENTLE_PLACE : DURATION.place
      const grip: Vec3 = [p.position[0], p.position[1] + h / 2, p.position[2]]
      go(dur * 0.7, grip, id)
      go(dur * 0.3, [grip[0], grip[1] + HOVER, grip[2]])
    } else if (p.kind === 'handoff') {
      go(DURATION.handoff, REST)
    }
    segments.push({ start, end: t, primitive: p })
  }
  go(0.8, REST)
  return { duration: t, segments, gripper, items }
}

export function sampleTimeline(tl: Timeline, t: number): Sample {
  const current = tl.segments.find((s) => t >= s.start && t < s.end) ?? null
  const items: Sample['items'] = {}
  for (const [id, it] of Object.entries(tl.items)) {
    const segs = tl.segments.filter((s) => s.primitive.object_id === id)
    const finished = segs.find((s) => (s.primitive.kind === 'place' || s.primitive.kind === 'handoff') && t >= s.end)
    const started = segs.some((s) => t >= s.start)
    items[id] = {
      pos: sample(it.pos, t, lerp3),
      rotY: sample(it.rot, t, (a, b, u) => a + (b - a) * u),
      state: finished ? (finished.primitive.kind === 'place' ? 'placed' : 'handed_off') : started ? 'active' : 'waiting',
    }
  }
  return { gripper: sample(tl.gripper, t, lerp3), items, current }
}

/** 2リンクのアームの肘の位置（レール上の肩から把持位置へ、y-z平面で解く）。 */
export function elbow(shoulder: Vec3, target: Vec3, l1 = 0.75, l2 = 0.75): Vec3 {
  const dy = target[1] - shoulder[1]
  const dz = target[2] - shoulder[2]
  const r = Math.min(Math.hypot(dy, dz), l1 + l2 - 1e-6)
  const a = Math.atan2(dy, dz)
  const b = Math.acos(Math.min(1, Math.max(-1, (l1 * l1 + r * r - l2 * l2) / (2 * l1 * r))))
  const ang = a + b // 肘を上側に曲げる
  return [target[0], shoulder[1] + l1 * Math.sin(ang), shoulder[2] + l1 * Math.cos(ang)]
}
