import type {
  ConfirmationItem, DemoInputs, ProductConfig, DemoObject, Extraction, Fixtures, HardwareCheck, JobTrace, Observation, Readiness,
  RobotSummary, Trace, V2Run, V2State, ItemMaster, EnvMaster, ShipmentMaster, MasterValidation, Masters,
  Validation, Workflow, InputsStatus, AnalysisJob, EditOp, Proposal, SavedRobotConfig, Scenario,
} from './types'

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`API ${path} が失敗しました（${res.status}）: ${detail}`)
  }
  return res.json() as Promise<T>
}

export const fetchFixtures = () => request<Fixtures>('/api/demo/fixtures')
export const fetchInputs = () => request<DemoInputs>('/api/demo/inputs')
export const observeVideo = () => request<Observation>('/api/observe', {})
export const fetchLatestObservation = () => request<Observation>('/api/observe/latest').catch(() => null)
export const extractWithClaude = (observations: 'video' | 'dev' = 'video') =>
  request<Extraction>('/api/extract', { observations })
export const fetchLatestExtraction = () => request<Extraction>('/api/extract/latest')
export const validateWorkflow = (workflow: Workflow) =>
  request<Validation>('/api/workflows/validate', { workflow })
export const runWorkflow = (workflow: Workflow, object: DemoObject) =>
  request<Trace>('/api/workflows/run', { workflow, object })
export const runJob = (workflow: Workflow, batchId: string, job?: Record<string, unknown>) =>
  request<JobTrace>('/api/jobs/run', { workflow, batch_id: batchId, job })
export const fetchReadiness = (workflow: Workflow, jobTrace: JobTrace, confirmationItems: ConfirmationItem[] = []) =>
  request<Readiness>('/api/readiness', { workflow, job_trace: jobTrace, confirmation_items: confirmationItems })
export const VIDEO_URL = '/api/media/work_video.mp4'

// シナリオv2（業務の規則・ハードウェア構成）
export const fetchV2State = () => request<V2State>('/api/v2/state')

// Step 2：動画のアップロードと解析開始（既存の解析処理を順に呼ぶ）
async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.detail?.message ?? `API ${path} が失敗しました（${res.status}）`)
  }
  return res.json() as Promise<T>
}
export const uploadVideo = (file: File) =>
  call<InputsStatus>(`/api/v2/video?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } })
export const resetVideo = () => call<InputsStatus>('/api/v2/video', { method: 'DELETE' })
export const startAnalysis = (supplement: string) =>
  call<AnalysisJob>('/api/v2/analyze', { method: 'POST', body: JSON.stringify({ supplement }), headers: { 'Content-Type': 'application/json' } })
export const fetchAnalysis = () => call<AnalysisJob>('/api/v2/analyze', {})

// Step 3：確認・教示（直した結果は新しい版として保存）
const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
export const editWorkflow = (ops: EditOp[], reason: string) => call<{ record_file: string }>('/api/v2/workflow/edit', json({ ops, reason }))
export const proposeRevision = (instruction: string, focus: string) => call<Proposal>('/api/v2/workflow/propose', json({ instruction, focus }))
export const applyProposal = (id: string) => call<{ record_file: string }>(`/api/v2/workflow/proposals/${id}/apply`, { method: 'POST' })
export const discardProposal = (id: string) => call<{ ok: boolean }>(`/api/v2/workflow/proposals/${id}`, { method: 'DELETE' })
export const revertWorkflow = () => call<{ record_file: string }>('/api/v2/workflow/revert', { method: 'POST' })
// 保存したロボット構成（Step 4 で保存 → Step 5 で選ぶ）
export const fetchRobotConfigs = () => call<SavedRobotConfig[]>('/api/v2/robot-configs', {})
export const saveRobotConfig = (name: string, config: ProductConfig, batchId: string) =>
  call<SavedRobotConfig>('/api/v2/robot-configs', json({ name, config, batch_id: batchId }))
export const deleteRobotConfig = (id: string) => call<{ ok: boolean }>(`/api/v2/robot-configs/${id}`, { method: 'DELETE' })
export const reselectHardware = () => call<AnalysisJob>('/api/v2/hardware/reselect', { method: 'POST' })
// config：画面で組んだ構成（ベース＋着せ替え）。null なら能力の制約なしで実行（Step 3 の荷物別の経路用）
// robotConfigId：Step 4 で保存した構成のID。指定すると実行結果を保存し、Step 6 が参照する
export const runV2 = (config: ProductConfig & { label?: string } | null, batchId: string, robotConfigId?: string) =>
  request<V2Run>('/api/v2/run', { config, batch_id: batchId, robot_config_id: robotConfigId ?? null })
// シナリオの対象の出荷予定を変える（シナリオIDは変わらない）
export const setScenarioBatch = (batchId: string) => send<Scenario>('PUT', '/api/v2/scenario', { batch_id: batchId })
export const renameScenario = (name: string) => send<Scenario>('PUT', '/api/v2/scenario', { name })
/** 確認事項を消し込む（対応済みにする）／戻す */
export const resolveConfirmation = (cid: string, resolved: boolean, note = '') =>
  send<Scenario>('PUT', `/api/v2/confirmations/${encodeURIComponent(cid)}`, { resolved, note })
// 保存した実行結果（今のシナリオ・ワークフローの版で、この構成・出荷予定の最新）。なければ null
export const fetchLatestExecution = async (robotConfigId: string, batchId: string): Promise<V2Run | null> => {
  const res = await fetch(`/api/v2/executions/latest?robot_config_id=${encodeURIComponent(robotConfigId)}&batch_id=${encodeURIComponent(batchId)}`)
  return res.ok ? (res.json() as Promise<V2Run | null>) : null
}
// マスタ（Step 1）
async function send<T>(method: 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!res.ok) throw new Error(`API ${path} が失敗しました（${res.status}）: ${await res.text()}`)
  return res.json() as Promise<T>
}
export const validateMasters = (items: ItemMaster, environment: EnvMaster, shipments: ShipmentMaster) =>
  request<MasterValidation>('/api/v2/masters/validate', { items, environment, shipments })
export const saveMasters = (items: ItemMaster, environment: EnvMaster, shipments: ShipmentMaster) => send<Masters>('PUT', '/api/v2/masters', { items, environment, shipments })
export const resetMasters = () => send<Masters>('DELETE', '/api/v2/masters')
// 業務要件は、選んだ出荷予定の荷物から導く（Step 4 の照合と Step 5 の判定で同じ要件）
export const checkV2 = (config: ProductConfig & { label?: string }, batchId: string) =>
  request<{ check: HardwareCheck; profile: RobotSummary; source: 'claude' | 'custom' }>('/api/v2/check', { config, batch_id: batchId })
