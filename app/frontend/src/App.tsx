import { useCallback, useEffect, useMemo, useState } from 'react'
import { checkV2, fetchV2State, runV2 } from './api'
import type { HardwareCheck, HwConfig, ProductConfig, RobotSummary, V2Run, V2State } from './types'
import StepNav, { type StepDef } from './components/StepNav'
import type { SegmentMap } from './components/Evidence'
import MasterStep from './steps/MasterStep'
import AnalysisStep from './steps/AnalysisStep'
import WorkflowStep from './steps/WorkflowStep'
import HardwareStep from './steps/HardwareStep'
import ExecutionStep from './steps/ExecutionStep'
import EvaluationStep from './steps/EvaluationStep'
import { configKey, diffFromDefault, initialConfig, product, toParts } from './lib/hwConfig'

const TITLES: Record<number, string> = { 0: 'マスタ登録', 1: '作業動画解析', 2: 'ワークフロー生成・確認', 3: 'ロボット構成の仮選定', 4: '仮想ロボット実行', 5: '導入前評価' }
const PURPOSE: Record<number, string> = {
  0: '荷物マスタ（寸法・重量・材質など）と環境マスタ（カゴ車・仮置き場・作業エリア）を登録します。以降のステップはすべてこの値を前提に動きます。',
  1: '動画を再生すると、いま人が行っている作業（大タスク・小タスク）と判断理由が右側に切り替わって表示されます。',
  2: '業務全体（Level 1）と荷物1個の判断（Level 2）を確認します。荷物を選ぶと、その荷物が通った経路が光ります。',
  3: '仮想メーカー3社の機種から選び、その機種が認めるオプション（手先・センサーなど）を選ぶと、業務の要求への対応が変わります。',
  4: '選んだ構成で仮想ロボットに業務を実行させます。3D・Level 1・Level 2は同じ実行トレースから動きます。',
  5: '仮想実行の結果と、導入に向けて改善・確認すべきことを整理します。',
}
const NEXT: Record<number, string> = { 0: '作業動画を解析する', 1:'ワークフローを確認する', 2: 'ロボット構成を確認する', 3: 'この構成で仮想実行へ', 4: '導入前評価を見る' }

type Checked = { check: HardwareCheck; profile: RobotSummary; source: 'claude' | 'custom' }

export default function App() {
  const [st, setSt] = useState<V2State | null>(null)
  const [step, setStep] = useState(0)
  const [menu, setMenu] = useState(false)
  // 工程メニューのピン止め（この端末のブラウザに覚えておく）
  const [pinned, setPinnedRaw] = useState(() => { try { return localStorage.getItem('w2r.navPinned') === '1' } catch { return false } })
  const setPinned = (p: boolean) => { setPinnedRaw(p); try { localStorage.setItem('w2r.navPinned', p ? '1' : '0') } catch { /* 保存できなくても動く */ } }
  const [cfg, setCfg] = useState<ProductConfig | null>(null)
  const [batchId, setBatchId] = useState('video_batch')
  const [checks, setChecks] = useState<Record<string, Checked>>({})                     // key = 機種＋オプション
  const [runs, setRuns] = useState<Record<string, { config: HwConfig; run: V2Run }>>({}) // key = 構成|荷物の条件
  const [logicRuns, setLogicRuns] = useState<Record<string, V2Run>>({})                 // 能力の制約なし（Level 2 の荷物別の経路用）
  const [running, setRunning] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchV2State().then((s) => { setSt(s); setCfg(initialConfig(s)) }).catch((e) => setError(String(e)))
  }, [])
  useEffect(() => {
    if (!st || logicRuns[batchId]) return
    runV2(null, batchId).then((r) => setLogicRuns((m) => ({ ...m, [batchId]: r }))).catch((e) => setError(String(e)))
  }, [st, batchId, logicRuns])
  // 構成が変わるたびに、業務要求との照合を取り直す（同じ構成は再利用）
  const ckey = cfg ? configKey(cfg) : ''
  useEffect(() => {
    if (!cfg || checks[ckey]) return
    checkV2(cfg).then((r) => setChecks((m) => ({ ...m, [ckey]: r }))).catch((e) => setError(String(e)))
  }, [cfg, ckey, checks])

  const segments: SegmentMap = useMemo(() => {
    const map: SegmentMap = {}
    const inputs = st?.extraction?.inputs
    inputs?.explanation.segments.forEach((s) => (map[s.id] = { ...s, kind: '説明（音声の文字起こし）' }))
    inputs?.observations.segments.forEach((s) => (map[s.id] = { ...s, kind: '動画で観測' }))
    return map
  }, [st])
  const onPlaying = useCallback((p: boolean) => setPlaying(p), [])
  // マスタを登録したら、状態を取り直し、照合・実行の結果を捨てる（前提が変わったため）
  const onMastersSaved = useCallback(() => {
    fetchV2State().then((s) => {
      setSt(s)
      setChecks({}); setRuns({}); setLogicRuns({})
      setBatchId((b) => (s.batches.some((x) => x.batch_id === b) ? b : s.batches[0]?.batch_id ?? 'video_batch'))
    }).catch((e) => setError(String(e)))
  }, [])

  if (error && !st) return <div className="fatal">{error}</div>
  if (!st || !cfg) return <div className="fatal">読み込み中…</div>

  const prod = product(st.hw_catalog, cfg.product_id)
  const changed = diffFromDefault(st.hw_catalog, cfg).length > 0
  const hw = checks[ckey] ?? null
  const config: HwConfig = {
    config_id: ckey, label: `${prod?.name ?? cfg.product_id}${changed ? '（オプション変更）' : ''}`,
    source: hw?.source === 'claude' ? 'claude' : 'custom', ...toParts(st.hw_catalog, cfg), product_id: cfg.product_id,
  }
  const key = `${ckey}|${batchId}`
  const run = runs[key]?.run ?? null
  const ext = st.extraction
  const otherRun = Object.keys(runs).some((k) => k !== key)
  const sameBatchRuns = Object.entries(runs).filter(([k]) => k.endsWith(`|${batchId}`)).map(([, v]) => v)

  async function doRun() {
    setRunning(true)
    setError(null)
    try {
      const r = await runV2({ ...cfg!, label: config.label }, batchId)
      setRuns((m) => ({ ...m, [key]: { config, run: r } }))
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  const c = hw?.check.counts
  const mv = st.masters.validation
  const steps: StepDef[] = [
    { id: 0, title: TITLES[0], status: !mv.ok ? 'failed' : mv.warnings.length ? 'warn' : 'done', note: `荷物${st.masters.items.items.length}・${st.masters.source === 'registered' ? '登録済み' : '初期値'}` },
    { id: 1, title: TITLES[1], status: st.tasks ? 'done' : ext?.inputs ? 'warn' : 'todo', note: st.tasks ? `大タスク${st.tasks.major_tasks.length}` : undefined },
    { id: 2, title: TITLES[2], status: !ext ? 'todo' : !ext.validation.ok ? 'failed' : ext.confirmation_items.length ? 'warn' : 'done', note: ext ? `確認事項${ext.confirmation_items.length}` : undefined },
    { id: 3, title: TITLES[3], status: !c ? 'todo' : c.ng || c.partial || c.unknown ? 'warn' : 'done', note: c ? `${prod?.name.split(' ')[0] ?? ''}・不足${c.ng}・未確認${c.unknown}` : undefined },
    { id: 4, title: TITLES[4], status: running || playing ? 'running' : run ? (run.job.end.handed_off ? 'warn' : 'done') : otherRun ? 'stale' : 'todo', note: run ? `配置${run.job.end.placed}/${run.job.items.length}` : undefined },
    { id: 5, title: TITLES[5], status: run ? 'done' : otherRun ? 'stale' : 'todo' },
  ]

  return (
    <div className={`shell ${pinned ? 'nav-pinned' : ''}`}>
      <header className="topbar">
        <button className="menu-btn" onClick={() => (pinned ? setPinned(false) : setMenu(!menu))} aria-label="工程メニュー"
          title={pinned ? 'ピン止めを外してメニューを隠す' : '工程メニュー'} data-testid="menu-btn">
          <span /><span /><span />
        </button>
        <img src="/work2robot_logo.png" alt="Work2Robot" className="logo" data-testid="logo" />
        <span className="cur-step" data-testid="cur-step">
          <span className={`step-no-mini st-${steps.find((s) => s.id === step)?.status}`}>{step}</span>{TITLES[step]}
        </span>
        {/* Claudeの保存済み結果がなく手書きの業務定義を表示しているときだけ、その旨を出す */}
        {!ext && <span className="badge badge-info" data-testid="source-badge">{st.notice}</span>}
        <label className="cond">荷物の条件
          <select value={batchId} onChange={(e) => setBatchId(e.target.value)} data-testid="batch">
            {st.batches.map((b) => <option key={b.batch_id} value={b.batch_id}>{b.label}</option>)}
          </select>
        </label>
      </header>
      <StepNav steps={steps} current={step} onGo={setStep} open={menu} onClose={() => setMenu(false)} pinned={pinned} onPin={setPinned} />
      <div className="step-head">
        <span className="step-purpose"><strong>Step {step}：{TITLES[step]}</strong>　{PURPOSE[step]}</span>
        {step === 4 && !run && otherRun && <span className="hint">構成または条件を変えたため、この組み合わせでは未実行です</span>}
        {error && <span className="error inline">{error}</span>}
        {step < 5 && (
          <button className="next-btn" onClick={() => setStep(step + 1)} data-testid="next-step">次へ：{NEXT[step]} →</button>
        )}
      </div>
      <main className="step-body">
        {step === 0 && <MasterStep key={`${st.masters.source}${st.masters.updated_at}`} st={st} onSaved={onMastersSaved} />}
        {step === 1 && <AnalysisStep st={st} />}
        {step === 2 && <WorkflowStep st={st} logicRun={logicRuns[batchId] ?? null} segments={segments} />}
        {step === 3 && (
          <HardwareStep
            st={st} config={cfg} onConfig={setCfg}
            check={hw?.check ?? null} profile={hw?.profile ?? null} source={hw?.source ?? null} run={run}
            segments={segments} onSeek={() => setStep(1)}
          />
        )}
        {step === 4 && <ExecutionStep st={st} run={run} config={config} running={running} onRun={doRun} onPlaying={onPlaying} onGoStep={setStep} />}
        {step === 5 && <EvaluationStep st={st} run={run} config={config} runs={sameBatchRuns} onGoStep={setStep} />}
      </main>
    </div>
  )
}
