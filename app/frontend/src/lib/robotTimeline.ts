// 業務実行トレースの基本動作（primitives）→ 3Dの動き。判断はせず、トレースを時間軸に並べるだけ。
// 基本動作1つ（Pick・Move・Place など）を、接近・把持・持ち上げ・搬送・減速して下ろす・解放・退避の段階に分けて描く。
// 区間（segments）は基本動作と1対1で、実行トレースとの対応は崩さない。
import type { JobTrace, Primitive, Vec3 } from '../types'

export const RAIL_Z = 0.85        // ロボットの通り道（カゴ車の手前）
export const SHOULDER_Y = 1.15
export const HOVER = 0.3          // 荷物の上で待つ高さ
const DEFAULT_DIMS: Vec3 = [0.3, 0.3, 0.3]

export const DURATION: Record<Primitive['kind'], number> = {
  recognize: 0.8,
  check: 1.6,   // 能力が足りない荷物：近づいて止まり、持ち上げない
  pick: 1.6,
  move: 1.8,
  place: 1.4,
  handoff: 1.0,
}
const GENTLE = 1.6 // 押し込まない置き方は、下ろす区間をこの倍率でゆっくりにする

/** 動きの段階（画面の「実行中の動作」に出す） */
export type Phase = 'idle' | 'infeed' | 'recognize' | 'approach' | 'grasp' | 'lift' | 'transfer' | 'lower' | 'release' | 'retreat' | 'check' | 'handoff'
export const PHASE_LABEL: Record<Phase, string> = {
  idle: '待機', infeed: 'コンベヤで荷物を手元へ', recognize: '荷物を認識', approach: '荷物へ接近', grasp: '接触・把持',
  lift: '持ち上げる', transfer: 'カゴ車へ搬送', lower: '減速して下ろす', release: '把持を解除', retreat: '退避',
  check: '近づいて確認（持ち上げない）', handoff: '人へ引継ぎ',
}

/** 機体の動き方：mobile＝台車ごと移動、fixed＝台座は固定でコンベヤから受け取る、concept＝動作を表現しない */
export type Mode = 'mobile' | 'fixed' | 'concept'

export type Segment = { start: number; end: number; primitive: Primitive }
type Key<T> = [number, T]

export type Timeline = {
  duration: number
  mode: Mode
  railZ: number        // 移動式の台車が通る線（カゴ車の手前）
  shoulderY: number    // アームの肩の高さ
  base: Vec3           // 固定式の台座の位置
  conveyor: { x0: number; x1: number; z: number; top: number } | null
  cartFrontZ: number
  segments: Segment[]
  phases: { start: number; end: number; phase: Phase }[]
  gripper: Key<Vec3>[] // 手先の先端（荷物の上面に触れる点）
  grip: Key<number>[]  // 1＝荷物を保持中
  items: Record<string, { dims: Vec3; pos: Key<Vec3>[]; rot: Key<number>[] }>
}

export type Sample = {
  gripper: Vec3
  grip: number
  phase: Phase
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

export function modeOf(job: JobTrace): Mode {
  const r = job.robot
  if (r?.product?.execution === 'concept') return 'concept'
  return r?.base === 'fixed_pedestal' ? 'fixed' : 'mobile'
}

export function buildTimeline(job: JobTrace): Timeline {
  const mode = modeOf(job)
  // 構成があれば、その肩の高さと立ち位置（カゴ車の開口からの距離）で描く
  const railZ = job.robot ? job.cart.depth_m / 2 + job.robot.standoff_m : RAIL_Z
  const shoulderY = job.robot ? job.robot.shoulder_height_m : SHOULDER_Y
  const cartFrontZ = job.cart.depth_m / 2 + 0.14
  const base: Vec3 = [-job.cart.width_m / 2 - 0.05, 0, railZ + 0.15]
  // 固定式：コンベヤ（周辺設備にある場合）が仮置き場から台座の脇まで荷物を運ぶ
  const conveyor = mode === 'fixed' && job.robot?.peripherals.includes('infeed_conveyor')
    ? { x0: -3.6, x1: base[0] - 0.65, z: base[2], top: 0.72 } : null
  const REST: Vec3 = mode === 'fixed' ? [base[0] - 0.2, shoulderY + 0.2, base[2] - 0.3] : [-0.6, 0.95, railZ - 0.25]

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
  const grip: Key<number>[] = [[0, 0]]
  const phases: Timeline['phases'] = []
  const segments: Segment[] = []
  let g: Vec3 = REST
  let holding = 0
  let t = 0
  type Opt = { carry?: string; rotTo?: number; phase: Phase; grip?: number }
  const go = (dt: number, to: Vec3, o: Opt) => {
    const t0 = t
    t += dt
    gripper.push([t0, g], [t, to])
    g = to
    const gv = o.grip ?? holding
    grip.push([t0, holding], [t, gv])
    holding = gv
    phases.push({ start: t0, end: t, phase: o.phase })
    if (o.carry) {
      const h = items[o.carry].dims[2]
      const c: Vec3 = [to[0], to[1] - h / 2, to[2]]
      items[o.carry].pos.push([t0, center[o.carry]], [t, c])
      center[o.carry] = c
      const r = o.rotTo ?? rot[o.carry]
      items[o.carry].rot.push([t0, rot[o.carry]], [t, r])
      rot[o.carry] = r
    }
  }
  /** 荷物だけを動かす（コンベヤでの搬入・引継ぎ場所への移動）。手先は止まったまま。 */
  const slide = (id: string, path: Vec3[], dt: number, phase: Phase) => {
    const step = dt / path.length
    for (const to of path) {
      const t0 = t
      t += step
      items[id].pos.push([t0, center[id]], [t, to])
      center[id] = to
      gripper.push([t0, g], [t, g])
      grip.push([t0, holding], [t, holding])
      phases.push({ start: t0, end: t, phase })
    }
  }
  const top = (id: string): Vec3 => {
    const c = center[id]
    return [c[0], c[1] + items[id].dims[2] / 2, c[2]]
  }
  const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

  for (const p of job.primitives) {
    const start = t
    const id = p.object_id
    const h = items[id]?.dims[2] ?? 0.3
    if (p.kind === 'recognize') {
      if (conveyor) {
        // 固定式：荷物をコンベヤに載せ、台座の脇（受け取り位置）まで送る
        const y = conveyor.top + h / 2
        slide(id, [[conveyor.x0, y, conveyor.z], [conveyor.x1, y, conveyor.z]], DURATION.recognize + 0.8, 'infeed')
      }
      const tp = top(id)
      go(DURATION.recognize, [tp[0], tp[1] + HOVER, tp[2]], { phase: 'recognize' })
    } else if (p.kind === 'check') {
      const tp = top(id)
      go(DURATION.check * 0.45, [tp[0], tp[1] + 0.08, tp[2]], { phase: 'check' })   // 近づく
      go(DURATION.check * 0.2, [tp[0], tp[1] + 0.08, tp[2]], { phase: 'check' })    // 止まって確認
      go(DURATION.check * 0.35, [tp[0], tp[1] + HOVER, tp[2]], { phase: 'check' })  // つかまずに離れる
    } else if (p.kind === 'pick') {
      const tp = top(id)
      go(DURATION.pick * 0.35, [tp[0], tp[1] + 0.06, tp[2]], { phase: 'approach' })
      go(DURATION.pick * 0.2, tp, { phase: 'grasp' })
      go(DURATION.pick * 0.15, tp, { phase: 'grasp', grip: 1 })
      go(DURATION.pick * 0.3, [tp[0], tp[1] + HOVER, tp[2]], { carry: id, phase: 'lift' })
    } else if (p.kind === 'move' && p.to) {
      // カゴ車の前面（開口）から入れる：搬送の高さまで上げ → 開口の前へ → 奥へ差し入れ
      const target: Vec3 = p.to
      const yT = Math.max(target[1], g[1])
      const front: Vec3 = [target[0], yT, Math.max(cartFrontZ, target[2])]
      const rotTo = p.rotated ? Math.PI / 2 : 0
      if (yT > g[1] + 1e-3) go(0.35, [g[0], yT, g[2]], { carry: id, phase: 'transfer' })
      go(DURATION.move * 0.5 + dist(g, front) * 0.25, front, { carry: id, rotTo, phase: 'transfer' })
      go(DURATION.move * 0.3, [target[0], yT, target[2]], { carry: id, phase: 'transfer' })
      if (yT > target[1] + 1e-3) go(0.3, target, { carry: id, phase: 'transfer' })
    } else if (p.kind === 'place' && p.position) {
      const k = p.press_mode === 'no_press' ? GENTLE : 1
      const tip: Vec3 = [p.position[0], p.position[1] + h / 2, p.position[2]]
      go(DURATION.place * 0.45 * k, [tip[0], tip[1] + 0.04, tip[2]], { carry: id, phase: 'lower' })
      go(DURATION.place * 0.2 * k, tip, { carry: id, phase: 'lower' })   // 置く直前は減速
      go(DURATION.place * 0.15, tip, { phase: 'release', grip: 0 })
      go(DURATION.place * 0.2, [tip[0], tip[1] + 0.12, tip[2]], { phase: 'retreat' })
      go(0.4, [tip[0], tip[1] + 0.12, Math.max(cartFrontZ, tip[2])], { phase: 'retreat' })
    } else if (p.kind === 'handoff') {
      go(DURATION.handoff * 0.6, REST, { phase: 'handoff' })
      if (mode === 'fixed' && conveyor && items[id]) {
        // 受け取り位置から外して、人が引き取る場所へ（コンベヤの手前の床）
        slide(id, [[conveyor.x1 - 0.2, h / 2, conveyor.z + 0.75]], DURATION.handoff * 0.4, 'handoff')
      } else {
        go(DURATION.handoff * 0.4, REST, { phase: 'handoff' })
      }
    }
    segments.push({ start, end: t, primitive: p })
  }
  go(0.8, REST, { phase: 'idle' })
  return { duration: t, mode, railZ, shoulderY, base, conveyor, cartFrontZ, segments, phases, gripper, grip, items }
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
  const ph = tl.phases.find((p) => t >= p.start && t < p.end)?.phase ?? 'idle'
  return { gripper: sample(tl.gripper, t, lerp3), grip: sample(tl.grip, t, (a, b, u) => a + (b - a) * u), phase: ph, items, current }
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

/**
 * 肩から手首へ、旋回（ヨー）＋縦の2リンクで解く。届かない位置は腕を伸ばしきった所で止める（届いたように描かない）。
 * 戻り値の wrist は実際に届いた手首の位置、reached は目標に届いたか。
 */
export function solveArm(S: Vec3, W: Vec3, l1: number, l2: number): { elbow: Vec3; wrist: Vec3; yaw: number; reached: boolean } {
  let hx = W[0] - S[0]
  let hz = W[2] - S[2]
  let d = Math.hypot(hx, hz)
  if (d < 1e-6) { hx = 0; hz = -1; d = 1e-6 }
  const ux = hx / d
  const uz = hz / d
  const dy = W[1] - S[1]
  const want = Math.hypot(d, dy)
  const r = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(want, l1 + l2 - 1e-3))
  const a = Math.atan2(dy, d)
  const b = Math.acos(Math.min(1, Math.max(-1, (l1 * l1 + r * r - l2 * l2) / (2 * l1 * r))))
  const ang = a + b
  const elbowP: Vec3 = [S[0] + ux * l1 * Math.cos(ang), S[1] + l1 * Math.sin(ang), S[2] + uz * l1 * Math.cos(ang)]
  const wrist: Vec3 = [S[0] + ux * r * Math.cos(a), S[1] + r * Math.sin(a), S[2] + uz * r * Math.cos(a)]
  return { elbow: elbowP, wrist, yaw: Math.atan2(ux, uz), reached: want <= l1 + l2 - 1e-3 + 1e-6 }
}
