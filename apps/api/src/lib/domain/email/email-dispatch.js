/**
 * EMAIL DISPATCH — the one worker that sends email.
 *
 * Invoked by the Cloudflare scheduler (job `email_dispatch`). Each tick:
 *   1. bridge due Closing Authority requests into email_queue,
 *   2. reap rows stuck in `sending` → failed/transport_outcome_unknown (never
 *      re-sent automatically: the provider may have accepted them),
 *   3. claim due rows (SKIP LOCKED → 'sending'),
 *   4. per row: fresh thread + suppression + sender + business revalidation →
 *      evaluateSendSafety → send / supersede / cancel / escalate / defer,
 *   5. heartbeat + summary into system_control.
 *
 * TRANSPORT RETRY ≠ BUSINESS FOLLOW-UP. A retryable provider error puts the
 * SAME row back (retry_count+1, next_retry_at) — one logical message, several
 * delivery attempts. A follow-up is a different row the planner creates.
 *
 * Sending requires BOTH system_control.email_enabled='true' AND env
 * EMAIL_SEND_ENABLED — the DB switch is the operator's kill switch, the env
 * flag is the deployment's. With either off the tick still runs (bridge,
 * reap, heartbeat) and reports how many messages are waiting.
 */
import crypto from 'node:crypto'

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { sendBrevoTransactionalEmail } from './brevo-provider.js'
import { evaluateSendSafety, DEFAULT_STALE_AFTER_MS } from './email-send-safety.js'
import { resolveBrandSender, mintMessageId, threadingHeaders, replyAddressFor } from './email-identity.js'
import { bridgeClosingEmailRequests, revalidateClosingEmail, writeBackClosingRequest } from './email-closing-bridge.js'
import { emitNotificationFromBusinessEvent } from '@/lib/domain/notifications/notification-emitter.js'
import { recordEmailEvent, laneFor } from './email-telemetry.js'
import { applyTracking, mintTrackingToken } from './email-tracking.js'
import { checkCompliance, buildComplianceParts, appendFooter } from './email-compliance.js'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(lower(v))

const REVALIDATORS = {
  closing: revalidateClosingEmail,
  manual: async () => ({ state: 'still_needed' }),
}

/** Register a source revalidator (seller automation registers its own). */
export function registerEmailRevalidator(source, fn) { REVALIDATORS[source] = fn }
export function hasEmailRevalidator(source) { return typeof REVALIDATORS[source] === 'function' }

async function readControls(db) {
  const { data } = await db.from('system_control').select('key, value').in('key', ['email_enabled', 'email_automation_enabled', 'email_stale_after_hours'])
  const m = Object.fromEntries((data || []).map((r) => [r.key, r.value]))
  return {
    emailEnabled: truthy(m.email_enabled),
    automationEnabled: m.email_automation_enabled === undefined ? true : truthy(m.email_automation_enabled),
    staleAfterMs: Number(m.email_stale_after_hours) > 0 ? Number(m.email_stale_after_hours) * 3600e3 : DEFAULT_STALE_AFTER_MS,
  }
}

async function checkSuppression(db, email) {
  const { data, error } = await db.from('email_suppression').select('reason, suppression_status, is_active, expires_at').eq('email_address', lower(email)).maybeSingle()
  if (error) return { ok: false, suppressed: false }
  if (data && data.is_active !== false && !(data.expires_at && Date.parse(data.expires_at) < Date.now())) return { ok: true, suppressed: true, reason: data.reason || data.suppression_status }
  return { ok: true, suppressed: false }
}

async function priorMessageIds(db, threadId, excludeId) {
  if (!threadId) return []
  const [{ data: out }, { data: inb }] = await Promise.all([
    db.from('email_queue').select('id, message_id_header, sent_at').eq('thread_id', threadId).in('queue_status', ['sent', 'delivered']),
    db.from('email_inbound_messages').select('message_id_header, received_at').eq('thread_id', threadId),
  ])
  return [
    ...(out || []).filter((r) => r.id !== excludeId && r.message_id_header).map((r) => ({ id: r.message_id_header, at: r.sent_at })),
    ...(inb || []).filter((r) => r.message_id_header).map((r) => ({ id: r.message_id_header, at: r.received_at })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at))).map((x) => x.id)
}

const EVENT_ALIASES = { send_failed: 'failed', send_retry_scheduled: 'retry_scheduled' }

/** Every dispatcher outcome is a canonical, append-only telemetry event. */
async function logEvent(db, row, eventType, extra = {}) {
  const type = EVENT_ALIASES[eventType] || eventType
  const attempt = extra.attempt ?? row.retry_count ?? 0
  await recordEmailEvent(db, {
    type,
    source: extra.source || 'dispatcher',
    message: { ...row, from_email: extra.from_email || row.from_email, provider_message_id: extra.provider_message_id || row.provider_message_id },
    key: `dispatcher:${type}:${row.id}:${attempt}`,
    providerMessageId: extra.provider_message_id || null,
    reason: extra.code || extra.error || null,
  })
}

async function flagThread(db, threadId, code, reason, now) {
  if (!threadId) return
  await db.from('email_threads').update({ needs_operator: true, needs_code: code, needs_reason: reason, needs_since: new Date(now).toISOString(), updated_at: new Date(now).toISOString() }).eq('id', threadId)
}

const NEEDS_MESSAGE = {
  stale_scheduled_message: 'A scheduled email was not sent because it was badly overdue — review before sending',
  recipient_identity_uncertain: 'Recipient identity is uncertain — confirm who this is before automation continues',
  business_state_changed: 'The deal changed after this email was planned — review it',
  title_contact_changed: 'Title contact changed after this email was planned — review it',
  recipient_invalid: 'Recipient address is invalid',
  content_missing: 'Automated email had no content',
  thread_unlinked: 'Automated email had no conversation link',
  transport_failed: 'Email failed to send after retries',
  recipient_suppressed: 'Recipient address is suppressed (bounced or unsubscribed) — use another channel or address',
}

export async function runEmailDispatch({ now = Date.now(), limit = 25, worker = null } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const send = deps.send || sendBrevoTransactionalEmail
  const notify = deps.notify || emitNotificationFromBusinessEvent
  const env = deps.env || process.env
  const workerId = worker || `email-dispatch:${crypto.randomBytes(4).toString('hex')}`
  const nowIso = new Date(now).toISOString()
  const summary = { bridged: 0, bridge_failed: 0, reaped: 0, claimed: 0, sent: 0, superseded: 0, cancelled: 0, escalated: 0, deferred: 0, failed: 0, retried: 0, waiting: 0, send_enabled: false, errors: [] }

  const controls = await readControls(db)
  const envEnabled = truthy(env.EMAIL_SEND_ENABLED)
  summary.send_enabled = controls.emailEnabled && envEnabled

  if (controls.automationEnabled) {
    try {
      const b = await bridgeClosingEmailRequests(db, { now })
      summary.bridged = b.bridged
      summary.bridge_failed = b.failed
    } catch (e) { summary.errors.push(`bridge:${e.message}`) }
  }

  try {
    const { data: reaped } = await db.rpc('email_queue_reap_stuck', {})
    summary.reaped = Number(reaped) || 0
    if (summary.reaped) {
      const { data: stuck } = await db.from('email_queue').select('*').eq('queue_status', 'failed').eq('failed_reason', 'transport_outcome_unknown').is('cancel_reason', null)
      for (const r of stuck || []) {
        await flagThread(db, r.thread_id, 'transport_outcome_unknown', 'An email may or may not have been delivered (send timed out) — check before resending', now)
        await db.from('email_queue').update({ cancel_reason: 'flagged_for_operator' }).eq('id', r.id)
        await writeBackClosingRequest(db, r, { status: 'failed', code: 'transport_outcome_unknown' }, now)
      }
    }
  } catch (e) { summary.errors.push(`reap:${e.message}`) }

  if (!summary.send_enabled) {
    const { data: waiting } = await db.from('email_queue').select('id').in('queue_status', ['pending_send', 'scheduled']).lte('scheduled_for', nowIso)
    summary.waiting = (waiting || []).length
    summary.disabled_reason = !controls.emailEnabled ? 'system_control.email_enabled' : 'EMAIL_SEND_ENABLED'
    await heartbeat(db, now, summary)
    return summary
  }

  const { data: claimed, error: claimErr } = await db.rpc('email_queue_claim', { p_limit: limit, p_worker: workerId, p_now: nowIso })
  if (claimErr) {
    summary.errors.push(`claim:${claimErr.message}`)
    await heartbeat(db, now, summary)
    return summary
  }
  summary.claimed = (claimed || []).length

  for (const row of claimed || []) {
    try {
      await processRow(db, row, { now, send, notify, env, controls, summary })
    } catch (e) {
      summary.errors.push(`${row.id}:${e.message}`)
      // Unknown failure after claim: do not strand it in 'sending' silently.
      await db.from('email_queue').update({ queue_status: 'failed', failed_reason: `dispatch_error:${clean(e.message).slice(0, 120)}`, is_locked: false, updated_at: nowIso }).eq('id', row.id)
      await flagThread(db, row.thread_id, 'automation_failed', 'Email dispatch hit an internal error', now)
      summary.failed++
    }
  }
  await heartbeat(db, now, summary)
  return summary
}

async function processRow(db, row, { now, send, notify, env, controls, summary }) {
  const nowIso = new Date(now).toISOString()
  const { data: thread } = row.thread_id ? await db.from('email_threads').select('*').eq('id', row.thread_id).maybeSingle() : { data: null }
  const [suppression, sender] = await Promise.all([
    checkSuppression(db, row.to_email),
    resolveBrandSender(db, row.brand_key || thread?.brand_key, env, now),
  ])
  let revalidation = null
  const revalidate = REVALIDATORS[row.source]
  if (revalidate) {
    try { revalidation = await revalidate(db, row, { thread, now }) } catch (e) { revalidation = { state: 'error', reason: `revalidation_failed:${e.message}` } }
  } else if (row.source && row.source !== 'manual') {
    revalidation = { state: 'error', reason: `no_revalidator:${row.source}` }
  }
  let alreadySent = false
  if (row.source_ref) {
    const { data: twins } = await db.from('email_queue').select('id').eq('source_ref', row.source_ref).in('queue_status', ['sent', 'delivered'])
    alreadySent = (twins || []).some((t) => t.id !== row.id)
  }

  const compliance = checkCompliance(row, sender)
  const verdict = evaluateSendSafety({ row, thread, suppression, sender, revalidation, alreadySent, compliance, now, staleAfterMs: controls.staleAfterMs })
  const release = { is_locked: false, lock_token: null, revalidated_at: nowIso, updated_at: nowIso }

  if (verdict.decision === 'supersede' || verdict.decision === 'cancel') {
    const status = verdict.decision === 'supersede' ? 'superseded' : 'cancelled'
    await db.from('email_queue').update({ ...release, queue_status: status, cancel_reason: verdict.code }).eq('id', row.id)
    await logEvent(db, row, status, { code: verdict.code })
    await writeBackClosingRequest(db, row, { status, code: verdict.code }, now)
    if (verdict.code === 'recipient_suppressed' && row.source !== 'manual') await flagThread(db, row.thread_id, 'recipient_suppressed', NEEDS_MESSAGE.recipient_suppressed, now)
    summary[status === 'superseded' ? 'superseded' : 'cancelled']++
    return
  }
  if (verdict.decision === 'defer') {
    const next = new Date(now + 15 * 60e3).toISOString()
    await db.from('email_queue').update({ ...release, queue_status: 'pending_send', next_retry_at: next, failed_reason: verdict.code }).eq('id', row.id)
    summary.deferred++
    return
  }
  if (verdict.decision === 'escalate' || verdict.decision === 'fail') {
    await db.from('email_queue').update({ ...release, queue_status: 'failed', failed_reason: verdict.code }).eq('id', row.id)
    await logEvent(db, row, verdict.decision === 'escalate' ? 'escalated' : 'send_failed', { code: verdict.code })
    await flagThread(db, row.thread_id, verdict.decision === 'escalate' ? verdict.code : 'automation_failed', NEEDS_MESSAGE[verdict.code] || verdict.code.replace(/_/g, ' '), now)
    await writeBackClosingRequest(db, row, { status: 'escalated', code: verdict.code }, now)
    summary[verdict.decision === 'escalate' ? 'escalated' : 'failed']++
    return
  }

  // ── send ──
  const s = sender.sender
  const messageId = row.message_id_header || mintMessageId(s.domain)
  const prior = await priorMessageIds(db, row.thread_id, row.id)
  const { inReplyTo, references } = threadingHeaders(prior)
  const replyTo = replyAddressFor(thread, s.inbound_domain) || s.reply_to_email || null
  const headers = { 'Message-Id': messageId }
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo
  if (references) headers.References = references
  const subject = inReplyTo && !/^re:/i.test(row.subject) && row.sequence > 1 ? `Re: ${row.subject}` : row.subject

  // Own tracking (signed-by-unguessability tokens, destinations pre-recorded)
  // when this sender has a tracking host; otherwise provider telemetry only.
  const tracked = await applyTracking(db, row, s.tracking_base_url)
  // Compliance parts go on AFTER tracking so the unsubscribe link is never
  // rewritten into a click redirect.
  let html = tracked.html || row.html_body || row.email_body
  let text = row.text_body || undefined
  let token = tracked.token || row.tracking_token || null
  if (compliance.required) {
    token = token || mintTrackingToken()
    const parts = buildComplianceParts(s, token)
    Object.assign(headers, parts.headers)
    html = appendFooter(html, parts.footerHtml)
    if (text) text = `${text}${parts.footerText}`
  }
  const lineage = { lane: laneFor(row), sending_domain: s.domain, provider: 'brevo', origin: row.source === 'manual' ? 'manual' : 'automation', template_version: row.template_version || row.metadata?.template_version || row.reason?.template_version || null }
  await db.from('email_queue').update({ message_id_header: messageId, in_reply_to: inReplyTo, references_header: references, from_email: s.email, from_name: s.name, reply_to_email: replyTo, sender_key: s.sender_key, ...lineage, ...(token ? { tracking_token: token } : {}) }).eq('id', row.id)
  Object.assign(row, lineage, { sender_key: s.sender_key, from_email: s.email })

  const result = await send({
    to: row.to_email,
    subject,
    htmlContent: html,
    textContent: text,
    sender: { name: s.name, email: s.email },
    replyTo: replyTo ? { email: replyTo } : null,
    headers,
    tags: [row.source || 'email', row.action_key].filter(Boolean),
  }, { api_key: s.api_key, send_enabled: true })

  if (result?.ok && result?.sent) {
    const providerMessageId = clean(result.message_id) || null
    await db.from('email_queue').update({ ...release, queue_status: 'sent', sent_at: nowIso, provider_message_id: providerMessageId, failed_reason: null, next_retry_at: null }).eq('id', row.id)
    await logEvent(db, { ...row, from_email: s.email }, 'sent', { provider_message_id: providerMessageId, from_email: s.email })
    // The provider's 2xx with a message id IS acceptance; delivery only comes from provider events.
    await logEvent(db, { ...row, from_email: s.email }, 'accepted', { provider_message_id: providerMessageId, from_email: s.email, source: 'provider_api' })
    await writeBackClosingRequest(db, row, { status: 'sent', providerMessageId }, now)
    await db.from('email_senders').update({ messages_sent_today: (s.messages_sent_today || 0) + 1, last_sent_at: nowIso }).eq('sender_key', s.sender_key)
    summary.sent++
    return
  }

  const err = result?.error || { code: result?.reason || 'send_failed', retryable: false }
  const attempts = (row.retry_count || 0) + 1
  const maxRetries = row.max_retries ?? 3
  if (err.retryable && attempts < maxRetries) {
    const backoff = 5 * 60e3 * 2 ** (attempts - 1)
    await db.from('email_queue').update({ ...release, queue_status: 'pending_send', retry_count: attempts, next_retry_at: new Date(now + backoff).toISOString(), failed_reason: err.code }).eq('id', row.id)
    await logEvent(db, row, 'send_retry_scheduled', { code: err.code, attempt: attempts })
    summary.retried++
    return
  }
  await db.from('email_queue').update({ ...release, queue_status: 'failed', retry_count: attempts, failed_reason: err.code }).eq('id', row.id)
  await logEvent(db, row, 'send_failed', { code: err.code, error: err.message, attempt: attempts })
  await flagThread(db, row.thread_id, 'automation_failed', `${NEEDS_MESSAGE.transport_failed} (${err.code})`, now)
  await writeBackClosingRequest(db, row, { status: 'failed', code: err.code }, now)
  try {
    await notify({ eventType: 'email_automation_failed', severity: 'high', title: 'Email failed to send', description: `${row.subject} → ${row.to_email}: ${err.code}`, sourceEntityType: 'email_thread', sourceEntityId: row.thread_id, deduplicationKey: `email_failed:${row.id}` })
  } catch { /* notification is best-effort */ }
  summary.failed++
}

async function heartbeat(db, now, summary) {
  const at = new Date(now).toISOString()
  const rows = [
    { key: 'email_dispatch_heartbeat_at', value: at },
    { key: 'email_dispatch_last_summary', value: JSON.stringify({ at, ...summary, errors: summary.errors.slice(0, 5) }) },
  ]
  if (summary.sent) rows.push({ key: 'email_dispatch_last_sent_at', value: at })
  await db.from('system_control').upsert(rows, { onConflict: 'key' })
}
