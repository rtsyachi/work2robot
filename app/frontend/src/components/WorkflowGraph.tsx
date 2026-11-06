import { useEffect, useMemo, useRef } from 'react'
import { THEME } from '../lib/theme'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Trace, WfNode, Workflow } from '../types'
import { NODE_H, NODE_W, layout, traversed, workflowEdges } from '../lib/graph'
import { NODE_TYPE_LABEL } from '../lib/labels'

type WfNodeData = { wf: WfNode; visited: boolean; dimmed: boolean; selected: boolean }

function WfNodeView({ data }: NodeProps<Node<WfNodeData, 'wf'>>) {
  const n = data.wf
  const unconfirmed = n.definition_status === 'needs_confirmation'
  const provisional = n.provisional === true
  const cls = [
    'wf-node',
    `wf-${n.type}`,
    data.visited ? 'is-visited' : '',
    data.dimmed ? 'is-dimmed' : '',
    data.selected ? 'is-selected' : '',
    unconfirmed || provisional ? 'is-unconfirmed' : '',
  ].join(' ')
  return (
    <div className={cls} style={{ width: NODE_W, height: NODE_H }} data-testid={`node-${n.id}`}>
      <Handle type="target" position={Position.Top} />
      <div className="wf-type">
        {NODE_TYPE_LABEL[n.type]}
        {unconfirmed && <span className="badge badge-warn">要確認</span>}
        {provisional && <span className="badge badge-warn">暫定</span>}
      </div>
      <div className="wf-label">{n.label ?? n.id}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

const nodeTypes = { wf: WfNodeView }

type Props = {
  workflow: Workflow
  trace: Trace | null
  selectedId: string | null
  onSelect: (id: string) => void
}

export default function WorkflowGraph({ workflow, trace, selectedId, onSelect }: Props) {
  const positions = useMemo(() => layout(workflow), [workflow])
  const hit = useMemo(() => traversed(trace), [trace])
  const box = useRef<HTMLDivElement>(null)
  const flow = useRef<ReactFlowInstance<Node<WfNodeData, 'wf'>, Edge> | null>(null)

  // 画面配置が後から変わっても（動画の読み込みなど）、枠の大きさに合わせて全体を表示し直す
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => flow.current?.fitView({ padding: 0.08 }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 再生中は親が毎フレーム再描画されるため、ノード・辺はトレースや選択が変わったときだけ作り直す
  const nodes: Node<WfNodeData, 'wf'>[] = useMemo(() => workflow.nodes.map((n) => ({
    id: n.id,
    type: 'wf',
    position: positions[n.id],
    width: NODE_W,
    height: NODE_H,
    data: {
      wf: n,
      visited: hit.nodes.has(n.id),
      dimmed: trace !== null && !hit.nodes.has(n.id),
      selected: n.id === selectedId,
    },
  })), [workflow, positions, hit, trace, selectedId])

  const edges: Edge[] = useMemo(() => workflowEdges(workflow).map((e) => {
    const on = hit.edges.has(e.id)
    const dim = trace !== null && !on
    const color = on ? THEME.brandStrong : dim ? THEME.lineStrong : THEME.muted
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label || undefined,
      type: 'smoothstep',
      animated: on,
      style: { stroke: color, strokeWidth: on ? 3 : 1.5 },
      labelStyle: { fill: on ? THEME.brandStrong : THEME.text2, fontWeight: on ? 700 : 400 },
      labelBgStyle: { fill: THEME.panel },
      markerEnd: { type: MarkerType.ArrowClosed, color },
      zIndex: on ? 1 : 0,
    }
  }), [workflow, hit, trace])

  return (
    <div ref={box} className="flow-box">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelect(node.id)}
        onInit={(inst) => { flow.current = inst; inst.fitView({ padding: 0.08 }) }}
        nodesDraggable={false}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.08 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
      >
        <Background gap={24} color={THEME.line} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
