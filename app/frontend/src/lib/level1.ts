// 業務全体（Level 1）の流れ図と、業務の規則の対応づけ。判定はしない（表示の整理だけ）。
import type { Level1Graph, RuleResult, V2Job } from '../types'

/** 業務の規則が、積付の繰り返し（実行器の固定の流れ）のどのタスクで効くか。実行器の作りで決まる（1つの規則が複数のタスクに効くこともある） */
export const RULE_TO_NODES: Record<string, string[]> = {
  order_by_weight_desc: ['l1_order'],
  no_stack_last: ['l1_order', 'l1_check_space'],
  brick_pattern: ['l1_check_space'],
  balance_load: ['l1_check_space'],
  full_support: ['l1_check_space'],
  load_limit: ['l1_check_space'],
  height_limit: ['l1_check_space'],
  overhang_check: ['l1_final_check'],
  balance_check: ['l1_final_check'],
}
/** 互換：規則の主な工程（1つ目） */
export const RULE_TO_L1: Record<string, string> = Object.fromEntries(Object.entries(RULE_TO_NODES).map(([k, v]) => [k, v[0]]))
/** 業務の規則の一覧（backend/workflow/job_rules.py の SUPPORTED_RULES と同じ） */
export const RULE_LABEL: Record<string, string> = {
  order_by_weight_desc: '重い荷物から先に、下の段から積む',
  no_stack_last: '上積み禁止の荷物は最後に積み、その上には何も置かない',
  brick_pattern: '同じ寸法の箱は、同じ段で縦横を組み合わせて置く（レンガ積み）',
  balance_load: '重心の偏りが小さくなる位置に置く（偏荷重の回避）',
  full_support: '底面全体が下の硬い箱の上面で支えられる位置にだけ置く',
  load_limit: '積載重量の上限を超えない',
  height_limit: '積付高さの上限を超えない',
  overhang_check: '終了前に、はみ出し（オーバーハング）がないか確認する',
  balance_check: '終了前に、重さが偏っていないか確認する',
}
export const UNSUPPORTED_L1 = 'l1_final_check'
export const ITEM_NODE = 'l1_item_workflow'

export const L1_HELP: Record<string, string> = {
  l1_start: '1便分の積付を始める',
  l1_list: '荷物の一覧（模擬の商品・荷姿マスタ）を確認する',
  l1_order: '業務の規則で積む順番を決める',
  l1_take_next: '順番に従って次の荷物を取り出す',
  l1_item_workflow: '荷物1個の判断（Level 2）を実行する。全ての荷物で同じワークフローを使う',
  l1_check_space: 'カゴ車の今の状態から置き場所を探す（配置の規則を適用）',
  l1_place: '基本動作（Pick → Move → Place）で置く',
  l1_handoff: '置き方や置き場所が決まらない、または能力が足りない荷物を人へ引き継ぐ',
  l1_update: 'カゴ車の状態（個数・重量・重心）を更新する',
  l1_more: '残りの荷物があれば繰り返す',
  l1_final_check: '終了前に、はみ出し・重量・重心を確認する',
  l1_end: '積付を終了する',
}

const EDGE_TEXT: Record<string, string> = { placed: '動作が決まった', handed_off: '決まらない', on_true: 'はい', on_false: 'いいえ', next: '' }

export type L1Edge = { id: string; source: string; target: string; label: string; loop: boolean }

/** 規則の方式（v2）で使う辺だけにする（終了前の確認を通る） */
export function level1Edges(g: Level1Graph): L1Edge[] {
  const hasFinal = g.nodes.some((n) => n.id === 'l1_final_check')
  return g.edges
    .filter((e) => !(hasFinal && e.source === 'l1_more' && e.target === 'l1_end'))
    .map((e) => {
      const loop = e.source === 'l1_more' && e.field === 'on_true'
      const label = e.label !== undefined ? e.label
        : e.source === 'l1_more' ? (e.field === 'on_true' ? 'ある：次の荷物へ' : 'ない') : EDGE_TEXT[e.field] ?? ''
      return { id: `${e.source}->${e.target}`, source: e.source, target: e.target, label, loop }
    })
}

export type L1Rule = { kind: 'rule' | 'unsupported'; type: string; label: string; status?: RuleResult['status'] }

/** Level 1 のノードごとに、効いている業務の規則（と実行での適用状況） */
export function rulesByNode(job: V2Job, results: RuleResult[] = []): Record<string, L1Rule[]> {
  const out: Record<string, L1Rule[]> = {}
  for (const r of job.rules) {
    const rr = results.find((x) => x.type === r.type)
    for (const node of RULE_TO_NODES[r.type] ?? []) {
      ;(out[node] ??= []).push({ kind: 'rule', type: r.type, label: rr?.label ?? r.note ?? r.type, status: rr?.status })
    }
  }
  for (const u of job.unsupported_rules) {
    ;(out[UNSUPPORTED_L1] ??= []).push({ kind: 'unsupported', type: 'unsupported', label: u.text, status: 'unsupported' })
  }
  return out
}
