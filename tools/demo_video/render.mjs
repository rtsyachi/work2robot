// デモ用模擬作業動画を決定的に描画して mp4 に書き出す。
//   node render.mjs                 … 全フレームを描画して mp4 を出力
//   node render.mjs --still=1,6,14  … 指定秒の静止画だけ出力（構図確認用）
// 出力先：<repo>/local_media/demo_input_proto/（.gitignore 対象）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import ffmpegPath from 'ffmpeg-static';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
// --scene=v2 … シナリオv2（scene_v2.html）。出力は local_media/demo_input_v2/
const sceneArg = process.argv.find((a) => a.startsWith('--scene='));
const sceneName = sceneArg ? sceneArg.slice(8) : 'v1';
const pageFile = sceneName === 'v2' ? 'scene_v2.html' : 'scene.html';
const outDir = path.join(repoRoot, 'local_media', sceneName === 'v2' ? 'demo_input_v2' : 'demo_input_proto');
const stillArg = process.argv.find((a) => a.startsWith('--still='));
const stills = stillArg ? stillArg.slice(8).split(',').map(Number) : null;
const voiceArg = process.argv.find((a) => a.startsWith('--voice='));
const query = voiceArg ? `?voice=${encodeURIComponent(voiceArg.slice(8))}` : '';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(here, rel === '/' ? pageFile : rel);
  if (!file.startsWith(here) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/${query}`;

const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => console.log('[page]', m.text()));
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.W2R_READY === true, null, { timeout: 60000 });
  const { duration, fps, events } = await page.evaluate(() => ({ duration: W2R.duration, fps: W2R.fps, events: W2R.events }));
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`duration=${duration.toFixed(2)}s fps=${fps}`);
  console.log(JSON.stringify(events));

  if (stills) {
    for (const s of stills) {
      await page.evaluate((t) => W2R.renderFrame(t), s);
      const f = path.join(outDir, `still_${String(s).replace('.', '_')}s.png`);
      await page.screenshot({ path: f });
      console.log('wrote', f);
    }
  } else {
    const framesDir = path.join(outDir, 'frames');
    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.mkdirSync(framesDir, { recursive: true });
    const n = Math.ceil(duration * fps);
    for (let i = 0; i <= n; i++) {
      await page.evaluate((t) => W2R.renderFrame(t), i / fps);
      await page.screenshot({ path: path.join(framesDir, `f${String(i).padStart(5, '0')}.png`) });
      if (i % 48 === 0) console.log(`frame ${i}/${n}`);
    }
    const mp4 = path.join(outDir, sceneName === 'v2' ? 'video_only.mp4' : 'demo_input_proto.mp4');
    const r = spawnSync(ffmpegPath, ['-y', '-loglevel', 'error', '-framerate', String(fps),
      '-i', path.join(framesDir, 'f%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', mp4], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('ffmpeg failed');
    // 場面の時刻は評価用データ。アプリ入力とは別のファイル名で保存する
    fs.writeFileSync(path.join(outDir, 'eval_scene_events.json'), JSON.stringify(events, null, 2));
    console.log('wrote', mp4);
  }
} finally {
  await browser.close();
  server.close();
}
