/**
 * THE CLOSING GUARD — the one rule for whether a deal may become CLOSED-WON.
 *
 * Pure. Evaluated by the closing authority before finalize_closing_case(),
 * which re-checks the financial core under a row lock (and a DB trigger
 * refuses closed-won on any other path). Returns structured blockers — never
 * a vague "cannot close".
 *
 * The rule, audited against the canonical records (not a UI checklist):
 *   seller contract fully executed           closing_cases.contract_status
 *   closing not terminal / voided            terminal_outcome, provenance.voided
 *   buyer committed                          buyer_offers (committed)
 *   buyer agreement executed (assignment /   buyer_agreements.status
 *     novation / double close all use one)
 *   buyer EMD verified, or explicitly not    emd_receipts (verified) /
 *     required (waived with provenance)        buyer_offers.emd_status
 *   no open title issues                     closing_title_issues
 *   title explicitly clear to close          closing_cases.clear_to_close_at (+ provenance CHECK)
 *   closing date confirmed                   closing_cases.closing_date_confirmed_at
 *   every settlement leg settled, ≥ 1 leg    settlement_records (settled requires evidence by CHECK)
 *
 * Deliberately NOT sufficient on their own: a passed closing date, a reason,
 * a selected buyer, an offer's EMD fields, a title commitment, a draft
 * settlement, or expected economics.
 */

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const arr = (v) => (Array.isArray(v) ? v : [])

export const GUARD_CODES = Object.freeze({
  closing_terminated: { message: 'Closing is cancelled / withdrawn / voided', owner: 'you' },
  seller_contract_not_executed: { message: 'Seller contract is not fully executed', owner: 'seller' },
  buyer_not_committed: { message: 'No committed buyer', owner: 'you' },
  buyer_agreement_not_executed: { message: 'Buyer agreement is not executed', owner: 'buyer' },
  emd_not_verified: { message: 'Buyer EMD is not verified (and not waived)', owner: 'buyer' },
  open_title_issues: { message: 'Open title issues', owner: 'title' },
  title_not_clear_to_close: { message: 'Title has not given clear to close', owner: 'title' },
  closing_date_not_confirmed: { message: 'Closing date is not confirmed', owner: 'title' },
  settlement_not_settled: { message: 'No settled settlement record', owner: 'title' },
  settlement_leg_unsettled: { message: 'A settlement leg is still pending or failed', owner: 'title' },
})

const DEAD_OFFER = new Set(['withdrawn', 'rejected', 'superseded', 'defaulted', 'terminated'])

export function evaluateClosingGuard({ closingCase: c = {}, offers = [], agreements = [], emdReceipts = [], settlements = [], titleIssues = [] } = {}) {
  const missing = []
  const add = (code) => { if (!missing.includes(code)) missing.push(code) }

  const voided = Boolean(c.provenance && typeof c.provenance === 'object' && c.provenance.voided === true)
  if (c.terminal_outcome || voided || ['cancelled', 'declined'].includes(lower(c.contract_status))) add('closing_terminated')
  if (lower(c.contract_status) !== 'fully_executed') add('seller_contract_not_executed')

  const live = arr(offers).filter((o) => !DEAD_OFFER.has(lower(o.status)))
  const committed = live.find((o) => lower(o.status) === 'committed' || lower(o.commitment_status) === 'committed') || null
  if (!committed) add('buyer_not_committed')

  const agreement = committed
    ? arr(agreements).find((a) => a.buyer_offer_id === committed.buyer_offer_id && lower(a.status) === 'fully_executed' && !a.superseded_at)
    : null
  if (!agreement) add('buyer_agreement_not_executed')

  if (committed) {
    const waived = lower(committed.emd_status) === 'not_required'
    const verified = arr(emdReceipts).some((r) => r.buyer_offer_id === committed.buyer_offer_id && lower(r.status) === 'verified')
    if (!waived && !verified) add('emd_not_verified')
  } else {
    add('emd_not_verified')
  }

  if (arr(titleIssues).some((i) => ['open', 'in_progress'].includes(lower(i.status)))) add('open_title_issues')
  if (!c.clear_to_close_at) add('title_not_clear_to_close')
  if (!c.closing_date_confirmed_at || !c.scheduled_closing_date) add('closing_date_not_confirmed')

  const legs = arr(settlements)
  if (!legs.some((s) => lower(s.settlement_status) === 'settled')) add('settlement_not_settled')
  if (legs.some((s) => ['pending', 'failed'].includes(lower(s.settlement_status)))) add('settlement_leg_unsettled')

  return {
    ok: missing.length === 0,
    code: missing.length ? 'CLOSING_BLOCKED' : 'CLOSING_ALLOWED',
    missing,
    blockers: missing.map((code) => ({ code, ...GUARD_CODES[code] })),
  }
}
