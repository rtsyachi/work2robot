// 仮想メーカーのロボット製品の3Dレンダー（カタログのヒーロー画像・サムネイル用）。
// 実在の機種の形状を写したものではなく、機体タイプと装備しているオプションが分かる独自デザインの簡易モデル。
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { ContactShadows, Html, OrbitControls, RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import type { ConfigParts } from '../types'
import type { PartKind } from '../lib/hwConfig'
import { SHORT } from '../lib/hwConfig'

type V = [number, number, number]
const UP = new THREE.Vector3(0, 1, 0)

// ---- 材質（強調中の部位は青く光らせる） ----
const HL = createContext(false)
export function Paint({ color, metal = 0.25, rough = 0.45 }: { color: string; metal?: number; rough?: number }) {
  const on = useContext(HL)
  return <meshStandardMaterial color={color} metalness={metal} roughness={rough} emissive={on ? '#4c6ef5' : '#000000'} emissiveIntensity={on ? 0.08 : 0} />
}
type PartProps = { kind: PartKind; children: ReactNode; hl: PartKind[]; onPick?: (k: PartKind) => void; label?: V }
function Part({ kind, children, hl, onPick, label }: PartProps) {
  const on = hl.includes(kind)
  return (
    <HL.Provider value={on}>
      <group onClick={onPick ? (e) => { e.stopPropagation(); onPick(kind) } : undefined}
        onPointerOver={onPick ? () => { document.body.style.cursor = 'pointer' } : undefined}
        onPointerOut={onPick ? () => { document.body.style.cursor = '' } : undefined}>
        {children}
        {on && label && (
          <Html position={label} center zIndexRange={[20, 0]}>
            <div className="render-tag">{SHORT[kind]}</div>
          </Html>
        )}
      </group>
    </HL.Provider>
  )
}

// ---- 形の部品 ----
export function Box({ p, s, c, m, r, rad = 0.02, rot }: { p: V; s: V; c: string; m?: number; r?: number; rad?: number; rot?: V }) {
  return (
    <RoundedBox args={s} radius={rad} smoothness={3} position={p} rotation={rot} castShadow receiveShadow>
      <Paint color={c} metal={m} rough={r} />
    </RoundedBox>
  )
}
export function Cyl({ p, r, h, c, m, rough, rot }: { p: V; r: number; h: number; c: string; m?: number; rough?: number; rot?: V }) {
  return (
    <mesh position={p} rotation={rot} castShadow receiveShadow>
      <cylinderGeometry args={[r, r, h, 32]} />
      <Paint color={c} metal={m} rough={rough} />
    </mesh>
  )
}
/** 2点を結ぶ角材（アームのリンクなど） */
export function Beam({ a, b, w, d, c, m, r }: { a: V; b: V; w: number; d: number; c: string; m?: number; r?: number }) {
  const { pos, quat, len } = useMemo(() => {
    const va = new THREE.Vector3(...a)
    const vb = new THREE.Vector3(...b)
    const dir = vb.clone().sub(va)
    return { pos: va.add(vb).multiplyScalar(0.5), quat: new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize()), len: dir.length() }
  }, [a, b])
  return (
    <group position={pos} quaternion={quat}>
      <RoundedBox args={[w, len, d]} radius={Math.min(w, d) * 0.3} smoothness={3} castShadow receiveShadow>
        <Paint color={c} metal={m} rough={r} />
      </RoundedBox>
    </group>
  )
}
export function Capsule({ a, b, r, c, m, rough }: { a: V; b: V; r: number; c: string; m?: number; rough?: number }) {
  const { pos, quat, len } = useMemo(() => {
    const va = new THREE.Vector3(...a)
    const vb = new THREE.Vector3(...b)
    const dir = vb.clone().sub(va)
    return { pos: va.add(vb).multiplyScalar(0.5), quat: new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize()), len: dir.length() }
  }, [a, b])
  return (
    <mesh position={pos} quaternion={quat} castShadow receiveShadow>
      <capsuleGeometry args={[r, Math.max(len - 2 * r, 0.001), 8, 20]} />
      <Paint color={c} metal={m} rough={rough} />
    </mesh>
  )
}

// ---- 手先（手首の位置から下向きに付ける） ----
const RUBBER = '#2b6cb0'
/** spread：挟み込みの指の開き幅（荷物の幅に合わせる。省略時は標準の開き） */
export function Effector({ id, at, rot = [0, 0, 0], spread }: { id: string; at: V; rot?: V; spread?: number }) {
  const fx = (base: number) => (spread != null ? Math.max(spread / 2 + 0.013, 0.05) : base)
  return (
    <group position={at} rotation={rot}>
      {id !== 'humanoid_hands' && <Cyl p={[0, -0.02, 0]} r={0.055} h={0.04} c="#3a3f45" m={0.6} rough={0.35} />}
      {(id === 'vacuum' || id === 'vacuum_gripper') && (
        <>
          <Box p={[0, -0.06, 0]} s={[id === 'vacuum' ? 0.28 : 0.22, 0.03, 0.18]} c="#4a5058" m={0.5} r={0.35} rad={0.008} />
          {(id === 'vacuum' ? [[-0.1, -0.06], [0.1, -0.06], [-0.1, 0.06], [0.1, 0.06]] : [[-0.05, 0], [0.05, 0]]).map(([x, z], i) => (
            <group key={i}>
              <Cyl p={[x, -0.09, z]} r={0.012} h={0.035} c="#8a9096" m={0.7} rough={0.3} />
              <Cyl p={[x, -0.115, z]} r={0.032} h={0.02} c={RUBBER} m={0} rough={0.8} />
            </group>
          ))}
        </>
      )}
      {(id === 'parallel_gripper' || id === 'vacuum_gripper') && (
        <>
          {id === 'parallel_gripper' && <Box p={[0, -0.07, 0]} s={[0.2, 0.07, 0.09]} c="#30353b" m={0.5} r={0.4} rad={0.01} />}
          {[-1, 1].map((sx) => (
            <Box key={sx} p={[sx * fx(id === 'parallel_gripper' ? 0.085 : 0.125), id === 'parallel_gripper' ? -0.16 : -0.14, 0]}
              s={[0.025, 0.14, 0.06]} c="#c9cdd2" m={0.8} r={0.25} rad={0.006} />
          ))}
        </>
      )}
      {id === 'humanoid_hands' && (
        <>
          <Box p={[0, -0.05, 0]} s={[0.08, 0.1, 0.035]} c="#2a2e33" m={0.4} r={0.4} rad={0.01} />
          {[-0.027, -0.009, 0.009, 0.027].map((x) => <Box key={x} p={[x, -0.125, 0]} s={[0.015, 0.06, 0.02]} c="#3a3f45" m={0.4} r={0.4} rad={0.006} />)}
          <Box p={[0.05, -0.07, 0.01]} s={[0.015, 0.05, 0.02]} c="#3a3f45" m={0.4} r={0.4} rad={0.006} rot={[0, 0, -0.5]} />
        </>
      )}
    </group>
  )
}
export function DepthCam({ p, rot }: { p: V; rot?: V }) {
  return (
    <group position={p} rotation={rot}>
      <Box p={[0, 0, 0]} s={[0.2, 0.05, 0.05]} c="#1c1f23" m={0.3} r={0.3} rad={0.01} />
      {[-0.06, 0.06].map((x) => <Cyl key={x} p={[x, 0, 0.026]} r={0.013} h={0.006} c="#4dabf7" m={0.2} rough={0.1} rot={[Math.PI / 2, 0, 0]} />)}
      <Cyl p={[0, 0, 0.026]} r={0.006} h={0.006} c="#ff6b6b" rot={[Math.PI / 2, 0, 0]} />
    </group>
  )
}
function RgbCam({ p, rot }: { p: V; rot?: V }) {
  return (
    <group position={p} rotation={rot}>
      <Box p={[0, 0, 0]} s={[0.07, 0.06, 0.07]} c="#1c1f23" m={0.3} r={0.3} rad={0.01} />
      <Cyl p={[0, 0, 0.04]} r={0.022} h={0.02} c="#228be6" m={0.3} rough={0.1} rot={[Math.PI / 2, 0, 0]} />
    </group>
  )
}
export function ForceRing({ p, c = '#f08c00' }: { p: V; c?: string }) {
  return <Cyl p={p} r={0.062} h={0.035} c={c} m={0.5} rough={0.35} />
}
function Scale({ p }: { p: V }) {
  return (
    <group position={p}>
      <Box p={[0, 0.04, 0]} s={[0.5, 0.06, 0.4]} c="#adb5bd" m={0.7} r={0.3} rad={0.01} />
      <Box p={[0.18, 0.08, 0.16]} s={[0.1, 0.03, 0.05]} c="#1c1f23" rad={0.005} />
    </group>
  )
}
function Carton({ p, s = [0.4, 0.28, 0.32] as V }: { p: V; s?: V }) {
  return (
    <mesh position={p} castShadow receiveShadow>
      <boxGeometry args={s} />
      <meshStandardMaterial color="#c49a6c" roughness={0.9} />
    </mesh>
  )
}

export type Kit = { parts: ConfigParts; hl: PartKind[]; onPick?: (k: PartKind) => void }

// ---- A社：固定式ステーションアーム（オレンジ・グラファイト、設備感） ----
function FixedArm({ parts, hl, onPick }: Kit) {
  const OR = '#e8661c', GR = '#2b2f33', ST = '#8a9096'
  const W: V = [1.12, 1.36, 0]
  return (
    <group>
      <Part kind="base" hl={hl} onPick={onPick} label={[0, 0.65, 0.3]}>
        <Box p={[0, 0.02, 0]} s={[0.95, 0.04, 0.95]} c="#5c636a" m={0.6} r={0.4} rad={0.01} />
        {[[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]].map(([x, z], i) => <Cyl key={i} p={[x, 0.05, z]} r={0.025} h={0.03} c={ST} m={0.8} rough={0.3} />)}
        <Box p={[0, 0.3, 0]} s={[0.4, 0.52, 0.4]} c={GR} m={0.4} r={0.45} rad={0.02} />
        <Box p={[0, 0.3, 0.205]} s={[0.26, 0.3, 0.01]} c="#3d4349" m={0.4} r={0.5} rad={0.004} />
        <Cyl p={[0, 0.62, 0]} r={0.24} h={0.14} c={OR} m={0.35} rough={0.4} />
      </Part>
      <Part kind="arm" hl={hl} onPick={onPick} label={[0.5, 1.75, 0.2]}>
        <Box p={[0, 0.83, 0]} s={[0.34, 0.32, 0.36]} c={OR} m={0.35} r={0.4} rad={0.04} />
        <Cyl p={[0, 0.92, 0]} r={0.14} h={0.44} c={GR} m={0.5} rough={0.35} rot={[0, 0, Math.PI / 2]} />
        <Beam a={[0, 0.92, 0]} b={[0.32, 1.72, 0]} w={0.2} d={0.24} c={OR} m={0.35} r={0.4} />
        <Cyl p={[0.32, 1.72, 0]} r={0.12} h={0.32} c={GR} m={0.5} rough={0.35} rot={[Math.PI / 2, 0, 0]} />
        <Box p={[0.2, 1.8, 0]} s={[0.18, 0.16, 0.2]} c={GR} m={0.5} r={0.35} rad={0.02} />
        <Beam a={[0.32, 1.72, 0]} b={[W[0], 1.56, 0]} w={0.15} d={0.17} c={OR} m={0.35} r={0.4} />
        <Cyl p={[W[0], 1.53, 0]} r={0.075} h={0.12} c={GR} m={0.5} rough={0.35} rot={[Math.PI / 2, 0, 0]} />
        <Cyl p={[W[0], 1.44, 0]} r={0.06} h={0.12} c={GR} m={0.5} rough={0.35} />
      </Part>
      <Part kind="end_effector" hl={hl} onPick={onPick} label={[W[0] + 0.25, W[1] - 0.15, 0]}>
        <Effector id={parts.end_effector} at={parts.sensors.includes('wrist_force_sensor') ? [W[0], W[1] - 0.035, 0] : W} />
        <Carton p={[W[0], W[1] - 0.33, 0]} s={[0.38, 0.26, 0.3]} />
      </Part>
      <Part kind="sensor" hl={hl} onPick={onPick} label={[-0.75, 2.2, -0.5]}>
        {parts.sensors.includes('depth_camera') && (
          <group>
            <Cyl p={[-0.75, 1.05, -0.5]} r={0.03} h={2.1} c={ST} m={0.8} rough={0.3} />
            <Box p={[-0.45, 2.08, -0.5]} s={[0.6, 0.04, 0.05]} c={ST} m={0.8} r={0.3} rad={0.005} />
            <DepthCam p={[-0.2, 2.03, -0.5]} rot={[-1.1, 0, 0]} />
          </group>
        )}
        {parts.sensors.includes('rgb_camera') && <RgbCam p={[0.75, 1.68, 0.12]} rot={[-0.6, 0.4, 0]} />}
        {parts.sensors.includes('wrist_force_sensor') && <ForceRing p={[W[0], W[1] - 0.005, 0]} />}
        {parts.sensors.includes('scale_station') && <Scale p={[0.95, 0, 0.75]} />}
      </Part>
      <Part kind="peripheral" hl={hl} onPick={onPick} label={[-1.0, 0.95, 0.75]}>
        {parts.peripherals.includes('infeed_conveyor') && (
          <group position={[-1.0, 0, 0.7]}>
            {[-0.55, 0.55].map((x) => [-0.2, 0.2].map((z) => <Box key={`${x}${z}`} p={[x, 0.33, z]} s={[0.05, 0.66, 0.05]} c={ST} m={0.7} r={0.3} rad={0.005} />))}
            <Box p={[0, 0.69, 0]} s={[1.3, 0.07, 0.5]} c="#3d4349" m={0.5} r={0.4} rad={0.01} />
            <Box p={[0, 0.735, 0]} s={[1.24, 0.02, 0.42]} c="#1c1f23" m={0.1} r={0.8} rad={0.004} />
            <Carton p={[0.25, 0.89, 0]} s={[0.36, 0.28, 0.3]} />
          </group>
        )}
      </Part>
    </group>
  )
}

// ---- B社：車輪移動式マニピュレータ（白・黒・ティール） ----
function MobileArm({ parts, hl, onPick, light }: Kit & { light: boolean }) {
  const WH = '#eef0f2', BK = '#1f2328', AC = '#12b886'
  const k = light ? 0.82 : 1
  const S: V = [-0.08, 1.0, 0]
  const E: V = [0.22, 1.0 + 0.55 * k, 0]
  const W: V = [0.22 + 0.5 * k, 1.0 + 0.32 * k, 0]
  return (
    <group>
      <Part kind="base" hl={hl} onPick={onPick} label={[0, 0.45, 0.4]}>
        <Box p={[0, 0.25, 0]} s={[0.92, 0.3, 0.66]} c={WH} m={0.15} r={0.35} rad={0.06} />
        <Box p={[0, 0.12, 0]} s={[0.95, 0.09, 0.69]} c={BK} m={0.2} r={0.6} rad={0.03} />
        <Box p={[0.475, 0.26, 0]} s={[0.01, 0.025, 0.5]} c={AC} m={0} r={0.3} rad={0.004} />
        <Box p={[0, 0.26, 0.335]} s={[0.6, 0.02, 0.01]} c={AC} m={0} r={0.3} rad={0.004} />
        {[[-0.32, 0.3], [0.32, 0.3], [-0.32, -0.3], [0.32, -0.3]].map(([x, z], i) => (
          <Cyl key={i} p={[x, 0.08, z]} r={0.08} h={0.06} c="#111" m={0.1} rough={0.9} rot={[Math.PI / 2, 0, 0]} />
        ))}
        <Cyl p={[0.36, 0.43, 0]} r={0.055} h={0.06} c={BK} m={0.3} rough={0.3} />
        <Cyl p={[-0.08, 0.44, 0]} r={0.13} h={0.08} c={BK} m={0.3} rough={0.4} />
        <Box p={[-0.08, 0.7, 0]} s={[0.17, 0.48, 0.17]} c={WH} m={0.15} r={0.35} rad={0.04} />
      </Part>
      <Part kind="arm" hl={hl} onPick={onPick} label={[0.3, 1.75, 0.2]}>
        <Cyl p={S} r={0.085} h={0.17} c={BK} m={0.3} rough={0.4} rot={[Math.PI / 2, 0, 0]} />
        <Cyl p={[S[0], S[1], 0.09]} r={0.088} h={0.012} c={AC} rot={[Math.PI / 2, 0, 0]} />
        <Capsule a={S} b={E} r={0.068 * k} c={WH} m={0.15} rough={0.35} />
        <Cyl p={E} r={0.07} h={0.15} c={BK} m={0.3} rough={0.4} rot={[Math.PI / 2, 0, 0]} />
        <Cyl p={[E[0], E[1], 0.078]} r={0.072} h={0.01} c={AC} rot={[Math.PI / 2, 0, 0]} />
        <Capsule a={E} b={[W[0], W[1] + 0.05, 0]} r={0.055 * k} c={WH} m={0.15} rough={0.35} />
        <Cyl p={[W[0], W[1] + 0.02, 0]} r={0.055} h={0.08} c={BK} m={0.3} rough={0.4} />
      </Part>
      <Part kind="end_effector" hl={hl} onPick={onPick} label={[W[0] + 0.22, W[1] - 0.15, 0]}>
        <Effector id={parts.end_effector} at={parts.sensors.includes('wrist_force_sensor') ? [W[0], W[1] - 0.035, 0] : [W[0], W[1] - 0.02, 0]} />
        <Carton p={[W[0], W[1] - 0.33, 0]} s={[0.34, 0.24, 0.28]} />
      </Part>
      <Part kind="sensor" hl={hl} onPick={onPick} label={[-0.08, 1.25, 0.25]}>
        {parts.sensors.includes('depth_camera') && <DepthCam p={[0.02, 0.86, 0]} rot={[0, Math.PI / 2, 0]} />}
        {parts.sensors.includes('rgb_camera') && <RgbCam p={[-0.08, 0.98, 0.1]} rot={[0, 0.6, 0]} />}
        {parts.sensors.includes('wrist_force_sensor') && <ForceRing p={[W[0], W[1] - 0.01, 0]} c={AC} />}
        {parts.sensors.includes('scale_station') && <Scale p={[0.95, 0, 0.75]} />}
      </Part>
      <Part kind="peripheral" hl={hl} onPick={onPick}><group /></Part>
    </group>
  )
}

// ---- C社：ヒューマノイド（メタリックグレー・ダーク） ----
export function Humanoid({ parts, hl, onPick }: Kit) {
  const MG = '#a3a9b0', DK = '#24272b', AC = '#4dabf7'
  const legs = [-1, 1].map((s) => ({ hip: [s * 0.11, 0.9, 0] as V, knee: [s * 0.12, 0.5, 0.03] as V, ankle: [s * 0.12, 0.1, 0] as V }))
  const arms = [-1, 1].map((s) => ({ sh: [s * 0.27, 1.47, 0] as V, el: [s * 0.32, 1.18, 0.1] as V, wr: [s * 0.3, 1.04, 0.33] as V }))
  return (
    <group>
      <Part kind="base" hl={hl} onPick={onPick} label={[0.35, 0.5, 0.2]}>
        {legs.map((l, i) => (
          <group key={i}>
            <Capsule a={l.hip} b={l.knee} r={0.07} c={MG} m={0.75} rough={0.3} />
            <Capsule a={l.knee} b={l.ankle} r={0.058} c={MG} m={0.75} rough={0.3} />
            <mesh position={l.knee} castShadow><sphereGeometry args={[0.065, 24, 16]} /><Paint color={DK} metal={0.4} rough={0.4} /></mesh>
            <Box p={[l.ankle[0], 0.04, 0.05]} s={[0.12, 0.07, 0.26]} c={DK} m={0.3} r={0.5} rad={0.02} />
          </group>
        ))}
        <Box p={[0, 0.96, 0]} s={[0.34, 0.16, 0.2]} c={DK} m={0.35} r={0.45} rad={0.04} />
      </Part>
      <group>
        <Box p={[0, 1.28, 0]} s={[0.44, 0.48, 0.25]} c={MG} m={0.75} r={0.3} rad={0.07} />
        <Box p={[0, 1.33, 0.126]} s={[0.34, 0.2, 0.02]} c={DK} m={0.4} r={0.3} rad={0.02} />
        <Box p={[0, 1.33, 0.137]} s={[0.12, 0.012, 0.004]} c={AC} m={0} r={0.3} rad={0.002} />
        <Box p={[0, 1.08, 0.08]} s={[0.26, 0.12, 0.12]} c={DK} m={0.35} r={0.45} rad={0.03} />
        <Cyl p={[0, 1.57, 0]} r={0.045} h={0.08} c={DK} m={0.4} rough={0.4} />
        <Box p={[0, 1.71, 0]} s={[0.2, 0.24, 0.22]} c={MG} m={0.75} r={0.3} rad={0.07} />
        <Box p={[0, 1.72, 0.105]} s={[0.17, 0.08, 0.02]} c="#0b0d10" m={0.6} r={0.08} rad={0.02} />
      </group>
      <Part kind="arm" hl={hl} onPick={onPick} label={[0.45, 1.35, 0.15]}>
        {arms.map((a, i) => (
          <group key={i}>
            <mesh position={a.sh} castShadow><sphereGeometry args={[0.075, 24, 16]} /><Paint color={DK} metal={0.4} rough={0.4} /></mesh>
            <Capsule a={a.sh} b={a.el} r={0.055} c={MG} m={0.75} rough={0.3} />
            <Capsule a={a.el} b={a.wr} r={0.047} c={MG} m={0.75} rough={0.3} />
          </group>
        ))}
      </Part>
      <Part kind="end_effector" hl={hl} onPick={onPick} label={[0.45, 1.0, 0.4]}>
        {arms.map((a, i) => <Effector key={i} id={parts.end_effector} at={a.wr} rot={[-0.9, 0, 0]} />)}
      </Part>
      <Part kind="sensor" hl={hl} onPick={onPick} label={[0, 1.95, 0.1]}>
        {parts.sensors.includes('rgb_camera') && <Cyl p={[0.05, 1.72, 0.118]} r={0.014} h={0.01} c="#228be6" rot={[Math.PI / 2, 0, 0]} />}
        {parts.sensors.includes('depth_camera') && <DepthCam p={[0, 1.81, 0.1]} />}
        {parts.sensors.includes('wrist_force_sensor') && arms.map((a, i) => <ForceRing key={i} p={a.wr} c={AC} />)}
      </Part>
    </group>
  )
}

const VIEW: Record<string, { cam: V; target: V }> = {
  fixed_pedestal: { cam: [2.5, 2.1, 3.1], target: [0.1, 0.95, 0.2] },
  wheeled_base: { cam: [2.2, 1.55, 2.6], target: [0.15, 0.7, 0.1] },
  legged_humanoid: { cam: [1.5, 1.45, 2.4], target: [0, 0.98, 0.05] },
}

type Props = {
  parts: ConfigParts
  highlight?: PartKind[]
  onPick?: (k: PartKind) => void
  thumb?: boolean
  armId?: string
}

/** 製品のレンダー。thumb はサムネイル（操作なし・静止）。 */
export default function ProductRender({ parts, highlight = [], onPick, thumb = false }: Props) {
  const view = VIEW[parts.base] ?? VIEW.wheeled_base
  const kit = { parts, hl: highlight, onPick }
  return (
    <Canvas
      className={thumb ? 'render-thumb' : 'render-hero'} shadows dpr={thumb ? 1 : [1, 1.5]} frameloop="demand"
      camera={{ position: view.cam, fov: thumb ? 36 : 34 }} gl={{ preserveDrawingBuffer: true, antialias: true }}
      onCreated={({ camera }) => camera.lookAt(...view.target)}
    >
      <hemisphereLight args={['#ffffff', '#8c939a', 0.9]} />
      <directionalLight position={[3, 5, 4]} intensity={1.6} castShadow shadow-mapSize={[1024, 1024]} />
      <directionalLight position={[-3, 2.5, -2]} intensity={0.5} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[3.2, 48]} />
        <meshStandardMaterial color="#e9ecef" roughness={0.95} />
      </mesh>
      <ContactShadows position={[0, 0.002, 0]} opacity={0.45} scale={6} blur={2.2} far={2.5} frames={1} />
      {parts.base === 'fixed_pedestal' && <FixedArm {...kit} />}
      {parts.base === 'wheeled_base' && <MobileArm {...kit} light={parts.arm === 'arm_light'} />}
      {parts.base === 'legged_humanoid' && <Humanoid {...kit} />}
      {!thumb && <OrbitControls target={view.target} enablePan={false} enableZoom={false} minPolarAngle={0.6} maxPolarAngle={1.45} />}
    </Canvas>
  )
}
