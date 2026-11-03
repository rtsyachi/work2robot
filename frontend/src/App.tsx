import { useEffect, useMemo, useState } from 'react'
import {
  VIDEO_URL,
  extractWithClaude,
  fetchFixtures,
  fetchInputs,
  fetchLatestExtraction,
  fetchLatestObservation,
  fetchReadiness,
  observeVideo,
  runJob,
  validateWorkflow,
} from './api'
import type {
  DemoInputs, DemoObject, Extraction, Fixtures, JobTrace, Observation, Readiness, Segment, TextInput, Validation,
} from './types'
import VideoPane from './components/VideoPane'
import ReadinessPanel from './components/ReadinessPanel'
import { objectRanges, toSeconds } from './lib/videoSync'
import WorkflowGraph from './components/WorkflowGraph'
import NodeDetail from './components/NodeDetail'
import TraceSummary from './components/TraceSummary'
import ExtractionPanel from './components/ExtractionPanel'
import Robot3D from './components/Robot3D'
import Level1Strip from './components/Level1Strip'
import { buildTimeline, sampleTimeline } from './lib/robotTimeline'
import { PARAM_LABEL } from './lib/labels'

type Source = 'fixture' | 'claude'

const KIND_LABEL: Record<string, string> = {
  recognize: '認識（属性を確認）',
  pick: 'Pick（把持）',
  move: 'Move（搬送）',
  place: 'Place（配置）',
  handoff: '人へ引継ぎ',
}
// 基本動作 → Level 1 の流れ図のノード
const KIND_TO_L1: Record<string, string> = {
  recognize: 'l1_item_workflow',
  pick: 'l1_place',
  move: 'l1_place',
  place: 'l1_place',
  handoff: 'l1_handoff',
}

function itemColor(o?: DemoObject): string {
  const a = o?.attributes ?? {}
  if (a.fragile_content?.value === true) return '#7048a8'
  if (a.material_class?.value === 'soft') return '#3f6ea5'
  if (a.material_class?.value === 'rigid') return '#c9a46b'
  return '#adb5bd'
}

export default function App() {
  const [fx, setFx] = useState<Fixtures | null>(null)
  const [inputs, setInputs] = useState<DemoInputs | null>(null)
  const [videoObs, setVideoObs] = useState<Observation | null>(null)
  const [seek, setSeek] = useState<{ t: number; nonce: number } | null>(null)
  const [fixtureValidation, setFixtureValidation] = useState<Validation | null>(null)
  const [extraction, setExtraction] = useState<Extraction | null>(null)
  const [source, setSource] = useState<Source>('fixture')
  const [batchId, setBatchId] = useState('video_batch')
  const [job, setJob] = useState<JobTrace | null>(null)
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [rightTab, setRightTab] = useState<'node' | 'readiness'>('node')
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [pinnedItem, setPinnedItem] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([fetchFixtures(), fetchInputs(), fetchLatestObservation()])
      .then(async ([f, i, o]) => {
        setFx(f)
        setInputs(i)
        setVideoObs(o)
        setFixtureValidation(await validateWorkflow(f.workflow))
      })
      .catch((e) => setError(String(e)))
  }, [])

  const timeline = useMemo(() => (job ? buildTimeline(job) : null), [job])

  useEffect(() => {
    if (!playing || !timeline) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      setT((prev) => {
        const next = Math.min(prev + dt * speed, timeline.duration)
        if (next >= timeline.duration) setPlaying(false)
        return next
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, timeline, speed])

  // 根拠の参照先：Claude生成なら生成に使った入力、それ以外は開発用の入力
  const evidenceInputs = source === 'claude' && extraction?.inputs ? extraction.inputs : inputs
  // 業務の再生が終わったら、自動化の事前評価を表示する
  const jobFinished = !!timeline && t >= timeline.duration
  useEffect(() => {
    if (jobFinished && readiness) setRightTab('readiness')
  }, [jobFinished, readiness])

  const segments = useMemo(() => {
    const map: Record<string, Segment & { kind: string }> = {}
    const obsKind = (o?: TextInput) => (o?.source_type === 'video_observation' ? '動画で観測' : '観測（開発用固定テキスト）')
    evidenceInputs?.explanation.segments.forEach((s) => (map[s.id] = { ...s, kind: '説明' }))
    evidenceInputs?.observations.segments.forEach((s) => (map[s.id] = { ...s, kind: obsKind(evidenceInputs.observations) }))
    return map
  }, [evidenceInputs])
  // 人の動画で、荷物ごとに扱っている区間（動画から作った観測テキストのタグから）
  const videoSegments = (source === 'claude' && extraction?.inputs?.observations.source_type === 'video_observation'
    ? extraction.inputs.observations : videoObs)?.segments ?? []
  const ranges = useMemo(() => objectRanges(videoSegments), [videoSegments])

  if (error && !fx) return <div className="fatal">{error}</div>
  if (!fx) return <div className="fatal">読み込み中…</div>

  const workflow = source === 'claude' && extraction ? extraction.workflow : fx.workflow
  const validation = source === 'claude' && extraction ? extraction.validation : fixtureValidation
  const objects = Object.fromEntries(fx.objects.map((o) => [o.object_id, o]))
  const colors = Object.fromEntries(fx.objects.map((o) => [o.object_id, itemColor(o)]))

  const sample = timeline ? sampleTimeline(timeline, t) : null
  const finished = !!timeline && t >= timeline.duration
  const current = sample?.current?.primitive ?? null
  const shownId = pinnedItem ?? current?.object_id ?? (finished ? job?.order[job.order.length - 1] ?? null : null)
  const shownItem = job?.items.find((i) => i.object_id === shownId) ?? null
  const trace = shownItem?.item_trace ?? null
  const selectedNode = workflow.nodes.find((n) => n.id === selectedId) ?? null
  const step = trace?.steps.find((s) => s.node_id === selectedId) ?? null

  const l1Active = !job ? null : finished ? 'l1_end' : current ? KIND_TO_L1[current.kind] : 'l1_order'
  const doneCount = job ? job.items.filter((i) => sample?.items[i.object_id]?.state === 'placed' || sample?.items[i.object_id]?.state === 'handed_off').length : 0
  const progress = job ? `処理済み ${doneCount}/${job.items.length}${current ? `・作業中：荷物${current.object_id}` : ''}` : ''

  let caption = ''
  if (current) {
    const p = current
    caption = `荷物${p.object_id}：${KIND_LABEL[p.kind]}`
    if (p.kind === 'place') {
      caption += `（${PARAM_LABEL.zone[p.zone ?? ''] ?? p.zone}・${PARAM_LABEL.press_mode[p.press_mode ?? ''] ?? p.press_mode}）`
      if (p.provisional) caption += '【暫定動作】'
    }
    if (p.kind === 'handoff') caption += `：${p.reason}`
  } else if (finished && job) {
    caption = `積付を終了：配置 ${job.end.placed}個・人へ引継ぎ ${job.end.handed_off}個`
  }

  function resetJob() {
    setJob(null)
    setReadiness(null)
    setRightTab('node')
    setT(0)
    setPlaying(false)
    setPinnedItem(null)
    setSelectedId(null)
  }

  function chooseSource(s: Source) {
    setSource(s)
    resetJob()
  }

  async function loadExtraction(live: boolean) {
    setError(null)
    try {
      if (live) {
        setBusy('Claudeが入力動画を解析しています（約30秒）…')
        setVideoObs(await observeVideo())
        setBusy('Claudeがワークフローを生成しています（1〜2分）…')
        setExtraction(await extractWithClaude('video'))
      } else {
        setBusy('保存済みの生成結果を読み込んでいます…')
        setExtraction(await fetchLatestExtraction())
      }
      chooseSource('claude')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  async function startJob() {
    setBusy('業務を実行しています…')
    setError(null)
    try {
      const j = await runJob(workflow, batchId, source === 'claude' && extraction ? extraction.job : undefined)
      setJob(j)
      setRightTab('node')
      setReadiness(await fetchReadiness(workflow, j, source === 'claude' && extraction ? extraction.confirmation_items : []))
      setT(0)
      setPinnedItem(null)
      setPlaying(true)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="app">
      <header>
        <h1>Work2Robot</h1>
        <span className="sub">Human Work → Workflow → Robot Work</span>
        {source === 'claude' && extraction ? (
          <span className="badge badge-claude" data-testid="source-badge">
            Claudeが生成（{extraction.meta.model}・{extraction.source === 'live' ? '今回生成' : '保存済み'}）
          </span>
        ) : (
          <span className="badge badge-info" data-testid="source-badge">{fx.notice}</span>
        )}
        {validation && (
          <span className={`badge ${validation.ok ? 'badge-ok' : 'badge-err'}`} data-testid="validation">
            {validation.ok ? '検証OK' : `検証エラー ${validation.errors.length}件`}
          </span>
        )}
      </header>

      <aside className="left">
        <h2>ワークフローの出どころ</h2>
        <div className="seg">
          <button className={source === 'fixture' ? 'is-active' : ''} onClick={() => chooseSource('fixture')}>
            手書き（テスト用）
          </button>
          <button className={source === 'claude' ? 'is-active' : ''} disabled={!extraction} onClick={() => chooseSource('claude')}>
            Claude生成
          </button>
        </div>
        <button className="secondary" onClick={() => loadExtraction(true)} disabled={!!busy} data-testid="extract-live">
          Claudeでワークフローを生成
        </button>
        <button className="secondary" onClick={() => loadExtraction(false)} disabled={!!busy} data-testid="extract-saved">
          保存済みの生成結果を表示
        </button>

        <h2 className="mt">荷物の条件</h2>
        <select className="batch" value={batchId} onChange={(e) => { setBatchId(e.target.value); resetJob() }} data-testid="batch">
          {fx.batches.map((b) => <option key={b.batch_id} value={b.batch_id}>{b.label}</option>)}
        </select>
        <div className="arrival">到着順：{fx.batches.find((b) => b.batch_id === batchId)?.object_ids.join(' → ')}</div>
        <button className="run" onClick={startJob} disabled={!!busy || !validation?.ok} data-testid="run-job">
          仮想ロボットで業務を実行
        </button>

        {job && timeline && (
          <div className="player">
            <button onClick={() => setPlaying(!playing)} data-testid="play">{playing ? '一時停止' : '再生'}</button>
            <button onClick={() => { setT(0); setPlaying(true) }}>最初から</button>
            <button onClick={() => { setT(timeline.duration); setPlaying(false) }} data-testid="to-end">最後へ</button>
            <button onClick={() => setSpeed(speed === 1 ? 2 : 1)}>{speed}倍速</button>
            <input
              type="range" min={0} max={timeline.duration} step={0.05} value={t}
              onChange={(e) => { setT(Number(e.target.value)); setPlaying(false) }}
            />
          </div>
        )}

        {job && (
          <ol className="job-items" data-testid="job-items">
            {job.items.map((it) => {
              const st = sample?.items[it.object_id]?.state
              return (
                <li
                  key={it.object_id}
                  className={`${it.object_id === shownId ? 'is-shown' : ''} st-${st}`}
                  onClick={() => { setPinnedItem(it.object_id); setPlaying(false) }}
                  data-testid={`job-item-${it.object_id}`}
                >
                  <strong>{it.object_id}</strong> {objects[it.object_id]?.description}
                  <div className="tags">
                    {it.outcome === 'placed'
                      ? <span className="badge badge-ok">{PARAM_LABEL.zone[it.zone ?? '']}{it.placement?.support ? `（${it.placement.support}の上）` : ''}</span>
                      : <span className="badge badge-err">人へ引継ぎ</span>}
                    {it.press_mode === 'no_press' && <span className="badge badge-info">押し込まない</span>}
                    {it.provisional && <span className="badge badge-warn">暫定</span>}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
        {pinnedItem && <button className="link" onClick={() => setPinnedItem(null)}>作業中の荷物の表示に戻す</button>}
        {busy && <div className="busy">{busy}</div>}
        {error && <div className="error">{error}</div>}
        {source === 'claude' && extraction && <ExtractionPanel extraction={extraction} onSelectNode={setSelectedId} />}
      </aside>

      <main className="center">
        <div className="top-row">
          <VideoPane
            src={VIDEO_URL}
            range={current ? ranges[current.object_id] ?? null : null}
            follow={playing}
            missingNote={current && !ranges[current.object_id]
              ? `荷物${current.object_id}は入力動画には映っていません（別の荷物条件）` : null}
            seek={seek}
          />
          <Robot3D job={job} sample={sample} colors={colors} caption={caption} />
        </div>
        <Level1Strip level1={fx.level1} activeId={l1Active} progress={progress} />
        <div className="graph">
          <div className="graph-title">
            {shownItem ? `荷物${shownItem.object_id}の判断（Level 2）` : '荷物1個のワークフロー（Level 2）'}
          </div>
          <WorkflowGraph
            key={`${source}-${extraction?.created_at ?? ''}`}
            workflow={workflow}
            trace={trace}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>
      </main>

      <aside className="right">
        <div className="seg">
          <button className={rightTab === 'node' ? 'is-active' : ''} onClick={() => setRightTab('node')}>判断と根拠</button>
          <button
            className={rightTab === 'readiness' ? 'is-active' : ''}
            disabled={!readiness}
            onClick={() => setRightTab('readiness')}
            data-testid="tab-readiness"
          >
            自動化の事前評価
          </button>
        </div>
        {rightTab === 'readiness' && readiness ? (
          <ReadinessPanel readiness={readiness} />
        ) : (
          <>
            <NodeDetail
              node={selectedNode} step={step} catalog={fx.catalog} segments={segments}
              onSeek={(t) => { setPlaying(false); setSeek({ t: toSeconds(t), nonce: Date.now() }) }}
            />
            {trace && <TraceSummary trace={trace} workflow={workflow} />}
          </>
        )}
      </aside>
    </div>
  )
}
