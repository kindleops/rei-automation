/**
 * Recipient-grain metrics — separate from property-grain graph matches.
 * UI must never treat matched_property_count as sendable recipients.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

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

  const { data: statusRows } = await supabase
    .from('campaign_targets')
    .select('target_status')
    .eq('campaign_id', campaignId)

  const statusCounts = {}
  for (const row of statusRows || []) {
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

  const { data: queueRows } = await supabase
    .from('send_queue')
    .select('id,queue_status')
    .eq('campaign_id', campaignId)

  let canonicalQueued = 0
  for (const row of queueRows || []) {
    if (ACTIVE_QUEUE_STATUSES.includes(clean(row.queue_status).toLowerCase())) canonicalQueued += 1
  }

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
  const { data: targets } = await supabase
    .from('campaign_targets')
    .select('master_owner_id,prospect_id,phone_id,to_phone_number,suppression_status,routing_status,template_status,target_status,identity_status')
    .eq('campaign_id', campaignId)
    .limit(50000)

  const rows = targets || []
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

/**
 * Per-campaign send_queue status counts — provider truth for sent, delivered
 * and failed. Returns null when the aggregate is unavailable, so the caller
 * falls back to the (weaker) target-status derivation rather than reporting
 * zero sends for a campaign that has sent.
 */
export async function fetchCampaignSendStateCounts(campaignIds = [], deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignIds.length) return new Map()
  if (typeof supabase?.rpc !== 'function') return null
  const { data, error } = await supabase.rpc('campaign_send_state_counts', { p_campaign_ids: campaignIds })
  if (error) {
    const message = String(error.message || '').toLowerCase()
    const missing = error.code === 'PGRST202' || message.includes('does not exist') || message.includes('not find')
    if (missing) return null
    throw error
  }
  if (!Array.isArray(data)) return null

  const byCampaign = new Map()
  for (const row of data) {
    const id = row.campaign_id
    if (!byCampaign.has(id)) byCampaign.set(id, {})
    const bucket = byCampaign.get(id)
    const status = clean(row.queue_status) || 'unknown'
    bucket[status] = (bucket[status] || 0) + Number(row.row_count || 0)
  }
  return byCampaign
}

/**
 * Grouped counts from the database. Returns null when the function is absent,
 * so the caller can fall back rather than report zero.
 */
async function fetchTargetStatusCountsViaRpc(supabase, campaignIds) {
  // A client without `.rpc` (or an environment without the function) must fall
  // back to the row scan, not fail — the counts matter more than the shortcut.
  if (typeof supabase?.rpc !== 'function') return null
  const { data, error } = await supabase.rpc('campaign_target_status_counts', { p_campaign_ids: campaignIds })
  if (error) {
    // Missing function / no permission: fall back to the row scan. Any other
    // error is a real failure and must not be mistaken for "no targets".
    const message = String(error.message || '').toLowerCase()
    const missing = error.code === 'PGRST202' || message.includes('does not exist') || message.includes('not find')
    if (missing) return null
    throw error
  }
  if (!Array.isArray(data)) return null

  const byCampaign = new Map()
  for (const row of data) {
    const id = row.campaign_id
    if (!byCampaign.has(id)) byCampaign.set(id, { statuses: {}, blocked: {}, total: 0 })
    const bucket = byCampaign.get(id)
    const n = Number(row.row_count || 0)
    bucket.total += n
    const status = clean(row.target_status) || 'unknown'
    bucket.statuses[status] = (bucket.statuses[status] || 0) + n
    const reason = clean(row.block_reason)
    if (reason) bucket.blocked[reason] = (bucket.blocked[reason] || 0) + n
  }
  return byCampaign
}

/**
 * One page of the target scan. PostgREST enforces its own `db-max-rows`
 * server side, so a `.limit()` above it is silently ignored — the reason this
 * function has to page rather than ask for everything at once.
 */
const TARGET_SCAN_PAGE = 1000

/**
 * Per-campaign target status/blocked-reason counts.
 *
 * These numbers ARE the campaign list's target counts, so a truncated scan is
 * a lie on every card. The previous single query asked for `.limit(100000)`
 * and looked safe, but PostgREST capped the response at its own max-rows and
 * returned 1000 of the 2,578 existing rows with no error and no signal —
 * so the list reported exactly 1000 targets across all campaigns
 * (kpis.totalTargets: 1000) while 1,578 were invisible, and individual
 * campaigns were undercounted at the cut: "Entity Graph · 5 properties" has
 * two rows in campaign_targets and the list said one.
 *
 * Paging until a short page arrives is what makes the count exact. Bounded so
 * a runaway cursor cannot spin: the ceiling is far above any real corpus and
 * exhausting it is reported rather than silently accepted.
 */
export async function fetchCampaignTargetStatusCounts(campaignIds = [], deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignIds.length) return new Map()

  /**
   * Aggregate in the DATABASE first.
   *
   * The scan below is exact but pages every matching row into this process to
   * group it — 2,578 rows on 2026-09-15 — and that was a dominant cost in the
   * Campaign Command list response. `campaign_target_status_counts` does the
   * GROUP BY in Postgres and returns 46 rows for the same answer.
   *
   * The row scan is kept as a fallback, not deleted: an environment without
   * the function must still get CORRECT counts rather than none, and this is
   * the surface where a silently-wrong count did real damage.
   */
  const viaRpc = await fetchTargetStatusCountsViaRpc(supabase, campaignIds)
  if (viaRpc) return viaRpc

  const byCampaign = new Map()
  const MAX_PAGES = 500
  let offset = 0
  let pages = 0

  for (;;) {
    const { data, error } = await supabase
      .from('campaign_targets')
      .select('campaign_id,target_status,block_reason')
      .in('campaign_id', campaignIds)
      // A stable order is required, or paging can repeat and skip rows.
      .order('campaign_id', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + TARGET_SCAN_PAGE - 1)
    if (error) throw error

    const rows = data || []
    for (const row of rows) {
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

    pages += 1
    if (rows.length < TARGET_SCAN_PAGE) break
    offset += rows.length
    if (pages >= MAX_PAGES) {
      console.warn('campaign_target_counts.scan_ceiling_reached', {
        campaigns: campaignIds.length, scanned: offset, pages,
      })
      break
    }
  }

  return byCampaign
}