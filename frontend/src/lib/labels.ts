// 画面表示用の日本語ラベル。判定ロジックは持たない。
import type { WfNode } from '../types'

export const NODE_TYPE_LABEL: Record<WfNode['type'], string> = {
  start: '開始',
  observe: '観測',
  decision: '判断',
  skill: 'ロボット動作（模擬）',
  handoff: '人へ引継ぎ',
  end: '終了',
}

export const FIELD_LABEL: Record<string, string> = {
  material_class: '材質',
  fragile_content: '壊れ物',
  base_area_m2: '底面積（㎡）',
  weight_kg: '重量（kg）',
  object_type: '荷物の種類',
}

export const EVIDENCE_LABEL: Record<string, string> = {
  video_observation: '動画で観測',
  spoken_instruction: '発話（音声認識）',
  provided_text: '提供された説明テキスト',
  mock_metadata: '模擬荷物マスタ',
  ai_hypothesis: 'AIの推測',
  human_confirmed: '人が確認',
  unknown: '不明',
}

export const RESULT_LABEL: Record<string, string> = {
  true: 'はい',
  false: 'いいえ',
  unknown: '不明',
  placed: '積付完了（仮想）',
  handed_off: '人へ引継ぎ',
}

export const PARAM_LABEL: Record<string, Record<string, string>> = {
  zone: { bottom: '下段', top: '上段' },
  press_mode: { normal: '通常', no_press: '押し込まない' },
}

const OP_SYMBOL: Record<string, string> = { eq: '＝', ge: '≧', lt: '＜' }
const VALUE_LABEL: Record<string, string> = { soft: '柔らかい（soft）', rigid: '硬い（rigid）' }

export function fieldLabel(field?: string): string {
  return field ? FIELD_LABEL[field] ?? field : ''
}

export function formatValue(v: unknown): string {
  if (v === true) return 'はい'
  if (v === false) return 'いいえ'
  if (v === null || v === undefined) return '（未定義）'
  if (typeof v === 'string') return VALUE_LABEL[v] ?? v
  return String(v)
}

export function conditionText(n: WfNode): string {
  if (n.operator === 'is_known') return `${fieldLabel(n.field)} が分かっている`
  const value = n.definition_status === 'needs_confirmation' ? '（基準未定義）' : formatValue(n.value)
  return `${fieldLabel(n.field)} ${OP_SYMBOL[n.operator ?? ''] ?? n.operator} ${value}`
}

export function paramsText(params: Record<string, string>): string {
  return Object.entries(params).map(([k, v]) => PARAM_LABEL[k]?.[v] ?? `${k}=${v}`).join('・')
}
