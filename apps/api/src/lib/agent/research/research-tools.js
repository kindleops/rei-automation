// Read-only research tools (owner 10-10 §3). Curated, parameterized reads with
// row caps — never SQL, never a URL, never a write. Every tool:
//   * is a small T0 read registered in a READ-ONLY registry (registry.js refuses
//     anything else at registration AND at authorization);
//   * reads through the guarded read client (quick-scan/read-client.js: GET-only
//     PostgREST on the app's own Supabase host + 3 allowlisted STABLE RPCs);
//   * projects an explicit column whitelist: no phone numbers, emails, owner /
//     seller / prospect names, mailing addresses, message text, or demographic /
//     protected-class fields (age, gender, marital status, language, income …);
//   * caps rows to the model (≤ 25) and rows read per request (≤ 200).
//
// The 9 Quick Scan T0 reads (quick-scan/tools.js) are reused unchanged, plus:
//   campaign.list · campaign.overview · campaign.targets · campaign.audience_top
//   eg.distress_signals · eg.contact_map · eg.facts
import { createToolRegistry } from '../tools/registry.js'
import { QUICK_SCAN_TOOL_SPECS, projectOwnership } from '../quick-scan/tools.js'
import { maskPhoneDigits } from './pii.js'

const NEVER = ['phone', 'email', 'e164', 'canonical_e164', 'to_phone_number', 'owner_name', 'seller_name', 'seller_full_name', 'seller_first_name', 'buyer_name', 'display_name', 'full_name', 'owner_1_name', 'owner_2_name', 'owner_address_full', 'mailing', 'preview', 'body', 'ssn', 'dob', 'age', 'age_bucket', 'gender', 'marital', 'marital_status', 'race', 'religion', 'demographic', 'income', 'language', 'education_model', 'occupation_group', 'net_asset_value', 'buying_power', 'evidence_url', 'decedent_person_keys', 'best_contact_key', 'best_phone_ref']
const UUID = { type: 'string', minLength: 36, maxLength: 36, pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }
const PROPERTY_ID = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_.:-]+$' }
const LIMIT = (max, dflt) => ({ type: 'integer', minimum: 1, maximum: max, default: dflt })

export const MAX_PINNED_IDS = 3000
export const GRAPH_CHUNK = 150

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const clean = (v) => (v == null ? null : String(v).trim() || null)

function unavailable(code, message) {
  const e = new Error(message)
  e.code = code
  e.unavailable = true
  return e
}

function readError(error, what) {
  const code = String(error?.code || '')
  if (code === 'PGRST205' || code === '42P01') return unavailable('SOURCE_NOT_APPLIED', `${what} is not available in this database`)
  if (code === '42703' || code === 'PGRST204') return unavailable('SOURCE_SCHEMA_MISMATCH', `${what}: column mismatch`)
  return unavailable('SOURCE_UNAVAILABLE', `${what} read failed`)
}

async function read(q, what) {
  const { data, error, count } = await q
  if (error) throw readError(error, what)
  return { rows: Array.isArray(data) ? data : data ? [data] : [], count: count ?? null }
}

// ── column whitelists (verified against the production catalog 2026-10-10) ──
export const CAMPAIGN_COLUMNS = 'id,name,status,objective,candidate_source,market,state,created_at,updated_at,built_at,activated_at,paused_at,completed_at,archived_at,queued_count,sent_count,delivered_count,failed_count,replied_count,positive_count,opt_out_count,daily_cap,total_cap,auto_send_enabled,metadata'
export const TARGET_COLUMNS = 'property_id,target_status,block_reason,identity_status,routing_status,suppression_status,template_status,priority_score,touch_number,market,state,updated_at'
export const GRAPH_COLUMNS = 'property_id,market,state,property_city,property_zip,property_county_name,property_type,units_count,property_address_full,priority_tier,sms_eligible,queue_eligible,queue_block_reason,never_contacted,touch_count,latest_contact_at,tax_delinquent,tax_delinquent_year,active_lien,property_flags_text,building_condition,estimated_repair_cost,estimated_value,equity_percent,equity_amount,total_loan_balance,ownership_years,is_corporate_owner,out_of_state_owner,owner_type,acquisition_score,aos_score,decision_tier,acquisition_confidence,transaction_probability_365,best_strategy,scores_computed_at,generated_at'
export const CONTACT_COLUMNS = 'property_id,seller_person_key,canonical_e164,phone_type,phone_activity_status,best_phone_score,identity_alignment,routing_tier,sms_eligible,wrong_number,true_post_contact_suppression,pending_prior_touch,active_queue_item,queue_block_reason,latest_contact_at,last_outbound_at,last_inbound_at,touch_count'
export const PROBATE_COLUMNS = 'property_id,validity_class,validity_subclass,estate_status,has_probate_filing,has_death_record,date_of_death,latest_doc_date,last_transfer_kind,last_transfer_date,listed_mls,decedent_confidence,best_contact_role,best_contact_tier,reachable_living_dm,only_deceased_reachable,exclude_targeting,opportunity_score,pressure_pts,deal_pts,contact_pts,audited_at'
export const PREFORECLOSURE_COLUMNS = 'property_id,verdict,auction_date,evidence_date,confidence,score,do_not_contact_reason,exclusion_reason,verified_at,evidence_url'
export const FACT_COLUMNS = 'property_id,tax_delinquent,tax_delinquent_year,tax_amt,tax_year,active_lien,is_hot_preforeclosure,acquisition_bucket,equity_percent,estimated_value,total_loan_balance,ownership_years,is_corporate_owner,out_of_state_owner,owner_type,building_condition,last_sale_doc_type,sale_date,sale_price,updated_at'

// vendor flags that encode personal / protected characteristics (age, marital or familial status,
// disability, national origin, language, religion, sex, military) are never sent to the model
export const PROTECTED_FLAG_RE = /(senior|elder|retire|aged?\b|\bage\b|divorc|widow|marri|single\s*(parent|mother|father)|famil|child|pregnan|disab|handicap|veteran|military|hispanic|latin|asian|black|white|ethnic|race|religio|church|language|spanish|female|\bmale\b|gender)/i
export const safeFlags = (text) => String(text || '').split(/[;,|]/).map((t) => t.trim()).filter((t) => t && !PROTECTED_FLAG_RE.test(t)).slice(0, 12)

const SORTS = Object.freeze(['aos_score', 'acquisition_score', 'transaction_probability_365', 'equity_percent'])

/** Pinned property ids of a campaign draft (EG stacked handoff), never sent to the model. */
export function pinnedPropertyIds(campaign) {
  const props = campaign?.metadata?.target_filters?.properties
  const out = []
  if (Array.isArray(props)) {
    for (const f of props) {
      if (String(f?.field_key || '') !== 'properties.property_id') continue
      if (!['is_any_of', 'in', 'equals', 'is'].includes(String(f?.operator || ''))) continue
      const vals = Array.isArray(f.value) ? f.value : [f.value]
      for (const v of vals) if (/^[A-Za-z0-9_.:-]{1,64}$/.test(String(v ?? ''))) out.push(String(v))
    }
  }
  return [...new Set(out)]
}

export function projectCampaign(c, { pinned = null } = {}) {
  const md = c.metadata || {}
  const stack = Array.isArray(md.entity_graph_stack) ? md.entity_graph_stack : []
  return {
    campaign_id: c.id,
    name: clean(c.name),
    status: clean(c.status),
    objective: clean(c.objective),
    candidate_source: clean(c.candidate_source),
    market: clean(c.market),
    state: clean(c.state),
    created_at: c.created_at || null,
    updated_at: c.updated_at || null,
    lifecycle: { built_at: c.built_at || null, activated_at: c.activated_at || null, paused_at: c.paused_at || null, completed_at: c.completed_at || null, archived_at: c.archived_at || null },
    counts: { queued: num(c.queued_count), sent: num(c.sent_count), delivered: num(c.delivered_count), failed: num(c.failed_count), replied: num(c.replied_count), positive: num(c.positive_count), opt_out: num(c.opt_out_count) },
    caps: { daily: num(c.daily_cap), total: num(c.total_cap), auto_send_enabled: c.auto_send_enabled === true },
    audience: {
      source: clean(md.source),
      handoff_mode: clean(md.handoff_mode),
      pinned_property_count: pinned ? pinned.length : null,
      entity_graph_stack_steps: stack.length,
      stack_labels: stack.slice(0, 15).map((s) => clean(s?.label)).filter(Boolean),
    },
  }
}

export function projectGraphRow(r) {
  return {
    property_id: String(r.property_id),
    address: clean(r.property_address_full),
    market: clean(r.market), state: clean(r.state), city: clean(r.property_city), zip: clean(r.property_zip), county: clean(r.property_county_name),
    property_type: clean(r.property_type), units: num(r.units_count),
    scores: { aos_score: num(r.aos_score), decision_tier: clean(r.decision_tier), acquisition_score: num(r.acquisition_score), acquisition_confidence: num(r.acquisition_confidence), transaction_probability_365: num(r.transaction_probability_365), best_strategy: clean(r.best_strategy), computed_at: r.scores_computed_at || null },
    distress: { tax_delinquent: r.tax_delinquent ?? null, tax_delinquent_year: num(r.tax_delinquent_year), active_lien: r.active_lien ?? null, flags: safeFlags(r.property_flags_text), building_condition: clean(r.building_condition), estimated_repair_cost: num(r.estimated_repair_cost) },
    equity: { estimated_value: num(r.estimated_value), equity_percent: num(r.equity_percent), equity_amount: num(r.equity_amount), total_loan_balance: num(r.total_loan_balance) },
    ownership: { ownership_years: num(r.ownership_years), is_corporate_owner: r.is_corporate_owner ?? null, out_of_state_owner: r.out_of_state_owner ?? null, owner_type: clean(r.owner_type) },
    outreach: { priority_tier: clean(r.priority_tier), sms_eligible: r.sms_eligible ?? null, queue_eligible: r.queue_eligible ?? null, queue_block_reason: clean(r.queue_block_reason), never_contacted: r.never_contacted ?? null, touch_count: num(r.touch_count), latest_contact_at: r.latest_contact_at || null },
  }
}

/** Collapse graph rows (one per property × phone) to one per property; any-of for eligibility. */
export function collapseGraphRows(rows) {
  const by = new Map()
  for (const r of rows) {
    const id = String(r.property_id)
    const cur = by.get(id)
    if (!cur) { by.set(id, { row: r, phones: 1, sms_any: r.sms_eligible === true }); continue }
    cur.phones += 1
    cur.sms_any = cur.sms_any || r.sms_eligible === true
  }
  return [...by.values()].map(({ row, phones, sms_any }) => ({ ...projectGraphRow(row), graph_rows: phones, sms_eligible_any_phone: sms_any }))
}

export function projectProbate(p) {
  if (!p) return null
  return {
    validity_class: clean(p.validity_class), validity_subclass: clean(p.validity_subclass), estate_status: clean(p.estate_status),
    has_probate_filing: p.has_probate_filing ?? null, has_death_record: p.has_death_record ?? null,
    date_of_death_year: p.date_of_death ? Number(String(p.date_of_death).slice(0, 4)) : null, // year only (minimized)
    latest_doc_date: p.latest_doc_date || null, last_transfer_kind: clean(p.last_transfer_kind), last_transfer_date: p.last_transfer_date || null,
    listed_mls: p.listed_mls ?? null, decedent_confidence: clean(p.decedent_confidence),
    best_contact_role: clean(p.best_contact_role), best_contact_tier: clean(p.best_contact_tier),
    reachable_living_decision_maker: p.reachable_living_dm ?? null, only_deceased_reachable: p.only_deceased_reachable ?? null,
    exclude_targeting: p.exclude_targeting ?? null,
    scores: { opportunity: num(p.opportunity_score), pressure: num(p.pressure_pts), deal: num(p.deal_pts), contact: num(p.contact_pts) },
    audited_at: p.audited_at || null,
  }
}

export function projectPreforeclosure(f) {
  if (!f) return null
  let host = null
  try { host = f.evidence_url ? new URL(String(f.evidence_url)).hostname : null } catch { host = null }
  return { verdict: clean(f.verdict), auction_date: f.auction_date || null, evidence_date: f.evidence_date || null, evidence_host: host, confidence: clean(f.confidence), score: num(f.score), do_not_contact_reason: clean(f.do_not_contact_reason), exclusion_reason: clean(f.exclusion_reason), verified_at: f.verified_at || null }
}

const differs = (vals) => {
  const known = vals.filter((v) => v.value !== null && v.value !== undefined)
  return known.length >= 2 && new Set(known.map((v) => String(v.value))).size > 1
}

/**
 * Deterministic cross-source checks (no model). Each item names its sources and
 * values; "conflict" = sources disagree, "check" = a combination worth review.
 */
export function findInconsistencies({ graph = null, parcel = null, liens = null, foreclosures = null, sales = null, probate = null, preforeclosure = null, facts = null, ownerKind = null, today = new Date() } = {}) {
  const out = []
  const tax = [
    { source: 'campaign_target_graph', value: graph?.tax_delinquent ?? null },
    { source: 'recorded_parcel', value: parcel?.tax_delinquent ?? null },
    { source: 'eg_property_facts', value: facts?.tax_delinquent ?? null },
  ].map((t) => ({ ...t, value: t.value === null || t.value === undefined || t.value === '' ? null : t.value === true || /^(true|t|yes|y|1)$/i.test(String(t.value)) }))
  if (differs(tax)) out.push({ code: 'tax_delinquency_sources_disagree', severity: 'conflict', values: tax })
  const taxYear = [
    { source: 'campaign_target_graph', value: num(graph?.tax_delinquent_year) },
    { source: 'recorded_parcel', value: num(parcel?.tax_delinquent_year) },
    { source: 'eg_property_facts', value: num(facts?.tax_delinquent_year) },
  ]
  if (differs(taxYear)) out.push({ code: 'tax_delinquent_year_disagrees', severity: 'conflict', values: taxYear })
  const anyTax = tax.some((t) => t.value === true)
  if (anyTax && Array.isArray(liens) && liens.length && !liens.some((l) => /tax/i.test(`${l.category || ''} ${l.type || ''} ${l.title || ''}`))) {
    out.push({ code: 'tax_flag_without_recorded_tax_lien', severity: 'check', values: [{ source: 'recorded_documents', value: `${liens.length} lien(s), none tax` }] })
  }
  if (probate) {
    if (probate.exclude_targeting === true && graph?.sms_eligible === true) out.push({ code: 'probate_excluded_but_sms_eligible', severity: 'conflict', values: [{ source: 'probate_status', value: 'exclude_targeting' }, { source: 'campaign_target_graph', value: 'sms_eligible' }] })
    if (probate.validity_class === 'SOLD_BY_ESTATE' && graph?.sms_eligible === true) out.push({ code: 'estate_sold_but_still_targetable', severity: 'conflict', values: [{ source: 'probate_status', value: probate.validity_class }, { source: 'campaign_target_graph', value: 'sms_eligible' }] })
    if (probate.validity_class === 'HEIR_OWNED_NOW' && ownerKind === 'estate') out.push({ code: 'heir_owned_but_record_owner_is_estate', severity: 'conflict', values: [{ source: 'probate_status', value: probate.validity_class }, { source: 'property_record', value: ownerKind }] })
    if (probate.has_death_record === true && probate.estate_status === 'no_filing' && ownerKind === 'individual') out.push({ code: 'deceased_owner_no_probate_filing', severity: 'check', values: [{ source: 'probate_status', value: 'death record, no filing' }, { source: 'property_record', value: ownerKind }] })
    if (probate.only_deceased_reachable === true) out.push({ code: 'only_deceased_party_reachable', severity: 'check', values: [{ source: 'probate_status', value: 'only_deceased_reachable' }] })
    const deathYear = probate.date_of_death_year
    const lastSale = Array.isArray(sales) && sales.length ? sales.map((s) => String(s.date || '')).sort().pop() : null
    if (deathYear && lastSale && Number(lastSale.slice(0, 4)) > deathYear && !['SOLD_BY_ESTATE', 'HEIR_OWNED_NOW'].includes(probate.validity_class || '')) {
      out.push({ code: 'recorded_sale_after_death_not_classified', severity: 'check', values: [{ source: 'recorded_documents', value: lastSale.slice(0, 10) }, { source: 'probate_status', value: `${probate.validity_class} (death year ${deathYear})` }] })
    }
  }
  if (preforeclosure) {
    const v = preforeclosure.verdict
    const closed = ['SOLD', 'FORECLOSED_REO', 'CANCELLED_CURED'].includes(v || '')
    const active = ['STILL_IN_PREFORECLOSURE', 'AUCTION_SCHEDULED', 'AUCTION_POSTPONED'].includes(v || '')
    const vendorFlag = facts?.is_hot_preforeclosure === true || Boolean(clean(parcel?.preforeclosure_status))
    if (closed && vendorFlag) out.push({ code: 'preforeclosure_flag_vs_verified_closed', severity: 'conflict', values: [{ source: 'preforeclosure_status_v2', value: v }, { source: facts?.is_hot_preforeclosure === true ? 'eg_property_facts' : 'recorded_parcel', value: 'preforeclosure flagged' }] })
    if (active && Array.isArray(foreclosures) && foreclosures.length === 0) out.push({ code: 'verified_preforeclosure_without_recorded_filing', severity: 'check', values: [{ source: 'preforeclosure_status_v2', value: v }, { source: 'recorded_documents', value: 'no foreclosure filing' }] })
    if (v === 'AUCTION_SCHEDULED' && preforeclosure.auction_date && Date.parse(preforeclosure.auction_date) < today.getTime()) out.push({ code: 'auction_date_passed', severity: 'check', values: [{ source: 'preforeclosure_status_v2', value: preforeclosure.auction_date }] })
  }
  return out
}

// ── tool specs ───────────────────────────────────────────────────────────────

function readTool({ name, capability, label, description, input_schema, to_model, sources, table, rows_to_model = 25, execute }) {
  return {
    name, version: 1, capability, label, description, input_schema,
    output_schema: { type: 'object', description: 'projected fields only; see research/research-tools.js' },
    side_effect: 'read',
    permission: { min_role: 'operator', apps: ['agent'] },
    cost_class: 'db_light',
    limits: { rows_to_model, max_rows: 200, timeout_ms: 30_000, per_run: 30 },
    disclosure: { to_model, never: NEVER },
    wraps: { kind: 'service', module: '@/lib/agent/quick-scan/read-client.js', export: 'createQuickScanReadClient', reads: table, route: 'GET /rest/v1 (read-guarded)' },
    output_trust: 'system',
    sources,
    async execute(input, ctx) {
      if (!ctx?.services?.db) throw unavailable('SERVICE_UNAVAILABLE', 'read client not injected')
      return execute(input, ctx.services)
    },
    audit: (input) => ({ summary: `${name} read`, target_refs: input.property_id ? [`property:${input.property_id}`] : input.campaign_id ? [`campaign:${input.campaign_id}`] : [] }),
    target_refs: (input) => (input.property_id ? [`property:${input.property_id}`] : []),
    failure: { retry: 'read_retry_once', surface: 'tool_error' },
  }
}

async function loadCampaign(db, id) {
  const { rows } = await read(db.from('campaigns').select(CAMPAIGN_COLUMNS).eq('id', id).limit(1), 'campaigns')
  if (!rows[0]) throw unavailable('CAMPAIGN_NOT_FOUND', 'no campaign with this id')
  return rows[0]
}

export const RESEARCH_TOOL_SPECS = Object.freeze([
  readTool({
    name: 'campaign.list', capability: 5, label: 'Listing campaigns',
    description: 'Most recently updated campaigns: id, name, status, lifecycle dates and send/reply counters. Optional status filter.',
    input_schema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['draft', 'built', 'queued', 'scheduled', 'activating', 'active', 'paused', 'completed', 'failed', 'archived'] }, limit: LIMIT(25, 15) } },
    to_model: ['campaign_id', 'name', 'status', 'counts', 'lifecycle'], sources: ['lc.campaigns'], table: 'campaigns',
    async execute(input, { db }) {
      let q = db.from('campaigns').select(CAMPAIGN_COLUMNS).order('updated_at', { ascending: false }).limit(Math.min(input.limit || 15, 25))
      if (input.status) q = q.eq('status', input.status)
      const { rows } = await read(q, 'campaigns')
      return { rows: rows.map((c) => { const p = projectCampaign(c, { pinned: pinnedPropertyIds(c) }); delete p.audience.stack_labels; return p }) }
    },
  }),
  readTool({
    name: 'campaign.overview', capability: 5, label: 'Reading campaign overview',
    description: 'One campaign: status, lifecycle, counters, how its audience was built (Entity Graph stack labels, pinned property count) and campaign_targets totals by status.',
    input_schema: { type: 'object', additionalProperties: false, properties: { campaign_id: UUID }, required: ['campaign_id'] },
    to_model: ['campaign', 'targets'], sources: ['lc.campaigns', 'lc.campaign_targets'], table: 'campaigns,campaign_targets',
    async execute(input, { db }) {
      const c = await loadCampaign(db, input.campaign_id)
      const pinned = pinnedPropertyIds(c)
      const total = await read(db.from('campaign_targets').select('id', { count: 'exact', head: true }).eq('campaign_id', input.campaign_id), 'campaign_targets')
      const sample = await read(db.from('campaign_targets').select('target_status').eq('campaign_id', input.campaign_id).limit(200), 'campaign_targets')
      const by = {}
      for (const r of sample.rows) by[r.target_status || 'unknown'] = (by[r.target_status || 'unknown'] || 0) + 1
      return { campaign: projectCampaign(c, { pinned }), targets: { total: total.count, by_status_first_200: by, tallied_rows: sample.rows.length } }
    },
  }),
  readTool({
    name: 'campaign.targets', capability: 5, label: 'Reading campaign targets',
    description: 'Rows from campaign_targets for one campaign (property id, target status, block reason, identity / routing / suppression status, priority score). No phones or names.',
    input_schema: { type: 'object', additionalProperties: false, properties: { campaign_id: UUID, target_status: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z_]+$' }, limit: LIMIT(25, 25) }, required: ['campaign_id'] },
    to_model: ['rows'], sources: ['lc.campaign_targets'], table: 'campaign_targets',
    async execute(input, { db }) {
      let q = db.from('campaign_targets').select(TARGET_COLUMNS).eq('campaign_id', input.campaign_id).order('priority_score', { ascending: false, nullsFirst: false }).limit(Math.min(input.limit || 25, 25))
      if (input.target_status) q = q.eq('target_status', input.target_status)
      const { rows } = await read(q, 'campaign_targets')
      return { rows: rows.map((r) => ({ property_id: String(r.property_id), target_status: clean(r.target_status), block_reason: clean(r.block_reason), identity_status: clean(r.identity_status), routing_status: clean(r.routing_status), suppression_status: clean(r.suppression_status), template_status: clean(r.template_status), priority_score: num(r.priority_score), touch_number: num(r.touch_number), market: clean(r.market), state: clean(r.state), updated_at: r.updated_at || null })) }
    },
  }),
  readTool({
    name: 'campaign.audience_top', capability: 5, label: 'Ranking the campaign audience',
    description: 'The strongest properties in a campaign audience (pinned Entity Graph selection, else campaign_targets), ranked by a stated score from the campaign target graph (default aos_score = Decision Engine score). Returns scores, distress flags, equity, ownership shape and outreach readiness per property. Never phones or names.',
    input_schema: { type: 'object', additionalProperties: false, properties: { campaign_id: UUID, sort: { type: 'string', enum: [...SORTS], default: 'aos_score' }, limit: LIMIT(25, 10) }, required: ['campaign_id'] },
    to_model: ['ranked_by', 'audience', 'rows'], sources: ['lc.campaigns', 'lc.campaign_target_graph'], table: 'campaigns,campaign_targets,campaign_target_graph',
    async execute(input, { db }) {
      const c = await loadCampaign(db, input.campaign_id)
      let ids = pinnedPropertyIds(c)
      let source = 'pinned_entity_graph_selection'
      if (!ids.length) {
        const t = await read(db.from('campaign_targets').select('property_id').eq('campaign_id', input.campaign_id).limit(200), 'campaign_targets')
        ids = [...new Set(t.rows.map((r) => String(r.property_id)).filter(Boolean))]
        source = 'campaign_targets'
      }
      const truncated = ids.length > MAX_PINNED_IDS
      ids = ids.slice(0, MAX_PINNED_IDS)
      const sort = SORTS.includes(input.sort) ? input.sort : 'aos_score'
      const limit = Math.min(input.limit || 10, 25)
      const rows = []
      let requests = 0
      for (let i = 0; i < ids.length; i += GRAPH_CHUNK) {
        const chunk = ids.slice(i, i + GRAPH_CHUNK)
        const r = await read(db.from('campaign_target_graph').select(GRAPH_COLUMNS).in('property_id', chunk).order(sort, { ascending: false, nullsFirst: false }).limit(60), 'campaign_target_graph')
        requests += 1
        rows.push(...r.rows)
      }
      const collapsed = collapseGraphRows(rows)
      const key = (p) => (sort === 'equity_percent' ? p.equity.equity_percent : p.scores[sort])
      collapsed.sort((a, b) => (key(b) ?? -Infinity) - (key(a) ?? -Infinity))
      return {
        ranked_by: { field: sort, source: 'campaign_target_graph', note: 'top rows per 150-id chunk, merged; ties and nulls last' },
        audience: { source, member_ids: ids.length, member_ids_truncated: truncated, graph_rows_examined: rows.length, chunk_requests: requests, properties_ranked: collapsed.length },
        rows: collapsed.slice(0, limit),
      }
    },
  }),
  readTool({
    name: 'eg.distress_signals', capability: 2, label: 'Reading distress signals',
    description: 'Distress evidence for one property side by side, each with its source: campaign target graph flags (tax delinquency, liens, condition), recorded parcel snapshot, verified probate status, verified preforeclosure status, Entity Graph facts (when applied), plus deterministic cross-source inconsistencies (tax, ownership, probate, preforeclosure).',
    input_schema: { type: 'object', additionalProperties: false, properties: { property_id: PROPERTY_ID }, required: ['property_id'] },
    to_model: ['graph', 'parcel', 'probate', 'preforeclosure', 'facts', 'inconsistencies'], sources: ['lc.campaign_target_graph', 'lc.recorded_documents', 'lc.probate_status', 'lc.preforeclosure_status_v2', 'lc.eg_property_facts'], table: 'campaign_target_graph,probate_status,preforeclosure_status_v2,eg_property_facts',
    async execute(input, services) {
      const { db } = services
      const id = input.property_id
      const settled = await Promise.allSettled([
        read(db.from('campaign_target_graph').select(GRAPH_COLUMNS).eq('property_id', id).limit(20), 'campaign_target_graph'),
        read(db.from('probate_status').select(PROBATE_COLUMNS).eq('property_id', id).limit(1), 'probate_status'),
        read(db.from('preforeclosure_status_v2').select(PREFORECLOSURE_COLUMNS).eq('property_id', id).limit(1), 'preforeclosure_status_v2'),
        read(db.from('eg_property_facts').select(FACT_COLUMNS).eq('property_id', id).limit(1), 'eg_property_facts'),
        services.dossier ? services.dossier(id) : Promise.resolve(null),
      ])
      const val = (i) => (settled[i].status === 'fulfilled' ? settled[i].value : null)
      const why = (i) => (settled[i].status === 'rejected' ? settled[i].reason?.code || 'SOURCE_UNAVAILABLE' : null)
      const graphRows = val(0)?.rows || []
      const graph = graphRows.length ? collapseGraphRows(graphRows)[0] : null
      const probate = projectProbate(val(1)?.rows?.[0])
      const pf = projectPreforeclosure(val(2)?.rows?.[0])
      const factsRow = val(3)?.rows?.[0] || null
      const dossier = val(4)
      const records = dossier?.records || null
      const parcel = records?.parcel ? { tax_delinquent: records.parcel.tax_delinquent ?? null, tax_delinquent_year: num(records.parcel.tax_delinquent_year), tax_year: num(records.parcel.tax_year), tax_amount: num(records.parcel.tax_amount), active_lien: records.parcel.active_lien ?? null, lien_count: num(records.parcel.lien_count), preforeclosure_status: clean(records.parcel.preforeclosure_status), preforeclosure_type: clean(records.parcel.preforeclosure_type), is_vacant: records.parcel.is_vacant ?? null } : null
      const liens = Array.isArray(records?.liens) ? records.liens.map((l) => ({ category: l.category ?? null, type: l.type ?? null, title: l.title ?? null, recorded: l.recorded ?? null, amount_due: num(l.amountDue), tax_period: l.taxPeriod ?? null })) : null
      const foreclosures = Array.isArray(records?.foreclosures) ? records.foreclosures.map((f) => ({ stage: f.stage ?? null, recorded: f.recorded ?? null, auction_date: f.auctionDate ?? null })) : null
      const sales = Array.isArray(records?.sales) ? records.sales.map((s) => ({ date: s.date ?? null, price: num(s.price), doc_type: s.docType ?? null, arms_length: s.armsLength ?? null })) : null
      const ownerKind = dossier ? projectOwnership(dossier).owner_kind : null
      const facts = factsRow ? Object.fromEntries(Object.entries(factsRow).filter(([k]) => k !== 'property_id')) : null
      return {
        property_id: id,
        graph: graph ? { distress: graph.distress, equity: graph.equity, ownership: graph.ownership, sms_eligible_any_phone: graph.sms_eligible_any_phone } : { available: false, reason: why(0) || 'not_in_campaign_target_graph' },
        parcel: parcel || { available: false, reason: dossier ? 'no_parcel_snapshot' : why(4) || 'property_record_unavailable' },
        recorded: { liens: liens ? liens.slice(0, 10) : null, foreclosures: foreclosures ? foreclosures.slice(0, 5) : null, last_sales: sales ? sales.slice(0, 3) : null },
        owner_kind: ownerKind,
        probate: probate || { available: false, reason: why(1) || 'no_probate_row' },
        preforeclosure: pf || { available: false, reason: why(2) || 'no_preforeclosure_row' },
        facts: facts || { available: false, reason: why(3) === 'SOURCE_NOT_APPLIED' ? 'facts_table_not_applied' : why(3) || 'no_facts_row' },
        inconsistencies: findInconsistencies({ graph: graph ? { tax_delinquent: graph.distress.tax_delinquent, tax_delinquent_year: graph.distress.tax_delinquent_year, sms_eligible: graph.sms_eligible_any_phone } : null, parcel, liens, foreclosures, sales, probate, preforeclosure: pf, facts, ownerKind }),
      }
    },
  }),
  readTool({
    name: 'eg.contact_map', capability: 2, label: 'Reading the contact map',
    description: 'Who can be reached for one property, without revealing anyone: people as handles (P1, P2 …), each phone as last-2 digits only, phone type / activity / score, identity alignment, routing tier, SMS eligibility and blockers from the campaign target graph, plus the probate best-contact ROLE when one exists. No names, no full numbers.',
    input_schema: { type: 'object', additionalProperties: false, properties: { property_id: PROPERTY_ID }, required: ['property_id'] },
    to_model: ['people', 'phones', 'probate_contact'], sources: ['lc.campaign_target_graph', 'lc.probate_status'], table: 'campaign_target_graph,probate_status',
    async execute(input, { db }) {
      const id = input.property_id
      const [g, p] = await Promise.all([
        read(db.from('campaign_target_graph').select(CONTACT_COLUMNS).eq('property_id', id).limit(40), 'campaign_target_graph'),
        read(db.from('probate_status').select('best_contact_role,best_contact_tier,reachable_living_dm,only_deceased_reachable').eq('property_id', id).limit(1), 'probate_status').catch(() => ({ rows: [] })),
      ])
      const handles = new Map()
      const handle = (k) => { const key = String(k || 'unlinked'); if (!handles.has(key)) handles.set(key, `P${handles.size + 1}`); return handles.get(key) }
      const phones = g.rows.slice(0, 25).map((r) => ({
        person: handle(r.seller_person_key),
        phone: r.canonical_e164 ? maskPhoneDigits(r.canonical_e164) : null,
        phone_type: clean(r.phone_type), activity: clean(r.phone_activity_status), score: num(r.best_phone_score),
        identity_alignment: clean(r.identity_alignment), routing_tier: clean(r.routing_tier),
        sms_eligible: r.sms_eligible ?? null, wrong_number: r.wrong_number ?? null, post_contact_suppression: r.true_post_contact_suppression ?? null,
        pending_prior_touch: r.pending_prior_touch ?? null, active_queue_item: r.active_queue_item ?? null, block_reason: clean(r.queue_block_reason),
        touch_count: num(r.touch_count), last_outbound_at: r.last_outbound_at || null, last_inbound_at: r.last_inbound_at || null,
      }))
      const pc = p.rows[0] || null
      return {
        property_id: id,
        people: handles.size,
        phones_in_graph: g.rows.length,
        sms_eligible_phones: g.rows.filter((r) => r.sms_eligible === true).length,
        phones,
        probate_contact: pc ? { role: clean(pc.best_contact_role), tier: clean(pc.best_contact_tier), reachable_living_decision_maker: pc.reachable_living_dm ?? null, only_deceased_reachable: pc.only_deceased_reachable ?? null } : null,
      }
    },
  }),
  readTool({
    name: 'eg.facts', capability: 2, label: 'Reading Entity Graph facts',
    description: 'The Entity Graph property facts read model (public.eg_property_facts) for one property: tax, lien, preforeclosure flag, equity, ownership shape, last sale. eg.distress_signals already includes these facts; call this only without it. Reports "not applied" if the read model does not exist yet.',
    input_schema: { type: 'object', additionalProperties: false, properties: { property_id: PROPERTY_ID }, required: ['property_id'] },
    to_model: ['facts'], sources: ['lc.eg_property_facts'], table: 'eg_property_facts', rows_to_model: 1,
    async execute(input, { db }) {
      try {
        const { rows } = await read(db.from('eg_property_facts').select(FACT_COLUMNS).eq('property_id', input.property_id).limit(1), 'eg_property_facts')
        if (!rows[0]) return { property_id: input.property_id, available: false, reason: 'no_facts_row' }
        const { property_id, ...facts } = rows[0]
        return { property_id: String(property_id), available: true, facts }
      } catch (e) {
        if (e.code === 'SOURCE_NOT_APPLIED') return { property_id: input.property_id, available: false, reason: 'facts_table_not_applied' }
        throw e
      }
    },
  }),
])

export const RESEARCH_CAPABILITIES = Object.freeze([2, 4, 5, 10])

/** The sealed, READ-ONLY research registry: the 9 Quick Scan reads + the research reads. */
export function createResearchToolRegistry() {
  const registry = createToolRegistry({ readOnly: true })
  for (const spec of QUICK_SCAN_TOOL_SPECS) registry.register(spec)
  for (const spec of RESEARCH_TOOL_SPECS) registry.register(spec)
  return registry.seal()
}

/** API tool name ↔ registry name (the Messages API allows no dots). */
export const toApiName = (name) => name.replace(/\./g, '__')
export const fromApiName = (name) => String(name).replace(/__/g, '.')
