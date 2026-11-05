import { useCallback, useMemo, useState } from 'react'
import type { Segment, TaskRule, V2State } from '../types'
import VideoPane from '../components/VideoPane'
import { toSeconds } from '../lib/videoSync'
import { DEMO_LABEL, KIND_LABEL, RELATION_LABEL, speechOf, taskAt } from '../lib/taskSync'
import { fmt } from '../lib/format'

/** ① 作業動画解析：動画の再生位置に合わせて、Claudeが解釈した大タスク・小タスク・判断理由を切り替える */
export default function AnalysisStep({ st }: { st: V2State }) {
  const inputs = st.extraction?.inputs
  const ts = st.tasks
  const [seek, setSeek] = useState<{ t: number; nonce: number } | null>(null)
  const [now, setNow] = useState({ t: 0, d: 0 })
  const [logOpen, setLogOpen] = useState(false)
  const onTime = useCallback((t: number, d: number) => setNow({ t, d }), [])
  const goSec = (t: number) => setSeek({ t: t + 0.05, nonce: Date.now() })
  const go = (ts0: string) => goSec(toSeconds(ts0))
  const speech = inputs?.explanation.segments ?? []
  const obs = inputs?.observations.segments ?? []
  const obsById = useMemo(() => Object.fromEntries(obs.map((o) => [o.id, o])), [obs])
  const spById = useMemo(() => Object.fromEntries(speech.map((s) => [s.id, s])), [speech])
  const dur = now.d || ts?.duration || 120
  const cur = ts ? taskAt(ts, now.t) : null
  const major = cur?.major ?? null
  const speakingIds = new Set(cur?.speaking.map((s) => s.speech_id) ?? [])
  const majorSpeech = ts && major ? speechOf(ts, major.id) : []
  const unresolved = ts && major
    ? ts.unresolved.filter((u) => u.obs_ids.some((o) => major.obs_ids.includes(o)) || u.speech_ids.some((s) => majorSpeech.some((l) => l.speech_id === s)))
    : []
  const isSpeaking = (r: TaskRule) => r.speech_ids.some((s) => speakingIds.has(s))

  const segLine = (s: Segment | undefined, kind: string) => s && (
    <li key={s.id}><button className="link" onClick={() => go(s.t)}>{s.id}・{s.t}</button> <span className="muted small">{kind}</span> {s.text}</li>
  )

  return (
    <div className="step-page analysis" data-testid="page-1">
      <div className="an-video">
        <VideoPane
          src={st.video_url} muted={false} range={null} follow={false} missingNote={null} seek={seek} onTime={onTime}
          title="人の作業（入力動画：プログラム生成の模擬作業動画＋作業者の説明音声）"
        />
        <div className="an-timeline" data-testid="timeline">
          {ts ? (
            <>
              <div className="mt-bar" data-testid="major-timeline">
                {ts.major_tasks.map((m) => (
                  <button
                    key={m.id} className={`mt-seg ${m.id === major?.id ? 'is-on' : ''}`}
                    style={{ left: `${(m.start / dur) * 100}%`, width: `${((m.end - m.start) / dur) * 100}%` }}
                    onClick={() => goSec(m.start)} title={`${m.name}（${fmt(m.start)}–${fmt(m.end)}）`} data-testid={`major-${m.id}`}
                  >{m.name}</button>
                ))}
                <div className="tl-now" style={{ left: `${(now.t / dur) * 100}%` }} />
              </div>
              <div className="tl-row"><span className="tl-name">説明</span>
                <div className="tl-bar">
                  {ts.speech_links.map((l) => (
                    <button key={l.speech_id} className={`tl-mark tl-s ${speakingIds.has(l.speech_id) ? 'is-on' : ''}`}
                      style={{ left: `${(l.start / dur) * 100}%` }} onClick={() => goSec(l.start)}
                      title={spById[l.speech_id]?.text}>{l.speech_id}</button>
                  ))}
                  <div className="tl-now" style={{ left: `${(now.t / dur) * 100}%` }} />
                </div>
              </div>
            </>
          ) : <div className="muted small">タスク構造がまだありません（scripts/run_task_structure.py で作成）。</div>}
          <div className="muted small">
            大タスクを選ぶとその場面へ移動します。タスクと判断理由は、事前に保存したClaudeの解析結果（{ts?.meta.model ?? '—'}）と再生位置を照合して表示しています。時刻はすべて元動画の時間軸。
          </div>
        </div>
      </div>

      <div className="an-side" data-testid="task-panel">
        {ts && major ? (
          <>
            <section className="tk-card tk-major" data-testid="cur-major">
              <div className="tk-k">① 大タスク（{ts.major_tasks.findIndex((m) => m.id === major.id) + 1}/{ts.major_tasks.length}）<span className="muted">　{fmt(major.start)}–{fmt(major.end)}</span></div>
              <div className="tk-title">{major.name}</div>
              <div className="small">{major.purpose}</div>
            </section>
            <section className="tk-card tk-sub" data-testid="cur-sub">
              <div className="tk-k">② 小タスク{cur?.sub && <span className="muted">　{fmt(cur.sub.start)}–{fmt(cur.sub.end)}</span>}</div>
              <div className="tk-title2">{cur?.sub?.name ?? '—'}</div>
              {cur?.sub && cur.sub.objects.length > 0 && <div className="small">対象：{cur.sub.objects.map((o) => <span key={o} className="chip static">{o}</span>)}</div>}
              <div className="sub-dots">
                {major.subtasks.map((s) => (
                  <button key={s.id} className={`dot ${s.id === cur?.sub?.id ? 'is-on' : ''}`} onClick={() => goSec(s.start)} title={s.name}>{s.id.split('.')[1]}</button>
                ))}
              </div>
            </section>
            <section className="tk-card tk-rules" data-testid="cur-rules">
              <div className="tk-k">③ 判断条件・作業ルール</div>
              {cur && cur.speaking.length > 0 && (
                <div className="speaking" data-testid="speaking">
                  🗣 いま説明中：「{cur.speaking.map((s) => spById[s.speech_id]?.text).join(' ')}」
                  {cur.speaking.some((s) => s.task_id && s.task_id !== major.id) && (
                    <span className="muted small">（{cur.speaking.map((s) => RELATION_LABEL[s.relation]).join('・')}）</span>
                  )}
                </div>
              )}
              {major.rules.length === 0 && <div className="muted small">この作業に対応づけた判断条件はありません。</div>}
              {major.rules.map((r) => (
                <div key={r.id} className={`tk-rule k-${r.kind} ${isSpeaking(r) ? 'is-speaking' : ''}`} data-testid={`rule-${r.id}`}>
                  <div>{r.text}</div>
                  <div className="tk-badges">
                    <span className={`badge kb-${r.kind}`}>{KIND_LABEL[r.kind]}</span>
                    <span className={`badge ${r.demonstrated === 'observed' ? 'badge-ok' : 'badge-warn'}`}>{DEMO_LABEL[r.demonstrated]}</span>
                    {r.definition_status === 'needs_confirmation' && <span className="badge badge-warn" title={r.confirmation_note}>基準は要確認</span>}
                  </div>
                  {r.definition_status === 'needs_confirmation' && r.confirmation_note && <div className="muted small">要確認：{r.confirmation_note}</div>}
                </div>
              ))}
            </section>
            <details className="tk-card" data-testid="cur-evidence">
              <summary>④ 判断根拠（観測 {cur?.sub?.obs_ids.length ?? 0}件・発話 {majorSpeech.length}件）</summary>
              <h4>この小タスクの動画観測</h4>
              <ul className="segs">{cur?.sub?.obs_ids.map((id) => segLine(obsById[id], '動画で観測'))}</ul>
              <h4>この大タスクに対応する説明</h4>
              <ul className="segs">
                {majorSpeech.map((l) => (
                  <li key={l.speech_id}>
                    <button className="link" onClick={() => goSec(l.start)}>{l.speech_id}・{fmt(l.start)}</button>{' '}
                    <span className="muted small">{RELATION_LABEL[l.relation]}</span> {spById[l.speech_id]?.text}
                    {l.note && <div className="muted small">{l.note}</div>}
                  </li>
                ))}
                {majorSpeech.length === 0 && <li className="muted small">対応する説明はありません（映像だけで示された作業）。</li>}
              </ul>
              <h4>ルールの根拠</h4>
              <ul className="small">{major.rules.map((r) => <li key={r.id}>{r.text}：発話 {r.speech_ids.join(', ') || 'なし'}／観測 {r.obs_ids.join(', ') || 'なし'}</li>)}</ul>
            </details>
            {unresolved.length > 0 && (
              <details className="tk-card tk-unresolved" data-testid="cur-unresolved">
                <summary>確認できなかったこと・説明と映像の食い違い（{unresolved.length}件）</summary>
                <ul className="small">{unresolved.map((u) => <li key={u.text}>{u.text}<span className="muted">（{[...u.obs_ids, ...u.speech_ids].join(', ')}）</span></li>)}</ul>
              </details>
            )}
          </>
        ) : <p className="muted">タスク構造がまだありません。</p>}
        <button className="link log-btn" onClick={() => setLogOpen(!logOpen)} data-testid="open-log">{logOpen ? '詳細ログを閉じる' : '詳細ログ（文字起こし全文・観測ログ）を表示'}</button>
        {logOpen && (
          <div className="log-panel" data-testid="log-panel">
            <h4>文字起こし全文（{speech.length}件）</h4>
            <ul className="segs" data-testid="speech-list">{speech.map((s) => segLine(s, '発話'))}</ul>
            <h4>動画の観測ログ（Claude・{obs.length}件）</h4>
            <ul className="segs" data-testid="obs-list">{obs.map((s) => segLine(s, ''))}</ul>
            {(inputs?.observations.uncertain ?? []).length > 0 && (
              <>
                <h4>観測で判断できなかったこと</h4>
                <ul className="small">{inputs!.observations.uncertain!.map((u) => <li key={u}>{u}</li>)}</ul>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
