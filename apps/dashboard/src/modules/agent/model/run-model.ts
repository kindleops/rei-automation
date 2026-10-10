/**
 * RUN MODEL — conversation / task events → the stream the dock and the
 * workspace canvas render (arch §9.2). Pure. Text streams only as
 * message.delta events arrive; the model's reasoning is shown only as
 * `decision` summaries; approvals render exactly the payload they carry.
 */
import type { AgentEvent, ApprovalRequest, CostEstimate, PlanStep, RunState, Tier } from '../contracts/contracts'
import { RUN_TERMINAL_STATES } from '../contracts/contracts'

export type StreamItem =
  | { kind: 'operator'; key: string; text: string; at: string; event_id: number }
  | { kind: 'assistant'; key: string; text: string; done: boolean; at: string; event_id: number }
  | { kind: 'decision'; key: string; summary: string; at: string; event_id: number }
  | { kind: 'tool'; key: string; tool: string; tier: Tier; label: string; state: 'running' | 'completed' | 'failed' | 'refused'; started_at: string; ended_at: string | null; duration_ms: number | null; rows: number | null; cost_usd: number | null; result: string | null; event_id: number }
  | { kind: 'plan'; key: string; artifact_id: string; steps: PlanStep[]; estimate: CostEstimate | null; hash: string; state: 'proposed' | 'approved' | 'rejected'; at: string; event_id: number }
  | { kind: 'approval'; key: string; approval: ApprovalRequest; state: 'requested' | 'granted' | 'denied' | 'expired' | 'invalidated' | 'consumed'; expires_ms: number | null; at: string; event_id: number }
  | { kind: 'artifact'; key: string; artifact_id: string; artifact_kind: string; title: string; status: string; version: number; at: string; event_id: number }
  | { kind: 'intent'; key: string; label: string; intent: string; params: Record<string, unknown>; at: string; event_id: number }
  | { kind: 'context'; key: string; label: string; at: string; event_id: number }

export interface RunView {
  run_id: string
  fixture: boolean
  title: string
  state: RunState
  created_at: string | null
  ended_at: string | null
  last_at: string | null
  cap_usd: number | null
  accrued_usd: number
  items: StreamItem[]
  index: Record<string, number>
  /** label of a tool.started with no completion yet (shimmer target) */
  current: string | null
  last_event_id: number
  last_seq: number
  gap: boolean
}

export const emptyRun = (run_id: string): RunView => ({ run_id, fixture: false, title: 'Agent', state: 'created', created_at: null, ended_at: null, last_at: null, cap_usd: null, accrued_usd: 0, items: [], index: {}, current: null, last_event_id: 0, last_seq: 0, gap: false })

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function expiryMs(at: string, raw: string): number | null {
  const rel = /^\+(\d+)m$/.exec(raw)
  if (rel) return Date.parse(at) + Number(rel[1]) * 60_000
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : null
}

export function applyRunEvent(prev: RunView, e: AgentEvent): RunView {
  const v: RunView = { ...prev, last_at: e.at }
  if (e.fixture) v.fixture = true
  if (prev.last_seq && e.seq !== prev.last_seq + 1) v.gap = true
  v.last_seq = Math.max(prev.last_seq, e.seq)
  v.last_event_id = Math.max(prev.last_event_id, e.event_id)
  const p = e.payload
  const push = (item: StreamItem) => { v.index = { ...v.index, [item.key]: v.items.length }; v.items = [...v.items, item] }
  const patch = (key: string, fn: (it: StreamItem) => StreamItem) => {
    const i = v.index[key]
    if (i === undefined) return
    const items = v.items.slice(); items[i] = fn(items[i]); v.items = items
  }
  switch (e.type) {
    case 'run.created': v.title = str(p.title) ?? v.title; v.cap_usd = num(p.budget_cap_usd); v.created_at = e.at; break
    case 'run.state': v.state = (str(p.to) as RunState) ?? v.state; break
    case 'run.completed': case 'run.cancelled': case 'run.failed': case 'run.budget_exhausted':
      v.state = e.type === 'run.completed' ? ((str(p.state) as RunState) ?? 'completed') : e.type === 'run.cancelled' ? 'cancelled' : e.type === 'run.failed' ? 'failed' : 'budget_exhausted'
      v.ended_at = e.at
      break
    case 'context.attached': {
      const refs = Array.isArray(p.object_refs) ? (p.object_refs as Array<{ label?: string }>) : []
      push({ kind: 'context', key: `ctx-${e.event_id}`, label: `${str(p.app) ?? 'context'} · ${refs.map((r) => r.label).filter(Boolean).join(', ') || `${num(p.selection_count) ?? 0} selected`}`, at: e.at, event_id: e.event_id })
      break
    }
    case 'message.operator': push({ kind: 'operator', key: `op-${str(p.turn_id) ?? e.event_id}`, text: str(p.text) ?? '', at: e.at, event_id: e.event_id }); break
    case 'message.delta': {
      const key = `as-${str(p.turn_id) ?? 'a'}`
      if (v.index[key] === undefined) push({ kind: 'assistant', key, text: str(p.text) ?? '', done: false, at: e.at, event_id: e.event_id })
      else patch(key, (it) => (it.kind === 'assistant' ? { ...it, text: it.text + (str(p.text) ?? '') } : it))
      break
    }
    case 'message.completed': {
      const key = `as-${str(p.turn_id) ?? 'a'}`
      if (v.index[key] === undefined) push({ kind: 'assistant', key, text: str(p.text) ?? '', done: true, at: e.at, event_id: e.event_id })
      else patch(key, (it) => (it.kind === 'assistant' ? { ...it, text: str(p.text) ?? it.text, done: true } : it))
      break
    }
    case 'decision': push({ kind: 'decision', key: `dc-${e.event_id}`, summary: (str(p.summary) ?? '').slice(0, 240), at: e.at, event_id: e.event_id }); break
    case 'tool.started': push({ kind: 'tool', key: `tc-${e.tool_call_id ?? e.event_id}`, tool: str(p.tool) ?? 'tool', tier: (str(p.tier) as Tier) ?? 'T0', label: str(p.label) ?? 'Working', state: 'running', started_at: e.at, ended_at: null, duration_ms: null, rows: null, cost_usd: null, result: null, event_id: e.event_id }); break
    case 'tool.completed': case 'tool.failed': case 'tool.refused':
      patch(`tc-${e.tool_call_id}`, (it) => (it.kind === 'tool' ? { ...it, state: e.type === 'tool.completed' ? 'completed' : e.type === 'tool.failed' ? 'failed' : 'refused', ended_at: e.at, duration_ms: num(p.duration_ms), rows: num(p.rows), cost_usd: num(p.cost_usd), result: str(p.result_summary) ?? str(p.message) ?? str(p.error_code) ?? str(p.refusal_code) } : it))
      break
    case 'plan.proposed': push({ kind: 'plan', key: `pl-${str(p.artifact_id)}`, artifact_id: str(p.artifact_id) ?? '', steps: (p.steps as PlanStep[]) ?? [], estimate: (p.estimate as CostEstimate) ?? null, hash: str(p.plan_hash_prefix) ?? '', state: 'proposed', at: e.at, event_id: e.event_id }); break
    case 'plan.approved': case 'plan.rejected': patch(`pl-${str(p.artifact_id)}`, (it) => (it.kind === 'plan' ? { ...it, state: e.type === 'plan.approved' ? 'approved' : 'rejected' } : it)); break
    case 'approval.requested': {
      const a = p.approval as ApprovalRequest
      if (a?.approval_id) push({ kind: 'approval', key: `ap-${a.approval_id}`, approval: a, state: 'requested', expires_ms: expiryMs(e.at, a.expires_at), at: e.at, event_id: e.event_id })
      break
    }
    case 'approval.granted': case 'approval.denied': case 'approval.expired': case 'approval.invalidated': case 'approval.consumed': {
      const state = e.type.split('.')[1] as 'granted' | 'denied' | 'expired' | 'invalidated' | 'consumed'
      patch(`ap-${str(p.approval_id)}`, (it) => (it.kind === 'approval' ? { ...it, state } : it))
      break
    }
    case 'artifact.created': push({ kind: 'artifact', key: `ar-${str(p.artifact_id)}`, artifact_id: str(p.artifact_id) ?? '', artifact_kind: str(p.kind) ?? 'artifact', title: str(p.title) ?? 'Artifact', status: str(p.status) ?? 'draft', version: num(p.version) ?? 1, at: e.at, event_id: e.event_id }); break
    case 'artifact.updated': patch(`ar-${str(p.artifact_id)}`, (it) => (it.kind === 'artifact' ? { ...it, status: str(p.status) ?? it.status, version: num(p.version) ?? it.version } : it)); break
    case 'ui.intent': push({ kind: 'intent', key: `ui-${e.event_id}`, label: str(p.label) ?? 'Opened', intent: str(p.intent) ?? '', params: (p.params as Record<string, unknown>) ?? {}, at: e.at, event_id: e.event_id }); break
    case 'usage.settled': v.accrued_usd = num(p.accrued_usd) ?? v.accrued_usd; break
    default: break
  }
  let current: string | null = null
  for (const it of v.items) if (it.kind === 'tool' && it.state === 'running') current = it.label
  v.current = current
  return v
}

export function reduceRun(run_id: string, events: AgentEvent[]): RunView {
  let v = emptyRun(run_id)
  for (const e of events) v = applyRunEvent(v, e)
  return v
}

export const runIsTerminal = (v: RunView) => RUN_TERMINAL_STATES.includes(v.state)

export const RUN_STATE_LABEL: Record<RunState, string> = {
  created: 'Starting', planning: 'Planning', awaiting_plan_approval: 'Waiting on you · plan', running: 'Working', waiting_tool: 'Waiting on a child run', awaiting_approval: 'Waiting on you · approval',
  needs_input: 'Needs your input', paused: 'Paused', completed: 'Done', completed_partial: 'Done · partial', budget_exhausted: 'Stopped · budget', cancelled: 'Cancelled', failed: 'Failed', failed_retryable: 'Failed · can resume', expired: 'Expired',
}
