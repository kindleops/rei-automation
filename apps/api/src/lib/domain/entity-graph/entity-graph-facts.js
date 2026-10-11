/**
 * ENTITY GRAPH · PROPERTY FACTS — one definition for every value a property
 * grid column shows, sorts and filters on (owner, 2026-10-09: "Now I can't even
 * sort… SMS eligible: 'not sortable — the database has no whole-cohort order
 * for it'. ALL the columns up top — you should be able to click and sort and
 * filter.").
 *
 * WHY A REGISTRY OF JS COMPUTES (and not a SQL mirror): the values the grid
 * shows for the joined / computed columns are produced by JS truth functions —
 * SMS eligibility is the campaign builder's resolveCampaignTargetReadiness
 * (through propertySmsEligibility), last contact is latestContact, equity is
 * equityTruth (equity_known_v1), liens vs filings is splitRecordedCategories,
 * the property type is enrichedPropertyType. A SQL re-implementation of any of
 * them is a second truth that drifts. So each fact column here names
 *   - the INPUTS it needs (keyed, read-only SQL over the source tables), and
 *   - a COMPUTE that calls the SAME function the cell renders from.
 * Both consumers use this one registry:
 *   1. the interim whole-cohort sort/filter (entity-graph-facts-query.js) —
 *      computes the facts for the filtered cohort at request time (live);
 *   2. the refresh job for the PROPOSED read model public.eg_property_facts
 *      (entity-graph-facts-refresh.js) — computes them per chunk and upserts.
 * so a value in the table, a value sorted at request time and the value in the
 * cell are the same function of the same rows.
 *
 * Phones are read server-side (linkage rule, counts) and never leave as
 * values; names never become facts except the deed / owner display names the
 * grid already shows.
 */
import { equityTruth } from './entity-graph-truth.js'
import { splitRecordedCategories } from './entity-graph-recorded-docs.js'
import { enrichedPropertyType, normalizeAssetTypeLabel } from './entity-graph-normalize.js'
import { contactCandidates, latestContact, propertySmsEligibility } from './entity-graph-outreach-state.js'
import { ENTITY_GRAPH_LINKED_COLUMNS, ENTITY_GRAPH_PROPERTY_COLUMNS } from './entity-graph-column-enrichment.js'
import { primaryLinkedProspect } from './entity-graph-owner-link.js'
import { SOURCE_COLUMN_TYPES } from './eg-property-facts-types.js'
import { propertyCompanyStatus } from './entity-graph-company-status.js'
import { classifyPropertyType } from './entity-graph-property-class.js'
import { CAMPAIGN_FIELD_CATALOG } from '@/lib/domain/campaigns/campaign-field-catalog.js'

const clean = (v) => String(v ?? '').trim()
const present = (v) => v !== null && v !== undefined && v !== ''
const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const time = (v) => {
  const t = v ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}
const dateOnly = (v) => {
  if (!v) return null
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : null
  const s = String(v).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}
const iso = (v) => {
  if (!v) return null
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/* ── signals: the server copy of property-signals.ts (parity test reads the TS table) ── */

export const SIGNAL_TABLE = Object.freeze({
  'tax delinquent': ['Tax delinquent', 'distress'],
  'tax lien': ['Tax lien', 'distress'],
  preforeclosure: ['Pre-foreclosure', 'distress'],
  'pre-foreclosure': ['Pre-foreclosure', 'distress'],
  foreclosure: ['Foreclosure', 'distress'],
  'notice of default': ['Notice of default', 'distress'],
  'lis pendens': ['Lis pendens', 'distress'],
  'upcoming auction': ['Auction scheduled', 'distress'],
  'bank owned': ['Bank owned', 'distress'],
  probate: ['Probate', 'distress'],
  'death record': ['Death record', 'distress'],
  'vacant home': ['Vacant', 'distress'],
  'zombie property': ['Zombie property', 'distress'],
  'active lien': ['Active lien', 'distress'],
  'hoa lien': ['HOA lien', 'distress'],
  judgment: ['Judgment', 'distress'],
  "mechanic's lien": ["Mechanic's lien", 'distress'],
  'code violation': ['Code violation', 'distress'],
  'high equity': ['High equity', 'opportunity'],
  'free and clear': ['Free & clear', 'opportunity'],
  'tired landlord': ['Tired landlord', 'opportunity'],
  'senior owner': ['Senior owner', 'opportunity'],
  'empty nester': ['Empty nester', 'opportunity'],
  'long term owner': ['Long-term owner', 'opportunity'],
  'absentee owner': ['Absentee owner', 'opportunity'],
  'out of state owner': ['Out-of-state owner', 'opportunity'],
  'likely to move': ['Likely to move', 'opportunity'],
  'heavily dated': ['Heavily dated', 'opportunity'],
  'no updates': ['No updates', 'opportunity'],
  'low equity': ['Low equity', 'risk'],
  'adjustable loan': ['Adjustable loan', 'risk'],
  'private lender': ['Private lender', 'risk'],
  landlocked: ['Landlocked', 'risk'],
  'new owner': ['New owner', 'risk'],
  'recently sold': ['Recently sold', 'risk'],
  'corporate owner': ['Corporate owner', 'neutral'],
  'cash buyer': ['Bought with cash', 'neutral'],
  'mid-term owner': ['Mid-term owner', 'neutral'],
  'bought at trustee sale': ['Bought at trustee sale', 'neutral'],
})
export const NOT_SIGNALS = Object.freeze(new Set(['apartment building 5+ units', 'commercial', 'strip malls', 'storage units', 'off market', 'corner lot']))
const SIGNAL_RANK = { distress: 0, opportunity: 1, risk: 2, neutral: 3 }
const signalTokens = (text) => String(text ?? '').split(/[;|,]/).map((s) => s.trim()).filter(Boolean)

function signalFor(raw) {
  const k = raw.trim().toLowerCase()
  if (!k || NOT_SIGNALS.has(k)) return null
  const hit = SIGNAL_TABLE[k]
  if (hit) return { key: k, label: hit[0], tone: hit[1] }
  return { key: k, label: raw.trim().replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), tone: 'neutral' }
}

/** The record-summary signal labels (propertyRecordSummary in entity-graph-service.js). */
function recordSignalLabels(row) {
  if (!('rec_mortgage_count' in row)) return []
  const out = []
  if (row.rec_foreclosure_count > 0) out.push(row.rec_foreclosure_stage || 'Foreclosure')
  if (row.rec_has_probate) out.push('Probate')
  if (row.rec_has_lis_pendens) out.push('Lis pendens')
  if (row.rec_has_default_notice) out.push('Notice of default')
  if (row.rec_has_death_record) out.push('Death record')
  if (row.rec_has_tax_lien) out.push('Tax lien')
  if (row.rec_has_judgment) out.push('Judgment')
  if (row.rec_has_private_lender) out.push('Private lender')
  if (row.rec_last_sale_distress) out.push('Bought at trustee sale')
  return out
}

/** Every signal on a property row, deduplicated, distress first — propertySignals() on the server. */
export function propertySignalsFromRow(row = {}) {
  const raw = [
    ...signalTokens(row.property_flags_text),
    ...signalTokens(row.seller_tags_text),
    ...recordSignalLabels(row),
  ]
  if (row.tax_delinquent) raw.push('Tax Delinquent')
  if (row.out_of_state_owner) raw.push('Out Of State Owner')
  const seen = new Map()
  for (const t of raw) {
    const s = signalFor(t)
    if (!s) continue
    const key = s.label.toLowerCase()
    if (!seen.has(key)) seen.set(key, s)
  }
  return [...seen.values()].sort((a, b) => SIGNAL_RANK[a.tone] - SIGNAL_RANK[b.tone])
}

/** Base (view) columns each base-row derivation reads — only the needed ones are selected. */
export const BASE_NEEDS = Object.freeze({
  equity: ['estimated_value', 'total_loan_balance', 'property_flags_text', 'rec_mortgage_balance', 'rec_mortgage_count'],
  records: ['rec_mortgage_count', 'rec_lien_categories'],
  signals: ['property_flags_text', 'seller_tags_text', 'tax_delinquent', 'out_of_state_owner', 'rec_mortgage_count', 'rec_foreclosure_count',
    'rec_foreclosure_stage', 'rec_has_probate', 'rec_has_lis_pendens', 'rec_has_default_notice', 'rec_has_death_record', 'rec_has_tax_lien',
    'rec_has_judgment', 'rec_has_private_lender', 'rec_last_sale_distress'],
  asset: ['asset_subclass', 'acquisition_bucket', 'property_flags_text', 'units_count', 'style', 'normalized_asset_class', 'property_type'],
  // the canonical property type (entity-graph-property-class.js) + the observed vendor property use (input 'use')
  ptype: ['property_type', 'property_class', 'units_count', 'building_square_feet', 'asset_subclass', 'acquisition_bucket', 'property_flags_text'],
  zip: ['property_address_zip', 'property_zip'],
  sale: ['rec_last_sale_date', 'rec_last_sale_price', 'sale_date'],
  buyer: ['rec_owner_buyer_acquisitions', 'rec_owner_buyer_status'],
  owner: ['master_owner_id'],
  company: ['is_corporate_owner'],
  linked: ['master_owner_id'],
})
/** The canonical property type family (classifyPropertyType) — one derivation, five columns. */
const PTYPE_COLS = new Set(['property_type_class', 'property_type_group', 'property_type_confidence', 'property_type_basis', 'property_use_raw'])
const DERIVATION_OF = (col) => (
  /^equity_/.test(col) ? 'equity'
    : /^(lien|filing)_/.test(col) ? 'records'
      : /^(signal_labels|distress_signal_count)$/.test(col) ? 'signals'
        : col === 'asset_type' ? 'asset'
          : PTYPE_COLS.has(col) ? 'ptype'
          : col === 'zip_code' ? 'zip'
            : col === 'last_sale_on' ? 'sale'
              : col === 'owner_buyer_purchases' ? 'buyer'
                : null)

/** The view columns computing `cols` reads. */
export function baseColumnsFor(cols) {
  const need = new Set(['property_id'])
  const inputs = inputsFor(cols)
  for (const col of cols) for (const c of BASE_NEEDS[DERIVATION_OF(col)] || []) need.add(c)
  for (const i of ['owner', 'company', 'linked', 'zip']) if (inputs.has(i)) for (const c of BASE_NEEDS[i]) need.add(c)
  return [...need]
}

/* ── inputs: keyed, read-only SQL. `$1` is always the property-id array. ─────────── */

/** Columns of public.v_entity_graph_properties the computes read (plus every plain fact column). */
export const BASE_INPUT_COLUMNS = Object.freeze([
  'property_id', 'master_owner_id', 'estimated_value', 'total_loan_balance', 'equity_percent', 'property_flags_text',
  'seller_tags_text', 'tax_delinquent', 'out_of_state_owner', 'asset_subclass', 'acquisition_bucket', 'units_count',
  'style', 'normalized_asset_class', 'property_type', 'property_address_zip', 'property_zip', 'sale_date', 'sale_price',
  'rec_mortgage_count', 'rec_mortgage_balance', 'rec_lien_categories', 'rec_foreclosure_count', 'rec_foreclosure_stage',
  'rec_has_probate', 'rec_has_lis_pendens', 'rec_has_default_notice', 'rec_has_death_record', 'rec_has_tax_lien',
  'rec_has_judgment', 'rec_has_private_lender', 'rec_last_sale_distress', 'rec_last_sale_date', 'rec_last_sale_price',
  'rec_owner_buyer_acquisitions', 'rec_owner_buyer_status', 'is_corporate_owner', 'property_class', 'building_square_feet',
])

const OWNER_COLS = [...ENTITY_GRAPH_LINKED_COLUMNS.owner]
/** seller.owner → the prospects person columns (same vendor vocabulary; columns seller.owner lacks stay null). */
export const SELLER_OWNER_PERSON_COLS = Object.freeze({
  language_preference: 'o.language_preference', gender: 'o.gender', marital_status: 'o.marital_status', occupation_group: 'o.occupation_group',
  education_model: 'o.education_model', est_household_income: 'o.est_household_income', net_asset_value: 'o.net_asset_value',
  buying_power: 'o.buying_power', person_flags_text: "array_to_string(o.person_flags, '; ')",
})
const SCORE_COLS = [...ENTITY_GRAPH_LINKED_COLUMNS.scores]
const PERSON_COLS = [...ENTITY_GRAPH_LINKED_COLUMNS.person].filter((c) => c !== 'age')
const ZIP_COLS = [...ENTITY_GRAPH_LINKED_COLUMNS.zip]

/**
 * Each input: sql(k) where k(expr, op = '= any') is the key predicate — keyed
 * (`expr = any($1::text[])`) for a small cohort, `true` (one sequential scan,
 * rows filtered in JS) for a large one: on prod the keyed form costs a random
 * heap read per row (15 s cold for 6,397 properties' graph rows) while the
 * whole campaign graph scans sequentially in ~3.5 s.
 */
export const FACT_INPUTS = Object.freeze({
  graph: {
    sql: (k) => `select g.property_id, g.graph_id, g.queue_eligible, g.queue_block_reason, g.seller_person_key, g.prospect_id,
                 g.canonical_prospect_id, g.canonical_e164, g.phone_id, g.timezone, g.identity_alignment,
                 g.last_outbound_at, g.last_inbound_at, g.latest_contact_at, g.best_phone_score, g.seller_full_name,
                 g.phone_type, g.phone_activity_status, g.phone_owner, g.matching_flags_text
            from public.campaign_target_graph g
           where ${k('g.property_id')}`,
  },
  // the RPC campaign_entity_contact_review_flags reads exactly this (entity role mode 'off')
  review: {
    sql: (k) => `select distinct ec.property_id from seller.property_entity_contact_v1 ec
           where ${k('ec.property_id')} and coalesce(ec.requires_review, true)`,
  },
  // the owning entity and its state-registry record (owning_entity_id = '<company_number>:<jurisdiction_code>')
  company: {
    sql: (k) => `select ec.property_id, ec.owning_entity_id, ec.owning_entity_name, c.company_number, c.company_name, c.current_status,
                 c.inactive, c.dissolution_date, c.incorporation_date, c.jurisdiction_code, c.nonprofit
            from seller.property_entity_contact_v1 ec
            left join seller.company c
              on ec.owning_entity_id like '%:%'
             and c.company_number = split_part(ec.owning_entity_id, ':', 1)
             and c.jurisdiction_code = split_part(ec.owning_entity_id, ':', 2)
           where ${k('ec.property_id')}`,
  },
  thread: {
    sql: (k) => `select distinct on (t.property_id) t.property_id, t.thread_key, t.latest_message_at, t.latest_direction,
                 t.seller_stage, t.stage, t.conversation_status, t.status, t.last_inbound_at, t.last_outbound_at
            from public.inbox_thread_state t
           where ${k('t.property_id')}
           order by t.property_id, t.latest_message_at desc nulls last, t.thread_key`,
  },
  // the deal a property shows: the most recently updated one (outreach-state applies the same rule)
  opp: {
    sql: (k) => `select distinct on (o.primary_property_id) o.primary_property_id as property_id, o.id::text as id,
                 o.acquisition_stage, o.opportunity_status, o.universal_status
            from public.acquisition_opportunities o
           where ${k('o.primary_property_id')}
           order by o.primary_property_id, o.updated_at desc nulls last, o.id`,
  },
  targets: {
    sql: (k) => `select t.property_id, count(distinct btrim(t.campaign_id::text))::int as campaign_count,
                 (array_agg(btrim(t.campaign_id::text) order by t.created_at desc nulls last))[1] as latest_campaign_id
            from public.campaign_targets t
           where ${k('t.property_id')} and nullif(btrim(t.campaign_id::text), '') is not null
           group by t.property_id`,
  },
  campaigns: { key: 'id', sql: (k) => `select c.id::text as id, c.name from public.campaigns c where ${k('c.id::text')}` },
  // prospects linked by linked_property_ids_json (GIN) — owner fallback, person fallback, contact candidates
  linked: {
    sql: (k) => `select btrim(x.pid) as property_id, pr.prospect_id, pr.master_owner_id, pr.individual_key, pr.full_name,
                 pr.matching_flags, pr.phones_json, pr.rank_position, pr.is_primary_prospect, pr.mob,
                 ${PERSON_COLS.map((c) => `pr.${c}`).join(', ')}
            from public.prospects pr
            cross join lateral jsonb_array_elements_text(case when jsonb_typeof(pr.linked_property_ids_json) = 'array' then pr.linked_property_ids_json else '[]'::jsonb end) as x(pid)
           where ${k('pr.linked_property_ids_json', '?|')} and ${k('btrim(x.pid)')}
           order by 1, pr.prospect_id`,
  },
  owners: { key: 'master_owner_id', sql: (k) => `select m.master_owner_id, ${OWNER_COLS.map((c) => `m.${c}`).join(', ')} from public.master_owners m where ${k('m.master_owner_id')}` },
  sub_owners: { key: 'master_owner_id', sql: (k) => `select s.master_owner_id, s.owner_name from public.sub_owners s where ${k('s.master_owner_id')}` },
  emails: { key: 'master_owner_id', sql: (k) => `select e.master_owner_id, count(*)::int as n from public.emails e where ${k('e.master_owner_id')} group by 1` },
  people: { key: 'individual_key', sql: (k) => `select distinct on (p.individual_key) p.individual_key, p.mob, ${PERSON_COLS.map((c) => `p.${c}`).join(', ')} from public.prospects p where ${k('p.individual_key')} order by p.individual_key, p.prospect_id desc` },
  /*
   * PERSON FALLBACKS (owner P0 2026-10-10: age / language / gender / marital / income / net asset value
   * empty in EG). public.prospects carries only the April + May imports, so the 52,556 compact-import
   * properties (08-06, 10-07) had no person at all. The same vendor person lives in seller.owner (1.3 M,
   * keyed by individual_key = the campaign graph's seller_person_key), and the deed owner resolves to a
   * person in seller.property_owner_resolution_v1. Read-only, keyed; field-by-field fallback (mergePerson).
   */
  resolution: {
    sql: (k) => `select r.property_id, r.individual_key, r.owner_resolution_status, r.owner_role from seller.property_owner_resolution_v1 r
           where ${k('r.property_id')} and r.owner_role = 'primary_legal_owner' and r.owner_resolution_status in ('confirmed', 'high_confidence') and r.individual_key is not null`,
  },
  seller_people: {
    key: 'individual_key',
    keyedAlways: true,
    sql: (k) => `select o.individual_key, o.month_of_birth as mob, ${PERSON_COLS.map((c) => (SELLER_OWNER_PERSON_COLS[c] ? `${SELLER_OWNER_PERSON_COLS[c]} as ${c}` : `null::text as ${c}`)).join(', ')}
            from seller.owner o where ${k('o.individual_key')}`,
  },
  scores: { sql: (k) => `select s.property_id, ${SCORE_COLS.map((c) => `s.${c}`).join(', ')} from public.property_acquisition_scores s where ${k('s.property_id')}` },
  zip_rollup: {
    key: 'zip',
    sql: (k) => `select r.geo_key as zip, r.period, r.sale_count, r.investor_count, r.buyer_known_count, r.cash_known_count, r.cash_count,
                 r.median_price, r.median_ppsf, r.latest_sale
            from public.mi_geo_period_rollup r
           where r.build_id = (select b.build_id from public.mi_rollup_builds b where b.status = 'ready' order by b.build_id desc limit 1)
             and r.geo_level = 'zip' and r.asset = 'all' and r.period in ('90d', '1y') and ${k('r.geo_key')}`,
  },
  // DealMachine's standardized property use, observed per property (96% of the universe; several rows = several observations)
  use: {
    sql: (k) => `select o.property_id, o.property_use from seller.property_use_observation o where ${k('o.property_id')}`,
  },
  zip_buyers: {
    key: 'zip',
    sql: (k) => `select z.zip, count(*)::int as buyers, count(*) filter (where b.activity_status = 'active')::int as active_buyers
            from public.eg_buyer_index b cross join lateral unnest(b.zips) as z(zip)
           where ${k('b.zips', '&&')} and ${k('z.zip')}
           group by z.zip`,
  },
})

/* ── fact columns ────────────────────────────────────────────────────────────────── */

/**
 * kind: categorical | numeric | date | boolean | text | tokens (text[])
 * pg:   the column type in eg_property_facts and in the interim unnest relation
 * plain: copied verbatim from v_entity_graph_properties (sorted/filtered by its own name)
 */
/** The migration that adds the canonical property-type columns to eg_property_facts. */
export const PTYPE_ADDENDUM = '20261010200000_eg_property_facts_field_accuracy'

const C = (col, pg, kind, label, inputs, compute, extra = {}) => Object.freeze({ col, pg, kind, label, inputs, compute, ...extra })

const ownerOf = (x) => x.owner?.row || null
const personOf = (x) => x.person || null
const zipOf = (x) => x.zipStats || null

const LINKED_FACTS = [
  ...OWNER_COLS.map((c) => C(`owner_${c}`, null, null, `Owner · ${c.replace(/_/g, ' ')}`, ['owner'], (x) => { const o = ownerOf(x); return o && present(o[c]) ? o[c] : null }, { source: 'master_owners', sourceColumn: c, field: `owner.${c}` })),
  ...SCORE_COLS.map((c) => C(`scores_${c}`, null, null, `Decision Engine · ${c.replace(/_/g, ' ')}`, ['scores'], (x) => (x.scores && present(x.scores[c]) ? x.scores[c] : null), { source: 'property_acquisition_scores', sourceColumn: c, field: `scores.${c}` })),
  ...PERSON_COLS.map((c) => C(`person_${c}`, 'text', 'categorical', `Person · ${c.replace(/_/g, ' ')}`, ['person'], (x) => { const p = personOf(x); return p && present(p[c]) ? String(p[c]) : null }, { field: `person.${c}` })),
  C('person_age', 'integer', 'numeric', 'Owner age', ['person'], (x) => {
    const p = personOf(x)
    if (!p || !/^\d{6}$/.test(clean(p.mob))) return null
    const now = x.now || new Date()
    const y = Number(p.mob.slice(0, 4)); const m = Number(p.mob.slice(4))
    return now.getUTCFullYear() - y - (now.getUTCMonth() + 1 < m ? 1 : 0)
  }, { field: 'person.age' }),
  C('person_source', 'text', 'categorical', 'Person data source', ['person'], (x) => x.personSource ?? null, { field: 'person.source', addendum: PTYPE_ADDENDUM }),
  C('zip_sales_90d', 'integer', 'numeric', 'ZIP sales (90d)', ['zip'], (x) => zipOf(x)?.sales90d ?? null, { field: 'zip.sales_90d' }),
  C('zip_sales_1y', 'integer', 'numeric', 'ZIP sales (1y)', ['zip'], (x) => zipOf(x)?.sales1y ?? null, { field: 'zip.sales_1y' }),
  C('zip_investor_share', 'integer', 'numeric', 'ZIP investor share', ['zip'], (x) => zipOf(x)?.investorShare1y ?? null, { field: 'zip.investor_share' }),
  C('zip_cash_share', 'integer', 'numeric', 'ZIP cash share', ['zip'], (x) => zipOf(x)?.cashShare1y ?? null, { field: 'zip.cash_share' }),
  C('zip_median_price', 'numeric', 'numeric', 'ZIP median price', ['zip'], (x) => zipOf(x)?.medianPrice1y ?? null, { field: 'zip.median_price' }),
  C('zip_median_ppsf', 'numeric', 'numeric', 'ZIP median $/sqft', ['zip'], (x) => zipOf(x)?.medianPpsf1y ?? null, { field: 'zip.median_ppsf' }),
  C('zip_latest_sale', 'date', 'date', 'ZIP latest sale', ['zip'], (x) => zipOf(x)?.latestSale ?? null, { field: 'zip.latest_sale' }),
  C('zip_buyers', 'integer', 'numeric', 'Buyers in ZIP (all)', ['zip_buyers'], (x) => x.zipBuyers?.buyers ?? null, { field: 'zip.buyers' }),
  C('zip_active_buyers', 'integer', 'numeric', 'Active buyers in ZIP', ['zip_buyers'], (x) => x.zipBuyers?.active_buyers ?? null, { field: 'zip.active_buyers' }),
  // contact.* — the campaign graph's best row (best phone score) + counts; the number never leaves
  C('contact_person', 'text', 'text', 'Contact · person', ['graph'], (x) => clean(x.bestGraph?.seller_full_name) || null, { field: 'contact.person' }),
  C('contact_person_count', 'integer', 'numeric', 'Contact · people', ['graph'], (x) => (x.graph.length ? new Set(x.graph.map((r) => clean(r.seller_person_key) || clean(r.seller_full_name)).filter(Boolean)).size : null), { field: 'contact.person_count' }),
  C('contact_phone_count', 'integer', 'numeric', 'Contact · phones', ['graph'], (x) => (x.graph.length ? new Set(x.graph.map((r) => clean(r.canonical_e164)).filter(Boolean)).size : null), { field: 'contact.phone_count' }),
  C('contact_line_type', 'text', 'categorical', 'Contact · line type', ['graph'], (x) => clean(x.bestGraph?.phone_type) || null, { field: 'contact.line_type' }),
  C('contact_phone_activity', 'text', 'categorical', 'Contact · phone activity', ['graph'], (x) => clean(x.bestGraph?.phone_activity_status) || null, { field: 'contact.phone_activity' }),
  C('contact_phone_owner', 'text', 'categorical', 'Contact · phone owner', ['graph'], (x) => clean(x.bestGraph?.phone_owner) || null, { field: 'contact.phone_owner' }),
  C('contact_identity', 'text', 'categorical', 'Contact · identity', ['graph'], (x) => clean(x.bestGraph?.identity_alignment) || null, { field: 'contact.identity' }),
  C('contact_matching', 'text', 'text', 'Contact · matching', ['graph'], (x) => clean(x.bestGraph?.matching_flags_text) || null, { field: 'contact.matching' }),
  C('entity_name', 'text', 'text', 'Title entity', ['owner'], (x) => (x.subOwnerNames?.length ? x.subOwnerNames[0] : null), { field: 'entity.name' }),
  C('entity_count', 'integer', 'numeric', 'Title entities', ['owner'], (x) => (x.subOwnerNames?.length || null), { field: 'entity.count' }),
  C('email_count', 'integer', 'numeric', 'Emails', ['owner'], (x) => (x.emailCount || null), { field: 'email.count' }),
]

export const COMPUTED_FACTS = ([
  /* outreach — the same functions as GET /entity-graph/outreach-state */
  C('sms_eligible', 'boolean', 'boolean', 'SMS eligible', ['graph', 'review'], (x) => x.sms?.eligible ?? null, { group: 'Outreach & pipeline' }),
  C('sms_status', 'text', 'categorical', 'SMS eligibility (reason)', ['graph', 'review'], (x) => (x.sms ? (x.sms.eligible ? 'eligible' : x.sms.reason) : null), { group: 'Outreach & pipeline' }),
  // sort key: eligible first, then the blocking reasons alphabetically
  C('sms_sort', 'text', 'text', 'SMS eligible (order)', ['graph', 'review'], (x) => (x.sms ? (x.sms.eligible ? '0' : `1 ${x.sms.reason}`) : null), { internal: true }),
  C('sms_graph_rows', 'integer', 'numeric', 'Campaign graph rows', ['graph'], (x) => x.graph.length, { group: 'Outreach & pipeline' }),
  C('contact_candidate_phones', 'integer', 'numeric', 'Contact candidates (phones, not in graph)', ['graph', 'linked'], (x) => x.candidatePhones ?? null, { group: 'Outreach & pipeline' }),
  C('last_contact_at', 'timestamptz', 'date', 'Last contact', ['graph', 'thread'], (x) => iso(x.lastContact?.at), { group: 'Outreach & pipeline' }),
  C('last_contact_direction', 'text', 'categorical', 'Last contact direction', ['graph', 'thread'], (x) => x.lastContact?.direction ?? null, { group: 'Outreach & pipeline' }),
  C('pipeline_stage', 'text', 'categorical', 'Pipeline stage', ['opp'], (x) => clean(x.opp?.acquisition_stage) || null, { group: 'Outreach & pipeline' }),
  C('pipeline_status', 'text', 'categorical', 'Pipeline status', ['opp'], (x) => (x.opp ? clean(x.opp.opportunity_status || x.opp.universal_status) || null : null), { group: 'Outreach & pipeline' }),
  C('deal_id', 'text', 'text', 'Deal id', ['opp'], (x) => (x.opp?.id ? String(x.opp.id) : null), { internal: true }),
  C('conversation_stage', 'text', 'categorical', 'Conversation stage', ['thread'], (x) => (x.thread ? clean(x.thread.seller_stage || x.thread.stage) || null : null), { group: 'Outreach & pipeline' }),
  C('conversation_status', 'text', 'categorical', 'Conversation status', ['thread'], (x) => (x.thread ? clean(x.thread.conversation_status || x.thread.status) || null : null), { group: 'Outreach & pipeline' }),
  C('last_message_at', 'timestamptz', 'date', 'Last message', ['thread'], (x) => iso(x.thread?.latest_message_at), { group: 'Outreach & pipeline' }),
  C('campaign_count', 'integer', 'numeric', 'Campaigns', ['targets'], (x) => (x.targets === undefined ? null : (x.targets?.campaign_count ?? 0)), { group: 'Outreach & pipeline' }),
  C('latest_campaign_name', 'text', 'categorical', 'Latest campaign', ['targets'], (x) => x.latestCampaignName ?? null, { group: 'Outreach & pipeline' }),
  /* value & records — the same functions as propertyToResult */
  C('equity_known_pct', 'numeric', 'numeric', 'Equity % (known)', [], (x) => (x.equity.known ? x.equity.percent : null), { group: 'Value & equity' }),
  C('equity_known_amount', 'numeric', 'numeric', 'Equity $ (known)', [], (x) => (x.equity.known ? x.equity.amount : null), { group: 'Value & equity' }),
  C('equity_class', 'text', 'categorical', 'Equity class', [], (x) => x.equity.class, { group: 'Value & equity' }),
  C('equity_rule', 'text', 'categorical', 'Equity evidence', [], (x) => x.equity.rule, { group: 'Value & equity' }),
  C('lien_count', 'integer', 'numeric', 'Liens (recorded, by type)', [], (x) => (x.recCaptured ? x.recDocs.liens.length : null), { group: 'Debt, liens & sales' }),
  C('lien_types', 'text[]', 'tokens', 'Lien types', [], (x) => (x.recCaptured ? x.recDocs.liens.map((d) => d.label) : null), { group: 'Debt, liens & sales' }),
  C('filing_count', 'integer', 'numeric', 'Recorded filings (non-lien)', [], (x) => (x.recCaptured ? x.recDocs.filings.length : null), { group: 'Debt, liens & sales' }),
  C('filing_types', 'text[]', 'tokens', 'Recorded filing types', [], (x) => (x.recCaptured ? x.recDocs.filings.map((d) => d.label) : null), { group: 'Debt, liens & sales' }),
  C('last_sale_on', 'text', 'date', 'Last sale (recorded, else vendor)', [], (x) => x.lastSaleOn, { group: 'Debt, liens & sales' }),
  C('owner_buyer_purchases', 'integer', 'numeric', 'Owner is a buyer (purchases)', [], (x) => x.ownerBuyerPurchases, { group: 'Ownership' }),
  C('signal_labels', 'text[]', 'tokens', 'Signals', [], (x) => x.signals.map((s) => s.label), { group: 'Signals' }),
  C('distress_signal_count', 'integer', 'numeric', 'Distress signals', [], (x) => x.signals.filter((s) => s.tone === 'distress').length || null, { group: 'Signals' }),
  C('asset_type', 'text', 'categorical', 'Property type (legacy enriched)', [], (x) => x.assetType, { group: 'Property' }),
  C('zip_code', 'text', 'categorical', 'ZIP', [], (x) => x.zip, { group: 'Geography' }),
  /*
   * THE canonical property type (owner P0 2026-10-10) — entity-graph-property-class.js.
   * addendum: not in the 20261009 eg_property_facts migration; added by
   * PROPOSED_20261010200000_eg_property_facts_property_type.sql. Until that is
   * applied, reads of these columns take the live path and the refresh skips them.
   */
  C('property_type_class', 'text', 'categorical', 'Property type', ['use'], (x) => x.ptype.type, { group: 'Property', addendum: PTYPE_ADDENDUM }),
  C('property_type_group', 'text', 'categorical', 'Property type group', ['use'], (x) => x.ptype.group, { group: 'Property', addendum: PTYPE_ADDENDUM }),
  C('property_type_confidence', 'text', 'categorical', 'Property type confidence', ['use'], (x) => x.ptype.confidence, { group: 'Property', addendum: PTYPE_ADDENDUM }),
  C('property_type_basis', 'text', 'categorical', 'Property type evidence', ['use'], (x) => x.ptype.basis, { group: 'Property', addendum: PTYPE_ADDENDUM }),
  C('property_use_raw', 'text', 'categorical', 'Property use (vendor)', ['use'], (x) => x.uses.length ? x.uses.join(' || ') : null, { group: 'Property', addendum: PTYPE_ADDENDUM }),
  /* the owning company's state-registry status (entity-graph-company-status.js) */
  C('company_status_class', 'text', 'categorical', 'Company status', ['company'], (x) => x.company.class, { group: 'Owning company' }),
  C('company_status_raw', 'text', 'categorical', 'Company status (registry wording)', ['company'], (x) => x.company.raw, { group: 'Owning company' }),
  C('company_registry_match', 'text', 'categorical', 'Company registry match', ['company'], (x) => x.company.registryMatch, { group: 'Owning company' }),
  C('company_name', 'text', 'text', 'Owning company', ['company'], (x) => x.company.name, { group: 'Owning company' }),
  C('company_inactive', 'boolean', 'boolean', 'Company flagged inactive (registry)', ['company'], (x) => (x.company.registryMatch === 'matched' ? x.companyRow?.inactive ?? null : null), { group: 'Owning company' }),
  C('company_dissolution_date', 'date', 'date', 'Company dissolved on', ['company'], (x) => dateOnly(x.companyRow?.dissolution_date), { group: 'Owning company' }),
  C('company_incorporation_date', 'date', 'date', 'Company incorporated on', ['company'], (x) => dateOnly(x.companyRow?.incorporation_date), { group: 'Owning company' }),
  C('company_age_years', 'numeric', 'numeric', 'Company age (years)', ['company'], (x) => {
    const d = dateOnly(x.companyRow?.incorporation_date)
    if (!d) return null
    const ms = (x.now || new Date()).getTime() - Date.parse(`${d}T00:00:00Z`)
    return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / (365.25 * 86_400_000) * 10) / 10 : null
  }, { group: 'Owning company' }),
  C('company_jurisdiction', 'text', 'categorical', 'Company jurisdiction', ['company'], (x) => (x.company.registryMatch === 'matched' ? x.companyRow?.jurisdiction_code || null : null), { group: 'Owning company' }),
  C('company_nonprofit', 'boolean', 'boolean', 'Company is a nonprofit', ['company'], (x) => (x.company.registryMatch === 'matched' ? x.companyRow?.nonprofit ?? null : null), { group: 'Owning company' }),
  C('owner_resolved_id', 'text', 'text', 'Resolved master owner', ['owner'], (x) => x.owner?.id ?? null, { internal: true }),
  C('owner_link_basis', 'text', 'categorical', 'Owner link basis', ['owner'], (x) => x.owner?.basis ?? null, { group: 'Ownership' }),
  ...LINKED_FACTS,
])

/**
 * Never a facts column: the withheld Podio-era scores, the vendor repair
 * estimate (owner valuation lanes — MLS ARV lane only) and internal plumbing.
 * Test: ⊇ every properties.* field in ENTITY_GRAPH_WITHHELD_FIELDS.
 */
export const WITHHELD_FACT_COLUMNS = Object.freeze(new Set([
  'cash_offer', 'final_acquisition_score', 'ai_score', 'structured_motivation_score', 'deal_strength_score', 'tag_distress_score',
  'estimated_repair_cost', 'estimated_repair_cost_per_sqft', 'search_profile_hash',
]))

/** Plain columns: every view column a property column, filter or facet can reference. */
export const PLAIN_FACT_COLUMNS = Object.freeze([...new Set([
  'property_id', 'property_address_full', 'market', 'market_region', 'property_address_city', 'property_address_state',
  'property_address_zip', 'property_zip', 'normalized_asset_class', 'property_type', 'units_count', 'estimated_value',
  'equity_percent', 'equity_amount', 'total_loan_balance', 'property_flags_text', 'seller_tags_text', 'owner_name',
  'is_corporate_owner', 'out_of_state_owner', 'tax_delinquent', 'active_lien', 'master_owner_id',
  ...ENTITY_GRAPH_PROPERTY_COLUMNS,
  ...[...ENTITY_GRAPH_LINKED_COLUMNS.rec].map((c) => `rec_${c}`),
  'rec_owner_buyer_id', 'rec_owner_buyer_status', 'rec_owner_buyer_acquisitions', 'rec_owner_buyer_basis',
  'property_flags_json', 'property_address_county_name', 'building_condition', 'rehab_level',
  // every catalogued property field the rail can filter on (column contract: a filter always compiles on the table)
  ...CAMPAIGN_FIELD_CATALOG.filter((f) => f.source_table_or_view === 'properties' && f.filterable).map((f) => f.source_column),
].filter((c) => c && SOURCE_COLUMN_TYPES.v_entity_graph_properties?.[c] && !WITHHELD_FACT_COLUMNS.has(c)))])

/** pg type → the header-filter kind. */
export function kindOfPg(pg) {
  const t = String(pg || '')
  if (t.endsWith('[]')) return 'tokens'
  if (t === 'boolean') return 'boolean'
  if (/^(integer|bigint|smallint|numeric|real|double precision)$/.test(t)) return 'numeric'
  if (/^(date|timestamp with time zone|timestamp without time zone|timestamptz)$/.test(t)) return 'date'
  if (t === 'jsonb' || t === 'json') return 'text'
  return 'categorical'
}

const typeOfSource = (f) => SOURCE_COLUMN_TYPES[f.source]?.[f.sourceColumn] || 'text'
/** Linked columns take their type from the source column (snapshot). */
function resolved(f) {
  if (f.pg) return f
  const pg = typeOfSource(f)
  return Object.freeze({ ...f, pg: pg === 'jsonb' ? 'text' : pg, kind: kindOfPg(pg), jsonText: pg === 'jsonb' })
}
for (let i = 0; i < COMPUTED_FACTS.length; i += 1) COMPUTED_FACTS[i] = resolved(COMPUTED_FACTS[i]) // eslint-disable-line no-param-reassign

/** Type of a plain (view) column. */
export const plainColumnType = (col) => SOURCE_COLUMN_TYPES.v_entity_graph_properties?.[col] || null

export const FACT_BY_COL = new Map(COMPUTED_FACTS.map((f) => [f.col, f]))

/**
 * Columns computed together (one family = the same inputs, cheap to finish
 * once loaded): sorting by SMS eligible also yields its reason for the header
 * filter without a second pass.
 */
const FAMILY_PREFIX = [
  ['sms', /^sms_/], ['contact_last', /^last_contact_/], ['pipeline', /^(pipeline_|deal_id$)/], ['conversation', /^(conversation_|last_message_at$)/],
  ['campaigns', /^(campaign_count|latest_campaign_name)$/], ['company', /^company_/], ['equity', /^equity_/], ['records', /^(lien|filing)_/],
  ['signals', /^(signal_labels|distress_signal_count)$/], ['ptype', /^(property_type_(class|group|confidence|basis)|property_use_raw)$/],
]
export function factFamily(col) {
  for (const [name, re] of FAMILY_PREFIX) if (re.test(col)) return name
  return `col:${col}`
}
/** `cols` widened to whole families, sorted (a stable cache key). */
export function widenToFamilies(cols) {
  const fams = new Set(cols.map(factFamily))
  return COMPUTED_FACTS.filter((f) => fams.has(factFamily(f.col))).map((f) => f.col).sort()
}
export const COMPUTED_FACT_COLS = new Set(COMPUTED_FACTS.map((f) => f.col))
export const isComputedFactColumn = (col) => COMPUTED_FACT_COLS.has(String(col ?? ''))
export const isPlainFactColumn = (col) => PLAIN_FACT_COLUMNS.includes(String(col ?? ''))
export const isFactSortColumn = (col) => isComputedFactColumn(col) || isPlainFactColumn(col)

/** The input sets a group of fact columns needs (transitively). */
export function inputsFor(cols) {
  const want = new Set()
  for (const col of cols) for (const i of FACT_BY_COL.get(col)?.inputs || []) want.add(i)
  if (want.has('person')) { want.add('graph'); want.add('linked'); want.add('resolution') }
  if (want.has('owner')) want.add('linked')
  if (want.has('zip_buyers')) want.add('zip')
  return want
}

/* ── loading ─────────────────────────────────────────────────────────────────────── */

const group = (rows, key) => {
  const map = new Map()
  for (const row of rows || []) {
    const k = clean(row[key])
    if (!k) continue
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(row)
  }
  return map
}
const one = (rows, key) => { const m = new Map(); for (const r of rows || []) { const k = clean(r[key]); if (k && !m.has(k)) m.set(k, r) } return m }

/**
 * Compute `cols` for the base rows (one per property, carrying BASE_INPUT_COLUMNS).
 * `query(sql, params, timeoutMs)` is the direct-PG read; returns Map(property_id → { col: value }).
 * `opts.entityRoleMode` must be 'off' for the SMS facts (the review flag's v2
 * modes are decided in JS over an evidence RPC that has no keyed bulk form).
 */
export async function computeFacts(baseRows, cols, { query, timeoutMs = 25_000, now = new Date(), entityRoleMode = 'off', chunk = 4_000, keyedMax = 4_000, trace = null } = {}) {
  const wanted = [...new Set(cols)].filter((c) => FACT_BY_COL.has(c))
  const needs = inputsFor(wanted)
  if (needs.has('review') && entityRoleMode !== 'off') {
    const error = new Error(`sms_facts_unavailable: entity role mode '${entityRoleMode}' decides review in JS per property`)
    error.code = 'facts_unavailable'
    throw error
  }
  const ids = baseRows.map((r) => clean(r.property_id)).filter(Boolean)
  const derivations = new Set(wanted.map(DERIVATION_OF).filter(Boolean))
  const read = async (name, keys) => {
    if (!keys.length) return []
    const input = FACT_INPUTS[name]
    // keyedAlways: a source too large to scan (seller.owner, 1.3 M rows) is read by its key index in chunks
    if (keys.length > keyedMax && !input.keyedAlways) {
      // one sequential scan, filtered here (see FACT_INPUTS)
      const res = await query(input.sql(() => 'true'), [], timeoutMs)
      const set = new Set(keys)
      const k = input.key || 'property_id'
      return (res?.rows || []).filter((r) => set.has(clean(r[k])))
    }
    const sql = input.sql((expr, op = '= any') => (op === '= any' ? `${expr} = any($1::text[])` : `${expr} ${op} $1::text[]`))
    const out = []
    for (let i = 0; i < keys.length; i += chunk) {
      const res = await query(sql, [keys.slice(i, i + chunk)], timeoutMs)
      out.push(...(res?.rows || []))
    }
    return out
  }
  const fetch = async (name) => (needs.has(name) ? read(name, ids) : null)
  const [graphRows, reviewRows, threadRows, oppRows, targetRows, linkedRows, scoreRows, companyRows, useRows, resolutionRows] = await Promise.all([
    fetch('graph'), fetch('review'), fetch('thread'), fetch('opp'), fetch('targets'), fetch('linked'), fetch('scores'), fetch('company'), fetch('use'), fetch('resolution'),
  ])
  const resolvedKeyBy = new Map((resolutionRows || []).map((r) => [clean(r.property_id), clean(r.individual_key)]).filter(([, k]) => k))
  const usesBy = group(useRows, 'property_id')
  const companyBy = one(companyRows, 'property_id')
  const graphBy = group(graphRows, 'property_id')
  const review = reviewRows ? new Set(reviewRows.map((r) => clean(r.property_id))) : null
  const threadBy = one(threadRows, 'property_id')
  const oppBy = one(oppRows, 'property_id')
  const targetBy = one(targetRows, 'property_id')
  const linkedBy = group(linkedRows, 'property_id')
  const scoreBy = one(scoreRows, 'property_id')
  const baseBy = new Map(baseRows.map((r) => [clean(r.property_id), r]))

  // second hop: owners (resolved), people (best graph person), campaigns, zips
  const ownerRes = new Map()
  if (needs.has('owner')) {
    for (const id of ids) {
      const oid = clean(baseBy.get(id)?.master_owner_id)
      if (oid) { ownerRes.set(id, { id: oid, basis: 'property' }); continue }
      const owners = new Set((linkedBy.get(id) || []).map((p) => clean(p.master_owner_id)).filter(Boolean))
      if (owners.size === 1) ownerRes.set(id, { id: [...owners][0], basis: 'prospect_link' })
    }
  }
  const ownerIds = [...new Set([...ownerRes.values()].map((o) => o.id))]
  const bestPerson = new Map()
  if (needs.has('person')) {
    for (const [id, rows] of graphBy) {
      let cur = null
      for (const g of rows) if (clean(g.seller_person_key) && (!cur || (Number(g.best_phone_score) || -1) > (Number(cur.best_phone_score) || -1))) cur = g
      if (cur) bestPerson.set(id, clean(cur.seller_person_key))
    }
  }
  const zipKey = (r) => clean(r?.property_address_zip || r?.property_zip).slice(0, 5)
  const zips = needs.has('zip') ? [...new Set(baseRows.map(zipKey).filter((z) => /^\d{5}$/.test(z)))] : []
  const latestCampaignIds = targetRows ? [...new Set(targetRows.map((t) => clean(t.latest_campaign_id)).filter(Boolean))] : []
  const sellerKeys = needs.has('person') ? [...new Set([...bestPerson.values(), ...resolvedKeyBy.values()])] : []
  const [ownerRows, subRows, emailRows, peopleRows, rollupRows, buyerRows, campaignRows, sellerPeopleRows] = await Promise.all([
    needs.has('owner') ? read('owners', ownerIds) : null,
    needs.has('owner') && wanted.some((c) => c.startsWith('entity_')) ? read('sub_owners', ownerIds) : null,
    needs.has('owner') && wanted.includes('email_count') ? read('emails', ownerIds) : null,
    needs.has('person') ? read('people', [...new Set(bestPerson.values())]) : null,
    zips.length ? read('zip_rollup', zips) : null,
    needs.has('zip_buyers') && zips.length ? read('zip_buyers', zips) : null,
    latestCampaignIds.length ? read('campaigns', latestCampaignIds) : null,
    sellerKeys.length ? read('seller_people', sellerKeys) : null,
  ])
  const sellerPeopleBy = one(sellerPeopleRows, 'individual_key')
  const ownerBy = one(ownerRows, 'master_owner_id')
  const subBy = new Map()
  for (const r of subRows || []) {
    const oid = clean(r.master_owner_id)
    if (!subBy.has(oid)) subBy.set(oid, new Set())
    if (clean(r.owner_name)) subBy.get(oid).add(clean(r.owner_name))
  }
  const emailBy = new Map((emailRows || []).map((r) => [clean(r.master_owner_id), Number(r.n) || 0]))
  const peopleBy = one(peopleRows, 'individual_key')
  const zipStats = new Map()
  for (const r of rollupRows || []) {
    const z = clean(r.zip)
    if (!zipStats.has(z)) zipStats.set(z, { sales90d: null, sales1y: null, investorShare1y: null, cashShare1y: null, medianPrice1y: null, medianPpsf1y: null, latestSale: null })
    const s = zipStats.get(z)
    if (r.period === '90d') s.sales90d = num(r.sale_count)
    if (r.period === '1y') {
      s.sales1y = num(r.sale_count)
      const known = num(r.buyer_known_count)
      s.investorShare1y = known ? Math.round((num(r.investor_count) / known) * 100) : null
      const cashKnown = num(r.cash_known_count)
      s.cashShare1y = cashKnown ? Math.round((num(r.cash_count) / cashKnown) * 100) : null
      s.medianPrice1y = num(r.median_price)
      s.medianPpsf1y = num(r.median_ppsf)
      s.latestSale = r.latest_sale ? String(r.latest_sale instanceof Date ? r.latest_sale.toISOString().slice(0, 10) : r.latest_sale).slice(0, 10) : null
    }
  }
  const buyersBy = one(buyerRows, 'zip')
  const campaignName = new Map((campaignRows || []).map((c) => [clean(c.id), c.name || null]))

  const computeStarted = Date.now()
  const out = new Map()
  for (const id of ids) {
    const row = baseBy.get(id) || {}
    const graph = graphBy.get(id) || []
    const x = { id, row, graph, now }
    if (needs.has('graph') || needs.has('review')) {
      x.sms = graphRows === null ? null : propertySmsEligibility(graph, review ? review.has(id) : false)
      let best = null
      for (const g of graph) if (!best || (Number(g.best_phone_score) || -1) > (Number(best.best_phone_score) || -1)) best = g
      x.bestGraph = best
    }
    if (needs.has('thread')) {
      x.thread = threadBy.get(id) || null
      x.lastContact = latestContact({ thread: x.thread, graphRows: graph })
    }
    if (needs.has('opp')) x.opp = oppBy.get(id) || null
    if (needs.has('targets')) {
      x.targets = targetBy.get(id) || null
      x.latestCampaignName = x.targets?.latest_campaign_id ? (campaignName.get(clean(x.targets.latest_campaign_id)) ?? null) : null
    }
    if (needs.has('linked') && wanted.includes('contact_candidate_phones')) {
      // contact discovery only where the graph has no phone (outreach-state's gap rule)
      const gap = !graph.some((r) => clean(r.canonical_e164))
      if (gap) {
        const found = contactCandidates({ prospects: (linkedBy.get(id) || []).slice(0, 12), propertyOwnerId: clean(row.master_owner_id) || null, graphRows: graph })
        x.candidatePhones = found.reduce((n, c) => n + c.phones.length, 0)
      } else x.candidatePhones = null
    }
    if (needs.has('owner')) {
      const res = ownerRes.get(id) || null
      x.owner = res ? { ...res, row: ownerBy.get(res.id) || null } : null
      x.subOwnerNames = res ? [...(subBy.get(res.id) || [])].sort() : []
      x.emailCount = res ? emailBy.get(res.id) || 0 : 0
    }
    if (needs.has('person')) {
      const key = bestPerson.get(id)
      const deedKey = resolvedKeyBy.get(id) || null
      const merged = mergePerson([
        ['prospect', (key && peopleBy.get(key)) || primaryLinkedProspect(linkedBy.get(id)) || null],
        ['seller_owner_contact', key ? sellerPeopleBy.get(key) || null : null],
        ['seller_owner_deed', deedKey ? sellerPeopleBy.get(deedKey) || null : null],
      ])
      x.person = merged.person
      x.personSource = merged.source
    }
    if (needs.has('scores')) x.scores = scoreBy.get(id) || null
    if (needs.has('company')) {
      x.companyRow = companyBy.get(id) || null
      x.company = propertyCompanyStatus(x.companyRow, { corporate: row.is_corporate_owner === true })
    }
    if (needs.has('zip')) { const z = zipKey(row); x.zipStats = zipStats.get(z) || null; x.zipBuyers = buyersBy.get(z) || null }
    // base-row derivations, only when a wanted column reads them
    if (derivations.has('equity')) x.equity = equityTruth(row)
    if (derivations.has('records')) {
      x.recCaptured = row.rec_mortgage_count !== null && row.rec_mortgage_count !== undefined
      x.recDocs = splitRecordedCategories(row.rec_lien_categories)
    }
    if (derivations.has('signals')) x.signals = propertySignalsFromRow(row)
    if (derivations.has('ptype')) {
      x.uses = [...new Set((usesBy.get(id) || []).map((r) => clean(r.property_use)).filter(Boolean))].sort()
      x.ptype = classifyPropertyType(row, { uses: x.uses })
    }
    if (derivations.has('asset')) x.assetType = enrichedPropertyType(row, normalizeAssetTypeLabel(row.normalized_asset_class || row.property_type)) || null
    if (derivations.has('zip')) x.zip = clean(row.property_address_zip || row.property_zip) || null
    if (derivations.has('sale')) {
      const fromRecord = Boolean(clean(row.rec_last_sale_date) || num(row.rec_last_sale_price) !== null)
      const d = fromRecord ? row.rec_last_sale_date : row.sale_date
      x.lastSaleOn = d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null
    }
    if (derivations.has('buyer')) {
      const n = num(row.rec_owner_buyer_acquisitions)
      x.ownerBuyerPurchases = n !== null && (n >= 2 || clean(row.rec_owner_buyer_status) === 'active') ? n : null
    }
    const values = {}
    for (const col of wanted) {
      const v = FACT_BY_COL.get(col).compute(x)
      values[col] = v === undefined ? null : (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) ? JSON.stringify(v) : v)
    }
    out.set(id, values)
  }
  if (trace) trace(`compute ${ids.length} × ${wanted.length} cols: ${Date.now() - computeStarted} ms`)
  return out
}

/**
 * Field-by-field person: the first source with a value for each column wins
 * (prospects → seller.owner for the graph's contact person → seller.owner for
 * the resolved deed owner). Month of birth is one field (age derives from it).
 * `source` = the source that supplied the most fields (ties → precedence).
 */
export function mergePerson(sources) {
  const cols = ['mob', ...PERSON_COLS]
  const person = {}
  const used = new Map()
  let any = false
  for (const c of cols) {
    for (const [name, row] of sources) {
      if (!row) continue
      const v = row[c]
      if (v === null || v === undefined || String(v).trim() === '') continue
      person[c] = v
      used.set(name, (used.get(name) || 0) + 1)
      any = true
      break
    }
  }
  if (!any) {
    // a person row with no values is still the linked person (keeps identity-only fields stable)
    const first = sources.find(([, row]) => row)
    return { person: first ? first[1] : null, source: first ? first[0] : null }
  }
  let source = null
  let best = -1
  for (const [name] of sources) if ((used.get(name) || 0) > best) { best = used.get(name) || 0; source = name }
  return { person, source }
}

export const __factsTest = { time }
