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
// 0–100 from five independent pieces of contact evidence. A missing piece takes
// its documented NEUTRAL value (it is unknown, not bad); explicit negative
// evidence (landline, identity mismatch/unknown, renter-without-ownership,
// shared phone) costs points. best_phone_score is 100% NULL in the graph and
// is never read (an empty score is unknown, never 0).
export const CONTACT_POINTS = Object.freeze({
  line: Object.freeze({ W: 30, L: 4, unknown: 14 }),
  identity: Object.freeze({ verified: 32, probable: 26, entity_company_linked: 20, unknown: 6, mismatch: 0, missing: 12 }),
  tag: Object.freeze({ likely_owner: 20, linked_to_company: 18, potential_owner: 10, potentially_linked_to_company: 8, family_only: 4, renter_no_owner: -14, missing: 7 }),
  usage: Object.freeze({ 'very heavy usage': 10, 'heavy usage': 10, 'moderate usage': 8, 'light usage': 5, 'minimal usage': 0, missing: 5 }),
  shared_phone_penalty: -15,
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

function entityOwned(row) {
  const ot = String(row.owner_type ?? '').toLowerCase()
  return row.is_corporate_owner === true || row.is_corporate_owner === 't' || /corporate|trust|estate|llc/.test(ot)
}

/**
 * @param {object} row graph row (+ optional `matching_flags` from prospects and
 *   `phone_owner_count` = distinct owners sharing this phone in the cohort)
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
  const identity = ia in P.identity && ia !== 'missing' ? ia : 'missing'
  if (identity !== 'missing') known += 1
  evidence.push({ code: `IDENTITY_${identity.toUpperCase()}`, points: P.identity[identity], source: 'campaign_target_graph.identity_alignment' })

  const tag = matchingTagClass(row.matching_flags, { entityOwned: entityOwned(row) })
  if (tag !== 'missing') known += 1
  evidence.push({ code: `TAG_${tag.toUpperCase()}`, points: P.tag[tag], source: 'prospects.matching_flags' })

  const usage = String(row.usage_2_months ?? '').trim().toLowerCase()
  const u = usage in P.usage && usage !== 'missing' ? usage : 'missing'
  if (u !== 'missing') known += 1
  evidence.push({ code: u === 'missing' ? 'USAGE_UNKNOWN' : `USAGE_${u.toUpperCase().replace(/\s+/g, '_')}`, points: P.usage[u], source: 'campaign_target_graph.usage_2_months' })

  const shared = num(row.phone_owner_count)
  if (shared !== null) known += 1
  if (shared !== null && shared > 1) evidence.push({ code: 'SHARED_PHONE_AMBIGUOUS', points: P.shared_phone_penalty, source: 'cohort:canonical_e164→master_owner_id' })

  const raw = evidence.reduce((s, e) => s + e.points, 0)
  const score = Math.max(0, Math.min(100, Math.round((raw / 92) * 100)))
  return { score, known_signals: known, total_signals: 5, line, identity, tag, evidence }
}

/** Bucket for funnel/quality splits. */
export function contactConfidenceBucket(score) {
  if (score === null || score === undefined) return 'unknown'
  return score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low'
}
