/**
 * EMAIL TELEMETRY — LeadCommand's canonical email event ledger.
 *
 * Brevo is the pipe; LeadCommand owns the history. Every lifecycle fact is a
 * row in public.email_events (append-only, DB-enforced), carrying the full
 * lineage of the message it belongs to (campaign, sequence step, template +
 * version, sender, sending domain, lane, seller/property/opportunity/closing,
 * provider + provider ids). Summary state (first/last open, counts, reply,
 * bounce) is DERIVED from these rows — never stored as a mutable flag.
 *
 * Replay safety: event_key is deterministic from provider identity +
 * type + provider timestamp, and inserts ignore duplicates, so a webhook
 * replay records nothing new.
 *
 * Consequences are deliberately narrow:
 *   hard bounce / invalid / repeated soft bounce → suppress that ADDRESS
 *   unsubscribe / complaint                      → suppress immediately
 *   delivered                                    → delivery timestamp
 *   open signal / click                          → NOTHING. Engagement is
 *     telemetry, never seller intent: no stage change, no notification.
 */

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()

export const EVENT_TYPES = Object.freeze(new Set([
  'queued', 'scheduled', 'sending', 'sent', 'accepted', 'delivered', 'open_signal', 'click', 'replied',
  'soft_bounce', 'hard_bounce', 'deferred', 'failed', 'invalid_address', 'blocked', 'unsubscribed', 'complaint',
  'suppressed', 'cancelled', 'superseded', 'automation_stopped', 'escalated', 'retry_scheduled',
]))

export const EVENT_SOURCES = Object.freeze(new Set([
  'dispatcher', 'provider_api', 'brevo_webhook', 'leadcommand_tracking_pixel', 'leadcommand_click_redirect',
  'cloudflare_inbound_email', 'brevo_inbound', 'manual_operator', 'import', 'system',
]))

/** Which lane a message belongs to — acquisition never hides transactional health. */
export function laneFor(row = {}) {
  if (clean(row.lane)) return row.lane
  const src = lower(row.source)
  if (src === 'campaign') return 'acquisition'
  if (src === 'seller') return 'seller_conversation'
  if (src === 'closing') return /buyer/.test(lower(row.action_key)) ? 'buyer' : 'closing'
  if (src === 'manual') return 'manual'
  if (src === 'alert' || src === 'system') return 'system'
  return 'transactional'
}

/** Lineage columns copied from the message onto every event about it. */
export function lineageOf(q = {}) {
  return {
    queue_id: q.id || null,
    thread_id: q.thread_id || null,
    recipient_email: lower(q.to_email) || null,
    to_email: lower(q.to_email) || null,
    from_email: lower(q.from_email) || null,
    subject: q.subject || null,
    lane: laneFor(q),
    origin: q.origin || (q.source === 'manual' ? 'manual' : 'automation'),
    sender_key: q.sender_key || null,
    sending_domain: q.sending_domain || (lower(q.from_email).split('@')[1] || null),
    provider: q.provider || 'brevo',
    provider_message_id: q.provider_message_id || null,
    campaign_id: q.campaign_id || null,
    campaign_target_id: q.campaign_target_id || null,
    sequence_id: q.sequence_id || null,
    sequence_step: q.sequence_step ?? null,
    template_id: q.template_id || null,
    template_version: q.template_version || q.metadata?.template_version || null,
    master_owner_id: q.master_owner_id || null,
    property_id: q.property_id || null,
    opportunity_id: q.opportunity_id || null,
    closing_case_id: q.closing_case_id || q.reason?.closing_case_id || null,
    buyer_id: q.buyer_id || null,
    title_company_id: q.title_company_id || null,
  }
}

/**
 * Append one event. Idempotent: the same key twice records once.
 * @returns {{ recorded: boolean, event_key: string }}
 */
export async function recordEmailEvent(db, { type, source, message = null, at = null, key = null, direction = 'outbound', provider = null, providerEventId = null, providerMessageId = null, signalClass = null, signalConfidence = null, bounceClass = null, reason = null, linkId = null, raw = null, extra = {} } = {}) {
  if (!EVENT_TYPES.has(type)) throw new Error(`unknown email event type: ${type}`)
  if (!EVENT_SOURCES.has(source)) throw new Error(`unknown email event source: ${source}`)
  const eventAt = new Date(at || Date.now()).toISOString()
  const lineage = message ? lineageOf(message) : {}
  const eventKey = key || `${source}:${type}:${lineage.queue_id || providerMessageId || 'none'}:${providerEventId || eventAt}`
  const row = {
    ...lineage,
    ...extra,
    event_key: eventKey,
    event_type: type,
    event_source: source,
    direction,
    provider: provider || lineage.provider || null,
    provider_event_id: providerEventId,
    provider_message_id: providerMessageId || lineage.provider_message_id || null,
    event_at: eventAt,
    received_at: new Date().toISOString(),
    created_at: eventAt,
    sent_at: type === 'sent' ? eventAt : null,
    delivered_at: type === 'delivered' ? eventAt : null,
    failed_at: ['failed', 'hard_bounce', 'soft_bounce', 'blocked', 'invalid_address'].includes(type) ? eventAt : null,
    signal_class: signalClass,
    signal_confidence: signalConfidence,
    bounce_class: bounceClass,
    reason,
    error_message: ['failed', 'hard_bounce', 'soft_bounce', 'blocked', 'invalid_address', 'deferred'].includes(type) ? reason : null,
    link_id: linkId,
    raw_payload: raw,
  }
  const { data, error } = await db.from('email_events').upsert(row, { onConflict: 'event_key', ignoreDuplicates: true }).select('event_key')
  if (error) throw error
  return { recorded: Array.isArray(data) ? data.length > 0 : Boolean(data), event_key: eventKey }
}

async function suppressAddress(db, email, reason, source, meta = {}) {
  if (!clean(email)) return
  await db.from('email_suppression').upsert({
    email_address: lower(email), reason, suppression_status: reason, source, is_active: true,
    metadata: meta, last_event_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: 'email_address' })
}

/** Stop pending automated email to one address (the address, not the seller). */
async function stopPendingToAddress(db, email, reason) {
  await db.from('email_queue')
    .update({ queue_status: 'superseded', cancel_reason: reason, updated_at: new Date().toISOString() })
    .eq('to_email', lower(email))
    .neq('source', 'manual')
    .in('queue_status', ['pending_send', 'scheduled'])
}

const SOFT_BOUNCE_LIMIT = 3

/** Apply the narrow, deterministic consequences of a recorded event. */
export async function applyEventConsequences(db, event, message = null, { now = Date.now() } = {}) {
  const email = lower(event.recipient || message?.to_email)
  const nowIso = new Date(now).toISOString()
  const out = []
  switch (event.type) {
    case 'delivered':
      if (message?.id) {
        await db.from('email_queue').update({ delivered_at: event.at || nowIso, ...(message.queue_status === 'sent' ? { queue_status: 'delivered' } : {}), updated_at: nowIso }).eq('id', message.id)
        if (message.source === 'closing' && message.source_ref) await db.from('closing_email_requests').update({ delivery_status: 'delivered', updated_at: nowIso }).eq('request_key', message.source_ref)
      }
      out.push('delivery_recorded')
      break
    case 'hard_bounce':
    case 'invalid_address':
      await suppressAddress(db, email, 'hard_bounce', event.source, { queue_id: message?.id || null, reason: event.reason || null })
      await stopPendingToAddress(db, email, 'recipient_hard_bounced')
      if (message?.id) await db.from('email_queue').update({ queue_status: 'bounced', failed_reason: event.reason || event.type, updated_at: nowIso }).eq('id', message.id)
      if (message?.source === 'closing' && message.source_ref) await db.from('closing_email_requests').update({ delivery_status: 'bounced', updated_at: nowIso }).eq('request_key', message.source_ref)
      if (message?.thread_id && ['closing', 'buyer', 'transactional'].includes(laneFor(message))) {
        await db.from('email_threads').update({ needs_operator: true, needs_code: 'address_bounced', needs_reason: `Email to ${email} bounced — use another address or call`, needs_since: nowIso, updated_at: nowIso }).eq('id', message.thread_id)
      }
      out.push('address_suppressed', 'pending_stopped')
      break
    case 'soft_bounce': {
      const since = new Date(now - 7 * 864e5).toISOString()
      const { data } = await db.from('email_events').select('event_key').eq('recipient_email', email).eq('event_type', 'soft_bounce').gte('event_at', since)
      if ((data || []).length >= SOFT_BOUNCE_LIMIT) {
        await suppressAddress(db, email, 'soft_bounce_repeated', event.source, { count_7d: data.length })
        await stopPendingToAddress(db, email, 'recipient_soft_bounced_repeatedly')
        out.push('address_suppressed_after_soft_bounces')
      }
      break
    }
    case 'unsubscribed':
      await suppressAddress(db, email, 'unsubscribe', event.source, { brand: message?.sender_key || null, sending_domain: message?.sending_domain || null, campaign_id: message?.campaign_id || null, scope: 'address' })
      await stopPendingToAddress(db, email, 'recipient_unsubscribed')
      out.push('address_suppressed', 'pending_stopped')
      break
    case 'complaint':
      await suppressAddress(db, email, 'complaint', event.source, { brand: message?.sender_key || null, sending_domain: message?.sending_domain || null })
      await stopPendingToAddress(db, email, 'recipient_complained')
      out.push('address_suppressed', 'pending_stopped')
      break
    default:
      // open_signal / click / accepted / deferred …: telemetry only.
      break
  }
  return out
}
