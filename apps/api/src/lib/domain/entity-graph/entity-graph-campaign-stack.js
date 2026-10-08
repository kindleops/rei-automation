/**
 * ENTITY GRAPH → CAMPAIGN · STACKED COHORTS (owner, 2026-10-08).
 *
 *   run filter A → add to campaign X; run filter B → add to the same X.
 *
 * WHAT THIS WRITES — and the whole of it: one campaign DRAFT's targeting
 * definition. The cohort is pinned as explicit property ids
 * (`properties.property_id is any of [...]`, the same explicit-selection
 * shape the campaign builder, its containment guard and resolveCampaignTargetMode
 * already understand), unioned with what the draft already pins, plus an
 * audit trail of each added segment in metadata.entity_graph_stack.
 *
 * WHAT THIS NEVER DOES: build campaign_targets, change status, schedule,
 * launch, write send_queue. Campaigns' own Build runs the target graph and
 * every gate (suppression, contactability, identity, sender routing,
 * templates) on the pinned set, exactly as for any other campaign.
 *
 * THE COUNTS come from the campaign target graph through
 * resolveCampaignTargetReadiness — the builder's own per-row rule:
 *   already_present   pinned on the draft before this run
 *   added_ready       has ≥1 graph row that is ready today
 *   added_held        queue-eligible graph rows, held by a readiness reason
 *                     (entity contact review, identity, timezone…) — pinned,
 *                     because Build carries them as held targets that can clear
 *   ineligible        not pinned: no graph row (not in the campaign audience)
 *                     or no queue-eligible row (no phone, suppressed, wrong
 *                     number, no SMS line, no sender coverage…) — by reason
 *
 * Refusals (nothing is written): the campaign is not a draft; the draft uses
 * dynamic filters (pinning ids beside them would INTERSECT, not stack); a
 * search term (search is ranked, not a cohort); a cohort over the stacking
 * limit — stated with its exact size, never silently clipped.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import {
  applyEntityGraphFieldFilters,
  resolveEntityGraphFieldFiltersOrThrow,
} from './entity-graph-field-filters.js'
import { applyOwnerFilters, applyPropertyFilters, applyProspectFilters, parseBrowseFilters } from './entity-graph-service.js'
import { isTestPropertyId } from './entity-graph-truth.js'
import { propertySmsEligibility } from './entity-graph-outreach-state.js'

/** Total pinned properties one campaign can carry through Entity Graph stacking. */
export const STACK_MAX_PROPERTIES = 25000
export const STACK_MAX_SEGMENTS = 50
export const STACK_WRITE_ATTEMPTS = 4
const PAGE = 1000
const CHUNK = 150

const clean = (v) => String(v ?? '').trim()
const uniq = (values) => [...new Set((values || []).map(clean).filter(Boolean))]

export class StackRefusal extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

async function readOrThrow(query) {
  const { data, error } = await query
  if (error) throw error
  return data || []
}

/** Keyset over one key column; refuses past `max` (counts one past it to know). */
async function keysetIds({ build, key, max, noun }) {
  const out = []
  let last = null
  for (;;) {
    let q = build().order(key, { ascending: true }).limit(PAGE)
    if (last !== null) q = q.gt(key, last)
    const page = await readOrThrow(q)
    for (const row of page) {
      const id = clean(row[key])
      if (id) out.push({ id, row })
    }
    if (out.length > max) {
      throw new StackRefusal(422, 'cohort_too_large', `This cohort is larger than ${max.toLocaleString('en-US')} ${noun}. Narrow it with another filter, or add it to the campaign in parts.`, { limit: max })
    }
    if (page.length < PAGE) break
    last = clean(page[page.length - 1][key])
  }
  return out
}

async function propertiesForOwners(supabase, ownerIds) {
  const out = []
  const ids = uniq(ownerIds)
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK)
    let last = null
    for (;;) {
      let q = supabase.from('properties').select('property_id, master_owner_id').in('master_owner_id', part).order('property_id', { ascending: true }).limit(PAGE)
      if (last !== null) q = q.gt('property_id', last)
      const page = await readOrThrow(q)
      out.push(...page.map((row) => clean(row.property_id)).filter(Boolean))
      if (page.length < PAGE) break
      last = clean(page[page.length - 1].property_id)
    }
    if (out.length > STACK_MAX_PROPERTIES) {
      throw new StackRefusal(422, 'cohort_too_large', `These owners hold more than ${STACK_MAX_PROPERTIES.toLocaleString('en-US')} properties. Narrow the cohort, or add it in parts.`, { limit: STACK_MAX_PROPERTIES })
    }
  }
  return uniq(out)
}

/**
 * The cohort as property ids. Selection = the ids given; cohort = every row
 * the tab's own browse query returns under these filters, server-side.
 * People and owners resolve to the properties their owner holds.
 */
export async function resolveStackPropertyIds(input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const scope = clean(input.scope || 'properties')
  const mode = clean(input.mode || 'selection')
  const notes = []
  if (!['properties', 'master_owners', 'people'].includes(scope)) {
    throw new StackRefusal(422, 'scope_not_stackable', 'Only properties, owners and people can be added to a campaign.')
  }
  if (mode === 'cohort' && clean(input.q)) {
    throw new StackRefusal(422, 'search_is_not_a_cohort', 'A search is a ranked lookup, not a cohort. Clear the search and use filters, or select the rows you want.')
  }
  const filters = parseBrowseFilters(input)
  const tab = scope
  const { resolved: fieldFilters } = resolveEntityGraphFieldFiltersOrThrow(tab, input)

  if (mode === 'selection') {
    const ids = uniq(input.ids)
    if (!ids.length) throw new StackRefusal(422, 'nothing_selected', 'Select at least one row.')
    if (scope === 'properties') return { propertyIds: ids.filter((id) => !isTestPropertyId(id)), requested: ids.length, notes }
    if (scope === 'master_owners') return { propertyIds: await propertiesForOwners(supabase, ids), requested: ids.length, notes }
    const people = []
    for (let i = 0; i < ids.length; i += CHUNK) {
      people.push(...await readOrThrow(supabase.from('prospects').select('prospect_id, master_owner_id').in('prospect_id', ids.slice(i, i + CHUNK))))
    }
    const unlinked = ids.length - people.filter((p) => clean(p.master_owner_id)).length
    if (unlinked > 0) notes.push(`${unlinked.toLocaleString('en-US')} selected ${unlinked === 1 ? 'person has' : 'people have'} no linked owner, so no property to target.`)
    notes.push('People are targeted through the properties their owner holds; the campaign graph chooses the contact person per property.')
    return { propertyIds: await propertiesForOwners(supabase, people.map((p) => p.master_owner_id)), requested: ids.length, notes }
  }

  if (mode !== 'cohort') throw new StackRefusal(422, 'unknown_mode', 'mode must be selection or cohort.')
  // Only the legacy params this scope's browse query actually APPLIES count as
  // narrowing (e.g. score_min is parsed but applies to no property query) —
  // otherwise a filter that narrows nothing would read as a cohort.
  const NARROWING = { properties: ['market', 'city', 'state', 'zip', 'assetType', 'unitsMin', 'unitsMax', 'county'], master_owners: ['ownerType', 'priorityTier', 'market', 'coverageMin'], people: ['language', 'reachable'] }
  if (!fieldFilters.length && !NARROWING[scope].some((k) => filters[k] !== '' && filters[k] !== null && filters[k] !== false && filters[k] !== undefined)) {
    throw new StackRefusal(422, 'cohort_has_no_filters', 'No filters are active, so this would add the entire universe. Narrow the cohort first.')
  }
  if (scope === 'properties') {
    const rows = await keysetIds({
      build: () => applyEntityGraphFieldFilters(applyPropertyFilters(supabase.from('v_entity_graph_properties').select('property_id'), filters), fieldFilters),
      key: 'property_id',
      max: STACK_MAX_PROPERTIES,
      noun: 'properties',
    })
    const ids = rows.map((r) => r.id)
    return { propertyIds: ids, requested: ids.length, notes }
  }
  if (scope === 'master_owners') {
    const owners = await keysetIds({
      build: () => applyEntityGraphFieldFilters(applyOwnerFilters(supabase.from('master_owners').select('master_owner_id'), filters), fieldFilters),
      key: 'master_owner_id',
      max: STACK_MAX_PROPERTIES,
      noun: 'owners',
    })
    return { propertyIds: await propertiesForOwners(supabase, owners.map((o) => o.id)), requested: owners.length, notes }
  }
  const people = await keysetIds({
    build: () => applyEntityGraphFieldFilters(applyProspectFilters(supabase.from('prospects').select('prospect_id, master_owner_id'), filters), fieldFilters),
    key: 'prospect_id',
    max: STACK_MAX_PROPERTIES,
    noun: 'people',
  })
  notes.push('People are targeted through the properties their owner holds; the campaign graph chooses the contact person per property.')
  const unlinked = people.filter((p) => !clean(p.row.master_owner_id)).length
  if (unlinked) notes.push(`${unlinked.toLocaleString('en-US')} of these people have no linked owner, so no property to target.`)
  return { propertyIds: await propertiesForOwners(supabase, people.map((p) => p.row.master_owner_id)), requested: people.length, notes }
}

const GRAPH_SELECT = [
  'property_id', 'queue_eligible', 'queue_block_reason', 'seller_person_key', 'prospect_id', 'canonical_prospect_id',
  'canonical_e164', 'phone_id', 'timezone', 'identity_alignment',
].join(',')

/**
 * Per-property classification against the campaign target graph, through the
 * builder's readiness rule. Phone numbers are read for the linkage rule and
 * never leave this function.
 */
export async function classifyStackProperties(propertyIds = [], deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const ids = uniq(propertyIds)
  const byProperty = new Map()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await readOrThrow(supabase.from('campaign_target_graph').select(GRAPH_SELECT).in('property_id', ids.slice(i, i + CHUNK)))
    for (const row of rows) {
      const id = clean(row.property_id)
      if (!byProperty.has(id)) byProperty.set(id, [])
      byProperty.get(id).push(row)
    }
  }
  const fetchReview = deps.fetchEntityContactReviewBlocks
    || (await import('@/lib/domain/campaigns/campaign-recipient-metrics.js')).fetchEntityContactReviewBlocks
  const queueEligibleIds = ids.filter((id) => (byProperty.get(id) || []).some((row) => row.queue_eligible))
  const review = await fetchReview(queueEligibleIds, { supabase })
  if (review?.ok === false) {
    throw new StackRefusal(503, 'eligibility_unavailable', 'Entity-contact review flags could not be read, so eligibility cannot be stated. Nothing was added.')
  }
  const blocked = review?.blocked || new Set()
  const ready = []
  const held = []
  const heldByReason = {}
  const ineligible = []
  const ineligibleByReason = {}
  const bump = (map, key) => { map[key] = (map[key] || 0) + 1 }
  for (const id of ids) {
    const rows = byProperty.get(id) || []
    const verdict = propertySmsEligibility(rows, blocked.has(id))
    if (verdict.eligible) ready.push(id)
    else if (rows.some((row) => row.queue_eligible)) { held.push(id); bump(heldByReason, verdict.reason) }
    else { ineligible.push(id); bump(ineligibleByReason, verdict.reason) }
  }
  return { ready, held, heldByReason, ineligible, ineligibleByReason }
}

function pinnedClause(ids) {
  return { field_key: 'properties.property_id', operator: 'is_any_of', value: ids }
}

/**
 * Add a cohort / selection to a draft campaign (new or existing).
 * deps: { supabase, campaigns: { getCampaign, createCampaign, casUpdate, afterStackWrite, explicitSelectedPropertyIds, resolveCampaignTargetMode, normalizeCampaignStatus } }
 */
export async function stackEntityGraphCohort(input = {}, deps = {}) {
  const campaignsApi = deps.campaigns || await loadCampaignsApi()
  const dryRun = input.dry_run === true || clean(input.dry_run) === '1' || clean(input.dry_run) === 'true'
  const campaignId = clean(input.campaign_id)
  const newName = clean(input.new_campaign_name)
  if (!campaignId && !newName && !dryRun) {
    throw new StackRefusal(422, 'destination_required', 'Choose a draft campaign or name a new one.')
  }

  // The destination first: refusing a non-draft costs no cohort read.
  let campaign = null
  if (campaignId) {
    const detail = await campaignsApi.getCampaign(campaignId, deps)
    campaign = detail?.campaign || null
    if (!campaign) throw new StackRefusal(404, 'campaign_not_found', 'That campaign no longer exists.')
    if (campaignsApi.normalizeCampaignStatus(campaign.status) !== 'draft') {
      throw new StackRefusal(409, 'campaign_not_draft', `“${campaign.name || 'This campaign'}” is ${clean(campaign.status) || 'not a draft'}. Entity Graph only adds to drafts — targets on a built, scheduled or live campaign change only through Campaigns.`)
    }
    const mode = campaignsApi.resolveCampaignTargetMode(campaign.metadata)
    if (!['none', 'explicit'].includes(mode.target_mode)) {
      throw new StackRefusal(409, 'campaign_has_dynamic_filters', `“${campaign.name || 'This campaign'}” targets by filters. Pinning properties beside them would intersect the two, not add — choose a draft built from Entity Graph, or a new one.`)
    }
  }

  const resolved = await resolveStackPropertyIds(input, deps)
  const existing = campaign ? [...campaignsApi.explicitSelectedPropertyIds(campaign)] : []
  const existingSet = new Set(existing)
  const fresh = resolved.propertyIds.filter((id) => !existingSet.has(id))
  const alreadyPresent = resolved.propertyIds.length - fresh.length
  const classified = await classifyStackProperties(fresh, deps)
  const pinned = [...classified.ready, ...classified.held]
  const totalAfter = existing.length + pinned.length
  if (totalAfter > STACK_MAX_PROPERTIES) {
    throw new StackRefusal(422, 'campaign_stack_too_large', `This would pin ${totalAfter.toLocaleString('en-US')} properties on one campaign; the limit is ${STACK_MAX_PROPERTIES.toLocaleString('en-US')}. Add this cohort to a new draft instead.`, { limit: STACK_MAX_PROPERTIES })
  }

  const segment = {
    at: new Date().toISOString(),
    scope: clean(input.scope || 'properties'),
    mode: clean(input.mode || 'selection'),
    field_filters: Array.isArray(input.field_filters) ? input.field_filters : safeJson(input.field_filters),
    label: clean(input.label) || null,
    requested: resolved.requested,
    resolved_properties: resolved.propertyIds.length,
    already_present: alreadyPresent,
    added_ready: classified.ready.length,
    added_held: classified.held.length,
    held_by_reason: classified.heldByReason,
    ineligible: classified.ineligible.length,
    ineligible_by_reason: classified.ineligibleByReason,
    actor: clean(input.actor) || null,
  }
  const summary = {
    ok: true,
    dry_run: dryRun,
    campaign_id: campaign?.id || null,
    campaign_name: campaign?.name || newName || null,
    ...segment,
    added: pinned.length,
    total_after: totalAfter,
    notes: resolved.notes,
    no_targets_built: true,
    no_send_queue_rows_created: true,
  }
  if (dryRun) return summary
  if (!pinned.length && !campaign) {
    throw new StackRefusal(422, 'nothing_eligible', 'None of these properties can be targeted, so no draft was created.', { summary })
  }
  if (!pinned.length) return { ...summary, unchanged: true }

  const union = [...existing, ...pinned]
  if (!campaign) {
    const created = await campaignsApi.createCampaign({
      name: newName,
      status: 'draft',
      auto_send_enabled: false,
      auto_reply_mode: 'disabled',
      target_filters: { properties: [pinnedClause(union)] },
      metadata: { source: 'entity_graph', handoff_mode: 'stacked_explicit', entity_graph_stack: [segment] },
    }, deps)
    if (!created?.ok) throw new StackRefusal(Number(created?.status) || 500, created?.error || 'campaign_create_failed', created?.message || 'The draft could not be created.')
    return { ...summary, campaign_id: created.campaign_id, campaign_name: created.campaign?.name || newName, created: true }
  }

  /**
   * COMPARE-AND-SET ON updated_at (trg_campaigns_updated_at bumps it on every
   * write). The pin list is rewritten only if the row is still the one this
   * run read; when another add landed in between, the row is re-read, the
   * union recomputed (ids that other add pinned become "already present"),
   * and the write retried. Two concurrent adds therefore both land — no lost
   * update — and the draft must still be a draft at the moment of writing.
   */
  const pinnedSet = new Set(pinned)
  let row = campaign
  for (let attempt = 0; attempt < STACK_WRITE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      row = (await campaignsApi.getCampaign(campaign.id, deps))?.campaign
      if (!row) throw new StackRefusal(404, 'campaign_not_found', 'That campaign no longer exists.')
      if (campaignsApi.normalizeCampaignStatus(row.status) !== 'draft') {
        throw new StackRefusal(409, 'campaign_not_draft', `“${row.name || 'This campaign'}” stopped being a draft while this was counted. Nothing was added.`)
      }
      if (!['none', 'explicit'].includes(campaignsApi.resolveCampaignTargetMode(row.metadata).target_mode)) {
        throw new StackRefusal(409, 'campaign_has_dynamic_filters', `“${row.name || 'This campaign'}” now targets by filters. Nothing was added.`)
      }
    }
    const current = [...campaignsApi.explicitSelectedPropertyIds(row)]
    const currentSet = new Set(current)
    const toAdd = [...pinnedSet].filter((id) => !currentSet.has(id))
    const unionNow = [...current, ...toAdd]
    if (unionNow.length > STACK_MAX_PROPERTIES) {
      throw new StackRefusal(422, 'campaign_stack_too_large', `This would pin ${unionNow.length.toLocaleString('en-US')} properties on one campaign; the limit is ${STACK_MAX_PROPERTIES.toLocaleString('en-US')}. Add this cohort to a new draft instead.`, { limit: STACK_MAX_PROPERTIES })
    }
    const raced = pinned.length - toAdd.length
    const landed = {
      ...summary,
      already_present: alreadyPresent + raced,
      added: toAdd.length,
      added_ready: classified.ready.filter((id) => !currentSet.has(id)).length,
      added_held: classified.held.filter((id) => !currentSet.has(id)).length,
      total_after: unionNow.length,
    }
    if (!toAdd.length) return { ...landed, unchanged: true }
    const previous = Array.isArray(row.metadata?.entity_graph_stack) ? row.metadata.entity_graph_stack : []
    const filtersKeep = Object.fromEntries(Object.entries(row.metadata?.target_filters || {}).filter(([, v]) => !Array.isArray(v)))
    const targetFilters = { ...filtersKeep, properties: [pinnedClause(unionNow)] }
    const metadata = {
      ...(row.metadata || {}),
      target_filters: targetFilters,
      entity_graph_stack: [...previous, { ...segment, already_present: landed.already_present, added_ready: landed.added_ready, added_held: landed.added_held }].slice(-STACK_MAX_SEGMENTS),
    }
    const written = await campaignsApi.casUpdate(row.id, row.updated_at, { metadata, market: null, state: null }, deps)
    if (written) {
      await campaignsApi.afterStackWrite(row.id, targetFilters, landed, deps)
      return landed
    }
  }
  throw new StackRefusal(409, 'campaign_changed', 'The campaign kept changing while this was being added. Run it again.')
}

function safeJson(value) {
  if (!value) return []
  try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
}

/** The campaign row only — getCampaign also computes launch readiness, which this never needs. */
async function readCampaignRow(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { data, error } = await supabase.from('campaigns').select('id, name, status, metadata, updated_at').eq('id', campaignId).maybeSingle()
  if (error) throw error
  return { campaign: data || null }
}

/** Drafts this can stack into: draft status and no dynamic filters. */
export async function listStackableDrafts(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const api = deps.campaigns || await loadCampaignsApi()
  const { data, error } = await supabase.from('campaigns').select('id, name, status, metadata, updated_at').eq('status', 'draft').order('updated_at', { ascending: false }).limit(100)
  if (error) throw error
  return (data || []).map((c) => {
    const mode = api.resolveCampaignTargetMode(c.metadata)
    const stackable = ['none', 'explicit'].includes(mode.target_mode)
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      updated_at: c.updated_at,
      pinned_properties: api.explicitSelectedPropertyIds(c).size,
      segments: Array.isArray(c.metadata?.entity_graph_stack) ? c.metadata.entity_graph_stack.length : 0,
      from_entity_graph: c.metadata?.source === 'entity_graph',
      stackable,
      reason: stackable ? null : 'campaign_has_dynamic_filters',
    }
  })
}

async function loadCampaignsApi() {
  const service = await import('@/lib/domain/campaigns/campaign-automation-service.js')
  const machine = await import('@/lib/domain/campaigns/campaign-state-machine.js')
  return {
    getCampaign: readCampaignRow,
    casUpdate: async (id, expectedUpdatedAt, patch, d = {}) => {
      const supabase = d.supabase || defaultSupabase
      let q = supabase.from('campaigns').update(patch).eq('id', id).eq('status', 'draft')
      q = expectedUpdatedAt ? q.eq('updated_at', expectedUpdatedAt) : q.is('updated_at', null)
      const { data, error } = await q.select('id')
      if (error) throw error
      return Array.isArray(data) && data.length === 1
    },
    afterStackWrite: async (id, targetFilters, landed, d = {}) => {
      await service.replaceCampaignFilters(id, targetFilters, d)
      await service.recordCampaignEvent({
        campaign_id: id,
        event_type: 'campaign.entity_graph_stacked',
        severity: 'info',
        title: 'Entity Graph cohort added',
        description: `${landed.added} properties pinned (${landed.already_present} already present, ${landed.ineligible} not targetable). No targets built, nothing sent.`,
        metadata: { added: landed.added, added_ready: landed.added_ready, added_held: landed.added_held, already_present: landed.already_present, ineligible_by_reason: landed.ineligible_by_reason, total_after: landed.total_after },
      }, d)
    },
    createCampaign: service.createCampaign,
    updateCampaign: service.updateCampaign,
    explicitSelectedPropertyIds: service.explicitSelectedPropertyIds,
    resolveCampaignTargetMode: service.resolveCampaignTargetMode,
    normalizeCampaignStatus: machine.normalizeCampaignStatus,
  }
}
