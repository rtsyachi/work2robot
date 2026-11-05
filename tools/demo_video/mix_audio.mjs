// 入力動画v2の映像に説明音声（E1〜E6）を合成する。
//   node mix_audio.mjs
// 音声：local_media/voice/E1〜E6（ユーザーの録音。wav/m4a/mp3）が全てあればそれを使い、
//       なければ local_media/voice_provisional/（仮の合成音声）を使って「仮の音声」と記録する。
// 入力：local_media/demo_input_v2/video_only.mp4 と eval_scene_events.json（render:v2 の出力）
// 出力：local_media/demo_input_v2/work_video_v2.mp4 と voice_mix.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const media = path.join(repoRoot, 'local_media');
const dir = path.join(media, 'demo_input_v2');
const events = JSON.parse(fs.readFileSync(path.join(dir, 'eval_scene_events.json'), 'utf8'));
const cues = events.voice_cues;

function findClip(base, id) {
  for (const ext of ['.wav', '.m4a', '.mp3']) {
    const f = path.join(base, id + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
const recorded = cues.map((c) => findClip(path.join(media, 'voice'), c.id));
const useRecorded = recorded.every(Boolean);
const source = useRecorded ? 'user_recording' : 'provisional_tts';
const clips = useRecorded ? recorded : cues.map((c) => findClip(path.join(media, 'voice_provisional'), c.id));
if (clips.some((c) => !c)) throw new Error('音声ファイルが足りません（tts_provisional.ps1 を先に実行）');

const ff = (args) => spawnSync(ffmpegPath, args, { encoding: 'utf8' });
function duration(f) {
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(ff(['-i', f]).stderr);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}

// 前後の無音を切り詰める
const tmp = path.join(dir, 'voice_trimmed');
fs.mkdirSync(tmp, { recursive: true });
const trim = 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse';
const result = cues.map((c, i) => {
  const out = path.join(tmp, `${c.id}.wav`);
  const r = ff(['-y', '-loglevel', 'error', '-i', clips[i], '-af', trim, '-ar', '48000', '-ac', '1', out]);
  if (r.status !== 0) throw new Error(r.stderr);
  const d = duration(out);
  const slot = c.end - c.start;
  return { id: c.id, file: path.relative(repoRoot, clips[i]), start: c.start, duration: d, planned: slot, trimmed: out };
});

const video = path.join(dir, 'video_only.mp4');
const total = duration(video);
const inputs = ['-y', '-loglevel', 'error', '-i', video];
const filters = [];
result.forEach((r, i) => {
  inputs.push('-i', r.trimmed);
  const ms = Math.round(r.start * 1000);
  filters.push(`[${i + 1}:a]adelay=${ms}|${ms}[a${i}]`);
});
filters.push(`${result.map((_, i) => `[a${i}]`).join('')}amix=inputs=${result.length}:normalize=0,apad[aout]`);
const outMp4 = path.join(dir, 'work_video_v2.mp4');
const r = ff([...inputs, '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', String(total), outMp4]);
if (r.status !== 0) throw new Error(r.stderr);

const meta = {
  voice_source: source,
  note: source === 'provisional_tts' ? '仮の音声（Windows標準の音声合成）。ユーザーの録音ではない' : 'ユーザーの録音',
  video_duration: total,
  clips: result.map(({ trimmed, ...x }) => x),
};
fs.writeFileSync(path.join(dir, 'voice_mix.json'), JSON.stringify(meta, null, 2));
for (const x of meta.clips) {
  const warn = x.duration > x.planned + 0.4 ? '  ← 予定より長い（次の台詞・動作と重なる可能性）' : '';
  console.log(`${x.id} start=${x.start.toFixed(1)}s dur=${x.duration.toFixed(2)}s planned=${x.planned.toFixed(2)}s${warn}`);
}
console.log(`voice=${meta.clips.map((x) => `${x.id}:${x.duration.toFixed(1)}`).join(',')}`);
console.log(`source=${source}`);
console.log('wrote', outMp4);
