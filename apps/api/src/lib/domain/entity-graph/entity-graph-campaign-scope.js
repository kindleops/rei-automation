/**
 * ENTITY GRAPH · CAMPAIGN SCOPE (owner, 2026-10-10: "from a campaign, pull up
 * that exact list of campaign targets in the entity graph and see every
 * column — signals, last contact, everything").
 *
 * One chip in the SAME filter AST the rail, the Overview and the grid read:
 *
 *   { field_key: 'campaign.membership', operator: 'is_any_of', value: ['<campaign uuid>'] }
 *
 * It is executed server-side and EXACTLY:
 *
 *   built campaign   the distinct property_id (owner / person on those tabs) of
 *                    every campaign_targets row ∪ every send_queue row carrying
 *                    the campaign id (whatever was queued or sent stays in the
 *                    scope even if its target row was rebuilt away)
 *   draft            its pinned id list (target_filters.properties[
 *                    properties.property_id is_any_of …]) — the Entity Graph
 *                    "Add to campaign" shape
 *   draft (filters)  its saved property-domain target_filters, resolved by the
 *                    same catalog compiler; a clause the property tab cannot
 *                    execute fails closed (422) — never a wider cohort
 *
 * The chip's appliers are synchronous (the browse / Overview / facts paths all
 * run them against a PostgREST builder or the SQL recorder), so the membership
 * is PRIMED once per request (primeCampaignScope, async, direct Postgres,
 * keyed reads on idx_campaign_targets_campaign_id / idx_send_queue_campaign_id)
 * and read from a short cache by the applier. An unprimed chip throws — it is
 * never applied as "no narrowing".
 *
 * An empty campaign is an empty cohort (`= any('{}')`), not the universe.
 */
import { hasDatabaseUrl, queryWithTimeout } from '@/lib/postgres/client.js'

export const CAMPAIGN_MEMBERSHIP_KEY = 'campaign.membership'

/** The id column the membership narrows on, per Entity Graph tab. */
export const CAMPAIGN_SCOPE_ID_COLUMN = Object.freeze({
  properties: 'property_id',
  master_owners: 'master_owner_id',
  // campaign_targets.prospect_id / send_queue.prospect_id carry the person's individual_key (measured
  // 2026-10-10: 0 of 2,605 match prospects.prospect_id, 2,382 match prospects.individual_key)
  people: 'individual_key',
})

export const CAMPAIGN_MEMBERSHIP_FIELD = Object.freeze({
  key: CAMPAIGN_MEMBERSHIP_KEY,
  domain: 'campaign',
  category: 'Campaign',
  label: 'Campaign',
  source_table_or_view: '*',
  source_column: 'property_id',
  type: 'campaign',
  operators: Object.freeze([{ key: 'is_any_of', label: 'In campaign' }]),
  derived: 'campaign_membership',
  filterable: true,
  searchable: false,
  supports_options: false,
  supports_counts: true,
  supported_in_preview: false,
  entity_graph_only: true,
  scope_filter: true,
  description: 'The campaign’s exact target set: every campaign_targets row plus whatever was queued or sent for it (a draft: its pinned ids or saved property filters).',
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TTL_MS = 60_000
const CACHE_MAX = 24
const TIMEOUT_MS = 8_000
const clean = (v) => String(v ?? '').trim()

export const isCampaignId = (v) => UUID.test(clean(v))
export const isCampaignMembership = (entry) => clean(entry?.field_key) === CAMPAIGN_MEMBERSHIP_KEY

const cache = new Map()
export const __campaignScopeTest = {
  reset() { cache.clear() },
  /** seed a resolved scope (tests): { properties: [...], master_owners: [...], people: [...] } */
  seed(id, scope) { cache.set(clean(id).toLowerCase(), { at: Date.now(), scope, pinned: true }) },
}

export class CampaignScopeError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'CampaignScopeError'
    this.code = code
    this.status = 422
    Object.assign(this, extra)
  }
}

/** The campaign ids a filter list names in its membership chip(s). */
export function campaignIdsInFilters(filters = []) {
  const out = []
  for (const f of filters || []) {
    if (!isCampaignMembership(f)) continue
    const values = Array.isArray(f.value) ? f.value : [f.value]
    for (const v of values) if (isCampaignId(v) && !out.includes(clean(v).toLowerCase())) out.push(clean(v).toLowerCase())
  }
  return out
}

function parseFilters(params = {}) {
  const raw = params.field_filters ?? params.fieldFilters ?? params.filters_json
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(String(raw))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Campaign ids named by a browse / Overview request's field_filters. */
export const campaignIdsInParams = (params = {}) => campaignIdsInFilters(parseFilters(params))

const EXPLICIT_PROPERTY_FIELD = 'properties.property_id'

/** A draft's pinned ids + its other (property-domain) clauses, from metadata.target_filters. */
export function draftDefinition(metadata = {}) {
  const tf = metadata && typeof metadata === 'object' && metadata.target_filters && typeof metadata.target_filters === 'object' ? metadata.target_filters : {}
  const explicit = []
  const clauses = []
  const foreign = []
  for (const [domain, list] of Object.entries(tf)) {
    if (!Array.isArray(list)) continue
    for (const clause of list) {
      if (!clause || typeof clause !== 'object') continue
      if (clean(clause.field_key) === EXPLICIT_PROPERTY_FIELD && ['is_any_of', 'in'].includes(clean(clause.operator))) {
        for (const v of Array.isArray(clause.value) ? clause.value : [clause.value]) { const id = clean(v); if (id && !explicit.includes(id)) explicit.push(id) }
        continue
      }
      if (clean(clause.field_key).startsWith('properties.') || domain === 'properties') clauses.push({ field_key: clean(clause.field_key), operator: clean(clause.operator), value: clause.value })
      else foreign.push({ domain, field_key: clean(clause.field_key) })
    }
  }
  return { explicit, clauses, foreign }
}

/**
 * Resolve one campaign's scope (exact). Direct Postgres, keyed reads only.
 * @returns {{ id, name, status, mode, targets, ids: { properties, master_owners, people }, definition?, queue }}
 */
export async function resolveCampaignScope(campaignId, deps = {}) {
  const query = deps.query || queryWithTimeout
  const id = clean(campaignId).toLowerCase()
  if (!isCampaignId(id)) throw new CampaignScopeError('campaign_scope_invalid_id', 'The campaign id is not a campaign id.')
  const { rows: [campaign] = [] } = await query(
    `select id::text as id, name, status, metadata, built_at from public.campaigns where id = $1::uuid`,
    [id], TIMEOUT_MS,
  )
  if (!campaign) throw new CampaignScopeError('campaign_scope_not_found', 'That campaign does not exist.', { campaign_id: id })
  const { rows: members = [] } = await query(
    `select 'target' as src, property_id, primary_property_id, master_owner_id, prospect_id, target_status as status from public.campaign_targets where campaign_id = $1::uuid
     union all
     select 'queue' as src, property_id, null as primary_property_id, master_owner_id, prospect_id, queue_status as status from public.send_queue where campaign_id = $1::uuid`,
    [id], TIMEOUT_MS,
  )
  const sets = { properties: new Set(), master_owners: new Set(), people: new Set() }
  let targets = 0
  let queueRows = 0
  for (const m of members) {
    if (m.src === 'target') targets += 1
    else queueRows += 1
    for (const p of [m.property_id, m.primary_property_id]) if (clean(p)) sets.properties.add(clean(p))
    if (clean(m.master_owner_id)) sets.master_owners.add(clean(m.master_owner_id))
    if (clean(m.prospect_id)) sets.people.add(clean(m.prospect_id))
  }
  const base = { id: campaign.id, name: clean(campaign.name) || 'Untitled campaign', status: clean(campaign.status) || null, targets, queueRows }
  if (members.length) {
    // the owners of the scope: the target's own owner id, else the owner of its property (properties.master_owner_id)
    // or of its person (prospects by individual_key) — the same links Entity Graph resolves owners by
    const [byProperty, byPerson] = await Promise.all([
      sets.properties.size ? query(`select distinct master_owner_id from public.properties where property_id = any($1::text[]) and master_owner_id is not null`, [[...sets.properties]], TIMEOUT_MS) : { rows: [] },
      sets.people.size ? query(`select distinct master_owner_id from public.prospects where individual_key = any($1::text[]) and master_owner_id is not null`, [[...sets.people]], TIMEOUT_MS) : { rows: [] },
    ])
    for (const r of [...(byProperty?.rows || []), ...(byPerson?.rows || [])]) if (clean(r.master_owner_id)) sets.master_owners.add(clean(r.master_owner_id))
    return { ...base, mode: 'built', ids: { properties: [...sets.properties], master_owners: [...sets.master_owners], people: [...sets.people] } }
  }
  const def = draftDefinition(campaign.metadata)
  if (def.explicit.length) {
    // the owners of the pinned properties (people: only once the campaign is built — a draft pins properties)
    const { rows: owners = [] } = await query(
      `select distinct master_owner_id from public.properties where property_id = any($1::text[]) and master_owner_id is not null`,
      [def.explicit], TIMEOUT_MS,
    )
    return { ...base, mode: 'explicit', ids: { properties: def.explicit, master_owners: owners.map((o) => clean(o.master_owner_id)).filter(Boolean), people: null } }
  }
  if (def.clauses.length || def.foreign.length) {
    return { ...base, mode: 'definition', ids: { properties: null, master_owners: null, people: null }, definition: def }
  }
  return { ...base, mode: 'empty', ids: { properties: [], master_owners: [], people: [] } }
}

/**
 * Resolve every campaign a request's filters name (cached 60 s). Call before
 * the browse / Overview appliers run. A no-op without a membership chip.
 */
export async function primeCampaignScope(params = {}, deps = {}) {
  const ids = campaignIdsInParams(params)
  if (!ids.length) return []
  const now = Date.now()
  const out = []
  for (const id of ids) {
    const hit = cache.get(id)
    if (hit && (now - hit.at < TTL_MS || hit.pinned) && !deps.force) { out.push(hit.scope); continue }
    if (!deps.query && !hasDatabaseUrl()) throw new CampaignScopeError('campaign_scope_needs_database', 'The campaign scope needs the direct database connection.')
    const scope = await resolveCampaignScope(id, deps)
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
    cache.set(id, { at: now, scope })
    out.push(scope)
  }
  return out
}

/** The primed scope of a campaign id, or null. */
export function primedCampaignScope(campaignId) {
  return cache.get(clean(campaignId).toLowerCase())?.scope ?? null
}

/**
 * The membership applier (entity-graph-field-filters.js → derived
 * 'campaign_membership'). Several campaign ids = their union. `resolveDefinition`
 * compiles a draft's saved property filters (injected to avoid a cycle).
 */
export function applyCampaignMembership(query, entry, { tab = 'properties', applyDefinition = null } = {}) {
  const column = CAMPAIGN_SCOPE_ID_COLUMN[tab]
  if (!column) throw new CampaignScopeError('campaign_scope_not_on_tab', `A campaign scope cannot narrow the ${tab} tab.`)
  const ids = (Array.isArray(entry.value) ? entry.value : [entry.value]).map((v) => clean(v).toLowerCase()).filter(isCampaignId)
  if (!ids.length) throw new CampaignScopeError('campaign_scope_invalid_id', 'The campaign chip carries no campaign id.')
  const union = new Set()
  const definitions = []
  for (const id of ids) {
    const scope = primedCampaignScope(id)
    if (!scope) throw new CampaignScopeError('campaign_scope_not_primed', 'The campaign scope was not resolved before the query ran — refusing to treat it as no filter.', { campaign_id: id })
    const list = scope.ids?.[tab]
    if (Array.isArray(list)) { for (const v of list) union.add(v); continue }
    if (scope.mode === 'definition' && tab === 'properties') { definitions.push(scope); continue }
    throw new CampaignScopeError('campaign_scope_unavailable_on_tab', tab === 'people'
      ? 'A draft campaign pins properties, not people — build it (or open its properties) to see its people.'
      : `This draft campaign is defined by filters; its ${tab === 'master_owners' ? 'owners' : 'records'} exist once it is built — open its properties instead.`, { campaign_id: id })
  }
  if (definitions.length) {
    if (definitions.length > 1 || union.size) throw new CampaignScopeError('campaign_scope_mixed_definitions', 'Only one filter-defined draft can be scoped at a time.')
    if (!applyDefinition) throw new CampaignScopeError('campaign_scope_definition_unsupported', 'This path cannot apply a campaign’s saved filters.')
    return applyDefinition(query, definitions[0].definition)
  }
  // an empty campaign is an empty cohort — never the universe
  return query.in(column, union.size ? [...union] : ['__no_campaign_members__'])
}

/** GET …/campaign-scope?campaign_id= — the chip's label and the scope's exact counts. */
export async function getCampaignScopeSummary(campaignId, deps = {}) {
  const query = deps.query || queryWithTimeout
  const [scope] = await primeCampaignScope({ field_filters: JSON.stringify([{ field_key: CAMPAIGN_MEMBERSHIP_KEY, operator: 'is_any_of', value: [campaignId] }]) }, { ...deps, force: deps.force })
  const { rows: [q] = [] } = await query(
    `select count(*)::int as queue_rows,
            count(*) filter (where sent_at is not null)::int as sent,
            count(*) filter (where delivered_at is not null)::int as delivered,
            count(*) filter (where lower(coalesce(queue_status, '')) in ('failed', 'failed_transport', 'blocked', 'cancelled'))::int as failed,
            count(*) filter (where sent_at is null and lower(coalesce(queue_status, '')) in ('queued', 'scheduled', 'pending', 'ready', 'held', 'retry'))::int as waiting
       from public.send_queue where campaign_id = $1::uuid`,
    [scope.id], TIMEOUT_MS,
  )
  // the people / owners the Entity Graph tabs will show: rows that exist for the scope's keys (keyed counts)
  const [peopleRows, ownerRows] = await Promise.all([
    Array.isArray(scope.ids.people) && scope.ids.people.length ? query(`select count(*)::int as n from public.prospects where individual_key = any($1::text[])`, [scope.ids.people], TIMEOUT_MS) : null,
    Array.isArray(scope.ids.master_owners) && scope.ids.master_owners.length ? query(`select count(*)::int as n from public.master_owners where master_owner_id = any($1::text[])`, [scope.ids.master_owners], TIMEOUT_MS) : null,
  ])
  return {
    id: scope.id,
    name: scope.name,
    status: scope.status,
    mode: scope.mode,
    targets: scope.targets,
    properties: Array.isArray(scope.ids.properties) ? scope.ids.properties.length : null,
    owners: Array.isArray(scope.ids.master_owners) ? (ownerRows ? ownerRows.rows?.[0]?.n ?? null : 0) : null,
    people: Array.isArray(scope.ids.people) ? (peopleRows ? peopleRows.rows?.[0]?.n ?? null : 0) : null,
    personKeys: Array.isArray(scope.ids.people) ? scope.ids.people.length : null,
    queue: { rows: q?.queue_rows ?? 0, sent: q?.sent ?? 0, delivered: q?.delivered ?? 0, failed: q?.failed ?? 0, waiting: q?.waiting ?? 0 },
    definition: scope.mode === 'definition' ? { clauses: scope.definition.clauses.length, foreign: scope.definition.foreign } : null,
    basis: scope.mode === 'built'
      ? 'Every campaign_targets row plus every send_queue row of this campaign (distinct properties).'
      : scope.mode === 'explicit' ? 'The draft’s pinned property list.' : scope.mode === 'definition' ? 'The draft’s saved property filters (exact once built).' : 'This campaign has no targets yet.',
  }
}

/**
 * CAMPAIGN OUTCOME COLUMNS for a page of properties (keyed reads):
 *   camp.template      sms_templates name / use case of the latest send
 *   camp.sent_at       latest send of this campaign to the property
 *   camp.delivery      delivered / failed (+ reason) / queued / scheduled
 *   camp.target_status the target row's status (+ block reason)
 *   camp.touch         touch number of the latest send
 *   camp.reply_intent  the classifier's intent on the first inbound AFTER the send
 *   camp.replied_at    when that reply arrived
 *   camp.opted_out     an opt-out inbound after the send (permission state)
 * Phones and message bodies never leave here.
 */
export const CAMPAIGN_OUTCOME_FIELDS = Object.freeze(['template', 'sent_at', 'delivery', 'target_status', 'touch', 'reply_intent', 'replied_at', 'opted_out'])

export async function campaignOutcomes(campaignId, propertyIds = [], deps = {}) {
  const query = deps.query || queryWithTimeout
  const id = clean(campaignId).toLowerCase()
  const ids = [...new Set(propertyIds.map(clean).filter(Boolean))].slice(0, 300)
  if (!isCampaignId(id) || !ids.length) return new Map()
  const [sq, ct] = await Promise.all([
    query(
      `select distinct on (property_id) property_id, template_id, template_key, use_case_template, queue_status, sent_at, delivered_at,
              failed_reason, touch_number, scheduled_for_utc, created_at
         from public.send_queue where campaign_id = $1::uuid and property_id = any($2::text[])
        order by property_id, coalesce(sent_at, scheduled_for_utc, created_at) desc nulls last, id`,
      [id, ids], TIMEOUT_MS,
    ),
    query(
      `select distinct on (property_id) property_id, target_status, block_reason, touch_number
         from public.campaign_targets where campaign_id = $1::uuid and property_id = any($2::text[])
        order by property_id, updated_at desc nulls last, id`,
      [id, ids], TIMEOUT_MS,
    ),
  ])
  const sends = new Map((sq?.rows || []).map((r) => [clean(r.property_id), r]))
  const firstSent = new Map()
  for (const [pid, r] of sends) if (r.sent_at) firstSent.set(pid, r.sent_at)
  const templateIds = [...new Set([...sends.values()].map((r) => clean(r.template_id)).filter((t) => UUID.test(t)))]
  const sentIds = [...firstSent.keys()]
  const [tpl, inbound] = await Promise.all([
    templateIds.length
      ? query(`select id::text as id, coalesce(nullif(template_name, ''), use_case) as name, use_case from public.sms_templates where id = any($1::uuid[])`, [templateIds], TIMEOUT_MS)
      : Promise.resolve({ rows: [] }),
    sentIds.length
      ? query(
        `select property_id, detected_intent, is_opt_out, coalesce(event_timestamp, received_at, created_at) as at
           from public.message_events where property_id = any($1::text[]) and direction ilike 'in%'
          order by property_id, coalesce(event_timestamp, received_at, created_at) asc`,
        [sentIds], TIMEOUT_MS,
      )
      : Promise.resolve({ rows: [] }),
  ])
  const tplName = new Map((tpl?.rows || []).map((r) => [clean(r.id), clean(r.name) || clean(r.use_case) || null]))
  const reply = new Map()
  const optOut = new Set()
  for (const r of inbound?.rows || []) {
    const pid = clean(r.property_id)
    const since = firstSent.get(pid)
    if (!since || new Date(r.at) < new Date(since)) continue
    if (r.is_opt_out) optOut.add(pid)
    if (!reply.has(pid)) reply.set(pid, { intent: clean(r.detected_intent) || 'unclassified', at: r.at })
  }
  const targets = new Map((ct?.rows || []).map((r) => [clean(r.property_id), r]))
  const out = new Map()
  for (const pid of ids) {
    const s = sends.get(pid)
    const t = targets.get(pid)
    if (!s && !t) continue
    const status = clean(s?.queue_status).toLowerCase()
    const delivery = !s ? null
      : s.delivered_at ? 'Delivered'
        : /fail|blocked|cancel/.test(status) ? `Failed${clean(s.failed_reason) ? ` · ${clean(s.failed_reason).slice(0, 60)}` : ''}`
          : s.sent_at ? 'Sent · awaiting delivery'
            : status ? status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : null
    const r = reply.get(pid)
    out.set(pid, {
      template: s ? (tplName.get(clean(s.template_id)) || clean(s.use_case_template) || clean(s.template_key) || null) : null,
      sent_at: s?.sent_at ? new Date(s.sent_at).toISOString() : null,
      delivery,
      target_status: t ? `${clean(t.target_status) || '—'}${clean(t.block_reason) ? ` · ${clean(t.block_reason).replace(/_/g, ' ')}` : ''}` : null,
      touch: s?.touch_number ?? t?.touch_number ?? null,
      reply_intent: r ? r.intent.replace(/_/g, ' ') : null,
      replied_at: r ? new Date(r.at).toISOString() : null,
      opted_out: s?.sent_at ? optOut.has(pid) : null,
    })
  }
  return out
}
