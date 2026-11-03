import type {
  ConfirmationItem, DemoInputs, DemoObject, Extraction, Fixtures, JobTrace, Observation, Readiness, Trace, Validation, Workflow,
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
