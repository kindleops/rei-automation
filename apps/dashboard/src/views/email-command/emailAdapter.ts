import { callBackend } from '../../lib/api/backendClient'
import type {
  EmailOverview,
  EmailRecord,
  EmailThread,
  EmailThreadDetail,
  BrevoHealth,
  EmailTemplate,
  EmailCampaignDraft,
  SuppressionEntry,
  ComposerPayload,
  SaveDraftResult,
  RecordFilters,
  InboxFilters,
} from './email.types'

// ── Mock data (fallback on backend error) ─────────────────────────────────────

/**
 * EVERY READ REPORTS FAILURE. NOTHING FABRICATES A FALLBACK.
 *
 * This module used to hold MOCK_OVERVIEW — nine zeros with
 * brevo_status: 'disconnected' — and returned it whenever the request failed
 * or the body shape was unexpected. Combined with the API answering 200 with
 * its own zeros, Email Command showed an operator a confident dashboard of
 * "0 emails, 0 eligible, 0 suppressed" over a 165,655-row corpus. The other
 * readers did the same with `[]`, and getEmailThread built an entire fake
 * empty thread ("(no subject)", no recipient, 0 messages) that could not be
 * told apart from a real one.
 *
 * §30/§44: an error must never render as empty. Each reader now returns an
 * explicit result and the surface decides what to say.
 */
export type EmailLoad<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * These endpoints return the payload FLAT (`{ ok: true, records: [...] }`),
 * not wrapped in `data` the way the buyer-match routes do — verified against
 * production. `callBackend` hands back the whole body as `res.data`, so the
 * flat body is one level in. Both shapes are accepted, but an envelope-level
 * `ok: false` is a failure either way.
 */
const readBody = (res: unknown): EmailLoad<Record<string, any>> => {
  const r = res as { ok?: boolean; status?: number; data?: any; error?: string; message?: string }
  if (!r?.ok) {
    return { ok: false, error: r?.message || r?.error || 'Email request failed' }
  }
  const body = r.data ?? {}
  if (body?.ok === false) {
    return { ok: false, error: body.message || body.error || 'Email request failed' }
  }
  const payload = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body
  return { ok: true, data: payload }
}


// ── Normalizers ───────────────────────────────────────────────────────────────

function normalizeRecord(row: any): EmailRecord {
  return {
    id: row.id ?? row.email_id ?? row.email ?? row.email_address,
    prospect_name: row.prospect_name ?? row.owner_name ?? '',
    owner_name: row.owner_name ?? null,
    email_address: row.email_address ?? row.email ?? '',
    email_rank: Number(row.email_rank ?? 0),
    email_score: Number(row.email_score ?? row.email_score_final ?? 0),
    match_confidence: row.match_confidence ?? row.email_match_confidence ?? 'unknown',
    verified_status: row.verified_status ?? 'unverified',
    brevo_contact_status: row.brevo_contact_status ?? 'unknown',
    suppression_status: row.suppression_status ?? 'none',
    linked_property: row.linked_property ?? row.property_id ?? null,
    property_address: row.property_address ?? null,
    market: row.market ?? null,
    language: row.language ?? 'en',
    last_email_sent: row.last_email_sent ?? row.last_email_sent_at ?? null,
    last_reply: row.last_reply ?? row.last_email_reply_at ?? null,
    eligibility: row.eligibility ?? (row.suppression_status && row.suppression_status !== 'none' ? 'ineligible' : 'eligible'),
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : null,
  }
}

function normalizeThread(row: any): EmailThread {
  return {
    id: row.id ?? row.thread_id ?? '',
    folder: row.folder ?? 'all',
    prospect_name: row.prospect_name ?? '',
    email_address: row.email_address ?? '',
    subject: row.subject ?? '(no subject)',
    last_message_preview: row.last_message_preview ?? row.body_preview ?? '',
    last_message_at: row.last_message_at ?? '',
    message_count: Number(row.message_count ?? 1),
    unread: Boolean(row.unread),
    property_address: row.property_address ?? null,
    market: row.market ?? null,
    has_sms_thread: Boolean(row.has_sms_thread),
    sentiment: row.sentiment ?? 'unknown',
  }
}

function normalizeHealth(raw: any): BrevoHealth {
  return {
    connected: Boolean(raw.connected),
    api_key_valid: Boolean(raw.api_key_valid),
    sender_identities: (raw.sender_identities ?? []).map((s: any) => ({
      name: s.name ?? '',
      email: s.email ?? '',
      active: Boolean(s.active),
      domain_verified: s.domain_verified === true || s.domain_verified === 'verified',
    })),
    domain_auth_status: raw.domain_auth_status ?? 'unknown',
    bounce_rate_7d: Number(raw.bounce_rate_7d ?? 0),
    send_failure_rate_7d: Number(raw.send_failure_rate_7d ?? 0),
    api_latency_ms: raw.api_latency_ms != null ? Number(raw.api_latency_ms) : null,
    webhook_configured: Boolean(raw.webhook_configured),
    last_checked: raw.last_checked ?? new Date().toISOString(),
  }
}

// ── Adapter methods ───────────────────────────────────────────────────────────

export const getEmailOverview = async (): Promise<EmailLoad<EmailOverview>> => {
  const read = readBody(await callBackend('/api/cockpit/email/overview'))
  if (!read.ok) return read
  const d = read.data
  if (d.total_emails === undefined) {
    return { ok: false, error: 'Email overview returned an unexpected shape' }
  }
  return {
    ok: true,
    data: {
      total_emails: Number(d.total_emails ?? 0),
      email_eligible: Number(d.email_eligible ?? 0),
      high_confidence: Number(d.high_confidence ?? 0),
      suppressed: Number(d.suppressed ?? 0),
      bounced: Number(d.bounced ?? 0),
      unsubscribed: Number(d.unsubscribed ?? 0),
      sent_today: Number(d.sent_today ?? 0),
      replies_today: Number(d.replies_today ?? 0),
      ready_for_campaign: Number(d.ready_for_campaign ?? 0),
      brevo_status:
        d.brevo_status === 'connected' || d.brevo_status === 'degraded' || d.brevo_status === 'disconnected'
          ? d.brevo_status
          : 'disconnected',
      last_updated: d.last_updated ?? new Date().toISOString(),
    },
  }
}

export const getEmailRecords = async (
  filters?: Partial<RecordFilters> & {
    limit?: number
    offset?: number
    /** §5/§6 — scope to the operator's current subject, server-side. */
    property_id?: string | null
    master_owner_id?: string | null
  },
): Promise<EmailLoad<{ records: EmailRecord[]; count: number }>> => {
  const qs = new URLSearchParams()
  if (filters?.search) qs.set('search', filters.search)
  if (filters?.eligibility && filters.eligibility !== 'all') qs.set('eligibility', filters.eligibility)
  if (filters?.confidence && filters.confidence !== 'all') qs.set('confidence', filters.confidence)
  if (filters?.suppression && filters.suppression !== 'all') qs.set('suppression', filters.suppression)
  if (filters?.market && filters.market !== 'all') qs.set('market', filters.market)
  // §29 — a page, never the whole 165k corpus.
  qs.set('limit', String(filters?.limit ?? 100))
  if (filters?.offset) qs.set('offset', String(filters.offset))
  if (filters?.property_id) qs.set('property_id', filters.property_id)
  if (filters?.master_owner_id) qs.set('master_owner_id', filters.master_owner_id)

  const read = readBody(await callBackend(`/api/cockpit/email/records?${qs.toString()}`))
  if (!read.ok) return read
  const rows = read.data.records
  if (!Array.isArray(rows)) return { ok: false, error: 'Email records returned an unexpected shape' }
  return {
    ok: true,
    data: {
      records: rows.map(normalizeRecord),
      // §28 — the corpus count from the server, never rows.length.
      count: Number(read.data.count ?? rows.length),
    },
  }
}

export const getEmailThreads = async (
  filters?: Partial<InboxFilters> & { limit?: number; offset?: number },
): Promise<EmailLoad<{ threads: EmailThread[]; count: number }>> => {
  const qs = new URLSearchParams()
  if (filters?.folder && filters.folder !== 'all') qs.set('folder', filters.folder)
  if (filters?.search) qs.set('search', filters.search)
  qs.set('limit', String(filters?.limit ?? 100))
  if (filters?.offset) qs.set('offset', String(filters.offset))

  const read = readBody(await callBackend(`/api/cockpit/email/threads?${qs.toString()}`))
  if (!read.ok) return read
  const rows = read.data.threads
  if (!Array.isArray(rows)) return { ok: false, error: 'Email threads returned an unexpected shape' }
  return {
    ok: true,
    data: { threads: rows.map(normalizeThread), count: Number(read.data.count ?? rows.length) },
  }
}

export const getEmailThread = async (
  threadId: string,
): Promise<EmailLoad<EmailThreadDetail | null>> => {
  const read = readBody(await callBackend(`/api/cockpit/email/threads/${encodeURIComponent(threadId)}`))
  if (!read.ok) return read

  const thread = read.data.thread
  // A thread that does not exist is `null`, NOT a fabricated blank thread.
  if (!thread) return { ok: true, data: null }

  return {
    ok: true,
    data: {
      ...normalizeThread(thread),
      messages: (thread.messages ?? []).map((m: any) => ({
        id: m.id ?? m.message_id ?? '',
        // §9 — direction is read, never defaulted to outbound.
        direction: m.direction === 'inbound' ? 'inbound' : m.direction === 'outbound' ? 'outbound' : 'unknown',
        from_address: m.from_address ?? m.from_email ?? '',
        to_address: m.to_address ?? m.to_email ?? '',
        subject: m.subject ?? '',
        body_preview: m.body_preview ?? '',
        body_html: m.body_html ?? m.html_body ?? null,
        sent_at: m.sent_at ?? null,
        status: m.status ?? null,
        failure_reason: m.failure_reason ?? null,
        opened: Boolean(m.opened),
        clicked: Boolean(m.clicked),
        bounced: Boolean(m.bounced),
      })),
      property_context: thread.property_context ?? null,
      prospect_context: thread.prospect_context ?? null,
      ai_summary: thread.ai_summary ?? null,
      sms_thread_id: thread.sms_thread_id ?? null,
    } as EmailThreadDetail,
  }
}

export const getBrevoHealth = async (): Promise<EmailLoad<BrevoHealth>> => {
  const read = readBody(await callBackend('/api/cockpit/email/brevo-health'))
  if (!read.ok) return read
  const raw = read.data
  if (raw?.provider !== 'brevo' && raw?.connected === undefined) {
    return { ok: false, error: 'Provider health returned an unexpected shape' }
  }
  return { ok: true, data: normalizeHealth(raw) }
}

export const getEmailTemplates = async (): Promise<EmailLoad<EmailTemplate[]>> => {
  const read = readBody(await callBackend('/api/cockpit/email/templates'))
  if (!read.ok) return read
  const rows = read.data.templates
  if (!Array.isArray(rows)) return { ok: false, error: 'Email templates returned an unexpected shape' }
  return {
    ok: true,
    data: rows.map((t: any) => ({
      id: t.id ?? t.template_id ?? t.template_key ?? '',
      name: t.name ?? t.template_id ?? '',
      category: t.category ?? 'first_touch',
      subject: t.subject ?? '',
      body_preview: t.body_preview ?? '',
      body: t.body ?? '',
      merge_fields: Array.isArray(t.merge_fields) ? t.merge_fields : [],
      last_used: t.last_used ?? null,
      usage_count: Number(t.usage_count ?? 0),
    })),
  }
}

/**
 * §24/§27 — THERE IS NO EMAIL CAMPAIGN AUTHORITY.
 *
 * This returned `[]`, which renders as "no campaigns yet" and implies the
 * feature works and is merely empty. No endpoint, table or service answers
 * "which email campaigns exist"; email campaign attribution simply does not
 * exist in this system. Saying so is the honest answer, and §27 forbids
 * showing a folder backed by a nonexistent authority.
 */
export const getEmailCampaigns = async (): Promise<EmailLoad<EmailCampaignDraft[]>> => ({
  ok: false,
  error: 'No email campaign authority exists in this system yet.',
})

/**
 * Suppression, queried on the SERVER.
 *
 * This used to fetch one page of records and filter it in JavaScript for
 * suppression_status !== 'none', so the list was "suppressed rows that
 * happened to be on page one" (§28/§29). Worse, it set
 * `suppressed_at: r.last_email_sent ?? new Date().toISOString()` — inventing
 * "suppressed just now" for any row whose real timestamp was unknown, which is
 * fabricated evidence about a compliance record.
 */
export const getSuppressionList = async (): Promise<EmailLoad<SuppressionEntry[]>> => {
  const read = await getEmailRecords({ suppression: 'suppressed', limit: 200 })
  if (!read.ok) return read
  return {
    ok: true,
    data: read.data.records.map((r) => ({
      id: r.id,
      email_address: r.email_address,
      prospect_name: r.prospect_name || 'Unknown',
      reason: r.suppression_status as any,
      // The real suppression timestamp, or null. Never "now".
      suppressed_at: (r.metadata as any)?.suppressed_at ?? null,
      source: ((r.metadata as any)?.suppression_source ?? 'unknown') as any,
      can_remove: false,
    })),
  }
}

export const saveEmailDraft = async (payload: ComposerPayload): Promise<SaveDraftResult> => {
  const res = await callBackend('/api/cockpit/email/drafts', {
    method: 'POST',
    body: JSON.stringify({
      to: payload.to,
      sender_email: payload.from_identity,
      subject: payload.subject,
      html_body: payload.body,
      template_id: payload.template_id,
      prospect_id: payload.prospect_id,
      property_id: payload.property_id,
    }),
  })
  const body = res as any
  if (body?.ok) {
    return { ok: true, draft_id: body.draft_id ?? undefined, message: body.message ?? 'Draft saved' }
  }
  return { ok: false, message: body?.message ?? body?.error ?? 'Draft save failed' }
}

export interface SendEmailResult {
  ok: boolean
  sent: boolean
  dry_run?: boolean
  no_send?: boolean
  blocked?: boolean
  mode?: string
  message_id?: string
  error?: string
  message?: string
  /** §18 — this exact message was already queued. A no-op, not a send. */
  duplicate?: boolean
  already_queued?: boolean
  queue_key?: string
  status?: string
}

export const sendEmail = async (
  payload: ComposerPayload & { idempotency_key?: string },
): Promise<SendEmailResult> => {
  /**
   * `callBackend` reports transport success for ANY parsed response, including
   * an HTTP 500 carrying `{ ok: false }`. This function used to read
   * `ok: Boolean(res.ok)` off that wrapper, so a server-side refusal could be
   * reported to the composer as a successful call, and the real `error` /
   * `message` (which live one level in) were dropped. readBody checks both
   * levels.
   */
  const res = await callBackend('/api/cockpit/email/manual-send', {
    method: 'POST',
    body: JSON.stringify({
      to: payload.to,
      sender_email: payload.from_identity,
      subject: payload.subject,
      htmlContent: payload.body,
      template_id: payload.template_id || undefined,
      prospect_id: payload.prospect_id || undefined,
      property_id: payload.property_id || undefined,
      idempotency_key: payload.idempotency_key || undefined,
    }),
  })

  const read = readBody(res)
  if (!read.ok) {
    return { ok: false, sent: false, error: read.error, message: read.error }
  }
  const body = read.data
  return {
    ok: Boolean(body?.ok),
    // Never inferred — only the server says a message was sent.
    sent: Boolean(body?.sent),
    dry_run: Boolean(body?.dry_run),
    no_send: Boolean(body?.no_send),
    blocked: Boolean(body?.blocked),
    duplicate: Boolean(body?.duplicate),
    already_queued: Boolean(body?.already_queued),
    queue_key: body?.queue_key ?? undefined,
    status: body?.status ?? undefined,
    mode: body?.mode ?? undefined,
    message_id: body?.message_id ?? undefined,
    error: body?.error ?? undefined,
    message: body?.message ?? undefined,
  }
}

/**
 * §21 — A TEMPLATE WITH UNRESOLVED VARIABLES MUST NOT BE SENDABLE.
 *
 * This substituted only the values it was handed and returned the body as-is,
 * so any variable the caller did not supply survived into the preview — and
 * therefore into a send — as a literal `{{first_name}}`. It also silently
 * produced "Hi ," when a value was present but blank.
 *
 * The unresolved names are now returned so the composer can refuse instead of
 * rendering a placeholder at a seller.
 */
export const previewEmailTemplate = async (
  templateId: string,
  mergeValues: Record<string, string>,
): Promise<EmailLoad<{ body: string; unresolved: string[] }>> => {
  const read = await getEmailTemplates()
  if (!read.ok) return read

  const template = read.data.find((t) => t.id === templateId)
  if (!template) return { ok: false, error: `Template ${templateId} not found` }

  let body = template.body
  for (const [key, val] of Object.entries(mergeValues)) {
    // A blank value is NOT a resolution — that is how "Hi ," happens.
    if (String(val ?? '').trim() === '') continue
    body = body.replaceAll(`{{${key}}}`, val)
  }

  const unresolved = [...new Set(
    [...body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]),
  )]
  return { ok: true, data: { body, unresolved } }
}
