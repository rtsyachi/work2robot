import { describe, expect, it } from 'vitest'
import fixture from '../../../data/workflow_fixture.json'
import type { Trace, Workflow } from '../types'
import { edgeId, layout, traversed, workflowEdges } from './graph'
import { conditionText } from './labels'

const wf = fixture as Workflow

describe('workflowEdges', () => {
  it('全ての遷移を辺にする（判断ノードは はい/いいえ/不明 の3本）', () => {
    const edges = workflowEdges(wf)
    const count = (t: string) => wf.nodes.filter((n) => n.type === t).length
    expect(count('decision')).toBe(4)
    // start 1 + observe 1 + decision 4×3 + skill 6（うち暫定3）
    expect(count('skill')).toBe(6)
    expect(edges).toHaveLength(20)
    const heavy = edges.filter((e) => e.source === 'is_heavy').map((e) => e.label)
    expect(heavy.sort()).toEqual(['いいえ', 'はい', '不明'].sort())
  })
})

describe('traversed', () => {
  it('トレースの通過ノードと辺だけをハイライト対象にする', () => {
    const trace = {
      steps: [{ node_id: 'is_fragile' }, { node_id: 'place_top_gentle' }],
      edges: [{ from: 'is_fragile', to: 'place_top_gentle', label: 'on_true' }],
    } as unknown as Trace
    const t = traversed(trace)
    expect([...t.nodes]).toEqual(['is_fragile', 'place_top_gentle'])
    expect(t.edges.has(edgeId('is_fragile', 'place_top_gentle', 'on_true'))).toBe(true)
    const ids = new Set(workflowEdges(wf).map((e) => e.id))
    expect([...t.edges].every((id) => ids.has(id))).toBe(true)
  })

  it('トレースがなければ何も光らせない', () => {
    expect(traversed(null).nodes.size).toBe(0)
  })
})

describe('layout', () => {
  it('全ノードに座標を付け、開始ノードを最上段に置く', () => {
    const pos = layout(wf)
    expect(Object.keys(pos)).toHaveLength(wf.nodes.length)
    const minY = Math.min(...Object.values(pos).map((p) => p.y))
    expect(pos.start.y).toBe(minY)
  })
})

describe('conditionText', () => {
  it('要確認の条件は閾値を表示しない', () => {
    const heavy = wf.nodes.find((n) => n.id === 'is_heavy')!
    expect(conditionText(heavy)).toBe('重量（kg） ≧ （基準未定義）')
    const large = wf.nodes.find((n) => n.id === 'is_large')!
    expect(conditionText(large)).toBe('底面積（㎡） ≧ 0.15')
  })
})
