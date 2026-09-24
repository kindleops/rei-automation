/**
 * How sellers responded to a campaign, from the message log.
 *
 * Every campaign's reply_count, positive_reply_count and opt_out_count come
 * from campaign_targets.target_status values — replied, replied_positive,
 * opt_out — that no target in production has ever held (only ready, planned
 * and blocked occur). So every campaign read "0 replies" and "0% reply rate".
 * Miami, on 2026-09-24: 41 of the 350 sellers it messaged had texted back.
 *
 * A reply here is precise and checkable: an inbound message FROM the seller's
 * number TO the number that sent them this campaign's message, AFTER that
 * message went out. A seller who also heard from another campaign on a
 * different number is not counted twice. Read-only.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

const SENT_STATUSES = ['sent', 'delivered']
const PAGE = 1000
const MAX_PAGES = 25
// 40 sellers per request, at most 1000 messages back (PostgREST's row cap):
// room for 25 replies a seller before a chunk could fill. A full chunk is
// reported as `truncated` rather than passed off as complete.
const PHONE_CHUNK = 40
const MESSAGE_CAP = 1000
const LATEST_LIMIT = 60

// The classifier's intents that mean "stop texting me".
const STOP_INTENTS = new Set(['opt_out', 'stop', 'unsubscribe', 'dnc'])

function clean(value) {
  return String(value ?? '').trim()
}

const pairKey = (seller, sender) => `${clean(seller)}|${clean(sender)}`

async function scanSent(supabase, campaignId) {
  const rows = []
  let total = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = rows.length
    const { data, error, count } = await supabase
      .from('send_queue')
      .select('id,to_phone_number,from_phone_number,sent_at,updated_at', page === 0 ? { count: 'exact' } : undefined)
      .eq('campaign_id', campaignId)
      .in('queue_status', SENT_STATUSES)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const batch = data || []
    if (page === 0 && Number.isFinite(count)) total = count
    rows.push(...batch)
    if (batch.length === 0) break
    if (total !== null ? rows.length >= total : batch.length < PAGE) break
  }
  return rows
}

export async function fetchCampaignResponses(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignId) return { ok: false, error: 'campaign_id_required' }

  // First time each seller heard from each of our numbers in this campaign.
  const firstSent = new Map()
  const sellers = new Set()
  for (const row of await scanSent(supabase, campaignId)) {
    const seller = clean(row.to_phone_number)
    const sender = clean(row.from_phone_number)
    const at = row.sent_at || row.updated_at
    if (!seller || !sender || !at) continue
    sellers.add(seller)
    const key = pairKey(seller, sender)
    const prev = firstSent.get(key)
    if (!prev || Date.parse(at) < Date.parse(prev)) firstSent.set(key, at)
  }

  const empty = {
    ok: true,
    campaign_id: campaignId,
    sellers_messaged: sellers.size,
    sellers_replied: 0,
    reply_messages: 0,
    sellers_asked_to_stop: 0,
    latest_reply_at: null,
    truncated: false,
    intents: {},
    latest: [],
  }
  if (sellers.size === 0) return empty

  const earliest = [...firstSent.values()].reduce((min, at) => (Date.parse(at) < Date.parse(min) ? at : min))
  const phones = [...sellers]
  const chunks = []
  for (let i = 0; i < phones.length; i += PHONE_CHUNK) chunks.push(phones.slice(i, i + PHONE_CHUNK))

  const results = await Promise.all(chunks.map((chunk) => supabase
    .from('message_events')
    .select('id,from_phone_number,to_phone_number,created_at,message_body,detected_intent,is_opt_out,thread_key,seller_display_name')
    .eq('direction', 'inbound')
    .in('from_phone_number', chunk)
    .gte('created_at', earliest)
    .order('created_at', { ascending: false })
    .limit(MESSAGE_CAP)))

  const bySeller = new Map()
  let replyMessages = 0
  let truncated = false
  for (const { data, error } of results) {
    if (error) throw error
    if ((data || []).length >= MESSAGE_CAP) truncated = true
    for (const msg of data || []) {
      const first = firstSent.get(pairKey(msg.from_phone_number, msg.to_phone_number))
      // Only replies to the number that sent this campaign's message, after it went out.
      if (!first || Date.parse(msg.created_at) <= Date.parse(first)) continue
      replyMessages += 1
      const seller = clean(msg.from_phone_number)
      const entry = bySeller.get(seller) || { latest: null, askedToStop: false }
      if (!entry.latest || Date.parse(msg.created_at) > Date.parse(entry.latest.created_at)) entry.latest = msg
      if (msg.is_opt_out === true || STOP_INTENTS.has(clean(msg.detected_intent).toLowerCase())) entry.askedToStop = true
      bySeller.set(seller, entry)
    }
  }

  const intents = {}
  let askedToStop = 0
  let latestAt = null
  for (const { latest, askedToStop: stop } of bySeller.values()) {
    // Each seller counted once, by what they said most recently.
    const intent = clean(latest.detected_intent).toLowerCase() || 'unclassified'
    intents[intent] = (intents[intent] || 0) + 1
    if (stop) askedToStop += 1
    if (!latestAt || Date.parse(latest.created_at) > Date.parse(latestAt)) latestAt = latest.created_at
  }

  const latest = [...bySeller.entries()]
    .map(([seller, { latest: msg, askedToStop: stop }]) => ({
      seller_phone: seller,
      seller_name: clean(msg.seller_display_name) || null,
      message: clean(msg.message_body) || null,
      intent: clean(msg.detected_intent) || null,
      asked_to_stop: stop,
      thread_key: clean(msg.thread_key) || null,
      at: msg.created_at,
    }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, LATEST_LIMIT)

  return {
    ...empty,
    sellers_replied: bySeller.size,
    reply_messages: replyMessages,
    sellers_asked_to_stop: askedToStop,
    latest_reply_at: latestAt,
    truncated,
    intents,
    latest,
  }
}
