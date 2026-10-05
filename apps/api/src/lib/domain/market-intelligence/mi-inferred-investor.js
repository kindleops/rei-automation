/**
 * MARKET INTELLIGENCE: the INFERRED-INVESTOR model (owner-based). Pure.
 *
 * Why it exists. "Investor purchases" (investor_purchase_count) counts only sales whose
 * deed names a buyer (~6% of sales). For the rest we still know the property's CURRENT
 * owner of record: whether it is a company or a trust, whether its tax bill is mailed
 * out of state, and how many properties receive their tax bill at the same mailing
 * address. Brief §48 says an LLC owner alone does NOT make a sale an investor purchase,
 * so this model is (a) a SEPARATE, clearly labelled metric, never added to recorded
 * investor purchases, (b) multi-signal and tiered, and (c) published only with its
 * validation against the sales that DO record a buyer.
 *
 * STEP 1 · LINK (mi_owner_link@1). A sale inherits today's owner ONLY when today's owner
 * plausibly IS that sale's buyer:
 *   - the sale is the property's most recent sale in the canonical sales corpus,
 *   - no later transfer exists in the canonical transactions (an event more than
 *     SAME_TRANSACTION_DAYS after the sale; closer events are the same transaction's
 *     duplicate recordings, which the sales MV clusters into one sale),
 *   - the property has an owner snapshot, observed at least RECORDING_LAG_DAYS after the
 *     sale (an earlier snapshot still shows the SELLER).
 *   Older sales whose property later resold never inherit today's owner.
 *
 * STEP 2 · TIER (mi_owner_tier@1), from owner-of-record signals only:
 *   strong        entity owner AND (out-of-state mailing OR ≥ 2 properties at the same
 *                 mailing address), OR ≥ 3 properties at the same mailing address
 *   likely        entity owner (alone), OR out-of-state mailing with 2 properties at the
 *                 same mailing address
 *   trust_estate  a trust / estate owner without a ≥ 3 stack: its own class, NOT investor
 *   absentee_only an individual with out-of-state mailing, no stack: NOT counted
 *   no_signal     an individual with in-state mailing and no stack: NOT investor
 *   (an individual with resident-owner contact evidence is no_signal whatever the stack:
 *    the property is the owner's home)
 *   Inferred investor = strong + likely.
 *
 * What the corpus cannot say (stated, never guessed): in-state absentee owners (the
 * mailing address is held only as a keyed hash, so it cannot be compared with the
 * property address), and owner NAMES for ~99% of the corpus (the owner snapshot carries
 * type flags, not names). A mailing-address cluster is NOT proof of one legal owner:
 * registered agents, management offices and PO boxes group unrelated owners.
 */

export const LINK_RULE = Object.freeze({ id: 'mi_owner_link@1', same_transaction_days: 45, recording_lag_days: 30 })
export const TIER_RULE = Object.freeze({ id: 'mi_owner_tier@1', strong_stack: 3, likely_stack: 2 })

export const TIERS = Object.freeze(['strong', 'likely', 'trust_estate', 'absentee_only', 'no_signal'])
export const INVESTOR_TIERS = Object.freeze(['strong', 'likely'])
export const TIER_LABEL = Object.freeze({
  strong: 'Strong inferred investor',
  likely: 'Likely inferred investor',
  trust_estate: 'Trust / estate owner (own class, not investor)',
  absentee_only: 'Absentee individual, no portfolio (not counted)',
  no_signal: 'Individual owner, no investor signal',
})
export const LINK_REASONS = Object.freeze({
  linked: 'Most recent sale; the current owner of record is its buyer',
  no_property: 'The sale has no property id',
  not_latest_sale: 'The property sold again later; today’s owner is not this sale’s buyer',
  later_transfer: 'A later transfer is recorded; today’s owner is not this sale’s buyer',
  no_owner_record: 'No owner snapshot for the property',
  owner_snapshot_before_sale: 'The owner snapshot predates the sale’s recording; it may still show the seller',
})

const DAY_MS = 86_400_000
const toDay = (v) => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? Math.floor(v) : null
  const t = Date.parse(String(v).slice(0, 10) + 'T00:00:00Z')
  return Number.isFinite(t) ? Math.floor(t / DAY_MS) : null
}

/**
 * Step 1. input: { propertyId, soldOn, isLatestSale, laterTransferOn (date of the latest
 * transfer after the sale, or null), ownerObservedOn (owner snapshot date, or null) }.
 * Dates are ISO strings or epoch days.
 */
export function linkSaleToOwner(s = {}) {
  if (!s.propertyId) return { linked: false, reason: 'no_property' }
  if (s.isLatestSale !== true) return { linked: false, reason: 'not_latest_sale' }
  const sold = toDay(s.soldOn)
  const later = toDay(s.laterTransferOn)
  if (sold !== null && later !== null && later - sold > LINK_RULE.same_transaction_days) return { linked: false, reason: 'later_transfer' }
  const obs = toDay(s.ownerObservedOn)
  if (obs === null) return { linked: false, reason: 'no_owner_record' }
  if (sold === null || obs - sold < LINK_RULE.recording_lag_days) return { linked: false, reason: 'owner_snapshot_before_sale' }
  return { linked: true, reason: 'linked' }
}

/**
 * Step 2. signals: { corporate, trust, outOfState, mailStack (properties sharing the owner's
 * mailing address, ≥ 1; null = no mailing address observed), residentOwner }.
 * Returns { tier, investor, evidence[] } — evidence lists every signal that decided it.
 */
export function classifyOwner(sig = {}) {
  const corporate = sig.corporate === true
  const trust = sig.trust === true
  const oos = sig.outOfState === true
  const stack = Number.isFinite(Number(sig.mailStack)) && Number(sig.mailStack) > 0 ? Math.floor(Number(sig.mailStack)) : 1
  const evidence = []
  if (corporate) evidence.push('entity_owner')
  if (trust) evidence.push('trust_owner')
  if (oos) evidence.push('out_of_state_mailing')
  if (stack >= 2) evidence.push(`mailing_stack_${stack >= TIER_RULE.strong_stack ? '3_plus' : '2'}`)
  if (sig.residentOwner === true) evidence.push('resident_owner_contact')
  const out = (tier) => ({ tier, investor: INVESTOR_TIERS.includes(tier), evidence })

  if (!corporate && sig.residentOwner === true) return out('no_signal')
  if (corporate && (oos || stack >= TIER_RULE.likely_stack)) return out('strong')
  if (stack >= TIER_RULE.strong_stack) return out('strong')
  if (trust && !corporate) return out('trust_estate')
  if (corporate) return out('likely')
  if (oos && stack === TIER_RULE.likely_stack) return out('likely')
  if (oos) return out('absentee_only')
  return out('no_signal')
}

/** Link + tier in one call (the per-sale resolver used by the research and the API). */
export function inferSale(s = {}) {
  const link = linkSaleToOwner(s)
  if (!link.linked) return { ...link, tier: null, investor: false, evidence: [] }
  return { ...link, ...classifyOwner(s) }
}

// ── validation against recorded buyers ───────────────────────────────────

/** Empty tier × recorded matrix. */
export function emptyMatrix() {
  return Object.fromEntries(TIERS.map((t) => [t, { recorded_investor: 0, recorded_other: 0 }]))
}
/** Add one linked sale with a recorded buyer. */
export function addToMatrix(m, tier, recordedInvestor) {
  if (!m[tier]) return m
  m[tier][recordedInvestor ? 'recorded_investor' : 'recorded_other'] += 1
  return m
}
/**
 * Precision / recall of "inferred investor" (strong + likely) against recorded investor
 * buyers, plus per-tier precision. Null where the denominator is 0.
 */
export function validationStats(m) {
  const sum = (tiers, k) => tiers.reduce((t, x) => t + (m[x]?.[k] || 0), 0)
  const tp = sum(INVESTOR_TIERS, 'recorded_investor')
  const fp = sum(INVESTOR_TIERS, 'recorded_other')
  const others = TIERS.filter((t) => !INVESTOR_TIERS.includes(t))
  const fn = sum(others, 'recorded_investor')
  const tn = sum(others, 'recorded_other')
  const n = tp + fp + fn + tn
  const r = (a, b) => (b ? a / b : null)
  return {
    n, tp, fp, fn, tn,
    precision: r(tp, tp + fp), recall: r(tp, tp + fn), accuracy: r(tp + tn, n),
    base_rate: r(tp + fn, n),
    tiers: Object.fromEntries(TIERS.map((t) => {
      const a = m[t]?.recorded_investor || 0
      const b = m[t]?.recorded_other || 0
      return [t, { n: a + b, recorded_investor: a, precision: r(a, a + b) }]
    })),
  }
}

// ── labels ────────────────────────────────────────────────────────────────

const compact = (n) => {
  const x = Math.abs(n)
  if (x >= 1e6) return `${(n / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M`
  if (x >= 1e4) return `${Math.round(n / 1e3)}K`
  if (x >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}
const pct = (v) => `${Math.round(v * 100)}%`

/**
 * The one label every surface uses, e.g.
 * "Inferred investor (owner-based) · 41% of 210K linked sales · validated 87% precision vs recorded buyers".
 */
export function inferredInvestorLabel({ share, linked, precision, validationN } = {}) {
  const parts = ['Inferred investor (owner-based)']
  if (Number.isFinite(share) && linked > 0) parts.push(`${pct(share)} of ${compact(linked)} linked sales`)
  else parts.push(`${compact(linked || 0)} linked sales`)
  if (Number.isFinite(precision) && validationN > 0) parts.push(`validated ${pct(precision)} precision vs recorded buyers`)
  else parts.push('not validated')
  return parts.join(' · ')
}

// ── buyer of record for one sale (comp cards, recent sales, Comp Intelligence) ──

/**
 * The display buyer for one sale. `sale` = { buyer (company name or null), buyer_kind }.
 * `owner` = the step-1 link + owner signals for the sale's property, or null.
 * Privacy (Buyer Match rules): a company is named only when `companyName(name)` returns
 * a displayable company; a person is never named.
 *
 * Returns { label, basis, kind, name|null, linked, reason }:
 *   basis 'recorded_buyer'          the deed names the buyer
 *   basis 'current_owner_of_record' the sale is linked; today's owner is its buyer
 *   basis 'not_on_record'           neither
 */
export function saleBuyerOfRecord(sale = {}, owner = null, companyName = (x) => x) {
  if (sale.buyer || sale.buyer_kind) {
    const name = sale.buyer ? companyName(sale.buyer) : null
    if (name) return { label: name, basis: 'recorded_buyer', kind: 'company', name, linked: Boolean(owner?.linked), reason: 'recorded' }
    if (sale.buyer_kind === 'person') return { label: 'Individual buyer', basis: 'recorded_buyer', kind: 'individual', name: null, linked: Boolean(owner?.linked), reason: 'recorded' }
    return { label: 'Company buyer (name withheld)', basis: 'recorded_buyer', kind: 'company', name: null, linked: Boolean(owner?.linked), reason: 'recorded' }
  }
  if (!owner || !owner.linked) return { label: 'Buyer not on record', basis: 'not_on_record', kind: null, name: null, linked: false, reason: owner?.reason || 'no_owner_record' }
  const ownerName = owner.ownerName ? companyName(owner.ownerName) : null
  let label
  let kind
  if (owner.corporate) { kind = 'company'; label = ownerName || 'Company (name not on record)' }
  else if (owner.trust) { kind = 'trust_estate'; label = ownerName || 'Trust / estate' }
  else if (owner.residentOwner) { kind = 'individual'; label = 'Individual (owner-occupant)' }
  else if (owner.outOfState) { kind = 'individual'; label = 'Individual (absentee · out-of-state mailing)' }
  else { kind = 'individual'; label = 'Individual (occupancy not on record)' }
  return { label: `${label} · current owner of record`, short: label, basis: 'current_owner_of_record', kind, name: kind === 'individual' ? null : ownerName, linked: true, reason: 'linked' }
}
