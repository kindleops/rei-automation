/**
 * CONVERSATION INTELLIGENCE (shadow) — read model for the operator review panel.
 *
 * Source of truth: GET /api/cockpit/agent/conversation-ai/shadow (read-only; reads the
 * PROPOSED table public.conversation_ai_shadow_decisions). While the table is not
 * applied the route answers { available: false } and the panel says so.
 *
 * DEV-ONLY fixture: when — and only when — import.meta.env.DEV is true AND
 * VITE_LC_CONV_AI_SHADOW_FIXTURE === '1', the panel may show masked replay records
 * from conversation-intel-fixture.ts, always labelled FIXTURE. The import is dynamic
 * and behind the same inline expression, so production builds never include it.
 *
 * Nothing here can send: there is no send action in this module. Every record's
 * send status is "not sent — shadow".
 */
import { useSyncExternalStore } from 'react'
import { callBackend } from '../../../lib/api/backendClient'

export const SHADOW_ENDPOINT = '/api/cockpit/agent/conversation-ai/shadow'
export const CONV_AI_FIXTURE_ENABLED: boolean = import.meta.env.DEV && import.meta.env.VITE_LC_CONV_AI_SHADOW_FIXTURE === '1'

export type Outcome = 'NO_RESPONSE' | 'UPDATE_ONLY' | 'REPLY_CANDIDATE' | 'ESCALATE_TO_SONNET' | 'NEEDS_REVIEW' | 'SUPPRESS'
export interface ShadowFact { fact: string; value: string | number | boolean; source_message_id: string; confidence: number }
export interface ShadowCall { model: string | null; route?: string; usd: number; latency_ms: number; input_tokens?: number | null; output_tokens?: number | null; valid?: boolean | null }
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
  before?: { recorded_intent: string | null; queued_reply: Array<{ use_case: string; status: string }> }
}

export type IntelSource = 'live' | 'fixture'
export interface IntelState {
  open: boolean
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  source: IntelSource | null
  records: ShadowRecord[]
  selectedKey: string | null
  filter: Outcome | 'ALL'
  note: string | null
}

let state: IntelState = { open: false, status: 'idle', source: null, records: [], selectedKey: null, filter: 'ALL', note: null }
const subs = new Set<() => void>()
const emit = () => { for (const s of subs) s() }
export function setIntel(patch: Partial<IntelState>) { state = { ...state, ...patch }; emit() }
export const getIntel = () => state
export function useIntel(): IntelState {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb) } }, getIntel, getIntel)
}

/** The live records; never a fixture unless the explicit dev flag is on (and then labelled). */
export async function loadIntel(): Promise<void> {
  setIntel({ status: 'loading', note: null })
  const r = await callBackend<{ ok: boolean; available: boolean; records: ShadowRecord[]; code?: string }>(`${SHADOW_ENDPOINT}?limit=100`)
  if (r.ok && r.data?.available) {
    const records = Array.isArray(r.data.records) ? r.data.records : []
    setIntel({ status: 'ready', source: 'live', records, selectedKey: records[0]?.idempotency_key ?? null })
    return
  }
  const code = r.ok ? r.data?.code ?? 'SHADOW_UNAVAILABLE' : r.error
  if (import.meta.env.DEV && import.meta.env.VITE_LC_CONV_AI_SHADOW_FIXTURE === '1') {
    const { CONVERSATION_INTEL_FIXTURE } = await import('./conversation-intel-fixture')
    setIntel({ status: 'ready', source: 'fixture', records: CONVERSATION_INTEL_FIXTURE, selectedKey: CONVERSATION_INTEL_FIXTURE[0]?.idempotency_key ?? null, note: `Live shadow records unavailable (${code}). Showing the dev fixture.` })
    return
  }
  setIntel({ status: r.ok ? 'unavailable' : 'error', source: null, records: [], selectedKey: null, note: code === 'SHADOW_TABLE_NOT_APPLIED' ? 'The shadow table is not applied yet (PROPOSED migration awaiting approval). No records exist.' : `Shadow records could not be read (${code}).` })
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  NO_RESPONSE: 'No response', UPDATE_ONLY: 'Update only', REPLY_CANDIDATE: 'Reply candidate', ESCALATE_TO_SONNET: 'Escalated', NEEDS_REVIEW: 'Needs review', SUPPRESS: 'Suppress',
}
export const STAGE_LABEL: Record<string, string> = {
  S1_ownership: 'S1 · Ownership', S2_interest: 'S2 · Interest', S3_asking_price: 'S3 · Asking price', S4_condition: 'S4 · Condition', S5_offer: 'S5 · Offer (human)', nurture: 'Nurture', closed: 'Closed', unknown: 'Unknown',
}
export const humanize = (s: string | null | undefined) => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

export function visibleRecords(s: IntelState): ShadowRecord[] {
  return s.filter === 'ALL' ? s.records : s.records.filter((r) => r.decision.outcome === s.filter)
}

/** Totals for the header strip (cost, latency, outcome mix) — computed from the records shown. */
export function summarize(records: ShadowRecord[]) {
  const total = records.reduce((a, r) => a + (r.cost?.total_usd || 0), 0)
  const lat = records.map((r) => r.latency_ms || 0).filter((n) => n > 0).sort((a, b) => a - b)
  const p = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * (lat.length - 1) + 0.5))] : null)
  const validated = records.filter((r) => r.validation.status === 'validated_draft').length
  return { count: records.length, total_usd: total, p50_ms: p(0.5), p95_ms: p(0.95), validated }
}
