import { useCallback, useEffect, useMemo, useState } from 'react'
import { checkV2, fetchLatestExecution, fetchRobotConfigs, fetchV2State, runV2, setScenarioBatch } from './api'
import type { HardwareCheck, HwConfig, ProductConfig, RobotSummary, SavedRobotConfig, V2Run, V2State } from './types'
import StepNav, { type StepDef } from './components/StepNav'
import type { SegmentMap } from './components/Evidence'
import MasterStep, { AnalysisMismatch } from './steps/MasterStep'
import AnalysisStep from './steps/AnalysisStep'
import StaleSelection from './components/StaleSelection'
import WorkflowStep from './steps/WorkflowStep'
import HardwareStep from './steps/HardwareStep'
import ExecutionStep, { RUN_MIN_MS } from './steps/ExecutionStep'
import EvaluationStep from './steps/EvaluationStep'
import { configKey, initialConfig, product, toParts } from './lib/hwConfig'

const TITLES: Record<number, string> = { 0: 'データ確認', 1: 'シナリオ作成', 2: 'ワークフロー確認', 3: 'ロボット構成', 4: 'シミュレーション実行', 5: 'シミュレーション評価' }
// 画面名の横に出す、その画面で行うことの一言
const SUBTITLES: Record<number, string> = {
  0: '商品・カゴ車・出荷予定など、前提となるデータを確認・修正する',
  1: '業務シナリオに作業動画と出荷予定を紐づけ、ワークフローを生成する',
  2: '生成されたワークフローの工程・タスク・判断条件を確認・修正する',
  3: '業務要件を満たすロボットの機種と部品を選び、構成を確定する',
  4: '選んだ構成で業務を仮想実行し、ロボットの動作を3Dで確認する',
  5: 'シミュレーション結果から、達成状況・効果見通し・残存課題を評価する',
}
// 表示上のステップ番号は 1 始まり（内部の step は 0〜5 のまま）
const NO = (step: number) => step + 1

type Checked = { check: HardwareCheck; profile: RobotSummary; source: 'claude' | 'custom' }

export default function App() {
  const [st, setSt] = useState<V2State | null>(null)
  const [step, setStep] = useState(0)
  const [menu, setMenu] = useState(false)
  // 工程メニューのピン止め（この端末のブラウザに覚えておく）
  // 初期はピン止め（左に常に表示）。外した設定だけブラウザに覚える
  const [pinned, setPinnedRaw] = useState(() => { try { return localStorage.getItem('w2r.navPinned') !== '0' } catch { return true } })
  const setPinned = (p: boolean) => { setPinnedRaw(p); try { localStorage.setItem('w2r.navPinned', p ? '1' : '0') } catch { /* 保存できなくても動く */ } }
  const [cfg, setCfg] = useState<ProductConfig | null>(null)
  const [batchId, setBatchId] = useState('video_batch')
  const [checks, setChecks] = useState<Record<string, Checked>>({})                     // key = 機種＋オプション
  const [runs, setRuns] = useState<Record<string, { config: HwConfig; run: V2Run }>>({}) // key = 構成|荷物の条件
  const [logicRuns, setLogicRuns] = useState<Record<string, V2Run>>({})                 // 能力の制約なし（Level 2 の荷物別の経路用）
  const [running, setRunning] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<SavedRobotConfig[]>([])   // 保存したロボット構成（Step 4 で保存 → Step 5 で選ぶ）
  const [execId, setExecId] = useState<string | null>(null)     // Step 5 で選んだ構成

  const loadSaved = useCallback((select?: string) => {
    fetchRobotConfigs().then((list) => {
      setSaved(list)
      setExecId((cur) => select ?? (cur && list.some((c) => c.id === cur) ? cur : list[0]?.id ?? null))
    }).catch((e) => setError(String(e)))
  }, [])
  useEffect(() => {
    fetchV2State().then((s) => { setSt(s); setCfg(initialConfig(s)); setBatchId(s.refs.batch_id) }).catch((e) => setError(String(e)))
    loadSaved()
  }, [loadSaved])
  useEffect(() => {
    if (!st || logicRuns[batchId]) return
    runV2(null, batchId).then((r) => setLogicRuns((m) => ({ ...m, [batchId]: r }))).catch((e) => setError(String(e)))
  }, [st, batchId, logicRuns])
  // 構成または出荷予定が変わるたびに、業務要件との照合を取り直す（同じ組み合わせは再利用）。Step 4 と Step 5 で同じ照合を使う
  const ckey = cfg ? `${configKey(cfg)}|${batchId}` : ''
  useEffect(() => {
    if (!cfg || checks[ckey]) return
    checkV2(cfg, batchId).then((r) => setChecks((m) => ({ ...m, [ckey]: r }))).catch((e) => setError(String(e)))
  }, [cfg, ckey, checks, batchId])
  const exec0 = saved.find((c) => c.id === execId) ?? null
  const ekey = exec0 ? `${configKey(exec0.config)}|${batchId}` : ''
  useEffect(() => {
    if (!exec0 || checks[ekey]) return
    checkV2(exec0.config, batchId).then((r) => setChecks((m) => ({ ...m, [ekey]: r }))).catch((e) => setError(String(e)))
  }, [exec0, ekey, checks, batchId])
  // 保存済みの実行結果があれば読み込む（再読み込みしても Step 5・6 で参照できる）
  const [tried, setTried] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (!exec0 || !ekey || runs[ekey] || tried[ekey] || !st) return
    setTried((m) => ({ ...m, [ekey]: true }))
    fetchLatestExecution(exec0.id, batchId).then((r) => {
      if (!r) return
      const hc: HwConfig = { config_id: configKey(exec0.config), label: exec0.name, source: exec0.source === 'claude' ? 'claude' : 'custom',
        ...toParts(st.hw_catalog, exec0.config), product_id: exec0.config.product_id }
      setRuns((m) => (m[ekey] ? m : { ...m, [ekey]: { config: hc, run: r } }))
    }).catch(() => undefined)
  }, [exec0, ekey, runs, tried, batchId, st])
  // 出荷予定（シナリオの対象）を変える：シナリオに記録し、業務要件を取り直す
  const changeBatch = (b: string) => {
    setBatchId(b)
    setScenarioBatch(b).then(() => fetchV2State()).then((s) => setSt(s)).catch((e) => setError(String(e)))
  }

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

  // 動画を変えた・解析が終わったら、状態を取り直し、構成（Claudeの仮選定）と照合・実行の結果を作り直す
  const onInputsChanged = useCallback(() => {
    fetchV2State().then((s) => {
      setSt(s); setCfg(initialConfig(s))
      setChecks({}); setRuns({}); setLogicRuns({})
    }).catch((e) => setError(String(e)))
    loadSaved()
  }, [loadSaved])

  if (error && !st) return <div className="fatal">{error}</div>
  if (!st || !cfg) return <div className="fatal">読み込み中…</div>

  const prod = product(st.hw_catalog, cfg.product_id)
  const hw = checks[ckey] ?? null
  // Step 5・6 は、Step 4 で保存した構成（または Claude の仮選定）から選んだものを使う
  const exec = exec0
  const execKey = exec ? configKey(exec.config) : ''
  const config: HwConfig | null = exec ? {
    config_id: execKey, label: exec.name,
    source: exec.source === 'claude' ? 'claude' : 'custom', ...toParts(st.hw_catalog, exec.config), product_id: exec.config.product_id,
  } : null
  const key = ekey
  const run = exec ? runs[key]?.run ?? null : null
  const execCheck = exec ? checks[ekey]?.check ?? null : null
  const ext = st.extraction
  const otherRun = Object.keys(runs).some((k) => k !== key)
  const sameBatchRuns = Object.entries(runs).filter(([k]) => k.endsWith(`|${batchId}`)).map(([, v]) => v)

  async function doRun() {
    if (!exec || !config) return
    setRunning(true)
    setError(null)
    try {
      // 実行は数百ミリ秒で終わるが、進み具合を見せてからプレビューを出す（最短 RUN_MIN_MS 待つ）
      const [r] = await Promise.all([runV2({ ...exec.config, label: exec.name }, batchId, exec.id), new Promise((ok) => setTimeout(ok, RUN_MIN_MS))])
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
    { id: 0, title: TITLES[0], status: !mv.ok ? 'failed' : mv.warnings.length ? 'warn' : 'done', note: `商品${st.masters.items.products.length}・${st.masters.source === 'registered' ? '登録済み' : '初期値'}` },
    { id: 1, title: TITLES[1], status: st.tasks ? 'done' : ext?.inputs ? 'warn' : 'todo', note: st.tasks ? `大タスク${st.tasks.major_tasks.length}` : undefined },
    { id: 2, title: TITLES[2], status: !ext ? 'todo' : !ext.validation.ok ? 'failed' : ext.confirmation_items.length ? 'warn' : 'done', note: ext ? `確認事項${ext.confirmation_items.length}` : undefined },
    { id: 3, title: TITLES[3], status: saved.some((x) => x.source === 'saved') ? 'done' : c ? 'warn' : 'todo', note: `${prod?.name.split(' ')[0] ?? ''}・保存${saved.filter((x) => x.source === 'saved').length}件` },
    { id: 4, title: TITLES[4], status: running || playing ? 'running' : run ? (run.job.end.handed_off ? 'warn' : 'done') : otherRun ? 'stale' : 'todo', note: run ? `配置${run.job.end.placed}/${run.job.items.length}` : undefined },
    { id: 5, title: TITLES[5], status: run ? 'done' : otherRun ? 'stale' : 'todo' },
  ]

  return (
    <div className={`shell ${pinned ? 'nav-pinned' : ''}`}>
      <header className="topbar">
        {/* ロゴと三本線はピン止めメニューの中。ピン止めを外したときだけ、メニューを開くためにここに出す */}
        {!pinned && <>
          <button className="menu-btn" onClick={() => setMenu(!menu)} aria-label="工程メニュー" title="工程メニュー" data-testid="menu-btn">
            <span /><span /><span />
          </button>
          <img src="/work2robot_logo.png" alt="Work2Robot" className="logo" data-testid="logo" />
        </>}
        <span className="cur-step" data-testid="cur-step">
          <span className="cur-no">{NO(step)}</span>{TITLES[step]}
        </span>
        <span className="cur-sub" data-testid="cur-sub">{SUBTITLES[step]}</span>
        {/* Claudeの保存済み結果がなく手書きの業務定義を表示しているときだけ、その旨を出す */}
        {!ext && <span className="badge badge-info" data-testid="source-badge">{st.notice}</span>}
        {/* 対象のシナリオは各画面の上部の帯（Step 3〜6）で示すので、右上には出さない */}
      </header>
      <StepNav steps={steps} current={step} onGo={setStep} open={menu} onClose={() => setMenu(false)} pinned={pinned} onPin={setPinned} />
      {/* 画面ごとの説明文と「次へ」は置かない（移動は左のメニュー）。エラーのときだけ帯を出す */}
      {error && <div className="step-head"><span className="error inline">{error}</span></div>}
      {step > 1 && st.inputs.analysis.missing.length > 0 && <AnalysisMismatch an={st.inputs.analysis} onOpen={() => setStep(1)} />}
      {step === 3 && st.selection_stale && <StaleSelection onChanged={onInputsChanged} />}
      <main className="step-body">
        {step === 0 && <MasterStep key={`${st.masters.source}${st.masters.updated_at}`} st={st} onSaved={onMastersSaved} />}
        {step === 1 && <AnalysisStep st={st} onChanged={onInputsChanged} batchId={batchId} onBatch={changeBatch} onGoStep={setStep} />}
        {step === 2 && <WorkflowStep st={st} logicRun={logicRuns[batchId] ?? null} segments={segments} onChanged={onInputsChanged} />}
        {step === 3 && (
          <HardwareStep
            st={st} config={cfg} onConfig={setCfg}
            check={hw?.check ?? null} profile={hw?.profile ?? null} source={hw?.source ?? null}
            segments={segments} onSeek={() => setStep(1)}
            saved={saved} onSaved={(c) => loadSaved(c.id)} batchId={batchId} onGoStep={setStep}
          />
        )}
        {step === 4 && <ExecutionStep st={st} run={run} config={config} running={running} onRun={doRun} onPlaying={onPlaying} onGoStep={setStep}
          saved={saved} execId={execId} onSelectExec={setExecId} execCheck={execCheck} batchId={batchId} />}
        {step === 5 && <EvaluationStep st={st} run={run} config={config} runs={sameBatchRuns} onGoStep={setStep} />}
      </main>
    </div>
  )
}
