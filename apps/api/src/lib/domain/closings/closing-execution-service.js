/**
 * CLOSING EXECUTION SERVICE — loads a bounded set of canonical records and
 * hands each closing to the pure derivation (closing-execution-model.js).
 *
 * Portfolio: every live case + cases closed or cancelled in the last
 * RECENT_DAYS. Child records are fetched in one batched query per table for
 * the whole set — never per closing — and a failing child source degrades that
 * facet (named in `degraded`) instead of failing the desk. `view=summary`
 * returns the portfolio row projection (summarizeClosing) the desktop
 * navigation needs; the room loads the full derivation by id.
 *
 * Detail: one case + its activity events, paginated. Activity (operational
 * chatter) is kept apart from the canonical timeline the model builds.
 * Documents: stored email attachments for the case load lazily (their own
 * route), with short-lived signed preview links from Email Command's module.
 *
 * Runtime: the automation kill switch, worker heartbeat and email sending
 * switch are read once per request so the desk can say whether "system
 * handling" is actually moving anything.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { deriveClosingExecution, summarizeClosing, summarizePortfolio } from './closing-execution-model.js'
import { mergeCadence } from './closing-automation-plan.js'

export const RECENT_DAYS = 120
const CASE_LIMIT = 300
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CASE_COLUMNS = [
  'id', 'closing_case_id', 'opportunity_id', 'property_id', 'property_address', 'master_owner_id', 'prospect_id', 'thread_key',
  'buyer_id', 'universal_stage', 'closing_status', 'contract_status', 'title_status', 'escrow_status', 'funding_status',
  'docusign_status', 'docusign_envelope_id', 'envelope_sent_at', 'signer_name', 'signer_email', 'accepted_at', 'effective_date',
  'contract_signed_date', 'emd_due_date', 'inspection_deadline', 'title_opened_date', 'title_commitment_date', 'cure_deadline',
  'scheduled_closing_date', 'signing_date', 'funding_date', 'recording_date',
  'seller_contract_price', 'earnest_money', 'buyer_price', 'assignment_fee', 'closing_costs', 'title_fees', 'expected_gross_revenue',
  'escrow_file_number', 'title_company_key', 'title_company_name', 'title_company_email', 'title_route_market', 'title_route_status',
  'title_company_selected_at', 'title_intro_sent_at', 'readiness', 'provenance', 'last_activity_at', 'created_at', 'updated_at',
  // closing authority (20260929090000_closing_authority.sql)
  'closing_tz', 'closing_date_confirmed_at', 'closing_date_source', 'title_acknowledged_at', 'title_acknowledged_source',
  'title_commitment_received_at', 'title_commitment_evidence', 'clear_to_close_at', 'clear_to_close_source', 'clear_to_close_evidence',
  'clear_to_close_actor', 'closed_at', 'closed_by', 'terminal_outcome', 'terminal_reason', 'terminal_at', 'terminal_actor',
  'automation_paused_at', 'automation_paused_reason', 'automation_paused_by', 'automation_state',
].join(',')

const REQUEST_COLUMNS = 'id, request_key, closing_case_id, action, category, sequence, status, status_reason, recipient_role, requested_at, due_at, claimed_at, sent_at, delivery_status, email_queue_id, updated_at'
const THREAD_COLUMNS = 'id, closing_case_id, thread_key, category, counterparty_email, counterparty_name, last_message_at, last_message_direction, last_message_preview, last_inbound_at, last_outbound_at, needs_operator, needs_code, needs_reason, automation_state, taken_over_by, taken_over_at'
const PROPERTY_COLUMNS = 'property_id, property_address_full, property_address_city, property_address_state, property_address_zip, market'
// The activity the model needs: the deposit record, date history and the
// automation's pause / escalation trail. The full feed stays paginated in the room.
const MODEL_ACTIVITY = ['contract_emd_deposited', 'closing_date_changed', 'title_commitment_date_set', 'automation_paused', 'automation_resumed', 'automation_escalated']
const RUNTIME_KEYS = ['closing_automation_enabled', 'closing_automation_heartbeat_at', 'closing_automation_cadence', 'email_enabled']

const clean = (v) => String(v ?? '').trim()
const truthy = (v) => ['1', 'true', 'yes', 'on', 'enabled'].includes(clean(v).toLowerCase())

async function childRows(db, table, column, ids, degraded, columns = '*', extra = null) {
  if (!ids.length) return []
  try {
    let q = db.from(table).select(columns).in(column, ids)
    if (extra) q = extra(q)
    const { data, error } = await q.limit(2000)
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

/**
 * Automation runtime, as the worker and the email dispatcher see it. Sending
 * needs BOTH the operator switch (system_control.email_enabled) and the
 * deployment flag (EMAIL_SEND_ENABLED) — the dispatcher's own rule.
 */
export async function readClosingRuntime(db, { env = process.env, degraded = [] } = {}) {
  try {
    const { data, error } = await db.from('system_control').select('key, value').in('key', RUNTIME_KEYS)
    if (error) throw error
    const m = Object.fromEntries((data || []).map((r) => [r.key, r.value]))
    let cadence
    try { cadence = m.closing_automation_cadence ? mergeCadence(typeof m.closing_automation_cadence === 'string' ? JSON.parse(m.closing_automation_cadence) : m.closing_automation_cadence) : undefined } catch { cadence = undefined }
    return {
      automationEnabled: truthy(m.closing_automation_enabled),
      heartbeatAt: clean(m.closing_automation_heartbeat_at) || null,
      emailSendEnabled: truthy(m.email_enabled) && truthy(env.EMAIL_SEND_ENABLED),
      emailSwitch: { operator: truthy(m.email_enabled), deployment: truthy(env.EMAIL_SEND_ENABLED) },
      cadence,
    }
  } catch (err) {
    degraded.push({ source: 'system_control', error: String(err?.message || err) })
    return null
  }
}

async function hydrate(db, cases, { now, runtime }) {
  const degraded = []
  const caseIds = cases.map((c) => c.closing_case_id).filter(Boolean)
  const oppIds = cases.map((c) => c.opportunity_id).filter((id) => UUID_RE.test(String(id || '')))
  const propIds = [...new Set(cases.map((c) => clean(c.property_id)).filter(Boolean))]
  const [offers, agreements, receipts, settlements, milestones, opps, issues, emails, activity, props, threads] = await Promise.all([
    childRows(db, 'buyer_offers', 'opportunity_id', oppIds, degraded),
    childRows(db, 'buyer_agreements', 'opportunity_id', oppIds, degraded),
    childRows(db, 'emd_receipts', 'closing_case_id', caseIds, degraded),
    childRows(db, 'settlement_records', 'closing_case_id', caseIds, degraded),
    childRows(db, 'closing_milestones', 'closing_case_id', caseIds, degraded),
    childRows(db, 'acquisition_opportunities', 'id', oppIds, degraded, 'id, acquisition_stage, opportunity_status, primary_thread_key, seller_display_name, market'),
    childRows(db, 'closing_title_issues', 'closing_case_id', caseIds, degraded),
    childRows(db, 'closing_email_requests', 'closing_case_id', caseIds, degraded, REQUEST_COLUMNS),
    childRows(db, 'closing_activity_events', 'closing_case_id', caseIds, degraded, 'id, closing_case_id, event_type, actor, source, detail, idempotency_key, created_at', (q) => q.in('event_type', MODEL_ACTIVITY)),
    childRows(db, 'properties', 'property_id', propIds, degraded, PROPERTY_COLUMNS),
    childRows(db, 'email_threads', 'closing_case_id', caseIds, degraded, THREAD_COLUMNS),
  ])
  const byOpp = { offers: groupBy(offers, 'opportunity_id'), agreements: groupBy(agreements, 'opportunity_id'), opps: groupBy(opps, 'id') }
  const byCase = { receipts: groupBy(receipts, 'closing_case_id'), settlements: groupBy(settlements, 'closing_case_id'), milestones: groupBy(milestones, 'closing_case_id'), issues: groupBy(issues, 'closing_case_id'), emails: groupBy(emails, 'closing_case_id'), activity: groupBy(activity, 'closing_case_id'), threads: groupBy(threads, 'closing_case_id') }
  const propBy = groupBy(props, 'property_id')
  const items = cases.map((c) => deriveClosingExecution({
    closingCase: c,
    offers: byOpp.offers.get(clean(c.opportunity_id)) || [],
    agreements: byOpp.agreements.get(clean(c.opportunity_id)) || [],
    emdReceipts: byCase.receipts.get(clean(c.closing_case_id)) || [],
    settlements: byCase.settlements.get(clean(c.closing_case_id)) || [],
    milestones: byCase.milestones.get(clean(c.closing_case_id)) || [],
    opportunity: (byOpp.opps.get(clean(c.opportunity_id)) || [])[0] || null,
    titleIssues: byCase.issues.get(clean(c.closing_case_id)) || [],
    emailRequests: byCase.emails.get(clean(c.closing_case_id)) || [],
    activity: byCase.activity.get(clean(c.closing_case_id)) || [],
    property: (propBy.get(clean(c.property_id)) || [])[0] || null,
    emailThreads: byCase.threads.get(clean(c.closing_case_id)) || [],
    runtime,
    now,
  }))
  return { items, degraded }
}

/** Sort keys the operator can choose — each a plain, stated ordering. */
const SORTS = {
  next_closing: (a, b) => (Date.parse(a.closing?.at || '9999') - Date.parse(b.closing?.at || '9999')),
  most_urgent: (a, b) => urgency(b) - urgency(a) || SORTS.next_closing(a, b),
  recently_updated: (a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0),
  recently_closed: (a, b) => Date.parse(b.money?.actual?.legs?.[0]?.closedAt || b.closedAt || b.updatedAt || 0) - Date.parse(a.money?.actual?.legs?.[0]?.closedAt || a.closedAt || a.updatedAt || 0),
}
/** Urgency = blocked > needs you > external/system > rest, then fewer days to close. */
function urgency(x) {
  const tone = { blocked: 4, attention: 3, external: 2, ready: 2, active: 1 }[x.state.tone] || 0
  return tone * 100 - Math.min(99, Math.max(0, x.closing?.daysOut ?? 99))
}

export async function getClosingPortfolio({ sort = 'most_urgent', view = 'full', now = Date.now() } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const since = new Date(now - RECENT_DAYS * 86_400_000).toISOString()
  const { data, error } = await db.from('closing_cases').select(CASE_COLUMNS)
    .or(`updated_at.gte.${since},closing_status.neq.closed`)
    .order('updated_at', { ascending: false })
    .limit(CASE_LIMIT)
  if (error) throw error
  const runtimeDegraded = []
  const runtime = await readClosingRuntime(db, { env: deps.env || process.env, degraded: runtimeDegraded })
  const { items, degraded } = await hydrate(db, data || [], { now, runtime })
  // A long-dead cancellation is history, not work; recent ones stay visible under Cancelled.
  const visible = items.filter((x) => !x.terminal || Date.parse(x.updatedAt || 0) >= now - RECENT_DAYS * 86_400_000)
  visible.sort(SORTS[sort] || SORTS.most_urgent)
  const summary = summarizePortfolio(visible, { now })
  return {
    items: view === 'summary' ? visible.map(summarizeClosing) : visible,
    view: view === 'summary' ? 'summary' : 'full',
    summary,
    runtime: runtime ? { automationEnabled: runtime.automationEnabled, heartbeatAt: runtime.heartbeatAt, emailSendEnabled: runtime.emailSendEnabled, emailSwitch: runtime.emailSwitch } : null,
    degraded: [...runtimeDegraded, ...degraded],
    sort: SORTS[sort] ? sort : 'most_urgent',
    recentDays: RECENT_DAYS,
    generatedAt: new Date(now).toISOString(),
  }
}

async function loadCaseRow(db, id) {
  const key = clean(id)
  if (!key) return null
  // uuid → opportunity_id; anything else → closing_case_id (text). Never an .or()
  // across both: a text value against the uuid column fails the whole query.
  let q = db.from('closing_cases').select(CASE_COLUMNS)
  q = UUID_RE.test(key) ? q.eq('opportunity_id', key) : q.eq('closing_case_id', key)
  const { data, error } = await q.limit(1)
  if (error) throw error
  return (data || [])[0] || null
}

export async function getClosingExecution(id, { now = Date.now(), activityLimit = 30, activityBefore = null } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const row = await loadCaseRow(db, id)
  if (!row) return null
  const runtimeDegraded = []
  const runtime = await readClosingRuntime(db, { env: deps.env || process.env, degraded: runtimeDegraded })
  const { items, degraded } = await hydrate(db, [row], { now, runtime })
  degraded.unshift(...runtimeDegraded)
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

/**
 * Stored files for one closing: attachments Email Command routed to the case,
 * plus attachments on the closing's own email threads. Real files only; a
 * signed preview link is minted per request (5 minutes) by Email Command's
 * attachment module. Nothing is written.
 */
export async function getClosingDocuments(id, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const row = await loadCaseRow(db, id)
  if (!row) return null
  const degraded = []
  const caseId = row.closing_case_id
  const threads = await childRows(db, 'email_threads', 'closing_case_id', [caseId], degraded, 'id, category')
  const cols = 'id, filename, content_type, size_bytes, doc_type, review_state, fetch_status, storage_bucket, storage_path, thread_id, routed_entity_type, routed_entity_id, routed_at, created_at'
  const [routed, onThreads] = await Promise.all([
    (async () => {
      try {
        const { data, error } = await db.from('email_attachments').select(cols).eq('routed_entity_type', 'closing_case').eq('routed_entity_id', caseId).limit(200)
        if (error) throw error
        return data || []
      } catch (err) { degraded.push({ source: 'email_attachments', error: String(err?.message || err) }); return [] }
    })(),
    childRows(db, 'email_attachments', 'thread_id', threads.map((t) => t.id), degraded, cols),
  ])
  const seen = new Set()
  const rows = [...routed, ...onThreads].filter((a) => (seen.has(a.id) ? false : seen.add(a.id)))
  const sign = deps.signedAttachmentUrl || (async (d, a) => (await import('@/lib/domain/email/email-attachments.js')).signedAttachmentUrl(d, a))
  const files = []
  for (const a of rows) {
    const category = threads.find((t) => t.id === a.thread_id)?.category || null
    files.push({
      id: a.id,
      filename: a.filename || null,
      contentType: a.content_type || null,
      size: a.size_bytes ?? null,
      docType: a.doc_type || null,
      review: a.review_state || null,
      stored: a.fetch_status === 'stored',
      routedToCase: a.routed_entity_type === 'closing_case' && a.routed_entity_id === caseId,
      party: category === 'buyer' ? 'Buyer' : category === 'title' ? 'Title' : null,
      at: a.routed_at || a.created_at || null,
      previewUrl: a.fetch_status === 'stored' ? await sign(db, a).catch(() => null) : null,
    })
  }
  files.sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')))
  return { closingCaseId: caseId, files, degraded }
}
