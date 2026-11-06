// Step 6 の評価指標（決定的な集計だけ。新しい判定はしない）
// タスク：Step 3 の確定ワークフローの工程・タスク。仮想実行した工程（積付の繰り返し・最終確認の規則）だけを達成／未達で判定し、
//        ほかは「未評価」として分母に入れない。荷物：マスタの品名ごとに Step 5 の実行結果を数える。
import type { JobTrace, Stage, TimeEstimate, V2State } from '../types'
import { stagesOf } from './process'

export type TaskStatus = 'done' | 'failed' | 'unevaluated'
export type TaskEval = { stage: string; label: string; status: TaskStatus; note: string }

const LOOP_TASKS = ['l1_list', 'l1_order', 'l1_take_next', 'l1_item_workflow', 'l1_check_space', 'l1_place', 'l1_update', 'l1_more']

/** 終了前の確認の規則が、実行結果で満たされたか（null＝基準がなく判定できない） */
function ruleOk(t: string, job: JobTrace): boolean | null | undefined {
  const c = job.checks
  if (t === 'overhang_check') return c?.overhang.ok
  if (t === 'balance_check') return c?.balance.ok ?? null
  if (t === 'height_limit') return c?.height.ok
  if (t === 'load_limit') return c?.load.ok ?? null
  const rr = job.rule_results?.find((r) => r.type === t)
  return rr ? rr.status === 'applied' : undefined
}

export function evaluateTasks(st: V2State, job: JobTrace): TaskEval[] {
  const stages: Stage[] = stagesOf(st.extraction?.process, st.job)
  const handed = job.items.filter((i) => i.outcome === 'handed_off')
  const capNg = handed.filter((i) => i.capability?.status === 'ng')
  const noSpace = handed.filter((i) => /置き場所|上限|高さ|積載/.test(i.handoff_reason ?? '') && i.capability?.status !== 'ng')
  const label = (id: string) => st.level1.nodes.find((n) => n.id === id)?.label ?? id
  const out: TaskEval[] = []
  for (const s of stages) {
    if (s.role === 'item_loop') {
      for (const id of LOOP_TASKS) {
        const fail = id === 'l1_place' ? handed : id === 'l1_item_workflow' ? capNg : id === 'l1_check_space' ? noSpace : []
        out.push({ stage: s.name, label: label(id), status: fail.length ? 'failed' : 'done',
          note: fail.length ? `${fail.map((i) => i.object_id).join('・')}を人へ引継ぎ` : `${job.items.length}個で完了（仮想実行）` })
      }
    } else if (s.role === 'final_check') {
      for (const n of s.nodes) {
        const oks = n.rule_refs.map((t) => ruleOk(t, job))
        if (n.rule_refs.length === 0 || oks.every((o) => o === undefined)) {
          out.push({ stage: s.name, label: n.label, status: 'unevaluated', note: '実行器では判定しない' })
        } else if (oks.some((o) => o === false)) {
          out.push({ stage: s.name, label: n.label, status: 'failed', note: '終了前の確認で基準を満たさない' })
        } else if (oks.some((o) => o === null)) {
          out.push({ stage: s.name, label: n.label, status: 'unevaluated', note: '基準が未定義で合否を判定しない' })
        } else {
          out.push({ stage: s.name, label: n.label, status: 'done', note: '終了前の確認で満たす（仮想実行）' })
        }
      }
    } else {
      for (const n of s.nodes) out.push({ stage: s.name, label: n.label, status: 'unevaluated', note: '仮想実行の対象外（表示のみの工程）' })
    }
  }
  return out
}

export type ItemTypeEval = { name: string; total: number; placed: number; ids: string[]; reasons: string[] }

/** 荷物の種類（マスタの品名）ごとの処理状況 */
export function evaluateItemTypes(st: V2State, job: JobTrace): ItemTypeEval[] {
  const groups = new Map<string, ItemTypeEval>()
  for (const it of job.items) {
    const name = st.objects.find((o) => o.object_id === it.object_id)?.description || '品名なし'
    const g = groups.get(name) ?? { name, total: 0, placed: 0, ids: [], reasons: [] }
    g.total += 1
    g.ids.push(it.object_id)
    if (it.outcome === 'placed') g.placed += 1
    else if (it.handoff_reason) g.reasons.push(`${it.object_id}：${it.handoff_reason}`)
    groups.set(name, g)
  }
  return [...groups.values()]
}

/** 人の作業時間：入力動画上の作業の始めから終わり（Step 2 の大タスク）。模擬作業動画の時間で、現場の実測ではない */
export function humanSeconds(st: V2State): number | null {
  const m = st.tasks?.major_tasks ?? []
  if (m.length) return Math.max(...m.map((x) => x.end)) - Math.min(...m.map((x) => x.start))
  return st.inputs.video.duration_s ?? null
}

export const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—')
export const mmss = (s: number) => `${Math.floor(s / 60)}分${String(Math.round(s % 60)).padStart(2, '0')}秒`

/** 総合所見（指標と主な課題から決まった文型で作る。Claudeは使わない） */
export function overallComment(p: {
  placed: number; total: number; handed: number; unknownCaps: number; ngCaps: number; undefinedCriteria: number
  robot: TimeEstimate | null | undefined; human: number | null
}): string {
  const parts = [p.handed === 0
    ? `仮想環境では荷物${p.total}個をすべて配置できました。`
    : `仮想環境では荷物${p.total}個のうち${p.placed}個を配置し、${p.handed}個は人へ引き継ぎました。`]
  if (p.ngCaps) parts.push(`構成の仕様が不足する要求が${p.ngCaps}件あります。`)
  const open = [p.unknownCaps ? `未確認の能力${p.unknownCaps}件` : '', p.undefinedCriteria ? `基準が未定義の業務ルール${p.undefinedCriteria}件` : ''].filter(Boolean)
  if (open.length) parts.push(`${open.join('と')}が、導入前に確かめるべき主な事項です。`)
  if (p.robot && p.human) parts.push(`模擬仕様からの推定では、作業時間は人の約${(p.robot.total_s / p.human).toFixed(1)}倍です（参考値）。`)
  return parts.join('')
}
