// ロボット全身の模式図（SVG）。構成の部品に応じて描き分け、部品ごとにクリックできる。実在の機種の外観ではない。
import type { CheckStatus, ConfigParts, HwCatalog } from '../types'
import type { PartKind } from '../lib/hwConfig'
import { SHORT, STATUS } from '../lib/hwConfig'

const PX = 120 // 1m あたりの画素数（模式図）
const GROUND = 410

type Geo = { sx: number; sy: number; ex: number; ey: number; wx: number; wy: number; thick: number }

function armGeo(cat: HwCatalog, parts: ConfigParts, side = 1): Geo {
  const base = cat.components.base.find((b) => b.id === parts.base)
  const arm = cat.components.arm.find((a) => a.id === parts.arm)
  const sh = base?.shoulder_height_m ?? 0.9
  const L = ((arm?.reach_m ?? 1.0) / 2) * PX
  const sx = 170 + side * (parts.base === 'legged_humanoid' ? 28 : 0)
  const sy = GROUND - sh * PX - 40
  const ex = sx + side * L * 0.55
  const ey = sy - L * 0.8
  return { sx, sy, ex, ey, wx: ex + side * L * 0.95, wy: ey + L * 0.45, thick: 6 + (arm?.payload_kg ?? 10) / 3 }
}

/** 手先の絵（x,y が手首。下向き） */
export function EffectorShape({ id, x, y, s = 1 }: { id: string; x: number; y: number; s?: number }) {
  const pad = id === 'vacuum' || id === 'vacuum_gripper'
  const fingers = id === 'parallel_gripper' || id === 'vacuum_gripper'
  return (
    <g transform={`translate(${x},${y}) scale(${s})`}>
      <rect x={-5} y={0} width={10} height={12} rx={2} fill="#495057" />
      {pad && (
        <>
          <rect x={-18} y={12} width={36} height={6} rx={2} fill="#343a40" />
          {[-12, 0, 12].map((dx) => <ellipse key={dx} cx={dx} cy={21} rx={5} ry={3} fill="#1c7ed6" />)}
        </>
      )}
      {fingers && (
        <>
          <rect x={-22} y={pad ? 18 : 12} width={44} height={5} rx={2} fill="#868e96" />
          <rect x={-22} y={pad ? 22 : 16} width={6} height={22} rx={2} fill="#f08c00" />
          <rect x={16} y={pad ? 22 : 16} width={6} height={22} rx={2} fill="#f08c00" />
        </>
      )}
      {id === 'humanoid_hands' && (
        <>
          <ellipse cx={0} cy={20} rx={9} ry={11} fill="#e0b48f" />
          {[-6, -2, 2, 6].map((dx) => <rect key={dx} x={dx - 1.5} y={26} width={3} height={9} rx={1.5} fill="#e0b48f" />)}
        </>
      )}
    </g>
  )
}

/** 部品の小さな絵（カタログのカード用） */
export function PartIcon({ kind, id }: { kind: PartKind; id: string }) {
  return (
    <svg viewBox="0 0 100 70" className="part-icon" aria-hidden>
      {kind === 'end_effector' && <EffectorShape id={id} x={50} y={6} s={1.3} />}
      {kind === 'base' && id === 'wheeled_base' && (<><rect x={18} y={24} width={64} height={24} rx={6} fill="#e8590c" /><circle cx={30} cy={54} r={9} fill="#212529" /><circle cx={70} cy={54} r={9} fill="#212529" /></>)}
      {kind === 'base' && id === 'fixed_pedestal' && (<><rect x={34} y={14} width={32} height={46} rx={3} fill="#868e96" /><rect x={22} y={58} width={56} height={8} fill="#495057" /></>)}
      {kind === 'base' && id === 'legged_humanoid' && (<><circle cx={50} cy={10} r={7} fill="#adb5bd" /><rect x={40} y={18} width={20} height={26} rx={4} fill="#5f3dc4" /><line x1={45} y1={44} x2={40} y2={66} stroke="#343a40" strokeWidth={5} /><line x1={55} y1={44} x2={60} y2={66} stroke="#343a40" strokeWidth={5} /></>)}
      {kind === 'arm' && (() => {
        const t: Record<string, [number, number]> = { arm_light: [22, 6], arm_medium: [28, 9], arm_heavy: [36, 12], arm_dual_humanoid: [18, 5] }
        const [L, w] = t[id] ?? [26, 8]
        return (<g stroke="#343a40" strokeLinecap="round"><line x1={20} y1={60} x2={20 + L * 0.6} y2={60 - L} strokeWidth={w} /><line x1={20 + L * 0.6} y1={60 - L} x2={20 + L * 1.9} y2={60 - L * 0.55} strokeWidth={w * 0.8} /><circle cx={20} cy={60} r={w * 0.7} fill="#e8590c" stroke="none" /></g>)
      })()}
      {kind === 'sensor' && id === 'rgb_camera' && (<><rect x={28} y={22} width={44} height={28} rx={4} fill="#343a40" /><circle cx={50} cy={36} r={10} fill="#4dabf7" /></>)}
      {kind === 'sensor' && id === 'depth_camera' && (<><rect x={18} y={26} width={64} height={20} rx={4} fill="#343a40" /><circle cx={34} cy={36} r={6} fill="#74c0fc" /><circle cx={66} cy={36} r={6} fill="#74c0fc" /><circle cx={50} cy={36} r={3} fill="#ff6b6b" /></>)}
      {kind === 'sensor' && id === 'wrist_force_sensor' && (<><rect x={30} y={26} width={40} height={18} rx={3} fill="#f08c00" /><text x={50} y={39} fontSize={10} textAnchor="middle" fill="#fff">F/T</text></>)}
      {kind === 'sensor' && id === 'scale_station' && (<><rect x={16} y={40} width={68} height={10} rx={2} fill="#868e96" /><rect x={40} y={50} width={20} height={12} fill="#495057" /><text x={50} y={34} fontSize={12} textAnchor="middle" fill="#495057">kg</text></>)}
      {kind === 'peripheral' && (<><rect x={6} y={36} width={88} height={10} rx={3} fill="#495057" />{[14, 30, 46, 62, 78].map((x) => <circle key={x} cx={x} cy={41} r={3} fill="#adb5bd" />)}<rect x={20} y={20} width={22} height={16} fill="#c9a46b" /><text x={66} y={30} fontSize={14} fill="#495057">→</text></>)}
    </svg>
  )
}

type Props = {
  cat: HwCatalog
  parts: ConfigParts
  selected: PartKind | null
  status: Partial<Record<PartKind, CheckStatus | null>>
  onPick: (k: PartKind) => void
  locked?: PartKind[]   // 機種に固定された部品（吹き出しに鍵の印）
  compact?: boolean     // 機種カード用の小さな絵（吹き出しなし）
}

/** ロボット全身の模式図。部品ごとにクリックできる */
export default function RobotFigure({ cat, parts, selected, status, onPick, locked = [], compact = false }: Props) {
  const legged = parts.base === 'legged_humanoid'
  const g = armGeo(cat, parts)
  const g2 = legged ? armGeo(cat, parts, -1) : null
  // 機種カード用の小さな絵では、部品を個別に選べないようにする（カード全体のクリックだけ）
  const hot = (k: PartKind) => (compact ? {} : {
    className: `fig-part ${selected === k ? 'is-sel' : ''}`,
    onClick: () => onPick(k),
    'data-testid': `fig-${k}`,
  })
  const mastX = legged ? 170 : 128
  const mastTop = legged ? g.sy - 62 : g.sy - 30
  const callouts: { k: PartKind; x: number; y: number; tx: number; ty: number }[] = [
    { k: 'end_effector', x: g.wx, y: g.wy + 24, tx: 300, ty: 70 },
    { k: 'arm', x: (g.sx + g.ex) / 2, y: (g.sy + g.ey) / 2, tx: 300, ty: 120 },
    { k: 'sensor', x: mastX, y: mastTop, tx: 14, ty: 70 },
    { k: 'base', x: 170, y: GROUND - 30, tx: 300, ty: 330 },
    { k: 'peripheral', x: 46, y: GROUND - 18, tx: 14, ty: 300 },
  ]

  return (
    <svg viewBox={compact ? '0 40 400 390' : '0 0 400 430'} className={compact ? 'robot-mini' : 'robot-figure'}
      data-testid={compact ? undefined : 'robot-figure'} style={compact ? { pointerEvents: 'none' } : undefined}>
      <rect x={0} y={GROUND} width={400} height={20} fill="#e9ecef" />
      {/* 周辺設備 */}
      <g {...hot('peripheral')}>
        <rect x={6} y={GROUND - 40} width={90} height={40} fill="transparent" />
        {parts.peripherals.includes('infeed_conveyor') ? (
          <>
            <rect x={6} y={GROUND - 22} width={86} height={9} rx={3} fill="#495057" />
            {[14, 30, 46, 62, 78].map((x) => <circle key={x} cx={x} cy={GROUND - 17.5} r={3} fill="#adb5bd" />)}
            <rect x={20} y={GROUND - 38} width={22} height={16} fill="#c9a46b" />
          </>
        ) : <rect x={12} y={GROUND - 16} width={70} height={10} rx={3} fill="none" stroke="#ced4da" strokeDasharray="4 3" />}
        {parts.sensors.includes('scale_station') && (
          <g><rect x={58} y={GROUND - 8} width={34} height={6} rx={2} fill="#868e96" /><text x={75} y={GROUND - 12} fontSize={9} textAnchor="middle" fill="#495057">kg</text></g>
        )}
      </g>
      {/* 移動方式（土台） */}
      <g {...hot('base')}>
        {parts.base === 'wheeled_base' && (
          <>
            <rect x={110} y={GROUND - 62} width={120} height={46} rx={10} fill="#e8590c" />
            <circle cx={135} cy={GROUND - 12} r={12} fill="#212529" />
            <circle cx={205} cy={GROUND - 12} r={12} fill="#212529" />
            <rect x={160} y={g.sy} width={20} height={GROUND - 62 - g.sy} fill="#d9480f" />
          </>
        )}
        {parts.base === 'fixed_pedestal' && (
          <>
            <rect x={140} y={g.sy} width={60} height={GROUND - g.sy - 8} rx={4} fill="#868e96" />
            <rect x={122} y={GROUND - 10} width={96} height={10} fill="#495057" />
          </>
        )}
        {legged && (
          <>
            <rect x={142} y={g.sy - 4} width={56} height={92} rx={10} fill="#5f3dc4" />
            <line x1={158} y1={g.sy + 86} x2={150} y2={GROUND - 4} stroke="#343a40" strokeWidth={12} strokeLinecap="round" />
            <line x1={182} y1={g.sy + 86} x2={190} y2={GROUND - 4} stroke="#343a40" strokeWidth={12} strokeLinecap="round" />
          </>
        )}
      </g>
      {/* アーム */}
      <g {...hot('arm')}>
        {[g, g2].filter(Boolean).map((a, i) => (
          <g key={i} stroke="#343a40" strokeLinecap="round">
            <line x1={a!.sx} y1={a!.sy} x2={a!.ex} y2={a!.ey} strokeWidth={a!.thick} />
            <line x1={a!.ex} y1={a!.ey} x2={a!.wx} y2={a!.wy} strokeWidth={a!.thick * 0.8} />
            <circle cx={a!.sx} cy={a!.sy} r={a!.thick * 0.8} fill="#e8590c" stroke="none" />
            <circle cx={a!.ex} cy={a!.ey} r={a!.thick * 0.6} fill="#e8590c" stroke="none" />
          </g>
        ))}
      </g>
      {/* 手先（手首の力覚センサーはセンサー扱い） */}
      <g {...hot('end_effector')}>
        <rect x={g.wx - 30} y={g.wy - 4} width={60} height={56} fill="transparent" />
        <EffectorShape id={parts.end_effector} x={g.wx} y={g.wy + (parts.sensors.includes('wrist_force_sensor') ? 8 : 0)} />
        {g2 && <EffectorShape id={parts.end_effector} x={g2.wx} y={g2.wy} />}
      </g>
      {/* センサー */}
      <g {...hot('sensor')}>
        {legged ? (
          <circle cx={170} cy={g.sy - 30} r={20} fill="#adb5bd" />
        ) : (
          <rect x={mastX - 3} y={mastTop} width={6} height={g.sy - mastTop + 30} fill="#adb5bd" />
        )}
        {parts.sensors.includes('rgb_camera') && (
          <g><rect x={mastX - 22} y={mastTop - 18} width={22} height={16} rx={3} fill="#343a40" /><circle cx={mastX - 11} cy={mastTop - 10} r={5} fill="#4dabf7" /></g>
        )}
        {parts.sensors.includes('depth_camera') && (
          <g><rect x={mastX + 2} y={mastTop - 16} width={32} height={12} rx={3} fill="#343a40" /><circle cx={mastX + 9} cy={mastTop - 10} r={3.5} fill="#74c0fc" /><circle cx={mastX + 27} cy={mastTop - 10} r={3.5} fill="#74c0fc" /></g>
        )}
        {parts.sensors.includes('wrist_force_sensor') && (
          <rect x={g.wx - 9} y={g.wy} width={18} height={8} rx={2} fill="#f08c00" />
        )}
        {parts.sensors.length === 0 && <text x={mastX} y={mastTop - 6} fontSize={10} textAnchor="middle" fill="#868e96">なし</text>}
      </g>
      {/* 吹き出し（部品名と状態） */}
      {!compact && callouts.map((c) => {
        const s = status[c.k]
        const right = c.tx > 200
        return (
          <g key={c.k} className={`callout ${selected === c.k ? 'is-sel' : ''}`} onClick={() => onPick(c.k)} data-testid={`callout-${c.k}`}>
            <line x1={c.x} y1={c.y} x2={right ? c.tx : c.tx + 86} y2={c.ty + 10} stroke="#adb5bd" strokeDasharray="3 2" pointerEvents="none" />
            <rect x={c.tx} y={c.ty} width={86} height={22} rx={11} className={`co-bg ${s ? STATUS[s].cls : 'st-none'}`} />
            <text x={c.tx + 43} y={c.ty + 15} fontSize={11} textAnchor="middle" className="co-text">
              {locked.includes(c.k) ? '🔒' : s ? STATUS[s].mark : '・'} {SHORT[c.k]}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
