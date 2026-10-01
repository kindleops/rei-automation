/**
 * MESSAGES adapter — message_events (the message ledger).
 *
 *   inbound_sms                      → seller.replied        (inbox)
 *   outbound, conversation sources   → message.sent/.failed  (queue)   one per message
 *   outbound, campaign sources       → message.sent/.failed  (campaign) ONLY in a seller/property replay;
 *                                      the global feed sees them as campaign.batch_sent (campaign-sends.js)
 *
 * The delivery outcome is updated in place on the send row (delivery_status /
 * delivered_at / failed_at), so a send is one event at its send time whose type
 * says how it ended — never a second "delivered" row. Test traffic (internal
 * handsets, proof rows) is excluded like every operational read.
 */
import { isInternalTestPhone } from '@/lib/config/internal-phones.js'
import { envelope, links, refs, humanize } from '../envelope.js'
import { readKeyed } from '../keyset.js'

export const CAMPAIGN_SEND_SOURCES = Object.freeze(['campaign_launch_execution', 'enqueue_campaign_target_one'])
const TEST_SOURCES = new Set(['internal_canary', 'inbox_lock_certification', 'queue_limited_cap_proof'])
const OPERATOR_SOURCES = new Set(['inbox', 'inbox_bulk_follow_up', 'manual', 'operator'])
const COLS = 'id, direction, event_type, created_at, thread_key, property_id, prospect_id, master_owner_id, market, seller_display_name, property_address, message_body, detected_intent, classification_confidence, is_opt_out, delivery_status, failure_reason, delivered_at, failed_at, queue_id, from_phone_number, metadata'

const clean = (v) => String(v ?? '').trim()
const preview = (s) => { const t = clean(s).replace(/\s+/g, ' '); return t ? (t.length > 140 ? `${t.slice(0, 139)}…` : t) : null }
const isTest = (r, q) => r.metadata?.internal_test === true || r.metadata?.proof === true || TEST_SOURCES.has(q?.source) || (r.direction === 'inbound' && isInternalTestPhone(r.from_phone_number))

/** Pure: one message row (+ its queue row) → envelope, or null when it is not an operator-level event. */
export function messageEvent(r, q = null, { includeCampaignSends = false, campaignName = null } = {}) {
  if (isTest(r, q)) return null
  const name = clean(r.seller_display_name) || null
  const base = {
    event_id: `me:${r.id}`, occurred_at: r.created_at,
    thread_key: r.thread_key, property_id: r.property_id, prospect_id: r.prospect_id, market: r.market,
    deep_link: links.thread(r.thread_key),
    provenance: { table: 'message_events', row_id: r.id, adapter: 'messages' },
  }
  const sellerRefs = [refs.seller(r.thread_key, name), refs.property(r.property_id, clean(r.property_address) || null)]
  if (r.direction === 'inbound') {
    const intent = clean(r.detected_intent) || null
    return envelope({
      ...base, source_system: 'inbox', event_type: 'seller.replied', severity: 'info',
      actor: { kind: 'seller', label: name },
      entity_refs: sellerRefs,
      summary: `${name || 'Seller'} replied${intent ? ` · ${humanize(intent)}` : ''}`,
      details: { intent, confidence: Number.isFinite(Number(r.classification_confidence)) && r.classification_confidence !== null ? Number(r.classification_confidence) : null, opt_out: r.is_opt_out === true, preview: preview(r.message_body) },
    })
  }
  if (r.direction !== 'outbound') return null
  const origin = clean(q?.source) || clean(r.metadata?.source) || null
  const campaign = CAMPAIGN_SEND_SOURCES.includes(origin)
  if (campaign && !includeCampaignSends) return null
  const failed = r.event_type === 'outbound_send_failed' || clean(r.delivery_status).toLowerCase() === 'failed'
  const delivered = clean(r.delivery_status).toLowerCase() === 'delivered'
  const who = campaign ? 'Campaign text' : origin === 'auto_reply' ? 'Auto reply' : origin === 'inbox_bulk_follow_up' ? 'Follow-up' : OPERATOR_SOURCES.has(origin) ? 'Your message' : 'Message'
  const reason = clean(r.metadata?.failure_class || r.failure_reason) || null
  const campaignId = q?.campaign_id || null
  return envelope({
    ...base,
    source_system: campaign ? 'campaign' : 'queue',
    event_type: failed ? 'message.failed' : 'message.sent',
    severity: failed ? 'warning' : 'info',
    actor: OPERATOR_SOURCES.has(origin) ? { kind: 'operator', label: 'You' } : { kind: 'automation', label: campaign ? 'Campaign' : origin === 'auto_reply' ? 'Auto reply' : null },
    entity_refs: [...sellerRefs, campaign ? refs.campaign(campaignId, campaignName) : null],
    campaign_id: campaignId,
    summary: `${who} ${failed ? 'failed' : 'sent'}${name ? ` · ${name}` : ''}${failed && reason ? ` · ${humanize(reason)}` : delivered ? ' · delivered' : ''}`,
    details: { origin, delivery: clean(r.delivery_status) || null, failure: reason ? humanize(reason) : null, delivered_at: r.delivered_at || null, failed_at: r.failed_at || null, queue_id: r.queue_id || null, preview: preview(r.message_body) },
  })
}

export const messagesAdapter = {
  name: 'messages',
  table: 'message_events',
  systems: ['inbox', 'queue', 'campaign'],
  types: ['seller.replied', 'message.sent', 'message.failed'],
  supports: (subject) => !subject || subject.type === 'seller' || subject.type === 'property',

  async read(scope, { db }) {
    const { subject, systems } = scope
    const wantIn = !systems || systems.has('inbox')
    const wantOut = !systems || systems.has('queue') || (subject && systems.has('campaign'))
    if (!wantIn && !wantOut) return { events: [], complete_above: null }
    if (subject && !subject.thread_keys.length && !subject.property_ids.length) return { events: [], complete_above: null }
    const build = () => {
      let qy = db.from('message_events').select(COLS)
      if (!wantIn) qy = qy.eq('direction', 'outbound')
      else if (!wantOut) qy = qy.eq('direction', 'inbound')
      else qy = qy.in('direction', ['inbound', 'outbound'])
      if (subject) qy = subject.thread_keys.length ? qy.in('thread_key', subject.thread_keys) : qy.in('property_id', subject.property_ids)
      return qy
    }
    // conversation events are sparse among campaign sends: read a wider raw window
    const { rows, complete_above } = await readKeyed(build, { toId: (r) => `me:${r.id}`, cursor: scope.cursor, since: scope.since, until: scope.until, limit: Math.min(1000, scope.limit * (subject ? 1 : 4)) })
    const qids = [...new Set(rows.filter((x) => x.row.direction === 'outbound' && x.row.queue_id).map((x) => String(x.row.queue_id)))]
    const queue = new Map()
    for (let i = 0; i < qids.length; i += 200) {
      const { data } = await db.from('send_queue').select('id, campaign_id, source').in('id', qids.slice(i, i + 200))
      for (const q of data || []) queue.set(String(q.id), q)
    }
    const cids = [...new Set([...queue.values()].map((q) => q.campaign_id).filter(Boolean))]
    const names = new Map()
    if (subject && cids.length) {
      const { data } = await db.from('campaigns').select('id, name').in('id', cids)
      for (const c of data || []) names.set(String(c.id), c.name)
    }
    const events = []
    for (const { row } of rows) {
      const q = row.queue_id ? queue.get(String(row.queue_id)) || null : null
      const e = messageEvent(row, q, { includeCampaignSends: Boolean(subject), campaignName: q?.campaign_id ? names.get(String(q.campaign_id)) || null : null })
      if (e && (!systems || systems.has(e.source_system))) events.push(e)
    }
    return { events, complete_above }
  },
}

