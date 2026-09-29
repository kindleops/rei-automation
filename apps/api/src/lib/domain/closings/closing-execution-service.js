/**
 * CLOSING EXECUTION SERVICE — loads a bounded set of canonical records and
 * hands each closing to the pure derivation (closing-execution-model.js).
 *
 * Portfolio: every live case + cases closed or cancelled in the last
 * RECENT_DAYS. Child records are fetched in one batched query per table for
 * the whole set — never per closing — and a failing child source degrades that
 * facet (named in `degraded`) instead of failing the desk.
 *
 * Detail: one case + its activity events, paginated. Activity (operational
 * chatter) is kept apart from the canonical timeline the model builds.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { deriveClosingExecution, summarizePortfolio } from './closing-execution-model.js'

export const RECENT_DAYS = 120
const CASE_LIMIT = 300
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CASE_COLUMNS = [
  'closing_case_id', 'opportunity_id', 'property_id', 'property_address', 'master_owner_id', 'prospect_id', 'thread_key',
  'buyer_id', 'universal_stage', 'closing_status', 'contract_status', 'title_status', 'escrow_status', 'funding_status',
  'docusign_status', 'docusign_envelope_id', 'envelope_sent_at', 'signer_name', 'signer_email', 'accepted_at',
  'contract_signed_date', 'emd_due_date', 'inspection_deadline', 'title_opened_date', 'title_commitment_date', 'cure_deadline',
  'scheduled_closing_date', 'signing_date', 'funding_date', 'recording_date',
  'seller_contract_price', 'earnest_money', 'buyer_price', 'assignment_fee', 'closing_costs', 'title_fees', 'expected_gross_revenue',
  'escrow_file_number', 'title_company_key', 'title_company_name', 'title_company_email', 'title_route_market', 'title_route_status',
  'title_company_selected_at', 'title_intro_sent_at', 'readiness', 'provenance', 'last_activity_at', 'created_at', 'updated_at',
].join(',')

const clean = (v) => String(v ?? '').trim()

async function childRows(db, table, column, ids, degraded, columns = '*') {
  if (!ids.length) return []
  try {
    const { data, error } = await db.from(table).select(columns).in(column, ids).limit(2000)
    if (error) throw error
    return data || []
  } catch (err) {
    degraded.push({ source: table, error: String(err?.message || err) })
    return []
  }
}

const groupBy = (rows, key) => {
  const map = new Map()
  for (const r of rows) {
    const k = clean(r[key])
    if (!k) continue
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(r)
  }
  return map
}

async function hydrate(db, cases, { now }) {
  const degraded = []
  const caseIds = cases.map((c) => c.closing_case_id).filter(Boolean)
  const oppIds = cases.map((c) => c.opportunity_id).filter((id) => UUID_RE.test(String(id || '')))
  const [offers, agreements, receipts, settlements, milestones, opps] = await Promise.all([
    childRows(db, 'buyer_offers', 'opportunity_id', oppIds, degraded),
    childRows(db, 'buyer_agreements', 'opportunity_id', oppIds, degraded),
    childRows(db, 'emd_receipts', 'closing_case_id', caseIds, degraded),
    childRows(db, 'settlement_records', 'closing_case_id', caseIds, degraded),
    childRows(db, 'closing_milestones', 'closing_case_id', caseIds, degraded),
    childRows(db, 'acquisition_opportunities', 'id', oppIds, degraded, 'id, acquisition_stage, opportunity_status, primary_thread_key, seller_display_name, market'),
  ])
  const byOpp = { offers: groupBy(offers, 'opportunity_id'), agreements: groupBy(agreements, 'opportunity_id'), opps: groupBy(opps, 'id') }
  const byCase = { receipts: groupBy(receipts, 'closing_case_id'), settlements: groupBy(settlements, 'closing_case_id'), milestones: groupBy(milestones, 'closing_case_id') }
  const items = cases.map((c) => deriveClosingExecution({
    closingCase: c,
    offers: byOpp.offers.get(clean(c.opportunity_id)) || [],
    agreements: byOpp.agreements.get(clean(c.opportunity_id)) || [],
    emdReceipts: byCase.receipts.get(clean(c.closing_case_id)) || [],
    settlements: byCase.settlements.get(clean(c.closing_case_id)) || [],
    milestones: byCase.milestones.get(clean(c.closing_case_id)) || [],
    opportunity: (byOpp.opps.get(clean(c.opportunity_id)) || [])[0] || null,
    now,
  }))
  return { items, degraded }
}

/** Sort keys the operator can choose — each a plain, stated ordering. */
const SORTS = {
  next_closing: (a, b) => (Date.parse(a.closing?.at || '9999') - Date.parse(b.closing?.at || '9999')),
  most_urgent: (a, b) => urgency(b) - urgency(a) || SORTS.next_closing(a, b),
  recently_updated: (a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0),
  recently_closed: (a, b) => Date.parse(b.money?.actual?.legs?.[0]?.closedAt || b.updatedAt || 0) - Date.parse(a.money?.actual?.legs?.[0]?.closedAt || a.updatedAt || 0),
}
/** Urgency = blocked > needs you > external > rest, then fewer days to close. */
function urgency(x) {
  const tone = { blocked: 4, attention: 3, external: 2, ready: 1, active: 1 }[x.state.tone] || 0
  return tone * 100 - Math.min(99, Math.max(0, x.closing?.daysOut ?? 99))
}

export async function getClosingPortfolio({ sort = 'most_urgent', now = Date.now() } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const since = new Date(now - RECENT_DAYS * 86_400_000).toISOString()
  const { data, error } = await db.from('closing_cases').select(CASE_COLUMNS)
    .or(`updated_at.gte.${since},closing_status.neq.closed`)
    .order('updated_at', { ascending: false })
    .limit(CASE_LIMIT)
  if (error) throw error
  const { items, degraded } = await hydrate(db, data || [], { now })
  // A long-dead cancellation is history, not work; recent ones stay visible under Cancelled.
  const visible = items.filter((x) => !x.terminal || Date.parse(x.updatedAt || 0) >= now - RECENT_DAYS * 86_400_000)
  visible.sort(SORTS[sort] || SORTS.most_urgent)
  return { items: visible, summary: summarizePortfolio(visible, { now }), degraded, sort: SORTS[sort] ? sort : 'most_urgent', recentDays: RECENT_DAYS, generatedAt: new Date(now).toISOString() }
}

export async function getClosingExecution(id, { now = Date.now(), activityLimit = 30, activityBefore = null } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const key = clean(id)
  if (!key) return null
  // uuid → opportunity_id; anything else → closing_case_id (text). Never an .or()
  // across both: a text value against the uuid column fails the whole query.
  let q = db.from('closing_cases').select(CASE_COLUMNS)
  q = UUID_RE.test(key) ? q.eq('opportunity_id', key) : q.eq('closing_case_id', key)
  const { data, error } = await q.limit(1)
  if (error) throw error
  const row = (data || [])[0]
  if (!row) return null
  const { items, degraded } = await hydrate(db, [row], { now })
  let activity = []
  let activityMore = false
  try {
    let aq = db.from('closing_activity_events').select('id, event_type, actor, source, detail, created_at').eq('closing_case_id', row.closing_case_id).order('created_at', { ascending: false }).limit(activityLimit + 1)
    if (activityBefore) aq = aq.lt('created_at', activityBefore)
    const { data: rows, error: aerr } = await aq
    if (aerr) throw aerr
    activityMore = (rows || []).length > activityLimit
    activity = (rows || []).slice(0, activityLimit).map((r) => ({ id: r.id, type: r.event_type, actor: r.actor || null, source: r.source || null, detail: r.detail || {}, at: r.created_at }))
  } catch (err) {
    degraded.push({ source: 'closing_activity_events', error: String(err?.message || err) })
  }
  return { closing: items[0], activity, activityMore, degraded, generatedAt: new Date(now).toISOString() }
}
