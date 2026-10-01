/**
 * WORKFLOW STUDIO 4.0 — client contract.
 *
 * Mirrors apps/api/src/lib/domain/workflow-studio/observatory/*. Every figure
 * is projected server-side from the owning runtime's own ledger; the client
 * lays out and paints, it never infers a state.
 */

export type NodeFamily =
  | 'TRIGGER' | 'ACTION' | 'AI' | 'DECISION' | 'CONDITION' | 'WAIT' | 'APPROVAL' | 'HUMAN_REVIEW'
  | 'SUBWORKFLOW' | 'RETRY' | 'DATA_LOOKUP' | 'STATE_CHANGE' | 'NOTIFICATION' | 'TERMINAL' | 'HANDOFF'

export type WorkflowFamily = 'SELLER' | 'ACQUISITION' | 'COMMUNICATION' | 'CAMPAIGN' | 'DELIVERY' | 'EMAIL' | 'BUYER' | 'CLOSING' | 'SYSTEM'
export type WorkflowStatus = 'live' | 'idle' | 'armed' | 'paused' | 'off' | 'not_running' | 'draft' | 'archived'
export type LibraryGroup = 'live_system' | 'studio' | 'drafts' | 'paused' | 'archived' | 'not_running'
export type EdgeKind = 'primary' | 'branch' | 'exception' | 'failure' | 'human' | 'retry' | 'handoff'
export type Period = '24h' | '7d' | '30d'
export type RunStatus = 'running' | 'waiting' | 'held' | 'needs_you' | 'failed' | 'completed' | 'cancelled'

export interface Heartbeat { key: string | null; at: string | null; state: 'current' | 'stale' | 'never' | 'event_driven' | 'on_demand'; cadence: string | null }

export interface WorkflowStats {
  runs_today: number | null
  runs_24h: number | null
  runs_7d: number | null
  needs_you: number | null
  in_flight: number | null
  executing?: number | null
  waiting?: number | null
  failed_24h: number | null
  last_run_at: string | null
  follow_ups_scheduled?: number
  feeding?: number
  placed_today?: number
  placed_24h?: number
  held_24h?: number
  rows_placed_24h?: number
  last_tick?: { groups: number; webhooks: number; queue_reconcile_at: string | null }
}

export interface RegistryEntry {
  workflow_key: string
  name: string
  short_name: string
  description: string
  family: WorkflowFamily
  kind: 'system' | 'studio'
  owner_app: string
  owner_href: string | null
  runtime: string
  runtime_version: string
  status: WorkflowStatus
  status_note: string | null
  group: LibraryGroup
  trigger: { type: string | null; label: string; source: string }
  subject_type: string
  supports: { live: boolean; runs: boolean; replay: boolean; edit: boolean; simulation: boolean }
  topology_version: string | null
  heartbeat: Heartbeat
  schedule: string | null
  ledger: string[]
  stats: WorkflowStats
  policy?: Record<string, string | null>
  parent?: string | null
  test?: boolean
}

export interface RuntimeBeat {
  key: string
  label: string
  heartbeat_key: string
  at: string | null
  age_ms: number | null
  state: 'current' | 'stale' | 'never' | 'seen'
  cadence: string
  switched_off: boolean
  switch_key: string | null
  external: boolean
  workflows: string[]
}

export interface RegistryResponse {
  ok: true
  generated_at: string
  day_start: string
  workflows: RegistryEntry[]
  telemetry: {
    in_flight: number
    needs_you: number
    live_automations: number
    events_today: number
    executing_now?: number
    waiting_now?: number
    runs_today?: number
    campaign_passes_today?: number | null
    campaign_passes_placed_today?: number | null
    by_workflow_today?: Record<string, number>
  }
  runtimes?: RuntimeBeat[]
  degraded: string[]
}

export interface TopologyNode {
  key: string
  family: NodeFamily
  label: string
  short?: string
  summary?: string | null
  description?: string | null
  lane?: number
  group?: string | null
  optional?: boolean
  evidence?: string[]
  owner?: string | null
  action?: string | null
  inputs?: string[]
  outputs?: string[]
  exits?: string[]
  handoff?: string | null
  terminal?: 'success' | 'failure' | 'neutral' | 'human' | null
  link?: { app: string; href: string } | null
  measured?: { latency: boolean; note?: string | null }
}

export interface TopologyEdge { id: string; from: string; to: string; kind: EdgeKind; label?: string | null }
export interface TopologyGroup { key: string; label: string; family: NodeFamily; layout: 'sequence' | 'stack'; summary?: string | null; collapsed?: boolean }
export interface TopologyStage { key: string; label: string; nodes: string[] }

export interface Topology {
  workflow_key: string
  topology_version: string
  direction: 'LR'
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  groups: TopologyGroup[]
  stages?: TopologyStage[]
  badge: string
}

export interface NodeTelemetry {
  entered: number
  passed: number
  held: number
  failed: number
  human: number
  skipped: number
  waiting_now: number
  p50_ms: number | null
  p95_ms: number | null
  last_at: string | null
}

export interface RecentRun { run_id: string; at: string; status: string; reason: string | null; subject: string | null }

export interface WorkflowTelemetry {
  period: Period
  since: string
  nodes: Record<string, NodeTelemetry>
  edges: Record<string, number>
  runs: { total: number; completed: number; waiting: number; held: number; needs_you: number; failed: number }
  recent?: Record<string, RecentRun[]>
  notes: string[]
}

export interface WorkflowDetailResponse { ok: true; workflow: RegistryEntry; topology: Topology; telemetry: WorkflowTelemetry | null; generated_at: string }

export interface RunSubject { kind: string; id: string | null; name: string | null; address: string | null; href: string | null }

export interface RunRow {
  run_id: string
  workflow_key: string
  version: string | null
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  subject: RunSubject
  trigger: string | null
  status: RunStatus
  status_label: string
  current_node: string | null
  final_node: string | null
  human: boolean
  result: string | null
  reason: string | null
  ingress?: { received_at: string | null; latency_ms: number | null; status: string | null; matched_by: string } | null
}

export interface RunsResponse { ok: true; runs: RunRow[]; next_cursor: string | null; counts: Partial<Record<RunStatus | 'all', number>>; period: Period; degraded?: string[] }

export interface ObservedEvent {
  event_id: string
  workflow_key: string
  run_id: string
  node_key: string | null
  event_type: string
  status: string
  occurred_at: string | null
  duration_ms: number | null
  reason_code: string | null
  label: string | null
  source_runtime: string
  source_ref: string | null
}

export type TimingQuality = 'measured' | 'recorder' | 'inferred' | 'single'

export interface RunPath { nodes: Record<string, { status: string; at: string | null; reason: string | null; label?: string | null }>; edges: string[]; order: string[]; focus: string | null; orphans?: string[] }

export interface RunDetailResponse {
  ok: true
  run: RunRow
  path: RunPath
  why: { headline: string; tone: 'good' | 'active' | 'held' | 'human' | 'bad' | 'muted'; lines: string[] }
  facts: Array<{ k: string; v: string; source: string }>
  decisions: Array<{ k: string; v: string; source: string }>
  ai: Array<{ k: string; v: string }>
  inputs: Array<{ k: string; v: string }>
  outputs: Array<{ k: string; v: string }>
  timeline: ObservedEvent[]
  links: Array<{ label: string; href: string; app: string }>
  technical: Record<string, unknown>
  topology_version: string
  timing?: { quality: TimingQuality; note: string }
}

export interface ActivityGroup {
  group_id: string
  run_id: string
  workflow_key: string
  workflow_name: string
  family: WorkflowFamily
  at: string
  headline: string
  subject: RunSubject
  facts: string[]
  status: RunStatus
  human: boolean
  focus_node: string | null
  events: ObservedEvent[]
}

export interface ActivityResponse { ok: true; groups: ActivityGroup[]; window_hours: number; generated_at: string; degraded: string[] }

export interface LiveActive {
  run_id: string | null
  workflow_key: string
  node_key: string | null
  status: RunStatus | string
  subject: RunSubject
  since: string | null
  due_at?: string | null
  detail?: string | null
  open?: { workflow_key: string; run_id: string } | null
  campaign_id?: string
}

export interface Traversal { workflow_key: string; run_id: string; edge_id: string; from: string; to: string; at: string; status: string }

export interface LiveResponse {
  ok: true
  now: string
  from?: string
  cadence_ms: number
  source: string
  active: LiveActive[]
  recent: ObservedEvent[]
  traversals?: Traversal[]
  degraded?: string[]
}

export type ExceptionCategory = 'human_review' | 'approval' | 'failed' | 'stalled' | 'stale_wait' | 'missing_data' | 'degraded'

export interface ExceptionAction { kind: string; label: string; href?: string; app?: string | null; run_id?: string; node_id?: string; drill?: RunsDrill }

export interface ExceptionItem {
  id: string
  category: ExceptionCategory
  workflow_key: string
  workflow_name: string
  run_id: string | null
  open: { workflow_key: string; run_id: string } | null
  node_key: string | null
  subject: RunSubject | null
  reason: string
  reason_code: string | null
  detail: string | null
  since: string | null
  owner_app: string
  href: string | null
  count: number | null
  drill: RunsDrill | null
  finding: boolean
  actions: ExceptionAction[]
}

export interface ExceptionsResponse {
  ok: true
  generated_at: string
  items: ExceptionItem[]
  total: number
  counts: Record<ExceptionCategory, number>
  categories: Array<{ key: ExceptionCategory; label: string; tone: string }>
  degraded: string[]
}

export type SystemEdgeKind = 'event' | 'action' | 'subworkflow' | 'external' | 'state'

export interface SystemNode {
  key: string
  kind: 'system' | 'external' | 'domain' | 'studio'
  workflow_key?: string
  label: string
  sub?: string
  family?: WorkflowFamily
  tier?: 'spine' | 'support'
  description?: string
  owner_app?: string
  owner_href?: string
  note?: string
  members?: Array<{ workflow_key: string; name: string; status: string; version: number | null }>
  heartbeat_at?: string | null
  switched_off?: boolean
  last_inbound_at?: string | null
  last_callback_at?: string | null
  sending?: boolean
}

export interface SystemEdge {
  id: string
  from: string
  to: string
  kind: SystemEdgeKind
  label: string
  evidence: string
  measure: string | null
  note?: string
  traffic: { window: '24h' | '7d'; count: number | null }
  state: 'carrying' | 'quiet' | 'off' | 'unmeasured' | 'unread'
}

export interface SystemMapResponse { ok: true; window: '24h' | '7d'; since: string; generated_at: string; nodes: SystemNode[]; edges: SystemEdge[]; degraded: string[] }

export interface Distribution { samples: number; p50: number | null; p75: number | null; p95: number | null; max: number | null; histogram: Array<{ lo: number; hi: number | null; count: number }> }

export interface AnalyticsBucket { at: string; to: string; total: number; completed: number; waiting: number; held: number; needs_you: number; failed: number; cancelled: number; running: number; human: number }
export interface AnalyticsNode { key: string; label: string; family: NodeFamily; entered: number; held: number; failed: number; human: number; hold_rate: number; fail_rate: number; human_rate: number; measured: boolean; p50_ms?: number | null; p95_ms?: number | null; samples?: number; last_at: string | null }
export interface AnalyticsDay { date: string; runs: number; human: number; failed: number; held: number; completed: number }

export interface AnalyticsResponse {
  ok: true
  workflow_key: string
  topology_version: string
  timing?: TimingQuality
  source_runtime?: string
  kind?: 'system' | 'studio'
  period: Period
  since: string
  population: { runs: number; note: string }
  series: AnalyticsBucket[]
  resolution: { system: number; human: number; held: number; failed: number; withdrawn: number; in_flight: number }
  performance: { runs: number; completion_rate: number | null; hold_rate: number | null; intervention_rate: number | null; failure_rate: number | null; median_ms: number | null; p95_ms: number | null; duration_samples: number; retry_rate: number | null }
  automation?: { automated: number; eligible: number; rate: number | null; definition: string }
  intervention?: { runs: number; rate: number | null; by_reason: Array<{ reason: string; label: string; count: number }>; by_node: Array<{ node: string; label: string; count: number }> }
  latency?: { runs: Distribution; nodes: Record<string, Distribution>; ingress: Distribution | null; note: string | null }
  dwell?: Array<Distribution & { node: string; label: string; family: NodeFamily }>
  days?: AnalyticsDay[]
  rhythm?: { tz: string; cells: Array<{ dow: number; hour: number; runs: number; human: number; failed: number }> }
  retries?: { runs: number; rate: number | null }
  bottlenecks: AnalyticsNode[]
  throughput: Array<{ key: string; label: string; family: NodeFamily; entered: number }>
  hold_reasons: Array<{ reason: string; label: string; count: number; node: string }>
  interventions: Array<{ at: string; to: string; human: number; total: number }>
  versions: Array<{ version: string; runs: number; completed: number; held: number; human: number; failed: number; first_at: string; last_at: string }>
  branches: Array<{ node: string; label: string; exits: Array<{ edge: string; to: string; label: string; kind: EdgeKind; count: number }> }>
  edges: Record<string, number>
  degraded: string[]
  generated_at: string
}

/** A drill-down handed to the runs ledger (analytics, exceptions, canvas). */
export interface RunsDrill {
  status?: RunStatus | 'all'
  node?: string | null
  edge?: string | null
  reason?: string | null
  version?: string | null
  from?: string | null
  to?: string | null
  human?: boolean
  period?: Period
  label?: string
}
