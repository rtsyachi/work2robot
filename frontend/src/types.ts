// データ形式の正本は docs/WORKFLOW_SPEC.md。ここは画面で使う分だけを型にしたもの。

export type Evidence = { type: string; note?: string; ref?: string }

export type WfNode = {
  id: string
  type: 'start' | 'observe' | 'decision' | 'skill' | 'handoff' | 'end'
  label?: string
  next?: string
  required_fields?: string[]
  field?: string
  operator?: 'eq' | 'ge' | 'lt' | 'is_known'
  value?: unknown
  definition_status?: 'defined' | 'needs_confirmation'
  confirmation_note?: string
  on_true?: string
  on_false?: string
  on_unknown?: string
  skill_name?: string
  parameters?: Record<string, string>
  reason?: string
  result?: string
  provisional?: boolean
  provisional_note?: string
  source_evidence?: Evidence[]
}

export type Workflow = {
  workflow_id: string
  version: number
  note?: string
  start_node_id: string
  nodes: WfNode[]
}

export type Attr = { value: unknown; source: string }

export type DemoObject = {
  object_id: string
  description?: string
  attributes: Record<string, Attr>
}

export type Skill = {
  name: string
  description: string
  parameters: Record<string, { values: string[]; required: boolean }>
  physical_verification: string
  poc_checks: string[]
}

export type Catalog = { catalog_id: string; note?: string; skills: Skill[] }

export type SkillEvent = {
  seq: number
  node_id: string
  skill: string
  parameters: Record<string, string>
  provisional: boolean
}

export type ProvisionalAction = { node_id: string; note: string; evidence: Evidence[] }

export type TraceStep = {
  index: number
  node_id: string
  node_type: WfNode['type']
  label?: string
  observed?: Record<string, Attr>
  missing_fields?: string[]
  field?: string
  operator?: string
  value?: unknown
  input?: Attr | null
  definition_status?: string
  result?: string
  edge?: string
  reason?: string
  rule_evidence?: Evidence[]
  skill_event?: SkillEvent
}

export type Trace = {
  trace_version: number
  workflow_id: string
  workflow_version: number
  object_id: string
  steps: TraceStep[]
  edges: { from: string; to: string; label: string }[]
  skill_events: SkillEvent[]
  handoffs: { node_id: string; reason: string }[]
  unknown_fields: string[]
  unconfirmed_conditions: string[]
  provisional_actions: ProvisionalAction[]
  result: 'placed' | 'handed_off'
}

export type Issue = { code: string; message: string; node_id: string | null }
export type Validation = { ok: boolean; errors: Issue[]; warnings: Issue[] }

export type Batch = { batch_id: string; label: string; object_ids: string[] }

export type ReadinessStatus = 'needs_physical_poc' | 'needs_information' | 'requires_human'
export type Readiness = {
  items: { object_id: string; status: ReadinessStatus; label: string; reasons: string[] }[]
  categories: Record<'workflow_checked' | 'needs_information' | 'needs_physical_poc' | 'requires_human', string[]>
  counts: Record<ReadinessStatus, number>
  note: string
}
export type Level1Graph = {
  nodes: { id: string; type: WfNode['type']; label: string }[]
  edges: { source: string; target: string; field: string }[]
}

export type Fixtures = {
  notice: string
  workflow: Workflow
  job: Record<string, unknown>
  level1: Level1Graph
  catalog: Catalog
  objects: DemoObject[]
  batches: Batch[]
}

export type Vec3 = [number, number, number]

export type Primitive = {
  seq: number
  object_id: string
  kind: 'recognize' | 'pick' | 'move' | 'place' | 'handoff'
  at?: Vec3
  from?: Vec3
  to?: Vec3
  position?: Vec3
  rotated?: boolean
  zone?: string
  press_mode?: string
  provisional?: boolean
  reason?: string
}

export type JobItem = {
  object_id: string
  seq: number
  item_trace: Trace
  outcome: 'placed' | 'handed_off'
  dims: Vec3 | null
  zone: string | null
  press_mode: string | null
  provisional: boolean
  placement: { position: Vec3; dims: Vec3; rotated: boolean; support: string | null } | null
  handoff_reason: string | null
}

export type JobTrace = {
  job_id: string
  workflow_id: string
  workflow_version: number
  cart: { width_m: number; depth_m: number; height_m: number }
  arrival: string[]
  order: string[]
  items: JobItem[]
  level1_steps: { seq: number; node_id: string; object_id: string | null; edge: string }[]
  primitives: Primitive[]
  end: { reason: string; placed: number; handed_off: number }
}

export type Segment = { id: string; t: string; text: string; objects?: string[] }
export type TextInput = { source_type: string; note: string; segments: Segment[] }
export type Observation = TextInput & {
  video?: string
  uncertain?: string[]
  created_at?: string
  record_file?: string
}
export type DemoInputs = { explanation: TextInput; observations: TextInput; attributes: unknown }

export type ConfirmationItem = {
  id: string
  kind: 'undefined_condition' | 'missing_information' | 'provisional_action' | 'physical_poc'
  topic: string
  detail: string
  related_node_ids: string[]
  source_evidence: Evidence[]
}

export type Extraction = {
  source: 'live' | 'saved'
  created_at: string
  record_file?: string
  workflow: Workflow
  job: Record<string, unknown> & { order_rule: { zones: string[]; note: string } }
  inputs?: { explanation: TextInput; observations: Observation }
  confirmation_items: ConfirmationItem[]
  summary: string
  validation: Validation
  meta: {
    model: string
    attempts: number
    fallback_used: boolean
    observation_source?: string
    usage: { input_tokens: number; output_tokens: number }[]
  }
}
