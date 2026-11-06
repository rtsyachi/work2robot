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
export type Improvement = { kind: string; source: 'computed' | 'claude'; text: string }
export type Readiness = {
  items: { object_id: string; status: ReadinessStatus; label: string; reasons: string[] }[]
  categories: Record<'workflow_checked' | 'needs_information' | 'needs_physical_poc' | 'requires_human', string[]>
  counts: Record<ReadinessStatus, number>
  note: string
  hardware?: { config_label: string; counts: Record<'ok' | 'partial' | 'unknown' | 'ng', number>; ng: string[]; partial?: string[]; unknown: string[]; ok: string[] } | null
  improvements?: Improvement[]
  improvements_note?: string
}
export type Level1Graph = {
  nodes: { id: string; type: WfNode['type'] | 'stage' | 'task'; label: string }[]
  edges: { source: string; target: string; field: string; label?: string }[]
}

/** 工程の構造（Level 1 の工程と、工程ごとの詳細＝Level 2）。item_loop 以外の工程は仮想実行の対象外（表示・確認用） */
export type Basis = 'video_observation' | 'spoken_instruction' | 'ai_hypothesis' | 'human_confirmed'
/** タスクの判断条件：基準名・使い方（優先順位・例外）・参照する業務の規則・根拠 */
export type Criterion = { name: string; how: string; rule_refs: string[]; basis: Basis; source_evidence: Evidence[] }
export type ProcessNode = {
  id: string; type: 'task' | 'decision'; label: string; detail: string
  criteria?: Criterion[]   // 判断条件（タスクの中の判断ロジック）。古い版にはない
  rule_refs: string[]; conditions: string[]; confirmation_refs?: string[]; basis: Basis; source_evidence: Evidence[]
}
export type Stage = {
  id: string; name: string; purpose: string; role: 'item_loop' | 'final_check' | 'other'; basis: Basis
  source_evidence: Evidence[]; nodes: ProcessNode[]; edges: { source: string; target: string; label: string }[]
}
export type Process = { stages: Stage[]; warnings?: { code: string; node_id: string; message: string }[] }

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
  kind: 'recognize' | 'check' | 'pick' | 'move' | 'place' | 'handoff'
  result?: string
  end_effector?: string | null
  unverified?: string[]
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
  placement: { position: Vec3; dims: Vec3; rotated: boolean; support: string | null; base_height?: number } | null
  handoff_reason: string | null
  applied_rules?: string[]
  stack_above?: string
  weight_kg?: number | null
  capability?: { status: 'ok' | 'unknown' | 'ng'; ng: string[]; unverified: string[]; end_effector: string }
  cart_after?: { count: number; load_kg: number; com_offset_m: number }
}

// ---- マスタ（Step 1） ----
/** 実行器などが使う荷物1個（出荷明細から組み立てたもの。画面では参照のみ） */
export type ItemMasterRow = {
  object_id: string
  name: string
  object_type: string
  material_class: 'rigid' | 'soft' | null
  weight_kg: number | null
  dims_m: [number, number, number] | null
  fragile_content: boolean | null
  handling_note: string
  product_id?: string
}
/** 商品マスタの1行（荷姿・ケース入数・ボール入数と、1ケースの重量・寸法を含む） */
export type ProductRow = {
  product_id: string; name: string; packing_type: string; material_class: 'rigid' | 'soft' | null
  case_qty: number | null; ball_qty: number | null; weight_kg: number | null; dims_m: [number, number, number] | null
  fragile_content: boolean | null; handling_note: string
}
/** 商品マスタ（product_master.json） */
export type ItemMaster = { master: string; note: string; products: ProductRow[]; updated_at?: string }
/** 出荷予定の1行（出荷の商品1つ）。同じ出荷IDの行の並び順が到着順 */
export type ShipmentLine = { line_id: string; shipped_on: string; shipment_id: string; destination: string; product_id: string; quantity: number }
/** 出荷予定（shipment_plan.json） */
export type ShipmentMaster = { data: string; note: string; plan: ShipmentLine[]; updated_at?: string }
export type CartMaster = {
  cart_id: string; name: string; inner_width_m: number; inner_depth_m: number; height_limit_m: number; max_load_kg: number
  open_side: string; note?: string
}
export type EnvMaster = {
  master: string; note: string; carts: CartMaster[]; active_cart_id: string
  staging: { name: string; rows_z_m: number[]; first_x_m: number; pitch_m: number; note?: string }
  work_area: { aisle_width_m: number | null; floor: string; note?: string }
  updated_at?: string
}
export type MasterIssue = { target: string; message: string }
export type MasterValidation = { ok: boolean; errors: MasterIssue[]; warnings: MasterIssue[] }
/** 受け付けるマスタの定義（backend/workflow/masters.py の MASTER_DEFS） */
export type MasterField = {
  key: string; label: string; type: 'text' | 'number' | 'enum' | 'bool' | 'dims' | 'ids' | 'numbers'
  need: 'required' | 'nullable' | 'optional'; unit?: string; min?: number; gt0?: boolean; note?: string
  values?: { value: string; label: string }[]
}
export type MasterDef = {
  table: 'products' | 'batches' | 'carts' | 'results'; group: string; label: string
  file: 'items' | 'environment' | 'shipments' | 'shipment_results'; path: string; kind: 'list' | 'single'; key?: string; active?: string
  purpose: string; used_in: string[]; fields: MasterField[]
  category: 'master' | 'transaction' | 'other'; who: string; method: string; readonly?: boolean
}
export type DataCategory = 'master' | 'transaction' | 'other'
/** 倉庫内マップ（平面図・参照のみ・模擬）。rect＝[x, y, 幅, 奥行]（m） */
export type WarehouseMap = {
  name: string; note: string; units: string; origin: string; size: [number, number]; source: string; relation_to_masters: string
  elements: { id: string; kind: string; label: string; rect: [number, number, number, number]; basis: 'observed' | 'mock'; dims: 'mock' | 'master'; note?: string }[]
}
export type Masters = {
  items: ItemMaster; environment: EnvMaster; shipments: ShipmentMaster; source: 'default' | 'registered'; updated_at: string | null; validation: MasterValidation
  definitions: MasterDef[]; categories: Record<DataCategory, { label: string; note: string }>
  shipment_results: { note: string; results: Record<string, unknown>[] }   // 出荷実績（参照のみ・模擬）
  warehouse_map: WarehouseMap
  parcels: ItemMasterRow[]   // 出荷明細から組み立てた荷物（1個ずつ・参照のみ）
  batches: Batch[]           // 出荷ヘッダ＋明細から組み立てた便（荷物IDの到着順）
}
/** トランザクション：作業動画と解析結果の状況（backend/inputs.py） */
export type AnalysisRow = {
  kind: string; label: string; step: number; engine: string; command: string
  status: 'ok' | 'mismatch' | 'unknown' | 'missing'; file: string | null; created_at: string | null; model: string | null; video: string | null
}
export type InputsStatus = {
  video: { file: string; exists: boolean; size_mb?: number; duration_s?: number; resolution?: string; fps?: number; has_audio?: boolean }
  analysis: { video: string; items: AnalysisRow[]; ok: boolean; mismatch: string[]; missing: string[] }
  is_demo: boolean  // 今の動画が v5デモ（アップロードなし）か
  job: AnalysisJob
}
/** Step 2「解析開始」の簡易な状態 */
export type AnalysisJob = {
  state: 'idle' | 'running' | 'done' | 'error'; stage: string | null; stages: string[]; video: string | null
  error: string | null; started_at: string | null; finished_at: string | null
}

export type RobotSummary = {
  config_id: string
  label: string
  base: string
  arm: string
  end_effector: string
  sensors: string[]
  peripherals: string[]
  labels: Record<'base' | 'arm' | 'end_effector', string>
  payload_kg: number
  reach_m: number
  shoulder_height_m: number
  standoff_m: number
  product?: { id: string; name: string; type: string; maker_id: string; maker_name: string; execution: 'supported' | 'concept'; execution_note: string; verification: string[] } | null
}

export type RuleResult = {
  type: string
  label: string
  status: 'applied' | 'not_applicable' | 'unsupported'
  detail: string
  notes: string[]
  source_evidence: Evidence[]
}

export type JobTrace = {
  job_id: string
  workflow_id: string
  workflow_version: number
  cart: { width_m: number; depth_m: number; height_m: number; max_load_kg?: number }
  staging?: { first_x_m: number; pitch_m: number; rows_z_m: number[] }
  arrival: string[]
  order: string[]
  items: JobItem[]
  level1_steps: { seq: number; node_id: string; object_id: string | null; edge: string }[]
  primitives: Primitive[]
  end: { reason: string; placed: number; handed_off: number; load_kg?: number }
  robot?: RobotSummary | null
  rule_results?: RuleResult[]
  checks?: {
    overhang: { ok: boolean }
    load: { total_kg: number; max_kg: number | null; ok: boolean | null }
    height: { max_m: number; limit_m: number; ok: boolean }
    balance: { com_offset_m: number; tolerance_m: number | null; ok: boolean | null }
  }
  limitations?: string
}

export type ReqLink = { kind: 'rule' | 'node' | 'object'; id: string }
export type Requirement = {
  id: string
  label: string
  kind: 'numeric' | 'geometry' | 'capability'
  value?: unknown
  unit?: string
  basis: string
  links?: ReqLink[]
  objects?: string[]
  per_object?: Record<string, number>
}
export type CheckStatus = 'ok' | 'partial' | 'unknown' | 'ng'
export type CheckResult = Requirement & { status: CheckStatus; provided: string; detail: string; affected?: string[] }
export type HardwareCheck = { config_id: string; results: CheckResult[]; counts: Record<CheckStatus, number>; note: string }

export type HwComponent = {
  id: string; label: string; note?: string; capabilities: Record<string, string>; cap_notes?: Record<string, string>
  mounts?: string[]; payload_kg?: number; reach_m?: number; mass_kg?: number; max_object_m?: number; shoulder_height_m?: number
}
export type ConfigParts = { base: string; arm: string; end_effector: string; sensors: string[]; peripherals: string[] }
// 仮想メーカーの機種と、その機種が認めるオプションで組んだ構成
export type ProductConfig = { product_id: string; end_effector: string; sensors: string[]; peripherals: string[] }
/** 保存したロボット構成（Step 4 で保存 → Step 5 で選ぶ）。id='claude' は Claude の仮選定（削除不可） */
export type SavedRobotConfig = {
  id: string; name: string; source: 'claude' | 'saved'; readonly: boolean; saved_at: string | null; config: ProductConfig
  /** 選定時のシナリオ・ワークフローの版・出荷予定と、その要件での照合の件数（古い保存にはない） */
  basis?: { scenario_id?: string; workflow_id: string | null; batch_id: string; counts?: Record<'ok' | 'partial' | 'unknown' | 'ng', number> }
}
/** シナリオ（業務単位）。動画・出荷予定はシナリオに紐づくデータで、IDには含めない */
export type Scenario = { scenario_id: string; type: string; name: string; batch_id: string
  resolved_confirmations?: Record<string, { at: string; note: string }>   // 消し込んだ確認事項（確認事項ID → 日時・メモ）
}
/** シナリオに紐づくデータの参照（既存のファイル名をIDとして使う） */
export type ScenarioRefs = { scenario_id: string; video_id: string; batch_id: string; workflow_id: string | null; selection_id: string | null }
/** 保存した仮想実行の結果の参照（Step 6 が「どの版・構成・実行の評価か」を示す） */
export type Execution = {
  execution_id: string; created_at: string; scenario_id: string; video_id: string; workflow_id: string | null
  robot_config_id: string; robot_config_name: string; batch_id: string; placed: number; handed_off: number
}
export type Maker = { id: string; name: string; type: 'fixed' | 'mobile' | 'humanoid'; philosophy: string; strengths: string }
export type Product = {
  id: string; maker_id: string; name: string; type: 'fixed' | 'mobile' | 'humanoid'; use_case: string; structure: string
  fixed: { base: string; arm: string }
  options: { end_effector: string[]; sensors: string[]; peripherals: string[] }
  default: { end_effector: string; sensors: string[]; peripherals: string[] }
  execution: 'supported' | 'concept'; execution_note?: string
  option_notes?: Record<string, string>
  verification?: string[]
}
export type HwCatalog = {
  catalog_id: string
  note: string
  capabilities: Record<string, string>
  manufacturers: Maker[]
  products: Product[]
  components: Record<'base' | 'arm' | 'end_effector' | 'sensor' | 'peripheral', HwComponent[]>
}
export type HwConfig = {
  config_id: string
  label: string
  product_id?: string
  base: string
  arm: string
  end_effector: string
  sensors: string[]
  peripherals: string[]
  source: 'claude' | 'handwritten' | 'custom'
  created_at?: string
}
export type Selection = {
  created_at: string
  record_file?: string
  config: HwConfig
  capability_requirements: { capability: string; reason: string; source_evidence: Evidence[] }[]
  rationale: { component: string; text: string }[]
  alternatives: { component: string; reason: string }[]
  unverified_points: string[]
  improvement_hypotheses: { kind: string; text: string }[]
  summary: string
  check: HardwareCheck
  errors: string[]
  meta: { model: string; attempts: number }
}

export type JobRule = { type: string; note?: string; source_evidence: Evidence[] }
export type V2Job = {
  cart: { width_m: number; depth_m: number; height_m: number; max_load_kg?: number }
  rules: JobRule[]
  unsupported_rules: { text: string; source_evidence: Evidence[] }[]
  balance_tolerance_m?: number | null
  balance_tolerance_evidence?: Evidence[]
}

/** Step 3 の版（直した結果は抽出の新しい版として保存する） */
export type Revision = {
  of: string; from?: string; by: 'user' | 'claude' | 'revert'
  reason?: string; instruction?: string; focus?: string; to?: string; ops?: Record<string, unknown>[]
}
export type EditOp =
  | { op: 'rule'; type: string; enabled: boolean; note?: string }
  | { op: 'decision'; node_id: string; operator?: string; value?: string | number | boolean | null; definition_status: 'defined' | 'needs_confirmation'; confirmation_note?: string }
  | { op: 'balance_tolerance'; value: number | null }
  | { op: 'criteria'; stage_id: string; node_id: string; criteria: { name: string; how: string; rule_refs: string[] }[] }
export type RuleDiff = { type: string; label: string; note?: string; before?: string; after?: string }
export type Proposal = {
  id: string; base: string; instruction: string; focus: string; summary: string; model: string
  confirmation_items: ConfirmationItem[]
  diff: {
    rules_added: RuleDiff[]; rules_removed: RuleDiff[]; rules_changed: RuleDiff[]
    nodes_added: { id: string; label: string; type: string }[]; nodes_removed: { id: string; label: string; type: string }[]
    nodes_changed: { id: string; label: string; before: Record<string, unknown>; after: Record<string, unknown> }[]
    unsupported_before: string[]; unsupported_after: string[]
    confirmations_resolved: string[]; confirmations_added: string[]
    stages_added?: string[]; stages_removed?: string[]
    stages_changed?: { stage: string; added: string[]; removed: string[]; changed: string[] }[]
  }
}

// Step 2：動画の時間軸に沿ったタスク構造（backend/ai/task_structure.py）。時刻は観測・発話から計算した秒
export type TaskRule = {
  id: string
  text: string
  kind: 'spoken' | 'observed' | 'ai_hypothesis'
  rule_type: string
  definition_status: 'defined' | 'needs_confirmation'
  confirmation_note: string
  demonstrated: 'observed' | 'not_observed' | 'unclear'
  speech_ids: string[]
  obs_ids: string[]
}
export type SubTask = { id: string; name: string; objects: string[]; obs_ids: string[]; start: number; end: number }
export type MajorTask = { id: string; name: string; purpose: string; obs_ids: string[]; start: number; end: number; subtasks: SubTask[]; rules: TaskRule[] }
export type SpeechLink = { speech_id: string; task_id: string; relation: 'during' | 'before' | 'after' | 'general'; note: string; start: number; end: number }
export type TaskStructure = {
  created_at: string
  major_tasks: MajorTask[]
  speech_links: SpeechLink[]
  unresolved: { text: string; obs_ids: string[]; speech_ids: string[] }[]
  duration: number
  meta: { model: string }
}

export type V2State = {
  tasks: TaskStructure | null
  notice: string | null
  extraction: (Omit<Extraction, 'job'> & { job: V2Job }) | null
  job: V2Job
  workflow: Workflow
  level1: Level1Graph
  catalog: Catalog
  hw_catalog: HwCatalog
  objects: DemoObject[]
  batches: Batch[]
  requirements: Requirement[]
  selection: Selection | null
  selection_stale: boolean  // 仮選定が、今のワークフローとは別の版から作られている
  scenario: Scenario
  refs: ScenarioRefs
  configs: HwConfig[]
  video_url: string
  masters: Masters
  inputs: InputsStatus
}

/** 模擬の速度仕様からのロボット作業時間の推定（backend/workflow/time_estimate.py）。null＝未算出 */
export type TimeEstimate = {
  total_s: number; final_check_s: number; basis: 'mock_spec'; note: string; excludes: string[]
  items: { object_id: string; seconds: number; travel_s: number; outcome: 'placed' | 'handed_off' }[]
  params: Record<string, string | number>
}
export type V2Run = { job: JobTrace; check: HardwareCheck | null; readiness: Readiness; time_estimate?: TimeEstimate | null; execution?: Execution }

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
  process?: Process
  meta: {
    model: string
    attempts: number
    fallback_used: boolean
    observation_source?: string
    usage: { input_tokens: number; output_tokens: number }[]
    revision?: Revision
  }
}
