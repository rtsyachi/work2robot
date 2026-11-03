// ワークフロー → 描画用のノード・辺、実行トレース → ハイライト対象。判定はしない（トレースを読むだけ）。
import dagre from '@dagrejs/dagre'
import type { Trace, WfNode, Workflow } from '../types'

export const NODE_W = 200
export const NODE_H = 58

const EDGE_FIELDS: Record<WfNode['type'], string[]> = {
  start: ['next'],
  observe: ['next'],
  decision: ['on_true', 'on_false', 'on_unknown'],
  skill: ['next'],
  handoff: ['next'],
  end: [],
}

export const EDGE_LABEL: Record<string, string> = { next: '', on_true: 'はい', on_false: 'いいえ', on_unknown: '不明' }

export type GraphEdge = { id: string; source: string; target: string; field: string; label: string }

export const edgeId = (from: string, to: string, field: string) => `${from}->${to}:${field}`

export function workflowEdges(wf: Workflow): GraphEdge[] {
  return wf.nodes.flatMap((n) =>
    EDGE_FIELDS[n.type]
      .map((f) => [f, (n as unknown as Record<string, unknown>)[f]] as const)
      .filter((pair): pair is readonly [string, string] => typeof pair[1] === 'string')
      .map(([f, target]) => ({ id: edgeId(n.id, target, f), source: n.id, target, field: f, label: EDGE_LABEL[f] })),
  )
}

export function traversed(trace: Trace | null): { nodes: Set<string>; edges: Set<string> } {
  if (!trace) return { nodes: new Set(), edges: new Set() }
  return {
    nodes: new Set(trace.steps.map((s) => s.node_id)),
    edges: new Set(trace.edges.map((e) => edgeId(e.from, e.to, e.label))),
  }
}

export function layout(wf: Workflow): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 56 })
  g.setDefaultEdgeLabel(() => ({}))
  wf.nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }))
  workflowEdges(wf).forEach((e) => g.setEdge(e.source, e.target))
  dagre.layout(g)
  return Object.fromEntries(
    wf.nodes.map((n) => {
      const p = g.node(n.id)
      return [n.id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 }]
    }),
  )
}
