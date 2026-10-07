// ─── ranking-v2/flags.js ─────────────────────────────────────────────────────
// Acquisition OS §84 — separate flags, no master switch. Both default OFF:
// only an explicit truthy value turns them on, so a deploy with the variable
// unset is dark and behaves byte-identically to the pre-v2 code.
//
//   CAMPAIGN_RANKING_V2  campaign graph build / dedupe / priority_score order
//   SELLER_SCREENER      the read-only Seller Screener + discovery + quality
//                        report APIs (no writes either way)

export const CAMPAIGN_RANKING_V2_FLAG = 'CAMPAIGN_RANKING_V2'
export const SELLER_SCREENER_FLAG = 'SELLER_SCREENER'

function truthy(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'on' || value === 'yes'
}

export function isCampaignRankingV2Enabled(env = process.env) {
  return truthy(env?.[CAMPAIGN_RANKING_V2_FLAG])
}

export function isSellerScreenerEnabled(env = process.env) {
  return truthy(env?.[SELLER_SCREENER_FLAG])
}
