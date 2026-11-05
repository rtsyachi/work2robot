import { describe, expect, it } from 'vitest'
import type { TaskStructure } from '../types'
import { speechOf, taskAt } from './taskSync'

const ts: TaskStructure = {
  created_at: '', duration: 60, meta: { model: 'm' }, unresolved: [],
  major_tasks: [
    { id: 'T1', name: '準備', purpose: '', obs_ids: ['O1'], start: 0, end: 8, rules: [],
      subtasks: [{ id: 'T1.1', name: '移動', objects: [], obs_ids: ['O1'], start: 0, end: 8 }] },
    { id: 'T2', name: '土台', purpose: '', obs_ids: ['O2', 'O3'], start: 8, end: 40, rules: [],
      subtasks: [
        { id: 'T2.1', name: 'H1を置く', objects: ['H1'], obs_ids: ['O2'], start: 8, end: 15 },
        { id: 'T2.2', name: 'H2を置く', objects: ['H2'], obs_ids: ['O3'], start: 15, end: 40 },
      ] },
  ],
  speech_links: [
    { speech_id: 'S1', task_id: '', relation: 'general', note: '', start: 1, end: 5 },
    { speech_id: 'S2', task_id: 'T2', relation: 'before', note: '', start: 5.5, end: 10 },
  ],
}

describe('taskAt', () => {
  it('再生位置に応じて大タスク・小タスクが切り替わる', () => {
    expect(taskAt(ts, 3).major?.id).toBe('T1')
    expect(taskAt(ts, 9).sub?.id).toBe('T2.1')
    expect(taskAt(ts, 20).sub?.id).toBe('T2.2')
  })
  it('シーク先へ即座に切り替わる（時間を戻しても）', () => {
    expect(taskAt(ts, 30).major?.id).toBe('T2')
    expect(taskAt(ts, 1).major?.id).toBe('T1')
  })
  it('区間の終わりより後では最後のタスクを保つ', () => {
    expect(taskAt(ts, 55).major?.id).toBe('T2')
  })
  it('話している発話と、時刻がずれた発話の対応づけ', () => {
    expect(taskAt(ts, 6).speaking.map((s) => s.speech_id)).toEqual(['S2'])
    expect(taskAt(ts, 6).major?.id).toBe('T1')          // 作業はまだ準備中
    expect(speechOf(ts, 'T2').map((s) => s.speech_id)).toEqual(['S2'])  // 説明は土台づくりに対応
  })
})
