/**
 * CONVERSATION INTELLIGENCE (shadow) — read model for the operator review panel.
 *
 * Sources of truth (server; nothing here is invented):
 *   GET  /api/cockpit/agent/conversation-ai/shadow    shadow decision records
 *        (public.conversation_ai_shadow_decisions; { available: false } while not applied)
 *   GET  /api/cockpit/agent/conversation-ai/control   every shadow gate, runtime limits +
 *        heartbeat, the conversation.decide kind, budget caps + spend, recent jobs
 *   POST /api/cockpit/agent/conversation-ai/control   { action: 'emergency_stop' | 'pause_kind', confirm: true }
 *        named operator only; the server calls agent.runtime_emergency_stop /
 *        agent.runtime_pause_kind. Neither control can turn anything on.
 *
 * No fixture is reachable from here: when the server has no records the panel says so.
 * Nothing here can send. Every draft is labelled "Draft — not sent (shadow)".
 */
import { useSyncExternalStore } from 'react'
import { callBackend } from '../../../lib/api/backendClient'

export const SHADOW_ENDPOINT = '/api/cockpit/agent/conversation-ai/shadow'
export const CONTROL_ENDPOINT = '/api/cockpit/agent/conversation-ai/control'
export const DRAFT_LABEL = 'Draft — not sent (shadow)'

export type Outcome = 'NO_RESPONSE' | 'UPDATE_ONLY' | 'REPLY_CANDIDATE' | 'ESCALATE_TO_SONNET' | 'NEEDS_REVIEW' | 'SUPPRESS'
export interface ShadowFact { fact: string; value: string | number | boolean; source_message_id: string; confidence: number }
export interface ShadowCall { model: string | null; route?: string; usd: number; latency_ms: number; input_tokens?: number | null; output_tokens?: number | null; valid?: boolean | null; stop_reason?: string | null; errors?: string[] }
export interface ShadowContextSummary {
  eligibility?: { blocked: boolean; reasons: string[]; outside_window: boolean | null; in_session: boolean | null } | null
  stage?: { stage: string; rationale?: string } | null
  do_not_ask?: string[]
  facts?: string[]
  message_count?: number
  trace?: { path?: string | null; escalation_triggers?: string[]; contradictions?: string[]; errors?: string[] } | null
}
export interface ShadowRecord {
  record_version: string
  idempotency_key: string
  inbound_message_id: string
  thread_ref: string | null
  created_at: string
  seller_message_masked: string
  our_last_message_masked?: string
  understood: { intent: string; seller_interest: string; confidence: number }
  facts: { extracted: ShadowFact[]; already_known: string[] }
  stage_evidence: { stage: string; evidence_message_ids: string[]; rationale: string }
  decision: { contract_version: string; outcome: Outcome; next_objective: string; response_needed: boolean; escalation_required: boolean; escalation_reason: string | null; send_permission_requested: boolean; send_permission_granted: false; source_message_ids: string[]; fail_closed?: { produced_by: string; errors: string[] } | null }
  model: { path: string; models: string[]; calls: ShadowCall[] }
  draft: { text: string; chars: number; monetary_amounts: Array<{ raw: string; amount: number | null }>; needs_approval: boolean } | null
  validation: { status: 'validated_draft' | 'rejected_with_reasons' | 'not_applicable'; reasons: string[]; question_kind?: string | null }
  send_status: 'not_sent_shadow'
  cost: { haiku_usd: number; sonnet_usd: number; other_usd: number; total_usd: number }
  latency_ms: number | null
  policy_code: string | null
  context_summary?: ShadowContextSummary | null
  deterministic_engine?: { intent?: string | null; compliance_flag?: string | null } | null
  before?: { recorded_intent: string | null; queued_reply: Array<{ use_case: string; status: string }> }
}

export interface ControlJob {
  job_id: string
  state: string
  attempt: number
  max_attempts: number
  trigger: string | null
  created_at: string | null
  claimed_at: string | null
  heartbeat_at: string | null
  next_attempt_at: string | null
  ended_at: string | null
  lease_owner: string | null
  lease_until: string | null
  budget_cap_usd: number
  deterministic_intent: string | null
  inbound_message_id: string | null
  result: { code: string | null; outcome: string | null; validation_status: string | null; path: string | null; cost_usd: number | null } | null
  error_code: string | null
  wall_ms: number | null
}
export type GateKey = 'env_shadow' | 'env_runtime' | 'db_runtime' | 'emergency_stop_clear' | 'kind_enabled' | 'spend_enabled'
export interface ControlState {
  mode: 'shadow'
  send_path: 'none'
  shadow: { on: boolean; state: 'on' | 'off' | 'unknown'; gates: Record<GateKey, boolean | null> }
  flags: { ai_conversation_shadow_enabled: boolean; agent_runtime_enabled: boolean; agent_enabled: boolean; cron_agent_runtime_enabled: boolean | null }
  runtime: {
    runtime_enabled: boolean; emergency_stop: boolean; emergency_stop_at: string | null; max_concurrency_global: number | null; tick_max_jobs: number | null; lease_seconds: number | null
    open: Record<string, number>; ended_24h: Record<string, number>
    heartbeat: { worker_id: string | null; last_tick_at: string | null; age_s: number | null; ticks: number | null } | null
  } | null
  kind: { configured: boolean; armed: boolean; enabled: boolean; max_concurrency: number | null; event_budget_cap_usd: number | null }
  budget: { spend_enabled: boolean; day_cap_usd: number | null; cycle_cap_usd: number | null; run_cap_usd: number | null; spent_day_usd: number; spent_cycle_usd: number; spent_day_kind_usd: number; per_event_reserve_usd: number | null } | null
  jobs: ControlJob[]
  errors: string[]
}
export type ControlAction = 'emergency_stop' | 'pause_kind'

export interface IntelState {
  open: boolean
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  records: ShadowRecord[]
  selectedKey: string | null
  filter: Outcome | 'ALL'
  note: string | null
  control: ControlState | null
  controlStatus: 'idle' | 'loading' | 'ready' | 'error'
  controlNote: string | null
}

const INITIAL: IntelState = { open: false, status: 'idle', records: [], selectedKey: null, filter: 'ALL', note: null, control: null, controlStatus: 'idle', controlNote: null }
let state: IntelState = INITIAL
const subs = new Set<() => void>()
const emit = () => { for (const s of subs) s() }
export function setIntel(patch: Partial<IntelState>) { state = { ...state, ...patch }; emit() }
export const getIntel = () => state
export function resetIntelForTest() { state = INITIAL; emit() }
export function useIntel(): IntelState {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb) } }, getIntel, getIntel)
}

const upstreamCode = (r: { error?: string; upstream?: unknown }) => {
  const up = r.upstream && typeof r.upstream === 'object' ? (r.upstream as Record<string, unknown>) : {}
  return (typeof up.error === 'string' && up.error) || (typeof up.code === 'string' && up.code) || r.error || 'REQUEST_FAILED'
}

/** The live shadow records. Never a fixture. */
export async function loadIntel(): Promise<void> {
  setIntel({ status: 'loading', note: null })
  const r = await callBackend<{ ok: boolean; available: boolean; records: ShadowRecord[]; code?: string }>(`${SHADOW_ENDPOINT}?limit=100`)
  if (r.ok && r.data?.available) {
    const records = Array.isArray(r.data.records) ? r.data.records : []
    const keep = records.some((x) => x.idempotency_key === state.selectedKey) ? state.selectedKey : records[0]?.idempotency_key ?? null
    setIntel({ status: 'ready', records, selectedKey: keep })
    return
  }
  const code = r.ok ? r.data?.code ?? 'SHADOW_UNAVAILABLE' : upstreamCode(r)
  setIntel({
    status: r.ok ? 'unavailable' : 'error', records: [], selectedKey: null,
    note: code === 'SHADOW_TABLE_NOT_APPLIED' ? 'The shadow table is not applied yet (PROPOSED migration awaiting approval). No records exist.' : `Shadow records could not be read (${code}).`,
  })
}

/** Gates, budget, kind, recent jobs. */
export async function loadControl(): Promise<void> {
  setIntel({ controlStatus: 'loading' })
  const r = await callBackend<ControlState & { ok: boolean }>(CONTROL_ENDPOINT, { timeoutMs: 15_000 })
  if (r.ok && r.data && r.data.mode === 'shadow') {
    setIntel({ control: r.data, controlStatus: 'ready' })
    return
  }
  setIntel({ controlStatus: 'error', controlNote: `Runtime state could not be read (${r.ok ? 'BAD_RESPONSE' : upstreamCode(r)}).` })
}

export const CONTROL_LABEL: Record<ControlAction, string> = { emergency_stop: 'Emergency stop', pause_kind: 'Pause conversation shadow' }

/** Operator control: the server calls agent.runtime_emergency_stop / agent.runtime_pause_kind. Throws on refusal (the confirm dialog shows it). */
export async function runControl(action: ControlAction, reason?: string): Promise<void> {
  const r = await callBackend<{ ok: boolean; error?: string; code?: string }>(CONTROL_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, confirm: true, reason: reason ?? null }),
    timeoutMs: 20_000,
  })
  if (!r.ok || r.data?.ok !== true) {
    const code = r.ok ? r.data?.code || r.data?.error || 'REFUSED' : upstreamCode(r)
    const msg = `${CONTROL_LABEL[action]} was refused (${code}). Nothing changed.`
    setIntel({ controlNote: msg })
    throw new Error(msg)
  }
  setIntel({ controlNote: `${CONTROL_LABEL[action]} applied.` })
  await loadControl()
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  NO_RESPONSE: 'No response', UPDATE_ONLY: 'Update only', REPLY_CANDIDATE: 'Reply candidate', ESCALATE_TO_SONNET: 'Escalated', NEEDS_REVIEW: 'Needs review', SUPPRESS: 'Suppress',
}
export const STAGE_LABEL: Record<string, string> = {
  S1_ownership: 'S1 · Ownership', S2_interest: 'S2 · Interest', S3_asking_price: 'S3 · Asking price', S4_condition: 'S4 · Condition', S5_offer: 'S5 · Offer (human)', nurture: 'Nurture', closed: 'Closed', unknown: 'Unknown',
}
export const JOB_STATE_LABEL: Record<string, string> = {
  queued: 'Queued', claimed: 'Claimed', running: 'Running', completed: 'Completed', waiting_for_approval: 'Waiting for approval', paused: 'Paused',
  retrying: 'Retrying', failed: 'Failed', cancelled: 'Cancelled', budget_blocked: 'Budget blocked', dead_letter: 'Dead letter',
}
export const GATE_LABEL: Record<GateKey, string> = {
  env_shadow: 'AI_CONVERSATION_SHADOW_ENABLED', env_runtime: 'AGENT_RUNTIME_ENABLED + AGENT_ENABLED', db_runtime: 'DB runtime_enabled',
  emergency_stop_clear: 'Emergency stop clear', kind_enabled: 'conversation.decide armed + enabled', spend_enabled: 'Model spend enabled',
}
export const humanize = (s: string | null | undefined) => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

export function visibleRecords(s: IntelState): ShadowRecord[] {
  return s.filter === 'ALL' ? s.records : s.records.filter((r) => r.decision.outcome === s.filter)
}

/** The runtime job that produced a record (joined server-side on the inbound message id). */
export function jobForRecord(control: ControlState | null, r: ShadowRecord): ControlJob | null {
  if (!control) return null
  return control.jobs.find((j) => j.inbound_message_id != null && j.inbound_message_id === r.inbound_message_id) ?? null
}

/** Why the engine chose not to reply / escalated — read from the record only. */
export function noResponseReason(r: ShadowRecord): string | null {
  const d = r.decision
  if (d.fail_closed) return `Fail-closed (${d.fail_closed.produced_by}): ${d.fail_closed.errors.slice(0, 3).join(', ') || 'no detail'}`
  if (d.escalation_required) return `Escalated: ${humanize(d.escalation_reason) || 'no reason recorded'}`
  if (d.outcome === 'NO_RESPONSE' || d.outcome === 'UPDATE_ONLY' || d.outcome === 'SUPPRESS' || !d.response_needed) {
    const el = r.context_summary?.eligibility
    if (el?.blocked && el.reasons?.length) return `Not eligible: ${el.reasons.slice(0, 3).map(humanize).join(', ')}`
    return `${OUTCOME_LABEL[d.outcome]} — next ${humanize(d.next_objective)}`
  }
  if (d.outcome === 'NEEDS_REVIEW') return `Needs review — next ${humanize(d.next_objective)}`
  return null
}

/** Totals for the header strip (cost, latency, outcome mix) — computed from the records shown. */
export function summarize(records: ShadowRecord[]) {
  const total = records.reduce((a, r) => a + (r.cost?.total_usd || 0), 0)
  const lat = records.map((r) => r.latency_ms || 0).filter((n) => n > 0).sort((a, b) => a - b)
  const p = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * (lat.length - 1) + 0.5))] : null)
  const validated = records.filter((r) => r.validation.status === 'validated_draft').length
  return { count: records.length, total_usd: total, p50_ms: p(0.5), p95_ms: p(0.95), validated }
}
