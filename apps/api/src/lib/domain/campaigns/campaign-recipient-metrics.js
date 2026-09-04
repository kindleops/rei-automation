/**
 * Recipient-grain metrics — separate from property-grain graph matches.
 * UI must never treat matched_property_count as sendable recipients.
 *
 * ── CANONICAL SEMANTICS: campaign_targets.status vs .target_status ──────────
 *
 * These are two different axes, both written at build time and easy to confuse.
 * Observed value domains in production (2026-08-17, 2359 rows):
 *
 *   status         ready 2281 · blocked 73 · draft 5
 *   target_status  planned 1619 · ready 612 · blocked 128
 *
 *   `status`        ELIGIBILITY, decided once when the target is built from the
 *                   campaign target graph. "Was this row sendable in principle
 *                   at build time." Written only by the insert at
 *                   campaign-automation-service.js:5917. Never mutated after.
 *
 *   `target_status` DISPATCH LIFECYCLE. Where the row sits in the send funnel:
 *                     ready   -> eligible, not yet hydrated into send_queue
 *                     planned -> hydrated; a send_queue row was created for it
 *                     blocked -> ineligible (block_reason explains why)
 *                   Written at build (same value as `status`) and then advanced
 *                   to 'planned' by the hydration step at :7069.
 *
 * `target_status` is the authoritative readiness signal for "can we send this
 * now", because it is the axis the hydration selector filters on
 * (`.eq('target_status','ready')`). `status` must NOT be used for readiness —
 * it stays 'ready' forever even after a row has been dispatched, so counting it
 * would report every historical target as sendable.
 *
 * Neither column ever carries sent/delivered/replied. Those live in send_queue;
 * aggregateTargetFunnel's sent/delivered/replied buckets read statuses that this
 * table does not produce and are therefore always zero.
 *
 * ── ORPHANS ─────────────────────────────────────────────────────────────────
 * 'planned' is only meaningful while a live send_queue row exists. Nothing in
 * the codebase moves target_status back out of 'planned', so when the queue row
 * reaches a terminal state (cancelled/expired/failed) the target is stranded:
 * invisible to the hydration selector (not 'ready') and with nothing left in the
 * queue to send. See releaseOrphanedCampaignTargets in
 * campaign-target-orphan-recovery.js.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { exactCount, fetchAllCampaignTargets } from './campaign-target-pagination.js'

const ACTIVE_QUEUE_STATUSES = ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending']

function clean(value) {
  return String(value ?? '').trim()
}

export async function computeCampaignRecipientMetrics(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignId) return { ok: false, error: 'campaign_id_required' }

  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('id,status,metadata,queued_count,sent_count,delivered_count,hydration_cursor')
    .eq('id', campaignId)
    .maybeSingle()
  if (campErr) throw campErr
  if (!campaign) return { ok: false, error: 'campaign_not_found' }

  const filters = campaign.metadata?.target_filters || {}

  const { count: targetRowCount } = await supabase
    .from('campaign_targets')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)

  // Paginated: an unbounded select is clamped to max-rows (1000) with no error.
  const statusRows = await fetchAllCampaignTargets(supabase, [campaignId], 'id,target_status')

  const statusCounts = {}
  for (const row of statusRows) {
    const key = clean(row.target_status) || 'unknown'
    statusCounts[key] = (statusCounts[key] || 0) + 1
  }

  const { data: distinctRow } = await supabase.rpc('campaign_recipient_distinct_counts', {
    p_campaign_id: campaignId,
  }).maybeSingle()

  let distinct = distinctRow || null
  if (!distinct) {
    distinct = await computeDistinctCountsFallback(supabase, campaignId)
  }

  const { count: graphMatchCount } = await supabase
    .from('campaign_target_graph')
    .select('graph_id', { count: 'exact', head: true })
    .eq('market', 'Miami, FL')
    .limit(1)

  const matchedPropertyCount = await countGraphMatchesForCampaign(supabase, campaign, graphMatchCount)

  // Counted server-side rather than fetched and tallied: this select had no
  // limit at all, so it was clamped to max-rows (1000) and under-reported the
  // live queue depth on any campaign with more than 1000 lifetime queue rows.
  // `count: 'exact', head: true` is not subject to max-rows.
  const canonicalQueued = await exactCount(supabase, 'send_queue', (q) =>
    q.eq('campaign_id', campaignId).in('queue_status', ACTIVE_QUEUE_STATUSES),
  )

  const readyRecipients = Number(statusCounts.ready || 0)
  const plannedRecipients = Number(statusCounts.planned || 0)

  return {
    ok: true,
    campaign_id: campaignId,
    campaign_status: campaign.status,
    stored_filters: filters,
    matched_property_count: matchedPropertyCount,
    target_row_count: targetRowCount ?? 0,
    distinct_master_owner_count: distinct?.distinct_owners ?? 0,
    distinct_prospect_count: distinct?.distinct_prospects ?? 0,
    unique_phone_count: distinct?.distinct_phones ?? 0,
    unique_e164_count: distinct?.distinct_e164 ?? 0,
    compliant_recipient_count: distinct?.compliant_count ?? 0,
    routable_recipient_count: distinct?.routable_count ?? 0,
    ready_recipient_count: readyRecipients,
    planned_count: plannedRecipients,
    queued_count: canonicalQueued,
    sent_count: Number(campaign.sent_count || 0),
    delivered_count: Number(campaign.delivered_count || 0),
    target_status_counts: statusCounts,
    duplicate_owner_groups: distinct?.duplicate_owner_groups ?? 0,
    duplicate_phone_groups: distinct?.duplicate_phone_groups ?? 0,
    hydration_cursor: campaign.hydration_cursor || null,
  }
}

async function computeDistinctCountsFallback(supabase, campaignId) {
  // Paginated: `.limit(50000)` was clamped to max-rows (1000), so distinct
  // owner/prospect/phone counts were undercounted on any campaign past 1000
  // targets — and silently, since the clamp is not an error.
  const rows = await fetchAllCampaignTargets(
    supabase,
    [campaignId],
    'id,master_owner_id,prospect_id,phone_id,to_phone_number,suppression_status,routing_status,template_status,target_status,identity_status',
  )
  const owners = new Set()
  const prospects = new Set()
  const phones = new Set()
  const e164 = new Set()
  let compliant = 0
  let routable = 0
  const ownerCounts = {}
  const phoneCounts = {}

  for (const row of rows) {
    if (row.master_owner_id) owners.add(row.master_owner_id)
    if (row.prospect_id) prospects.add(row.prospect_id)
    if (row.phone_id) phones.add(row.phone_id)
    const num = clean(row.to_phone_number)
    if (num) {
      e164.add(num)
      phoneCounts[num] = (phoneCounts[num] || 0) + 1
    }
    if (row.master_owner_id) ownerCounts[row.master_owner_id] = (ownerCounts[row.master_owner_id] || 0) + 1
    const suppressed = clean(row.suppression_status) === 'blocked'
    const routingReady = clean(row.routing_status) === 'ready'
    if (!suppressed) compliant += 1
    if (!suppressed && routingReady && clean(row.target_status) === 'ready') routable += 1
  }

  return {
    distinct_owners: owners.size,
    distinct_prospects: prospects.size,
    distinct_phones: phones.size,
    distinct_e164: e164.size,
    compliant_count: compliant,
    routable_count: routable,
    duplicate_owner_groups: Object.values(ownerCounts).filter((n) => n > 1).length,
    duplicate_phone_groups: Object.values(phoneCounts).filter((n) => n > 1).length,
  }
}

async function countGraphMatchesForCampaign(supabase, campaign, fallback) {
  try {
    const filters = campaign.metadata?.target_filters || {}
    const propertyFilters = Array.isArray(filters.properties) ? filters.properties : []
    let query = supabase.from('campaign_target_graph').select('graph_id', { count: 'exact', head: true })
    for (const filter of propertyFilters) {
      const key = clean(filter.field_key)
      const values = Array.isArray(filter.value) ? filter.value : [filter.value]
      if (key === 'properties.market' && values.length) {
        query = query.in('market', values.map(clean).filter(Boolean))
      }
      if (key === 'properties.property_type' && values.length) {
        query = query.in('canonical_property_group', values.map(clean).filter(Boolean))
      }
    }
    const { count, error } = await query
    if (!error && count != null) return count
  } catch {
    // graph filter columns may vary
  }
  return fallback ?? null
}

export async function fetchCampaignTargetStatusCounts(campaignIds = [], deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignIds.length) return new Map()
  /**
   * Previously `.limit(100000)`, which PostgREST silently clamped to max-rows
   * (1000). Because this is a single query spanning ALL campaigns, the cap was
   * shared across them: with 2359 target rows the campaign list reported ~1000
   * targets in total and attributed them to whichever campaigns happened to
   * sort first. Miami showed "630 tgt / 10 ready" against a true 802 / 802.
   */
  const data = await fetchAllCampaignTargets(
    supabase,
    campaignIds,
    'id,campaign_id,target_status,block_reason',
  )

  const byCampaign = new Map()
  // Seed every requested campaign so one with zero targets reports 0 rather
  // than being absent from the map (callers treat "missing" as "unknown").
  for (const id of campaignIds) {
    byCampaign.set(id, { statuses: {}, blocked: {}, total: 0 })
  }
  for (const row of data) {
    const id = row.campaign_id
    if (!byCampaign.has(id)) {
      byCampaign.set(id, { statuses: {}, blocked: {}, total: 0 })
    }
    const bucket = byCampaign.get(id)
    bucket.total += 1
    const status = clean(row.target_status) || 'unknown'
    bucket.statuses[status] = (bucket.statuses[status] || 0) + 1
    if (row.block_reason) bucket.blocked[row.block_reason] = (bucket.blocked[row.block_reason] || 0) + 1
  }
  return byCampaign
}