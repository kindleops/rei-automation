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

const MOCK_OVERVIEW: EmailOverview = {
  total_emails: 0,
  email_eligible: 0,
  high_confidence: 0,
  suppressed: 0,
  bounced: 0,
  unsubscribed: 0,
  sent_today: 0,
  replies_today: 0,
  ready_for_campaign: 0,
  brevo_status: 'disconnected',
  last_updated: new Date().toISOString(),
}

const MOCK_HEALTH: BrevoHealth = {
  connected: false,
  api_key_valid: false,
  sender_identities: [],
  domain_auth_status: 'unknown',
  bounce_rate_7d: 0,
  send_failure_rate_7d: 0,
  api_latency_ms: null,
  webhook_configured: false,
  last_checked: new Date().toISOString(),
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

export const getEmailOverview = async (): Promise<EmailOverview> => {
  const res = await callBackend('/api/cockpit/email/overview')
  if (res.ok && (res as any).data) {
    const d = (res as any).data
    return {
      total_emails: d.total_emails ?? 0,
      email_eligible: d.email_eligible ?? 0,
      high_confidence: d.high_confidence ?? 0,
      suppressed: d.suppressed ?? 0,
      bounced: d.bounced ?? 0,
      unsubscribed: d.unsubscribed ?? 0,
      sent_today: d.sent_today ?? 0,
      replies_today: d.replies_today ?? 0,
      ready_for_campaign: d.ready_for_campaign ?? 0,
      brevo_status: (d.brevo_status === 'connected' || d.brevo_status === 'degraded' || d.brevo_status === 'disconnected')
        ? d.brevo_status : 'disconnected',
      last_updated: d.last_updated ?? new Date().toISOString(),
    }
  }
  // Backend returns the response body directly (not wrapped in .data)
  const body = res as any
  if (body.total_emails !== undefined) {
    return {
      total_emails: body.total_emails ?? 0,
      email_eligible: body.email_eligible ?? 0,
      high_confidence: body.high_confidence ?? 0,
      suppressed: body.suppressed ?? 0,
      bounced: body.bounced ?? 0,
      unsubscribed: body.unsubscribed ?? 0,
      sent_today: body.sent_today ?? 0,
      replies_today: body.replies_today ?? 0,
      ready_for_campaign: body.ready_for_campaign ?? 0,
      brevo_status: (body.brevo_status === 'connected' || body.brevo_status === 'degraded' || body.brevo_status === 'disconnected')
        ? body.brevo_status : 'disconnected',
      last_updated: body.last_updated ?? new Date().toISOString(),
    }
  }
  return MOCK_OVERVIEW
}

export const getEmailRecords = async (filters?: Partial<RecordFilters>): Promise<EmailRecord[]> => {
  const qs = new URLSearchParams()
  if (filters?.search) qs.set('search', filters.search)
  if (filters?.eligibility && filters.eligibility !== 'all') qs.set('eligibility', filters.eligibility)
  if (filters?.confidence && filters.confidence !== 'all') qs.set('confidence', filters.confidence)
  if (filters?.suppression && filters.suppression !== 'all') qs.set('suppression', filters.suppression)
  if (filters?.market && filters.market !== 'all') qs.set('market', filters.market)
  qs.set('limit', '200')

  const path = `/api/cockpit/email/records?${qs.toString()}`
  const res = await callBackend(path)
  const body = res as any

  const rows = body?.records ?? body?.data?.records ?? null
  if (Array.isArray(rows)) return rows.map(normalizeRecord)
  return []
}

export const getEmailThreads = async (filters?: Partial<InboxFilters>): Promise<EmailThread[]> => {
  const qs = new URLSearchParams()
  if (filters?.folder && filters.folder !== 'all') qs.set('folder', filters.folder)
  if (filters?.search) qs.set('search', filters.search)

  const res = await callBackend(`/api/cockpit/email/threads?${qs.toString()}`)
  const body = res as any

  const rows = body?.threads ?? body?.data?.threads ?? null
  if (Array.isArray(rows)) return rows.map(normalizeThread)
  return []
}

export const getEmailThread = async (threadId: string): Promise<EmailThreadDetail> => {
  const res = await callBackend(`/api/cockpit/email/threads/${encodeURIComponent(threadId)}`)
  const body = res as any
  const thread = body?.thread ?? body?.data?.thread ?? null

  if (thread) {
    return {
      ...normalizeThread(thread),
      messages: (thread.messages ?? []).map((m: any) => ({
        id: m.id ?? m.message_id ?? '',
        direction: m.direction === 'inbound' ? 'inbound' : 'outbound',
        from_address: m.from_address ?? m.from_email ?? '',
        to_address: m.to_address ?? m.to_email ?? '',
        subject: m.subject ?? '',
        body_preview: m.body_preview ?? '',
        body_html: m.body_html ?? m.html_body ?? null,
        sent_at: m.sent_at ?? null,
        opened: Boolean(m.opened),
        clicked: Boolean(m.clicked),
        bounced: Boolean(m.bounced),
      })),
      property_context: thread.property_context ?? null,
      prospect_context: thread.prospect_context ?? null,
      ai_summary: thread.ai_summary ?? null,
      sms_thread_id: thread.sms_thread_id ?? null,
    }
  }

  return {
    id: threadId,
    folder: 'all',
    prospect_name: '',
    email_address: '',
    subject: '(no subject)',
    last_message_preview: '',
    last_message_at: '',
    message_count: 0,
    unread: false,
    property_address: null,
    market: null,
    has_sms_thread: false,
    sentiment: 'unknown',
    messages: [],
    property_context: null,
    prospect_context: null,
    ai_summary: null,
    sms_thread_id: null,
  }
}

export const getBrevoHealth = async (): Promise<BrevoHealth> => {
  const res = await callBackend('/api/cockpit/email/brevo-health')
  const body = res as any
  const raw = body?.data ?? body
  if (raw?.provider === 'brevo' || raw?.connected !== undefined) {
    return normalizeHealth(raw)
  }
  return MOCK_HEALTH
}

export const getEmailTemplates = async (): Promise<EmailTemplate[]> => {
  const res = await callBackend('/api/cockpit/email/templates')
  const body = res as any
  const rows = body?.templates ?? body?.data?.templates ?? null
  if (Array.isArray(rows)) {
    return rows.map((t: any) => ({
      id: t.id ?? t.template_key ?? '',
      name: t.name ?? t.template_key ?? '',
      category: t.category ?? 'first_touch',
      subject: t.subject ?? '',
      body_preview: t.body_preview ?? '',
      body: t.body ?? '',
      merge_fields: Array.isArray(t.merge_fields) ? t.merge_fields : [],
      last_used: t.last_used ?? null,
      usage_count: Number(t.usage_count ?? 0),
    }))
  }
  return []
}

export const getEmailCampaigns = async (): Promise<EmailCampaignDraft[]> => {
  return []
}

export const getSuppressionList = async (): Promise<SuppressionEntry[]> => {
  const records = await getEmailRecords({ suppression: 'all' })
  return records
    .filter((r) => r.suppression_status !== 'none')
    .map((r) => ({
      id: r.id,
      email_address: r.email_address,
      prospect_name: r.prospect_name || 'Unknown',
      reason: r.suppression_status as any,
      suppressed_at: r.last_email_sent ?? new Date().toISOString(),
      source: 'brevo' as const,
      can_remove: false,
    }))
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
}

export const sendEmail = async (payload: ComposerPayload): Promise<SendEmailResult> => {
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
    }),
  })
  const body = res as any
  return {
    ok: Boolean(body?.ok),
    sent: Boolean(body?.sent),
    dry_run: Boolean(body?.dry_run),
    no_send: Boolean(body?.no_send),
    blocked: Boolean(body?.blocked),
    mode: body?.mode ?? undefined,
    message_id: body?.message_id ?? undefined,
    error: body?.error ?? undefined,
    message: body?.message ?? undefined,
  }
}

export const previewEmailTemplate = async (templateId: string, mergeValues: Record<string, string>): Promise<string> => {
  const templates = await getEmailTemplates()
  const template = templates.find((t) => t.id === templateId)
  if (!template) return ''
  let body = template.body
  for (const [key, val] of Object.entries(mergeValues)) {
    body = body.replaceAll(`{{${key}}}`, val)
  }
  return body
}
