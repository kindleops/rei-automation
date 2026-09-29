/**
 * PROVIDER-NEUTRAL EMAIL CONTRACT.
 *
 * Campaign Command and Email Command never talk to a provider. A provider is
 * an adapter with two duties:
 *   send(message, sender)      → { ok, sent, message_id, error:{code,retryable} }
 *   normalizeEvent(payload)    → canonical LeadCommand events (email-telemetry
 *                                vocabulary) or [] for noise
 * Brevo is adapter #1. SES / Postmark / Resend / LeadCommand SMTP plug in by
 * adding an entry here; history and analytics do not change.
 */
import { sendBrevoTransactionalEmail } from './brevo-provider.js'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()

function tsOf(p) {
  const n = Number(p.ts_event ?? p.ts_epoch ?? p.ts)
  if (Number.isFinite(n) && n > 0) return new Date(n > 1e12 ? n : n * 1000).toISOString()
  const d = Date.parse(p.date || p.event_at || '')
  return Number.isFinite(d) ? new Date(d).toISOString() : null
}

const BREVO_MAP = {
  request: 'accepted',
  sent: 'accepted',
  delivered: 'delivered',
  opened: 'open_signal',
  proxy_open: 'open_signal',
  click: 'click',
  clicked: 'click',
  hard_bounce: 'hard_bounce',
  hardbounce: 'hard_bounce',
  soft_bounce: 'soft_bounce',
  softbounce: 'soft_bounce',
  invalid_email: 'invalid_address',
  invalid: 'invalid_address',
  deferred: 'deferred',
  complaint: 'complaint',
  spam: 'complaint',
  unsubscribed: 'unsubscribed',
  unsubscribe: 'unsubscribed',
  blocked: 'blocked',
  error: 'failed',
}
// "unique_opened" / "unique_proxy_open" duplicate the first "opened": the
// ledger keeps every open, uniqueness is derived — so they are dropped.
const BREVO_IGNORED = new Set(['unique_opened', 'unique_proxy_open', 'first_opening'])

/** Brevo transactional webhook item → canonical event (or null). */
export function normalizeBrevoEvent(p = {}) {
  const raw = lower(p.event || p.event_type || p.type).replace(/\s+/g, '_')
  if (!raw || BREVO_IGNORED.has(raw)) return null
  const type = BREVO_MAP[raw]
  if (!type) return null
  const providerMessageId = clean(p['message-id'] || p.message_id || p.messageId) || null
  const at = tsOf(p)
  const link = clean(p.link) || null
  return {
    type,
    provider: 'brevo',
    source: 'brevo_webhook',
    providerMessageId,
    providerEventId: `${providerMessageId || lower(p.email)}:${raw}:${at || ''}${link ? `:${link}` : ''}`,
    at,
    recipient: lower(p.email) || null,
    signalClass: raw === 'proxy_open' ? 'privacy_proxy' : (type === 'open_signal' || type === 'click') ? 'unknown' : null,
    bounceClass: type === 'hard_bounce' || type === 'invalid_address' ? 'permanent' : type === 'soft_bounce' || type === 'deferred' ? 'temporary' : null,
    reason: clean(p.reason) || null,
    link,
    raw: { event: raw, id: p.id ?? null, ts_event: p.ts_event ?? null, reason: p.reason ?? null, link, tag: p.tag ?? p.tags ?? null, subject: p.subject ?? null },
  }
}

export const EMAIL_PROVIDERS = Object.freeze({
  brevo: { send: sendBrevoTransactionalEmail, normalizeEvent: normalizeBrevoEvent },
})

export function providerFor(name) {
  return EMAIL_PROVIDERS[lower(name) || 'brevo'] || null
}
