// 荷物マスタのCSV取り込み・書き出し（画面での登録用）。値の検証はバックエンド（masters.validate_masters）が行う。
import type { ItemMasterRow } from '../types'

export const CSV_HEADER = ['object_id', 'name', 'object_type', 'material_class', 'weight_kg', 'width_m', 'depth_m', 'height_m', 'fragile_content', 'handling_note']

const num = (s: string): number | null => {
  const t = s.trim()
  if (!t) return null
  const v = Number(t)
  return Number.isFinite(v) ? v : NaN
}

/** CSV（1行目は見出し）→ 荷物マスタの行。空欄は未登録（null）。解釈できない行は errors に入れる。 */
export function parseItemCsv(text: string): { rows: ItemMasterRow[]; errors: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  const errors: string[] = []
  if (!lines.length) return { rows: [], errors: ['CSVが空です'] }
  const head = lines[0].split(',').map((h) => h.trim())
  const idx = (k: string) => head.indexOf(k)
  if (idx('object_id') < 0) return { rows: [], errors: ['見出しに object_id がありません'] }
  const rows: ItemMasterRow[] = []
  lines.slice(1).forEach((line, n) => {
    const c = line.split(',')
    const get = (k: string) => (idx(k) >= 0 ? (c[idx(k)] ?? '').trim() : '')
    const mat = get('material_class')
    const w = num(get('width_m')), d = num(get('depth_m')), h = num(get('height_m'))
    const fr = get('fragile_content').toLowerCase()
    const weight = num(get('weight_kg'))
    if ([w, d, h, weight].some((v) => Number.isNaN(v))) errors.push(`${n + 2}行目：数値でない値があります`)
    rows.push({
      object_id: get('object_id'),
      name: get('name'),
      object_type: get('object_type'),
      material_class: mat === 'rigid' || mat === 'soft' ? mat : (mat ? (mat as 'rigid') : null),
      weight_kg: Number.isNaN(weight) ? null : weight,
      dims_m: w != null && d != null && h != null && !Number.isNaN(w + d + h) ? [w, d, h] : null,
      fragile_content: fr === 'true' || fr === 'はい' || fr === '1' ? true : fr === 'false' || fr === 'いいえ' || fr === '0' ? false : null,
      handling_note: get('handling_note'),
    })
  })
  return { rows, errors }
}

export function toItemCsv(rows: ItemMasterRow[]): string {
  const cell = (v: unknown) => (v == null ? '' : String(v).replace(/,/g, '、'))
  return [CSV_HEADER.join(','), ...rows.map((r) => [r.object_id, r.name, r.object_type, r.material_class, r.weight_kg,
    r.dims_m?.[0], r.dims_m?.[1], r.dims_m?.[2], r.fragile_content, r.handling_note].map(cell).join(','))].join('\n')
}
