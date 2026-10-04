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
 * 3. Language holds: a ready seller whose language has no supported template
 *    is refused at send time (`unsupported_language`). Counted with the
 *    renderer's own predicate (targetLanguageHold), never a second rule.
 *
 * Pure functions; the callers own every read.
 */

import { targetLanguageHold } from '@/lib/sms/language_aliases.js'

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
export function sendableAfterPersonalization(sendableNow, senderMarkets = [], personalization = null, languageHolds = null) {
  if (sendableNow === null || sendableNow === undefined || !Number.isFinite(Number(sendableNow))) return null
  if (!personalization && !languageHolds) return Number(sendableNow)
  const sendable = new Set((senderMarkets || []).filter((m) => m && m.sendable !== false).map((m) => clean(m.market)))
  let refused = 0
  for (const [market, count] of Object.entries(personalization?.none_by_market || {})) {
    if (sendable.has(clean(market))) refused += Number(count) || 0
  }
  // language-held sellers whose greeting would render (the rest are already counted above)
  for (const [market, count] of Object.entries(languageHolds?.by_market_unrefused || {})) {
    if (sendable.has(clean(market))) refused += Number(count) || 0
  }
  return Math.max(0, Number(sendableNow) - refused)
}

/**
 * Ready rows the renderer will refuse for language (no supported template).
 *   held                 every language-held ready row
 *   by_language          { Farsi: 6, Thai: 3, Pashto: 1 }
 *   held_and_refused     held rows the greeting lint refuses anyway
 *   by_market            every held row, per market
 *   by_market_unrefused  the rest, per market — what sendableAfterPersonalization subtracts
 * `kinds` (optional, aligned with readyRows) is each row's greeting kind after
 * name hydration; without it the row's own greetingPersonalization is used.
 */
export function summarizeLanguageHolds(readyRows = [], kinds = null) {
  const out = { held: 0, by_language: {}, held_and_refused: 0, by_market: {}, by_market_unrefused: {} }
  const rows = readyRows || []
  for (let i = 0; i < rows.length; i += 1) {
    const language = targetLanguageHold(rows[i])
    if (!language) continue
    out.held += 1
    out.by_language[language] = (out.by_language[language] || 0) + 1
    const rowMarket = clean(rows[i].market) || 'unknown'
    out.by_market[rowMarket] = (out.by_market[rowMarket] || 0) + 1
    const kind = Array.isArray(kinds) && kinds.length === rows.length ? kinds[i] : greetingPersonalization(rows[i])
    if (kind === 'none') out.held_and_refused += 1
    else {
      const market = clean(rows[i].market) || 'unknown'
      out.by_market_unrefused[market] = (out.by_market_unrefused[market] || 0) + 1
    }
  }
  return out
}

/**
 * The sample build's sendable count after language holds (no personalization
 * is measured on the sample): sendable_now minus held rows in sendable markets.
 */
export function sendableAfterLanguageHolds(sendableNow, senderMarkets = [], languageHolds = null) {
  if (!languageHolds) return sendableNow === null || sendableNow === undefined ? null : Number(sendableNow)
  return sendableAfterPersonalization(sendableNow, senderMarkets, null, { by_market_unrefused: languageHolds.by_market || {} })
}
