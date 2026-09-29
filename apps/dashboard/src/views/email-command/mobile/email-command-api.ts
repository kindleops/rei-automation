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
  next: { at: string; action: string | null; sequence: number | null; why: Why | null; queue_id: string } | null
  approvals: Array<{ queue_id: string; subject: string; why: Why | null }>
  last_failure: { code: string; at: string } | null
  operator_unread: boolean
}

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
  | { kind: 'outbound'; id: string; at: string; from: { email: string | null; name: string | null }; to: string; subject: string; text: string | null; html: string | null; status: string; engagement: Engagement; automated: boolean; action: string | null; sequence: number | null; why: Why | null; cancel_reason: string | null; attachments: Attachment[] }
  | { kind: 'inbound'; id: string; at: string; from: { email: string; name: string | null }; subject: string | null; reply: string; quoted: boolean; signature: string | null; html: string | null; status: string; understood: { assertions?: Array<{ type: string; value?: unknown; excerpt: string }>; flags?: string[]; applied?: Array<{ type: string; ok: boolean }> }; attachments: Attachment[] }
  | { kind: 'system'; at: string; label: string; source: string | null }

export interface ThreadRoom { thread: ThreadSummary; sms_thread_key: string | null; items: Item[] }

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

export interface ActionResult { ok: boolean; code?: string; message?: string; stopped?: number; duplicate?: boolean }

export async function postThreadAction(id: string, action: string, fields: Record<string, unknown> = {}): Promise<ActionResult> {
  if (isDemoMode()) return action === 'mark_read' ? { ok: true } : DEMO_REFUSAL
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
