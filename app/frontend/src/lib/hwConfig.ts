// ロボット構成（仮想メーカーの機種＋その機種が認めるオプション）と、部品と業務要求の関係。照合そのものはバックエンド（/api/v2/check）が行う。
import type { CheckStatus, ConfigParts, HwCatalog, HwComponent, Product, ProductConfig, Requirement, V2State } from '../types'

export type PartKind = 'base' | 'arm' | 'end_effector' | 'sensor' | 'peripheral'
export const PART_TITLE: Record<PartKind, string> = {
  base: '移動方式', arm: 'アーム本体', end_effector: 'エンドエフェクタ', sensor: 'センサー', peripheral: '周辺機器',
}
export const SHORT: Record<PartKind, string> = { base: '移動方式', arm: 'アーム', end_effector: 'エンドエフェクタ', sensor: 'センサー', peripheral: '周辺機器' }
export const TYPE_LABEL: Record<Product['type'], string> = { fixed: '固定式', mobile: '車輪移動式', humanoid: 'ヒューマノイド' }
// 画面の3区分（仕様照合の結果 ok／partial／unknown／ng を、対応可能・対応不可・判断不可にまとめて見せる。照合ロジックは変えない）
export type Verdict = 'can' | 'cannot' | 'unknown'
export const VERDICT_OF: Record<CheckStatus, Verdict> = { ok: 'can', ng: 'cannot', partial: 'unknown', unknown: 'unknown' }
export const VERDICT: Record<Verdict, { text: string; cls: string; mark: string; meaning: string }> = {
  can: { text: '対応可能', cls: 'st-ok', mark: '○', meaning: '現在の構成で、既知の業務要求を仕様上満たす（仕様・模擬条件に基づく評価で、実機での動作成功を保証しない）' },
  cannot: { text: '対応不可', cls: 'st-ng', mark: '×', meaning: '現在の構成では、既知の業務要求を仕様上満たせない' },
  unknown: { text: '判断不可', cls: 'st-unknown', mark: '？', meaning: '仕様情報や検証結果が不足し、対応可否を判断できない（一部の荷物だけ満たす場合を含む）' },
}
export const STATUS: Record<CheckStatus, { text: string; cls: string; mark: string; meaning: string }> = {
  ok: VERDICT.can,
  partial: { ...VERDICT.unknown, meaning: '一部の荷物・場面だけ満たすため、全体としては判断できない' },
  unknown: VERDICT.unknown,
  ng: VERDICT.cannot,
}
const CAP_TO: Record<string, CheckStatus> = { supported: 'ok', partial: 'partial', unverified: 'unknown', unsupported: 'ng' }
const RANK: CheckStatus[] = ['ok', 'partial', 'unknown', 'ng']

export function product(cat: HwCatalog, id: string): Product | undefined {
  return cat.products.find((p) => p.id === id)
}
export function productDefault(p: Product): ProductConfig {
  return { product_id: p.id, ...p.default }
}
/** 機種の固定構造とオプションを合わせた部品の組み合わせ（全身図・要求との関係に使う） */
export function toParts(cat: HwCatalog, c: ProductConfig): ConfigParts {
  const p = product(cat, c.product_id)!
  return { ...p.fixed, end_effector: c.end_effector, sensors: c.sensors, peripherals: c.peripherals }
}
export function configKey(c: ProductConfig): string {
  return JSON.stringify([c.product_id, c.end_effector, [...c.sensors].sort(), [...c.peripherals].sort()])
}
/** 最初に表示する構成：Claudeの仮選定（あれば）、なければ最初の機種の標準構成 */
export function initialConfig(st: V2State): ProductConfig {
  const sel = st.selection?.config
  if (sel?.product_id) return { product_id: sel.product_id, end_effector: sel.end_effector, sensors: sel.sensors, peripherals: sel.peripherals }
  return productDefault(st.hw_catalog.products[0])
}
export function sameConfig(a: ProductConfig, b: ProductConfig): boolean {
  return configKey(a) === configKey(b)
}

export function comp(cat: HwCatalog, kind: PartKind, id: string): HwComponent | undefined {
  return cat.components[kind].find((c) => c.id === id)
}

/** 機種の標準構成からの変更点 */
export function diffFromDefault(cat: HwCatalog, cur: ProductConfig): string[] {
  const p = product(cat, cur.product_id)
  if (!p) return []
  const out: string[] = []
  const name = (k: PartKind, id: string) => comp(cat, k, id)?.label ?? id
  if (p.default.end_effector !== cur.end_effector) out.push(`手先：${name('end_effector', p.default.end_effector)} → ${name('end_effector', cur.end_effector)}`)
  ;([['sensors', 'sensor'], ['peripherals', 'peripheral']] as const).forEach(([key, k]) => {
    cur[key].filter((x) => !p.default[key].includes(x)).forEach((x) => out.push(`${SHORT[k]}を追加：${name(k, x)}`))
    p.default[key].filter((x) => !cur[key].includes(x)).forEach((x) => out.push(`${SHORT[k]}を外す：${name(k, x)}`))
  })
  return out
}

const NUMERIC: Record<string, PartKind[]> = { payload: ['arm', 'end_effector'], object_size: ['end_effector'], reach: ['arm', 'base'] }
type Rel = { req: Requirement; status: CheckStatus | null; note: string }

/** この部品が関わる業務要求と、この部品だけで見たときの状態 */
export function relatedReqs(kind: PartKind, c: HwComponent, reqs: Requirement[]): Rel[] {
  return reqs.flatMap((r): Rel[] => {
    if (r.kind === 'capability') {
      const st = c.capabilities[r.id]
      return st ? [{ req: r, status: CAP_TO[st], note: c.cap_notes?.[r.id] ?? '' }] : []
    }
    if (!NUMERIC[r.id]?.includes(kind)) return []
    const v = Number(r.value)
    if (r.id === 'payload' && kind === 'arm' && c.payload_kg != null) return [{ req: r, status: c.payload_kg >= v ? 'ok' : 'partial', note: `可搬${c.payload_kg}kg` }]
    if (r.id === 'payload' && kind === 'end_effector') return [{ req: r, status: null, note: `手先の重さ${c.mass_kg}kgぶん可搬が減る` }]
    if (r.id === 'object_size' && c.max_object_m != null) return [{ req: r, status: c.max_object_m >= v ? 'ok' : 'partial', note: `つかめる幅${c.max_object_m}m` }]
    if (r.id === 'reach' && kind === 'arm') return [{ req: r, status: null, note: `リーチ${c.reach_m}m` }]
    if (r.id === 'reach' && kind === 'base') return [{ req: r, status: null, note: `肩の高さ${c.shoulder_height_m}m` }]
    return []
  })
}

/** 逆引き：この機種（固定構造＋選べるオプションのどれか）で、ある要求に最もよく対応できる状態 */
export function bestForProduct(cat: HwCatalog, p: Product, req: Requirement): CheckStatus | null {
  const cands: [PartKind, string][] = [['base', p.fixed.base], ['arm', p.fixed.arm],
    ...p.options.end_effector.map((x) => ['end_effector', x] as [PartKind, string]),
    ...p.options.sensors.map((x) => ['sensor', x] as [PartKind, string]),
    ...p.options.peripherals.map((x) => ['peripheral', x] as [PartKind, string])]
  const sts = cands.flatMap(([k, id]) => {
    const c = comp(cat, k, id)
    return c ? relatedReqs(k, c, [req]).map((x) => x.status).filter(Boolean) as CheckStatus[] : []
  })
  if (req.id === 'payload') {
    const arm = comp(cat, 'arm', p.fixed.arm)
    const lightest = Math.min(...p.options.end_effector.map((e) => comp(cat, 'end_effector', e)?.mass_kg ?? 0))
    return (arm?.payload_kg ?? 0) - lightest >= Number(req.value) ? 'ok' : 'partial'
  }
  return RANK.find((s) => sts.includes(s)) ?? (req.kind === 'capability' ? 'ng' : null)
}
