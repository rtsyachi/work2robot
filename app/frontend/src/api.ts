import type {
  ConfirmationItem, DemoInputs, ProductConfig, DemoObject, Extraction, Fixtures, HardwareCheck, JobTrace, Observation, Readiness,
  RobotSummary, Trace, V2Run, V2State, ItemMaster, EnvMaster, MasterValidation, Masters,
  Validation, Workflow,
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
// config：画面で組んだ構成（ベース＋着せ替え）。null なら能力の制約なしで実行（Step 2 の荷物別の経路用）
export const runV2 = (config: ProductConfig & { label?: string } | null, batchId: string) =>
  request<V2Run>('/api/v2/run', { config, batch_id: batchId })
// マスタ（Step 0）
async function send<T>(method: 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!res.ok) throw new Error(`API ${path} が失敗しました（${res.status}）: ${await res.text()}`)
  return res.json() as Promise<T>
}
export const validateMasters = (items: ItemMaster, environment: EnvMaster) =>
  request<MasterValidation>('/api/v2/masters/validate', { items, environment })
export const saveMasters = (items: ItemMaster, environment: EnvMaster) => send<Masters>('PUT', '/api/v2/masters', { items, environment })
export const resetMasters = () => send<Masters>('DELETE', '/api/v2/masters')
export const checkV2 =(config: ProductConfig & { label?: string }) =>
  request<{ check: HardwareCheck; profile: RobotSummary; source: 'claude' | 'custom' }>('/api/v2/check', { config })
