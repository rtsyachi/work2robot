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

/** 機体の動き方：mobile＝台車ごと移動、walk＝二足歩行で移動（ヒューマノイド）、fixed＝台座は固定でコンベヤから受け取る、concept＝動作を表現しない */
export type Mode = 'mobile' | 'walk' | 'fixed' | 'concept'

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
  /** 二足歩行（walk）だけ：体の位置 x・向き yaw・歩数の進み s（移動距離＋旋回量。足の運びに使う）。体の z は railZ */
  body?: Key<BodyPose>[]
}
export type BodyPose = { x: number; yaw: number; s: number }

export type Sample = {
  gripper: Vec3
  grip: number
  phase: Phase
  items: Record<string, { pos: Vec3; rotY: number; state: 'waiting' | 'active' | 'placed' | 'handed_off' }>
  current: Segment | null
  body?: BodyPose
}

const ease = (u: number) => u * u * (3 - 2 * u)
const lerp3 = (a: Vec3, b: Vec3, u: number): Vec3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]

function sample<T>(keys: Key<T>[], t: number, mix: (a: T, b: T, u: number) => T, linear = false): T {
  if (t <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i]
    if (t <= t1) {
      const [t0, v0] = keys[i - 1]
      return t1 === t0 ? v1 : mix(v0, v1, linear ? (t - t0) / (t1 - t0) : ease((t - t0) / (t1 - t0)))
    }
  }
  return keys[keys.length - 1][1]
}

export function modeOf(job: JobTrace): Mode {
  const r = job.robot
  if (r?.product?.execution === 'concept') return 'concept'
  if (r?.base === 'legged_humanoid') return 'walk'
  return r?.base === 'fixed_pedestal' ? 'fixed' : 'mobile'
}

export function buildTimeline(job: JobTrace): Timeline {
  const mode = modeOf(job)
  if (mode === 'walk') return buildWalkTimeline(job)
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
  const lin = tl.mode === 'walk'   // 二足歩行は細かいキーを直線で補間
  const current = tl.segments.find((s) => t >= s.start && t < s.end) ?? null
  const items: Sample['items'] = {}
  for (const [id, it] of Object.entries(tl.items)) {
    const segs = tl.segments.filter((s) => s.primitive.object_id === id)
    const finished = segs.find((s) => (s.primitive.kind === 'place' || s.primitive.kind === 'handoff') && t >= s.end)
    const started = segs.some((s) => t >= s.start)
    items[id] = {
      pos: sample(it.pos, t, lerp3, lin),
      rotY: sample(it.rot, t, (a, b, u) => a + (b - a) * u, lin),
      state: finished ? (finished.primitive.kind === 'place' ? 'placed' : 'handed_off') : started ? 'active' : 'waiting',
    }
  }
  const ph = tl.phases.find((p) => t >= p.start && t < p.end)?.phase ?? 'idle'
  const body = tl.body ? sample(tl.body, t, mixPose, lin) : undefined
  return { gripper: sample(tl.gripper, t, lerp3, lin), grip: sample(tl.grip, t, (a, b, u) => a + (b - a) * u, lin), phase: ph, items, current, body }
}

// ---------------- 二足歩行（ヒューマノイド）の時間軸 ----------------
// 体の位置・向き・歩数をキーフレームで持つ（描画のたびに向きを寄せない＝一時停止や再生位置の移動でもずれない）。
// 歩く：歩き出しと止まり際に、歩きながら進行方向・作業方向へ向き直る（90度）。真後ろ（180度）はその場で足を踏み替えて向き直る。
// 荷物を持っている間は、荷物を体の前（両手の間）に保つ。箱を回して置くときは、カゴ車の前で腕と上体で回す（体の向きとは別）。
export const STEP_L = 0.4          // 歩数 s の1歩分（移動距離＋旋回量。足の着地点の間隔）
const WALK_SPEED = 1.5             // m/s（道のりの平均。加減速はキーを作るときに1回）
const TURN_45 = 0.26               // その場の踏み替えで45度回る時間（秒。180度で約1.2秒）
const TURN_W = 0.25                // 旋回量を歩数に換算する係数（1ラジアン＝0.25）
const READY = { fwd: 0.3, y: 0.82 }  // 空手のときの手の位置（体の前）
const CARRY = { fwd: 0.42, y: 0.74 } // 荷物を持つときの荷物の中心（体の前・腰の高さ）

const wrap = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }
function mixPose(a: BodyPose, b: BodyPose, u: number): BodyPose {
  return { x: a.x + (b.x - a.x) * u, yaw: a.yaw + wrap(b.yaw - a.yaw) * u, s: a.s + (b.s - a.s) * u }
}

/** 歩数 s のときの体の位置と向き（キーは s について単調。同じ区間の中では x・向き・s が同じ割合で進む） */
export function bodyAtS(tl: Timeline, s: number): BodyPose {
  const ks = tl.body ?? []
  if (!ks.length) return { x: 0, yaw: Math.PI, s }
  if (s <= ks[0][1].s) return ks[0][1]
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1][1], b = ks[i][1]
    if (s <= b.s && b.s > a.s) return mixPose(a, b, (s - a.s) / (b.s - a.s))
  }
  return ks[ks.length - 1][1]
}

/** 足（0＝左・1＝右）の位置。歩数 k の間は片足が振り出し、もう一方は着地点に固定（床を滑らない） */
export function footAt(tl: Timeline, s: number, foot: 0 | 1): { pos: Vec3; yaw: number } {
  const land = (sl: number) => {
    const b = bodyAtS(tl, Math.max(0, sl))
    const side = foot === 0 ? -0.11 : 0.11
    return { pos: [b.x + Math.cos(b.yaw) * side + Math.sin(b.yaw) * 0.08, 0, tl.railZ - Math.sin(b.yaw) * side + Math.cos(b.yaw) * 0.08] as Vec3, yaw: b.yaw }
  }
  const k = Math.floor(s / STEP_L + 1e-9)
  const p = s / STEP_L - k
  if (k % 2 !== foot) {
    // この足は着地中：最後に着地した位置（歩数 k の始まり）に固定
    return land(k * STEP_L)
  }
  // この足が振り出し中：前の着地点（k-1 歩目の始まり）から次の着地点（k+1 歩目の始まり）へ
  const a = land((k - 1) * STEP_L), b = land((k + 1) * STEP_L)
  const u = ease(p)
  return { pos: [a.pos[0] + (b.pos[0] - a.pos[0]) * u, Math.sin(Math.PI * p) * 0.07, a.pos[2] + (b.pos[2] - a.pos[2]) * u], yaw: a.yaw + wrap(b.yaw - a.yaw) * u }
}

function buildWalkTimeline(job: JobTrace): Timeline {
  const railZ = job.robot ? job.cart.depth_m / 2 + job.robot.standoff_m : RAIL_Z
  const shoulderY = job.robot ? job.robot.shoulder_height_m : SHOULDER_Y
  const cartFrontZ = job.cart.depth_m / 2 + 0.14
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
  // 体の前の点（体の位置 x・向き yaw から、前へ fwd・高さ y）
  const rel = (x: number, yaw: number, fwd: number, y: number): Vec3 => [x + Math.sin(yaw) * fwd, y, railZ + Math.cos(yaw) * fwd]
  let body: BodyPose = { x: -0.6, yaw: Math.PI, s: 0 }
  const handsAt = (b: { x: number; yaw: number }, carry: string | null): Vec3 =>
    carry ? rel(b.x, b.yaw, CARRY.fwd, CARRY.y + items[carry].dims[2] / 2) : rel(b.x, b.yaw, READY.fwd, READY.y)
  let g: Vec3 = handsAt(body, null)
  let holding = 0
  let t = 0
  const gripper: Key<Vec3>[] = [[0, g]]
  const grip: Key<number>[] = [[0, 0]]
  const bodyKeys: Key<BodyPose>[] = [[0, body]]
  const phases: Timeline['phases'] = []
  const segments: Segment[] = []
  type Pose = { tip: Vec3; x: number; yaw: number }
  type Opt = { carry?: string | null; rotTo?: number; phase: Phase; grip?: number; sTo?: number }
  /** 1つの動き：u（0→1、加減速は1回だけ）に対する手先・体の位置と向きを細かいキーにする（キーの間は直線で補間） */
  const motion = (dt: number, f: (u: number) => Pose, o: Opt) => {
    const t0 = t
    const n = Math.max(2, Math.ceil(dt / 0.04))
    const g0 = holding, g1 = o.grip ?? holding
    const s0 = body.s
    const carry = o.carry ?? null
    const r0 = carry ? rot[carry] : 0, r1 = carry ? (o.rotTo ?? r0) : 0
    if (carry) { items[carry].pos.push([t0, center[carry]]); items[carry].rot.push([t0, r0]) }
    let prev = body
    for (let i = 1; i <= n; i++) {
      const e = ease(i / n)
      const ti = t0 + dt * (i / n)
      const ps = f(e)
      const s = o.sTo != null ? s0 + (o.sTo - s0) * e : prev.s + Math.abs(ps.x - prev.x) + Math.abs(wrap(ps.yaw - prev.yaw)) * TURN_W
      prev = { x: ps.x, yaw: ps.yaw, s }
      gripper.push([ti, ps.tip])
      grip.push([ti, g0 + (g1 - g0) * e])
      bodyKeys.push([ti, prev])
      if (carry) {
        const h = items[carry].dims[2]
        const c: Vec3 = [ps.tip[0], ps.tip[1] - h / 2, ps.tip[2]]
        items[carry].pos.push([ti, c]); center[carry] = c
        const r = r0 + (r1 - r0) * e
        items[carry].rot.push([ti, r]); rot[carry] = r
      }
    }
    phases.push({ start: t0, end: t0 + dt, phase: o.phase })
    t = t0 + dt
    g = gripper[gripper.length - 1][1]
    holding = g1
    body = prev
  }
  /** 手先だけを動かす（体は止まったまま） */
  const go = (dt: number, to: Vec3, o: Opt) => {
    const from = g, b = body
    motion(dt, (u) => ({ tip: [from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u, from[2] + (to[2] - from[2]) * u], x: b.x, yaw: b.yaw }), o)
  }
  /** 止まるときは歩数の区切りまで踏み切る（足を宙に残さない） */
  const settle = (carry: string | null, phase: Phase) => {
    const target = Math.ceil(body.s / STEP_L - 1e-6) * STEP_L
    if (target - body.s < 1e-6) return
    const b = body, tip = g
    motion(0.08 + 0.3 * (target - body.s) / STEP_L, () => ({ tip, x: b.x, yaw: b.yaw }), { carry, phase, sTo: target })
  }
  /** その場で足を踏み替えて向き直る（真後ろへ戻るときなど） */
  const turnTo = (yaw: number, carry: string | null, phase: Phase) => {
    const d = wrap(yaw - body.yaw)
    if (Math.abs(d) < 0.02) return
    const b = body, from = g, to = handsAt({ x: b.x, yaw: b.yaw + d }, carry)
    motion(TURN_45 * Math.abs(d) / (Math.PI / 4) + 0.15, (u) => {
      const y = b.yaw + d * u
      return { tip: carry ? handsAt({ x: b.x, yaw: y }, carry) : [from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u, from[2] + (to[2] - from[2]) * u], x: b.x, yaw: y }
    }, { carry, phase })
    settle(carry, phase)
  }
  /** 体を x へ動かし、最後に face を向く。歩き出し・止まり際は歩きながら曲がる（1回の加減速）。真後ろへはその場で踏み替える */
  const walkTo = (x: number, face: number, carry: string | null, phase: Phase) => {
    const dx = x - body.x
    if (Math.abs(dx) < 0.35) {
      turnTo(face, carry, phase)
      if (Math.abs(dx) > 0.01) {
        const b = body
        motion(0.35 + Math.abs(dx) / 0.5, (u) => { const xx = b.x + dx * u; return { tip: handsAt({ x: xx, yaw: b.yaw }, carry), x: xx, yaw: b.yaw } }, { carry, phase })   // 横へ数歩
      }
      settle(carry, phase)
      return
    }
    const dir = dx < 0 ? -Math.PI / 2 : Math.PI / 2   // 進行方向（-x 向き＝-90度）
    if (Math.abs(wrap(dir - body.yaw)) > Math.PI * 0.75) turnTo(dir, carry, phase)   // 真後ろへ戻る：先に踏み替えて向き直る
    const b = body, sign = Math.sign(dx)
    const lead = Math.min(0.35, Math.abs(dx) * 0.3)
    const d0 = wrap(dir - b.yaw), d1 = wrap(face - dir)
    // 道のり（移動距離＋旋回量）に沿って、歩き出しの曲がり → 直進 → 止まり際の曲がり
    const LA = lead + Math.abs(d0) * 0.35, LB = Math.abs(dx) - 2 * lead, LC = lead + Math.abs(d1) * 0.35
    const L = LA + LB + LC
    const at = (u: number) => {
      const q = u * L
      if (q <= LA) { const k = q / LA; return { x: b.x + sign * lead * k, yaw: b.yaw + d0 * k } }
      if (q <= LA + LB) { const k = (q - LA) / Math.max(LB, 1e-6); return { x: b.x + sign * (lead + LB * k), yaw: dir } }
      const k = (q - LA - LB) / LC
      return { x: b.x + sign * (lead + LB + lead * k), yaw: dir + d1 * k }
    }
    const from = g
    // 曲がる角度の分だけ時間を確保する（90度あたり約0.8秒。短い距離で2回曲がるときに速く回りすぎない）
    motion(Math.max(0.25 + L / WALK_SPEED, (Math.abs(d0) + Math.abs(d1)) / (Math.PI / 2) * 0.8), (u) => {
      const p = at(u)
      // 空手のときは歩き出しの間に手を体の前の位置へ寄せる（荷物を持っているときは常に体の前）
      const hand = handsAt(p, carry)
      const k = carry ? 1 : Math.min(1, u * 4)
      return { tip: [from[0] + (hand[0] - from[0]) * k, from[1] + (hand[1] - from[1]) * k, from[2] + (hand[2] - from[2]) * k], x: p.x, yaw: p.yaw }
    }, { carry, phase })
    settle(carry, phase)
  }
  const top = (id: string): Vec3 => { const c = center[id]; return [c[0], c[1] + items[id].dims[2] / 2, c[2]] }
  const faceZ = (z: number) => (z > railZ ? 0 : Math.PI)   // 奥（+z）を向く＝0、カゴ車側（-z）＝π

  for (const p of job.primitives) {
    const start = t
    const id = p.object_id
    const h = items[id]?.dims[2] ?? 0.3
    if (p.kind === 'recognize') {
      const tp = top(id)
      walkTo(tp[0], faceZ(tp[2]), null, 'approach')
      go(DURATION.recognize, handsAt(body, null), { phase: 'recognize' })
    } else if (p.kind === 'check') {
      const tp = top(id)
      go(DURATION.check * 0.45, [tp[0], tp[1] + 0.08, tp[2]], { phase: 'check' })
      go(DURATION.check * 0.2, [tp[0], tp[1] + 0.08, tp[2]], { phase: 'check' })
      go(DURATION.check * 0.35, handsAt(body, null), { phase: 'check' })
    } else if (p.kind === 'pick') {
      const tp = top(id)
      go(DURATION.pick * 0.35, [tp[0], tp[1] + 0.06, tp[2]], { phase: 'approach' })
      go(DURATION.pick * 0.2, tp, { phase: 'grasp' })
      go(DURATION.pick * 0.15, tp, { phase: 'grasp', grip: 1 })
      go(DURATION.pick * 0.2, [tp[0], tp[1] + 0.15, tp[2]], { carry: id, phase: 'lift' })
      go(DURATION.pick * 0.3, handsAt(body, id), { carry: id, phase: 'lift' })   // 体の前へ抱え込む
    } else if (p.kind === 'move' && p.to) {
      const target: Vec3 = p.to
      walkTo(target[0], Math.PI, id, 'transfer')   // 抱えたままカゴ車の前へ（体の向きと荷物の向きは別）
      const yT = Math.max(target[1], g[1])
      const front: Vec3 = [target[0], yT, Math.max(cartFrontZ, target[2])]
      const rotTo = p.rotated ? Math.PI / 2 : 0
      go(DURATION.move * 0.4, front, { carry: id, rotTo, phase: 'transfer' })   // 開口の前で、腕と上体で箱を回す
      go(DURATION.move * 0.3, [target[0], yT, target[2]], { carry: id, phase: 'transfer' })
      if (yT > target[1] + 1e-3) go(0.3, target, { carry: id, phase: 'transfer' })
    } else if (p.kind === 'place' && p.position) {
      const k = p.press_mode === 'no_press' ? GENTLE : 1
      const tip: Vec3 = [p.position[0], p.position[1] + h / 2, p.position[2]]
      go(DURATION.place * 0.45 * k, [tip[0], tip[1] + 0.04, tip[2]], { carry: id, phase: 'lower' })
      go(DURATION.place * 0.2 * k, tip, { carry: id, phase: 'lower' })
      go(DURATION.place * 0.15, tip, { phase: 'release', grip: 0 })
      go(DURATION.place * 0.2, [tip[0], tip[1] + 0.12, tip[2]], { phase: 'retreat' })
      go(0.4, [tip[0], tip[1] + 0.12, Math.max(cartFrontZ, tip[2])], { phase: 'retreat' })
    } else if (p.kind === 'handoff') {
      go(DURATION.handoff, handsAt(body, null), { phase: 'handoff' })
    }
    segments.push({ start, end: t, primitive: p })
  }
  go(0.8, handsAt(body, null), { phase: 'idle' })
  return { duration: t, mode: 'walk', railZ, shoulderY, base: [0, 0, railZ], conveyor: null, cartFrontZ, segments, phases, gripper, grip, items, body: bodyKeys }
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
export function solveArm(S: Vec3, W: Vec3, l1: number, l2: number, elbowDown = false): { elbow: Vec3; wrist: Vec3; yaw: number; reached: boolean } {
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
  // 産業用アームは肘を上側（a + b）、人の腕（ヒューマノイド）は肘を下・後ろ側（a - b）に曲げる
  const ang = elbowDown ? a - b : a + b
  const elbowP: Vec3 = [S[0] + ux * l1 * Math.cos(ang), S[1] + l1 * Math.sin(ang), S[2] + uz * l1 * Math.cos(ang)]
  const wrist: Vec3 = [S[0] + ux * r * Math.cos(a), S[1] + r * Math.sin(a), S[2] + uz * r * Math.cos(a)]
  return { elbow: elbowP, wrist, yaw: Math.atan2(ux, uz), reached: want <= l1 + l2 - 1e-3 + 1e-6 }
}
