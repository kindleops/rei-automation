/**
 * CLOSING → EMAIL bridge.
 *
 * Closing Authority decides WHAT should be said to title/buyer and WHEN
 * (closing_email_requests). Email Command owns HOW: the thread, the template,
 * the sender, the send, the delivery truth. This module:
 *   1. turns due `pending_transport` requests into email_queue rows (one
 *      logical message per request; queue_key = request_key, so a re-run can
 *      never create a second message),
 *   2. revalidates a closing message against the case at dispatch time,
 *   3. writes the transport outcome back onto the request so the closing
 *      planner sees `sent` (it never chases an email that was not sent).
 */
import { ensureThread, threadKeyFor } from './email-identity.js'
import { renderTemplate, loadTemplateOverrides } from './email-templates.js'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const ts = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null }

function fmtDate(v, tz) {
  const t = ts(v)
  if (t === null) return ''
  // A date stored at 00:00Z is a calendar date, not an instant.
  const dateOnly = /T00:00:00(\.000)?(Z|\+00:00)?$/.test(String(v)) || /^\d{4}-\d{2}-\d{2}$/.test(String(v))
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: dateOnly ? 'UTC' : (tz || 'America/Chicago') }).format(new Date(t))
}

const LEG = { title: 'title', buyer: 'buyer', lender: 'lender' }

/**
 * Bridge due requests. `senderName` resolves per brand at dispatch; the
 * template gets a display name now so the rendered body is complete.
 */
export async function bridgeClosingEmailRequests(db, { now = Date.now(), limit = 25, defaultSenderName = 'Acquisitions' } = {}) {
  const nowIso = new Date(now).toISOString()
  const { data: due, error } = await db.from('closing_email_requests')
    .select('*').eq('status', 'pending_transport').order('due_at', { ascending: true }).limit(limit)
  if (error) throw error
  const rows = (due || []).filter((r) => ts(r.due_at) === null || ts(r.due_at) <= now)
  if (!rows.length) return { bridged: 0, failed: 0 }

  const overrides = await loadTemplateOverrides(db, [...new Set(rows.map((r) => r.template_key))])
  const caseIds = [...new Set(rows.map((r) => r.closing_case_id))]
  const { data: cases } = await db.from('closing_cases').select('*').in('closing_case_id', caseIds)
  const byCase = new Map((cases || []).map((c) => [c.closing_case_id, c]))

  let bridged = 0
  let failed = 0
  for (const r of rows) {
    const c = byCase.get(r.closing_case_id) || {}
    const leg = LEG[r.recipient_role] || 'title'
    const thread = await ensureThread(db, {
      thread_key: r.thread_key || threadKeyFor({ closingCaseId: r.closing_case_id, leg }),
      category: leg === 'title' ? 'title' : leg,
      counterparty_email: r.recipient_email,
      counterparty_name: leg === 'title' ? (r.payload?.title_company_name || c.title_company_name) : (r.payload?.buyer_name || null),
      counterparty_role: leg,
      closing_case_id: r.closing_case_id,
      opportunity_id: r.opportunity_id || c.opportunity_id || null,
      property_id: r.property_id || c.property_id || null,
      master_owner_id: c.master_owner_id || null,
      title_company_id: leg === 'title' ? (c.title_company_id || null) : null,
      brand_key: c.brand_key || r.payload?.brand_key || null,
      subject: r.payload?.property_address ? `${r.payload.property_address}` : null,
      resolution_method: 'closing_authority',
    })

    const vars = {
      property_address: r.payload?.property_address || c.property_address,
      escrow_file_number: r.payload?.escrow_file_number || c.escrow_file_number,
      title_company_name: r.payload?.title_company_name || c.title_company_name,
      scheduled_closing_date: fmtDate(r.payload?.scheduled_closing_date || c.scheduled_closing_date, c.closing_tz),
      commitment_due: fmtDate(c.title_commitment_date, c.closing_tz),
      seller_name: r.payload?.seller_name || c.seller_name,
      buyer_name: r.payload?.buyer_name || null,
      emd_due: fmtDate(r.payload?.due, c.closing_tz),
      sequence: String(r.sequence || 1),
      sender_name: defaultSenderName,
    }
    const rendered = renderTemplate(r.template_key, vars, overrides[r.template_key])
    if (!rendered.ok) {
      failed++
      await db.from('closing_email_requests').update({ status: 'failed', status_reason: `${rendered.code}:${(rendered.missing || []).join(',')}`, updated_at: nowIso }).eq('id', r.id)
      await flagThread(db, thread.id, 'automation_failed', `Could not write the ${r.action.replace(/_/g, ' ')} email — missing ${(rendered.missing || []).join(', ') || rendered.code}`, now)
      continue
    }

    const queueRow = {
      queue_key: r.request_key,
      queue_status: 'pending_send',
      scheduled_for: r.due_at || nowIso,
      to_email: lower(r.recipient_email),
      subject: rendered.subject,
      email_body: rendered.html,
      html_body: rendered.html,
      text_body: rendered.text,
      template_id: r.template_key,
      property_id: r.property_id || null,
      master_owner_id: c.master_owner_id || null,
      thread_id: thread.id,
      source: 'closing',
      source_ref: r.request_key,
      action_key: `closing.${r.action}`,
      sequence: r.sequence || 1,
      brand_key: thread.brand_key || null,
      requested_by: r.requested_by || 'closing_automation',
      reason: {
        why: r.status_reason || null,
        category: r.category,
        action: r.action,
        sequence: r.sequence,
        due_at: r.due_at,
        closing_case_id: r.closing_case_id,
        template_version: rendered.version,
      },
      metadata: { closing_email_request_id: r.id, template_version: rendered.version },
    }
    const ins = await db.from('email_queue').insert(queueRow).select('id').maybeSingle()
    let queueId = ins.data?.id || null
    if (ins.error) {
      if (ins.error.code !== '23505') throw ins.error
      const existing = await db.from('email_queue').select('id').eq('queue_key', r.request_key).maybeSingle()
      queueId = existing.data?.id || null
    }
    await db.from('closing_email_requests').update({ status: 'claimed', claimed_at: nowIso, email_queue_id: queueId ? String(queueId) : null, updated_at: nowIso }).eq('id', r.id)
    bridged++
  }
  return { bridged, failed }
}

async function flagThread(db, threadId, code, reason, now) {
  if (!threadId) return
  await db.from('email_threads').update({ needs_operator: true, needs_code: code, needs_reason: reason, needs_since: new Date(now).toISOString(), updated_at: new Date(now).toISOString() }).eq('id', threadId)
}

/** Stop conditions per closing category, evaluated on the live case. */
export function closingCategorySatisfied(category, c = {}, { offers = [], receipts = [], agreements = [], statements = [] } = {}) {
  const ack = ts(c.title_acknowledged_at) !== null
  const commitment = ts(c.title_commitment_received_at) !== null
  const ctc = ts(c.clear_to_close_at) !== null
  const cat = clean(category)
  if (cat === 'title_open') return c.title_intro_sent_at ? 'title_already_opened' : null
  if (cat === 'title_ack') return ack || commitment || ctc ? 'title_acknowledged' : null
  if (cat === 'title_commitment') return commitment || ctc ? 'commitment_received' : null
  if (cat === 'clear_to_close') return ctc ? 'clear_to_close_received' : null
  if (cat === 'settlement') return statements.length ? 'statement_received' : null
  if (cat.startsWith('closing_confirmation:')) {
    const planned = cat.slice('closing_confirmation:'.length)
    if (!c.closing_date_confirmed_at) return 'closing_date_unconfirmed'
    return ts(planned) !== ts(c.scheduled_closing_date) ? 'closing_date_changed' : null
  }
  const offer = offers.find((o) => lower(o.status) === 'committed') || offers[0]
  if (cat === 'buyer_emd') {
    if (!offer || lower(offer.emd_status) === 'not_required') return 'emd_not_required'
    return receipts.some((r) => r.buyer_offer_id === offer.buyer_offer_id && ['received_unverified', 'verified'].includes(lower(r.status))) ? 'emd_received' : null
  }
  if (cat === 'buyer_agreement') {
    return offer && agreements.some((a) => a.buyer_offer_id === offer.buyer_offer_id && lower(a.status) === 'fully_executed') ? 'agreement_executed' : null
  }
  return null
}

/** Dispatch-time revalidation for source='closing'. */
export async function revalidateClosingEmail(db, row) {
  const { data: req } = await db.from('closing_email_requests').select('*').eq('request_key', row.source_ref).maybeSingle()
  if (!req) return { state: 'cancelled', reason: 'request_missing' }
  if (['cancelled', 'skipped'].includes(req.status)) return { state: 'cancelled', reason: req.status_reason || 'request_cancelled' }
  const { data: c } = await db.from('closing_cases').select('*').eq('closing_case_id', req.closing_case_id).maybeSingle()
  if (!c) return { state: 'cancelled', reason: 'closing_missing' }
  if (c.terminal_outcome || c.provenance?.voided || ['cancelled', 'declined'].includes(lower(c.contract_status))) return { state: 'cancelled', reason: 'closing_terminated' }
  if (c.closed_at || lower(c.closing_status) === 'closed') return { state: 'cancelled', reason: 'closing_closed' }
  if (c.automation_paused_at) return { state: 'cancelled', reason: 'automation_paused' }
  if (lower(c.title_company_email) && req.recipient_role === 'title' && lower(c.title_company_email) !== lower(row.to_email)) return { state: 'changed', reason: 'title_contact_changed' }

  const extra = {}
  if (req.category === 'buyer_emd' || req.category === 'buyer_agreement') {
    const [{ data: offers }, { data: receipts }, { data: agreements }] = await Promise.all([
      db.from('buyer_offers').select('*').eq('opportunity_id', c.opportunity_id),
      db.from('emd_receipts').select('*').eq('closing_case_id', c.closing_case_id),
      db.from('buyer_agreements').select('*').eq('opportunity_id', c.opportunity_id),
    ])
    Object.assign(extra, { offers: offers || [], receipts: receipts || [], agreements: agreements || [] })
  }
  if (req.category === 'settlement') {
    const { data: s } = await db.from('settlement_records').select('settlement_statement_reference').eq('closing_case_id', c.closing_case_id)
    extra.statements = (s || []).filter((x) => x.settlement_statement_reference)
  }
  const satisfied = closingCategorySatisfied(req.category, c, extra)
  if (satisfied) return { state: 'satisfied', reason: satisfied }
  return { state: 'still_needed' }
}

/** Transport outcome → the request (the closing planner reads `sent`). */
export async function writeBackClosingRequest(db, row, outcome, now = Date.now()) {
  if (row.source !== 'closing' || !row.source_ref) return
  const nowIso = new Date(now).toISOString()
  const patch = { updated_at: nowIso }
  if (outcome.status === 'sent') Object.assign(patch, { status: 'sent', sent_at: nowIso, provider_message_id: outcome.providerMessageId || null, delivery_status: 'sent' })
  else if (outcome.status === 'failed') Object.assign(patch, { status: 'failed', status_reason: outcome.code || 'transport_failed', delivery_status: 'failed' })
  else if (['cancelled', 'superseded'].includes(outcome.status)) Object.assign(patch, { status: 'cancelled', status_reason: outcome.code || outcome.status })
  else if (outcome.status === 'escalated') Object.assign(patch, { status: 'failed', status_reason: `escalated:${outcome.code}` })
  else if (outcome.delivery) Object.assign(patch, { delivery_status: outcome.delivery })
  await db.from('closing_email_requests').update(patch).eq('request_key', row.source_ref)
}
