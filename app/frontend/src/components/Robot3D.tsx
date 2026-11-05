// 仮想ロボット実行の3D。Step 3 と同じ製品モデル（A社固定式・B社移動式・C社ヒューマノイド）を、実行トレースの時間軸で動かす。
// 物理シミュレーションではなく、業務ワークフローと選定構成に基づく作業プレビュー。
import { memo, useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, OrbitControls, RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import type { JobItem, JobTrace, RobotSummary, Vec3 } from '../types'
import { type Sample, type Timeline, solveArm } from '../lib/robotTimeline'
import { Beam, Box, Capsule, Cyl, DepthCam, Effector, ForceRing, Humanoid, Paint } from './ProductRender'

const UP = new THREE.Vector3(0, 1, 0)
const GROUND = -0.15 // カゴ車の床（y=0）の下の地面
const TOOL = 0.125   // 手首から手先の先端（荷物に触れる点）まで

export type CamMode = 'follow' | 'overview' | 'cart' | 'free'

// ---- 環境 ----
const Floor = memo(function Floor() {
  const lines = useMemo(() => {
    const out: [number, number, number, number][] = []
    for (let x = -8; x <= 3; x += 1) out.push([x, -2, x, 4])
    for (let z = -2; z <= 4; z += 1) out.push([-8, z, 3, z])
    return out
  }, [])
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-2.5, GROUND, 1]} receiveShadow>
        <planeGeometry args={[12, 7]} />
        <meshStandardMaterial color="#c9ced3" roughness={0.85} />
      </mesh>
      {lines.map(([x0, z0, x1, z1], i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[(x0 + x1) / 2, GROUND + 0.001, (z0 + z1) / 2]}>
          <planeGeometry args={[Math.max(Math.abs(x1 - x0), 0.008), Math.max(Math.abs(z1 - z0), 0.008)]} />
          <meshBasicMaterial color="#b8bec4" />
        </mesh>
      ))}
    </group>
  )
})

/** 安全区画の黄色い線（ロボットの作業範囲） */
function SafetyLines({ x0, x1, z0, z1 }: { x0: number; x1: number; z0: number; z1: number }) {
  const w = 0.05
  const seg: [number, number, number, number][] = [[(x0 + x1) / 2, z0, x1 - x0, w], [(x0 + x1) / 2, z1, x1 - x0, w], [x0, (z0 + z1) / 2, w, z1 - z0], [x1, (z0 + z1) / 2, w, z1 - z0]]
  return (
    <group>
      {seg.map(([x, z, sx, sz], i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[x, GROUND + 0.002, z]}>
          <planeGeometry args={[sx, sz]} />
          <meshBasicMaterial color="#f2c200" />
        </mesh>
      ))}
    </group>
  )
}

/** 木製パレット（上面が y=0） */
const Pallet = memo(function Pallet({ x, z, w, d }: { x: number; z: number; w: number; d: number }) {
  const WOOD = '#b08a5a'
  const slats = 6
  return (
    <group position={[x, 0, z]}>
      {Array.from({ length: slats }, (_, i) => (
        <mesh key={i} position={[0, -0.012, -d / 2 + (d / (slats - 1)) * i]} castShadow receiveShadow>
          <boxGeometry args={[w, 0.024, d / slats * 0.7]} />
          <meshStandardMaterial color={WOOD} roughness={0.9} />
        </mesh>
      ))}
      {[-1, 0, 1].map((k) => (
        <mesh key={k} position={[k * (w / 2 - 0.06), GROUND / 2 - 0.012, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.1, -GROUND - 0.024, d]} />
          <meshStandardMaterial color="#977347" roughness={0.9} />
        </mesh>
      ))}
    </group>
  )
})

/** カゴ車（ロールボックスパレット）：床・キャスター・角柱・3面の網。前面は開口。 */
const Cart = memo(function Cart({ w, d, h }: { w: number; d: number; h: number }) {
  const MET = '#aeb5bb'
  const top = h + 0.15
  const bars: { p: Vec3; s: Vec3 }[] = []
  for (let x = -w / 2 + 0.1; x < w / 2 - 0.05; x += 0.1) bars.push({ p: [x, top / 2, -d / 2], s: [0.008, top, 0.008] })
  for (let z = -d / 2 + 0.1; z < d / 2 - 0.05; z += 0.1) {
    bars.push({ p: [-w / 2, top / 2, z], s: [0.008, top, 0.008] })
    bars.push({ p: [w / 2, top / 2, z], s: [0.008, top, 0.008] })
  }
  for (const y of [0.3, 0.6, 0.9]) {
    bars.push({ p: [0, y, -d / 2], s: [w, 0.012, 0.012] })
    bars.push({ p: [-w / 2, y, 0], s: [0.012, 0.012, d] })
    bars.push({ p: [w / 2, y, 0], s: [0.012, 0.012, d] })
  }
  return (
    <group>
      <mesh position={[0, -0.03, 0]} castShadow receiveShadow>
        <boxGeometry args={[w + 0.04, 0.06, d + 0.04]} />
        <meshStandardMaterial color="#6c757d" metalness={0.6} roughness={0.45} />
      </mesh>
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
        <group key={i} position={[sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06)]}>
          <mesh position={[0, -0.075, 0]}><boxGeometry args={[0.05, 0.03, 0.05]} /><meshStandardMaterial color="#495057" metalness={0.6} /></mesh>
          <mesh position={[0, -0.11, 0]} rotation={[0, 0, Math.PI / 2]} castShadow><cylinderGeometry args={[0.04, 0.04, 0.03, 16]} /><meshStandardMaterial color="#212529" roughness={0.8} /></mesh>
        </group>
      ))}
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
        <mesh key={i} position={[sx * w / 2, top / 2, sz * d / 2]} castShadow>
          <boxGeometry args={[0.03, top, 0.03]} />
          <meshStandardMaterial color={MET} metalness={0.75} roughness={0.35} />
        </mesh>
      ))}
      {[[0, -d / 2, w, 0.03], [-w / 2, 0, 0.03, d], [w / 2, 0, 0.03, d]].map(([x, z, sx, sz], i) => (
        <mesh key={i} position={[x, top, z]} castShadow>
          <boxGeometry args={[sx, 0.03, sz]} />
          <meshStandardMaterial color={MET} metalness={0.75} roughness={0.35} />
        </mesh>
      ))}
      {bars.map((b, i) => (
        <mesh key={i} position={b.p}>
          <boxGeometry args={b.s} />
          <meshStandardMaterial color={MET} metalness={0.7} roughness={0.4} />
        </mesh>
      ))}
      {/* 積付高さの上限（これより上・外に出さない） */}
      {[[0, h, -d / 2, w, 0.014], [-w / 2, h, 0, 0.014, d], [w / 2, h, 0, 0.014, d], [0, h, d / 2, w, 0.014]].map(([x, y, z, sx, sz], i) => (
        <mesh key={i} position={[x, y, z]}>
          <boxGeometry args={[sx, 0.014, sz]} />
          <meshBasicMaterial color="#f2c200" transparent opacity={0.85} />
        </mesh>
      ))}
    </group>
  )
})

const Conveyor = memo(function Conveyor({ x0, x1, z, top }: { x0: number; x1: number; z: number; top: number }) {
  const len = x1 - x0
  const cx = (x0 + x1) / 2
  const legs = Math.max(2, Math.round(len / 0.9) + 1)
  return (
    <group>
      {Array.from({ length: legs }, (_, i) => x0 + 0.05 + (len - 0.1) * (i / (legs - 1))).map((x) => [-0.22, 0.22].map((dz) => (
        <mesh key={`${x}${dz}`} position={[x, (top + GROUND) / 2 - 0.04, z + dz]} castShadow>
          <boxGeometry args={[0.04, top - GROUND - 0.08, 0.04]} />
          <meshStandardMaterial color="#8a9096" metalness={0.7} roughness={0.35} />
        </mesh>
      )))}
      <mesh position={[cx, top - 0.04, z]} castShadow receiveShadow>
        <boxGeometry args={[len, 0.07, 0.5]} />
        <meshStandardMaterial color="#3d4349" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[cx, top - 0.003, z]} receiveShadow>
        <boxGeometry args={[len - 0.04, 0.008, 0.42]} />
        <meshStandardMaterial color="#1c1f23" roughness={0.85} />
      </mesh>
      {[-0.255, 0.255].map((dz) => (
        <mesh key={dz} position={[cx, top + 0.01, z + dz]}>
          <boxGeometry args={[len, 0.03, 0.012]} />
          <meshStandardMaterial color="#e8661c" metalness={0.3} roughness={0.45} />
        </mesh>
      ))}
    </group>
  )
})

/** 関節の円筒（軸の向きを指定） */
function Joint({ p, axis, r, h, c }: { p: Vec3; axis: Vec3; r: number; h: number; c: string }) {
  const q = useMemo(() => new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(...axis).normalize()), [axis[0], axis[1], axis[2]])
  return (
    <mesh position={p} quaternion={q} castShadow>
      <cylinderGeometry args={[r, r, h, 28]} />
      <Paint color={c} metal={0.45} rough={0.35} />
    </mesh>
  )
}

/** 保持状態のランプ（手首の上）：緑＝保持中、赤＝能力の確認（持ち上げない）、灰＝空 */
function Lamp({ p, state }: { p: Vec3; state: 'hold' | 'check' | 'idle' }) {
  const c = state === 'hold' ? '#2fb344' : state === 'check' ? '#e03131' : '#868e96'
  return (
    <mesh position={p}>
      <cylinderGeometry args={[0.062, 0.062, 0.018, 24]} />
      <meshStandardMaterial color={c} emissive={c} emissiveIntensity={state === 'idle' ? 0 : 0.9} />
    </mesh>
  )
}

type ArmProps = {
  robot: RobotSummary
  tip: Vec3            // 手先の先端の目標
  shoulderY: number
  lamp: 'hold' | 'check' | 'idle'
  spread?: number
}

/** B社：車輪移動式マニピュレータ（台車ごと通り道を走る） */
function MobileRobot({ robot, tip, shoulderY, lamp, spread, railZ }: ArmProps & { railZ: number }) {
  const WH = '#eef0f2', BK = '#1f2328', AC = '#12b886'
  const light = robot.arm === 'arm_light'
  const bx = tip[0]
  const S: Vec3 = [bx, shoulderY, railZ]
  const l = robot.reach_m / 2
  const arm = solveArm(S, [tip[0], tip[1] + TOOL, tip[2]], l, l)
  const n: Vec3 = [Math.cos(arm.yaw), 0, -Math.sin(arm.yaw)] // 腕の面に垂直な関節軸
  const k = light ? 0.82 : 1
  const mastH = Math.max(0.1, shoulderY - GROUND - 0.08 - 0.48) // 台車の上面から肩の関節の下まで
  return (
    <group>
      <group position={[bx, GROUND, railZ]}>
        <Box p={[0, 0.25, 0]} s={[0.92, 0.3, 0.5]} c={WH} m={0.15} r={0.35} rad={0.06} />
        <Box p={[0, 0.12, 0]} s={[0.95, 0.09, 0.53]} c={BK} m={0.2} r={0.6} rad={0.03} />
        <Box p={[0.475, 0.26, 0]} s={[0.01, 0.025, 0.38]} c={AC} m={0} r={0.3} rad={0.004} />
        <Box p={[0, 0.26, 0.255]} s={[0.6, 0.02, 0.01]} c={AC} m={0} r={0.3} rad={0.004} />
        <Box p={[0, 0.26, -0.255]} s={[0.6, 0.02, 0.01]} c={AC} m={0} r={0.3} rad={0.004} />
        {[[-0.32, 0.22], [0.32, 0.22], [-0.32, -0.22], [0.32, -0.22]].map(([x, z], i) => (
          <Cyl key={i} p={[x, 0.08, z]} r={0.08} h={0.06} c="#111" m={0.1} rough={0.9} rot={[Math.PI / 2, 0, 0]} />
        ))}
        <Cyl p={[0.36, 0.43, 0]} r={0.055} h={0.06} c={BK} m={0.3} rough={0.3} />
        <Cyl p={[0, 0.44, 0]} r={0.13} h={0.08} c={BK} m={0.3} rough={0.4} />
        <Box p={[0, 0.48 + mastH / 2, 0]} s={[0.17, mastH, 0.17]} c={WH} m={0.15} r={0.35} rad={0.04} />
        {robot.sensors.includes('depth_camera') && <DepthCam p={[0.1, shoulderY - GROUND - 0.15, 0]} rot={[0, Math.PI / 2, 0]} />}
      </group>
      <Joint p={S} axis={n} r={0.085} h={0.17} c={BK} />
      <Capsule a={S} b={arm.elbow} r={0.068 * k} c={WH} m={0.15} rough={0.35} />
      <Joint p={arm.elbow} axis={n} r={0.07} h={0.15} c={BK} />
      <Capsule a={arm.elbow} b={[arm.wrist[0], arm.wrist[1] + 0.06, arm.wrist[2]]} r={0.055 * k} c={WH} m={0.15} rough={0.35} />
      <Cyl p={[arm.wrist[0], arm.wrist[1] + 0.03, arm.wrist[2]]} r={0.055} h={0.08} c={BK} m={0.3} rough={0.4} />
      <Lamp p={[arm.wrist[0], arm.wrist[1] + 0.075, arm.wrist[2]]} state={lamp} />
      {robot.sensors.includes('wrist_force_sensor') && <ForceRing p={[arm.wrist[0], arm.wrist[1] - 0.005, arm.wrist[2]]} c={AC} />}
      <Effector id={robot.end_effector} at={arm.wrist} rot={[0, arm.yaw, 0]} spread={spread} />
    </group>
  )
}

/** A社：固定式ステーションアーム（台座は動かない） */
function FixedRobot({ robot, tip, shoulderY, lamp, spread, base }: ArmProps & { base: Vec3 }) {
  const OR = '#e8661c', GR = '#2b2f33', ST = '#8a9096'
  const S: Vec3 = [base[0], shoulderY, base[2]]
  const l = robot.reach_m / 2
  const arm = solveArm(S, [tip[0], tip[1] + TOOL, tip[2]], l, l)
  const n: Vec3 = [Math.cos(arm.yaw), 0, -Math.sin(arm.yaw)]
  const colH = shoulderY - GROUND - 0.3
  return (
    <group>
      <group position={[base[0], GROUND, base[2]]}>
        <Box p={[0, 0.02, 0]} s={[0.7, 0.04, 0.7]} c="#5c636a" m={0.6} r={0.4} rad={0.01} />
        {[[-0.28, -0.28], [0.28, -0.28], [-0.28, 0.28], [0.28, 0.28]].map(([x, z], i) => <Cyl key={i} p={[x, 0.05, z]} r={0.025} h={0.03} c={ST} m={0.8} rough={0.3} />)}
        <Box p={[0, 0.04 + colH / 2, 0]} s={[0.4, colH, 0.4]} c={GR} m={0.4} r={0.45} rad={0.02} />
        <Cyl p={[0, colH + 0.1, 0]} r={0.24} h={0.14} c={OR} m={0.35} rough={0.4} />
      </group>
      <group position={S} rotation={[0, arm.yaw, 0]}>
        <Box p={[0, -0.09, 0]} s={[0.34, 0.3, 0.36]} c={OR} m={0.35} r={0.4} rad={0.04} />
      </group>
      <Joint p={S} axis={n} r={0.14} h={0.44} c={GR} />
      <Beam a={S} b={arm.elbow} w={0.2} d={0.24} c={OR} m={0.35} r={0.4} />
      <Joint p={arm.elbow} axis={n} r={0.12} h={0.32} c={GR} />
      <Beam a={arm.elbow} b={[arm.wrist[0], arm.wrist[1] + 0.08, arm.wrist[2]]} w={0.15} d={0.17} c={OR} m={0.35} r={0.4} />
      <Cyl p={[arm.wrist[0], arm.wrist[1] + 0.04, arm.wrist[2]]} r={0.06} h={0.1} c={GR} m={0.5} rough={0.35} />
      <Lamp p={[arm.wrist[0], arm.wrist[1] + 0.095, arm.wrist[2]]} state={lamp} />
      {robot.sensors.includes('wrist_force_sensor') && <ForceRing p={[arm.wrist[0], arm.wrist[1] - 0.005, arm.wrist[2]]} />}
      <Effector id={robot.end_effector} at={arm.wrist} rot={[0, arm.yaw, 0]} spread={spread} />
      {robot.sensors.includes('depth_camera') && (
        // カゴ車の奥に立てた支柱から、上方の深度カメラでカゴ車の中を見る
        <group>
          <Cyl p={[0.85, (GROUND + 2.1) / 2, -0.7]} r={0.03} h={2.1 - GROUND} c={ST} m={0.8} rough={0.3} />
          <Beam a={[0.85, 2.08, -0.7]} b={[0.15, 2.08, -0.15]} w={0.04} d={0.04} c={ST} m={0.8} r={0.3} />
          <DepthCam p={[0.15, 2.02, -0.15]} rot={[-Math.PI / 2, 0, 0]} />
        </group>
      )}
    </group>
  )
}

// ---- 荷物 ----
function Item({ it, pos, rotY, color, soft, state, active, checking, tags }: {
  it: JobItem; pos: Vec3; rotY: number; color: string; soft: boolean
  state: string; active: boolean; checking: boolean; tags: string[]
}) {
  const [w, d, h] = it.dims ?? [0.3, 0.3, 0.3]
  const handedOff = state === 'handed_off'
  const warn = handedOff || checking
  const emissive = warn ? '#e8590c' : active ? '#4c6ef5' : '#000000'
  const ei = warn ? 0.45 : active ? 0.05 : 0
  return (
    <group position={pos} rotation={[0, rotY, 0]}>
      {soft ? (
        <RoundedBox args={[w, h, d]} radius={Math.min(0.07, h / 2.2)} smoothness={4} castShadow receiveShadow>
          <meshStandardMaterial color={color} roughness={0.75} emissive={emissive} emissiveIntensity={ei} />
        </RoundedBox>
      ) : (
        <>
          <mesh castShadow receiveShadow>
            <boxGeometry args={[w, h, d]} />
            <meshStandardMaterial color={color} roughness={0.88} emissive={emissive} emissiveIntensity={ei} />
          </mesh>
          {/* 封緘テープ */}
          <mesh position={[0, h / 2 + 0.001, 0]}>
            <boxGeometry args={[w * 1.001, 0.002, Math.min(0.06, d * 0.25)]} />
            <meshStandardMaterial color="#d9c49a" roughness={0.6} />
          </mesh>
        </>
      )}
      <Html center position={[0, h / 2 + 0.08, 0]} zIndexRange={[10, 0]}>
        <div className={`tag3d ${active ? 'is-active' : ''}`}>
          {it.object_id}
          {tags.map((t) => <span key={t} className="t-rule">{t}</span>)}
          {checking && <span className="t-hand">能力不足</span>}
          {handedOff && <span className="t-hand">人へ</span>}
        </div>
      </Html>
    </group>
  )
}

// ---- カメラ ----
const PRESET: Record<'overview' | 'cart', { pos: Vec3; target: Vec3 }> = {
  overview: { pos: [1.6, 3.3, 5.0], target: [-1.6, 0.2, 0.6] },
  cart: { pos: [1.3, 1.9, 2.7], target: [-0.1, 0.5, 0] },
}
function CameraRig({ mode, focus, onUser, fixed }: { mode: CamMode; focus: Vec3; onUser: () => void; fixed: boolean }) {
  const { camera } = useThree()
  const ctl = useRef<any>(null)
  const f = useRef(new THREE.Vector3(...focus))
  f.current.set(...focus)
  useEffect(() => {
    const c = ctl.current
    if (!c) return
    const h = () => onUser()
    c.addEventListener('start', h)
    return () => c.removeEventListener('start', h)
  }, [onUser])
  useFrame((_, dt) => {
    const c = ctl.current
    if (!c || mode === 'free') return
    let pos: THREE.Vector3, tgt: THREE.Vector3
    if (mode === 'follow' && fixed) {
      // 固定式：作業範囲は台座のまわりだけなので、コンベヤの端からカゴ車までを一定の視点で見る
      tgt = new THREE.Vector3(-0.8, 0.6, 0.3)
      pos = new THREE.Vector3(1.0, 2.8, 4.3)
    } else if (mode === 'follow') {
      // ロボットの手先とカゴ車の間を見る（作業の場所が変わるとゆっくり追う）
      const fx = Math.max(-5, Math.min(0.2, f.current.x))
      tgt = new THREE.Vector3((fx + 0) / 2 - 0.1, 0.45, 0.35)
      pos = new THREE.Vector3(tgt.x + 1.6, 2.3, 3.4)
    } else {
      pos = new THREE.Vector3(...PRESET[mode].pos)
      tgt = new THREE.Vector3(...PRESET[mode].target)
    }
    const a = Math.min(1, dt * 2)
    camera.position.lerp(pos, a)
    c.target.lerp(tgt, a)
    c.update()
  })
  return <OrbitControls ref={ctl} makeDefault target={[-1.4, 0.3, 0.5]} maxPolarAngle={1.45} minDistance={1.2} maxDistance={9} />
}

type Props = {
  job: JobTrace | null
  sample: Sample | null
  tl: Timeline | null
  colors: Record<string, string>
  soft: Record<string, boolean>
  caption: string
  camMode: CamMode
  onCamUser: () => void
  ruleTags: (it: JobItem, placed: boolean) => string[]
}

export default function Robot3D({ job, sample, tl, colors, soft, caption, camMode, onCamUser, ruleTags }: Props) {
  const robot = job?.robot ?? null
  const railZ = tl?.railZ ?? 0.85
  const shoulderY = tl?.shoulderY ?? 1.15
  const cart = job?.cart ?? { width_m: 1.0, depth_m: 0.75, height_m: 1.2 }
  const tip: Vec3 = sample?.gripper ?? [-0.6, 0.9, railZ - 0.3]
  const cur = sample?.current?.primitive ?? null
  const holding = (sample?.grip ?? 0) > 0.5
  const lamp: 'hold' | 'check' | 'idle' = holding ? 'hold' : sample?.phase === 'check' ? 'check' : 'idle'
  const curItem = job?.items.find((i) => i.object_id === cur?.object_id)
  // 挟み込みの指：把持中は荷物の幅、それ以外は少し広げる
  const spread = curItem?.dims ? (holding ? curItem.dims[0] : curItem.dims[0] + 0.08) : undefined
  const mode = tl?.mode ?? 'mobile'
  // 仮置き場（環境マスタ）：列ごとに、並ぶ荷物の範囲をパレットで覆う
  const pallets = useMemo(() => {
    const s = job?.staging ?? { first_x_m: -1.0, pitch_m: 0.6, rows_z_m: [0.25, 1.45] }
    const n = Math.max(1, Math.ceil((job?.items.length ?? 17) / s.rows_z_m.length))
    const x0 = s.first_x_m + 0.3, x1 = s.first_x_m - (n - 1) * s.pitch_m - 0.3
    const count = Math.max(1, Math.ceil((x0 - x1) / 1.22))
    return s.rows_z_m.flatMap((z) => Array.from({ length: count }, (_, i) => [x0 - 0.6 - i * 1.22, z] as [number, number]))
  }, [job])
  const parts = robot ? { base: robot.base, arm: robot.arm, end_effector: robot.end_effector, sensors: robot.sensors, peripherals: robot.peripherals } : null

  return (
    <div className="pane-3d" data-testid="robot-3d">
      <Canvas shadows dpr={[1, 1.5]} camera={{ position: [1.6, 3.3, 5.0], fov: 40 }} gl={{ preserveDrawingBuffer: true, antialias: true }}>
        <color attach="background" args={['#e9edf1']} />
        <fog attach="fog" args={['#e9edf1', 9, 18]} />
        <hemisphereLight args={['#ffffff', '#9aa1a8', 0.85]} />
        <directionalLight position={[3, 6, 4]} intensity={1.5} castShadow shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-7} shadow-camera-right={4} shadow-camera-top={4} shadow-camera-bottom={-4} shadow-bias={-0.0004} />
        <directionalLight position={[-4, 3, -2]} intensity={0.45} />
        <CameraRig mode={camMode} focus={tip} onUser={onCamUser} fixed={tl?.mode === 'fixed'} />

        <Floor />
        <SafetyLines x0={-6.4} x1={1.2} z0={-0.7} z1={2.0} />
        {pallets.map(([x, z]) => <Pallet key={`${x}${z}`} x={x} z={z} w={1.2} d={0.5} />)}
        <Cart w={cart.width_m} d={cart.depth_m} h={cart.height_m} />
        {tl?.conveyor && <Conveyor {...tl.conveyor} />}

        {robot && parts && mode === 'mobile' && <MobileRobot robot={robot} tip={tip} shoulderY={shoulderY} lamp={lamp} spread={spread} railZ={railZ} />}
        {robot && mode === 'fixed' && tl && <FixedRobot robot={robot} tip={tip} shoulderY={shoulderY} lamp={lamp} spread={spread} base={tl.base} />}
        {robot && parts && mode === 'concept' && (
          // 概念プレビュー：歩行・双腕の運搬は表現しない（静止した姿だけを置く）
          <group position={[-0.95, GROUND, railZ + 0.25]} rotation={[0, 0.5, 0]}>
            <Humanoid parts={parts} hl={[]} />
          </group>
        )}

        {job && sample && job.items.map((it) => {
          const s = sample.items[it.object_id]
          if (!s) return null
          const active = cur?.object_id === it.object_id
          return (
            <Item key={it.object_id} it={it} pos={s.pos} rotY={s.rotY} color={colors[it.object_id] ?? '#adb5bd'} soft={!!soft[it.object_id]}
              state={s.state} active={active} checking={active && cur?.kind === 'check'} tags={ruleTags(it, s.state === 'placed' || (active && cur?.kind === 'place'))} />
          )
        })}
      </Canvas>
      <div className="overlay-3d">
        仮想作業プレビュー（実行トレースを再生。把持力・可動域・干渉・安全性は未検証）
        {robot && <div className="robot-label" data-testid="robot-label">{robot.product?.maker_name ? `${robot.product.maker_name}・` : ''}{robot.label}（可搬{robot.payload_kg}kg・リーチ{robot.reach_m}m）</div>}
        <div className="robot-label legend">
          手首のランプ：<span style={{ color: '#2fb344' }}>●保持中</span> <span style={{ color: '#e03131' }}>●能力の確認（持ち上げない）</span>
        </div>
      </div>
      {caption && <div className="caption-3d" data-testid="caption-3d">{caption}</div>}
    </div>
  )
}
