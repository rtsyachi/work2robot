// 動画の再生位置 → いま表示するタスク・発話。判定はしない（事前に構造化した時間区間と照合するだけ）。
import type { MajorTask, SpeechLink, SubTask, TaskStructure } from '../types'

export type TaskAt = { major: MajorTask | null; sub: SubTask | null; speaking: SpeechLink[] }

const inRange = (t: number, a: number, b: number) => t >= a - 1e-6 && t < b

/** 再生位置 t（秒）にあたる大タスク・小タスク・話している発話。区間の外（隙間）では直前のタスクを保つ */
export function taskAt(ts: TaskStructure, t: number): TaskAt {
  const majors = ts.major_tasks
  let major = majors.find((m) => inRange(t, m.start, m.end)) ?? null
  if (!major) major = [...majors].reverse().find((m) => m.start <= t) ?? majors[0] ?? null
  let sub: SubTask | null = null
  if (major) {
    sub = major.subtasks.find((s) => inRange(t, s.start, s.end)) ?? null
    if (!sub) sub = [...major.subtasks].reverse().find((s) => s.start <= t) ?? major.subtasks[0] ?? null
  }
  const speaking = ts.speech_links.filter((l) => inRange(t, l.start, l.end + 0.3))
  return { major, sub, speaking }
}

/** 大タスクに対応づけた発話（時刻がずれていても、対応づけで結ぶ） */
export function speechOf(ts: TaskStructure, majorId: string): SpeechLink[] {
  return ts.speech_links.filter((l) => l.task_id === majorId)
}

export const RELATION_LABEL: Record<SpeechLink['relation'], string> = {
  during: 'この作業中の説明', before: 'これから行う作業の説明', after: '終わった作業の説明', general: '業務全体の説明',
}
export const KIND_LABEL = { spoken: '作業者の説明', observed: '映像から読み取り', ai_hypothesis: 'Claudeの推定' } as const
export const DEMO_LABEL = { observed: '映像で実演あり', not_observed: '映像では確認できない', unclear: '映像では判別できない' } as const
