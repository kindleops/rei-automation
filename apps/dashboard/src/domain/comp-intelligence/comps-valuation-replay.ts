/**
 * COMPS — ENGINE VALUATION REPLAY.
 *
 * The acquisition engine values a subject with calculateValuation()
 * (apps/api/src/lib/acquisition/acquisitionDecisionEngine.js):
 *
 *   mid        = Σ(adjusted price × weight) / Σ weight
 *   q25 / q75  = weight-quantiles of the adjusted prices
 *   confidence = 32% depth + 25% weighted comparability score
 *              + 18% weighted data completeness + 20% consistency
 *              + 5% source diversity
 *   low / high = q25 / q75, widened to a confidence-dependent minimum spread
 *
 * This is that function, line for line, so an operator's comp set is priced
 * by the engine's own formula — not a second methodology. It is pinned two
 * ways: unit tests replay the engine's stored production run (5124 Russell
 * Ave N, 12 comps → $263,300 / $294,600 / $319,200, confidence 84), and at
 * runtime the workstation replays the system set and shows whether it
 * reproduces the stored valuation exactly before trusting any delta.
 *
 * What it is NOT: the engine's selection. The engine chooses its set (MAD
 * outlier removal over the whole pool, then the top 12 by weight); a replay
 * prices exactly the set it is given.
 */
import type { CompsWorkspace, EvidenceComp } from './comps-evidence-api'

export interface ReplayInput {
  key: string
  adjustedPrice: number
  weight: number
  score: number
  completeness: number
  saleSource: string | null
}

export interface ReplayComponents {
  depth: number
  compScore: number
  completeness: number
  consistency: number
  sourceDiversity: number
}

export interface ReplayResult {
  low: number
  mid: number
  high: number
  /** rounded, as the engine stores it */
  confidence: number
  /** before rounding — the blend of the components */
  confidenceRaw: number
  count: number
  totalWeight: number
  q25: number
  q75: number
  dispersion: number
  minimumSpread: number
  sourceTypes: Array<string | null>
  components: ReplayComponents
}

const clamp = (v: number | null, min = 0, max = 100) => Math.min(max, Math.max(min, v ?? min))
const roundMoney = (v: number) => Math.round(v / 100) * 100

function weightedAverage(rows: ReplayInput[], value: (r: ReplayInput) => number): number | null {
  let numerator = 0
  let denominator = 0
  for (const r of rows) {
    const v = value(r)
    const w = Math.max(0, r.weight)
    if (!Number.isFinite(v) || w <= 0) continue
    numerator += v * w
    denominator += w
  }
  return denominator > 0 ? numerator / denominator : null
}

function weightedQuantile(rows: ReplayInput[], quantile: number): number | null {
  const sorted = rows
    .map((r) => ({ value: r.adjustedPrice, weight: Math.max(0, r.weight) }))
    .filter((r) => Number.isFinite(r.value) && r.weight > 0)
    .sort((a, b) => a.value - b.value)
  if (!sorted.length) return null
  const total = sorted.reduce((s, r) => s + r.weight, 0)
  const target = total * clamp(quantile, 0, 1)
  let cumulative = 0
  for (const r of sorted) {
    cumulative += r.weight
    if (cumulative >= target) return r.value
  }
  return sorted[sorted.length - 1].value
}

/** Population standard deviation (the engine divides by n). */
function standardDeviation(values: number[]): number {
  const v = values.filter((x) => Number.isFinite(x))
  if (v.length < 2) return 0
  const average = v.reduce((s, x) => s + x, 0) / v.length
  return Math.sqrt(v.reduce((s, x) => s + (x - average) ** 2, 0) / v.length)
}

/**
 * The engine's valuation of exactly these comps. Null when there is nothing
 * to price — the engine then falls back to the property record's estimate,
 * which is not comparable evidence and is never replayed here.
 */
export function replayValuation(inputs: ReplayInput[]): ReplayResult | null {
  // The engine prices its selection in weight order; summation follows it.
  const rows = inputs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.weight - a.r.weight || a.i - b.i)
    .map((x) => x.r)
  if (!rows.length) return null
  const totalWeight = rows.reduce((s, r) => s + r.weight, 0)
  if (!(totalWeight > 0)) return null
  const mid = weightedAverage(rows, (r) => r.adjustedPrice)
  if (mid === null) return null
  const q25 = weightedQuantile(rows, 0.25) ?? mid
  const q75 = weightedQuantile(rows, 0.75) ?? mid
  const dispersion = mid ? standardDeviation(rows.map((r) => r.adjustedPrice)) / mid : 1
  const depth = clamp((rows.length / 8) * 100)
  const compScore = weightedAverage(rows, (r) => r.score) ?? 0
  const completeness = weightedAverage(rows, (r) => r.completeness) ?? 0
  const consistency = clamp(100 - dispersion * 180)
  const sourceTypes = [...new Set(rows.map((r) => r.saleSource))]
  const sourceDiversity = sourceTypes.length >= 2 ? 100 : 70
  const confidenceRaw = clamp(depth * 0.32 + compScore * 0.25 + completeness * 0.18 + consistency * 0.2 + sourceDiversity * 0.05)
  const minimumSpread = 0.05 + ((100 - confidenceRaw) / 100) * 0.08
  const low = Math.min(q25, mid * (1 - minimumSpread))
  const high = Math.max(q75, mid * (1 + minimumSpread))
  return {
    low: roundMoney(low),
    mid: roundMoney(mid),
    high: roundMoney(high),
    confidence: Math.round(confidenceRaw),
    confidenceRaw,
    count: rows.length,
    totalWeight,
    q25,
    q75,
    dispersion,
    minimumSpread,
    sourceTypes,
    components: { depth, compScore, completeness, consistency, sourceDiversity },
  }
}

/** The engine's replay inputs for a comp, when the engine judged it priceable. */
export function replayInputFor(c: EvidenceComp): ReplayInput | null {
  const e = c.engine
  if (!e || !e.eligible) return null
  const adjustedPrice = e.adjustedPrice ?? null
  const weight = e.weight ?? null
  if (adjustedPrice === null || weight === null || !(weight > 0) || !(adjustedPrice > 0)) return null
  return {
    key: c.key,
    adjustedPrice,
    weight,
    score: e.score ?? 0,
    completeness: e.completeness ?? 0,
    saleSource: e.saleSource ?? null,
  }
}

export interface ReplayOfSet {
  result: ReplayResult | null
  /** comps in the set the engine cannot price (excluded, no adjusted price) */
  unpriced: string[]
}

export function replaySet(comps: EvidenceComp[]): ReplayOfSet {
  const inputs: ReplayInput[] = []
  const unpriced: string[] = []
  for (const c of comps) {
    const input = replayInputFor(c)
    if (input) inputs.push(input)
    else unpriced.push(c.key)
  }
  return { result: replayValuation(inputs), unpriced }
}

export type Parity =
  | { state: 'exact' }
  | { state: 'differs'; fields: Array<{ field: 'low' | 'mid' | 'high' | 'confidence'; stored: number; replay: number }> }
  | { state: 'not_comparable'; reason: 'no_stored_valuation' | 'fallback_valuation' | 'nothing_to_replay' }

/**
 * Does replaying the stored system set reproduce the stored valuation? Only
 * when it does is a system → operator delta purely the operator's change.
 */
export function parityWithStored(conclusion: CompsWorkspace['conclusion'], replay: ReplayResult | null): Parity {
  if (!conclusion || conclusion.valueMid === null) return { state: 'not_comparable', reason: 'no_stored_valuation' }
  if (conclusion.method && conclusion.method !== 'weighted_adjusted_comp_value') return { state: 'not_comparable', reason: 'fallback_valuation' }
  if (!replay) return { state: 'not_comparable', reason: 'nothing_to_replay' }
  const fields: Array<{ field: 'low' | 'mid' | 'high' | 'confidence'; stored: number; replay: number }> = []
  const check = (field: 'low' | 'mid' | 'high' | 'confidence', stored: number | null) => {
    if (stored === null) return
    if (stored !== replay[field]) fields.push({ field, stored, replay: replay[field] })
  }
  check('low', conclusion.valueLow)
  check('mid', conclusion.valueMid)
  check('high', conclusion.valueHigh)
  check('confidence', conclusion.valuationConfidence)
  return fields.length ? { state: 'differs', fields } : { state: 'exact' }
}

export interface LeaveOneOut {
  key: string
  result: ReplayResult | null
  deltaMid: number | null
  deltaMidPct: number | null
  deltaConfidence: number | null
  /** the comp's share of the set's total engine weight */
  weightShare: number
}

/**
 * Remove each comp in turn and replay the rest — the same formula, no
 * re-selection (the engine itself would backfill from its pool). Measures how
 * much the valuation depends on each piece of evidence.
 */
export function leaveOneOut(inputs: ReplayInput[]): LeaveOneOut[] {
  const base = replayValuation(inputs)
  const total = inputs.reduce((s, r) => s + r.weight, 0)
  return inputs.map((r) => {
    const rest = inputs.filter((x) => x.key !== r.key)
    const result = replayValuation(rest)
    return {
      key: r.key,
      result,
      deltaMid: base && result ? result.mid - base.mid : null,
      deltaMidPct: base && result && base.mid ? (result.mid - base.mid) / base.mid : null,
      deltaConfidence: base && result ? result.confidence - base.confidence : null,
      weightShare: total > 0 ? r.weight / total : 0,
    }
  })
}

/**
 * The engine's stored outlier band (MAD over its whole pool): an adjusted
 * price outside median ± allowed deviation was rejected as an outlier.
 */
export function outlierBand(run: CompsWorkspace['engineRun']): { low: number; high: number; median: number; allowed: number } | null {
  const o = run?.outlier
  if (!o || o.method !== 'median_absolute_deviation' || o.median === null || o.allowedDeviation === null) return null
  return { low: o.median - o.allowedDeviation, high: o.median + o.allowedDeviation, median: o.median, allowed: o.allowedDeviation }
}
