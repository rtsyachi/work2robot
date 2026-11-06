import { useEffect, useMemo, useRef } from 'react'
import { THEME } from '../lib/theme'
import {
  Handle, MarkerType, Position, ReactFlow,
  type Edge, type Node, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from '@dagrejs/dagre'
import type { Level1Graph as L1 } from '../types'
import { ITEM_NODE, level1Edges, type L1Rule } from '../lib/level1'

export type NodeBadge = { text: string; cls: string }
type D = { label: string; type: string; active: boolean; selected: boolean; rules: L1Rule[]; item: boolean; badges: NodeBadge[]; w: number; h: number; tb: boolean }

function L1NodeView({ data }: NodeProps<Node<D, 'l1'>>) {
  const unsupported = data.rules.filter((r) => r.kind === 'unsupported').length
  const rules = data.rules.length - unsupported
  return (
    <div
      className={`l1g-node l1g-${data.type} ${data.active ? 'is-active' : ''} ${data.selected ? 'is-selected' : ''} ${data.item ? 'is-item' : ''}`}
      style={{ width: data.w, height: data.h }}
    >
      <Handle type="target" position={data.tb ? Position.Top : Position.Left} />
      <div className="l1g-label">{data.label}</div>
      <div className="l1g-badges">
        {rules > 0 && <span className="badge badge-info">規則 {rules}</span>}
        {unsupported > 0 && <span className="badge badge-err">未対応 {unsupported}</span>}
        {data.badges.map((b) => <span key={b.text} className={`badge ${b.cls}`}>{b.text}</span>)}
        {data.item && <span className="badge badge-claude">{data.selected ? '▼ 展開中' : '▼ 開く'}</span>}
      </div>
      <Handle type="source" position={data.tb ? Position.Bottom : Position.Right} />
    </div>
  )
}
const nodeTypes = { l1: L1NodeView }

type Props = {
  level1: L1
  rules: Record<string, L1Rule[]>
  activeId: string | null
  selectedId: string | null
  onSelect?: (id: string) => void
  height?: number
  badges?: Record<string, NodeBadge[]>  // ノードごとの追加の印（根拠の種類・仮想実行の対象など）
  nodeSize?: [number, number]
  itemNode?: string | null              // 荷物1個の判断へ進むノード（▼ 開く）
  testId?: string
  direction?: 'LR' | 'TB'               // TB＝上から下へ縦に並べる
}

/** 流れ図（業務全体の工程、工程の詳細、積付の繰り返し）：順序・分岐・繰り返し */
export default function Level1Graph({ level1, rules, activeId, selectedId, onSelect, height = 190, badges = {}, nodeSize = [150, 54],
  itemNode = ITEM_NODE, testId = 'level1-graph', direction = 'LR' }: Props) {
  const [W, H] = nodeSize
  const tb = direction === 'TB'
  const edges0 = useMemo(() => level1Edges(level1), [level1])
  const pos = useMemo(() => {
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: direction, nodesep: 18, ranksep: tb ? 26 : 34 })
    g.setDefaultEdgeLabel(() => ({}))
    level1.nodes.forEach((n) => g.setNode(n.id, { width: W, height: H }))
    edges0.filter((e) => !e.loop).forEach((e) => g.setEdge(e.source, e.target))
    dagre.layout(g)
    return Object.fromEntries(level1.nodes.map((n) => [n.id, { x: g.node(n.id).x - W / 2, y: g.node(n.id).y - H / 2 }]))
  }, [level1, edges0, W, H, direction])
  const box = useRef<HTMLDivElement>(null)
  const flow = useRef<ReactFlowInstance<Node<D, 'l1'>, Edge> | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => flow.current?.fitView({ padding: 0.04 }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const nodes: Node<D, 'l1'>[] = useMemo(() => level1.nodes.map((n) => ({
    id: n.id, type: 'l1', position: pos[n.id], width: W, height: H,
    data: { label: n.label, type: n.type, active: n.id === activeId, selected: n.id === selectedId,
            rules: rules[n.id] ?? [], item: n.id === itemNode, badges: badges[n.id] ?? [], w: W, h: H, tb },
  })), [level1, pos, activeId, selectedId, rules, badges, itemNode, W, H, tb])
  const edges: Edge[] = useMemo(() => edges0.map((e) => ({
    id: e.id, source: e.source, target: e.target, label: e.label || undefined,
    type: e.loop ? 'default' : 'smoothstep', animated: e.loop,
    style: { stroke: e.loop ? THEME.brand : THEME.muted, strokeWidth: e.loop ? 2 : 1.5, strokeDasharray: e.loop ? '6 4' : undefined },
    labelStyle: { fill: e.loop ? THEME.brand : THEME.text2, fontWeight: e.loop ? 700 : 400, fontSize: 11 },
    labelBgStyle: { fill: THEME.panel },
    markerEnd: { type: MarkerType.ArrowClosed, color: e.loop ? THEME.brand : THEME.muted },
  })), [edges0])

  return (
    <div ref={box} className="l1g-box" style={{ height }} data-testid={testId}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        onNodeClick={(_, n) => onSelect?.(n.id)}
        onInit={(inst) => { flow.current = inst; inst.fitView({ padding: 0.04 }) }}
        nodesDraggable={false} nodesConnectable={false} zoomOnScroll={false} panOnDrag={false}
        fitView fitViewOptions={{ padding: 0.04 }} proOptions={{ hideAttribution: true }} minZoom={0.3}
      />
    </div>
  )
}
