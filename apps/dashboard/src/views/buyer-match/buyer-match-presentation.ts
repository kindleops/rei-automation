/**
 * BUYER-MATCH-MOBILE-LOCK-1 §6/§7/§8/§14/§18 — presenting canonical output.
 *
 * Everything here is a READ of what the match engine already produced. Nothing
 * computes a score, ranks anything, or writes a reason. The routed demo page it
 * replaces did all three: it looped buyers x demo properties building its own
 * `matchScore`, then sorted by it.
 *
 * The engine emits, for every one of its candidates (verified 100% populated on
 * all 350 production rows): `match_score` 57.2-91.4, `match_grade` A/B/C,
 * `reason_for_match` as semicolon-delimited real evidence, `distance_miles`,
 * purchase counts and dates, median price, and `buyer_response_status`.
 */

/**
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so a naive read turns
 * "the engine recorded nothing" into a confident zero. That produced a null
 * score rendering as "0.0" and, worse, a null distance rendering as
 * "Nearest buy 0.0mi" — a fabricated evidence claim that the buyer purchased at
 * this exact property. Absent stays absent.
 */
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export interface BuyerMatchCandidate {
  buyer_match_candidate_id: string
  buyer_entity_id: string
  buyer_name: string | null
  buyer_type: string | null
  total_match_score: number | null
  match_grade: string | null
  reason_for_match: string | null
  buyer_response_status: string | null
  package_sent_at?: string | null
  selected?: boolean | null
  distance_miles?: number | null
  purchase_count?: number | null
  purchase_count_365d?: number | null
  last_purchase_date?: string | null
  median_purchase_price?: number | null
  matched_purchase_count?: number | null
  markets_active?: string[]
  zips_active?: string[]
  preferred_asset_classes?: string[]
  mailing_state?: string | null
}

/**
 * §6 — the grade the engine assigned, in words, with its own score beside it.
 *
 * Deliberately NOT a percentage. The engine emits a 0-100 score and an A/B/C
 * grade; it does not claim "91% likely to buy", so rendering "91% match" would
 * invent an interpretation it never made. Observed bands on production:
 * A 78.7-91.4, B 65.2-79.0, C 57.2-66.3.
 */
export function describeMatchGrade(candidate: BuyerMatchCandidate): {
  label: string
  tone: 'strong' | 'good' | 'fair' | 'unknown'
  score: string | null
} {
  const score = num(candidate.total_match_score)
  const scoreText = score === null ? null : score.toFixed(1)
  const grade = String(candidate.match_grade ?? '').trim().toUpperCase()

  if (grade === 'A') return { label: 'Strong match', tone: 'strong', score: scoreText }
  if (grade === 'B') return { label: 'Good match', tone: 'good', score: scoreText }
  if (grade === 'C') return { label: 'Fair match', tone: 'fair', score: scoreText }
  // A grade the engine did not set is not silently promoted to a good one.
  return { label: grade ? `Grade ${grade}` : 'Ungraded', tone: 'unknown', score: scoreText }
}

/**
 * §8 — the engine's own reasons, split for a mobile card.
 *
 * `reason_for_match` arrives as one semicolon-delimited string with a trailing
 * separator, e.g.
 *   "2 purchase(s) in zip 85033; nearest buy 0.5mi away; active local buyer
 *    (7 nearby purchases); bought in last 6mo; "
 * Splitting and trimming is presentation. No clause is reworded, reordered by
 * importance, or added — the engine's order is kept, because the engine decided
 * it.
 */
export function matchReasons(candidate: BuyerMatchCandidate, limit = 3): string[] {
  const raw = String(candidate.reason_for_match ?? '')
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, Math.max(0, limit))
}

/**
 * §14 — "buyer exists" is not "buyer is active".
 *
 * There is no `is_active` flag on a candidate, so nothing here labels anyone
 * Active. A factual recency marker is used instead, exactly as §14 asks:
 * `Last purchase · Jan 2026`. `purchase_count_365d` is stated only when the
 * engine recorded one.
 */
export function describeActivity(candidate: BuyerMatchCandidate): string | null {
  const last = String(candidate.last_purchase_date ?? '').trim()
  if (!last) {
    const total = num(candidate.purchase_count) ?? 0
    return total > 0 ? `${total} recorded purchase${total === 1 ? '' : 's'}` : null
  }
  const date = new Date(last)
  if (Number.isNaN(date.getTime())) return null
  const when = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(date)
  const trailing = num(candidate.purchase_count_365d) ?? 0
  return trailing > 0
    ? `Last purchase · ${when} · ${trailing} in 12mo`
    : `Last purchase · ${when}`
}

/** Geography the engine actually recorded for the buyer. */
export function describeGeography(candidate: BuyerMatchCandidate): string | null {
  const distance = num(candidate.distance_miles)
  if (distance !== null) {
    const nearby = num(candidate.matched_purchase_count) ?? 0
    return nearby > 0
      ? `Nearest buy ${distance.toFixed(1)}mi · ${nearby} nearby`
      : `Nearest buy ${distance.toFixed(1)}mi`
  }
  const markets = candidate.markets_active ?? []
  if (markets.length) return markets.slice(0, 2).join(', ')
  return candidate.mailing_state ? `Mails to ${candidate.mailing_state}` : null
}

const DISPOSITION_LABELS: Record<string, string> = {
  not_contacted: 'Not contacted',
  contacted: 'Contacted',
  package_sent: 'Package sent',
  interested: 'Interested',
  passed: 'Passed',
  requested_info: 'Requested info',
  offer: 'Offer',
  bid: 'Bid',
  unresponsive: 'No response',
}

/**
 * §18 — canonical disposition only.
 *
 * A candidate row existing does NOT mean the buyer was contacted; the engine
 * writes `buyer_response_status` and every production row currently reads
 * `not_contacted`. An unrecognised value is shown as itself rather than being
 * folded into a friendlier neighbour.
 */
export function describeDisposition(candidate: BuyerMatchCandidate): { label: string; contacted: boolean } {
  const raw = String(candidate.buyer_response_status ?? '').trim().toLowerCase()
  if (!raw) return { label: 'No outreach recorded', contacted: false }
  const label = DISPOSITION_LABELS[raw] ?? raw.replace(/_/g, ' ')
  const contacted = raw !== 'not_contacted'
  return { label, contacted }
}

/**
 * §10 — one canonical buyer, once.
 *
 * The API already scopes to the latest run, and every production run holds
 * exactly 25 rows for 25 distinct `buyer_entity_id`s, so there is nothing to
 * de-duplicate today. This keeps that true if a future run ever repeats an
 * entity: the highest-scoring row wins and the engine's order is preserved.
 */
export function dedupeByBuyerEntity(candidates: BuyerMatchCandidate[]): BuyerMatchCandidate[] {
  const best = new Map<string, BuyerMatchCandidate>()
  for (const candidate of candidates) {
    const key = String(candidate.buyer_entity_id ?? candidate.buyer_match_candidate_id)
    const existing = best.get(key)
    if (!existing || (num(candidate.total_match_score) ?? 0) > (num(existing.total_match_score) ?? 0)) {
      best.set(key, candidate)
    }
  }
  return [...best.values()]
}
