// Step 5（仮想実行）の画面収録：起動中のアプリで構成を選んで実行し、再生位置を一定間隔で進めながら
// 画面を撮って動画にする（ヘッドレスでも動きが飛ばないよう、時刻を指定して1コマずつ撮る）。
//   npm run record:step4                    （Claudeの推奨構成）
//   npm run record:step4 -- --product=aw_40f （Step 4 でその機種を選んでから実行）
//   --fps=10（1秒あたりのコマ数）--speed=2（再生速度の倍率）
//   --from=2 --to=6（再生位置の秒で切り出す）--cam=cart（視点：follow／overview／cart）--out=名前.mp4（出力名）
//   出力：<repo>/local_media/ui_check/step4_<機種>.mp4（tools/demo_video の ffmpeg を使う）。Claude APIは呼ばない。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { goStep } from './nav.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(here, '..', '..', '..', 'local_media', 'ui_check')
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const url = arg('url', 'http://127.0.0.1:5173/')
const productId = arg('product', '')
const fps = Number(arg('fps', '10'))
const speed = Number(arg('speed', '2'))
const from = Number(arg('from', '0'))
const toArg = arg('to', '')
const cam = arg('cam', '')
const outName = arg('out', '')
const tmp = path.join(outDir, 'rec_frames')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })

const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
await page.goto(url)
await page.waitForSelector('[data-testid=cur-step]')
// --name=（構成の名前）：Step 4 でその機種を選び、この名前で構成を確定して、Step 5 でその構成を選ぶ
const configName = decodeURIComponent(arg('name', ''))
if (productId) {
  await goStep(page, '[data-testid=step-3]')
  await page.click(`[data-testid=product-${productId}]`)
  await page.waitForTimeout(1500)
  if (configName) {
    await page.fill('[data-testid=config-name]', configName)
    await page.click('[data-testid=config-save-btn]')
    await page.waitForFunction((n) => document.querySelector('[data-testid=config-save-msg]')?.textContent?.includes(n), configName)
  }
}
await goStep(page, '[data-testid=step-4]')
if (configName) {
  const v = await page.$$eval('[data-testid=ex-config] option', (os, n) => os.find((o) => o.textContent === n)?.value, configName)
  if (v) await page.selectOption('[data-testid=ex-config]', v)
  await page.waitForTimeout(800)
}
await page.click('[data-testid=run-job]')
await page.waitForSelector('[data-testid=caption-3d]')
// 自動再生を止め、再生位置のスライダーで時刻を指定する
if ((await page.textContent('[data-testid=play]')).includes('一時停止')) await page.click('[data-testid=play]')
const slider = '[data-testid=player] input[type=range]'
const duration = Number(await page.getAttribute(slider, 'max'))
const setT = (t) => page.$eval(slider, (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, String(v))
  el.dispatchEvent(new Event('input', { bubbles: true }))
}, t)

if (cam) await page.click(`[data-testid=cam-${cam}]`)
const blocked = !!(await page.$('[data-testid=ex-blocked]'))
const dt = speed / fps
let n = 0
const shot = async () => page.screenshot({ path: path.join(tmp, `f${String(n++).padStart(5, '0')}.png`) })
if (blocked) {
  for (let i = 0; i < fps * 4; i++) { await page.waitForTimeout(80); await shot() } // 要約を4秒見せる
} else {
  const end = toArg ? Math.min(Number(toArg), duration) : duration
  for (let t = from; t <= end + 1e-6; t += dt) {
    await setT(Math.min(t, end))
    await page.waitForTimeout(60)
    await shot()
  }
  for (let i = 0; i < fps * 2; i++) await shot() // 最後の状態を2秒
}
await browser.close()

const name = outName || `step4_${productId || 'recommended'}.mp4`
// 入力動画の制作ツール（tools/demo_video）に入っている ffmpeg を使う。なければ PATH の ffmpeg
const bundled = path.resolve(here, '..', '..', '..', 'tools', 'demo_video', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
const ffmpeg = fs.existsSync(bundled) ? bundled : 'ffmpeg'
const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(tmp, 'f%05d.png'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', path.join(outDir, name)], { stdio: 'inherit' })
if (r.status !== 0) throw new Error('ffmpeg で動画にできませんでした')
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`録画: ${path.join(outDir, name)}（${n}コマ・再生時間 ${duration.toFixed(1)}秒を${speed}倍で）`)
