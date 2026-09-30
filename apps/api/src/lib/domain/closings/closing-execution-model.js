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
 *   closing_title_issues transaction title issues (open ones block)
 *   closing_email_requests + the automation's own planner (closing-automation-plan.js)
 *                        what automation did, is doing, and will do next
 *   email_threads        the latest communication with title / buyer (Email Command)
 *   properties           canonical address + market when the case lacks them
 *
 * Deliberately absent: any score. "Health 82%" is replaced by the concrete
 * rail, the canonical requirement list, and items that each say what, why,
 * who, and how severe.
 *
 * Truth rules pinned by tests (closing-execution-model.test.mjs):
 *   - READY TO CLOSE = the canonical S10 guard's seven pre-closing
 *     requirements (closing-guard.js), all met. The desk has no rule of its own.
 *   - CLOSED only from the closing workflow's own `closed` state; a passed
 *     date never closes anything (it raises "closing date passed" instead).
 *   - EMD received only from an emd_receipts row; VERIFIED only with provenance.
 *   - ACTUAL money only from settled settlement_records, never mixed with
 *     expected figures.
 *   - CLEAR TO CLOSE only from clear_to_close_at (source + evidence + actor by
 *     CHECK); a legacy readiness flag without provenance does not count.
 *   - A closing date is CONFIRMED only from closing_date_confirmed_at;
 *     otherwise it is a TARGET and gets no countdown.
 *   - SYSTEM HANDLING only when the automation's own planner is actively
 *     chasing the open step (a follow-up already went out and the next one is
 *     scheduled), automation is on for this closing, and email can be sent.
 */

import { deriveTimezoneFromGeography } from '../campaigns/contact-window-timezone.js'
import { displayableCompanyName } from '../entity-graph/buyer-name-privacy.js'
import { evaluateClosingGuard } from './closing-guard.js'
import { DEFAULT_CADENCE, planClosingAutomation } from './closing-automation-plan.js'

const DAY = 86_400_000
const HOUR = 3_600_000
const RECENT_RESOLVED_DAYS = 14
const HEARTBEAT_STALE_MS = 30 * 60_000
const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const pos = (v) => { const n = num(v); return n !== null && n > 0 ? n : null }
const iso = (v) => { if (!v) return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null }
const ms = (v) => { if (!v) return null; const t = Date.parse(v); return Number.isFinite(t) ? t : null }
const arr = (v) => (Array.isArray(v) ? v : [])
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`
const words = (s) => clean(s).replace(/_/g, ' ')

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

/**
 * READY TO CLOSE — the canonical S10 guard's pre-closing requirements, in rail
 * order. `met` is read from evaluateClosingGuard() itself, so the desk and
 * Pipeline's finalize can never disagree. (The guard's remaining codes —
 * terminated, settlement settled — are the closing itself, not readiness.)
 */
export const READY_REQUIREMENTS = Object.freeze([
  { key: 'contract', code: 'seller_contract_not_executed', label: 'Seller contract executed' },
  { key: 'buyer', code: 'buyer_not_committed', label: 'Buyer committed' },
  { key: 'agreement', code: 'buyer_agreement_not_executed', label: 'Buyer agreement executed' },
  { key: 'emd', code: 'emd_not_verified', label: 'Buyer EMD verified' },
  { key: 'issues', code: 'open_title_issues', label: 'No open title issues' },
  { key: 'title', code: 'title_not_clear_to_close', label: 'Title clear to close' },
  { key: 'schedule', code: 'closing_date_not_confirmed', label: 'Closing date confirmed' },
])

/** Left-navigation groups, in display order. Assignment precedence lives in groupOf(). */
export const GROUPS = Object.freeze([
  { key: 'needs_you', label: 'Needs you' },
  { key: 'closing_today', label: 'Closing today' },
  { key: 'closing_soon', label: 'Closing soon' },
  { key: 'waiting_seller', label: 'Waiting on seller' },
  { key: 'waiting_buyer', label: 'Waiting on buyer' },
  { key: 'waiting_title', label: 'Waiting on title' },
  { key: 'waiting_lender', label: 'Waiting on lender' },
  { key: 'system_handling', label: 'System handling' },
  { key: 'ready', label: 'Ready' },
  { key: 'closed', label: 'Closed' },
  { key: 'cancelled', label: 'Cancelled' },
])

/** Automation follow-up loops — what each one chases and why. */
export const LOOPS = Object.freeze({
  title_open: { label: 'Title order', why: 'Title has not received the order', party: 'title' },
  title_ack: { label: 'Title acknowledgement follow-up', why: 'Title has not acknowledged the order', party: 'title' },
  title_commitment: { label: 'Title commitment follow-up', why: 'Commitment not yet received', party: 'title' },
  clear_to_close: { label: 'Clear-to-close follow-up', why: 'No clear to close yet', party: 'title' },
  settlement: { label: 'Settlement statement request', why: 'No settlement statement yet', party: 'title' },
  buyer_emd: { label: 'Buyer EMD reminder', why: 'Buyer EMD not received', party: 'buyer' },
  buyer_agreement: { label: 'Buyer agreement follow-up', why: 'Buyer has not signed the agreement', party: 'buyer' },
  closing_confirmation: { label: 'Closing confirmation to title', why: 'Closing date confirmed — title is told once per date', party: 'title' },
})
const loopKey = (category) => clean(category).split(':')[0]
/** Why automation is not moving anything right now (null = it is). */
export const HELD_TEXT = Object.freeze({
  automation_paused: 'Automation is paused for this closing',
  automation_disabled: 'Closing automation is switched off',
  worker_stale: 'The closing automation worker has not checked in',
  email_sending_off: 'Email sending is off',
})

const TERMINAL_CONTRACT = new Set(['cancelled', 'declined'])
const DEAD_OFFER = new Set(['withdrawn', 'rejected', 'superseded'])
const FAILED_BUYER = new Set(['defaulted', 'terminated'])
const FAILED_COMMITMENT = new Set(['defaulted', 'terminated', 'replacement_required'])
const DEAD_AGREEMENT = new Set(['declined', 'voided', 'expired'])
const AUTOMATION_ACTORS = new Set(['closing_automation', 'email_command', 'system', 'docusign', 'closing_workflow', 'title-inbound'])

const ISSUE_LABEL = {
  open_lien: 'Open lien', probate: 'Probate', name_discrepancy: 'Name discrepancy', hoa_balance: 'HOA balance',
  missing_release: 'Unreleased mortgage', tax: 'Tax', judgment: 'Judgment', easement: 'Easement', survey: 'Survey', other: 'Title issue',
}

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
  const hoursLeft = due && state === 'due' ? Math.round((Date.parse(due.at) - now) / HOUR) : null
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
      reference: clean(receipt.escrow_reference) || clean(receipt.external_reference) || null,
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
  titleIssues = [],
  emailRequests = [],
  activity = [],
  property = null,
  emailThreads = [],
  runtime = null,
  now = Date.now(),
} = {}) {
  const addressText = clean(c.property_address) || clean(property?.property_address_full) || null
  const parsed = parseAddress(addressText)
  const addr = {
    line: parsed.line,
    city: parsed.city || clean(property?.property_address_city) || null,
    state: parsed.state || (clean(property?.property_address_state).toUpperCase() || null),
    zip: parsed.zip || clean(property?.property_address_zip) || null,
  }
  const tzInfo = deriveTimezoneFromGeography(addr.state, addr.zip)
  const tz = clean(c.closing_tz) || tzInfo.iana || null
  const today = localParts(now, tz || 'America/Chicago').date
  const market = clean(property?.market) || clean(opportunity?.market) || clean(c.title_route_market) || null

  const contractStatus = lower(c.contract_status)
  const closingStatus = lower(c.closing_status)
  const caseStage = lower(c.universal_stage) || null
  const provenance = c.provenance && typeof c.provenance === 'object' ? c.provenance : {}
  const voided = provenance.voided === true
  const terminalOutcome = lower(c.terminal_outcome) || null
  const terminal = TERMINAL_CONTRACT.has(contractStatus) || voided || Boolean(terminalOutcome)
  const closed = !terminal && (closingStatus === 'closed' || caseStage === 'closed')
  const contractExecuted = contractStatus === 'fully_executed' || Boolean(c.contract_signed_date && !terminal && caseStage && caseStage !== 'formal_contract')

  const offer = pickBuyerOffer(offers)
  const agreement = pickAgreement(agreements, offer)
  const { buyer: buyerReceipts, contract: contractReceipts } = splitReceipts(emdReceipts, offer)
  const settled = arr(settlements).filter((s) => lower(s.settlement_status) === 'settled')
  const settlementLive = arr(settlements).filter((s) => !['failed', 'reversed'].includes(lower(s.settlement_status)))
  const settlementFailed = arr(settlements).find((s) => ['failed', 'reversed'].includes(lower(s.settlement_status))) || null
  const statementRef = arr(settlements).map((s) => clean(s.settlement_statement_reference)).find(Boolean) || null
  const requests = arr(emailRequests)
  const threads = arr(emailThreads)

  /* closing date */
  const when = describeWhen(c.scheduled_closing_date, tz)
  // Confirmed only through the closing authority (closing_date_confirmed_at) —
  // the same fact the S10 guard reads. A closed deal's date is history.
  const confirmed = Boolean(when) && (Boolean(c.closing_date_confirmed_at) || closed)
  const daysOut = when ? dayDiff(today, when.date) : null
  const datePassed = Boolean(when) && when.date < today

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
  if (buyerEmd && offer?.metadata?.emd_waiver) buyerEmd.waiver = { reason: clean(offer.metadata.emd_waiver.reason) || null, evidence: clean(offer.metadata.emd_waiver.evidence) || null, actor: clean(offer.metadata.emd_waiver.actor) || null, at: iso(offer.metadata.emd_waiver.at) }
  // Seller-contract EMD (our deposit): emd_receipts is buyer-only by schema,
  // so the canonical record is the audited `contract_emd_deposited` event.
  const contractEmdRequired = pos(c.earnest_money) !== null
  const deposit = arr(activity).find((a) => a.event_type === 'contract_emd_deposited' || a.type === 'contract_emd_deposited')
  const depositReceipt = deposit ? { receipt_id: deposit.idempotency_key || deposit.id || null, status: 'verified', amount: deposit.detail?.amount, received_at: deposit.detail?.deposited_at, verified_at: deposit.detail?.deposited_at, verified_by: deposit.actor, verification_method: deposit.source, evidence_reference: deposit.detail?.evidence, escrow_destination: deposit.detail?.escrow, source: 'contract_emd_deposit' } : bestReceipt(contractReceipts)
  const contractEmd = contractEmdRequired
    ? emdLine({ kind: 'contract', amount: c.earnest_money, dueAt: c.emd_due_date, receipt: depositReceipt, required: true, now, today, tz })
    : null
  const emdDone = (line) => !line || line.state === 'verified' || line.state === 'not_required'

  /* title */
  const titleStatus = lower(c.title_status)
  const routeStatus = lower(c.title_route_status)
  // Clear to close is explicit: clear_to_close_at carries source + evidence + actor by CHECK.
  const clearToClose = Boolean(c.clear_to_close_at)
  const legacyCtcFlag = !clearToClose && Boolean(c.readiness && typeof c.readiness === 'object' && c.readiness.clear_to_close === true)
  const commitmentDue = describeWhen(c.title_commitment_date, tz)
  const commitmentReceived = Boolean(c.title_commitment_received_at)
  const acknowledged = Boolean(c.title_acknowledged_at)
  const openIssues = arr(titleIssues).filter((i) => ['open', 'in_progress'].includes(lower(i.status)))
  const escalations = (c.automation_state && typeof c.automation_state === 'object' && c.automation_state.escalations) || {}
  const titleThread = threads.find((t) => lower(t.category) === 'title') || null
  const buyerThread = threads.find((t) => lower(t.category) === 'buyer') || null

  /* ── automation: the planner's own view of this closing ── */
  const rt = {
    automationEnabled: runtime?.automationEnabled === undefined ? null : runtime.automationEnabled,
    emailSendEnabled: runtime?.emailSendEnabled === undefined ? null : runtime.emailSendEnabled,
    heartbeatAt: iso(runtime?.heartbeatAt),
  }
  const heartbeatStale = rt.heartbeatAt ? now - Date.parse(rt.heartbeatAt) > HEARTBEAT_STALE_MS : null
  const plan = planClosingAutomation({
    closingCase: { ...c, __has_statement: Boolean(statementRef) },
    offers, agreements, emdReceipts, requests, now,
    cadence: runtime?.cadence || DEFAULT_CADENCE,
    automationEnabled: rt.automationEnabled !== false,
  })
  const satisfied = (category) => {
    switch (category) {
      case 'title_route': return Boolean(clean(c.title_company_email) || clean(c.title_company_key))
      case 'title_ack': return acknowledged || commitmentReceived || clearToClose
      case 'title_commitment': return commitmentReceived || clearToClose
      case 'clear_to_close': return clearToClose
      case 'settlement': return Boolean(statementRef)
      case 'buyer_emd': return !buyerEmd || ['verified', 'received', 'not_required'].includes(buyerEmd.state)
      case 'buyer_agreement': return agreementExecuted
      default: return false
    }
  }
  const held = c.automation_paused_at ? 'automation_paused'
    : rt.automationEnabled === false ? 'automation_disabled'
      : heartbeatStale ? 'worker_stale'
        : rt.emailSendEnabled === false ? 'email_sending_off' : null
  const reqsFor = (category) => requests.filter((r) => loopKey(r.category) === category).sort((a, b) => (num(a.sequence) ?? 0) - (num(b.sequence) ?? 0) || String(a.requested_at || '').localeCompare(String(b.requested_at || '')))
  const loops = plan.schedule.map((s) => {
    const key = loopKey(s.category)
    const mine = reqsFor(key).filter((r) => r.category === s.category)
    const last = mine[mine.length - 1] || null
    const inFlight = mine.find((r) => ['pending_transport', 'claimed'].includes(r.status)) || null
    return {
      category: s.category,
      key,
      label: LOOPS[key]?.label || words(key),
      why: LOOPS[key]?.why || null,
      party: LOOPS[key]?.party || null,
      state: s.state,
      reason: s.reason || null,
      done: s.done ?? mine.length,
      max: s.max ?? null,
      next: s.next || null,
      escalateAt: s.escalateAt || null,
      occupiedBy: s.occupiedBy || null,
      inFlight: inFlight ? { sequence: num(inFlight.sequence), status: inFlight.status, at: iso(inFlight.claimed_at || inFlight.requested_at) } : null,
      latest: last ? { sequence: num(last.sequence), status: last.status, reason: last.status_reason || null, at: iso(last.sent_at || last.claimed_at || last.requested_at), sentAt: iso(last.sent_at) } : null,
    }
  })
  /** The loop carrying an open step, when the system is actively chasing it. */
  const handlingFor = (keys) => {
    for (const k of keys) {
      const l = loops.find((x) => x.key === k && x.state !== 'satisfied')
      if (!l) continue
      const chasing = l.inFlight || (['scheduled', 'due'].includes(l.state) && (l.done ?? 0) >= 1) || (k === 'title_open' && ['due', 'queued'].includes(l.state))
      if (!chasing) continue
      const next = l.inFlight ? { sequence: l.inFlight.sequence, at: l.inFlight.at, queued: true } : l.next
      return { category: l.category, key: l.key, label: l.label, why: l.why, party: l.party, sequence: next?.sequence ?? null, at: next?.at ?? null, queued: Boolean(next?.queued), state: l.state, done: l.done, max: l.max, held }
    }
    return null
  }

  /* ── rail ── */
  const rail = []
  const step = (key, label, status, owner, detail, at = null, action = null, short = null) => rail.push({ key, label, status, owner: status === 'complete' || status === 'not_started' ? null : owner, detail, at, action, short: short || detail })

  // CONTRACT (seller side, DocuSign)
  if (contractExecuted) step('contract', 'Contract', 'complete', null, 'Fully executed', iso(c.contract_signed_date), null, 'Executed')
  else if (terminal) step('contract', 'Contract', 'blocked', 'you', contractStatus === 'declined' ? 'Seller declined' : voided ? 'Voided' : 'Cancelled', null, null, contractStatus === 'declined' ? 'Declined' : voided ? 'Voided' : 'Cancelled')
  else if (contractStatus === 'seller_signed') step('contract', 'Contract', 'active', 'you', 'Seller signed — your countersignature', iso(c.envelope_sent_at), 'countersign', 'Countersign')
  else if (['sent_for_signature', 'viewed', 'buyer_signed'].includes(contractStatus)) step('contract', 'Contract', 'waiting', 'seller', contractStatus === 'viewed' ? 'Seller opened it — not signed' : 'Awaiting seller signature', iso(c.envelope_sent_at), 'nudge_seller', contractStatus === 'viewed' ? 'Viewed' : 'Out for signature')
  else step('contract', 'Contract', 'active', 'you', 'Contract not sent', null, 'send_contract', 'Not sent')

  // BUYER (selection → commitment). Never collapsed into "buyer secured".
  if (buyerCommitted) step('buyer', 'Buyer', 'complete', null, 'Committed', iso(offer.committed_at), null, 'Committed')
  else if (buyerFailed) step('buyer', 'Buyer', 'blocked', 'you', `Buyer ${commitment === 'replacement_required' ? 'needs replacing' : offerStatus || commitment}`, null, 'replace_buyer', 'Fell through')
  else if (buyerSelected) step('buyer', 'Buyer', 'active', commitment === 'agreement_sent' ? 'buyer' : 'you', commitment === 'agreement_sent' ? 'Selected — agreement out for signature' : 'Selected — not committed', iso(offer.selected_at), commitment === 'agreement_sent' ? 'nudge_buyer' : 'send_buyer_agreement', 'Selected')
  else if (contractExecuted) step('buyer', 'Buyer', 'active', 'you', 'No buyer selected', null, 'select_buyer', 'None')
  else step('buyer', 'Buyer', 'not_started', null, 'After contract', null, null, '—')

  // BUYER AGREEMENT
  if (agreementExecuted) step('agreement', 'Buyer agreement', 'complete', null, 'Executed', iso(agreement.executed_at), null, 'Signed')
  else if (agreement && DEAD_AGREEMENT.has(agreementStatus)) step('agreement', 'Buyer agreement', 'blocked', 'you', `Agreement ${agreementStatus}`, iso(agreement.declined_at || agreement.voided_at || agreement.expired_at), 'resend_buyer_agreement', words(agreementStatus))
  else if (agreement && ['sent', 'viewed', 'counterparty_signed'].includes(agreementStatus)) step('agreement', 'Buyer agreement', 'waiting', 'buyer', agreementStatus === 'viewed' ? 'Buyer opened it — not signed' : 'Awaiting buyer signature', iso(agreement.sent_at), 'nudge_buyer', agreementStatus === 'viewed' ? 'Viewed' : 'Sent')
  else if (agreement && agreementStatus === 'buyer_signed') step('agreement', 'Buyer agreement', 'active', 'you', 'Buyer signed — your countersignature', null, 'countersign', 'Countersign')
  else if (agreement) step('agreement', 'Buyer agreement', 'active', 'you', 'Drafted — not sent', null, 'send_buyer_agreement', 'Draft')
  else if (buyerSelected) step('agreement', 'Buyer agreement', 'active', 'you', 'No agreement yet', null, 'send_buyer_agreement', 'None')
  else step('agreement', 'Buyer agreement', 'not_started', null, 'After buyer selection', null, null, '—')

  // EMD (buyer's, into escrow) — receipts only
  if (!buyerEmd) step('emd', 'EMD', 'not_started', null, 'After buyer selection', null, null, '—')
  else if (buyerEmd.state === 'verified') step('emd', 'EMD', 'complete', null, 'Verified', buyerEmd.receipt?.verifiedAt, null, 'Verified')
  else if (buyerEmd.state === 'not_required') step('emd', 'EMD', 'complete', null, 'Not required', null, null, 'Waived')
  else if (buyerEmd.state === 'received') step('emd', 'EMD', 'active', 'you', 'Received — not verified', buyerEmd.receipt?.receivedAt, 'verify_emd', 'Unverified')
  else if (buyerEmd.state === 'overdue') step('emd', 'EMD', 'blocked', 'buyer', 'Overdue', buyerEmd.due?.at, 'chase_emd', 'Overdue')
  else if (['failed', 'disputed', 'refunded'].includes(buyerEmd.state)) step('emd', 'EMD', 'blocked', 'you', `Receipt ${buyerEmd.state}`, null, 'resolve_emd', words(buyerEmd.state))
  else step('emd', 'EMD', 'waiting', 'buyer', buyerEmd.due ? 'Due' : 'Required', buyerEmd.due?.at, 'chase_emd', buyerEmd.due ? `Due ${humanDate(buyerEmd.due.date)}` : 'Required')

  // TITLE
  if (clearToClose) step('title', 'Title', 'complete', null, 'Clear to close', iso(c.clear_to_close_at), null, 'Clear')
  else if (!contractExecuted) step('title', 'Title', 'not_started', null, 'After contract', null, null, '—')
  else if (openIssues.length) step('title', 'Title', 'blocked', lower(openIssues[0].owner) || 'title', `${openIssues.length} open title issue${openIssues.length === 1 ? '' : 's'}`, iso(openIssues[0].opened_at), 'email_title', `${openIssues.length} issue${openIssues.length === 1 ? '' : 's'}`)
  else if (commitmentReceived) step('title', 'Title', 'waiting', 'title', 'Commitment received — awaiting clear to close', iso(c.title_commitment_received_at), 'email_title', 'Committed')
  else if (acknowledged) step('title', 'Title', 'waiting', 'title', commitmentDue ? 'Acknowledged — commitment due' : 'Acknowledged — awaiting commitment', iso(c.title_acknowledged_at), 'email_title', commitmentDue ? `Commitment due ${humanDate(commitmentDue.date)}` : 'Opened')
  else if (routeStatus === 'title_route_unavailable') step('title', 'Title', 'blocked', 'you', 'No title company routes this market', null, 'choose_title', 'No route')
  else if (!clean(c.title_company_key) && !clean(c.title_company_name)) step('title', 'Title', 'active', 'system', 'Routing title company', null, null, 'Routing')
  else if (!c.title_intro_sent_at && !titleStatus) step('title', 'Title', 'active', 'system', 'Title company chosen — order not sent yet', iso(c.title_company_selected_at), 'email_title', 'Ordering')
  else if (titleStatus === 'opened') step('title', 'Title', 'waiting', 'title', commitmentDue ? 'Opened — commitment due' : 'Opened — awaiting commitment', iso(c.title_opened_date), 'email_title', 'Opened')
  else step('title', 'Title', 'waiting', 'title', 'Order sent — not acknowledged', iso(c.title_intro_sent_at), 'email_title', 'Ordered')

  // CLOSING DATE
  if (closed) step('schedule', 'Closing date', 'complete', null, when ? 'Held' : 'Closed', when?.at, null, when ? humanDate(when.date) : 'Closed')
  else if (confirmed && !datePassed) step('schedule', 'Closing date', 'complete', null, 'Confirmed', when.at, null, humanDate(when.date))
  else if (confirmed) step('schedule', 'Closing date', 'blocked', 'you', 'Date passed — not closed', when.at, 'schedule_closing', 'Passed')
  else if (when && !contractExecuted) step('schedule', 'Closing date', 'not_started', null, 'Target — after contract', when.at, null, `Target ${humanDate(when.date)}`)
  else if (when) step('schedule', 'Closing date', 'waiting', 'title', 'Target only — not confirmed', when.at, 'email_title', `Target ${humanDate(when.date)}`)
  else step('schedule', 'Closing date', contractExecuted ? 'active' : 'not_started', 'you', 'No closing date', null, 'schedule_closing', 'Not set')

  // SETTLEMENT / FUNDS
  if (settled.length) step('settlement', 'Settlement', 'complete', null, 'Settled', iso(settled[0].closed_at), null, 'Settled')
  else if (settlementFailed) step('settlement', 'Settlement', 'blocked', 'title', `Settlement ${lower(settlementFailed.settlement_status)}`, iso(settlementFailed.updated_at), 'email_title', words(settlementFailed.settlement_status))
  else if (settlementLive.length) step('settlement', 'Settlement', 'waiting', 'title', statementRef ? `Statement received · funds ${lower(settlementLive[0].funding_status) || 'pending'}` : 'Statement pending', null, 'email_title', statementRef ? 'Statement received' : 'Pending')
  else if (lower(c.funding_status) === 'funded' || lower(c.escrow_status) === 'funded') step('settlement', 'Settlement', 'waiting', 'title', 'Escrow funded — no settlement record', iso(c.funding_date), 'email_title', 'Funded')
  else step('settlement', 'Settlement', confirmed ? 'waiting' : 'not_started', 'title', confirmed ? 'No settlement statement yet' : 'Before closing', null, null, confirmed ? 'Awaiting' : '—')

  // CLOSE
  if (closed) step('close', 'Closed', 'complete', null, settled.length ? 'Closed and settled' : 'Closed — settlement record unavailable', iso(c.closed_at || settled[0]?.closed_at || c.recording_date), null, 'Closed')
  else step('close', 'Closed', 'not_started', null, when ? (confirmed ? 'Scheduled' : 'Target') : 'Not scheduled', when?.at, null, '—')

  /* ── READY TO CLOSE: the canonical guard's seven, read from the guard itself ── */
  const guard = evaluateClosingGuard({ closingCase: c, offers, agreements, emdReceipts, settlements, titleIssues })
  const railOf = (k) => rail.find((r) => r.key === k)
  const requirementDetail = {
    contract: () => (contractExecuted ? `Executed${c.contract_signed_date ? ` ${humanDate(iso(c.contract_signed_date).slice(0, 10))}` : ''}` : railOf('contract')?.detail),
    buyer: () => (buyerCommitted ? `Committed${offer?.committed_at ? ` ${humanDate(iso(offer.committed_at).slice(0, 10))}` : ''}` : railOf('buyer')?.detail),
    agreement: () => railOf('agreement')?.detail,
    emd: () => (buyerEmd?.state === 'verified' ? `Verified${buyerEmd.receipt?.method ? ` · ${words(buyerEmd.receipt.method)}` : ''}` : buyerEmd?.state === 'not_required' ? 'Waived with evidence' : buyerEmd?.state === 'received' ? 'Received — not verified' : buyerEmd?.state === 'overdue' ? `Overdue since ${humanDate(buyerEmd.due.date)}` : buyerEmd ? (buyerEmd.due ? `Due ${humanDate(buyerEmd.due.date)}` : 'Required') : 'No buyer yet'),
    issues: () => (openIssues.length ? `${openIssues.length} open` : 'None open'),
    title: () => (clearToClose ? `${words(c.clear_to_close_source) || 'Title'} · ${humanDate(iso(c.clear_to_close_at).slice(0, 10))}` : legacyCtcFlag ? 'Legacy flag without provenance — not counted' : railOf('title')?.detail),
    schedule: () => (confirmed ? `Confirmed${c.closing_date_source ? ` · ${words(c.closing_date_source)}` : ''}` : when ? 'Target only — not confirmed' : 'No date'),
  }
  const requirementOwner = { contract: 'seller', buyer: 'you', agreement: 'buyer', emd: 'buyer', issues: 'title', title: 'title', schedule: 'title' }
  const requirements = READY_REQUIREMENTS.map((r) => {
    const met = !guard.missing.includes(r.code)
    return { key: r.key, code: r.code, label: r.label, met, detail: requirementDetail[r.key]() || null, owner: met ? null : (r.key === 'emd' && buyerEmd?.state === 'received' ? 'you' : r.key === 'issues' ? (lower(openIssues[0]?.owner) || 'title') : requirementOwner[r.key]) }
  })
  // The checklist can be complete while something still blocks (a passed date,
  // a failed settlement): READY is the complete checklist with nothing blocking.
  const checklistComplete = !closed && !terminal && requirements.every((r) => r.met === true)
  const openRequirements = requirements.filter((r) => r.met !== true)

  /* ── the plane: every open item with a severity; only some are blockers ── */
  const items = []
  const item = (key, spec) => items.push({ key, what: spec.what, why: spec.why || null, owner: spec.owner, ownerLabel: OWNER_LABEL[spec.owner] || null, severity: spec.severity, group: spec.group || null, action: spec.action || null, requirement: spec.requirement || null, requirements: spec.requirements || null, at: spec.at || null, dateOnly: Boolean(spec.dateOnly), source: spec.source || null })
  const recent = (at) => Boolean(at) && now - Date.parse(at) <= RECENT_RESOLVED_DAYS * DAY
  const soonWindow = confirmed && !datePassed && daysOut !== null && daysOut <= 7
  const activeEscalations = []
  const resolvedEscalations = []
  for (const [category, e] of Object.entries(escalations)) (satisfied(category) ? resolvedEscalations : activeEscalations).push([category, e])

  if (!terminal && !closed) {
    // — schedule —
    if (datePassed) item('date_passed', { what: 'Closing date passed — not closed', why: `${confirmed ? 'Confirmed' : 'Target'} ${humanDate(when.date)}. Nothing records a close — reschedule it or record the settlement. A passed date never closes a deal.`, owner: 'you', severity: 'blocking', group: 'blocking', action: 'schedule_closing', requirement: 'schedule', at: when.at, dateOnly: !when.time })
    if (caseStage === 'prepared_to_close' && !when) item('no_date', { what: 'Closing date missing', why: 'Stage is Prepared to Close with no date on record.', owner: 'you', severity: 'blocking', group: 'missing', action: 'schedule_closing', requirement: 'schedule' })
    // — buyer EMD (receipts only) —
    if (buyerEmd?.state === 'overdue') item('emd_overdue', { what: `Buyer EMD overdue${buyerEmd.amount ? ` · ${usd(buyerEmd.amount)}` : ''}`, why: `Was due ${humanDate(buyerEmd.due.date)}. Without it the buyer is not bound.`, owner: 'buyer', severity: 'overdue', group: 'overdue', action: 'chase_emd', requirement: 'emd', at: buyerEmd.due.at, dateOnly: !buyerEmd.due.time })
    if (buyerEmd && ['failed', 'disputed', 'refunded'].includes(buyerEmd.state)) item('emd_failed', { what: `Buyer EMD ${buyerEmd.state}`, why: 'The deposit did not clear; the buyer is not bound.', owner: 'you', severity: 'blocking', group: 'blocking', action: 'resolve_emd', requirement: 'emd' })
    if (buyerEmd?.state === 'received') item('emd_unverified', { what: `Buyer EMD received — verify it${buyerEmd.amount ? ` · ${usd(buyerEmd.amount)}` : ''}`, why: 'A receipt counts only once verified with a method and evidence.', owner: 'you', severity: 'pending', group: 'human_decision', action: 'verify_emd', requirement: 'emd', at: buyerEmd.receipt?.receivedAt })
    if (buyerEmd?.state === 'due' && buyerEmd.dueSoon) item('emd_due_soon', { what: `Buyer EMD due ${humanDate(buyerEmd.due.date)}${buyerEmd.amount ? ` · ${usd(buyerEmd.amount)}` : ''}`, why: 'No receipt recorded yet.', owner: 'buyer', severity: 'due_soon', group: 'due_soon', action: 'chase_emd', requirement: 'emd', at: buyerEmd.due.at, dateOnly: !buyerEmd.due.time })
    else if (buyerEmd && ['due', 'required'].includes(buyerEmd.state)) item('emd_due', { what: `Buyer EMD ${buyerEmd.due ? `due ${humanDate(buyerEmd.due.date)}` : 'required'}`, why: 'No receipt recorded yet.', owner: 'buyer', severity: 'waiting', action: 'chase_emd', requirement: 'emd', at: buyerEmd.due?.at, dateOnly: Boolean(buyerEmd.due) && !buyerEmd.due.time })
    // — seller-contract EMD (ours) —
    if (contractEmd?.state === 'overdue') item('contract_emd_overdue', { what: 'Contract EMD — no deposit recorded', why: `Due ${humanDate(contractEmd.due.date)} under the seller contract.`, owner: 'you', severity: 'overdue', group: 'overdue', action: 'record_contract_emd', at: contractEmd.due.at, dateOnly: !contractEmd.due.time })
    else if (contractEmd?.state === 'due' && contractEmd.dueSoon) item('contract_emd_due', { what: `Contract EMD due ${humanDate(contractEmd.due.date)}`, why: 'Our deposit under the seller contract.', owner: 'you', severity: 'due_soon', group: 'due_soon', action: 'record_contract_emd', at: contractEmd.due.at, dateOnly: !contractEmd.due.time })
    // — buyer —
    if (buyerFailed) item('buyer_failed', { what: 'Buyer fell through', why: `Offer ${offerStatus || commitment}. The deal needs a replacement buyer.`, owner: 'you', severity: 'blocking', group: 'blocking', action: 'replace_buyer', requirement: 'buyer' })
    if (agreement && DEAD_AGREEMENT.has(agreementStatus)) item('agreement_dead', { what: `Buyer agreement ${agreementStatus}`, why: 'No executed buyer contract.', owner: 'you', severity: 'blocking', group: 'blocking', action: 'resend_buyer_agreement', requirement: 'agreement' })
    if (contractExecuted && !offer) item('no_buyer', { what: 'No buyer selected', why: 'Selection happens in Buyer Match; commitment needs an executed agreement.', owner: 'you', severity: 'pending', group: soonWindow ? 'missing' : null, action: 'select_buyer', requirement: 'buyer' })
    if (buyerSelected && !buyerCommitted && !agreement && !buyerFailed) item('no_agreement', { what: 'Buyer agreement not sent', why: 'Selected is not committed — the buyer is bound only by an executed agreement.', owner: 'you', severity: 'pending', group: soonWindow ? 'missing' : null, action: 'send_buyer_agreement', requirement: 'agreement' })
    if (agreement && ['sent', 'viewed', 'counterparty_signed'].includes(agreementStatus)) item('agreement_out', { what: agreementStatus === 'viewed' ? 'Buyer opened the agreement — not signed' : 'Buyer agreement out for signature', why: `Sent ${agreement.sent_at ? humanDate(iso(agreement.sent_at).slice(0, 10)) : ''}`.trim(), owner: 'buyer', severity: 'waiting', action: 'nudge_buyer', requirement: 'agreement', at: iso(agreement.sent_at) })
    // — title —
    if (routeStatus === 'title_route_unavailable' && !clean(c.title_company_email)) item('no_title', { what: 'No title company for this market', why: 'Title cannot open until a company is chosen.', owner: 'you', severity: 'blocking', group: 'blocking', action: 'choose_title', requirement: 'title' })
    for (const i of openIssues) {
      const type = lower(i.issue_type)
      const directed = lower(i.owner) === 'you' && Boolean(c.automation_paused_at)
      item(`title_issue:${i.issue_id}`, { what: `${ISSUE_LABEL[type] || 'Title issue'}${directed ? ': automation paused, needs operator direction' : ''}`, why: `${clean(i.description) ? `${clean(i.description)}. ` : ''}Blocks clear to close until resolved or waived with evidence — never cleared automatically.`, owner: lower(i.owner) || 'title', severity: 'blocking', group: lower(i.owner) === 'you' ? 'human_decision' : 'blocking', action: lower(i.owner) === 'seller' ? 'nudge_seller' : lower(i.owner) === 'you' ? 'resolve_title_issue' : 'email_title', requirement: 'issues', at: iso(i.opened_at), source: clean(i.source) || null })
    }
    const commitmentLate = Boolean(commitmentDue) && commitmentDue.date < today && !commitmentReceived && !clearToClose
    if (commitmentLate) item('title_late', { what: 'Title commitment late', why: `Was due ${humanDate(commitmentDue.date)}.`, owner: 'title', severity: 'overdue', group: 'overdue', action: 'email_title', requirement: 'title', at: commitmentDue.at, dateOnly: !commitmentDue.time })
    else if (commitmentDue && !commitmentReceived && !clearToClose && dayDiff(today, commitmentDue.date) <= 1) item('title_commitment_due', { what: `Title commitment due ${dayDiff(today, commitmentDue.date) === 0 ? 'today' : 'tomorrow'}`, why: 'Not received yet.', owner: 'title', severity: 'due_soon', group: 'due_soon', action: 'email_title', requirement: 'title', at: commitmentDue.at, dateOnly: !commitmentDue.time })
    if (contractExecuted && !clearToClose && !openIssues.length && routeStatus !== 'title_route_unavailable' && (acknowledged || commitmentReceived || titleStatus === 'opened' || c.title_intro_sent_at) && !commitmentLate) {
      item('title_open', { what: commitmentReceived ? 'Clear to close — awaiting title' : acknowledged || titleStatus === 'opened' ? 'Title commitment — awaiting title' : 'Title order — awaiting acknowledgement', why: railOf('title')?.detail, owner: 'title', severity: 'waiting', action: 'email_title', requirement: 'title' })
    }
    // — schedule (unconfirmed) —
    if (when && !confirmed && contractExecuted && !datePassed) item('date_unconfirmed', { what: `Closing date not confirmed — target ${humanDate(when.date)}`, why: 'A target gets no countdown until title confirms it.', owner: 'title', severity: 'waiting', action: 'email_title', requirement: 'schedule', at: when.at, dateOnly: !when.time })
    if (!when && contractExecuted && caseStage !== 'prepared_to_close') item('date_missing', { what: 'No closing date yet', why: 'Set a target or confirm the date with title.', owner: 'you', severity: 'pending', action: 'schedule_closing', requirement: 'schedule' })
    // — proximity: closing within 3 days and not ready —
    if (confirmed && !datePassed && daysOut !== null && daysOut <= 3 && !checklistComplete) {
      const n = openRequirements.length
      item('at_risk', { what: `Closing ${daysOut === 0 ? 'today' : daysOut === 1 ? 'tomorrow' : `in ${daysOut} days`} — ${n} open`, why: openRequirements.map((r) => r.label).join(' · '), owner: 'you', severity: 'due_soon', group: 'due_soon', action: 'review', requirements: openRequirements.map((r) => r.key), at: when.at, dateOnly: !when.time })
    }
    // — settlement —
    if (settlementFailed) item('settlement_failed', { what: `Settlement ${lower(settlementFailed.settlement_status)}`, why: 'Funds did not settle.', owner: 'title', severity: 'blocking', group: 'blocking', action: 'email_title' })
    if (confirmed && !datePassed && daysOut !== null && daysOut <= 3 && !statementRef) item('statement_missing', { what: 'Settlement statement not received', why: `Closing ${daysOut === 0 ? 'today' : `in ${daysOut} day${daysOut === 1 ? '' : 's'}`} — title has not sent the statement.`, owner: 'title', severity: 'due_soon', group: 'missing', action: 'email_title' })
    // — automation —
    for (const [category, e] of activeEscalations) item(`escalated:${category}`, { what: clean(e?.message) || 'Automation escalated', why: 'Routine follow-ups are exhausted; this needs you.', owner: 'you', severity: 'overdue', group: 'human_decision', action: category.startsWith('buyer') ? 'nudge_buyer' : 'email_title', at: iso(e?.at) })
    if (c.automation_paused_at) item('automation_paused', { what: `Automation paused${clean(c.automation_paused_reason) ? ` — ${clean(c.automation_paused_reason)}` : ''}`, why: 'No follow-ups go out for this closing until it is resumed.', owner: 'you', severity: 'pending', group: 'human_decision', action: 'resume_automation', at: iso(c.automation_paused_at), source: clean(c.automation_paused_by) || null })
  }
  // — resolved (recent): the plane shows what cleared, and how —
  if (!terminal) {
    for (const i of arr(titleIssues).filter((x) => ['resolved', 'waived'].includes(lower(x.status)) && recent(iso(x.resolved_at)))) {
      item(`title_issue_resolved:${i.issue_id}`, { what: `${ISSUE_LABEL[lower(i.issue_type)] || 'Title issue'} ${lower(i.status)}`, why: clean(i.resolution_evidence) || null, owner: 'title', severity: 'resolved', at: iso(i.resolved_at), source: clean(i.resolved_by) || null })
    }
    const v = buyerEmd?.state === 'verified' ? buyerEmd.receipt : null
    const reminded = reqsFor('buyer_emd').some((r) => r.status === 'sent')
    if (v?.verifiedAt && recent(v.verifiedAt) && ((buyerEmd.due && v.verifiedAt.slice(0, 10) > buyerEmd.due.date) || reminded)) {
      item('emd_resolved', { what: `Buyer EMD verified${buyerEmd.amount ? ` · ${usd(buyerEmd.amount)}` : ''}`, why: [v.method ? words(v.method) : null, v.evidence].filter(Boolean).join(' · ') || null, owner: 'buyer', severity: 'resolved', at: v.verifiedAt, source: v.verifiedBy })
    }
    for (const [category, e] of resolvedEscalations) if (recent(iso(e?.at))) item(`escalation_resolved:${category}`, { what: `${LOOPS[category]?.label || words(category)} — resolved after escalation`, why: clean(e?.message) || null, owner: 'you', severity: 'resolved', at: iso(e?.at) })
  }
  const SEVERITY_RANK = { blocking: 0, overdue: 1, due_soon: 2, pending: 3, waiting: 4, resolved: 5 }
  const ownedByYou = (i) => (i.owner === 'you' ? 0 : 1)
  items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
  const hard = items.filter((i) => i.severity === 'blocking' || i.severity === 'overdue')
  const ready = checklistComplete && hard.length === 0
  // Compat: the phone's "Blocking this closing" list (what / why / who / next).
  const blockers = hard.map(({ key, what, why, owner, ownerLabel, action }) => ({ key, what, why, owner, ownerLabel, action }))

  /* ── who has the ball, and the one next action ── */
  const firstOpen = rail.find((r) => r.status === 'active' || r.status === 'waiting' || r.status === 'blocked') || null
  const RAIL_LOOPS = {
    title: acknowledged || titleStatus === 'opened' ? (commitmentReceived ? ['clear_to_close'] : ['title_commitment']) : ['title_open', 'title_ack'],
    emd: ['buyer_emd'], agreement: ['buyer_agreement'], buyer: ['buyer_agreement'], settlement: ['settlement'],
  }
  let ball = null
  if (!terminal && !closed) {
    const youFirst = [...hard].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || ownedByYou(a) - ownedByYou(b))
    const escalation = hard.find((i) => i.key.startsWith('escalated:'))
    const top = hard.find((i) => i.severity === 'blocking' && i.owner === 'you') || escalation || youFirst[0] || null
    const atRisk = items.find((i) => i.key === 'at_risk') || null
    if (top) {
      const loopKeys = top.requirement ? RAIL_LOOPS[top.requirement === 'issues' ? 'title' : top.requirement] || [] : []
      ball = { owner: top.owner, what: top.what, why: top.why, action: top.action, at: top.at, dateOnly: top.dateOnly, blocker: true, source: top.key, automation: handlingFor(loopKeys) }
    } else if (ready) {
      if (guard.ok) ball = { owner: 'you', what: 'Finalize the closing', why: 'Every requirement is met and the settlement is recorded — finalize writes the final record (S10).', action: 'finalize', at: null, blocker: false, source: 'finalize' }
      else {
        const settlementHandling = handlingFor(['settlement'])
        ball = { owner: 'title', what: 'Title conducts the closing', why: statementRef ? 'Statement received — waiting for the settled record (funds + final statement).' : 'Settlement statement and funds come from title at closing.', action: 'email_title', at: when?.at || null, blocker: false, source: 'closing', automation: settlementHandling }
      }
    } else if (atRisk) {
      ball = { owner: 'you', what: atRisk.what, why: atRisk.why, action: 'review', at: atRisk.at, blocker: false, source: 'at_risk', requirements: atRisk.requirements }
    } else if (firstOpen) {
      const handling = firstOpen.owner && firstOpen.owner !== 'you' ? handlingFor(RAIL_LOOPS[firstOpen.key] || []) : null
      const systemActs = firstOpen.owner === 'system' && firstOpen.short !== 'Routing'
      if (handling && !handling.held) ball = { owner: 'system', waitingOn: firstOpen.owner === 'system' ? null : firstOpen.owner, what: `${handling.label}${handling.sequence ? ` #${handling.sequence}` : ''}`, why: handling.why, action: firstOpen.action, at: handling.at, blocker: false, source: firstOpen.key, automation: handling }
      else ball = { owner: systemActs && held ? 'you' : firstOpen.owner || 'you', waitingOn: null, what: `${firstOpen.label}: ${firstOpen.detail}`, why: systemActs && held ? `${HELD_TEXT[held]} — nothing is moving this step.` : handling?.held ? `${HELD_TEXT[handling.held]} — ${handling.label.toLowerCase()}${handling.sequence ? ` #${handling.sequence}` : ''} is not going out.` : null, action: firstOpen.action, at: firstOpen.at, blocker: false, source: firstOpen.key, automation: handling }
    }
    if (ball) ball.ownerLabel = OWNER_LABEL[ball.owner] || null
  }
  const next = ball ? { what: ball.what, owner: ball.owner, ownerLabel: ball.ownerLabel, action: ball.action, blocker: ball.blocker } : null

  /* ── state (one label, derived — the first matching rule wins) ── */
  const cancellation = terminal ? describeCancellation() : null
  let state
  if (terminal) state = { key: cancellation.outcome, label: cancellation.label, tone: 'terminated' }
  else if (closed) state = { key: 'closed', label: settled.length ? 'Closed' : 'Closed · settlement record unavailable', tone: 'closed' }
  else if (hard.some((b) => b.key === 'date_passed')) state = { key: 'date_passed', label: 'Closing date passed — not closed', tone: 'blocked' }
  else if (hard.some((b) => b.key === 'emd_overdue')) state = { key: 'emd_overdue', label: 'EMD overdue', tone: 'blocked' }
  else if (hard.length) state = { key: 'blocked', label: 'Blocked', tone: 'blocked' }
  else if (ready) state = { key: 'ready_to_close', label: 'Ready to close', tone: 'ready' }
  else if (items.some((i) => i.key === 'at_risk')) state = { key: 'closing_at_risk', label: 'Closing at risk', tone: 'attention' }
  else if (ball?.owner === 'you') state = { key: 'needs_you', label: 'Needs you', tone: 'attention' }
  else if (ball?.owner === 'system') state = { key: 'system_handling', label: 'System handling', tone: 'active' }
  else if (ball?.owner) state = { key: `waiting_on_${ball.owner}`, label: `Waiting on ${OWNER_LABEL[ball.owner].toLowerCase()}`, tone: 'external' }
  else state = { key: 'on_track', label: 'On track', tone: 'active' }

  function describeCancellation() {
    const correction = provenance.monetary_correction && typeof provenance.monetary_correction === 'object' ? provenance.monetary_correction : null
    const outcome = terminalOutcome || (voided ? 'voided' : contractStatus === 'declined' ? 'declined' : 'cancelled')
    const label = { failed: 'Failed', withdrawn: 'Withdrawn', voided: 'Voided', declined: 'Seller declined' }[outcome] || 'Cancelled'
    const at = iso(c.terminal_at) || iso(provenance.voided_at) || iso(correction?.applied_at) || null
    const reason = clean(c.terminal_reason) || clean(provenance.void_reason) || (correction ? `Monetary correction — ${clean(correction.truth) || clean(correction.correction_id) || 'figures voided'}` : null)
      || (contractStatus === 'declined' ? 'Seller declined the contract (DocuSign)' : contractStatus === 'cancelled' ? 'Contract cancelled' : null)
    const actor = clean(c.terminal_actor) || clean(provenance.voided_by) || clean(correction?.authorized_by) || null
    return { outcome, label, at, atSource: c.terminal_at ? 'terminal_at' : at ? 'provenance' : null, lastUpdatedAt: iso(c.updated_at), reason, actor, lastMilestone: null }
  }

  /* ── money: expected vs actual, never mixed ── */
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
      evidence: clean(s.evidence_reference) || null,
      funding: { status: clean(s.funding_status) || null, fundedAmount: num(s.funded_amount), fundedAt: iso(s.funded_at), disbursedAmount: num(s.disbursed_amount), disbursedAt: iso(s.disbursed_at) },
      recording: { status: clean(s.recording_status) || null, at: iso(s.recorded_at), instrument: clean(s.recording_instrument_id) || null, jurisdiction: clean(s.recording_jurisdiction) || null },
      exception: clean(s.post_close_exception) ? { kind: clean(s.post_close_exception), at: iso(s.post_close_exception_at), note: clean(s.post_close_exception_note) || null } : null,
    })),
    sellerAmount: sum('actual_seller_amount'),
    buyerAmount: sum('actual_buyer_amount'),
    assignmentFee: sum('actual_assignment_fee'),
    closingCosts: sum('actual_closing_costs'),
    otherCosts: sum('actual_other_costs'),
    netProceeds: sum('actual_net_proceeds'),
  } : null
  const variance = (expected, got) => (expected !== null && expected !== undefined && got !== null && got !== undefined ? got - expected : null)
  const comparison = [
    { key: 'purchase', label: 'Purchase (seller)', expected: contractPrice, actual: actual?.sellerAmount ?? null },
    { key: 'sale', label: 'Sale (buyer)', expected: buyerPrice, actual: actual?.buyerAmount ?? null },
    { key: 'fee', label: 'Assignment fee', expected: expectedFee, actual: actual?.assignmentFee ?? null },
  ].filter((r) => r.expected !== null || r.actual !== null).map((r) => ({ ...r, variance: variance(r.expected, r.actual) }))
  const pendingSettlement = !settled.length && settlementLive.length ? settlementLive.map((s) => ({ id: clean(s.settlement_id) || null, leg: clean(s.leg) || null, status: lower(s.settlement_status) || null, funding: lower(s.funding_status) || null, statementType: clean(s.settlement_statement_type) || null, statementRef: clean(s.settlement_statement_reference) || null, provider: clean(s.closing_provider) || null })) : []

  /* ── documents: only real references; status never inferred from upload ── */
  const documents = []
  if (clean(c.docusign_envelope_id) || contractStatus) {
    const map = { fully_executed: 'signed', sent_for_signature: 'awaiting_signature', viewed: 'awaiting_signature', seller_signed: 'awaiting_countersignature', buyer_signed: 'awaiting_signature', draft: 'draft', declined: 'declined', cancelled: 'voided' }
    documents.push({ key: 'purchase_agreement', label: 'Purchase agreement', party: 'Seller', status: map[contractStatus] || 'unknown', source: clean(c.docusign_envelope_id) ? 'DocuSign' : 'Closing case', reference: clean(c.docusign_envelope_id) || null, at: iso(c.contract_signed_date || c.envelope_sent_at), requirement: 'contract' })
  }
  for (const a of arr(agreements)) {
    const map = { fully_executed: 'signed', sent: 'awaiting_signature', viewed: 'awaiting_signature', buyer_signed: 'awaiting_countersignature', counterparty_signed: 'awaiting_signature', draft: 'draft', ready: 'draft', declined: 'declined', voided: 'voided', expired: 'expired', superseded: 'superseded' }
    const type = { assignment_agreement: 'Assignment agreement', purchase_agreement: 'Buyer purchase agreement', novation_agreement: 'Novation agreement' }[lower(a.agreement_type)] || 'Buyer agreement'
    documents.push({ key: `agreement:${clean(a.agreement_id)}`, label: type, party: 'Buyer', status: a.superseded_at ? 'superseded' : map[lower(a.status)] || 'unknown', source: clean(a.provider) || 'Buyer agreements', reference: clean(a.provider_envelope_id) || clean(a.document_payload?.document_reference) || clean(a.agreement_id) || null, version: num(a.agreement_version), at: iso(a.executed_at || a.sent_at || a.created_at), requirement: 'agreement' })
  }
  if (buyerSelected && !agreement) documents.push({ key: 'agreement:missing', label: 'Buyer agreement', party: 'Buyer', status: 'missing', source: null, reference: null, at: null, requirement: 'agreement' })
  for (const r of arr(emdReceipts)) {
    if (!clean(r.evidence_reference)) continue
    const buyerSide = Boolean(r.buyer_id || r.buyer_offer_id || r.buyer_agreement_id)
    documents.push({ key: `emd:${clean(r.receipt_id)}`, label: buyerSide ? 'Buyer EMD receipt' : 'Contract EMD receipt', party: buyerSide ? 'Buyer' : 'You', status: lower(r.status) === 'verified' ? 'verified' : 'received', source: clean(r.verification_method) || clean(r.source) || 'EMD receipts', reference: clean(r.evidence_reference), at: iso(r.verified_at || r.received_at), requirement: 'emd' })
  }
  if (buyerEmd?.state === 'overdue') documents.push({ key: 'emd:missing', label: 'Buyer EMD receipt', party: 'Buyer', status: 'missing', source: null, reference: null, at: null, requirement: 'emd' })
  if (deposit && clean(deposit.detail?.evidence)) documents.push({ key: 'contract_emd_deposit', label: 'Contract EMD deposit', party: 'You', status: 'verified', source: clean(deposit.source) || 'Closing authority', reference: clean(deposit.detail.evidence), at: iso(deposit.detail?.deposited_at || deposit.created_at) })
  for (const s of arr(settlements)) {
    if (clean(s.settlement_statement_reference)) documents.push({ key: `statement:${clean(s.settlement_id)}`, label: { alta: 'ALTA settlement statement', hud1: 'HUD-1', closing_statement: 'Closing statement' }[lower(s.settlement_statement_type)] || 'Settlement statement', party: 'Title', status: lower(s.settlement_status) === 'settled' ? 'final' : 'received', source: clean(s.closing_provider) || 'Settlement records', reference: clean(s.settlement_statement_reference), at: iso(s.closed_at || s.created_at) })
    if (clean(s.recording_evidence_reference) || clean(s.recording_instrument_id)) documents.push({ key: `recording:${clean(s.settlement_id)}`, label: 'Recorded deed', party: 'County', status: lower(s.recording_status) === 'recorded' ? 'final' : 'received', source: clean(s.recording_jurisdiction) || 'Recording', reference: clean(s.recording_instrument_id) || clean(s.recording_evidence_reference), at: iso(s.recorded_at) })
  }
  if (c.title_commitment_received_at) documents.push({ key: 'title_commitment', label: 'Title commitment', party: 'Title', status: 'received', source: clean(c.title_company_name) || 'Title', reference: clean(c.title_commitment_evidence) || null, at: iso(c.title_commitment_received_at), requirement: 'title' })
  else if (commitmentDue && commitmentDue.date < today && !clearToClose && !terminal && !closed) documents.push({ key: 'title_commitment:missing', label: 'Title commitment', party: 'Title', status: 'missing', source: null, reference: null, at: null, requirement: 'title' })
  if (c.clear_to_close_at) documents.push({ key: 'clear_to_close', label: 'Clear-to-close confirmation', party: 'Title', status: 'received', source: clean(c.clear_to_close_source) || 'Title', reference: clean(c.clear_to_close_evidence) || null, at: iso(c.clear_to_close_at), requirement: 'title' })
  if (confirmed && daysOut !== null && daysOut <= 3 && !statementRef && !closed && !terminal) documents.push({ key: 'statement:missing', label: 'Settlement statement', party: 'Title', status: 'missing', source: null, reference: null, at: null })
  if (offer && clean(offer.pof_reference)) documents.push({ key: 'pof', label: 'Proof of funds', party: 'Buyer', status: lower(offer.pof_status) === 'verified' ? 'verified' : 'received', source: clean(offer.pof_verified_by) || 'Buyer offer', reference: clean(offer.pof_reference), at: iso(offer.pof_verified_at) })

  /* ── timeline: canonical history with provenance (not chatter) ── */
  const timeline = []
  const ev = (at, label, source, extra = {}) => { const t = iso(at); if (t) timeline.push({ at: t, label, source, kind: 'event', ...extra }) }
  const milestoneTypes = new Set(arr(milestones).map((m) => lower(m.milestone_type)))
  ev(c.created_at, 'Closing case opened', 'Closing case', { kind: 'origin' })
  ev(c.accepted_at, 'Seller accepted the offer', 'Closing case', { kind: 'milestone' })
  ev(c.envelope_sent_at, 'Contract sent for signature', 'DocuSign')
  if (!milestoneTypes.has('contract_fully_executed')) ev(c.contract_signed_date, 'Contract fully executed', 'DocuSign', { kind: 'milestone' })
  ev(c.title_company_selected_at, `Title routed${clean(c.title_company_name) ? ` · ${clean(c.title_company_name)}` : ''}`, 'Title router')
  ev(c.title_intro_sent_at, 'Title order sent', 'Title intro email')
  if (!milestoneTypes.has('title_opened')) ev(c.title_opened_date, 'Title opened', 'Closing case', { kind: 'milestone' })
  ev(c.title_acknowledged_at, 'Title acknowledged the order', words(c.title_acknowledged_source) || 'Closing authority')
  ev(c.title_commitment_received_at, 'Title commitment received', clean(c.title_commitment_evidence) || 'Closing authority', { kind: 'milestone' })
  if (!milestoneTypes.has('clear_to_close')) ev(c.clear_to_close_at, 'Clear to close', `${words(c.clear_to_close_source) || 'title'}${clean(c.clear_to_close_actor) ? ` · ${clean(c.clear_to_close_actor)}` : ''}`, { kind: 'milestone' })
  for (const i of arr(titleIssues)) {
    ev(i.opened_at, `Title issue opened · ${ISSUE_LABEL[lower(i.issue_type)] || words(i.issue_type)}`, words(i.source) || 'Title')
    if (i.resolved_at) ev(i.resolved_at, `Title issue ${lower(i.status)} · ${ISSUE_LABEL[lower(i.issue_type)] || words(i.issue_type)}`, clean(i.resolved_by) || 'Closing authority')
  }
  for (const a of arr(activity).filter((x) => (x.event_type || x.type) === 'closing_date_changed')) {
    const d = a.detail || {}
    ev(a.created_at || a.at, `Closing ${d.before?.at ? `moved ${humanDate(String(d.before.at).slice(0, 10))} → ${humanDate(String(d.after?.at || '').slice(0, 10))}` : `set ${humanDate(String(d.after?.at || '').slice(0, 10))}`}${d.after?.confirmed ? ' (confirmed)' : ''}`, `${a.source || 'operator'}${d.reason ? ` · ${d.reason}` : ''}`)
  }
  for (const a of arr(activity).filter((x) => ['automation_paused', 'automation_resumed', 'automation_escalated'].includes(x.event_type || x.type))) {
    const type = a.event_type || a.type
    ev(a.created_at || a.at, type === 'automation_paused' ? `Automation paused${a.detail?.reason ? ` · ${a.detail.reason}` : ''}` : type === 'automation_resumed' ? 'Automation resumed' : `Automation escalated · ${clean(a.detail?.message) || words(a.detail?.category)}`, clean(a.actor) || 'closing automation')
  }
  if (terminal && cancellation?.at) ev(cancellation.at, `Closing ${cancellation.label.toLowerCase()}${cancellation.reason ? ` · ${cancellation.reason}` : ''}`, cancellation.actor || 'Closing authority', { kind: 'terminal' })
  const MILESTONE_LABEL = { contract_fully_executed: 'Contract fully executed', title_opened: 'Title opened', escrow_funded: 'Escrow funded', closing_scheduled: 'Closing scheduled', clear_to_close: 'Clear to close', buyer_committed: 'Buyer committed', closed: 'Closed' }
  for (const m of arr(milestones)) ev(m.occurred_at || m.recorded_at, MILESTONE_LABEL[lower(m.milestone_type)] || words(m.milestone_type), `Closing workflow${clean(m.actor) ? ` · ${clean(m.actor)}` : ''}`, { kind: 'milestone' })
  if (offer) {
    ev(offer.submitted_at, 'Buyer offer received', 'Buyer offers')
    ev(offer.selected_at, 'Buyer selected', `Buyer offers${clean(offer.selected_by) ? ` · ${clean(offer.selected_by)}` : ''}`, { kind: 'milestone' })
    if (!milestoneTypes.has('buyer_committed')) ev(offer.committed_at, 'Buyer committed', 'Buyer offers', { kind: 'milestone' })
  }
  for (const a of arr(agreements)) { ev(a.sent_at, 'Buyer agreement sent', clean(a.provider) || 'Buyer agreements'); ev(a.executed_at, 'Buyer agreement executed', clean(a.provider) || 'Buyer agreements', { kind: 'milestone' }) }
  for (const r of arr(emdReceipts)) {
    ev(r.received_at, `EMD received${pos(r.amount) ? ` · ${usd(pos(r.amount))}` : ''}`, clean(r.source) || 'EMD receipts')
    ev(r.verified_at, 'EMD verified', `${clean(r.verified_by) || 'EMD receipts'}${clean(r.verification_method) ? ` · ${words(r.verification_method)}` : ''}`, { kind: 'milestone' })
  }
  if (deposit) ev(deposit.detail?.deposited_at || deposit.created_at, `Contract EMD deposited${pos(deposit.detail?.amount) ? ` · ${usd(pos(deposit.detail.amount))}` : ''}`, clean(deposit.actor) || 'Closing authority')
  if (!milestoneTypes.has('escrow_funded')) ev(c.funding_date, 'Escrow funded', 'Closing case')
  for (const s of arr(settlements)) {
    ev(s.funded_at, 'Funds received', clean(s.closing_provider) || 'Settlement records')
    if (!milestoneTypes.has('closed')) ev(s.closed_at, 'Settled', clean(s.closing_provider) || 'Settlement records', { kind: 'milestone' })
    ev(s.recorded_at, 'Deed recorded', clean(s.recording_jurisdiction) || 'Recording', { kind: 'milestone' })
  }
  if (!milestoneTypes.has('closed') && !arr(settlements).some((s) => s.recorded_at)) ev(c.recording_date, 'Recorded', 'Closing case')
  if (closed && !milestoneTypes.has('closed') && !settled.length) ev(c.closed_at, 'Closed', clean(c.closed_by) || 'Closing case', { kind: 'milestone' })
  if (when && !closed && !terminal) timeline.push({ at: when.at, label: confirmed ? 'Closing' : 'Target closing', source: 'Closing case', kind: 'planned', planned: true })
  timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  if (cancellation) {
    const before = timeline.filter((e) => !e.planned && e.kind !== 'terminal' && e.kind !== 'origin' && (!cancellation.at || e.at <= cancellation.at))
    const last = before[before.length - 1] || null
    cancellation.lastMilestone = last ? { label: last.label, at: last.at } : null
  }

  /* ── deadlines on record: owner + state ──
   * `deadlines` stays the CURRENT deadlines other than the closing date itself
   * (Calendar projects each one from this model as `closing:<case>:<key>`; the
   * closing date is its own event, `closing:<case>:closing_date`). Superseded
   * dates live in `deadlineHistory` so they are never projected as due. */
  const deadlines = []
  const dl = (key, label, field, value, { met, owner }) => {
    const w = describeWhen(value, tz)
    if (!w) return
    const due = w.date
    const dstate = terminal ? 'cancelled' : met ? 'satisfied' : due < today ? 'overdue' : due === today ? 'due_today' : 'upcoming'
    deadlines.push({ key, label, field, ...w, owner, state: dstate, met: Boolean(met), overdue: dstate === 'overdue', calendar: { eventId: `closing:${clean(c.closing_case_id)}:${key}`, date: due } })
  }
  dl('contract_emd', 'Contract EMD due', 'closing_cases.emd_due_date', c.emd_due_date, { met: contractEmd ? emdDone(contractEmd) || contractEmd.state === 'received' : true, owner: 'you' })
  if (offer) dl('buyer_emd', 'Buyer EMD due', 'buyer_offers.emd_due_date', offer.emd_due_date, { met: Boolean(buyerEmd) && (emdDone(buyerEmd) || buyerEmd.state === 'received'), owner: 'buyer' })
  dl('inspection', 'Inspection deadline', 'closing_cases.inspection_deadline', c.inspection_deadline, { met: closed, owner: 'you' })
  dl('title_commitment', 'Title commitment due', 'closing_cases.title_commitment_date', c.title_commitment_date, { met: commitmentReceived || clearToClose, owner: 'title' })
  dl('cure', 'Title cure deadline', 'closing_cases.cure_deadline', c.cure_deadline, { met: clearToClose, owner: 'title' })
  dl('signing', 'Signing', 'closing_cases.signing_date', c.signing_date, { met: closed, owner: 'title' })
  deadlines.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  // Superseded dates: every earlier closing / commitment date kept by the audit trail.
  const deadlineHistory = []
  for (const a of arr(activity).filter((x) => ['closing_date_changed', 'title_commitment_date_set'].includes(x.event_type || x.type))) {
    const d = a.detail || {}
    const beforeAt = typeof d.before === 'object' && d.before ? d.before.at : d.before
    const w = describeWhen(beforeAt, tz)
    if (!w) continue
    const commitmentEvent = (a.event_type || a.type) === 'title_commitment_date_set'
    deadlineHistory.push({ key: `${commitmentEvent ? 'title_commitment' : 'closing'}:superseded:${w.at}`, label: commitmentEvent ? 'Title commitment due' : typeof d.before === 'object' && d.before?.confirmed ? 'Closing' : 'Target closing', field: commitmentEvent ? 'closing_cases.title_commitment_date' : 'closing_cases.scheduled_closing_date', ...w, owner: 'title', state: 'superseded', met: false, overdue: false, supersededAt: iso(a.created_at || a.at), by: clean(a.actor) || null, reason: clean(d.reason) || null })
  }
  deadlineHistory.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

  /* ── automation: runtime, the loop carrying the ball, every request ── */
  const interventions = arr(activity)
    .filter((a) => ['automation_paused', 'automation_resumed', 'closing_date_changed', 'title_commitment_date_set'].includes(a.event_type || a.type) && !AUTOMATION_ACTORS.has(lower(a.actor)))
    .map((a) => ({ type: a.event_type || a.type, actor: clean(a.actor) || null, at: iso(a.created_at || a.at), reason: clean(a.detail?.reason) || null }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
  const automation = {
    paused: Boolean(c.automation_paused_at),
    pausedReason: clean(c.automation_paused_reason) || null,
    pausedAt: iso(c.automation_paused_at),
    pausedBy: clean(c.automation_paused_by) || null,
    runtime: { ...rt, heartbeatStale },
    held,
    state: plan.state,
    handling: ball?.automation || null,
    loops: loops.filter((l) => !['satisfied'].includes(l.state) || l.done > 0),
    escalations: Object.entries(escalations).map(([category, e]) => ({ category, at: iso(e?.at), message: clean(e?.message) || null, reason: clean(e?.reason) || null, active: !satisfied(category) })),
    pendingEmails: requests.filter((r) => ['pending_transport', 'claimed'].includes(r.status)).length,
    emails: [...requests].sort((a, b) => String(b.requested_at || '').localeCompare(String(a.requested_at || ''))).slice(0, 30).map((r) => ({ id: clean(r.id) || clean(r.request_key) || null, action: r.action, category: r.category, label: LOOPS[loopKey(r.category)]?.label || words(r.action), sequence: num(r.sequence), status: r.status, recipientRole: r.recipient_role, requestedAt: iso(r.requested_at), dueAt: iso(r.due_at), claimedAt: iso(r.claimed_at), sentAt: iso(r.sent_at), reason: r.status_reason || null, delivery: r.delivery_status || null, queueId: clean(r.email_queue_id) || null })),
    interventions,
    workflow: { key: 'closing_execution', runId: clean(c.closing_case_id) || null },
  }

  const stageInfo = STAGES[caseStage] || null
  const oppStage = lower(opportunity?.acquisition_stage) || null
  const offerBuyerName = displayableCompanyName(offer?.metadata?.buyer_name || offer?.material_terms?.buyer_name || offer?.metadata?.buyer_company)
  const threadOut = (t) => (t ? { id: clean(t.id) || null, key: clean(t.thread_key) || null, counterparty: clean(t.counterparty_name) || null, email: clean(t.counterparty_email) || null, lastAt: iso(t.last_message_at), direction: clean(t.last_message_direction) || null, preview: clean(t.last_message_preview) || null, lastInboundAt: iso(t.last_inbound_at), lastOutboundAt: iso(t.last_outbound_at), needs: t.needs_operator ? { code: clean(t.needs_code) || null, reason: clean(t.needs_reason) || null } : null, takenOver: t.automation_state === 'taken_over' ? { by: clean(t.taken_over_by) || null, at: iso(t.taken_over_at) } : null } : null)

  const proximity = !terminal && !closed && when && confirmed
    ? (datePassed ? { key: 'passed', label: 'Closing date passed — not closed' }
      : daysOut === 0 ? { key: 'today', label: 'Closing today' }
        : daysOut === 1 ? { key: 'tomorrow', label: 'Closing tomorrow' }
          : daysOut <= 7 ? { key: 'soon', label: `Closing in ${daysOut} days` } : { key: 'scheduled', label: `Closing ${humanDate(when.date)}` })
    : null

  const out = {
    id: clean(c.closing_case_id),
    rowId: clean(c.id) || null,
    opportunityId: clean(c.opportunity_id) || null,
    propertyId: clean(c.property_id) || null,
    masterOwnerId: clean(c.master_owner_id) || null,
    threadKey: clean(c.thread_key) || clean(opportunity?.primary_thread_key) || null,
    property: { address: addressText, ...addr, tz, tzConfident: clean(c.closing_tz) ? true : tzInfo.confident, addressSource: clean(c.property_address) ? 'closing_case' : addressText ? 'property' : null },
    market,
    seller: { name: clean(opportunity?.seller_display_name) || clean(c.signer_name) || null, signerEmail: clean(c.signer_email) || null },
    stage: stageInfo ? { key: caseStage, ...stageInfo, opportunityStage: oppStage, diverged: Boolean(oppStage && oppStage !== caseStage && STAGES[oppStage]) } : null,
    terminal,
    closed,
    ready,
    state,
    group: null,
    closing: when ? { ...when, confirmed, daysOut: confirmed && !closed ? daysOut : null, past: datePassed, source: clean(c.closing_date_source) || null, confirmedAt: iso(c.closing_date_confirmed_at), state: terminal ? 'cancelled' : closed ? 'satisfied' : datePassed ? 'overdue' : daysOut === 0 ? 'due_today' : 'upcoming', calendar: { eventId: `closing:${clean(c.closing_case_id)}:closing_date`, date: when.date } } : null,
    proximity,
    rail,
    requirements,
    readiness: { met: requirements.filter((r) => r.met).length, total: requirements.length },
    items,
    blockers,
    ball,
    next,
    cancellation,
    buyer: offer ? {
      id: clean(offer.buyer_id) || null,
      offerId: clean(offer.buyer_offer_id) || null,
      name: offerBuyerName,
      selected: buyerSelected,
      selectedAt: iso(offer.selected_at),
      selectedBy: clean(offer.selected_by) || null,
      committed: buyerCommitted,
      committedAt: iso(offer.committed_at),
      commitmentStatus: commitment || null,
      commitmentType: clean(offer.commitment_type) || null,
      offerStatus: offerStatus || null,
      strategy: clean(offer.strategy) || null,
      price: buyerPrice,
      closingDate: clean(offer.closing_date) || null,
      pof: { status: lower(offer.pof_status) || null, verifiedAt: iso(offer.pof_verified_at), expiresAt: iso(offer.pof_expires_at) },
      agreement: agreement ? { id: clean(agreement.agreement_id) || null, type: clean(agreement.agreement_type) || null, status: agreementStatus || null, version: num(agreement.agreement_version), executedAt: iso(agreement.executed_at), sentAt: iso(agreement.sent_at), provider: clean(agreement.provider) || null, envelope: clean(agreement.provider_envelope_id) || null } : null,
      thread: threadOut(buyerThread),
    } : null,
    emd: { buyer: buyerEmd, contract: contractEmd },
    title: {
      company: clean(c.title_company_name) || null,
      email: clean(c.title_company_email) || null,
      contact: clean(titleThread?.counterparty_name) || null,
      routeStatus: routeStatus || null,
      routeMarket: clean(c.title_route_market) || null,
      status: titleStatus || null,
      selectedAt: iso(c.title_company_selected_at),
      introSentAt: iso(c.title_intro_sent_at),
      openedAt: iso(c.title_opened_date),
      acknowledgedAt: iso(c.title_acknowledged_at),
      acknowledgedSource: clean(c.title_acknowledged_source) || null,
      commitmentDue,
      commitmentReceivedAt: iso(c.title_commitment_received_at),
      commitmentEvidence: clean(c.title_commitment_evidence) || null,
      clearToClose,
      ctc: clearToClose ? { at: iso(c.clear_to_close_at), source: clean(c.clear_to_close_source) || null, evidence: clean(c.clear_to_close_evidence) || null, actor: clean(c.clear_to_close_actor) || null } : null,
      legacyCtcFlag,
      escrowFile: clean(c.escrow_file_number) || null,
      openIssues: openIssues.length,
      thread: threadOut(titleThread),
    },
    contract: {
      status: contractStatus || null,
      executedAt: iso(c.contract_signed_date),
      sentAt: iso(c.envelope_sent_at),
      acceptedAt: iso(c.accepted_at),
      effectiveAt: iso(c.effective_date),
      signer: clean(c.signer_name) || null,
      price: contractPrice,
      earnestMoney: pos(c.earnest_money),
      envelope: clean(c.docusign_envelope_id) || null,
      docusignStatus: clean(c.docusign_status) || null,
      inspectionDeadline: describeWhen(c.inspection_deadline, tz),
    },
    money: { estimated, actual, expectedFeeVsActual: actual && expectedFee ? { expected: expectedFee, actual: actual.assignmentFee } : null, comparison, pendingSettlement, statementReceived: Boolean(statementRef) },
    documents,
    timeline,
    deadlines,
    deadlineHistory,
    titleIssues: arr(titleIssues).map((i) => ({ id: i.issue_id, type: i.issue_type, label: ISSUE_LABEL[lower(i.issue_type)] || words(i.issue_type), description: i.description || null, status: i.status, owner: i.owner || null, source: i.source || null, evidence: i.evidence_reference || null, notes: i.notes || null, openedAt: iso(i.opened_at), openedBy: clean(i.opened_by) || null, resolvedAt: iso(i.resolved_at), resolvedBy: clean(i.resolved_by) || null, resolution: clean(i.resolution_evidence) || null })),
    automation,
    terminalOutcome,
    // The S10 guard, as finalize_closing will evaluate it (a finalize button shows only when ok).
    finalize: closed || terminal ? null : guard,
    updatedAt: iso(c.updated_at),
    lastActivityAt: iso(c.last_activity_at),
  }
  out.group = groupOf(out)
  return out
}

/**
 * The left-navigation group. Precedence: what needs you, then what closes
 * soonest, then who holds the ball; history last.
 */
export function groupOf(x) {
  if (x.terminal) return 'cancelled'
  if (x.closed) return 'closed'
  if (x.state.tone === 'blocked' || x.state.tone === 'attention') return 'needs_you'
  if (x.closing?.confirmed && x.closing.daysOut === 0) return 'closing_today'
  if (x.closing?.confirmed && x.closing.daysOut !== null && x.closing.daysOut > 0 && x.closing.daysOut <= 7) return 'closing_soon'
  if (x.ready) return 'ready'
  const owner = x.ball?.owner
  if (owner === 'system') return 'system_handling'
  if (['seller', 'buyer', 'title', 'lender'].includes(owner)) return `waiting_${owner}`
  return 'needs_you'
}

/** Portfolio summary — derived from each closing; attention grouped by kind. */
export function summarizePortfolio(items = [], { now = Date.now() } = {}) {
  const active = items.filter((x) => !x.terminal && !x.closed)
  const by = (g) => items.filter((x) => x.group === g).length
  // Next closing = the next FUTURE confirmed closing. A passed date is attention, not "next".
  const upcoming = active.filter((x) => x.closing?.confirmed && !x.closing.past && (x.closing.time ? Date.parse(x.closing.at) > now : true))
    .sort((a, b) => Date.parse(a.closing.at) - Date.parse(b.closing.at))
  const attention = { blocking: [], overdue: [], due_soon: [], missing: [], human_decision: [] }
  for (const x of active) {
    for (const i of x.items || []) {
      if (!i.group || !attention[i.group]) continue
      attention[i.group].push({ closingId: x.id, address: x.property.line || x.property.address, key: i.key, what: i.what, why: i.why, owner: i.owner, severity: i.severity, requirement: i.requirement, requirements: i.requirements, at: i.at, dateOnly: i.dateOnly })
    }
  }
  return {
    counts: {
      active: active.length,
      needsYou: by('needs_you'),
      waitingExternal: active.filter((x) => x.state.tone === 'external').length,
      ready: active.filter((x) => x.ready).length,
      closed: items.filter((x) => x.closed).length,
      cancelled: items.filter((x) => x.terminal).length,
      closingToday: active.filter((x) => x.closing?.confirmed && x.closing.daysOut === 0).length,
      closingSoon: active.filter((x) => x.closing?.confirmed && x.closing.daysOut !== null && x.closing.daysOut > 0 && x.closing.daysOut <= 7).length,
      systemHandling: active.filter((x) => x.ball?.owner === 'system').length,
      blocked: active.filter((x) => x.state.tone === 'blocked').length,
    },
    groups: GROUPS.map((g) => ({ ...g, count: by(g.key) })).filter((g) => g.count > 0),
    nextClosing: upcoming[0] ? { id: upcoming[0].id, address: upcoming[0].property.line || upcoming[0].property.address, closing: upcoming[0].closing, state: upcoming[0].state } : null,
    attention,
  }
}

/**
 * The portfolio row: what the navigation, the status rail and the portfolio
 * view need — nothing more. The room loads the full derivation by id.
 */
export function summarizeClosing(x) {
  return {
    id: x.id,
    rowId: x.rowId,
    opportunityId: x.opportunityId,
    propertyId: x.propertyId,
    masterOwnerId: x.masterOwnerId,
    threadKey: x.threadKey,
    property: x.property,
    market: x.market,
    seller: { name: x.seller.name },
    buyer: x.buyer ? { name: x.buyer.name, selected: x.buyer.selected, committed: x.buyer.committed } : null,
    title: { company: x.title.company, escrowFile: x.title.escrowFile },
    stage: x.stage,
    terminal: x.terminal,
    closed: x.closed,
    ready: x.ready,
    state: x.state,
    group: x.group,
    closing: x.closing,
    proximity: x.proximity,
    readiness: x.readiness,
    requirements: x.requirements.map((r) => ({ key: r.key, label: r.label, met: r.met })),
    items: x.items.filter((i) => i.severity !== 'resolved').slice(0, 6).map(({ key, what, owner, severity, group, requirement, requirements, at, dateOnly }) => ({ key, what, owner, severity, group, requirement, requirements, at, dateOnly })),
    ball: x.ball ? { owner: x.ball.owner, ownerLabel: x.ball.ownerLabel, what: x.ball.what, why: x.ball.why, at: x.ball.at, waitingOn: x.ball.waitingOn || null, automation: x.ball.automation ? { label: x.ball.automation.label, sequence: x.ball.automation.sequence, at: x.ball.automation.at, why: x.ball.automation.why, held: x.ball.automation.held } : null } : null,
    money: { expectedFee: x.money.estimated.assignmentFee?.value ?? null, actualNet: x.money.actual?.netProceeds ?? null, actualFee: x.money.actual?.assignmentFee ?? null, closedAt: x.money.actual?.legs?.[0]?.closedAt ?? null },
    cancellation: x.cancellation,
    automation: { paused: x.automation.paused, held: x.automation.held },
    updatedAt: x.updatedAt,
    lastActivityAt: x.lastActivityAt,
  }
}
