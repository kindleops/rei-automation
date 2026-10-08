/**
 * EXACT-SELECTION PREVIEW — a pinned set of property ids, resolved read-only
 * through the same readiness rule the target builder uses.
 *
 * Contract:
 *   - Only the requested property ids are ever read (`.in('property_id', ids)`).
 *     Any graph row outside the request is reported as an integrity failure and
 *     the preview fails; it is never included.
 *   - Every requested property gets exactly one outcome with an explicit reason:
 *       included    ready for a campaign draft (still subject to launch checks)
 *       excluded    fails the authoritative readiness rule (reason = block reason)
 *       held        already in a queue lane (active queue item / pending prior touch)
 *       duplicate   same canonical recipient as a higher-priority selected property
 *       unresolved  no campaign-graph row, or no canonical phone for the property
 *   - No writes. No campaign targets, no send_queue rows.
 *
 * The draft itself is created through the existing explicit-selection path
 * (`properties.property_id in [...]` target filter), whose build is guarded by
 * checkExplicitTargetContainment(); this preview is the operator-facing check
 * that the pinned set is exactly what was requested before that draft exists.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import {
  CAMPAIGN_TARGET_GRAPH_TABLE,
  CAMPAIGN_TARGET_GRAPH_SELECT,
  resolveCampaignTargetReadiness,
} from '@/lib/domain/campaigns/campaign-automation-service.js'
import { comparePropertyPriority } from '@/lib/domain/campaigns/campaign-recipient-dedup.js'

export const EXACT_SELECTION_MAX = 5000
const CHUNK = 200

function clean(value) {
  return String(value ?? '').trim()
}

function phoneKey(value) {
  const d = String(value ?? '').replace(/\D/g, '')
  if (d.length === 10) return `+1${d}`
  if (d.length === 11 && d.startsWith('1')) return `+${d}`
  return null
}

export function normalizeSelectionIds(ids = []) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = clean(raw)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Pure classification. `rowsByProperty` maps property_id -> graph rows.
 * Exported for tests; previewExactSelection() supplies the rows.
 */
export function classifyExactSelection(requestedIds = [], rows = []) {
  const requested = normalizeSelectionIds(requestedIds)
  const requestedSet = new Set(requested)
  const outside = rows.filter((row) => !requestedSet.has(clean(row.property_id)))

  const byProperty = new Map()
  for (const row of rows) {
    const id = clean(row.property_id)
    if (!requestedSet.has(id)) continue
    if (!byProperty.has(id)) byProperty.set(id, [])
    byProperty.get(id).push(row)
  }

  const results = []
  const candidates = []
  for (const id of requested) {
    const propertyRows = byProperty.get(id) || []
    if (propertyRows.length === 0) {
      results.push({ property_id: id, status: 'unresolved', reason: 'not_in_campaign_graph' })
      continue
    }
    const withPhone = propertyRows.filter((row) => phoneKey(row.canonical_e164))
    if (withPhone.length === 0) {
      const reason = clean(propertyRows[0].queue_block_reason) || 'missing_phone'
      results.push({ property_id: id, status: 'unresolved', reason, address: propertyRows[0].property_address_full || null })
      continue
    }
    // One recipient per property: the highest-priority row with a phone.
    const row = [...withPhone].sort(comparePropertyPriority)[0]
    candidates.push(row)
  }

  // Dedupe by canonical recipient phone across the selection (priority order).
  const seenPhones = new Map()
  for (const row of [...candidates].sort(comparePropertyPriority)) {
    const id = clean(row.property_id)
    const phone = phoneKey(row.canonical_e164)
    const base = {
      property_id: id,
      address: row.property_address_full || null,
      owner_name: row.owner_name || row.seller_full_name || null,
      identity_alignment: row.identity_alignment || null,
      phone_present: true,
      vendor_dnc_advisory: row.blocker_flags?.vendor_dnc === true ? true : row.blocker_flags?.vendor_dnc === false ? false : 'unknown',
      sender_market: row.sender_market || null,
    }
    if (seenPhones.has(phone)) {
      results.push({ ...base, status: 'duplicate', reason: `same_recipient_as:${seenPhones.get(phone)}` })
      continue
    }
    seenPhones.set(phone, id)
    if (row.active_queue_item || row.pending_prior_touch) {
      results.push({ ...base, status: 'held', reason: row.active_queue_item ? 'active_queue_item' : 'pending_prior_touch' })
      continue
    }
    const readiness = resolveCampaignTargetReadiness(row)
    if (!readiness.ready) {
      results.push({ ...base, status: 'excluded', reason: readiness.blockReason })
      continue
    }
    results.push({ ...base, status: 'included', reason: null })
  }

  const order = new Map(requested.map((id, i) => [id, i]))
  results.sort((a, b) => order.get(a.property_id) - order.get(b.property_id))
  const counts = { included: 0, excluded: 0, held: 0, duplicate: 0, unresolved: 0 }
  for (const r of results) counts[r.status] += 1

  return {
    ok: outside.length === 0,
    error: outside.length ? 'rows_outside_selection' : null,
    requested_count: requested.length,
    outcome_count: results.length,
    outside_selection_count: outside.length,
    counts,
    results,
  }
}

export async function previewExactSelection(input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const ids = normalizeSelectionIds(input.property_ids)
  if (ids.length === 0) return { ok: false, status: 400, error: 'empty_selection' }
  if (ids.length > EXACT_SELECTION_MAX) return { ok: false, status: 413, error: 'selection_too_large', max: EXACT_SELECTION_MAX }

  // Cohort scope confirmation: a whole-cohort selection must state the count the
  // operator confirmed; a mismatch means the cohort changed under them.
  if (input.cohort_confirmation && Number(input.cohort_confirmation.confirmed_count) !== ids.length) {
    return { ok: false, status: 409, error: 'cohort_count_changed', confirmed_count: input.cohort_confirmation.confirmed_count, current_count: ids.length }
  }

  const rows = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const { data, error } = await supabase.from(CAMPAIGN_TARGET_GRAPH_TABLE).select(CAMPAIGN_TARGET_GRAPH_SELECT).in('property_id', chunk)
    if (error) return { ok: false, status: 503, error: 'campaign_graph_unavailable', message: error.message }
    rows.push(...(data || []))
  }
  const result = classifyExactSelection(ids, rows)
  return {
    ...result,
    dry_run: true,
    no_campaign_targets_created: true,
    no_send_queue_rows_created: true,
    target_filter: { field_key: 'properties.property_id', operator: 'in', value: ids },
  }
}
