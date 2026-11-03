// 実画面の動作確認：起動中のアプリ（API + Vite）をヘッドレスEdgeで操作し、スクリーンショットを撮る。
//   npm run screenshot   （出力先：<repo>/local_media/ui_check/）
//   --url= で接続先を変えられる（既定 http://127.0.0.1:5173/。確認用は npm run screenshot:verify）。
//   Claude APIは呼ばない（保存済み結果のみ使う）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(here, '..', '..', 'local_media', 'ui_check')
const urlArg = process.argv.find((a) => a.startsWith('--url='))
const url = urlArg ? urlArg.slice(6) : 'http://127.0.0.1:5173/'
fs.mkdirSync(outDir, { recursive: true })

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(new URL('api/health', url))
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`アプリに接続できません: ${url}`)
}

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok, detail })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await waitForServer()
const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(url)
  await page.waitForSelector('[data-testid=validation]')
  check('検証バッジ', (await page.textContent('[data-testid=validation]')) === '検証OK')
  check('3Dビューの描画', (await page.$$('[data-testid=robot-3d] canvas')).length === 1)

  async function runBatch(batchId) {
    await page.selectOption('[data-testid=batch]', batchId)
    await page.click('[data-testid=run-job]')
    await page.waitForSelector('[data-testid=job-items]')
  }

  // 動画と同じ荷物：途中と最後
  await runBatch('video_batch')
  await sleep(4500)
  await page.screenshot({ path: path.join(outDir, '10_job_video_mid.png') })
  check('実行中の基本動作の表示', (await page.textContent('[data-testid=caption-3d]')).includes('荷物'))
  const video = await page.$eval('[data-testid=work-video]', (v) => ({ t: v.currentTime, paused: v.paused, ready: v.readyState }))
  check('人の動画が仮想ロボットに合わせて再生される', video.ready > 0 && !video.paused && video.t > 0, JSON.stringify(video))
  check('Level 1 のハイライト', (await page.$$('.l1-node.is-active')).length === 1)
  await page.click('[data-testid=to-end]')
  await sleep(500)
  const items = await page.textContent('[data-testid=job-items]')
  check('動画と同じ荷物：AとBが下段、CはAの上、DはCの上', /A.*下段.*B.*下段.*C.*上段（Aの上）.*D.*上段（Cの上）/s.test(items), items)
  check('終了の表示', (await page.textContent('[data-testid=caption-3d]')).includes('積付を終了'))
  await page.screenshot({ path: path.join(outDir, '11_job_video_end.png') })

  // 別の荷物条件：到着順が違い、属性不明のEを含む
  await runBatch('mixed_batch')
  await page.click('[data-testid=to-end]')
  await sleep(500)
  const mixed = await page.textContent('[data-testid=job-items]')
  check('別の荷物条件：Eが暫定動作、DはEの上', /E.*暫定/s.test(mixed) && mixed.includes('Eの上'), mixed)
  await page.waitForSelector('[data-testid=readiness]')
  const rd = await page.textContent('[data-testid=readiness]')
  check('事前評価：Eは人の確認が必要', /E\s*人の確認・引継ぎが必要/.test(rd), rd.slice(0, 300))
  check('事前評価：実機PoC項目', rd.includes('軟質物・袋物の把持'), rd.slice(0, 300))
  await page.screenshot({ path: path.join(outDir, '12_job_mixed_end.png') })
  await page.click('text=判断と根拠')
  await page.click('[data-testid=job-item-E]')
  await page.click('[data-testid=node-place_unknown_provisional]')
  await page.waitForSelector('[data-testid=node-detail]')
  check('荷物Eの判断のハイライト', (await page.$$eval('.wf-node.is-visited', (els) => els.map((e) => e.dataset.testid))).includes('node-place_unknown_provisional'))
  await page.screenshot({ path: path.join(outDir, '13_job_mixed_E.png') })

  // 保存済みのClaude生成ワークフローで同じ業務を実行（Claude APIは呼ばない）
  await page.click('[data-testid=extract-saved]')
  await page.waitForSelector('[data-testid=extraction-panel]')
  check('Claude生成の表示', (await page.textContent('[data-testid=source-badge]')).includes('Claudeが生成'))
  const panel = await page.textContent('[data-testid=extraction-panel]')
  check('動画から作った観測テキストで生成', panel.includes('動画から作った観測テキスト'), panel.slice(0, 200))
  check('業務全体（Level 1）の抽出', panel.includes('下段→上段'), panel.slice(0, 300))
  await runBatch('mixed_batch')
  await page.click('[data-testid=to-end]')
  await sleep(500)
  const claudeItems = await page.textContent('[data-testid=job-items]')
  check('Claude生成のワークフローで全件処理', (claudeItems.match(/上段|下段|人へ引継ぎ/g) ?? []).length === 5, claudeItems)
  await page.screenshot({ path: path.join(outDir, '14_job_claude_mixed.png') })
} finally {
  await browser.close()
}

for (const c of checks) console.log(`${c.ok ? 'OK ' : 'NG '} ${c.name}${c.ok ? '' : `  → ${c.detail}`}`)
if (errors.length) console.log('ブラウザのエラー:\n' + errors.join('\n'))
console.log(`スクリーンショット: ${outDir}`)
process.exit(checks.every((c) => c.ok) && errors.length === 0 ? 0 : 1)
