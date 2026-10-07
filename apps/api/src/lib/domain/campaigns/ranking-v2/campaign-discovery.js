// ─── ranking-v2/campaign-discovery.js ────────────────────────────────────────
// Acquisition OS §16 / §68 — "Where are the best acquisition campaigns right
// now?"  e.g.  "Dallas 75217 · 143 high-pressure sellers · median equity 61% ·
// strong buyer depth · investor activity high".
//
// Read-only. MI ranks ZIPs by investor/buyer activity; this joins that with
// the seller-situation universe the operator can actually reach. It NEVER
// launches anything (§68): the output is a ranked list the operator opens in
// the Screener / Composer.
//
// FORMULA  zip_discovery_v1 (per ZIP × asset lane, reachable = queue_eligible)
//   pressure_pool  = tier_A + 0.5 · tier_B          (reachable sellers only)
//   discovery      = pressure_pool · (market_quality / 100)
//                    market_quality unknown → 0.5 (neutral, flagged)
//   eligible ZIP   = reachable ≥ MIN_REACHABLE and pressure_pool ≥ 1
//   sort           = discovery desc, high_pressure desc, zip asc
// The PROPOSED SQL view v_campaign_zip_discovery_v1 is the same formula over
// the persisted seller_situation scores once they exist.

import { marketAssetLane } from '@/lib/domain/campaigns/ranking-v2/market-quality.js'
import { contactConfidenceBucket, equityEvidence } from '@/lib/domain/campaigns/ranking-v2/contact-evidence.js'

export const DISCOVERY_VERSION = 'zip_discovery_v1'
export const DISCOVERY_CONSTANTS = Object.freeze({ MIN_REACHABLE: 10, TIER_B_WEIGHT: 0.5, UNKNOWN_MARKET_FACTOR: 0.5 })

function median(values) {
  const v = values.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = v.length >> 1
  return v.length % 2 ? v[mid] : Math.round(((v[mid - 1] + v[mid]) / 2) * 10) / 10
}

function level(score) {
  if (score === null || score === undefined) return 'unknown'
  return score >= 65 ? 'high' : score >= 40 ? 'moderate' : 'low'
}

/** rows + contexts (from buildRowContexts) → ranked ZIP campaigns. */
export function rankDiscoveryZips(rows = [], contexts = [], { limit = 25 } = {}) {
  const C = DISCOVERY_CONSTANTS
  const byKey = new Map()
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const ctx = contexts[i] || {}
    const zip = String(row.property_zip ?? '').slice(0, 5)
    if (!/^\d{5}$/.test(zip)) continue
    const lane = marketAssetLane(row)
    const key = `${zip}|${lane}`
    if (!byKey.has(key)) byKey.set(key, { zip, asset: lane, state: row.state || null, sellers: 0, reachable: 0, tier: { A: 0, B: 0, C: 0, UNKNOWN: 0 }, high_pressure: 0, equity: [], equity_class: { high: 0, low: 0, unknown: 0 }, contact_high: 0, cohort_ready: 0, market: ctx.market || null, market_name: row.market || null })
    const z = byKey.get(key)
    z.sellers += 1
    const reachable = row.queue_eligible === true || row.queue_eligible === 't'
    if (!reachable) continue
    z.reachable += 1
    const tier = ctx.situation?.opportunity_tier
    z.tier[tier === 'A' || tier === 'B' || tier === 'C' ? tier : 'UNKNOWN'] += 1
    // "High-pressure" = acute tier A (≥2 hard distress families, A1). The raw
    // forced-sale component is not calibrated yet (§10), so no FSP cut-off.
    if (tier === 'A') z.high_pressure += 1
    const eq = equityEvidence(row)
    z.equity.push(eq.known ? eq.percent : null) // KNOWN equity only (equity_known_v1)
    z.equity_class[eq.class] += 1
    const contactHigh = contactConfidenceBucket(ctx.rank?.contact_score) === 'high'
    if (contactHigh) z.contact_high += 1
    if (contactHigh && (tier === 'A' || tier === 'B') && eq.class !== 'low') z.cohort_ready += 1
    if (!z.market && ctx.market) z.market = ctx.market
  }
  const out = []
  for (const z of byKey.values()) {
    const pool = z.tier.A + C.TIER_B_WEIGHT * z.tier.B
    if (z.reachable < C.MIN_REACHABLE || pool < 1) continue
    const mq = z.market?.score ?? null
    const factor = mq === null ? C.UNKNOWN_MARKET_FACTOR : mq / 100
    const discovery = Math.round(pool * factor * 10) / 10
    const medianEquity = median(z.equity)
    const buyerDepth = z.market?.terms?.buyer_depth ?? null
    const investor = z.market?.terms?.investor_activity ?? null
    const headlineParts = [
      `${z.market_name || z.state || ''} ${z.zip}`.trim(),
      `${z.high_pressure} high-pressure sellers (tier A)`,
      `${z.tier.B} stacked (tier B) of ${z.reachable} reachable`,
      `${z.contact_high} high-contact-confidence`,
      medianEquity === null ? 'equity % unknown' : `median known equity ${Math.round(medianEquity)}% (n=${z.equity.filter((v) => v !== null).length})`,
      buyerDepth === null ? 'buyer depth not measured' : `${level(buyerDepth) === 'high' ? 'strong' : level(buyerDepth)} buyer depth`,
      investor === null ? null : `investor activity ${level(investor)}`,
    ].filter(Boolean)
    out.push({
      zip: z.zip,
      asset: z.asset,
      market: z.market_name,
      state: z.state,
      sellers_in_graph: z.sellers,
      reachable: z.reachable,
      tiers: z.tier,
      high_pressure: z.high_pressure,
      pressure_pool: pool,
      median_equity_percent_known: medianEquity,
      equity_known: z.equity.filter((v) => v !== null).length,
      equity_class: z.equity_class,
      contact_high: z.contact_high,
      cohort_ready: z.cohort_ready,
      market_quality: mq,
      market_label: z.market?.label ?? 'unknown',
      market_terms: z.market?.terms ?? null,
      market_inputs: z.market?.inputs ?? null,
      market_quality_assumed: mq === null,
      discovery_score: discovery,
      headline: headlineParts.join(' · '),
      provenance: { situation: 'seller_situation_v2 (in-process)', market: z.market?.provenance ?? null },
    })
  }
  out.sort((a, b) => b.discovery_score - a.discovery_score || b.high_pressure - a.high_pressure || a.zip.localeCompare(b.zip))
  return { version: DISCOVERY_VERSION, constants: C, zips: out.slice(0, limit), zips_considered: byKey.size }
}
