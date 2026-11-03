import { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { JobTrace, Vec3 } from '../types'
import { RAIL_Z, SHOULDER_Y, type Sample, elbow } from '../lib/robotTimeline'

const UP = new THREE.Vector3(0, 1, 0)

function Limb({ a, b, r, color }: { a: Vec3; b: Vec3; r: number; color: string }) {
  const { pos, quat, len } = useMemo(() => {
    const va = new THREE.Vector3(...a)
    const vb = new THREE.Vector3(...b)
    const dir = vb.clone().sub(va)
    const length = Math.max(dir.length(), 1e-4)
    return {
      pos: va.add(vb).multiplyScalar(0.5),
      quat: new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()),
      len: length,
    }
  }, [a, b])
  return (
    <mesh position={pos} quaternion={quat} castShadow>
      <cylinderGeometry args={[r, r, len, 16]} />
      <meshStandardMaterial color={color} metalness={0.3} roughness={0.5} />
    </mesh>
  )
}

function Cart({ w, d, h }: { w: number; d: number; h: number }) {
  const bars: [Vec3, Vec3][] = []
  for (let x = -w / 2; x <= w / 2 + 1e-6; x += 0.1) bars.push([[x, 0, -d / 2], [x, h, -d / 2]])
  for (let z = -d / 2; z <= d / 2 + 1e-6; z += 0.1) {
    bars.push([[-w / 2, 0, z], [-w / 2, h, z]])
    bars.push([[w / 2, 0, z], [w / 2, h, z]])
  }
  for (const y of [0.4, 0.8, h]) {
    bars.push([[-w / 2, y, -d / 2], [w / 2, y, -d / 2]])
    bars.push([[-w / 2, y, -d / 2], [-w / 2, y, d / 2]])
    bars.push([[w / 2, y, -d / 2], [w / 2, y, d / 2]])
  }
  return (
    <group>
      <mesh position={[0, -0.015, 0]} receiveShadow>
        <boxGeometry args={[w, 0.03, d]} />
        <meshStandardMaterial color="#868e96" metalness={0.5} roughness={0.4} />
      </mesh>
      {bars.map(([a, b], i) => <Limb key={i} a={a} b={b} r={0.008} color="#9aa1a8" />)}
    </group>
  )
}

type Props = {
  job: JobTrace | null
  sample: Sample | null
  colors: Record<string, string>
  caption: string
}

export default function Robot3D({ job, sample, colors, caption }: Props) {
  const g: Vec3 = sample?.gripper ?? [-0.5, 0.95, 0.6]
  const shoulder: Vec3 = [g[0], SHOULDER_Y, RAIL_Z]
  const el = elbow(shoulder, g)
  const cart = job?.cart ?? { width_m: 0.8, depth_m: 0.6, height_m: 1.6 }

  return (
    <div className="pane-3d" data-testid="robot-3d">
      <Canvas shadows camera={{ position: [1.2, 2.5, 3.3], fov: 42 }} gl={{ preserveDrawingBuffer: true }}>
        <color attach="background" args={['#eef1f4']} />
        <hemisphereLight args={['#ffffff', '#adb5bd', 0.9]} />
        <directionalLight position={[3, 6, 4]} intensity={1.4} castShadow />
        <OrbitControls target={[-1.0, 0.3, 0]} />

        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.15, 0]} receiveShadow>
          <planeGeometry args={[12, 8]} />
          <meshStandardMaterial color="#d0d5da" />
        </mesh>
        {/* 仮置き台 */}
        <mesh position={[-2.05, -0.075, 0]} receiveShadow>
          <boxGeometry args={[2.9, 0.15, 0.7]} />
          <meshStandardMaterial color="#8d7b68" />
        </mesh>
        {/* レール */}
        <mesh position={[-1.5, -0.1, RAIL_Z]}>
          <boxGeometry args={[4.4, 0.1, 0.12]} />
          <meshStandardMaterial color="#495057" />
        </mesh>
        <Cart w={cart.width_m} d={cart.depth_m} h={Math.min(cart.height_m, 1.2)} />

        {/* 模擬ロボット（レール走行＋2リンクアーム） */}
        <mesh position={[g[0], 0.0, RAIL_Z]} castShadow>
          <boxGeometry args={[0.3, 0.12, 0.3]} />
          <meshStandardMaterial color="#e8590c" />
        </mesh>
        <Limb a={[g[0], 0, RAIL_Z]} b={shoulder} r={0.05} color="#e8590c" />
        <Limb a={shoulder} b={el} r={0.04} color="#343a40" />
        <Limb a={el} b={g} r={0.035} color="#343a40" />
        <mesh position={[g[0], g[1] + 0.02, g[2]]}>
          <boxGeometry args={[0.16, 0.04, 0.16]} />
          <meshStandardMaterial color="#fab005" />
        </mesh>

        {job && sample && job.items.map((it) => {
          const s = sample.items[it.object_id]
          if (!s) return null
          const [w, d, h] = it.dims ?? [0.3, 0.3, 0.3]
          const handedOff = s.state === 'handed_off'
          const active = sample.current?.primitive.object_id === it.object_id
          return (
            <group key={it.object_id} position={s.pos} rotation={[0, s.rotY, 0]}>
              <mesh castShadow receiveShadow>
                <boxGeometry args={[w, h, d]} />
                <meshStandardMaterial
                  color={colors[it.object_id] ?? '#adb5bd'}
                  emissive={handedOff ? '#e8590c' : active ? '#4c6ef5' : '#000000'}
                  emissiveIntensity={handedOff ? 0.5 : active ? 0.25 : 0}
                />
              </mesh>
              <Html center position={[0, h / 2 + 0.08, 0]} zIndexRange={[10, 0]}>
                <div className={`tag3d ${active ? 'is-active' : ''}`}>
                  {it.object_id}
                  {s.state === 'placed' && it.provisional && <span className="t-prov">暫定</span>}
                  {handedOff && <span className="t-hand">人へ</span>}
                </div>
              </Html>
            </group>
          )
        })}
      </Canvas>
      <div className="overlay-3d">仮想プレビュー（作業ロジックの確認。実機の把持・安全性は未検証）</div>
      {caption && <div className="caption-3d" data-testid="caption-3d">{caption}</div>}
    </div>
  )
}
