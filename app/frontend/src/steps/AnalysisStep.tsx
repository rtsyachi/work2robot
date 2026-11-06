import { useEffect, useRef, useState } from 'react'
import type { AnalysisJob, MasterDef, V2State } from '../types'
import VideoPane from '../components/VideoPane'
import { fetchAnalysis, renameScenario, resetVideo, startAnalysis, uploadVideo } from '../api'
import { fmt } from '../lib/format'

type Status = { text: string; cls: 'is-ok' | 'is-run' | 'is-todo' | 'is-err' }
const OK = (text = '登録済み'): Status => ({ text, cls: 'is-ok' })

/** ② シナリオ作成：左に「シナリオ → マスタ → トランザクション → 作業動画」を縦に並べ、右に作業動画のプレビュー、その下にワークフロー生成と
 *  （生成済みなら）ワークフロー確認・ワークフローID。
 *  マスタ・トランザクションは画面に固定の項目を置かず、データの定義（区分つき）から並べる（別の業務のシナリオでも同じ画面で使う）。
 *  ワークフローの詳細の確認・修正は Step 3 で行う。生成は既存の解析（文字起こし → 観測 → タスク構造 → ワークフロー生成 → 仮選定）を呼ぶ。 */
export default function AnalysisStep({ st, onChanged, batchId, onBatch, onGoStep }: {
  st: V2State; onChanged: () => void; batchId: string; onBatch: (b: string) => void; onGoStep: (n: number) => void
}) {
  const inp = st.inputs
  const m = st.masters
  const [job, setJob] = useState<AnalysisJob>(inp.job)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [editName, setEditName] = useState(false)
  const [name, setName] = useState(st.scenario.name)
  const [addOpen, setAddOpen] = useState<'master' | 'transaction' | null>(null)
  const [form, setForm] = useState(false)   // 生成の確認（補足と費用）を開いているか。押してすぐには課金しない
  const [note, setNote] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const running = job.state === 'running'
  const generated = !!st.extraction && inp.analysis.missing.length === 0

  // 生成中は数秒ごとに状態を確かめ、終わったら（完了・失敗とも）画面のデータを読み直す
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => {
      fetchAnalysis().then((j) => { setJob(j); if (j.state !== 'running') onChanged() }).catch(() => undefined)
    }, 3000)
    return () => window.clearInterval(id)
  }, [running, onChanged])

  const act = (p: Promise<unknown>, after?: () => void) => {
    setBusy(true); setErr(null)
    p.then(() => { after?.(); onChanged() }).catch((e) => setErr(String(e instanceof Error ? e.message : e))).finally(() => setBusy(false))
  }
  const start = () => {
    setBusy(true); setErr(null)
    startAnalysis(note).then((j) => { setJob(j); setForm(false) }).catch((e) => setErr(String(e instanceof Error ? e.message : e))).finally(() => setBusy(false))
  }

  // データの定義から、区分ごとの行を作る（件数・紐づけの状態）
  const src = (d: MasterDef) => ({ items: m.items, environment: m.environment, shipments: m.shipments, shipment_results: m.shipment_results }[d.file]) as unknown as Record<string, unknown>
  const count = (d: MasterDef) => { const x = src(d)?.[d.path]; return d.kind === 'list' ? ((x as unknown[]) ?? []).length : x ? 1 : 0 }
  const PREFIX: Record<string, string[]> = { items: ['item', 'items'], carts: ['cart', 'carts'], batches: ['batch', 'batches'], results: ['result', 'results'] }
  const issues = (d: MasterDef) => [...m.validation.errors, ...m.validation.warnings].filter((e) => (PREFIX[d.table] ?? [d.table]).includes(e.target.split(':')[0])).length
  const dataRows = (cat: 'master' | 'transaction') => m.definitions.filter((d) => d.category === cat && d.kind === 'list').map((d) => {
    const n = count(d)
    const target = d.table === 'batches' ? st.batches.find((b) => b.batch_id === batchId) : null   // シナリオの対象（出荷予定）
    return (
      <li key={d.table} className="sc-data" data-testid={`sc-data-${d.table}`}>
        <span className="sc-data-name">{d.label}</span>
        <span className="sc-data-n">{n}件{d.readonly ? '・参照' : ''}</span>
        {target !== null && target !== undefined ? (
          <select value={batchId} onChange={(e) => onBatch(e.target.value)} disabled={running} className="sc-data-sel" data-testid="scenario-batch" title="このシナリオで使う対象">
            {st.batches.map((b) => <option key={b.batch_id} value={b.batch_id}>対象：{b.label}</option>)}
          </select>
        ) : <span className="sc-data-sel" />}
        <Badge s={n === 0 ? { text: '未登録', cls: 'is-todo' } : issues(d) ? { text: `紐づけ済み・注意${issues(d)}`, cls: 'is-run' } : OK('紐づけ済み')} />
      </li>
    )
  })

  const v = inp.video
  const wfStatus: Status = running ? { text: '生成中', cls: 'is-run' } : job.state === 'error' ? { text: '失敗', cls: 'is-err' } : generated ? OK('生成済み') : { text: '生成前', cls: 'is-todo' }

  return (
    <div className="step-page scenario" data-testid="page-1">
      <section className="sc-left" data-testid="analysis-input">
        <ol className="sc-list">
          {/* ① シナリオ */}
          <li className="sc-item" data-testid="sc-scenario">
            <div className="sc-head"><span className="sc-no">1</span><h3>シナリオ登録</h3><Badge s={OK()} /></div>
            <div className="sc-body">
              {editName ? (
                <span className="sc-inline">
                  <input value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="scenario-name" />
                  <button className="btn-primary" disabled={busy || !name.trim()} onClick={() => act(renameScenario(name.trim()), () => setEditName(false))}>保存</button>
                  <button className="btn-ghost" onClick={() => { setName(st.scenario.name); setEditName(false) }}>キャンセル</button>
                </span>
              ) : (
                <div className="sc-title">{st.scenario.name}<button className="link small" onClick={() => setEditName(true)} data-testid="scenario-rename">名前を変更</button></div>
              )}
              <div className="sc-kv" data-testid="scenario-id">シナリオID：<code>{st.scenario.scenario_id}</code><span className="sc-sub">　業務の種類：カゴ車への混載荷物積付</span></div>
            </div>
          </li>
          {/* ② マスタ・③ トランザクション（定義から並べる汎用の行） */}
          <li className="sc-item" data-testid="sc-master">
            <div className="sc-head"><span className="sc-no">2</span><h3>マスタ登録</h3><button className="link small" onClick={() => onGoStep(0)}>Step 1 で確認</button></div>
            <ul className="sc-data-list">{dataRows('master')}</ul>
            <AddData kind="マスタ" open={addOpen === 'master'} onToggle={() => setAddOpen(addOpen === 'master' ? null : 'master')} tid="add-master" />
          </li>
          <li className="sc-item" data-testid="sc-transaction">
            <div className="sc-head"><span className="sc-no">3</span><h3>トランザクション登録</h3><button className="link small" onClick={() => onGoStep(0)}>Step 1 で確認</button></div>
            <ul className="sc-data-list">{dataRows('transaction')}</ul>
            <AddData kind="トランザクション" open={addOpen === 'transaction'} onToggle={() => setAddOpen(addOpen === 'transaction' ? null : 'transaction')} tid="add-transaction" />
          </li>
          {/* ④ 作業動画 */}
          <li className="sc-item" data-testid="sc-video">
            <div className="sc-head"><span className="sc-no">4</span><h3>作業動画登録</h3><Badge s={v.exists ? OK() : { text: '未登録', cls: 'is-todo' }} /></div>
            <div className="sc-body sc-row">
              <span><strong data-testid="scenario-video">{v.file}</strong><span className="sc-sub">　{v.duration_s ? fmt(Math.floor(v.duration_s)) : '—'}{inp.is_demo ? '・デモ動画' : '・アップロード'}{v.has_audio ? '・説明音声あり' : ''}</span></span>
              <span className="sc-actions">
                <input ref={fileRef} type="file" accept="video/mp4" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) act(uploadVideo(f)); e.target.value = '' }} data-testid="video-file" />
                <button className="btn-ghost" disabled={busy || running} onClick={() => fileRef.current?.click()}>差し替え</button>
                {!inp.is_demo && <button className="link small" disabled={busy || running} onClick={() => act(resetVideo())} data-testid="reset-video">デモ動画に戻す</button>}
              </span>
            </div>
          </li>
        </ol>
        {/* 左の「作業動画」の下：ワークフロー生成 → 生成済みならワークフロー確認（ワークフローID） */}
        <div className="sc-gen" data-testid="sc-workflow">
          <div className="sc-gen-row">
            <button className="btn-primary sc-gen-btn" disabled={busy || running || !v.exists} onClick={() => (form ? start() : setForm(true))} data-testid="start-analysis">
              {running ? '生成中…' : form ? '生成を開始（約$1.5・6〜7分）' : generated ? 'ワークフローを再生成' : 'ワークフローを生成'}
            </button>
            {form && !running && <button className="btn-ghost" onClick={() => setForm(false)} data-testid="gen-cancel">キャンセル</button>}
            <Badge s={wfStatus} />
          </div>
          {form && !running && (
            <div className="sc-gen-form">
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="補足（任意）：未検証の補足としてClaudeに渡します" data-testid="analysis-note" />
              <span className="sc-sub">文字起こし → 動画の観測 → タスク構造 → ワークフロー生成 → ロボットの仮選定（Claude API・課金あり）</span>
            </div>
          )}
          {running && <div className="sc-gen-msg is-run" data-testid="analysis-status">生成中：{job.stage ?? '準備中'}（{job.stages.indexOf(job.stage ?? '') + 1}/{job.stages.length}）… 6〜7分かかります</div>}
          {!running && job.state === 'error' && <div className="ai-status is-error">生成に失敗しました。{job.error}（保存済みの結果は消していません）</div>}
          {err && <div className="ai-status is-error">{err}</div>}

          {generated && !running && (
            <div className="sc-wf" data-testid="sc-workflow-done">
              <button className="btn-primary sc-gen-btn" onClick={() => onGoStep(2)} data-testid="go-workflow">ワークフロー確認 →</button>
              <div className="sc-wf-info">
                <div data-testid="workflow-id">ワークフローID：<code>{(st.refs.workflow_id ?? '').replace(/\.json$/, '')}</code></div>
                <div className="sc-sub" data-testid="analysis-status">✓ 生成済み・工程 {st.extraction?.process?.stages?.length ?? '—'}・確認事項 {st.extraction?.confirmation_items.length ?? 0}件</div>
              </div>
            </div>
          )}
        </div>
      </section>

      <aside className="sc-right" data-testid="sc-preview">
        <div className="sc-prev-head" data-testid="preview-title"><strong>作業動画（プレビュー）</strong><span className="sc-sub">{v.file}{v.duration_s ? `・${fmt(Math.floor(v.duration_s))}` : ''}</span></div>
        <VideoPane key={st.video_url} src={st.video_url} muted={false} range={null} follow={false} missingNote={null} seek={null} title="" />

      </aside>
    </div>
  )
}

/** ＋ 追加：シナリオにデータを追加で紐づけられることを示す。今回は紐づけ先を選ぶ処理はないので、押すとその旨を出すだけ */
function AddData({ kind, open, onToggle, tid }: { kind: string; open: boolean; onToggle: () => void; tid: string }) {
  return (
    <div className="sc-add">
      <button className="sc-add-btn" onClick={onToggle} data-testid={tid}>＋ {kind}を追加</button>
      {open && <span className="sc-sub" data-testid={`${tid}-note`}>今回のシナリオで使う{kind}はすべて紐づけ済みです。別の{kind}の追加は今後対応します（データ自体は Step 1 で確認）。</span>}
    </div>
  )
}

function Badge({ s }: { s: Status }) {
  return <span className={`sc-badge ${s.cls}`}>{s.cls === 'is-ok' ? '✓ ' : ''}{s.text}</span>
}
