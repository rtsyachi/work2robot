import { useEffect, useMemo, useRef } from 'react'
import {
  Handle, MarkerType, Position, ReactFlow,
  type Edge, type Node, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from '@dagrejs/dagre'
import type { Level1Graph as L1 } from '../types'
import { ITEM_NODE, level1Edges, type L1Rule } from '../lib/level1'

const W = 150
const H = 54
type D = { label: string; type: string; active: boolean; selected: boolean; rules: L1Rule[]; item: boolean }

function L1NodeView({ data }: NodeProps<Node<D, 'l1'>>) {
  const unsupported = data.rules.filter((r) => r.kind === 'unsupported').length
  const rules = data.rules.length - unsupported
  return (
    <div
      className={`l1g-node l1g-${data.type} ${data.active ? 'is-active' : ''} ${data.selected ? 'is-selected' : ''} ${data.item ? 'is-item' : ''}`}
      style={{ width: W, height: H }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="l1g-label">{data.label}</div>
      <div className="l1g-badges">
        {rules > 0 && <span className="badge badge-info">規則 {rules}</span>}
        {unsupported > 0 && <span className="badge badge-err">未対応 {unsupported}</span>}
        {data.item && <span className="badge badge-claude">{data.selected ? '▼ 展開中' : '▼ 開く'}</span>}
      </div>
      <Handle type="source" position={Position.Right} />
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
}

/** 業務全体（Level 1）：順序・分岐・繰り返し・終了条件の流れ図 */
export default function Level1Graph({ level1, rules, activeId, selectedId, onSelect, height = 190 }: Props) {
  const edges0 = useMemo(() => level1Edges(level1), [level1])
  const pos = useMemo(() => {
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'LR', nodesep: 18, ranksep: 34 })
    g.setDefaultEdgeLabel(() => ({}))
    level1.nodes.forEach((n) => g.setNode(n.id, { width: W, height: H }))
    edges0.filter((e) => !e.loop).forEach((e) => g.setEdge(e.source, e.target))
    dagre.layout(g)
    return Object.fromEntries(level1.nodes.map((n) => [n.id, { x: g.node(n.id).x - W / 2, y: g.node(n.id).y - H / 2 }]))
  }, [level1, edges0])
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
            rules: rules[n.id] ?? [], item: n.id === ITEM_NODE },
  })), [level1, pos, activeId, selectedId, rules])
  const edges: Edge[] = useMemo(() => edges0.map((e) => ({
    id: e.id, source: e.source, target: e.target, label: e.label || undefined,
    type: e.loop ? 'default' : 'smoothstep', animated: e.loop,
    style: { stroke: e.loop ? '#5f3dc4' : '#868e96', strokeWidth: e.loop ? 2 : 1.5, strokeDasharray: e.loop ? '6 4' : undefined },
    labelStyle: { fill: e.loop ? '#5f3dc4' : '#495057', fontWeight: e.loop ? 700 : 400, fontSize: 11 },
    labelBgStyle: { fill: '#ffffff' },
    markerEnd: { type: MarkerType.ArrowClosed, color: e.loop ? '#5f3dc4' : '#868e96' },
  })), [edges0])

  return (
    <div ref={box} className="l1g-box" style={{ height }} data-testid="level1-graph">
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
