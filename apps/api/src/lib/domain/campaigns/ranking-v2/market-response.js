// ─── ranking-v2/market-response.js ───────────────────────────────────────────
// Market RESPONSE RATE as bounded CONTEXT (owner rule, 2026-10-07): never an
// unrestricted multiplier, never "Minneapolis +20 forever".
//
// Historical response mixes list, copy, phone quality, identity, timing,
// campaign age, asset mix and sender — so it is only allowed to nudge Layer 4:
//
//   cell        = market × asset lane (sfr | mf | other)
//   rate        = recency-decayed  Σ w·interested / Σ w·delivered
//                 w = 0.5^(age_days / HALF_LIFE_DAYS); outcomes younger than
//                 MATURITY_DAYS are excluded (replies still arriving)
//   shrunk      = (Σw·k + PRIOR_STRENGTH·p_lane) / (Σw·n + PRIOR_STRENGTH)
//                 (empirical Bayes toward the lane's global rate p_lane)
//   cell used   only if Σw·n ≥ MIN_EFFECTIVE_N, else no context (null)
//   points      = clamp(SCALE·(shrunk/p_lane − 1), −CAP, +CAP)
//
// The cap is reported with every ranked row, so its influence is auditable.
// Refit from the funnel each time (it decays) — never persisted as a weight.

export const RESPONSE_CONTEXT = Object.freeze({
  HALF_LIFE_DAYS: 60,
  MATURITY_DAYS: 14,
  PRIOR_STRENGTH: 400,
  MIN_EFFECTIVE_N: 200,
  SCALE: 8,
  CAP: 4,
})

export function responseLane(row = {}) {
  const units = Number(row.units_count)
  const type = String(row.property_type ?? '').toLowerCase()
  if ((Number.isFinite(units) && units >= 2) || /multi|duplex|triplex|apartment/.test(type)) return 'mf'
  if (/single|sfr|residential|townhouse|condo/.test(type) || !type) return 'sfr'
  return 'other'
}

/**
 * @param {{market:string, lane:string, contacted_at:string|Date, interested:boolean}[]} outcomes
 * @returns {Map<string, {market, lane, n_eff, k_eff, raw, shrunk, global, points}>} key `${market}|${lane}`
 */
export function fitMarketResponse(outcomes = [], { now = Date.now(), C = RESPONSE_CONTEXT } = {}) {
  const cells = new Map()
  const lanes = new Map()
  for (const o of outcomes) {
    const t = o.contacted_at instanceof Date ? o.contacted_at.getTime() : Date.parse(o.contacted_at)
    if (!Number.isFinite(t)) continue
    const age = (now - t) / 86_400_000
    if (age < C.MATURITY_DAYS) continue
    const w = 0.5 ** (age / C.HALF_LIFE_DAYS)
    const lane = o.lane || 'sfr'
    const key = `${o.market || '(none)'}|${lane}`
    const c = cells.get(key) || { market: o.market || '(none)', lane, n_eff: 0, k_eff: 0 }
    c.n_eff += w
    c.k_eff += o.interested ? w : 0
    cells.set(key, c)
    const g = lanes.get(lane) || { n: 0, k: 0 }
    g.n += w
    g.k += o.interested ? w : 0
    lanes.set(lane, g)
  }
  const out = new Map()
  for (const [key, c] of cells) {
    const g = lanes.get(c.lane)
    const global = g && g.n > 0 ? g.k / g.n : null
    if (!global || c.n_eff < C.MIN_EFFECTIVE_N) {
      out.set(key, { ...round(c), raw: c.n_eff ? c.k_eff / c.n_eff : null, shrunk: null, global, points: null, reason: !global ? 'no_lane_rate' : 'below_min_effective_n' })
      continue
    }
    const shrunk = (c.k_eff + C.PRIOR_STRENGTH * global) / (c.n_eff + C.PRIOR_STRENGTH)
    const points = Math.max(-C.CAP, Math.min(C.CAP, C.SCALE * (shrunk / global - 1)))
    out.set(key, { ...round(c), raw: c.k_eff / c.n_eff, shrunk, global, points: Math.round(points * 100) / 100, reason: null })
  }
  return out
}

function round(c) {
  return { market: c.market, lane: c.lane, n_eff: Math.round(c.n_eff * 10) / 10, k_eff: Math.round(c.k_eff * 10) / 10 }
}

export function responseContextFor(row, fitted) {
  if (!(fitted instanceof Map)) return null
  return fitted.get(`${row.market || '(none)'}|${responseLane(row)}`) || null
}
