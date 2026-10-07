// ─── ranking-v2/contact-evidence.js ──────────────────────────────────────────
// Ranking v2.1 Layer 1 (CONTACT CONFIDENCE) and the UNKNOWN-semantics rules for
// equity and phone quality (owner rebuild 2026-10-07).
//
//   "First reach the right person. Then prioritize the person most likely to
//    need to sell. Then prioritize the property we can actually make money on."
//
// Every contribution is an evidence item {code, points, source}; unknown is
// reported as unknown (`known:false`), never coerced to 0 or to 100%.

function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function tokens(text) {
  return new Set(String(text ?? '').split(/[;,|]/).map((s) => s.trim().toLowerCase()).filter(Boolean))
}

// ── EQUITY (Layer 3 input) ───────────────────────────────────────────────────
//
// RULE equity_known_v1 — a blank OR zero loan balance is NOT evidence of no
// debt (the graph stores a missing mortgage as 0: 93,803 of 169,797 rows, of
// which 35,880 carry no free-and-clear evidence at all). Equity is KNOWN only:
//   1. loan_balance > 0 and estimated_value > 0  → (value − loan) / value
//   2. loan_balance 0/blank AND the vendor "Free And Clear" flag (DealMachine)
//      AND estimated_value > 0                   → 100%  (provenance vendor_flag)
// Otherwise the percentage is UNKNOWN. A vendor "High Equity" / "Low Equity"
// flag alone gives a CLASS (high / low) without a percentage.
// Class: high ≥ 40%, low < 40%, unknown.
export const EQUITY_HIGH_THRESHOLD = 40

export function equityEvidence(row = {}) {
  const value = num(row.estimated_value)
  const loan = num(row.total_loan_balance)
  const flags = tokens(row.property_flags_text ?? row.podio_tags)
  if (value !== null && value > 0 && loan !== null && loan > 0) {
    const pct = Math.max(-100, Math.min(100, Math.round(((value - loan) / value) * 1000) / 10))
    return { known: true, percent: pct, class: pct >= EQUITY_HIGH_THRESHOLD ? 'high' : 'low', rule: 'loan_and_value', provenance: 'vendor_record' }
  }
  if (value !== null && value > 0 && (loan === null || loan === 0) && flags.has('free and clear')) {
    return { known: true, percent: 100, class: 'high', rule: 'vendor_free_and_clear', provenance: 'vendor_flag' }
  }
  if (flags.has('high equity')) return { known: false, percent: null, class: 'high', rule: 'vendor_high_equity_flag', provenance: 'vendor_flag' }
  if (flags.has('low equity')) return { known: false, percent: null, class: 'low', rule: 'vendor_low_equity_flag', provenance: 'vendor_flag' }
  return { known: false, percent: null, class: 'unknown', rule: 'no_loan_evidence', provenance: null }
}

// ── CONTACT CONFIDENCE (Layer 1) ─────────────────────────────────────────────
//
// IDENTITY TIERS (owner decision 2026-10-07). A missing vendor matching tag is
// ABSENCE of evidence, not negative evidence:
//   strongest      verified identity + positive tag (Likely Owner / Linked To Company)
//   strong         verified + no tag · probable + positive tag ·
//                  entity_company_linked + Linked To Company (entity-owned)
//   moderate       probable + no tag · entity_company_linked + no tag ·
//                  unknown/missing identity + positive tag · verified + weak tag
//                  (Potential Owner / Potentially Linked / Family)
//   weak           unknown identity, no positive tag
//   none           no identity value and no tag at all (nothing recorded)
//   contradictory  identity mismatch, OR an owner-like identity contradicted by
//                  a renter-only tag (Resident / Likely Renting) — always lower
// Then line type (mobile / landline / unknown), 2-month usage, and a shared-
// phone penalty. best_phone_score is 100% NULL in the graph and is never read
// (an empty score is unknown, never 0).
export const IDENTITY_TIER_POINTS = Object.freeze({ strongest: 52, strong: 44, moderate: 34, weak: 14, none: 20, contradictory: 4 })
export const CONTACT_POINTS = Object.freeze({
  line: Object.freeze({ W: 30, L: 4, unknown: 14 }),
  identity_tier: IDENTITY_TIER_POINTS,
  usage: Object.freeze({ 'very heavy usage': 10, 'heavy usage': 10, 'moderate usage': 8, 'light usage': 5, 'minimal usage': 0, missing: 5 }),
  shared_phone_penalty: -15,
  max_raw: 92,
})

/** The contact-matching tag class from prospects.matching_flags (text, ', '-joined). */
export function matchingTagClass(matchingFlags, { entityOwned = false } = {}) {
  if (matchingFlags === null || matchingFlags === undefined || String(matchingFlags).trim() === '') return 'missing'
  const t = tokens(matchingFlags)
  if (t.has('likely owner')) return 'likely_owner'
  if (t.has('linked to company')) return entityOwned ? 'linked_to_company' : 'potential_owner'
  if (t.has('potential owner')) return 'potential_owner'
  if (t.has('potentially linked to company')) return 'potentially_linked_to_company'
  if (t.has('resident') || t.has('likely renting')) return 'renter_no_owner'
  if (t.has('family')) return 'family_only'
  return 'missing'
}

const POSITIVE_TAGS = new Set(['likely_owner', 'linked_to_company'])
const WEAK_TAGS = new Set(['potential_owner', 'potentially_linked_to_company', 'family_only'])

/** identity alignment × matching tag → tier (see table above). */
export function identityTier(identity, tag) {
  const id = String(identity ?? '').trim().toLowerCase()
  const known = ['verified', 'probable', 'entity_company_linked', 'unknown', 'mismatch'].includes(id) ? id : 'missing'
  if (known === 'mismatch') return 'contradictory'
  if (tag === 'renter_no_owner' && (known === 'verified' || known === 'probable' || known === 'entity_company_linked')) return 'contradictory'
  if (known === 'verified') return POSITIVE_TAGS.has(tag) ? 'strongest' : tag === 'missing' ? 'strong' : 'moderate'
  if (known === 'probable') return POSITIVE_TAGS.has(tag) ? 'strong' : 'moderate'
  if (known === 'entity_company_linked') return tag === 'linked_to_company' ? 'strong' : 'moderate'
  if (known === 'unknown') return POSITIVE_TAGS.has(tag) ? 'moderate' : 'weak'
  // identity not recorded
  if (POSITIVE_TAGS.has(tag)) return 'moderate'
  if (tag === 'renter_no_owner') return 'weak'
  if (WEAK_TAGS.has(tag)) return 'weak'
  return 'none'
}

function entityOwned(row) {
  const ot = String(row.owner_type ?? '').toLowerCase()
  return row.is_corporate_owner === true || row.is_corporate_owner === 't' || /corporate|trust|estate|llc/.test(ot)
}

/**
 * @param {object} row graph row (+ optional `matching_flags` from prospects and
 *   `phone_owner_count` = distinct owners sharing this phone)
 */
export function contactConfidence(row = {}) {
  const P = CONTACT_POINTS
  const evidence = []
  let known = 0
  const lt = String(row.phone_type ?? '').trim().toUpperCase()
  const line = lt === 'W' || lt === 'L' ? lt : 'unknown'
  if (line !== 'unknown') known += 1
  evidence.push({ code: line === 'W' ? 'MOBILE_LINE' : line === 'L' ? 'LANDLINE' : 'LINE_TYPE_UNKNOWN', points: P.line[line], source: 'campaign_target_graph.phone_type' })

  const ia = String(row.identity_alignment ?? '').trim().toLowerCase()
  const identity = ['verified', 'probable', 'entity_company_linked', 'unknown', 'mismatch'].includes(ia) ? ia : 'missing'
  const tag = matchingTagClass(row.matching_flags, { entityOwned: entityOwned(row) })
  if (identity !== 'missing') known += 1
  if (tag !== 'missing') known += 1
  const tier = identityTier(identity, tag)
  evidence.push({ code: `IDENTITY_TIER_${tier.toUpperCase()}`, points: P.identity_tier[tier], source: `campaign_target_graph.identity_alignment=${identity} × prospects.matching_flags=${tag}` })

  const usage = String(row.usage_2_months ?? '').trim().toLowerCase()
  const u = usage in P.usage && usage !== 'missing' ? usage : 'missing'
  if (u !== 'missing') known += 1
  evidence.push({ code: u === 'missing' ? 'USAGE_UNKNOWN' : `USAGE_${u.toUpperCase().replace(/\s+/g, '_')}`, points: P.usage[u], source: 'campaign_target_graph.usage_2_months' })

  const shared = num(row.phone_owner_count)
  if (shared !== null) known += 1
  if (shared !== null && shared > 1) evidence.push({ code: 'SHARED_PHONE_AMBIGUOUS', points: P.shared_phone_penalty, source: 'canonical_e164→distinct master_owner_id' })

  const raw = evidence.reduce((acc, e) => acc + e.points, 0)
  const score = Math.max(0, Math.min(100, Math.round((raw / P.max_raw) * 100)))
  return { score, known_signals: known, total_signals: 5, line, identity, tag, identity_tier: tier, evidence }
}

/** Bucket for funnel/quality splits. */
export function contactConfidenceBucket(score) {
  if (score === null || score === undefined) return 'unknown'
  return score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low'
}
