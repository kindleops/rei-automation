/**
 * CONTACT SCORE — the skip-trace vendor's contact score, put on a labelled
 * 0–100 scale.
 *
 * `contact_score_final` (prospects and phones) is imported from the vendor
 * export as-is; on 98% of prospect rows it equals `raw_contact_score`. Its
 * scale is 0–120 (measured 2026-10-10: prospects −1…120, phones 22…120, a
 * third of phones above 100; −1 = not scored). Shown raw with no scale it read
 * as a broken percentage ("Contact score 105"). Displayed here as 0–100 with
 * the vendor value kept visible; it is reachability evidence only — never a
 * pricing input.
 */
export const CONTACT_SCORE_VENDOR_MAX = 120

/** The vendor score on 0–100 (null when absent or the −1 "not scored" sentinel). */
export function contactScore100(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.min(100, Math.round((n / CONTACT_SCORE_VENDOR_MAX) * 100))
}

/** "88/100" — the display value; null when not scored. */
export function contactScoreText(raw: number | string | null | undefined): string | null {
  const s = contactScore100(raw)
  return s === null ? null : `${s}/100`
}

export const CONTACT_SCORE_DEFINITION = 'Skip-trace vendor contact score: how likely this phone / person reaches the owner. Vendor scale 0–120, shown as 0–100.'

/** The definition shown on hover beside every contact score. */
export function contactScoreHint(raw: number | string | null | undefined): string {
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? `${CONTACT_SCORE_DEFINITION} Vendor value ${Math.round(n)} of ${CONTACT_SCORE_VENDOR_MAX}.` : `${CONTACT_SCORE_DEFINITION} Not scored.`
}
