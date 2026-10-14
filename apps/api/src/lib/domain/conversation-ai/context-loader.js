// READ-ONLY loader for one inbound's context (prod shadow). Every read is a bounded,
// indexed select on an injected client; nothing is written. The result is the
// argument object of buildConversationContext() — the builder enforces the
// single-thread / single-phone / single-property invariants on what is loaded.
//
//   message_events  by provider_message_sid (unique)  → the inbound row
//                   by thread_key (indexed), last 75 days, ≤ 40 rows
//   send_queue      by thread_key (indexed), ≤ 60 rows → use cases + scheduled follow-ups
//   seller_offers   by thread_key (indexed)            → authoritative offers only
//   properties      by property_id (unique)            → type / city / state / zone
//   prospects       by prospect_id (pk)                → first name + names to mask
//
// 8.5.15: the inbound row is a separate one-row read (loadInboundRow) so the runtime
// job checks its VERSION and the existing shadow record BEFORE any thread read: a
// duplicate / retried / stale-version job never reloads the thread. The thread read
// is bounded (≤ 40 events, ≤ 60 queue rows, ≤ 10 offers, ≤ 5 properties, 1 prospect,
// 75 days) — never the full history.
import { firstNameOnly } from './pii.js'

export const CONTEXT_LIMITS = Object.freeze({ days: 75, events: 40, queue: 60, offers: 10, properties: 5 })
const INBOUND_COLUMNS = 'id,thread_key,from_phone_number,to_phone_number,message_body,event_timestamp,received_at,created_at,property_id,prospect_id,detected_intent,language'

const SCHEDULED = new Set(['scheduled', 'queued', 'pending', 'held'])

async function rows(q) {
  const r = await q
  if (r?.error) throw Object.assign(new Error('CONTEXT_READ_FAILED'), { code: 'CONTEXT_READ_FAILED' })
  return Array.isArray(r?.data) ? r.data : r?.data ? [r.data] : []
}

/**
 * @param {{ supabase: object, providerMessageSid: string, now?: string }} a
 * @returns {Promise<{ input: object, row: object }|null>} null when the inbound row is not found
 */
/** The inbound row alone (provider_message_sid is unique): one indexed read. null when absent. */
export async function loadInboundRow({ supabase, providerMessageSid }) {
  if (!supabase?.from) throw Object.assign(new Error('NO_CLIENT'), { code: 'NO_CLIENT' })
  const [inbound] = await rows(supabase.from('message_events').select(INBOUND_COLUMNS).eq('provider_message_sid', providerMessageSid).eq('direction', 'inbound').limit(1))
  return inbound?.thread_key ? inbound : null
}

/**
 * @param {{ supabase: object, providerMessageSid: string, now?: string, inbound?: object }} a
 *   inbound: the row from loadInboundRow (not re-read when given)
 */
export async function loadShadowContext({ supabase, providerMessageSid, now = new Date().toISOString(), inbound: given = null }) {
  if (!supabase?.from) throw Object.assign(new Error('NO_CLIENT'), { code: 'NO_CLIENT' })
  const inbound = given || (await loadInboundRow({ supabase, providerMessageSid }))
  if (!inbound?.thread_key) return null
  const L = CONTEXT_LIMITS
  const since = new Date(Date.parse(now) - L.days * 864e5).toISOString()
  const [events, queue, offers] = await Promise.all([
    rows(supabase.from('message_events').select('id,direction,thread_key,from_phone_number,to_phone_number,message_body,event_timestamp,created_at,property_id,detected_intent,queue_id').eq('thread_key', inbound.thread_key).gte('created_at', since).order('created_at', { ascending: false }).limit(L.events)),
    rows(supabase.from('send_queue').select('id,use_case_template,queue_status,scheduled_for_utc,created_at').eq('thread_key', inbound.thread_key).gte('created_at', since).order('created_at', { ascending: false }).limit(L.queue)),
    rows(supabase.from('seller_offers').select('id,property_id,purchase_price,status,created_at').eq('thread_key', inbound.thread_key).limit(L.offers)),
  ])
  const propertyIds = [...new Set([inbound.property_id, ...events.map((e) => e.property_id)].filter(Boolean))].slice(0, L.properties)
  const [props, prospects] = await Promise.all([
    propertyIds.length ? rows(supabase.from('properties').select('property_id,property_type,property_address_city,property_address_state,property_address_zip,timezone,owner_1_name,owner_2_name,owner_name').in('property_id', propertyIds).limit(L.properties)) : [],
    inbound.prospect_id ? rows(supabase.from('prospects').select('prospect_id,first_name,full_name,timezone').eq('prospect_id', inbound.prospect_id).limit(1)) : [],
  ])
  const useCaseByQueue = new Map(queue.map((q) => [q.id, q.use_case_template]))
  const at = (r) => r.event_timestamp || r.received_at || r.created_at
  const sellerPhone = inbound.from_phone_number
  const thread = events.map((e) => ({
    id: e.id, direction: e.direction === 'inbound' ? 'inbound' : 'outbound', body: e.message_body || '', at: at(e),
    thread_key: e.thread_key, seller_phone: e.direction === 'inbound' ? e.from_phone_number : e.to_phone_number,
    use_case: e.queue_id ? useCaseByQueue.get(e.queue_id) || null : null, property_id: e.property_id, intent: e.detected_intent || null,
  }))
  const p = prospects[0] || null
  const names = [p?.full_name, ...props.flatMap((x) => [x.owner_1_name, x.owner_2_name, x.owner_name])].filter(Boolean)
  return {
    row: inbound,
    timezone: p?.timezone || props[0]?.timezone || null,
    geography: props.find((x) => x.property_id === inbound.property_id) ? { state: props.find((x) => x.property_id === inbound.property_id).property_address_state || null, zip: props.find((x) => x.property_id === inbound.property_id).property_address_zip || null } : null,
    input: {
      now,
      inbound: { id: inbound.id, body: inbound.message_body || '', at: at(inbound), thread_key: inbound.thread_key, from_phone: sellerPhone, property_id: inbound.property_id },
      thread,
      properties: props.map((x) => ({ property_id: x.property_id, property_type: x.property_type, city: x.property_address_city, state: x.property_address_state })),
      offers: offers.map((o) => ({ id: o.id, property_id: o.property_id, amount: o.purchase_price != null ? Number(o.purchase_price) : null, status: o.status, created_at: o.created_at, source_table: 'seller_offers' })),
      followups: queue.filter((q) => SCHEDULED.has(String(q.queue_status || '').toLowerCase())).map((q) => ({ use_case: q.use_case_template, due_at: q.scheduled_for_utc, status: q.queue_status })),
      names: { full_names: names, first_name: firstNameOnly(p?.first_name || p?.full_name || null) },
      language: inbound.language || null,
    },
  }
}
