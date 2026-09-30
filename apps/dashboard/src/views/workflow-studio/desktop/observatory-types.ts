/**
 * WORKFLOW OBSERVATORY — client contract (desktop Workflow Studio 3.0).
 *
 * Mirrors apps/api/src/lib/domain/workflow-studio/observatory/*. Every figure is
 * projected server-side from the owning runtime's own ledger; the client lays
 * the topology out and paints it, it never infers a state.
 */

export type NodeFamily =
  | 'TRIGGER' | 'ACTION' | 'AI' | 'DECISION' | 'CONDITION' | 'WAIT' | 'APPROVAL' | 'HUMAN_REVIEW'
  | 'SUBWORKFLOW' | 'RETRY' | 'DATA_LOOKUP' | 'STATE_CHANGE' | 'NOTIFICATION' | 'TERMINAL' | 'HANDOFF'

export type WorkflowFamily = 'SELLER' | 'ACQUISITION' | 'COMMUNICATION' | 'CAMPAIGN' | 'DELIVERY' | 'EMAIL' | 'BUYER' | 'CLOSING' | 'SYSTEM'

export type WorkflowStatus = 'live' | 'idle' | 'armed' | 'paused' | 'off' | 'not_running' | 'draft' | 'archived'
export type LibraryGroup = 'live_system' | 'studio' | 'drafts' | 'paused' | 'archived' | 'not_running'

export type EdgeKind = 'primary' | 'branch' | 'exception' | 'failure' | 'human' | 'retry' | 'handoff'

export interface Heartbeat { key: string | null; at: string | null; state: 'current' | 'stale' | 'never' | 'event_driven' | 'on_demand'; cadence: string | null }

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
  trigger: { type: string; label: string; source: string }
  subject_type: string
  supports: { live: boolean; runs: boolean; replay: boolean; edit: boolean; simulation: boolean }
  topology_version: string | null
  heartbeat: Heartbeat
  schedule: string | null
  ledger: string[]
  stats: { runs_today: number | null; runs_24h: number | null; runs_7d: number | null; needs_you: number | null; in_flight: number | null; failed_24h: number | null; last_run_at: string | null; last_tick?: { groups: number; webhooks: number; queue_reconcile_at: string | null } }
  policy?: Record<string, string | null>
  parent?: string | null
  test?: boolean
}

export interface RegistryResponse {
  ok: true
  generated_at: string
  day_start: string
  workflows: RegistryEntry[]
  telemetry: { in_flight: number; needs_you: number; live_automations: number; events_today: number }
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

export interface Topology {
  workflow_key: string
  topology_version: string
  direction: 'LR'
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  groups: TopologyGroup[]
  /** macro stages for the overview's mini graph (each lists the nodes it stands for) */
  stages?: Array<{ key: string; label: string; nodes: string[] }>
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

export interface WorkflowTelemetry {
  period: Period
  since: string
  nodes: Record<string, NodeTelemetry>
  edges: Record<string, number>
  runs: { total: number; completed: number; waiting: number; held: number; needs_you: number; failed: number }
  /** the last few runs through each node (newest first, ≤ 6) */
  recent?: Record<string, Array<{ run_id: string; at: string; status: string; reason: string | null; subject: string | null }>>
  notes: string[]
}

export type Period = '24h' | '7d' | '30d'

export interface WorkflowDetailResponse {
  ok: true
  workflow: RegistryEntry
  topology: Topology
  telemetry: WorkflowTelemetry | null
  generated_at: string
}

export type RunStatus = 'running' | 'waiting' | 'held' | 'needs_you' | 'failed' | 'completed' | 'cancelled'

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
}

export interface RunsResponse { ok: true; runs: RunRow[]; next_cursor: string | null; counts: Partial<Record<RunStatus | 'all', number>>; period: Period }

export interface ObservedEvent {
  event_id: string
  workflow_key: string
  run_id: string
  node_key: string | null
  event_type: string
  status: string
  occurred_at: string
  duration_ms: number | null
  reason_code: string | null
  label: string
  source_runtime: string
  source_ref: string | null
}

export interface RunDetailResponse {
  ok: true
  run: RunRow
  path: { nodes: Record<string, { status: string; at: string | null; reason: string | null; label?: string | null }>; edges: string[]; order: string[]; focus: string | null }
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

export interface LiveResponse {
  ok: true
  now: string
  cadence_ms: number
  source: string
  active: Array<{ run_id: string; workflow_key: string; node_key: string | null; status: RunStatus; subject: RunSubject; since: string | null; detail?: string | null }>
  recent: ObservedEvent[]
}

export interface NeedsYouItem {
  run_id: string
  workflow_key: string
  workflow_name: string
  detail?: string | null
  node_key: string | null
  subject: RunSubject
  reason: string
  since: string | null
  href: string | null
}

export interface NeedsYouResponse { ok: true; items: NeedsYouItem[]; total: number; generated_at: string }

export interface AnalyticsBucket { at: string; to: string; total: number; completed: number; waiting: number; held: number; needs_you: number; failed: number; cancelled: number; running: number; human: number }
export interface AnalyticsNode { key: string; label: string; family: NodeFamily; entered: number; held: number; failed: number; human: number; hold_rate: number; fail_rate: number; human_rate: number; measured: boolean; p50_ms?: number | null; p95_ms?: number | null; samples?: number; last_at: string | null }
export interface AnalyticsResponse {
  ok: true
  workflow_key: string
  topology_version: string
  period: Period
  since: string
  population: { runs: number; note: string }
  series: AnalyticsBucket[]
  resolution: { system: number; human: number; held: number; failed: number; withdrawn: number; in_flight: number }
  performance: { runs: number; completion_rate: number | null; hold_rate: number | null; intervention_rate: number | null; failure_rate: number | null; median_ms: number | null; p95_ms: number | null; duration_samples: number; retry_rate: number | null }
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
