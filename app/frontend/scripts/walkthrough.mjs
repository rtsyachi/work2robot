// 3分デモのアプリ部分（docs/DEMO.md）を、5ステップの順に自動操作して画面を録る（通し確認用の下書き）。
//   npm run walkthrough:verify   （出力先：<repo>/local_media/demo_walkthrough/walkthrough.mp4）
//   Claude APIは呼ばない（保存済み結果のみ）。ナレーション・導入映像は含まない。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { goStep } from './nav.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(here, '..', '..', '..', 'local_media', 'demo_walkthrough')
const framesDir = path.join(outDir, 'frames')
const urlArg = process.argv.find((a) => a.startsWith('--url='))
const url = urlArg ? urlArg.slice(6) : 'http://127.0.0.1:5173/'
fs.rmSync(framesDir, { recursive: true, force: true })
fs.mkdirSync(framesDir, { recursive: true })
// ffmpeg は動画生成ツール（tools/demo_video）に同梱のものを使う
const ffmpegPath = (await import(path.resolve(here, '..', '..', '..', 'tools', 'demo_video', 'node_modules', 'ffmpeg-static', 'index.js')
  .replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'))).default
let page = null
let frame = 0
// 待つ間も一定間隔で画面を撮る（録画の代わり）
const sleep = async (ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const t = Date.now()
    if (page) await page.screenshot({ path: path.join(framesDir, `f${String(frame++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 80 })
    const rest = 250 - (Date.now() - t)
    if (rest > 0) await new Promise((r) => setTimeout(r, rest))
  }
}

const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
})
const t0 = Date.now()
const marks = []
const mark = (label) => marks.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${label}`)
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  page = await ctx.newPage()
  await page.goto(url)
  await page.waitForSelector('[data-testid=cur-step]')
  mark('② シナリオ作成')
  await page.click('[data-testid=speech-list] li:nth-child(3) button')
  await sleep(9000)
  await goStep(page, '[data-testid=step-2]')
  await page.waitForSelector('[data-testid=chip-H1]')
  mark('③ Level 1 → Level 2、荷物ごとの経路')
  await page.click('[data-testid=chip-H1]')
  await sleep(3000)
  await page.click('[data-testid=chip-S1]')
  await sleep(2500)
  await page.click('[data-testid=level2] .wf-decision')
  const seek = await page.$('[data-testid=node-detail] [data-testid^=seek-S]')
  if (seek) await seek.click()
  mark('③ 判断の根拠（発話・動画）')
  await sleep(6000)
  await page.click('[data-testid=level1-graph] .react-flow__node[data-id=l1_check_space]')
  mark('③ 配置の規則（レンガ積みなど）')
  await sleep(5000)
  await goStep(page, '[data-testid=step-3]')
  mark('④ 必要な能力と推奨構成')
  await sleep(9000)
  await goStep(page, '[data-testid=step-4]')
  await page.click('[data-testid=run-job]')
  mark('⑤ 推奨構成で連続積付（2倍速）')
  await page.click('[data-testid=speed-2]')
  await sleep(26000)
  await page.click('[data-testid=compare]')
  mark('⑤ 人間と比較')
  await sleep(8000)
  await page.click('[data-testid=compare]')
  await page.click('[data-testid=to-end]')
  await sleep(2000)
  await goStep(page, '[data-testid=step-3]')
  await page.click('summary:has-text("比較用の構成を選ぶ")')
  await page.click('[data-testid=config-light_vacuum]')
  mark('④ 比較用の構成（不足が出る）')
  await sleep(4000)
  await goStep(page, '[data-testid=step-4]')
  await page.click('[data-testid=run-job]')
  await page.click('[data-testid=speed-2]')
  mark('⑤ 比較：能力不足で持ち上げない')
  await sleep(12000)
  await goStep(page, '[data-testid=step-5]')
  mark('⑥ シミュレーション評価')
  await sleep(10000)
  mark('終了')
  page = null
  await ctx.close()
} finally {
  await browser.close()
}
const fps = (frame / ((Date.now() - t0) / 1000)).toFixed(3)
const mp4 = path.join(outDir, 'walkthrough.mp4')
const r = spawnSync(ffmpegPath, ['-y', '-loglevel', 'error', '-framerate', fps, '-i', path.join(framesDir, 'f%05d.jpg'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24', mp4], { stdio: 'inherit' })
console.log(r.status === 0 ? `録画: ${mp4}（${frame}枚・約${fps}fps）` : 'ffmpeg に失敗しました')
console.log(marks.join('\n'))
