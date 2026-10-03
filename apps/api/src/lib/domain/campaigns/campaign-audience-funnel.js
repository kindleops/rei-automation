/**
 * CAMPAIGN AUDIENCE FUNNEL — the pieces the graph counts can't say on their own.
 *
 * 1. Universe: how many properties the audience's LOCATION alone selects, so
 *    the funnel can show what the targeting filters removed (matched is already
 *    location + filters).
 * 2. Personalization: whether a ready seller has a first name for the greeting.
 *    The render lint refuses a blank greeting ("Hi , this is …"). Measured on the
 *    Composer sample (2026-10-03): a person with no first name on file greets by
 *    the deed name ("Hey Brett A Bublitz"), an entity-owned property with no
 *    representative first name renders blank and is refused (property 273588014,
 *    "Rci Holdings Inc", TEMPLATE_RENDER_LINT_FAILURE).
 *
 * Pure functions; the callers own every read.
 */

const clean = (value) => String(value ?? '').trim()

/** Catalog categories that define WHERE the audience is, not WHO in it. */
export const UNIVERSE_FILTER_CATEGORIES = new Set(['Location & Market', 'Identity & IDs'])

/** True for a filter that selects the location universe (market, ZIP, county, drawn area, pinned ids). */
export function isUniverseFilter(filter = {}, fieldDefinition = null) {
  const field = fieldDefinition || filter.fieldDefinition || null
  if (field?.type === 'geo_area') return true
  const category = clean(field?.category || filter.category)
  return UNIVERSE_FILTER_CATEGORIES.has(category)
}

/**
 * How the greeting will be personalized for one ready target.
 *   first_name  a first name is on file (graph projection or canonical prospect)
 *   deed_name   no first name, an individual owner: greets by the deed name
 *   none        no first name and a company/no owner name: the lint refuses it
 */
export function greetingPersonalization(row = {}) {
  const snapshot = row?.metadata?.candidate_snapshot || {}
  if (clean(row.seller_first_name) || clean(snapshot.seller_first_name)) return 'first_name'
  const corporate = row.is_corporate_owner === true || snapshot.is_corporate_owner === true
  const ownerName = clean(row.owner_name) || clean(snapshot.owner_name)
  if (!corporate && ownerName) return 'deed_name'
  return 'none'
}

/**
 * Personalization counts over ready rows, split by market so a caller can
 * subtract lint refusals only where a sender can actually carry the seller.
 */
export function summarizePersonalization(readyRows = []) {
  const totals = { first_name: 0, deed_name: 0, none: 0 }
  const noneByMarket = {}
  for (const row of readyRows || []) {
    const kind = greetingPersonalization(row)
    totals[kind] += 1
    if (kind === 'none') {
      const market = clean(row.market) || 'unknown'
      noneByMarket[market] = (noneByMarket[market] || 0) + 1
    }
  }
  return { ...totals, none_by_market: noneByMarket }
}

/**
 * Ready sellers a sender can carry AND whose greeting renders: sendable_now
 * minus lint refusals in sendable markets. Null when routing is unknown.
 */
export function sendableAfterPersonalization(sendableNow, senderMarkets = [], personalization = null) {
  if (sendableNow === null || sendableNow === undefined || !Number.isFinite(Number(sendableNow))) return null
  if (!personalization) return Number(sendableNow)
  const sendable = new Set((senderMarkets || []).filter((m) => m && m.sendable !== false).map((m) => clean(m.market)))
  let refused = 0
  for (const [market, count] of Object.entries(personalization.none_by_market || {})) {
    if (sendable.has(clean(market))) refused += Number(count) || 0
  }
  return Math.max(0, Number(sendableNow) - refused)
}
