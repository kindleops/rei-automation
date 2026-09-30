import { callBackend } from '../../../lib/api/backendClient'

/**
 * EMAIL COMMAND — client contract for /api/cockpit/email/command.
 * The server derives every operating state, context line, next action and
 * delivery status (apps/api/src/lib/domain/email/email-command-model.js);
 * this file only types them. A failed read is an error, never an empty inbox.
 */

export type OpState = 'needs_you' | 'system_handling' | 'waiting' | 'failed' | 'unresolved' | 'done'
export type Ball = 'you' | 'leadcommand' | 'them' | null
export type Category = 'seller' | 'title' | 'buyer' | 'lender' | 'attorney' | 'agent' | 'vendor' | 'internal' | 'unresolved' | 'other'

export interface Why { why?: string | null; category?: string; action?: string; sequence?: number; due_at?: string; template_version?: string; use_case?: string; audit_reason?: string | null; [k: string]: unknown }

export interface ClosingCtx { kind: 'closing'; closing_case_id: string; property_address: string | null; waiting_for: string | null; scheduled_closing_date: string | null; closing_tz: string | null; automation_paused: boolean; open: string }
export interface SellerCtx { kind: 'seller'; stage: string; stage_label: string | null; seller_name: string | null; property_address: string | null; known_facts: Array<{ key: string; label: string; value: string | number }>; sms_thread_key: string | null; contactability: string | null; open_sms: string | null; open_deal: string | null }

export interface ThreadSummary {
  id: string
  category: Category
  counterparty: { name: string | null; email: string | null; role: string }
  subject: string | null
  property_address: string | null
  last_message: { at: string | null; direction: 'inbound' | 'outbound' | null; preview: string | null }
  needs: { code: string; reason: string; since: string } | null
  resolution: 'resolved' | 'ambiguous' | 'unresolved'
  contact_preference: 'email' | 'sms' | null
  context: ClosingCtx | SellerCtx | null
  state: OpState
  ball: Ball
  automation: string
  next: { at: string; action: string | null; sequence: number | null; why: Why | null; queue_id: string; status?: OutboxStatus | null; attempts?: number; held_reason?: string | null } | null
  approvals: Array<{ queue_id: string; subject: string; why: Why | null }>
  last_failure: { code: string; at: string } | null
  operator_unread: boolean
  /* desktop read-model fields (bounded, read-only; absent on older payloads) */
  market?: string | null
  failure?: Failure | null
  escalated?: boolean
  origin?: { automated: number; manual: number }
}

/** Outbox state of the next pending message — the only thing an "automation is replying" marker may claim. */
export type OutboxStatus = 'sending' | 'retrying' | 'held' | 'scheduled' | 'queued'
export interface Failure { class: 'delivery' | 'transport' | 'suppression' | 'blocked' | 'provider' | 'unknown'; label: string; what: string; code: string | null; retry: 'none' | 'exhausted'; attempts: number; operator_must_act: boolean; action: string; at: string | null }

export interface Home {
  counts: Record<OpState, number>
  needs_you: ThreadSummary[]
  system_handling: ThreadSummary[]
  waiting: ThreadSummary[]
  failed: ThreadSummary[]
  unresolved: ThreadSummary[]
  recent: ThreadSummary[]
  delivery: { send_enabled: boolean; operator_switch: boolean; heartbeat_at: string | null; health: { status: string; issues: string[]; at: string } | null }
  truncated: boolean
  parties?: { seller: number; buyer: number; title: number; closings: number }
  automation_counts?: { active: number; escalated: number; manual: number }
}

export interface Engagement {
  sent_at: string | null; accepted_at: string | null; delivered_at: string | null
  open_signals: number; likely_human_opens: number; first_open_at: string | null; last_open_at: string | null
  clicks: number; first_click_at: string | null; last_click_at: string | null
  replied_at: string | null; bounce: { type: string; at: string; reason: string | null } | null
  unsubscribed_at: string | null; complaint_at: string | null
}
export interface Attachment { id: string; filename: string; content_type: string; size_bytes: number | null; doc_type: string | null; confidence: number | null; review_state: string; fetch_status: string; routed: { type: string; id: string } | null; url: string | null }
export type Item =
  | { kind: 'outbound'; id: string; at: string; from: { email: string | null; name: string | null }; to: string; subject: string; text: string | null; html: string | null; status: string; engagement: Engagement; automated: boolean; action: string | null; sequence: number | null; why: Why | null; cancel_reason: string | null; attachments: Attachment[]; provenance?: Provenance; failure?: Failure | null; retry_count?: number }
  | { kind: 'inbound'; id: string; at: string; from: { email: string; name: string | null }; subject: string | null; reply: string; quoted: boolean; signature: string | null; html: string | null; status: string; understood: { assertions?: Array<{ type: string; value?: unknown; excerpt: string }>; flags?: string[]; applied?: Array<{ type: string; ok: boolean }> }; attachments: Attachment[] }
  | { kind: 'system'; at: string; label: string; source: string | null }

export interface Provenance { kind: 'operator' | 'workflow' | 'system' | 'unknown'; label: string | null; workflow: string | null }

/** One explanatory line; `{at}` in the text is replaced by the operator's own rendering of `at`. */
export interface WhyLine { text: string; at: string | null; fmt: 'ago' | 'until' | 'stamp' | null; tone: 'good' | 'warn' | 'bad' | 'auto' | 'muted' | null }
export interface ThreadIntelligence {
  summary: {
    intent: { label: string; source: string; at: string | null } | null
    sentiment: null
    stage: { label: string | null; moved: 'moved' | 'stayed' | null; from: string | null; at: string | null; closing?: boolean } | null
    lead_state: string | null
    next_action: { label: string; at: string | null; status: string | null } | null
    last_reply_at: string | null
    channel: { owner: 'you' | 'leadcommand' | 'them' | null; preference: 'email' | 'sms' | null; sms_linked: boolean }
  }
  automation: { mode: string; label: string; armed: Array<{ queue_id: string; label: string; at: string | null; status: OutboxStatus | null; sequence: number | null }>; next_send_at: string | null; approvals: number; send_enabled: boolean | null; operator_switch: boolean | null; taken_over_at: string | null }
  why: { title: string; lines: WhyLine[] } | null
  links: Array<{ system: string; label: string; detail: string | null; href: string; thread_key?: string }>
  party: { name: string | null; email: string | null; role: string | null; resolution: string | null; method: string | null; candidates: number }
  property: { address: string | null; market: string | null; property_id: string | null } | null
  delivery: { status: string; at: string | null; subject: string | null; from: string | null; domain: string | null; provider: string | null; provenance: Provenance; engagement: { delivered_at: string | null; open_signals: number; likely_human_opens: number; clicks: number; replied_at: string | null; bounce: { type: string; at: string; reason: string | null } | null } } | null
  activity: { inbound: number; outbound: number; planned: number; automated: number; manual: number; attachments: number; first_at: string | null; last_at: string | null }
}

export interface ThreadRoom { thread: ThreadSummary; sms_thread_key: string | null; items: Item[]; intelligence?: ThreadIntelligence }

export interface MessageTelemetry {
  message: { id: string; logical_id: string; subject: string; to: string; from: string | null; sender: string | null; sending_domain: string | null; provider: string; provider_message_id: string | null; lane: string | null; origin: string | null; source: string | null; campaign_id: string | null; sequence_step: number | null; template: string | null; template_version: string | null; status: string; scheduled_for: string | null; sent_at: string | null; retry_count: number | null; why: Why | null; cancel_reason: string | null }
  engagement: Engagement
  links: Array<{ id: string; link_index: number; destination_url: string; clicks: number }>
  events: Array<{ event_type: string; event_at: string; event_source: string; provider: string | null; signal_class: string | null; reason: string | null; has_provider_payload: boolean }>
}

const BASE = '/api/cockpit/email/command'

/* ── demo (?demo=1): the REAL read model over scenario rows, labelled, write-proof ── */
export const isDemoMode = () => { try { return new URLSearchParams(window.location.search).get('demo') === '1' } catch { return false } }
type DemoFile = { generatedAt: string; home: Home; threads: Record<string, ThreadRoom>; messages: Record<string, MessageTelemetry> }
let demoCache: Promise<DemoFile> | null = null
function shift<T>(v: T, delta: number): T {
  if (typeof v === 'string') return (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? new Date(Date.parse(v) + delta).toISOString() : v) as T
  if (Array.isArray(v)) return v.map((x) => shift(x, delta)) as T
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shift(x, delta)])) as T
  return v
}
const loadDemo = () => (demoCache ??= import('./email-demo.generated.json').then((m) => {
  const raw = (m.default ?? m) as unknown as DemoFile
  return shift(raw, Date.now() - Date.parse(raw.generatedAt))
}))

async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await callBackend<T & { ok: boolean; error?: string }>(path, { signal, timeoutMs: 30_000 })
  if (!res.ok) throw new Error((res as { error?: string }).error || 'email_command_unavailable')
  const body = res.data as (T & { ok: boolean; error?: string }) | undefined
  if (!body || body.ok === false) throw new Error(body?.error || 'email_command_unavailable')
  return body
}

export const fetchHome = async (params: { filter?: string; q?: string } = {}, signal?: AbortSignal): Promise<Home> => {
  if (isDemoMode()) return (await loadDemo()).home
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as Array<[string, string]>).toString()
  return read<Home>(`${BASE}${qs ? `?${qs}` : ''}`, signal)
}
export const fetchThread = async (id: string, signal?: AbortSignal): Promise<ThreadRoom> => {
  if (isDemoMode()) { const r = (await loadDemo()).threads[id]; if (!r) throw new Error('not_found'); return r }
  return read<ThreadRoom>(`${BASE}/threads/${encodeURIComponent(id)}`, signal)
}
export const fetchMessage = async (id: string): Promise<MessageTelemetry> => {
  if (isDemoMode()) { const r = (await loadDemo()).messages[id]; if (!r) throw new Error('not_found'); return r }
  return read<MessageTelemetry>(`${BASE}/messages/${encodeURIComponent(id)}`)
}
const DEMO_REFUSAL = { ok: false, code: 'DEMO_READ_ONLY', message: 'Demo data — nothing is written or sent.' }

export interface ActionResult { ok: boolean; code?: string; message?: string; stopped?: number; duplicate?: boolean; demo?: boolean }

export async function postThreadAction(id: string, action: string, fields: Record<string, unknown> = {}): Promise<ActionResult> {
  // Demo: the handoff is shown locally (nothing is written); every other write is refused.
  if (isDemoMode()) return ['mark_read', 'take_over', 'return_to_system'].includes(action) ? { ok: true, demo: true } : DEMO_REFUSAL
  const res = await callBackend<ActionResult>(`${BASE}/threads/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify({ action, ...fields }) })
  if (!res.ok) {
    const body = (res.upstream as { data?: ActionResult } | undefined)?.data ?? (res.upstream as ActionResult | undefined)
    return body && typeof body === 'object' && 'ok' in body ? body : { ok: false, code: 'REQUEST_FAILED', message: res.message || res.error || 'Not accepted' }
  }
  return (res.data as ActionResult) ?? { ok: false, code: 'EMPTY_RESPONSE' }
}

export interface SendResult { ok: boolean; queued?: boolean; send_enabled?: boolean; status?: string; error?: string; message?: string; duplicate?: boolean }

export async function sendReply(input: { thread_id: string; to: string; subject: string; body: string; idempotency_key: string; scheduled_for?: string | null }): Promise<SendResult> {
  if (isDemoMode()) return { ok: false, error: 'DEMO_READ_ONLY', message: DEMO_REFUSAL.message }
  const html = input.body.split(/\n{2,}/).map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`).join('')
  const res = await callBackend<SendResult>(`${BASE}/send`, { method: 'POST', body: JSON.stringify({ thread_id: input.thread_id, to: input.to, subject: input.subject, html_body: html, text_body: input.body, idempotency_key: input.idempotency_key, scheduled_for: input.scheduled_for || undefined }) })
  if (!res.ok) {
    const body = (res.upstream as SendResult | undefined)
    return body && typeof body === 'object' && 'ok' in body ? body : { ok: false, error: res.error || 'send_failed', message: res.message }
  }
  return (res.data as SendResult) ?? { ok: false, error: 'empty_response' }
}
