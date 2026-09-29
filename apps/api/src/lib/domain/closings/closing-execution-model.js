/**
 * CLOSING EXECUTION MODEL — one closing, derived deterministically from its
 * canonical records. READ ONLY. Pure: no I/O, no clock except `now`.
 *
 * Sources (the only ones):
 *   closing_cases        contract / title / schedule / deadlines / expected money
 *   buyer_offers         selected + committed buyer (status, commitment_status)
 *   buyer_agreements     the buyer contract (CHECK-constrained status)
 *   emd_receipts         EARNEST MONEY. The offer's emd_status/emd_received_at
 *                        are proposal fields and are NEVER read as "received".
 *   settlement_records   ACTUAL money. `settled` requires evidence by CHECK;
 *                        only settled legs produce actuals.
 *   closing_milestones   workflow provenance for the timeline
 *
 * Deliberately absent: any score. "Health 82%" is replaced by the concrete
 * rail, the requirement list, and blockers that each say what, why, who, next.
 *
 * Truth rules pinned by tests (closing-execution-model.test.mjs):
 *   - READY only when every required condition is explicitly met.
 *   - CLOSED only from the closing workflow's own `closed` state; a passed
 *     date never closes anything (it raises "closing date passed" instead).
 *   - EMD received only from an emd_receipts row.
 *   - ACTUAL money only from settled settlement_records.
 *   - A closing date is CONFIRMED only when closing_status is scheduled/closed;
 *     otherwise it is a TARGET and gets no countdown.
 */

import { deriveTimezoneFromGeography } from '../campaigns/contact-window-timezone.js'
import { displayableCompanyName } from '../entity-graph/buyer-name-privacy.js'

const DAY = 86_400_000
const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const pos = (v) => { const n = num(v); return n !== null && n > 0 ? n : null }
const iso = (v) => { if (!v) return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null }
const arr = (v) => (Array.isArray(v) ? v : [])

/* ── canonical stages (universal-lead-state-registry) ─────────────────── */
export const STAGES = Object.freeze({
  formal_contract: { code: 'S6', label: 'Formal Contract' },
  disposition: { code: 'S7', label: 'Disposition' },
  under_contract: { code: 'S8', label: 'Under Contract' },
  prepared_to_close: { code: 'S9', label: 'Prepared to Close' },
  closed: { code: 'S10', label: 'Closed' },
})

export const OWNERS = Object.freeze(['you', 'seller', 'buyer', 'title', 'lender', 'system'])
const OWNER_LABEL = { you: 'You', seller: 'Seller', buyer: 'Buyer', title: 'Title', lender: 'Lender', system: 'System' }

const TERMINAL_CONTRACT = new Set(['cancelled', 'declined'])
const DEAD_OFFER = new Set(['withdrawn', 'rejected', 'superseded'])
const FAILED_BUYER = new Set(['defaulted', 'terminated'])
const FAILED_COMMITMENT = new Set(['defaulted', 'terminated', 'replacement_required'])
const DEAD_AGREEMENT = new Set(['declined', 'voided', 'expired'])

/* ── address + time ───────────────────────────────────────────────────── */

export function parseAddress(full) {
  const text = clean(full)
  const m = /,\s*([^,]+?),\s*([A-Za-z]{2})\s*(\d{5})?(?:-\d{4})?\s*$/.exec(text)
  if (!m) return { line: text || null, city: null, state: null, zip: null }
  const line = text.slice(0, m.index).trim()
  const titled = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
  return { line: line || null, city: titled(m[1].trim()), state: m[2].toUpperCase(), zip: m[3] || null }
}

function localParts(at, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` }
}

/**
 * A timestamp stored at exactly 00:00:00 UTC is a DATE (these columns are
 * written from date-only offer terms); anything else is an appointment whose
 * wall time belongs to the property's zone.
 */
export function describeWhen(value, tz) {
  const at = iso(value)
  if (!at) return null
  const d = new Date(at)
  const dateOnly = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0
  if (dateOnly || !tz) return { at, date: at.slice(0, 10), time: null, tz: dateOnly ? null : tz || null }
  const { date, hm } = localParts(at, tz)
  return { at, date, time: hm, tz }
}

/** "2026-09-28" → "Sep 28" (server-written sentences read like sentences). */
const humanDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

function dayDiff(fromDate, toDate) {
  return Math.round((Date.parse(`${toDate}T12:00:00Z`) - Date.parse(`${fromDate}T12:00:00Z`)) / DAY)
}

/* ── buyer / agreement / emd / settlement selection ───────────────────── */

export function pickBuyerOffer(offers = []) {
  const live = arr(offers).filter((o) => !DEAD_OFFER.has(lower(o.status)))
  const rank = (o) => (lower(o.status) === 'committed' || lower(o.commitment_status) === 'committed' ? 3
    : o.selected_at || lower(o.status) === 'selected' ? 2
      : FAILED_BUYER.has(lower(o.status)) ? 1 : 0)
  return [...live].sort((a, b) => rank(b) - rank(a) || (Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0)))[0] || null
}

function pickAgreement(agreements = [], offer) {
  const rows = arr(agreements)
    .filter((a) => !a.superseded_at && lower(a.status) !== 'superseded')
    .filter((a) => !offer || !a.buyer_offer_id || a.buyer_offer_id === offer.buyer_offer_id)
  return rows.sort((a, b) => (num(b.agreement_version) ?? 0) - (num(a.agreement_version) ?? 0))[0] || null
}

/** Buyer EMD = receipts tied to a buyer/offer; contract EMD = receipts tied to neither. */
function splitReceipts(receipts = [], offer) {
  const buyer = []
  const contract = []
  for (const r of arr(receipts)) {
    if (r.buyer_offer_id || r.buyer_id || r.buyer_agreement_id) {
      if (!offer || !r.buyer_offer_id || r.buyer_offer_id === offer.buyer_offer_id) buyer.push(r)
    } else contract.push(r)
  }
  return { buyer, contract }
}

const RECEIPT_RANK = { verified: 4, received_unverified: 3, disputed: 2, failed: 1, refunded: 0 }
const bestReceipt = (rows) => [...rows].sort((a, b) => (RECEIPT_RANK[lower(b.status)] ?? -1) - (RECEIPT_RANK[lower(a.status)] ?? -1))[0] || null

function emdLine({ kind, amount, dueAt, receipt, required, now, today, tz }) {
  const due = describeWhen(dueAt, tz)
  const status = lower(receipt?.status)
  let state
  if (!required) state = 'not_required'
  else if (status === 'verified') state = 'verified'
  else if (status === 'received_unverified') state = 'received'
  else if (status === 'failed' || status === 'disputed') state = status
  else if (status === 'refunded') state = 'refunded'
  else if (due && due.date < today) state = 'overdue'
  else state = due ? 'due' : 'required'
  const hoursLeft = due && state === 'due' ? Math.round((Date.parse(due.at) - now) / 3_600_000) : null
  return {
    kind,
    required,
    amount: pos(receipt?.amount) ?? pos(amount),
    state,
    due,
    dueSoon: hoursLeft !== null && hoursLeft <= 48,
    receipt: receipt ? {
      id: clean(receipt.receipt_id) || null,
      status: status || null,
      receivedAt: iso(receipt.received_at),
      verifiedAt: iso(receipt.verified_at),
      verifiedBy: clean(receipt.verified_by) || null,
      method: clean(receipt.verification_method) || null,
      evidence: clean(receipt.evidence_reference) || null,
      escrow: clean(receipt.escrow_destination) || null,
      reference: clean(receipt.escrow_reference) || null,
      source: clean(receipt.source) || null,
    } : null,
  }
}

/* ── the derivation ───────────────────────────────────────────────────── */

export function deriveClosingExecution({
  closingCase: c = {},
  offers = [],
  agreements = [],
  emdReceipts = [],
  settlements = [],
  milestones = [],
  opportunity = null,
  now = Date.now(),
} = {}) {
  const addr = parseAddress(c.property_address)
  const tzInfo = deriveTimezoneFromGeography(addr.state, addr.zip)
  const tz = tzInfo.iana || null
  const today = localParts(now, tz || 'America/Chicago').date

  const contractStatus = lower(c.contract_status)
  const closingStatus = lower(c.closing_status)
  const caseStage = lower(c.universal_stage) || null
  const voided = Boolean(c.provenance && typeof c.provenance === 'object' && c.provenance.voided === true)
  const terminal = TERMINAL_CONTRACT.has(contractStatus) || voided
  const closed = !terminal && (closingStatus === 'closed' || caseStage === 'closed')
  const contractExecuted = contractStatus === 'fully_executed' || Boolean(c.contract_signed_date && !terminal && caseStage && caseStage !== 'formal_contract')

  const offer = pickBuyerOffer(offers)
  const agreement = pickAgreement(agreements, offer)
  const { buyer: buyerReceipts, contract: contractReceipts } = splitReceipts(emdReceipts, offer)
  const settled = arr(settlements).filter((s) => lower(s.settlement_status) === 'settled')
  const settlementLive = arr(settlements).filter((s) => !['failed', 'reversed'].includes(lower(s.settlement_status)))
  const settlementFailed = arr(settlements).find((s) => ['failed', 'reversed'].includes(lower(s.settlement_status))) || null
  const statementRef = arr(settlements).map((s) => clean(s.settlement_statement_reference)).find(Boolean) || null

  /* closing date */
  const when = describeWhen(c.scheduled_closing_date, tz)
  const confirmed = Boolean(when) && (closingStatus === 'scheduled' || closingStatus === 'closed')
  const daysOut = when ? dayDiff(today, when.date) : null

  /* buyer */
  const offerStatus = lower(offer?.status)
  const commitment = lower(offer?.commitment_status)
  const buyerCommitted = Boolean(offer) && (offerStatus === 'committed' || commitment === 'committed')
  const buyerSelected = Boolean(offer) && (buyerCommitted || Boolean(offer.selected_at) || offerStatus === 'selected')
  const buyerFailed = Boolean(offer) && (FAILED_BUYER.has(offerStatus) || FAILED_COMMITMENT.has(commitment))
  const agreementStatus = lower(agreement?.status)
  const agreementExecuted = agreementStatus === 'fully_executed'

  /* emd */
  const buyerEmdRequired = Boolean(offer) && lower(offer.emd_status) !== 'not_required' && (pos(offer.emd_amount) !== null || Boolean(offer.emd_due_date))
  const buyerEmd = buyerSelected
    ? emdLine({ kind: 'buyer', amount: offer.emd_amount, dueAt: offer.emd_due_date, receipt: bestReceipt(buyerReceipts), required: buyerEmdRequired, now, today, tz })
    : null
  const contractEmdRequired = pos(c.earnest_money) !== null
  const contractEmd = contractEmdRequired
    ? emdLine({ kind: 'contract', amount: c.earnest_money, dueAt: c.emd_due_date, receipt: bestReceipt(contractReceipts), required: true, now, today, tz })
    : null
  const emdDone = (line) => !line || line.state === 'verified' || line.state === 'not_required'

  /* title */
  const titleStatus = lower(c.title_status)
  const routeStatus = lower(c.title_route_status)
  const clearToClose = c.readiness && typeof c.readiness === 'object' && c.readiness.clear_to_close === true
  const commitmentDue = describeWhen(c.title_commitment_date, tz)

  /* ── rail ── */
  const rail = []
  const step = (key, label, status, owner, detail, at = null, action = null) => rail.push({ key, label, status, owner: status === 'complete' || status === 'not_started' ? null : owner, detail, at, action })

  // CONTRACT (seller side, DocuSign)
  if (contractExecuted) step('contract', 'Contract', 'complete', null, 'Fully executed', iso(c.contract_signed_date))
  else if (terminal) step('contract', 'Contract', 'blocked', 'you', contractStatus === 'declined' ? 'Seller declined' : 'Cancelled')
  else if (contractStatus === 'seller_signed') step('contract', 'Contract', 'active', 'you', 'Seller signed — your countersignature', iso(c.envelope_sent_at), 'countersign')
  else if (['sent_for_signature', 'viewed', 'buyer_signed'].includes(contractStatus)) step('contract', 'Contract', 'waiting', 'seller', contractStatus === 'viewed' ? 'Seller opened it — not signed' : 'Awaiting seller signature', iso(c.envelope_sent_at), 'nudge_seller')
  else step('contract', 'Contract', 'active', 'you', 'Contract not sent', null, 'send_contract')

  // BUYER (selection → commitment). Never collapsed into "buyer secured".
  if (buyerCommitted) step('buyer', 'Buyer', 'complete', null, 'Committed', iso(offer.committed_at))
  else if (buyerFailed) step('buyer', 'Buyer', 'blocked', 'you', `Buyer ${commitment === 'replacement_required' ? 'needs replacing' : offerStatus || commitment}`, null, 'replace_buyer')
  else if (buyerSelected) step('buyer', 'Buyer', 'active', commitment === 'agreement_sent' ? 'buyer' : 'you', commitment === 'agreement_sent' ? 'Selected — agreement out for signature' : 'Selected — not committed', iso(offer.selected_at), commitment === 'agreement_sent' ? 'nudge_buyer' : 'send_buyer_agreement')
  else if (contractExecuted) step('buyer', 'Buyer', 'active', 'you', 'No buyer selected', null, 'select_buyer')
  else step('buyer', 'Buyer', 'not_started', null, 'After contract')

  // BUYER AGREEMENT
  if (agreementExecuted) step('agreement', 'Buyer agreement', 'complete', null, 'Executed', iso(agreement.executed_at))
  else if (agreement && DEAD_AGREEMENT.has(agreementStatus)) step('agreement', 'Buyer agreement', 'blocked', 'you', `Agreement ${agreementStatus}`, iso(agreement.declined_at || agreement.voided_at || agreement.expired_at), 'resend_buyer_agreement')
  else if (agreement && ['sent', 'viewed', 'counterparty_signed'].includes(agreementStatus)) step('agreement', 'Buyer agreement', 'waiting', 'buyer', agreementStatus === 'viewed' ? 'Buyer opened it — not signed' : 'Awaiting buyer signature', iso(agreement.sent_at), 'nudge_buyer')
  else if (agreement && agreementStatus === 'buyer_signed') step('agreement', 'Buyer agreement', 'active', 'you', 'Buyer signed — your countersignature', null, 'countersign')
  else if (agreement) step('agreement', 'Buyer agreement', 'active', 'you', 'Drafted — not sent', null, 'send_buyer_agreement')
  else if (buyerSelected) step('agreement', 'Buyer agreement', 'active', 'you', 'No agreement yet', null, 'send_buyer_agreement')
  else step('agreement', 'Buyer agreement', 'not_started', null, 'After buyer selection')

  // EMD (buyer's, into escrow) — receipts only
  if (!buyerEmd) step('emd', 'EMD', 'not_started', null, 'After buyer selection')
  else if (buyerEmd.state === 'verified') step('emd', 'EMD', 'complete', null, 'Verified', buyerEmd.receipt?.verifiedAt)
  else if (buyerEmd.state === 'not_required') step('emd', 'EMD', 'complete', null, 'Not required')
  else if (buyerEmd.state === 'received') step('emd', 'EMD', 'active', 'you', 'Received — not verified', buyerEmd.receipt?.receivedAt, 'verify_emd')
  else if (buyerEmd.state === 'overdue') step('emd', 'EMD', 'blocked', 'buyer', 'Overdue', buyerEmd.due?.at, 'chase_emd')
  else if (buyerEmd.state === 'failed' || buyerEmd.state === 'disputed' || buyerEmd.state === 'refunded') step('emd', 'EMD', 'blocked', 'you', `Receipt ${buyerEmd.state}`, null, 'resolve_emd')
  else step('emd', 'EMD', 'waiting', 'buyer', buyerEmd.due ? 'Due' : 'Required', buyerEmd.due?.at, 'chase_emd')

  // TITLE
  if (clearToClose) step('title', 'Title', 'complete', null, 'Clear to close')
  else if (!contractExecuted) step('title', 'Title', 'not_started', null, 'After contract')
  else if (routeStatus === 'title_route_unavailable') step('title', 'Title', 'blocked', 'you', 'No title company routes this market', null, 'choose_title')
  else if (!clean(c.title_company_key) && !clean(c.title_company_name)) step('title', 'Title', 'active', 'system', 'Routing title company')
  else if (!c.title_intro_sent_at && !titleStatus) step('title', 'Title', 'active', 'you', 'Title company chosen — intro not sent', iso(c.title_company_selected_at), 'email_title')
  else if (titleStatus === 'opened') step('title', 'Title', 'waiting', 'title', commitmentDue ? 'Opened — commitment due' : 'Opened — awaiting commitment', iso(c.title_opened_date), 'email_title')
  else step('title', 'Title', 'waiting', 'title', 'Order placed — file not opened', iso(c.title_intro_sent_at), 'email_title')

  // CLOSING DATE
  if (closed) step('schedule', 'Closing date', 'complete', null, when ? 'Held' : 'Closed', when?.at)
  else if (confirmed) step('schedule', 'Closing date', 'complete', null, 'Scheduled', when.at)
  else if (when && !contractExecuted) step('schedule', 'Closing date', 'not_started', null, 'Target — after contract', when.at)
  else if (when) step('schedule', 'Closing date', 'active', 'title', 'Target only — not confirmed', when.at, 'email_title')
  else step('schedule', 'Closing date', contractExecuted ? 'active' : 'not_started', 'you', 'No closing date', null, 'schedule_closing')

  // SETTLEMENT / FUNDS
  if (settled.length) step('settlement', 'Settlement', 'complete', null, 'Settled', iso(settled[0].closed_at))
  else if (settlementFailed) step('settlement', 'Settlement', 'blocked', 'title', `Settlement ${lower(settlementFailed.settlement_status)}`, iso(settlementFailed.updated_at), 'email_title')
  else if (settlementLive.length) step('settlement', 'Settlement', 'waiting', 'title', statementRef ? `Statement received · funds ${lower(settlementLive[0].funding_status) || 'pending'}` : 'Statement pending', null, 'email_title')
  else if (lower(c.funding_status) === 'funded' || lower(c.escrow_status) === 'funded') step('settlement', 'Settlement', 'waiting', 'title', 'Escrow funded — no settlement record', iso(c.funding_date), 'email_title')
  else step('settlement', 'Settlement', confirmed ? 'waiting' : 'not_started', 'title', confirmed ? 'No settlement statement yet' : 'Before closing')

  // CLOSE
  if (closed) step('close', 'Closed', 'complete', null, settled.length ? 'Closed and settled' : 'Closed — settlement not recorded', iso(settled[0]?.closed_at || c.recording_date))
  else step('close', 'Closed', 'not_started', null, when ? (confirmed ? 'Scheduled' : 'Target') : 'Not scheduled', when?.at)

  /* ── ready to close: explicit, all required ── */
  const requirements = [
    { key: 'contract', label: 'Seller contract executed', met: contractExecuted },
    { key: 'buyer', label: 'Buyer committed', met: buyerCommitted },
    { key: 'agreement', label: 'Buyer agreement executed', met: agreementExecuted },
    { key: 'emd', label: 'Buyer EMD verified', met: Boolean(buyerEmd) && emdDone(buyerEmd), detail: buyerEmd?.state === 'received' ? 'Received — not verified' : null },
    { key: 'title', label: 'Title clear to close', met: clearToClose },
    { key: 'schedule', label: 'Closing scheduled', met: confirmed },
    { key: 'statement', label: 'Settlement statement received', met: Boolean(statementRef) },
  ]
  const ready = !closed && !terminal && requirements.every((r) => r.met === true)
  const openRequirements = requirements.filter((r) => r.met !== true)

  /* ── blockers: what / why / who / next ── */
  const blockers = []
  const block = (key, what, why, owner, action) => blockers.push({ key, what, why, owner, ownerLabel: OWNER_LABEL[owner], action })
  if (!terminal && !closed) {
    if (buyerEmd?.state === 'overdue') block('emd_overdue', `Buyer EMD overdue${buyerEmd.amount ? ` · $${buyerEmd.amount.toLocaleString('en-US')}` : ''}`, `Was due ${humanDate(buyerEmd.due.date)}. Without it the buyer is not bound.`, 'buyer', 'chase_emd')
    if (buyerEmd && ['failed', 'disputed'].includes(buyerEmd.state)) block('emd_failed', `Buyer EMD ${buyerEmd.state}`, 'The deposit did not clear; the buyer is not bound.', 'you', 'resolve_emd')
    if (contractEmd?.state === 'overdue') block('contract_emd_overdue', `Contract EMD — no receipt recorded`, `Due ${humanDate(contractEmd.due.date)} under the seller contract.`, 'you', 'record_contract_emd')
    if (buyerFailed) block('buyer_failed', 'Buyer fell through', `Offer ${offerStatus || commitment}. The deal needs a replacement buyer.`, 'you', 'replace_buyer')
    if (agreement && DEAD_AGREEMENT.has(agreementStatus)) block('agreement_dead', `Buyer agreement ${agreementStatus}`, 'No executed buyer contract.', 'you', 'resend_buyer_agreement')
    if (routeStatus === 'title_route_unavailable') block('no_title', 'No title company for this market', 'Title cannot open until a company is chosen.', 'you', 'choose_title')
    if (commitmentDue && commitmentDue.date < today && !clearToClose) block('title_late', 'Title commitment late', `Was due ${humanDate(commitmentDue.date)}.`, 'title', 'email_title')
    if (settlementFailed) block('settlement_failed', `Settlement ${lower(settlementFailed.settlement_status)}`, 'Funds did not settle.', 'title', 'email_title')
    if (when && when.date < today) block('date_passed', 'Closing date passed — not closed', `${confirmed ? 'Scheduled' : 'Target'} ${humanDate(when.date)}. Nothing records a close.`, 'title', 'email_title')
    else if (confirmed && daysOut !== null && daysOut <= 3 && !ready) block('at_risk', `Closing ${daysOut === 0 ? 'today' : daysOut === 1 ? 'tomorrow' : `in ${daysOut} days`} — ${openRequirements.length} open`, openRequirements.map((r) => r.label).join(' · '), 'you', 'review')
    if ((caseStage === 'prepared_to_close') && !when) block('no_date', 'Closing date missing', 'Stage is Prepared to Close with no date on record.', 'you', 'schedule_closing')
  }

  /* ── state (one label, derived — the first matching rule wins) ── */
  const firstOpen = rail.find((r) => r.status === 'active' || r.status === 'waiting' || r.status === 'blocked') || null
  let state
  if (terminal) state = { key: 'cancelled', label: 'Cancelled', tone: 'terminated' }
  else if (closed) state = { key: 'closed', label: settled.length ? 'Closed' : 'Closed — settlement not recorded', tone: 'closed' }
  else if (blockers.some((b) => b.key === 'emd_overdue')) state = { key: 'emd_overdue', label: 'EMD overdue', tone: 'blocked' }
  else if (blockers.some((b) => b.key === 'at_risk' || b.key === 'date_passed')) state = { key: 'closing_at_risk', label: 'Closing date at risk', tone: 'blocked' }
  else if (blockers.length) state = { key: 'blocked', label: 'Blocked', tone: 'blocked' }
  else if (ready) state = { key: 'ready_to_close', label: 'Ready to close', tone: 'ready' }
  else if (firstOpen?.owner === 'you') state = { key: 'needs_you', label: 'Needs you', tone: 'attention' }
  else if (firstOpen?.owner === 'system') state = { key: 'system_handling', label: 'System handling', tone: 'active' }
  else if (firstOpen?.owner) state = { key: `waiting_on_${firstOpen.owner}`, label: `Waiting on ${OWNER_LABEL[firstOpen.owner].toLowerCase()}`, tone: 'external' }
  else state = { key: 'on_track', label: 'On track', tone: 'active' }

  const next = terminal || closed ? null
    : blockers[0] ? { what: blockers[0].what, owner: blockers[0].owner, ownerLabel: blockers[0].ownerLabel, action: blockers[0].action, blocker: true }
      : firstOpen ? { what: `${firstOpen.label}: ${firstOpen.detail}`, owner: firstOpen.owner, ownerLabel: OWNER_LABEL[firstOpen.owner] || null, action: firstOpen.action, blocker: false }
        : null

  /* ── money: estimated vs actual, never mixed ── */
  const buyerPrice = pos(offer?.assignment_price) ?? pos(offer?.offer_price) ?? pos(c.buyer_price)
  const contractPrice = pos(c.seller_contract_price)
  const expectedFee = pos(c.assignment_fee) ?? (buyerPrice && contractPrice && buyerPrice > contractPrice && lower(offer?.strategy || 'assignment') === 'assignment' ? buyerPrice - contractPrice : null)
  const estimated = {
    contractPrice: contractPrice ? { value: contractPrice, basis: contractExecuted ? 'Executed seller contract' : 'Accepted offer — contract not executed' } : null,
    buyerPrice: buyerPrice ? { value: buyerPrice, basis: buyerCommitted ? 'Committed buyer offer' : buyerSelected ? 'Selected buyer offer' : 'Closing case' } : null,
    assignmentFee: expectedFee ? { value: expectedFee, basis: pos(c.assignment_fee) ? 'Closing case' : 'Buyer price − contract price' } : null,
    closingCosts: pos(c.closing_costs) ? { value: pos(c.closing_costs), basis: 'Closing case' } : null,
    titleFees: pos(c.title_fees) ? { value: pos(c.title_fees), basis: 'Closing case' } : null,
    grossRevenue: pos(c.expected_gross_revenue) ? { value: pos(c.expected_gross_revenue), basis: 'Closing case' } : null,
  }
  const sum = (key) => { const v = settled.map((s) => num(s[key])).filter((n) => n !== null); return v.length ? v.reduce((a, b) => a + b, 0) : null }
  const actual = settled.length ? {
    legs: settled.map((s) => ({
      id: clean(s.settlement_id) || null, leg: clean(s.leg) || null, strategy: clean(s.strategy) || null,
      closedAt: iso(s.closed_at), provider: clean(s.closing_provider) || null,
      sellerAmount: num(s.actual_seller_amount), buyerAmount: num(s.actual_buyer_amount),
      assignmentFee: num(s.actual_assignment_fee), closingCosts: num(s.actual_closing_costs),
      otherCosts: num(s.actual_other_costs), netProceeds: num(s.actual_net_proceeds),
      statementType: clean(s.settlement_statement_type) || null, statementRef: clean(s.settlement_statement_reference) || null,
      verifiedBy: clean(s.verified_by) || null, verifiedAt: iso(s.verified_at), method: clean(s.verification_method) || null,
      recording: { status: clean(s.recording_status) || null, at: iso(s.recorded_at), instrument: clean(s.recording_instrument_id) || null, jurisdiction: clean(s.recording_jurisdiction) || null },
      exception: clean(s.post_close_exception) ? { kind: clean(s.post_close_exception), at: iso(s.post_close_exception_at), note: clean(s.post_close_exception_note) || null } : null,
    })),
    assignmentFee: sum('actual_assignment_fee'),
    closingCosts: sum('actual_closing_costs'),
    otherCosts: sum('actual_other_costs'),
    netProceeds: sum('actual_net_proceeds'),
  } : null

  /* ── documents: only real references; status never inferred from upload ── */
  const documents = []
  if (clean(c.docusign_envelope_id) || contractStatus) {
    const map = { fully_executed: 'signed', sent_for_signature: 'awaiting_signature', viewed: 'awaiting_signature', seller_signed: 'awaiting_countersignature', buyer_signed: 'awaiting_signature', draft: 'draft', declined: 'declined', cancelled: 'voided' }
    documents.push({ key: 'purchase_agreement', label: 'Purchase agreement', party: 'Seller', status: map[contractStatus] || 'unknown', source: clean(c.docusign_envelope_id) ? 'DocuSign' : 'Closing case', reference: clean(c.docusign_envelope_id) || null, at: iso(c.contract_signed_date || c.envelope_sent_at) })
  }
  for (const a of arr(agreements)) {
    const map = { fully_executed: 'signed', sent: 'awaiting_signature', viewed: 'awaiting_signature', buyer_signed: 'awaiting_countersignature', counterparty_signed: 'awaiting_signature', draft: 'draft', ready: 'draft', declined: 'declined', voided: 'voided', expired: 'expired', superseded: 'superseded' }
    const type = { assignment_agreement: 'Assignment agreement', purchase_agreement: 'Buyer purchase agreement', novation_agreement: 'Novation agreement' }[lower(a.agreement_type)] || 'Buyer agreement'
    documents.push({ key: `agreement:${clean(a.agreement_id)}`, label: type, party: 'Buyer', status: a.superseded_at ? 'superseded' : map[lower(a.status)] || 'unknown', source: clean(a.provider) || 'Buyer agreements', reference: clean(a.provider_envelope_id) || clean(a.agreement_id) || null, version: num(a.agreement_version), at: iso(a.executed_at || a.sent_at || a.created_at) })
  }
  if (buyerSelected && !agreement) documents.push({ key: 'agreement:missing', label: 'Buyer agreement', party: 'Buyer', status: 'missing', source: null, reference: null, at: null })
  for (const r of arr(emdReceipts)) {
    if (!clean(r.evidence_reference)) continue
    const buyerSide = Boolean(r.buyer_id || r.buyer_offer_id || r.buyer_agreement_id)
    documents.push({ key: `emd:${clean(r.receipt_id)}`, label: buyerSide ? 'Buyer EMD receipt' : 'Contract EMD receipt', party: buyerSide ? 'Buyer' : 'You', status: 'received', source: clean(r.verification_method) || clean(r.source) || 'EMD receipts', reference: clean(r.evidence_reference), at: iso(r.received_at) })
  }
  for (const s of arr(settlements)) {
    if (clean(s.settlement_statement_reference)) documents.push({ key: `statement:${clean(s.settlement_id)}`, label: { alta: 'ALTA settlement statement', hud1: 'HUD-1', closing_statement: 'Closing statement' }[lower(s.settlement_statement_type)] || 'Settlement statement', party: 'Title', status: lower(s.settlement_status) === 'settled' ? 'final' : 'received', source: clean(s.closing_provider) || 'Settlement records', reference: clean(s.settlement_statement_reference), at: iso(s.closed_at || s.created_at) })
    if (clean(s.recording_evidence_reference) || clean(s.recording_instrument_id)) documents.push({ key: `recording:${clean(s.settlement_id)}`, label: 'Recorded deed', party: 'County', status: lower(s.recording_status) === 'recorded' ? 'final' : 'received', source: clean(s.recording_jurisdiction) || 'Recording', reference: clean(s.recording_instrument_id) || clean(s.recording_evidence_reference), at: iso(s.recorded_at) })
  }
  if (confirmed && daysOut !== null && daysOut <= 3 && !statementRef && !closed) documents.push({ key: 'statement:missing', label: 'Settlement statement', party: 'Title', status: 'missing', source: null, reference: null, at: null })
  if (offer && clean(offer.pof_reference)) documents.push({ key: 'pof', label: 'Proof of funds', party: 'Buyer', status: lower(offer.pof_status) === 'verified' ? 'verified' : 'received', source: clean(offer.pof_verified_by) || 'Buyer offer', reference: clean(offer.pof_reference), at: iso(offer.pof_verified_at) })

  /* ── timeline: canonical history with provenance (not chatter) ── */
  const timeline = []
  const ev = (at, label, source, extra = {}) => { const t = iso(at); if (t) timeline.push({ at: t, label, source, ...extra }) }
  const milestoneTypes = new Set(arr(milestones).map((m) => lower(m.milestone_type)))
  ev(c.accepted_at, 'Seller accepted the offer', 'Closing case')
  ev(c.envelope_sent_at, 'Contract sent for signature', 'DocuSign')
  if (!milestoneTypes.has('contract_fully_executed')) ev(c.contract_signed_date, 'Contract fully executed', 'DocuSign')
  ev(c.title_company_selected_at, `Title routed${clean(c.title_company_name) ? ` · ${clean(c.title_company_name)}` : ''}`, 'Title router')
  ev(c.title_intro_sent_at, 'Title order sent', 'Title intro email')
  if (!milestoneTypes.has('title_opened')) ev(c.title_opened_date, 'Title opened', 'Closing case')
  const MILESTONE_LABEL = { contract_fully_executed: 'Contract fully executed', title_opened: 'Title opened', escrow_funded: 'Escrow funded', closing_scheduled: 'Closing scheduled', closed: 'Closed' }
  for (const m of arr(milestones)) ev(m.occurred_at || m.recorded_at, MILESTONE_LABEL[lower(m.milestone_type)] || clean(m.milestone_type).replace(/_/g, ' '), `Closing workflow${clean(m.actor) ? ` · ${clean(m.actor)}` : ''}`)
  if (offer) {
    ev(offer.submitted_at, 'Buyer offer received', 'Buyer offers')
    ev(offer.selected_at, 'Buyer selected', `Buyer offers${clean(offer.selected_by) ? ` · ${clean(offer.selected_by)}` : ''}`)
    ev(offer.committed_at, 'Buyer committed', 'Buyer offers')
  }
  for (const a of arr(agreements)) { ev(a.sent_at, 'Buyer agreement sent', clean(a.provider) || 'Buyer agreements'); ev(a.executed_at, 'Buyer agreement executed', clean(a.provider) || 'Buyer agreements') }
  for (const r of arr(emdReceipts)) {
    ev(r.received_at, `EMD received${pos(r.amount) ? ` · $${pos(r.amount).toLocaleString('en-US')}` : ''}`, clean(r.source) || 'EMD receipts')
    ev(r.verified_at, 'EMD verified', `${clean(r.verified_by) || 'EMD receipts'}${clean(r.verification_method) ? ` · ${clean(r.verification_method).replace(/_/g, ' ')}` : ''}`)
  }
  if (!milestoneTypes.has('escrow_funded')) ev(c.funding_date, 'Escrow funded', 'Closing case')
  for (const s of arr(settlements)) {
    ev(s.funded_at, 'Funds received', clean(s.closing_provider) || 'Settlement records')
    ev(s.closed_at, 'Settled', clean(s.closing_provider) || 'Settlement records')
    ev(s.recorded_at, 'Deed recorded', clean(s.recording_jurisdiction) || 'Recording')
  }
  if (!milestoneTypes.has('closed') && !arr(settlements).some((s) => s.recorded_at)) ev(c.recording_date, 'Recorded', 'Closing case')
  if (when && !closed) timeline.push({ at: when.at, label: confirmed ? 'Closing' : 'Target closing', source: 'Closing case', planned: true })
  timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

  /* ── deadlines that are actually on record ── */
  const deadlines = []
  const dl = (key, label, value, met) => { const w = describeWhen(value, tz); if (w) deadlines.push({ key, label, ...w, met, overdue: !met && w.date < today }) }
  dl('contract_emd', 'Contract EMD due', c.emd_due_date, contractEmd ? emdDone(contractEmd) || contractEmd.state === 'received' : true)
  if (offer) dl('buyer_emd', 'Buyer EMD due', offer.emd_due_date, Boolean(buyerEmd) && (emdDone(buyerEmd) || buyerEmd.state === 'received'))
  dl('inspection', 'Inspection deadline', c.inspection_deadline, closed)
  dl('title_commitment', 'Title commitment due', c.title_commitment_date, clearToClose)
  dl('cure', 'Title cure deadline', c.cure_deadline, clearToClose)
  dl('signing', 'Signing', c.signing_date, closed)
  deadlines.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

  const stageInfo = STAGES[caseStage] || null
  const oppStage = lower(opportunity?.acquisition_stage) || null
  const offerBuyerName = displayableCompanyName(offer?.metadata?.buyer_name || offer?.material_terms?.buyer_name || offer?.metadata?.buyer_company)

  return {
    id: clean(c.closing_case_id),
    opportunityId: clean(c.opportunity_id) || null,
    propertyId: clean(c.property_id) || null,
    masterOwnerId: clean(c.master_owner_id) || null,
    threadKey: clean(c.thread_key) || clean(opportunity?.primary_thread_key) || null,
    property: { address: clean(c.property_address) || null, ...addr, tz, tzConfident: tzInfo.confident },
    seller: { name: clean(opportunity?.seller_display_name) || clean(c.signer_name) || null, signerEmail: clean(c.signer_email) || null },
    stage: stageInfo ? { key: caseStage, ...stageInfo, opportunityStage: oppStage, diverged: Boolean(oppStage && oppStage !== caseStage && STAGES[oppStage]) } : null,
    terminal,
    closed,
    ready,
    state,
    closing: when ? { ...when, confirmed, daysOut: confirmed && !closed ? daysOut : null, past: when.date < today } : null,
    rail,
    requirements,
    blockers,
    next,
    buyer: offer ? {
      id: clean(offer.buyer_id) || null,
      offerId: clean(offer.buyer_offer_id) || null,
      name: offerBuyerName,
      selected: buyerSelected,
      selectedAt: iso(offer.selected_at),
      committed: buyerCommitted,
      committedAt: iso(offer.committed_at),
      commitmentStatus: commitment || null,
      offerStatus: offerStatus || null,
      strategy: clean(offer.strategy) || null,
      price: buyerPrice,
      closingDate: clean(offer.closing_date) || null,
      pof: { status: lower(offer.pof_status) || null, verifiedAt: iso(offer.pof_verified_at), expiresAt: iso(offer.pof_expires_at) },
      agreement: agreement ? { id: clean(agreement.agreement_id) || null, type: clean(agreement.agreement_type) || null, status: agreementStatus || null, version: num(agreement.agreement_version), executedAt: iso(agreement.executed_at), sentAt: iso(agreement.sent_at) } : null,
    } : null,
    emd: { buyer: buyerEmd, contract: contractEmd },
    title: {
      company: clean(c.title_company_name) || null,
      email: clean(c.title_company_email) || null,
      routeStatus: routeStatus || null,
      routeMarket: clean(c.title_route_market) || null,
      status: titleStatus || null,
      introSentAt: iso(c.title_intro_sent_at),
      openedAt: iso(c.title_opened_date),
      commitmentDue,
      clearToClose,
      escrowFile: clean(c.escrow_file_number) || null,
    },
    contract: {
      status: contractStatus || null,
      executedAt: iso(c.contract_signed_date),
      sentAt: iso(c.envelope_sent_at),
      signer: clean(c.signer_name) || null,
      price: contractPrice,
      earnestMoney: pos(c.earnest_money),
      envelope: clean(c.docusign_envelope_id) || null,
    },
    money: { estimated, actual, expectedFeeVsActual: actual && expectedFee ? { expected: expectedFee, actual: actual.assignmentFee } : null },
    documents,
    timeline,
    deadlines,
    updatedAt: iso(c.updated_at),
    lastActivityAt: iso(c.last_activity_at),
  }
}

/** Portfolio buckets — simple, derived from each closing's state. */
export function summarizePortfolio(items = [], { now = Date.now() } = {}) {
  const active = items.filter((x) => !x.terminal && !x.closed)
  const recentClosed = items.filter((x) => x.closed)
  const needsYou = active.filter((x) => x.state.tone === 'blocked' || x.state.tone === 'attention')
  const external = active.filter((x) => x.state.tone === 'external')
  const ready = active.filter((x) => x.ready)
  // Next closing = the soonest date not yet passed (a passed date is a blocker, not "next").
  const upcoming = active.filter((x) => x.closing?.at && !x.closing.past)
    .sort((a, b) => Date.parse(a.closing.at) - Date.parse(b.closing.at))
  return {
    counts: { active: active.length, needsYou: needsYou.length, waitingExternal: external.length, ready: ready.length, closed: recentClosed.length, cancelled: items.filter((x) => x.terminal).length },
    nextClosing: upcoming[0] ? { id: upcoming[0].id, address: upcoming[0].property.line || upcoming[0].property.address, closing: upcoming[0].closing, state: upcoming[0].state } : null,
  }
}
