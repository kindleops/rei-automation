/**
 * EMAIL COMPLIANCE PARTS — unsubscribe + sender postal address.
 *
 * Automated email in the acquisition and seller-conversation lanes carries:
 *   - List-Unsubscribe: <https://…/u/<token>> and
 *     List-Unsubscribe-Post: List-Unsubscribe=One-Click (RFC 8058 one-click,
 *     which Gmail and Yahoo require of bulk senders);
 *   - a footer with the sender's postal address and a visible unsubscribe link.
 *
 * Both come from the sender's email_senders row (metadata.postal_address,
 * metadata.unsubscribe_base_url or metadata.tracking_base_url). If either is
 * missing the dispatcher DEFERS the message (sender_compliance_incomplete) —
 * it never sends a lane-scoped email without them.
 *
 * The token is the message's tracking_token (144-bit random, unique-indexed),
 * so the unsubscribe acts on exactly the address that received that message.
 * Closing/title, transactional and operator-manual mail is not lane-scoped
 * here (owner decision recorded in the go-live runbook).
 */
import { laneFor, recordEmailEvent, applyEventConsequences } from './email-telemetry.js'

const clean = (v) => String(v ?? '').trim()

export const COMPLIANCE_LANES = Object.freeze(new Set(['acquisition', 'seller_conversation']))

export function complianceRequired(row = {}) {
  return clean(row.source) !== 'manual' && COMPLIANCE_LANES.has(laneFor(row))
}

/** Pure readiness check (no token needed). */
export function checkCompliance(row = {}, sender = null) {
  const required = complianceRequired(row)
  if (!required) return { required: false, ok: true, code: 'not_required' }
  const s = sender?.sender || {}
  if (!clean(s.postal_address)) return { required, ok: false, code: 'sender_compliance_incomplete', missing: 'postal_address' }
  if (!clean(s.unsubscribe_base_url)) return { required, ok: false, code: 'sender_compliance_incomplete', missing: 'unsubscribe_base_url' }
  return { required, ok: true, code: 'ok' }
}

function escapeHtml(s) {
  return clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function unsubscribeUrlFor(baseUrl, token) {
  return `${clean(baseUrl).replace(/\/+$/, '')}/u/${encodeURIComponent(token)}`
}

/**
 * Headers + footer for one message. Footer text is functional (address and
 * unsubscribe mechanism), not marketing copy; a sender may override the line
 * via metadata.unsubscribe_footer_text ("{{unsubscribe_url}}" placeholder).
 */
export function buildComplianceParts(sender = {}, token) {
  const url = unsubscribeUrlFor(sender.unsubscribe_base_url, token)
  const custom = clean(sender.unsubscribe_footer_text)
  const line = custom ? custom.replace(/\{\{unsubscribe_url\}\}/g, url) : `Unsubscribe: ${url}`
  return {
    url,
    headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    footerText: `\n\n--\n${clean(sender.postal_address)}\n${line}`,
    footerHtml: `\n<p style="margin-top:24px;font-size:12px;line-height:1.5;color:#6b7280">${escapeHtml(sender.postal_address).replace(/\n/g, '<br>')}<br><a href="${escapeHtml(url)}">${custom ? escapeHtml(custom.replace(/\{\{unsubscribe_url\}\}/g, '')).trim() || 'Unsubscribe' : 'Unsubscribe'}</a></p>`,
  }
}

export function appendFooter(html, footerHtml) {
  const h = String(html || '')
  return /<\/body>/i.test(h) ? h.replace(/<\/body>/i, `${footerHtml}</body>`) : `${h}${footerHtml}`
}

const TOKEN_RE = /^[A-Za-z0-9_-]{20,40}$/

/**
 * One-click unsubscribe (RFC 8058 POST, or the confirm button on the GET page).
 * Suppresses exactly the address that received the message, stops its pending
 * automated email, and records an append-only 'unsubscribed' event. Idempotent:
 * a second POST records nothing new. Email-only: it does not change SMS
 * consent (an email unsubscribe is not an SMS STOP).
 */
export async function recordUnsubscribe(db, rawToken, { now = Date.now() } = {}) {
  const token = clean(rawToken)
  if (!TOKEN_RE.test(token)) return { ok: false, reason: 'bad_token' }
  const { data: msg, error } = await db.from('email_queue').select('*').eq('tracking_token', token).maybeSingle()
  if (error) return { ok: false, reason: 'lookup_failed' }
  if (!msg) return { ok: false, reason: 'unknown_token' }
  const at = new Date(now).toISOString()
  const r = await recordEmailEvent(db, { type: 'unsubscribed', source: 'leadcommand_unsubscribe', message: msg, at, key: `unsubscribe:${msg.id}`, reason: 'one_click' })
  await applyEventConsequences(db, { type: 'unsubscribed', recipient: msg.to_email, source: 'leadcommand_unsubscribe', at }, msg, { now })
  return { ok: true, recorded: r.recorded, email: msg.to_email }
}
