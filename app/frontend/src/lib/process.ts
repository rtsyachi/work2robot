// 工程の構造（Level 1 の工程と、工程ごとの詳細＝Level 2）を画面の流れ図の形にする。判定はしない（表示の整理だけ）。
import type { Evidence, Process, ProcessNode, Stage, V2Job } from '../types'
import { RULE_LABEL } from './level1'

export const BASIS_LABEL: Record<string, string> = {
  video_observation: '動画で観測',
  spoken_instruction: '作業者の説明',
  ai_hypothesis: 'Claudeの補完（根拠なし）',
  human_confirmed: '人が確認',
}
export const ROLE_LABEL: Record<Stage['role'], string> = {
  item_loop: '仮想実行する工程（荷物ごとの繰り返し）',
  final_check: '仮想実行で規則を判定する工程',
  other: '仮想実行の対象外（業務理解として表示）',
}
/** 工程の役割の短い表示 */
export const ROLE_SHORT: Record<Stage['role'], string> = { item_loop: '仮想実行', final_check: '規則を判定', other: '表示のみ' }

/** 工程の構造がない古い版では、積付の繰り返しと終了前の確認の2工程として表示する */
export function stagesOf(process: Process | undefined, job: V2Job): Stage[] {
  if (process?.stages?.length) return process.stages
  const finals = job.rules.filter((r) => r.type === 'overhang_check' || r.type === 'balance_check')
  return [
    { id: 'loading', name: '荷物の積付', purpose: '荷物を1個ずつ取り出し、規則に従ってカゴ車へ積む', role: 'item_loop', basis: 'video_observation',
      source_evidence: [], nodes: [], edges: [] },
    { id: 'final', name: '終了前の確認', purpose: '積み終わったあとに確認する', role: 'final_check', basis: 'spoken_instruction', source_evidence: [],
      nodes: finals.length ? [{ id: 'final_check', type: 'task', label: '積付状態を確認する', detail: '積み終わったカゴ車を確認する',
        criteria: finals.map((r) => ({ name: RULE_LABEL[r.type] ?? r.type, how: r.note ?? '', rule_refs: [r.type], basis: 'spoken_instruction' as const, source_evidence: r.source_evidence })),
        rule_refs: finals.map((r) => r.type), conditions: finals.map((r) => RULE_LABEL[r.type] ?? r.type), basis: 'spoken_instruction', source_evidence: [] }] : [],
      edges: [] },
  ]
}

/** 積付の工程（実行器の固定の流れ）を、業務上のタスクにまとめて見せる（表示だけ。実行器は変えない）。
 *  判断（置き場所があるか・残りがあるか）はノードにせず、タスクの判断条件・分岐・繰り返しとして示す。 */
/** 積付の工程のタスクの判断条件。並び順＝実行器が判断する優先度（job_rules.py の _order・valid・choose の順）。
 *  must＝満たさない置き方はしない（制約）、prefer＝満たせる中で優先する（選好）、logic＝荷物1個の判断の分岐。
 *  rule があれば、使い方は業務の規則の注記（画面で書き換えると規則の注記を直す）。 */
export type LoopCriterion = { name: string; kind: 'must' | 'prefer' | 'logic'; rule?: string; how: string }
export type LoopTask = { id: string; label: string; l1: string[]; detail: string; criteria: LoopCriterion[] }
export const LOOP_DECIDE = 't_decide'
export const LOOP_TASKS: LoopTask[] = [
  { id: 't_select', label: '次に積む荷物を決定する', l1: ['l1_list', 'l1_order'], detail: '荷物一覧から次に積む荷物を決める',
    criteria: [{ name: '上積みの可否', kind: 'must', rule: 'no_stack_last', how: '上に載せられない荷物は最後に回す' },
      { name: '重量', kind: 'prefer', rule: 'order_by_weight_desc', how: '重い荷物から先に積む' }] },
  { id: 't_take', label: '荷物を取り出す', l1: ['l1_take_next'], detail: '仮置き場から荷物を取り出す', criteria: [] },
  { id: LOOP_DECIDE, label: '荷物の配置位置・置き方を決定する', l1: ['l1_item_workflow', 'l1_check_space'], detail: '置き方を決め、カゴ車の空きから置き場所を探す',
    criteria: [{ name: '置き方', kind: 'logic', how: '材質などで置き方を決める（荷物1個の判断）' },
      { name: '積載重量', kind: 'must', rule: 'load_limit', how: '上限を超えるなら置かない' },
      { name: '積付高さ', kind: 'must', rule: 'height_limit', how: '上限を超える位置には置かない' },
      { name: '上積みの可否', kind: 'must', rule: 'no_stack_last', how: '上積み禁止の荷物の上には置かない' },
      { name: '支持面', kind: 'must', rule: 'full_support', how: '底面全体が支えられる位置にだけ置く' },
      { name: '寸法の揃い', kind: 'prefer', rule: 'brick_pattern', how: '同じ寸法の箱はレンガ積みにする' },
      { name: '重さの偏り', kind: 'prefer', rule: 'balance_load', how: '重心の偏りが小さい位置を選ぶ' }] },
  { id: 't_place', label: '荷物を把持・移動・配置する', l1: ['l1_place'], detail: 'Pick → Move → Place', criteria: [] },
  { id: 't_handoff', label: '人へ引き継ぐ', l1: ['l1_handoff'], detail: '持ち上げずに人へ渡す', criteria: [] },
  { id: 't_update', label: '配置結果を確認する', l1: ['l1_update', 'l1_more'], detail: 'カゴ車の状態（個数・重量・重心）を更新する', criteria: [] },
]
export const KIND_LABEL: Record<LoopCriterion['kind'], string> = { must: '必須', prefer: '優先', logic: '分岐' }
export const LOOP_EDGES = [
  { source: 't_select', target: 't_take', label: '' },
  { source: 't_take', target: LOOP_DECIDE, label: '' },
  { source: LOOP_DECIDE, target: 't_place', label: '' },
  { source: LOOP_DECIDE, target: 't_handoff', label: '置き場所がない・能力が足りないとき' },
  { source: 't_place', target: 't_update', label: '' },
  { source: 't_handoff', target: 't_update', label: '' },
  { source: 't_update', target: 't_select', label: '残りの荷物があるとき' },
]

/** タスクの判断条件（古い版で criteria がなければ conditions の「基準：使い方」から作る）。並び順＝優先度 */
export function criteriaOf(n: ProcessNode): { name: string; how: string; rule_refs: string[]; basis?: string; source_evidence?: Evidence[] }[] {
  if (n.criteria) return n.criteria
  return n.conditions.map((c) => {
    const i = c.indexOf('：')
    return i > 0 ? { name: c.slice(0, i), how: c.slice(i + 1), rule_refs: [] } : { name: c, how: c, rule_refs: [] }
  })
}

/** 工程の数字（タスク数・判断条件の数） */
export function stageCounts(stage: Stage): { tasks: number; conds: number } {
  if (stage.role === 'item_loop') return { tasks: LOOP_TASKS.length, conds: LOOP_TASKS.reduce((a, t) => a + t.criteria.length, 0) }
  return { tasks: stage.nodes.length, conds: stage.nodes.reduce((a, n) => a + criteriaOf(n).length, 0) }
}
