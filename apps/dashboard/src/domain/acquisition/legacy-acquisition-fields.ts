/**
 * THE PODIO-ERA ACQUISITION OUTPUT FAMILY.
 *
 * One list, so "stop showing the legacy numbers" is a single edit rather than a
 * hunt through every surface that happens to render a property row.
 *
 * These are OUTPUT columns from the retired Podio-era scoring, carried forward on
 * `properties` by the import. The current acquisition authority
 * (apps/api/src/lib/acquisition/decisionAuthority.js) is explicit about them:
 *
 *   "Deliberately NOT included: cash_offer, final_acquisition_score,
 *    tag_distress_score, deal_strength_score, structured_motivation_score,
 *    ai_score, and the offer_pp* family. Those are Podio-era OUTPUT columns,
 *    never inputs to this engine."
 *
 * and states the invariant plainly:
 *
 *   "Economics come from property_acquisition_scores / its immutable upstream
 *    snapshot, or they are recomputed. There is no legacy fallback."
 *
 * The engine never reads them. Rendering them beside engine output invites the
 * operator to read a heuristic from a retired system as this system's answer —
 * production, 2026-09-14: 104,217 properties carry a screening score and 163 have
 * an engine row, so on 104,054 properties the legacy number was the ONLY number
 * on screen and nothing said it was not the engine's.
 *
 * THE COLUMNS ARE NOT DROPPED. This is a display rule; §9 is explicit that no
 * migration removes historical fields. `properties` keeps every one of them, the
 * importer keeps writing them, and any backend that still depends on one is
 * untouched.
 */

/** Exact column names. */
export const LEGACY_ACQUISITION_FIELDS: readonly string[] = Object.freeze([
  'cash_offer',
  'final_acquisition_score',
  'structured_motivation_score',
  'deal_strength_score',
  'tag_distress_score',
  'ai_score',
  // The per-unit offer derivations — all computed FROM cash_offer.
  'offer_ppsf',
  'offer_ppu',
  'offer_ppbd',
  'offer_ppls',
  'offer_vs_loan',
  'offer_vs_sale_price',
  // Podio's own option payload, which carried the tag-driven scoring inputs.
  'options',
])

const LEGACY_SET = new Set(LEGACY_ACQUISITION_FIELDS)

/** Prefix families that cannot be enumerated exhaustively. */
const LEGACY_PATTERNS: readonly RegExp[] = Object.freeze([
  /^offer_pp/,
  /^podio_/,
])

export function isLegacyAcquisitionField(key: string): boolean {
  if (LEGACY_SET.has(key)) return true
  return LEGACY_PATTERNS.some((pattern) => pattern.test(key))
}

/** Drop every legacy output column from a list of column names. */
export function withoutLegacyAcquisitionFields<T extends string>(keys: readonly T[]): T[] {
  return keys.filter((key) => !isLegacyAcquisitionField(key))
}
