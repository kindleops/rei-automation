/**
 * A campaign's messages — what is waiting to send and what went out — read
 * from send_queue, the fact table.
 *
 * The mobile Queue listed campaign_send_windows instead: planning slots that
 * are written once as "planned" and never updated (all 109 in production are
 * "planned", 107 of them in the past). Miami showed June windows labelled
 * SCHEDULED under a header reading "Scheduled 0". Its real queue on
 * 2026-09-24: nothing waiting, 354 sent.
 *
 * Read-only. Counts are exact (one head count per bucket); rows are a bounded
 * page, named from the campaign's own target snapshot.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { EXECUTION_FAILURE_STATUSES } from './campaign-failures.js'

export const MESSAGE_BUCKETS = {
  upcoming: ['scheduled', 'queued', 'ready', 'pending', 'approval'],
  sending: ['processing', 'sending'],
  sent: ['sent', 'delivered'],
}

const DEFAULT_LIMIT = 40
const MAX_LIMIT = 100
const TARGET_LOOKUP_CHUNK = 100

// Only the metadata keys that mark a row as test-only; the whole document is
// kilobytes per row.
const ROW_SELECT = [
  'id', 'queue_status', 'scheduled_for', 'sent_at', 'delivered_at', 'updated_at',
  'to_phone_number', 'from_phone_number', 'market', 'property_address', 'campaign_target_id', 'master_owner_id', 'thread_key', 'failed_reason',
  'meta_no_send:metadata->>no_send', 'meta_proof_no_send:metadata->>proof_no_send', 'meta_launch_mode:metadata->>launch_mode',
].join(',')

const ORDER = {
  // Next to go first.
  upcoming: { column: 'scheduled_for', ascending: true },
  sending: { column: 'updated_at', ascending: false },
  // Most recent first.
  sent: { column: 'sent_at', ascending: false },
}

function clean(value) {
  return String(value ?? '').trim()
}

const truthy = (value) => ['true', '1', 'yes'].includes(clean(value).toLowerCase())

async function countStatuses(supabase, campaignId, statuses) {
  const { count, error } = await supabase
    .from('send_queue')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('queue_status', statuses)
  if (error) throw error
  return Number(count || 0)
}

/** Look rows up by id, 100 at a time, keyed by `key`. Enrichment: errors are skipped. */
async function lookupById(supabase, table, select, key, ids) {
  const unique = [...new Set(ids)]
  const chunks = []
  for (let i = 0; i < unique.length; i += TARGET_LOOKUP_CHUNK) chunks.push(unique.slice(i, i + TARGET_LOOKUP_CHUNK))
  const results = await Promise.all(chunks.map((chunk) => supabase.from(table).select(select).in(key, chunk)))
  const map = new Map()
  for (const { data, error } of results) {
    // Without a name the row still shows its number; never fail the page for one.
    if (error) continue
    for (const row of data || []) map.set(row[key], row)
  }
  return map
}

export function normalizeMessageBucket(value) {
  const bucket = clean(value).toLowerCase()
  return Object.prototype.hasOwnProperty.call(MESSAGE_BUCKETS, bucket) ? bucket : 'upcoming'
}

/**
 * @param {string} campaignId
 * @param {{ bucket?: string, limit?: number }} options
 * @param {{ supabase?: object }} deps
 */
export async function fetchCampaignMessages(campaignId, options = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignId) return { ok: false, error: 'campaign_id_required' }

  const bucket = normalizeMessageBucket(options.bucket)
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(options.limit) || DEFAULT_LIMIT)))
  const order = ORDER[bucket]

  const [upcoming, sending, sent, delivered, notSent, page] = await Promise.all([
    countStatuses(supabase, campaignId, MESSAGE_BUCKETS.upcoming),
    countStatuses(supabase, campaignId, MESSAGE_BUCKETS.sending),
    countStatuses(supabase, campaignId, MESSAGE_BUCKETS.sent),
    countStatuses(supabase, campaignId, ['delivered']),
    countStatuses(supabase, campaignId, EXECUTION_FAILURE_STATUSES),
    supabase
      .from('send_queue')
      .select(ROW_SELECT)
      .eq('campaign_id', campaignId)
      .in('queue_status', MESSAGE_BUCKETS[bucket])
      .order(order.column, { ascending: order.ascending, nullsFirst: false })
      .order('id', { ascending: true })
      .limit(limit),
  ])
  if (page.error) throw page.error

  const rows = page.data || []
  // The target snapshot names the seller; older rows without one fall back to
  // the owner record (Miami's latest sends carry no target id).
  const targets = await lookupById(
    supabase, 'campaign_targets', 'id,owner_name,property_address,market', 'id',
    rows.map((row) => row.campaign_target_id).filter(Boolean),
  )
  const owners = await lookupById(
    supabase, 'master_owners', 'master_owner_id,display_name', 'master_owner_id',
    rows.filter((row) => !clean(targets.get(row.campaign_target_id)?.owner_name) && row.master_owner_id)
      .map((row) => row.master_owner_id),
  )

  return {
    ok: true,
    campaign_id: campaignId,
    bucket,
    counts: { upcoming, sending, sent, delivered, not_sent: notSent },
    messages: rows.map((row) => {
      const target = row.campaign_target_id ? targets.get(row.campaign_target_id) : null
      const owner = row.master_owner_id ? owners.get(row.master_owner_id) : null
      return {
        id: row.id,
        status: clean(row.queue_status).toLowerCase(),
        scheduled_for: row.scheduled_for || null,
        sent_at: row.sent_at || null,
        delivered_at: row.delivered_at || null,
        updated_at: row.updated_at || null,
        seller_name: clean(target?.owner_name) || clean(owner?.display_name) || null,
        property_address: clean(target?.property_address || row.property_address) || null,
        market: clean(row.market || target?.market) || null,
        to_phone_number: row.to_phone_number || null,
        from_phone_number: row.from_phone_number || null,
        failed_reason: row.failed_reason || null,
        // Opens the seller's conversation in the Inbox.
        thread_key: clean(row.thread_key) || null,
        // A proof/test row sits in the queue but will never transmit.
        test_only: truthy(row.meta_no_send) || truthy(row.meta_proof_no_send)
          || clean(row.meta_launch_mode) === 'proof_hydration_no_send',
      }
    }),
    has_more: rows.length >= limit,
  }
}
