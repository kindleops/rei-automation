/**
 * ENTITY GRAPH · DEEP-RESEARCH QA CAPTURE (2026-10-08). NO DATABASE, NO NETWORK.
 *
 * Serves a dev-mode build from an in-process static server. Every
 * /api/cockpit/entity-graph/* request is answered IN PROCESS by the REAL API
 * domain code (browse, filter catalog, composition, columns, outreach state,
 * network, campaign-stack list + DRY RUN) running against a SYNTHETIC
 * in-memory dataset through a minimal supabase-js stand-in. Nothing reaches
 * production: every other /api and Supabase request is aborted, Google Street
 * View requests are answered with a local placeholder (and counted — the
 * fan-out rule says one per selected property, zero for lists / hovers), and a
 * campaign-stack POST that is not a dry run is refused and reported as a
 * violation (it never runs).
 *
 * Run from apps/api (the '@/…' alias resolves against its cwd):
 *   node --import ./tests/alias-loader-register.mjs ../dashboard/scripts/proof/desktop/eg-research-qa.mjs \
 *     --dist=/tmp/eg-qa-dist --out=../dashboard/artifacts/eg-research-qa --themes=dark,light \
 *     --sizes=1440x900,1920x1080,2560x1440,5120x1440
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

process.env.SUPABASE_URL ||= 'http://127.0.0.1:1'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'harness'
delete process.env.DATABASE_URL

const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const DIST = path.resolve(arg('dist', '/tmp/eg-qa-dist'))
const OUT = path.resolve(arg('out', '../dashboard/artifacts/eg-research-qa'))
const THEMES = arg('themes', 'dark').split(',')
const SIZES = arg('sizes', '1440x900').split(',').filter(Boolean).map((s) => s.split('x').map(Number))
const ONLY = arg('scenes', '')
await fs.mkdir(OUT, { recursive: true })

const { browseEntityGraph } = await import('@/lib/domain/entity-graph/entity-graph-service.js')
const { getEntityGraphFilterCatalog } = await import('@/lib/domain/entity-graph/entity-graph-field-filters.js')
const { buildEntityGraphComposition, getCompositionCatalog } = await import('@/lib/domain/entity-graph/entity-graph-composition.js')
const { getEntityGraphColumnEnrichment } = await import('@/lib/domain/entity-graph/entity-graph-column-enrichment.js')
const { getEntityGraphOutreachState } = await import('@/lib/domain/entity-graph/entity-graph-outreach-state.js')
const { getEntityNetwork } = await import('@/lib/domain/entity-graph/entity-network-service.js')
const { listStackableDrafts, stackEntityGraphCohort, StackRefusal } = await import('@/lib/domain/entity-graph/entity-graph-campaign-stack.js')

/* ── synthetic dataset (deterministic) ─────────────────────────────────── */
let seed = 7
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const MARKETS = [['Dallas, TX', 'Dallas', 'TX', 'Dallas', 32.78, -96.8], ['Atlanta, GA', 'Atlanta', 'GA', 'Fulton', 33.75, -84.39], ['Miami, FL', 'Miami', 'FL', 'Miami-Dade', 25.76, -80.19], ['Houston, TX', 'Houston', 'TX', 'Harris', 29.76, -95.37]]
const STREETS = ['Elm St', 'Oak Ave', 'Magnolia Dr', 'Peachtree Rd', 'Bayview Ln', 'Cedar Ct', 'Sunset Blvd', 'Willow Way', 'Maple St', 'Ridge Rd']
const FLAGS = ['Vacant Home', 'Tax Delinquent', 'Tired Landlord', 'Preforeclosure', 'Probate', 'High Equity', 'Free And Clear', 'Absentee Owner']
const FIRST = ['Ana', 'Luis', 'Marcus', 'Denise', 'Robert', 'Grace', 'Hector', 'Linda', 'Samuel', 'Yvonne', 'Carlos', 'Patricia']
const LAST = ['Ruiz', 'Johnson', 'Nguyen', 'Williams', 'Okafor', 'Garcia', 'Patel', 'Brown', 'Moreno', 'Davis']
const T = { properties: [], master_owners: [], prospects: [], phones: [], emails: [], sub_owners: [], inbox_thread_state: [], acquisition_opportunities: [], campaign_targets: [], campaigns: [], campaign_target_graph: [], property_acquisition_scores: [] }
for (let o = 0; o < 24; o += 1) {
  const last = pick(LAST)
  const trust = o % 4 === 0
  const id = `mo_${String(o).padStart(4, '0')}`
  T.master_owners.push({ master_owner_id: id, display_name: trust ? `${last} Family Trust` : o % 5 === 1 ? `${last} Holdings LLC` : `${pick(FIRST)} ${last}`, owner_type_guess: trust ? 'TRUST/ESTATE | ABSENTEE' : o % 5 === 1 ? 'LLC/CORP | ABSENTEE' : 'INDIVIDUAL | ABSENTEE', priority_tier: pick(['A', 'B', 'C']), follow_up_cadence: pick(['weekly', 'monthly']), property_count: 0, portfolio_total_value: 0, portfolio_total_units: 0, contactability_score: Math.round(rnd() * 100), primary_owner_address: `${100 + o} Main St, Plano, TX`, markets_text: '', best_language: o % 3 === 0 ? 'Spanish' : 'English', max_ownership_years: 5 + Math.round(rnd() * 25), tax_delinquent_count: o % 6 === 0 ? 1 : 0, active_lien_count: o % 7 === 0 ? 1 : 0 })
  if (trust || o % 5 === 1) T.sub_owners.push({ sub_owner_id: `so_${o}`, master_owner_id: id, owner_name: trust ? `${last} Family Trust` : `${last} Holdings LLC`, owner_address_full: `${100 + o} Main St, Plano, TX` })
  for (let p = 0; p < 2; p += 1) {
    const pid = `pr_${o}_${p}`
    const full = `${pick(FIRST)} ${last}`
    T.prospects.push({ prospect_id: pid, master_owner_id: id, full_name: full, first_name: full.split(' ')[0], language_preference: o % 3 === 0 ? 'Spanish' : 'English', gender: pick(['Male', 'Female']), marital_status: pick(['Married', 'Single']), occupation_group: pick(['Retired', 'Professional', 'Skilled Trade']), est_household_income: pick(['$50-75K', '$75-100K', '$100-150K']), net_asset_value: pick(['$250-500K', '$500K-1M']), buying_power: pick(['Moderate', 'High']), education_model: pick(['College', 'High School']), timezone: 'America/Chicago', contact_window: pick(['Morning', 'Evening']), mob: String(1940 + Math.round(rnd() * 45)) + String(1 + Math.floor(rnd() * 12)).padStart(2, '0'), matching_flags: pick(['Likely Owner, Family', 'Likely Owner', 'Family, Resident', 'Likely Renting', 'Linked To Company']), person_flags_text: pick(['Primary Decision Maker; Property Owner', 'Senior; Property Owner', 'Elderly Parent; Senior']), sms_eligible: rnd() > 0.25, email_eligible: rnd() > 0.5, contact_score_final: Math.round(rnd() * 100), rank_position: p + 1, is_primary_prospect: p === 0, likely_owner: true })
    T.phones.push({ phone_id: `ph_${o}_${p}`, master_owner_id: id, canonical_e164: `+1555${String(o * 10 + p).padStart(7, '0')}`, phone: `(555) 01${String(o).padStart(2, '0')}-${p}000`, phone_type: pick(['Wireless', 'Landline']), primary_prospect_id: pid, activity_status: pick(['Active', 'Inactive']), contact_score_final: Math.round(rnd() * 100), sort_rank: p + 1, usage_12_months: pick(['High', 'Low']), usage_2_months: pick(['High', 'Low']), phone_owner: full })
  }
}
let n = 0
for (const o of T.master_owners) {
  const count = 1 + Math.floor(rnd() * 4)
  for (let i = 0; i < count; i += 1, n += 1) {
    const [market, city, state, county, lat, lng] = MARKETS[n % MARKETS.length]
    const value = 120000 + Math.round(rnd() * 600) * 1000
    const loan = rnd() > 0.45 ? Math.round(value * (0.2 + rnd() * 0.6)) : 0
    const flags = [...new Set([pick(FLAGS), ...(rnd() > 0.5 ? [pick(FLAGS)] : []), ...(loan === 0 && rnd() > 0.4 ? ['Free And Clear'] : [])])]
    const id = String(237800000 + n)
    const row = {
      property_id: id, master_owner_id: o.master_owner_id, property_address_full: `${100 + n * 7} ${pick(STREETS)}, ${city}, ${state}`, property_address_city: city, property_address_state: state, property_address_zip: `7${String(5000 + n).slice(0, 4)}`, property_address_county_name: county, market, latitude: lat + rnd() * 0.2, longitude: lng + rnd() * 0.2,
      property_type: pick(['Single Family', 'Single Family', 'Duplex', 'Triplex']), units_count: 1 + (n % 3 === 0 ? 1 : 0), total_bedrooms: 2 + Math.floor(rnd() * 3), total_baths: 1 + Math.floor(rnd() * 2), building_square_feet: 900 + Math.round(rnd() * 1600), year_built: 1940 + Math.round(rnd() * 70),
      estimated_value: value, equity_percent: loan ? Math.round(((value - loan) / value) * 100) : 100, equity_amount: value - loan, total_loan_balance: loan, property_flags_text: flags.join('; '), property_flags_json: flags, owner_name: o.display_name, owner_type_guess: o.owner_type_guess, is_corporate_owner: /LLC|TRUST/.test(o.owner_type_guess), out_of_state_owner: rnd() > 0.6, tax_delinquent: flags.includes('Tax Delinquent'), tax_delinquent_year: flags.includes('Tax Delinquent') ? 2024 : null, active_lien: rnd() > 0.8,
      building_condition: pick(['Average', 'Poor', 'Good', 'Unsound']), rehab_level: pick(['Light', 'Medium', 'Heavy']), sale_date: `${2000 + Math.floor(rnd() * 22)}-0${1 + Math.floor(rnd() * 8)}-15`, sale_price: Math.round(value * 0.55), last_sale_doc_type: pick(['Warranty Deed', 'Quitclaim Deed', 'Grant Deed']), ownership_years: 3 + Math.floor(rnd() * 20),
      rec_mortgage_count: loan ? 1 : 0, rec_mortgage_balance: loan || null, rec_first_rate: loan ? +(3 + rnd() * 4).toFixed(2) : null, rec_first_lender: loan ? pick(['Wells Fargo Bank', 'Rocket Mortgage', 'Private Lender LLC']) : null, rec_lien_count: rnd() > 0.7 ? 1 : 0, rec_has_probate: flags.includes('Probate'), rec_has_lis_pendens: rnd() > 0.85, rec_foreclosure_count: flags.includes('Preforeclosure') ? 1 : 0, rec_sale_count: 2, rec_last_sale_date: null, rec_last_sale_price: null, rec_years_owned: 3 + Math.floor(rnd() * 20),
    }
    row.rec_last_sale_date = row.sale_date
    row.rec_last_sale_price = row.sale_price
    T.properties.push(row)
    o.property_count += 1
    o.portfolio_total_value += value
    o.portfolio_total_units += row.units_count
    o.markets_text = market
    const persons = T.prospects.filter((p) => p.master_owner_id === o.master_owner_id)
    const eligible = rnd()
    for (const [k, person] of persons.entries()) {
      const phone = T.phones.find((ph) => ph.primary_prospect_id === person.prospect_id)
      T.campaign_target_graph.push({ graph_id: `g_${id}_${k}`, property_id: id, master_owner_id: o.master_owner_id, seller_person_key: person.prospect_id, seller_full_name: person.full_name, canonical_e164: eligible > 0.2 ? phone?.canonical_e164 : null, timezone: 'America/Chicago', identity_alignment: eligible > 0.15 ? 'verified' : 'unknown', queue_eligible: eligible > 0.3, queue_block_reason: eligible > 0.3 ? null : pick(['missing_phone', 'non_sms_capable', 'pending_prior_touch', 'suppressed']), best_phone_score: Math.round(rnd() * 100), phone_type: phone?.phone_type, phone_activity_status: phone?.activity_status, last_outbound_at: rnd() > 0.5 ? `2026-09-${10 + Math.floor(rnd() * 18)}T15:00:00Z` : null, last_inbound_at: null, matching_flags_text: person.matching_flags })
    }
    if (n % 4 === 0) T.inbox_thread_state.push({ thread_key: `t_${id}`, property_id: id, master_owner_id: o.master_owner_id, prospect_id: persons[0]?.prospect_id, latest_message_at: `2026-10-0${1 + (n % 7)}T14:20:00Z`, latest_direction: n % 8 === 0 ? 'inbound' : 'outbound', latest_message_body: n % 8 === 0 ? 'Maybe. What would you offer for it as-is?' : `Hi ${persons[0]?.first_name}, this is Alex — do you still own ${row.property_address_full.split(',')[0]}?`, last_inbound_at: n % 8 === 0 ? `2026-10-0${1 + (n % 7)}T14:20:00Z` : null, last_outbound_at: '2026-09-30T15:00:00Z', seller_stage: n % 8 === 0 ? 'S2' : 'S1', stage: 'ownership_check', status: 'open', conversation_status: n % 8 === 0 ? 'needs_reply' : 'waiting', inbox_bucket: 'new', is_hot_lead: n % 16 === 0, last_intent: n % 8 === 0 ? 'price_curious' : null })
    if (n % 12 === 0) T.acquisition_opportunities.push({ id: `opp_${n}`, primary_property_id: id, acquisition_stage: 'offer_sent', opportunity_status: 'active', universal_status: 'active' })
    if (n % 5 === 0) T.campaign_targets.push({ property_id: id, campaign_id: 'cmp_dallas', target_status: 'ready', block_reason: null, created_at: '2026-09-20T00:00:00Z' })
    if (n % 9 === 0) T.property_acquisition_scores.push({ property_id: id, aos_score: 62, decision_tier: 'B', best_strategy: 'cash' })
  }
}
// contact discovery: owner-less properties whose graph rows carry no phone,
// with prospects linked to the property that DO carry phones
for (const p of T.properties.slice(40, 46)) {
  p.master_owner_id = null
  for (const g of T.campaign_target_graph.filter((r) => r.property_id === p.property_id)) { g.canonical_e164 = null; g.queue_eligible = false; g.queue_block_reason = 'missing_phone' }
  T.prospects.push({ prospect_id: `lp_${p.property_id}`, master_owner_id: null, individual_key: `ik_${p.property_id}`, full_name: `${pick(FIRST)} ${pick(LAST)}`, linked_property_ids_json: [p.property_id], phones_json: [{ canonical_e164: `+1555${p.property_id.slice(-7)}`, phone_type: 'W', phone_score: 74, usage_2_months: 'Heavy Usage' }], matching_flags: 'Likely Owner' })
}
// a large portfolio for the graph performance pass (owner with 90 properties)
{
  const big = { master_owner_id: 'mo_big', display_name: 'Lone Star Rentals LLC', owner_type_guess: 'LLC/CORP | ABSENTEE', priority_tier: 'A', property_count: 90, portfolio_total_value: 0, portfolio_total_units: 0, markets_text: 'Dallas, TX' }
  T.master_owners.push(big)
  for (let i = 0; i < 90; i += 1) {
    const id = String(239000000 + i)
    T.properties.push({ ...T.properties[i % 40], property_id: id, master_owner_id: 'mo_big', property_address_full: `${2000 + i} Commerce St, Dallas, TX`, owner_name: big.display_name, estimated_value: 150000 + i * 5000 })
  }
}
T.campaigns.push(
  { id: 'cmp_dallas', name: 'Dallas S1 · ownership check', status: 'built', metadata: {}, updated_at: '2026-09-20T00:00:00Z' },
  { id: 'cmp_draft_probate', name: 'Probate + vacant · stacked', status: 'draft', metadata: { source: 'entity_graph', target_filters: { properties: [{ field_key: 'properties.property_id', operator: 'is_any_of', value: T.properties.slice(0, 6).map((p) => p.property_id) }] }, entity_graph_stack: [{ at: '2026-10-07' }] }, updated_at: '2026-10-07T00:00:00Z' },
  { id: 'cmp_draft_market', name: 'Atlanta market draft', status: 'draft', metadata: { target_filters: { properties: [{ field_key: 'properties.market', operator: 'is_any_of', value: ['Atlanta, GA'] }] } }, updated_at: '2026-10-06T00:00:00Z' },
)
T.v_entity_graph_properties = T.properties

/* ── a minimal supabase-js stand-in over T ─────────────────────────────── */
const likeRe = (p) => new RegExp(`^${String(p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*')}$`, 'i')
const unq = (v) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v)
function splitTop(expr) {
  const out = []; let depth = 0; let q = false; let cur = ''
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i]
    if (q) { cur += ch; if (ch === '\\') { cur += expr[++i]; continue } if (ch === '"') q = false; continue }
    if (ch === '"') { q = true; cur += ch; continue }
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}
function orPred(expr) {
  const parts = splitTop(expr).map((part) => {
    const g = /^(and|or)\((.*)\)$/.exec(part)
    if (g) { const inner = orPred(g[2]); const preds = splitTop(g[2]).map((x) => orPred(x)); return g[1] === 'and' ? (r) => preds.every((p) => p(r)) : inner }
    const m = /^([a-z_0-9]+)\.(not\.)?(eq|neq|gt|gte|lt|lte|ilike|like|is|in)\.(.*)$/.exec(part)
    if (!m) return () => true
    const [, col, not, op, raw] = m
    const v = unq(raw)
    const base = (r) => {
      const x = r[col]
      if (op === 'is') return v === 'null' ? x == null : String(x) === v
      if (op === 'ilike' || op === 'like') return likeRe(v).test(String(x ?? ''))
      if (op === 'in') return raw.replace(/^\(|\)$/g, '').split(',').includes(String(x))
      if (op === 'eq') return String(x) === v
      if (op === 'neq') return String(x) !== v
      const a = Number(x); const b = Number(v)
      return x != null && (op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b)
    }
    return not ? (r) => !base(r) : base
  })
  return (r) => parts.some((p) => p(r))
}
function fake() {
  const writes = []
  const from = (table) => {
    const st = { preds: [], order: [], from: 0, to: null, limit: null, count: false, head: false, single: false, write: null }
    const cmp = (c, f) => { st.preds.push((r) => f(r[c])); return api }
    const api = {
      select(_c, opts = {}) { if (opts.count) st.count = true; if (opts.head) st.head = true; return api },
      eq: (c, v) => cmp(c, (x) => (typeof v === 'boolean' ? x === v : String(x) === String(v))),
      neq: (c, v) => cmp(c, (x) => String(x) !== String(v)),
      gt: (c, v) => cmp(c, (x) => x != null && (typeof v === 'number' ? Number(x) > v : String(x) > String(v))),
      gte: (c, v) => cmp(c, (x) => x != null && (typeof v === 'number' ? Number(x) >= v : String(x) >= String(v))),
      lt: (c, v) => cmp(c, (x) => x != null && (typeof v === 'number' ? Number(x) < v : String(x) < String(v))),
      lte: (c, v) => cmp(c, (x) => x != null && (typeof v === 'number' ? Number(x) <= v : String(x) <= String(v))),
      in: (c, vs) => { const s = new Set((vs || []).map(String)); return cmp(c, (x) => s.has(String(x))) },
      is: (c, v) => cmp(c, (x) => (v === null ? x == null : x === v)),
      ilike: (c, p) => cmp(c, (x) => likeRe(p).test(String(x ?? ''))),
      like: (c, p) => cmp(c, (x) => likeRe(p).test(String(x ?? ''))),
      not: (c, op, v) => cmp(c, (x) => (op === 'is' ? (v === null ? x != null : x !== v) : op === 'like' || op === 'ilike' ? !likeRe(v).test(String(x ?? '')) : op === 'eq' ? String(x) !== String(v) : true)),
      or: (expr) => { st.preds.push(orPred(String(expr))); return api },
      overlaps: (c, vs) => cmp(c, (x) => Array.isArray(x) && x.some((y) => vs.includes(y))),
      contains: (c, vs) => { const want = typeof vs === 'string' ? JSON.parse(vs) : vs; return cmp(c, (x) => Array.isArray(x) && want.every((y) => x.includes(y))) },
      order: (c, o = {}) => { st.order.push([c, o.ascending !== false]); return api },
      range: (a, b) => { st.from = a; st.to = b; return api },
      limit: (k) => { st.limit = k; return api },
      maybeSingle: () => { st.single = true; return api },
      single: () => { st.single = true; return api },
      textSearch: () => api,
      update: (v) => { st.write = { update: v }; return api },
      insert: (v) => { st.write = { insert: v }; writes.push({ table, insert: v }); return api },
      delete: () => { st.write = { delete: true }; return api },
      then(res, rej) {
        if (st.write) { writes.push({ table, ...st.write }); return Promise.resolve({ data: null, error: { message: 'qa harness: writes are refused' } }).then(res, rej) }
        let rows = (T[table] || []).filter((r) => st.preds.every((p) => p(r)))
        const total = rows.length
        for (const [c, asc] of [...st.order].reverse()) rows = [...rows].sort((a, b) => { const x = a[c]; const y = b[c]; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * (asc ? 1 : -1) })
        if (st.to !== null) rows = rows.slice(st.from, st.to + 1)
        if (st.limit !== null) rows = rows.slice(0, st.limit)
        const data = st.head ? null : st.single ? (rows[0] ?? null) : rows
        return Promise.resolve({ data, error: null, count: st.count ? total : null }).then(res, rej)
      },
    }
    return api
  }
  return { from, rpc: async () => ({ data: [], error: null }), writes }
}
const sb = fake()
const groupBy = async ({ source, column, applyFilters }) => {
  const { data } = await applyFilters(sb.from(source).select('*'))
  const m = new Map()
  for (const r of data || []) { const v = r[column] == null || r[column] === '' ? null : String(r[column]); m.set(v, (m.get(v) || 0) + 1) }
  return [...m.entries()].map(([value, count]) => ({ value, count }))
}
const groupTokens = async ({ source, column, split, applyFilters }) => {
  const { data } = await applyFilters(sb.from(source).select('*'))
  const m = new Map()
  for (const r of data || []) {
    const toks = split ? String(r[column] ?? '').split(new RegExp(`\\s*${split.trim()}\\s*`)) : (Array.isArray(r[column]) ? r[column] : [])
    for (const t of toks.map((x) => x.trim()).filter(Boolean)) m.set(t, (m.get(t) || 0) + 1)
  }
  return { tokens: [...m.entries()].map(([value, count]) => ({ value, count })), total: (data || []).length }
}
const compDeps = { supabase: sb, facetsAvailable: () => true, groupedFacetCounts: groupBy, groupedTokenCounts: groupTokens }

/* ── the API, answered in process ──────────────────────────────────────── */
const violations = []
const streetView = { requests: 0, byScene: {} }
let scene = ''
async function api(u, req) {
  const p = u.pathname.replace('/api/cockpit/entity-graph', '')
  const params = Object.fromEntries(u.searchParams.entries())
  if (p === '/counts') return { ok: true, counts: { properties: T.properties.length, master_owners: T.master_owners.length, people: T.prospects.length, organizations: T.sub_owners.length, contact_methods: T.phones.length, buyers: 0, markets: 4, zips: 40 } }
  if (p === '/kpis') return { ok: true, kpis: { properties: T.properties.length, linkedProperties: T.properties.length, owners: T.master_owners.length, portfolioOwners: T.master_owners.filter((o) => o.property_count > 1).length, entities: T.sub_owners.length, ownersWithPhone: T.master_owners.length - 3 } }
  if (p === '/browse') return { ok: true, ...(await browseEntityGraph(params, { supabase: sb, propertySortIndexes: async () => new Set() })) }
  if (p === '/filter-catalog') { const c = getEntityGraphFilterCatalog(params.tab || 'properties'); return c.source ? { ok: true, ...c } : { ok: false, error: 'tab_does_not_support_field_filters' } }
  if (p === '/composition') return params.catalog ? { ok: true, ...getCompositionCatalog(params.tab) } : { ok: true, composition: await buildEntityGraphComposition(params, compDeps) }
  if (p === '/columns') return { ok: true, ...(await getEntityGraphColumnEnrichment(params, { supabase: sb })) }
  if (p === '/outreach-state') return { ok: true, ...(await getEntityGraphOutreachState(params, { supabase: sb })) }
  const net = /^\/network\/(property|owner|person)\/(.+)$/.exec(p)
  if (net) { const data = await getEntityNetwork(net[1], decodeURIComponent(net[2]), { supabase: sb }); return data ? { ok: true, data } : { ok: false, error: 'entity_not_found' } }
  if (p === '/campaign-stack' && req.method() === 'GET') return { ok: true, drafts: await listStackableDrafts({ supabase: sb }) }
  if (p === '/campaign-stack' && req.method() === 'POST') {
    const body = JSON.parse(req.postData() || '{}')
    if (body.dry_run !== true) { violations.push({ scene, what: 'non-dry-run campaign-stack POST refused', body }); return { ok: false, error: 'qa_harness_refuses_writes', message: 'QA harness: only dry runs are answered.' } }
    try { return await stackEntityGraphCohort(body, { supabase: sb }) } catch (e) { return { ok: false, error: e instanceof StackRefusal ? e.code : 'error', message: e.message } }
  }
  return null
}
const PLACEHOLDER = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9cc3e6"/><stop offset="0.55" stop-color="#dfe9f2"/><stop offset="0.56" stop-color="#7a8b6f"/><stop offset="1" stop-color="#5d6b52"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><rect x="210" y="130" width="220" height="130" fill="#c9b79c"/><polygon points="190,135 320,60 450,135" fill="#6d4c3d"/><rect x="300" y="190" width="40" height="70" fill="#4a3a30"/><text x="16" y="342" font-family="sans-serif" font-size="13" fill="#fff">Street View placeholder (QA harness · no Google request)</text></svg>`)

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
const server = http.createServer(async (rq, res) => {
  const pth = decodeURIComponent(new URL(rq.url, 'http://x').pathname)
  let file = path.join(DIST, pth)
  try { if (!(await fs.stat(file)).isFile()) throw 0 } catch { file = path.join(DIST, 'index.html') }
  res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
  res.end(await fs.readFile(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

async function guard(page) {
  await page.route('**/*', async (r) => {
    const req = r.request()
    const u = new URL(req.url())
    if (u.hostname.includes('googleapis') && u.pathname.includes('streetview')) {
      streetView.requests += 1
      streetView.byScene[scene] = (streetView.byScene[scene] || 0) + 1
      return r.fulfill({ status: 200, contentType: 'image/svg+xml', body: PLACEHOLDER })
    }
    if (u.pathname.startsWith('/api/cockpit/entity-graph/')) {
      try {
        const body = await api(u, req)
        if (body) return r.fulfill({ status: body.ok === false ? 422 : 200, contentType: 'application/json', body: JSON.stringify(body) })
      } catch (e) { return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'harness', message: String(e?.message || e).slice(0, 200) }) }) }
      return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'not_in_harness' }) })
    }
    const isApi = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
    if (isApi || u.hostname.includes('googleapis') || u.hostname.includes('basemaps') || u.hostname.includes('gstatic')) return r.abort()
    return r.continue()
  })
}

const ff = (x) => `ff=${encodeURIComponent(JSON.stringify(x))}`
const PROP = T.properties.find((p) => T.inbox_thread_state.some((t) => t.property_id === p.property_id)) ?? T.properties[0]
const SCENES = [
  ['01-properties-rail-open', `/entity-graph?${ff([{ field_key: 'properties.flags', operator: 'is_any_of', value: ['Vacant Home'] }])}`, 'facet'],
  ['02-rail-collapsed', `/entity-graph?${ff([{ field_key: 'properties.flags', operator: 'is_any_of', value: ['Vacant Home'] }])}`, 'collapse'],
  ['03-people-facets', `/entity-graph?egs=people&${ff([{ field_key: 'prospects.age_years', operator: 'gte', value: 65 }])}`, 'people'],
  ['04-add-to-campaign-preview', `/entity-graph?${ff([{ field_key: 'properties.tax_delinquent', operator: 'is_true' }])}`, 'stack'],
  ['05-inspector-streetview', `/entity-graph/property/${PROP.property_id}?${ff([{ field_key: 'properties.flags', operator: 'is_any_of', value: ['Vacant Home', 'Probate'] }])}`, 'inspector'],
  ['06-graph-hover-card', `/entity-graph/property/${PROP.property_id}?egv=graph`, 'hover'],
  ['07-graph-fullscreen', `/entity-graph/property/${PROP.property_id}?egv=graph&egfs=1`, 'hover'],
  ['10-contact-discovery', `/entity-graph/property/${T.properties[41].property_id}`, 'inspector'],
  ['09-perf', `/entity-graph`, 'perf'],
  ['08-pane-50', `/entity-graph?${ff([{ field_key: 'properties.flags', operator: 'is_any_of', value: ['Vacant Home'] }])}`, 'split'],
].filter(([nm]) => !ONLY || ONLY.split(',').some((o) => nm.startsWith(o)))

const browser = await chromium.launch()
const report = []
for (const theme of THEMES) for (const [W, H] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: W >= 5120 ? 0.5 : 1, serviceWorkers: 'block' })
  await ctx.addInitScript((t) => {
    try {
      localStorage.removeItem('nexus.desktop.split')
      sessionStorage.removeItem('lc.workspace.session.v1')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const s = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...s, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  await guard(page)
  const label = `${theme}-${W}x${H}`
  for (const [name, route, mode] of SCENES) {
    scene = `${label}-${name}`
    const row = { label, name }
    try {
      await page.evaluate(() => { try { localStorage.removeItem(Object.keys(localStorage).find((k) => k.startsWith('nexus.entityGraph.desk.rail.v1')) || '_') } catch { /* */ } sessionStorage.clear() }).catch(() => {})
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForSelector('.egdk', { timeout: 60_000 })
      await page.waitForTimeout(1800)
      if (mode === 'facet') {
        await page.locator('.egdk-rgroup__head', { hasText: 'Location' }).first().click().catch(() => {})
        await page.locator('.egdk-facet__head', { hasText: /^Market/ }).first().click().catch(() => {})
        await page.waitForTimeout(900)
      }
      if (mode === 'collapse') { await page.locator('.egdk-rail__collapse').first().click(); await page.waitForTimeout(500) }
      if (mode === 'people') {
        await page.locator('.egdk-rgroup__head', { hasText: 'Owner matching' }).first().click().catch(() => {})
        await page.locator('.egdk-facet__head', { hasText: 'Matching tags' }).first().click().catch(() => {})
        await page.locator('.egdk-rgroup__head', { hasText: 'Demographics' }).first().click().catch(() => {})
        await page.locator('.egdk-facet__head', { hasText: 'Language' }).first().click().catch(() => {})
        await page.waitForTimeout(1000)
        row.peopleFacetBuckets = await page.locator('.egdk-facet.is-open .egdk-bucket').count()
      }
      if (mode === 'stack') {
        await page.locator('.egdk-bar__tools button', { hasText: 'Add to campaign' }).first().click()
        await page.waitForSelector('.egdk-stack', { timeout: 10_000 })
        await page.locator('.egdk-stack__dest', { hasText: 'Probate + vacant' }).first().click().catch(() => {})
        await page.waitForSelector('.egdk-stack__figs', { timeout: 15_000 }).catch(() => {})
        await page.waitForTimeout(600)
        row.stackFigures = await page.locator('.egdk-stack__fig').evaluateAll((els) => els.map((e) => e.innerText.replace(/\n/g, ' ')))
      }
      if (mode === 'inspector') {
        await page.waitForSelector('.egdk-insp__visual img, .egdk-insp__visual', { timeout: 15_000 }).catch(() => {})
        await page.waitForTimeout(1500)
        row.streetViewThisScene = streetView.byScene[scene] || 0
      }
      if (mode === 'hover') {
        await page.waitForSelector('.egdk-node.is-property', { timeout: 15_000 })
        const node = page.locator('.egdk-graphpane .egdk-node.is-property.is-anchor, .egdk-graphpane .egdk-node.is-property').first()
        const box = await node.boundingBox()
        if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.waitForTimeout(700) }
        row.hoverCard = await page.locator('.egdk-gcard').innerText().catch(() => null)
        row.streetViewThisScene = streetView.byScene[scene] || 0
      }
      if (mode === 'perf') {
        // filter latency: click a quick filter → the summary changes (client + in-process API)
        const before = await page.locator('.egdk-head__summary').innerText()
        const t0 = Date.now()
        await page.locator('.egdk-preset', { hasText: 'Tax delinquent' }).first().click()
        await page.waitForFunction((b) => document.querySelector('.egdk-head__summary')?.textContent !== b && !/Reading/.test(document.querySelector('.egdk-head__summary')?.textContent || ''), before, { timeout: 15_000 })
        row.filterLatencyMs = Date.now() - t0
        await page.locator('.egdk-preset', { hasText: 'Tax delinquent' }).first().click()
        await page.waitForTimeout(800)
        // grid scroll: frames painted during a 1.2 s programmatic scroll of the whole grid
        const reqDuring = []
        const onReq = (r) => { if (r.url().includes('/api/')) reqDuring.push(new URL(r.url()).pathname.split('/').pop()) }
        page.on('request', onReq)
        await page.evaluate(() => { window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)) }).observe({ type: 'longtask', buffered: false }) } catch { /* */ } })
        const scrollRun = () => page.evaluate(async () => {
          const el = document.querySelector('.egdk .lc-grid__scroller')
          if (!el) return null
          let frames = 0; let worst = 0; let last = performance.now()
          const start = last
          await new Promise((done) => {
            const tick = (t) => { frames += 1; worst = Math.max(worst, t - last); last = t; el.scrollTop = ((t - start) / 1200) * (el.scrollHeight - el.clientHeight); el.dispatchEvent(new Event('scroll')); if (t - start < 1200) requestAnimationFrame(tick); else done() }
            requestAnimationFrame(tick)
          })
          return { frames, fps: Math.round(frames / 1.2), worstFrameMs: Math.round(worst), rowsMounted: el.querySelectorAll('.lc-grid__row').length, longTasks: window.__lt.slice(0, 20) }
        })
        // calibration: frames in an IDLE 1.2 s on this page (no scroll) — the machine's ceiling
        row.idleFps = await page.evaluate(async () => { let f = 0; const s0 = performance.now(); await new Promise((d) => { const t = (n) => { f += 1; if (n - s0 < 1200) requestAnimationFrame(t); else d() }; requestAnimationFrame(t) }); return Math.round(f / 1.2) })
        row.gridScroll = await scrollRun()
        // the same scroll with glass blur off: separates JS/render cost from
        // software rasterisation of backdrop-filter (headless has no GPU)
        await page.addStyleTag({ content: '* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }' })
        await page.evaluate(() => { const el = document.querySelector('.egdk .lc-grid__scroller'); if (el) el.scrollTop = 0 })
        await page.waitForTimeout(300)
        row.gridScrollNoBlur = await scrollRun()
        // JS cost of one scroll update (React render of the grid), measured directly
        row.scrollHandlerMs = await page.evaluate(async () => {
          const el = document.querySelector('.egdk .lc-grid__scroller'); if (!el) return null
          const t = performance.now(); el.scrollTop = 200; el.dispatchEvent(new Event('scroll'))
          await new Promise((r) => setTimeout(r, 0)); return Math.round(performance.now() - t)
        })
        page.off('request', onReq)
        row.gridScroll.requestsDuringScroll = reqDuring
        // large network: open the 90-property owner's graph, time to first paint + hover
        const t1 = Date.now()
        await page.goto(`${BASE}/entity-graph/owner/mo_big?egv=graph&egfs=1`, { waitUntil: 'domcontentloaded' })
        await page.waitForSelector('.egdk-graphpane .egdk-node', { timeout: 20_000 })
        row.bigGraphMs = Date.now() - t1
        row.bigGraphNodes = await page.locator('.egdk-graphpane .egdk-node').count()
        const nodes = page.locator('.egdk-graphpane .egdk-node.is-property')
        const t2 = Date.now()
        for (let i = 0; i < Math.min(8, await nodes.count()); i += 1) { const b = await nodes.nth(i).boundingBox(); if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2) }
        await page.waitForSelector('.egdk-gcard', { timeout: 5000 }).catch(() => {})
        row.hoverSweepMs = Date.now() - t2
        row.streetViewAfterHoverSweep = streetView.byScene[scene] || 0
      }
      if (mode === 'split') {
        // ⌥-click a sidebar app = "Open beside" (the shell's own split gesture)
        const item = page.locator('.cr-row', { hasText: /^Map$/ }).first()
        if (await item.count()) {
          await item.click({ modifiers: ['Alt'] })
          await page.waitForTimeout(3500)
          await page.mouse.move(Math.round(W * 0.35), Math.round(H * 0.6))
          await page.waitForTimeout(500)
        } else row.split = 'no sidebar item'
        row.panes = await page.evaluate(() => [...document.querySelectorAll('.dsk-pane')].map((p) => Math.round(p.getBoundingClientRect().width)))
      }
      row.overflowX = await page.evaluate(() => { const el = document.querySelector('.egdk'); return el ? el.scrollWidth > el.clientWidth + 1 : null })
      const file = path.join(OUT, `${label}-${name}.png`)
      await page.screenshot({ path: file })
      row.file = file
    } catch (e) {
      row.failed = String(e.message).slice(0, 200)
      await page.screenshot({ path: path.join(OUT, `${label}-${name}-failed.png`) }).catch(() => {})
    }
    report.push(row)
    console.log(JSON.stringify({ ...row, hoverCard: row.hoverCard ? row.hoverCard.slice(0, 120) : undefined }))
  }
  if (errors.length) { console.log('page errors:', label, errors.slice(0, 6)); report.push({ label, pageErrors: errors.slice(0, 12) }) }
  await ctx.close()
}
await browser.close()
server.close()
const summary = { streetView, violations, writesAttempted: sb.writes }
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ summary, report }, null, 1))
console.log('SUMMARY', JSON.stringify({ streetViewTotal: streetView.requests, byScene: streetView.byScene, violations: violations.length, writesAttempted: sb.writes.length }))
