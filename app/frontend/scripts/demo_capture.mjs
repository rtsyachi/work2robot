// 提出動画（3分デモ）の素材収録：起動中のアプリを操作し、場面ごとの画面画像（1920×1080）と、
// シミュレーション実行の3D再生のコマ（再生位置を1コマずつ進める）を撮る。Claude API は呼ばない（保存済みの結果を表示するだけ）。
//   npm run demo:capture        出力：<repo>/local_media/demo_build/shots/*.png・frames/*.png・capture.json
// 画面は表示倍率1.25（1536×864 を 1920×1080 で撮る）で、文字を大きめに見せる。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { goStep } from './nav.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.resolve(here, '..', '..', '..', 'local_media', 'demo_build')
const shotsDir = path.join(out, 'shots')
const framesDir = path.join(out, 'frames')
fs.rmSync(shotsDir, { recursive: true, force: true })
fs.rmSync(framesDir, { recursive: true, force: true })
fs.mkdirSync(shotsDir, { recursive: true })
fs.mkdirSync(framesDir, { recursive: true })
const url = process.argv.find((a) => a.startsWith('--url='))?.split('=')[1] ?? 'http://127.0.0.1:5173/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = { shots: [], frames: {}, notes: [] }

const browser = await chromium.launch({ channel: 'msedge', args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
const ctx = await browser.newContext({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 })
const page = await ctx.newPage()
const shot = async (name, note = '') => {
  await sleep(400)
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`) })
  log.shots.push({ name, note })
  console.log('shot', name)
}
await page.goto(url)
await page.waitForSelector('[data-testid=cur-step]')
await page.waitForSelector('[data-testid=page-0] [data-testid=mview-products]')

// ---- S4 紹介・入力：① データ確認（商品マスタ・出荷予定）→ ② シナリオ作成 ----
await shot('s4_products', 'データ確認：商品マスタ（食品卸の模擬データ）')
await page.click('[data-testid=mnode-batches]')
await page.waitForSelector('[data-testid=table-batches]')
await shot('s4_plan', 'データ確認：出荷予定')
await goStep(page, '[data-testid=step-1]')
await page.waitForSelector('[data-testid=sc-workflow]')
await sleep(1200)
await shot('s4_scenario', 'シナリオ作成：シナリオ・マスタ・出荷予定・作業動画・ワークフロー（生成済み）')

// ---- S5 業務理解：③ ワークフロー確認（業務全体 → 積付の工程の Level 1・Level 2 → 根拠と確認事項） ----
await goStep(page, '[data-testid=step-2]')
await page.waitForSelector('[data-testid=stage-graph]')
await shot('s5_overview', 'ワークフロー確認：業務全体（工程の流れ）')
const checks = await page.$$('[data-testid^=stage-check-]')
await checks[1].click()   // 荷物を1個ずつ積む（Level 1 のタスクの流れ）
await page.waitForSelector('[data-testid=level1-graph] .tflow-card')
await shot('s5_level1', '積付の工程：タスクの流れと判断条件（優先度順）')
await page.click('[data-testid=tcard-t_decide]')
await page.waitForSelector('[data-testid=level2]')
// 柔らかいバッグ（S1）を選ぶと、その荷物が通った分岐が光る
const s1 = await page.$('[data-testid=item-chips] >> text=S1')
if (s1) await s1.click()
await page.$eval('[data-testid=level2]', (el) => el.scrollIntoView({ block: 'center' }))
await sleep(1200)
await shot('s5_level2', '荷物1個の判断（Level 2 の分岐）：S1 が通った経路')
await page.click('[data-testid=back-overview]')
await page.waitForSelector('[data-testid=stage-graph]')
await (await page.$$('[data-testid^=stage-check-]'))[0].click()   // 作業準備：Claudeの補完タスク・根拠・確認事項
await page.waitForSelector('[data-testid=pnode-list] .tflow-card')
await page.click('[data-testid=pnode-list] .tflow-card')
await page.waitForSelector('[data-testid=pnode-detail]')
await sleep(800)
await shot('s5_evidence', 'タスクの根拠（AIの推測・動画の場面）と現場への確認事項')
// 確認事項の消込（撮ったら戻す）
const resolve = await page.$('[data-testid=pnode-detail] [data-testid=confirm-resolve]')
if (resolve) {
  await resolve.click()
  await page.waitForSelector('[data-testid=pnode-detail] [data-testid=confirm-undo]')
  await shot('s5_resolved', '確認事項を消込（対応済み）')
  await page.click('[data-testid=pnode-detail] [data-testid=confirm-undo]')
  await page.waitForSelector('[data-testid=pnode-detail] [data-testid=confirm-resolve]')
}

// ---- S6 ロボット構成：Claudeの推奨（HM-2）と業務要件との照合 ----
await goStep(page, '[data-testid=step-3]')
await page.waitForSelector('[data-testid=counts] .h6-count')
await page.click('[data-testid=product-hm_2]')
await sleep(1500)
await shot('s6_hm2', 'ロボット構成：Claudeの推奨 HM-2（★）')
await page.click('[data-testid=eval-toggle]')
await page.waitForSelector('[data-testid=req-payload] .hb')
await sleep(600)
await shot('s6_reqs', '業務要件との照合（対応不可0・判断不可・対応可能）')
await page.click('[data-testid=eval-toggle]')

// ---- S7 シミュレーション実行：Claudeの推奨構成で実行 → 3D再生（再生位置を1コマずつ進める） ----
await goStep(page, '[data-testid=step-4]')
await page.waitForSelector('[data-testid=ex-config]')
const claudeOpt = await page.$$eval('[data-testid=ex-config] option', (os) => os.find((o) => o.textContent.includes('Claudeの仮選定'))?.value)
await page.selectOption('[data-testid=ex-config]', claudeOpt)
await sleep(1200)
await shot('s7_setup', 'シミュレーション実行：実行条件（Claudeの推奨構成）')
await page.click('[data-testid=run-job]')
await page.waitForSelector('[data-testid=ex-running]')
await sleep(700)
await shot('s7_running', '実行中')
await page.waitForSelector('[data-testid=caption-3d]')
if ((await page.textContent('[data-testid=play]')).includes('一時停止')) await page.click('[data-testid=play]')
const slider = '[data-testid=player] input[type=range]'
const duration = Number(await page.getAttribute(slider, 'max'))
const setT = (t) => page.$eval(slider, (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, String(v))
  el.dispatchEvent(new Event('input', { bubbles: true }))
}, t)
// 区間：[再生位置の始め, 終わり, 倍速]。1倍で H1 を持って運ぶ所まで → 4倍で数個 → 終盤を4倍で積み終わりまで
const plan = [[0, 11, 1], [11, 59, 4], [Math.max(59, duration - 20), duration, 4]]
let n = 0
for (const [a, b, speed] of plan) {
  const list = []
  for (let t = a; t <= b + 1e-6; t += speed / 30) list.push(Math.min(t, b))
  for (const t of list) {
    await setT(t)
    await sleep(35)
    await page.screenshot({ path: path.join(framesDir, `s7_${String(n++).padStart(5, '0')}.png`) })
  }
  log.frames[`${a}-${b}x${speed}`] = list.length
}
log.frames.total = n
log.notes.push(`3D再生の長さ ${duration.toFixed(1)}秒`)
await shot('s7_end', '積み終わり')

// ---- S9 シミュレーション評価（Claudeの推奨構成の実行結果） ----
await goStep(page, '[data-testid=step-5]')
await page.waitForSelector('[data-testid=ev-summary]')
await sleep(800)
await shot('s9_summary', 'シミュレーション評価：サマリと主要KPI')
await page.click('[data-testid=tab-issues]')
await page.waitForSelector('[data-testid=ev-issues]')
await sleep(600)
await shot('s9_issues', '課題・改善余地（評価観点・現状と課題・改善案・実機PoC）')

// ---- S8 構成の比較：軽いヒューマノイド（HM-1）では能力が足りない ----
await goStep(page, '[data-testid=step-3]')
await page.waitForSelector('[data-testid=counts] .h6-count')
await page.click('[data-testid=product-hm_1]')
await sleep(1200)
await page.click('[data-testid=eval-toggle]')
await page.waitForSelector('[data-testid=req-payload] .hb')
await sleep(600)
await shot('s8_hm1_reqs', 'HM-1：可搬重量・リーチが不足（重い箱は人へ引継ぎの見込み）')
await page.click('[data-testid=eval-toggle]')
await goStep(page, '[data-testid=step-4]')
const hm1 = await page.$$eval('[data-testid=ex-config] option', (os) => os.find((o) => o.textContent.trim() === 'ヒューマノイド')?.value)
if (hm1) {
  await page.selectOption('[data-testid=ex-config]', hm1)
  await page.waitForSelector('[data-testid=ex-invalid]')
  await sleep(600)
  await shot('s8_hm1_blocked', 'シミュレーション実行：業務要件を満たさないため実行できない')
  await page.selectOption('[data-testid=ex-config]', claudeOpt)   // 選択を推奨構成に戻す
} else log.notes.push('HM-1 の保存済み構成がないため、実行不可の画面は撮っていない')

fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify({ ...log, duration }, null, 2))
await browser.close()
console.log('done', JSON.stringify(log.frames))
