/**
 * DECISION ROOM MODEL — every derived figure the desktop shows, as pure
 * functions over the canonical read model. Nothing here prices a deal: the
 * engine's own numbers are arranged, compared and explained. The two places
 * that compute are labelled as such: the Scenario Lab (the engine's own offer
 * arithmetic, replayed — computeScenarioOffer) and the purchase-price spread
 * (buyer ceiling − price, the engine's own definition of the assignment fee).
 */
import { computeScenarioOffer } from '../../../domain/deal-intelligence/deal-scenario-model'
import type { ScenarioInputs, ScenarioResult } from '../../../domain/deal-intelligence/deal-decision-api'
import { humanize, int, usd } from './di-format'
import { isAvailable, type DiAvailable, type DiDecision, type DiGate, type DiRecordedDocument, type DiSellerFact } from './di-types'

const pos = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
const fin = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export const availableOf = (d: DiDecision | null): DiAvailable | null => (d && isAvailable(d.decision) ? d.decision : null)

/* ══ DECISION STATE ════════════════════════════════════════════════════════ */

export type Tone = 'go' | 'hold' | 'alt' | 'wait' | 'stop' | 'none'

export interface DecisionState {
  analyzed: boolean
  tier: string | null
  label: string
  tone: Tone
  authority: {
    kind: 'may_present' | 'withheld' | 'review' | 'not_evaluated'
    title: string
    detail: string | null
    range: [number, number] | null
  }
  nextMove: string | null
  zone: string | null
  computedAt: string | null
  ageDays: number | null
}

export function decisionState(d: DiDecision): DecisionState {
  const dec = availableOf(d)
  if (!dec) {
    return {
      analyzed: false,
      tier: null,
      label: 'Not analyzed',
      tone: 'none',
      authority: { kind: 'not_evaluated', title: 'No decision on record', detail: 'The decision engine has never priced this property.', range: null },
      nextMove: d.automation?.negotiation?.nextMoveLabel ?? null,
      zone: null,
      computedAt: null,
      ageDays: null,
    }
  }
  const auth = dec.authorization
  const range: [number, number] | null = auth?.authorizedFloor && auth?.authorizedCeiling ? [auth.authorizedFloor, auth.authorizedCeiling] : null
  const nextMoveKey = d.automation?.negotiation?.nextMove ?? null
  let authority: DecisionState['authority']
  if (auth?.presentable === true) {
    authority = { kind: 'may_present', title: 'Automation may present this range', detail: auth.zone ? `Negotiation zone: ${auth.zone}` : null, range }
  } else if (auth?.presentable === false) {
    authority = { kind: 'withheld', title: 'Withheld from the seller', detail: auth.withheldText ?? (auth.withheldReason ? humanize(auth.withheldReason) : null), range }
  } else if (nextMoveKey === 'human_review') {
    authority = { kind: 'review', title: 'Operator review requested', detail: d.automation?.negotiation?.humanReviewReason ? `Reason: ${d.automation.negotiation.humanReviewReason}` : null, range }
  } else {
    authority = { kind: 'not_evaluated', title: 'Authority not evaluated', detail: 'The seller negotiation has not evaluated this decision.', range }
  }
  return {
    analyzed: true,
    tier: dec.tier,
    label: dec.tierLabel ?? humanize(dec.tier) ?? 'Analyzed',
    tone: (dec.tierTone as Tone) ?? 'hold',
    authority,
    nextMove: auth?.nextMove ?? d.automation?.negotiation?.nextMoveLabel ?? null,
    zone: auth?.zone ?? null,
    computedAt: dec.computedAt,
    ageDays: dec.ageDays,
  }
}

/* ══ OFFER FIGURES ═════════════════════════════════════════════════════════ */

export interface OfferFigures {
  engineFloor: number | null
  engineRec: number | null
  buyerCeiling: number | null
  valuationCeiling: number | null
  behaviorBinds: boolean
  authFloor: number | null
  authCeiling: number | null
  minMargin: number | null
  targetMargin: number | null
  /** ceiling − target: the highest price that still keeps the target margin */
  maxForTarget: number | null
  /** ceiling − minimum margin: above it the fee gate would fail */
  maxForMinimum: number | null
  modeledFee: number | null
  ask: number | null
  initialAsk: number | null
  counter: number | null
  currentOffer: number | null
  binding: boolean
  gapToRec: number | null
  gapToAuthCeiling: number | null
}

export function offerFigures(d: DiDecision): OfferFigures {
  const o = d.offer
  const dec = availableOf(d)
  const auth = dec?.authorization ?? null
  const ceiling = pos(o?.effectiveCeiling)
  const minMargin = pos(o?.assignmentMarginFloor) ?? pos(o?.protectedMargin) ?? pos(d.automation?.negotiation?.minimumAssignmentMargin)
  const target = pos(o?.targetMargin)
  const ask = pos(o?.negotiation.ask)
  const rec = pos(o?.recommended)
  const authCeiling = pos(auth?.authorizedCeiling)
  return {
    engineFloor: pos(o?.floor),
    engineRec: rec,
    buyerCeiling: ceiling,
    valuationCeiling: pos(o?.valuationCeiling),
    // The observed-buyer ceiling only matters when it is the lower of the two.
    behaviorBinds: Boolean(ceiling && pos(o?.valuationCeiling) && ceiling < (pos(o?.valuationCeiling) as number) - 100),
    authFloor: pos(auth?.authorizedFloor),
    authCeiling,
    minMargin,
    targetMargin: target,
    maxForTarget: ceiling && target ? ceiling - target : null,
    maxForMinimum: ceiling && minMargin ? ceiling - minMargin : null,
    modeledFee: fin(o?.expectedFee),
    ask,
    initialAsk: pos(o?.negotiation.initialAsk),
    counter: pos(o?.negotiation.counter),
    currentOffer: pos(o?.negotiation.currentOffer),
    binding: Boolean(o?.binding),
    gapToRec: ask && rec ? ask - rec : null,
    gapToAuthCeiling: ask && authCeiling ? ask - authCeiling : null,
  }
}

/* ══ SCALES ════════════════════════════════════════════════════════════════ */

export interface Tick { v: number; at: number; label: string }

/** Round ticks: 4–8 labels across the domain, at 1/2/2.5/5 × 10ⁿ steps. */
export function niceTicks(min: number, max: number, target = 6): Tick[] {
  if (!(max > min)) return []
  const raw = (max - min) / target
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  const out: Tick[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-6; v += step) out.push({ v, at: (v - min) / (max - min), label: usd(v) ?? '' })
  return out
}

const placeOn = (min: number, max: number) => (v: number | null | undefined) => {
  if (v === null || v === undefined || !Number.isFinite(v) || !(max > min)) return { at: null as number | null, clamped: false }
  const raw = (v - min) / (max - min)
  return { at: Math.max(0, Math.min(1, raw)), clamped: raw < 0 || raw > 1 }
}

/* ══ VALUATION SPECTRUM ════════════════════════════════════════════════════ */

export type MarkerClass = 'engine' | 'record' | 'seller' | 'offer' | 'authorized' | 'ceiling' | 'mls' | 'binding' | 'scenario'

export interface SpectrumMarker {
  key: string
  label: string
  value: number
  at: number
  clamped: boolean
  cls: MarkerClass
  /** provenance word under the value */
  basis: string
}

export interface SpectrumModel {
  min: number
  max: number
  ticks: Tick[]
  supported: { low: number; high: number; from: number; to: number } | null
  engine: { value: number; at: number } | null
  compRange: { low: number; high: number; from: number; to: number; clamped: boolean } | null
  comps: Array<{ id: string; value: number; at: number; weight: number; clamped: boolean }>
  offer: { floor: number; rec: number; from: number; to: number } | null
  authorized: { floor: number; ceiling: number; from: number; to: number } | null
  minimumBoundary: { value: number; at: number } | null
  markers: SpectrumMarker[]
}

/**
 * Everything priced, on one axis. The server's scale (bounded to the
 * valuation neighbourhood, outliers clamped to the edge and flagged) is used
 * when present so phone and desktop agree; comp dots and the authorized band
 * are placed on that same scale.
 */
export function spectrumModel(d: DiDecision): SpectrumModel | null {
  const v = d.valuation
  const f = offerFigures(d)
  const s = v?.spectrum
  let min = s?.min ?? null
  let max = s?.max ?? null
  if (min === null || max === null) {
    const vals = [v?.low, v?.mid, v?.high, v?.avm, f.engineFloor, f.engineRec, f.buyerCeiling, f.ask].filter((x): x is number => typeof x === 'number' && x > 0)
    if (vals.length < 2) return null
    const lo = Math.min(...vals)
    const hi = Math.max(...vals)
    const pad = (hi - lo) * 0.08 || hi * 0.1
    min = Math.max(0, lo - pad)
    max = hi + pad
  }
  const place = placeOn(min, max)
  const markers: SpectrumMarker[] = []
  const add = (key: string, label: string, value: number | null, cls: MarkerClass, basis: string) => {
    if (!value) return
    const p = place(value)
    if (p.at === null) return
    markers.push({ key, label, value, at: p.at, clamped: p.clamped, cls, basis })
  }
  add('engine', 'Engine value', pos(v?.mid), 'engine', 'modeled · weighted comps')
  add('avm', 'AVM', pos(v?.avm), 'record', 'record · provider estimate')
  add('ask', 'Seller ask', f.ask, 'seller', 'seller said')
  add('recommended', 'Engine offer', f.engineRec, 'offer', 'modeled · recommendation')
  add('ceiling', 'Buyer ceiling', f.buyerCeiling, 'ceiling', 'modeled exit')
  add('mls', 'MLS list', pos(d.subject.mls?.listPrice), 'mls', 'MLS')
  add('binding', 'Our offer', f.binding ? f.currentOffer : null, 'binding', 'binding offer')
  add('counter', 'Seller counter', f.counter, 'seller', 'seller said')

  const sup = pos(v?.low) && pos(v?.high) ? { low: v!.low as number, high: v!.high as number } : null
  const compsLow = pos(v?.compLow)
  const compsHigh = pos(v?.compHigh)
  const cl = place(compsLow)
  const ch = place(compsHigh)
  const offerFrom = place(f.engineFloor)
  const offerTo = place(f.engineRec)
  const aFrom = place(f.authFloor)
  const aTo = place(f.authCeiling)
  const mb = place(f.maxForMinimum)
  return {
    min,
    max,
    ticks: niceTicks(min, max, 7),
    supported: sup ? { ...sup, from: place(sup.low).at ?? 0, to: place(sup.high).at ?? 1 } : null,
    engine: pos(v?.mid) ? { value: v!.mid as number, at: place(v!.mid).at ?? 0 } : null,
    compRange: compsLow && compsHigh && cl.at !== null && ch.at !== null ? { low: compsLow, high: compsHigh, from: cl.at, to: ch.at, clamped: cl.clamped || ch.clamped } : null,
    comps: (d.comps?.top ?? [])
      .map((c, i) => {
        const value = pos(c.adjustedValue) ?? pos(c.salePrice)
        const p = place(value)
        return value && p.at !== null ? { id: c.id ?? `comp-${i}`, value, at: p.at, weight: fin(c.weight) ?? 0, clamped: p.clamped } : null
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x)),
    offer: f.engineFloor && f.engineRec && offerFrom.at !== null && offerTo.at !== null ? { floor: f.engineFloor, rec: f.engineRec, from: offerFrom.at, to: offerTo.at } : null,
    authorized: f.authFloor && f.authCeiling && aFrom.at !== null && aTo.at !== null ? { floor: f.authFloor, ceiling: f.authCeiling, from: aFrom.at, to: aTo.at } : null,
    minimumBoundary: f.maxForMinimum && mb.at !== null && !mb.clamped ? { value: f.maxForMinimum, at: mb.at } : null,
    markers: markers.sort((a, b) => a.at - b.at),
  }
}

/**
 * Label lanes: 0 = first row above, 1 = first row below, 2 / 3 = outer rows.
 * A marker takes the first lane whose last label ends far enough to its left.
 */
export function layoutLanes(markers: ReadonlyArray<{ at: number }>, widthPx: number, labelPx = 104): number[] {
  const last = [-Infinity, -Infinity, -Infinity, -Infinity]
  const gap = labelPx / Math.max(1, widthPx)
  return markers.map((m) => {
    let lane = last.findIndex((x) => m.at - x >= gap)
    if (lane < 0) lane = last.indexOf(Math.min(...last))
    last[lane] = m.at
    return lane
  })
}

/* ══ OFFER TRACK (the negotiation band, zoomed) ════════════════════════════ */

export interface OfferTrack {
  min: number
  max: number
  ticks: Tick[]
  zones: Array<{ key: 'target' | 'minimum' | 'below' | 'over'; from: number; to: number; label: string }>
  engine: { from: number; to: number } | null
  authorized: { from: number; to: number } | null
  pins: Array<{ key: string; label: string; value: number; at: number; cls: MarkerClass; offScale: 'left' | 'right' | null }>
}

export function offerTrack(f: OfferFigures, scenario?: { rec: number; floor: number; ceiling: number } | null, extra: ReadonlyArray<{ key: string; label: string; value: number; cls: MarkerClass }> = []): OfferTrack | null {
  const core = [f.engineFloor, f.engineRec, f.buyerCeiling, f.authFloor, f.authCeiling, f.currentOffer, f.counter, scenario?.rec, scenario?.floor, scenario?.ceiling, ...extra.map((e) => e.value)]
    .filter((x): x is number => typeof x === 'number' && x > 0)
  if (core.length < 2) return null
  let lo = Math.min(...core)
  let hi = Math.max(...core)
  const span = hi - lo || hi * 0.2
  // An ask within reach widens the band; a far ask stays an off-scale pin.
  if (f.ask && f.ask > hi && f.ask - hi <= span * 1.25) hi = f.ask
  if (f.ask && f.ask < lo && lo - f.ask <= span * 1.25) lo = f.ask
  const pad = (hi - lo) * 0.1
  const min = Math.max(0, lo - pad)
  const max = hi + pad
  const at = (v: number) => (v - min) / (max - min)
  const clampAt = (v: number) => Math.max(0, Math.min(1, at(v)))
  const zones: OfferTrack['zones'] = []
  const ceiling = scenario?.ceiling ?? f.buyerCeiling
  const target = f.targetMargin
  const minimum = f.minMargin
  if (ceiling) {
    const tBound = target ? ceiling - target : null
    const mBound = minimum ? ceiling - minimum : null
    const z = (key: OfferTrack['zones'][number]['key'], a: number, b: number, label: string) => {
      const from = clampAt(a)
      const to = clampAt(b)
      if (to > from) zones.push({ key, from, to, label })
    }
    if (tBound !== null) z('target', min, tBound, `Keeps the ${usd(target)} target margin`)
    if (tBound !== null && mBound !== null) z('minimum', tBound, mBound, `Clears the ${usd(minimum)} minimum, below target`)
    else if (mBound !== null) z('minimum', min, mBound, `Clears the ${usd(minimum)} minimum`)
    if (mBound !== null) z('below', mBound, ceiling, `Below the ${usd(minimum)} minimum margin`)
    z('over', ceiling, max, 'Above the buyer ceiling — no assignment spread')
  }
  const pins: OfferTrack['pins'] = []
  const pin = (key: string, label: string, value: number | null, cls: MarkerClass) => {
    if (!value) return
    const raw = at(value)
    pins.push({ key, label, value, at: Math.max(0, Math.min(1, raw)), cls, offScale: raw < 0 ? 'left' : raw > 1 ? 'right' : null })
  }
  pin('recommended', 'Engine offer', f.engineRec, 'offer')
  pin('floor', 'Engine floor', f.engineFloor, 'offer')
  pin('ceiling', 'Buyer ceiling', f.buyerCeiling, 'ceiling')
  pin('ask', 'Seller ask', f.ask, 'seller')
  pin('counter', 'Seller counter', f.counter, 'seller')
  if (f.binding) pin('binding', 'Our offer', f.currentOffer, 'binding')
  for (const e of extra) pin(e.key, e.label, e.value, e.cls)
  return {
    min,
    max,
    ticks: niceTicks(min, max, 5),
    zones,
    engine: f.engineFloor && f.engineRec ? { from: clampAt(f.engineFloor), to: clampAt(f.engineRec) } : null,
    authorized: f.authFloor && f.authCeiling ? { from: clampAt(f.authFloor), to: clampAt(f.authCeiling) } : null,
    pins,
  }
}

/* ══ CONFIDENCE DECOMPOSITION ══════════════════════════════════════════════ */

export interface ConfidenceRow {
  key: 'valuation' | 'subject' | 'buyer' | 'finance'
  label: string
  score: number | null
  weight: number
  contribution: number | null
  lost: number | null
  notes: string[]
  missing: string[]
}

export interface ConfidenceModel {
  overall: number | null
  uncapped: number | null
  cap: number | null
  capReason: string | null
  formula: string | null
  rows: ConfidenceRow[]
  largest: ConfidenceRow | null
  secondary: ConfidenceRow | null
}

const DEFAULT_WEIGHTS = { valuation: 0.45, subject: 0.2, buyer: 0.2, finance: 0.15 }

/** "45% valuation + 20% subject completeness + …" → weights, so the bars follow the engine's own formula. */
export function weightsFromFormula(formula: string | null | undefined): typeof DEFAULT_WEIGHTS {
  const out = { ...DEFAULT_WEIGHTS }
  if (!formula) return out
  for (const m of formula.matchAll(/(\d+(?:\.\d+)?)%\s*([a-z/ ]+?)(?=\s*\+|$)/gi)) {
    const w = Number(m[1]) / 100
    const name = m[2].toLowerCase()
    if (name.includes('valuation')) out.valuation = w
    else if (name.includes('subject')) out.subject = w
    else if (name.includes('buyer')) out.buyer = w
    else if (name.includes('finance') || name.includes('distress')) out.finance = w
  }
  return out
}

export function confidenceModel(d: DiDecision): ConfidenceModel | null {
  const dec = availableOf(d)
  const cb = dec?.confidenceBreakdown
  if (!dec || !cb) return null
  const w = weightsFromFormula(cb.formula)
  const inv = dec.investorEvidence
  const c = d.comps
  const riskKeys = new Set(d.risks.map((r) => r.key))
  const valuationNotes = [
    c ? `${c.selected} qualified comp${c.selected === 1 ? '' : 's'}${c.dispersion !== null ? ` · ${Math.round(c.dispersion * 100)}% spread` : ''}` : null,
    riskKeys.has('valuation_disagreement') ? 'Engine value and AVM disagree' : null,
    riskKeys.has('thin_comps') || riskKeys.has('no_comps') ? 'Thin comp coverage' : null,
  ].filter(Boolean) as string[]
  const buyerNotes = inv
    ? [inv.local !== null ? `${int(inv.local)} nearby investor purchase${inv.local === 1 ? '' : 's'}` : null, inv.distinctBuyers !== null ? `${inv.distinctBuyers} distinct buyers` : null, inv.method].filter(Boolean) as string[]
    : []
  const mk = (key: ConfidenceRow['key'], label: string, score: number | null, notes: string[], missing: string[]): ConfidenceRow => ({
    key, label, score, weight: w[key], notes, missing,
    contribution: score === null ? null : Math.round(score * w[key] * 10) / 10,
    lost: score === null ? null : Math.round((100 - score) * w[key] * 10) / 10,
  })
  const rows = [
    mk('valuation', 'Valuation', cb.valuation, valuationNotes, []),
    mk('subject', 'Subject data', cb.subject, [], cb.subjectMissing ?? []),
    mk('buyer', 'Buyer behavior', cb.buyer, buyerNotes, []),
    mk('finance', 'Finance & distress', cb.finance, [], cb.financeMissing ?? (cb.subjectMissing ? [] : cb.missing)),
  ]
  const ranked = rows.filter((r) => r.lost !== null).sort((a, b) => (b.lost ?? 0) - (a.lost ?? 0))
  return {
    overall: dec.confidence,
    uncapped: cb.uncapped ?? null,
    cap: cb.cap ?? null,
    capReason: cb.capReason ?? null,
    formula: cb.formula,
    rows,
    largest: ranked[0] && (ranked[0].lost ?? 0) > 0 ? ranked[0] : null,
    secondary: ranked[1] && (ranked[1].lost ?? 0) > 0 ? ranked[1] : null,
  }
}

/* ══ HARD GATES ════════════════════════════════════════════════════════════ */

export interface GateView extends DiGate {
  display: string
  gapText: string | null
  definition: string
  why: string
  change: string
}

const fmtMetric = (v: number | null | undefined, unit: DiGate['unit']) => (v === null || v === undefined ? '—' : unit === 'usd' ? usd(v) ?? '—' : int(v) ?? '—')

const GATE_COPY: Record<string, { definition: string; why: string }> = {
  comp_count_at_least_4: { definition: 'At least 4 comparable sales survive the engine’s screens and price the valuation.', why: 'With fewer, one or two sales carry the value, so the engine will not name a firm number on its own.' },
  valuation_confidence_at_least_80: { definition: 'The engine’s confidence in its own valuation — comp agreement, recency, distance and data completeness.', why: 'A hard offer commits to one number. Below 80 the value is not firm enough to commit automatically.' },
  confidence_at_least_85: { definition: 'Overall decision confidence: the weighted blend of valuation, subject data, buyer behavior and finance/distress completeness.', why: 'The bar for the machine to make a binding offer without a person.' },
  assignment_fee_meets_minimum_economics: { definition: 'The modeled assignment spread (buyer ceiling − our offer) must reach the minimum margin.', why: 'Below the minimum the deal does not pay for itself.' },
  assignment_fee_meets_target: { definition: 'Recorded by an earlier engine rule that compared the modeled fee with the target margin rather than the minimum.', why: 'Same economics question; re-analysis would evaluate it under the current minimum-economics rule.' },
  recommended_offer_available: { definition: 'The engine produced a positive cash offer.', why: 'Without one there is nothing to present.' },
  aos_at_least_780: { definition: 'Acquisition opportunity score (0–1,000): margin, valuation strength, buyer demand, distress, liquidity, equity and strategy optionality.', why: 'The engine’s bar for an automated hard offer.' },
}

export function gateViews(d: DiDecision): GateView[] {
  const dec = availableOf(d)
  if (!dec) return []
  const conf = confidenceModel(d)
  const aos = dec.aosComposition
  const headroom = aos ? [...aos.components].sort((a, b) => (b.max - b.points) - (a.max - a.points)).slice(0, 2).map((c) => `${c.label.toLowerCase()} (${Math.round(c.points)}/${c.max})`) : []
  const c = d.comps
  const f = offerFigures(d)
  const change: Record<string, string> = {
    comp_count_at_least_4: c && c.rejected !== null ? `More recent nearby sales of the same asset type. ${c.raw ?? '—'} candidates were screened; ${c.rejected} were rejected.` : 'More recent nearby sales of the same asset type, then re-analysis.',
    valuation_confidence_at_least_80: `Tighter comp agreement${c?.dispersion !== null && c?.dispersion !== undefined ? ` (spread now ${Math.round(c.dispersion * 100)}%)` : ''}, closer or more recent sales, and condition facts that settle the repair estimate.`,
    confidence_at_least_85: conf?.largest ? `Raise the weakest component — ${conf.largest.label.toLowerCase()} is costing ${conf.largest.lost} points.` : 'Raise the weakest confidence component.',
    assignment_fee_meets_minimum_economics: f.maxForMinimum ? `A purchase price at or below ${usd(f.maxForMinimum)}, a higher buyer ceiling (value) or lower repairs.` : 'A lower purchase price, a higher value or lower repairs.',
    assignment_fee_meets_target: 'Re-analysis under the current engine.',
    recommended_offer_available: 'A value high enough that the buyer ceiling exceeds the margin.',
    aos_at_least_780: headroom.length ? `Most headroom: ${headroom.join(', ')}.` : 'Margin, valuation strength and buyer demand drive it most.',
  }
  return dec.gates.map((g) => {
    const key = g.canonicalKey && !g.legacy ? g.canonicalKey : g.key
    const copy = GATE_COPY[g.key] ?? GATE_COPY[key] ?? { definition: g.label, why: '' }
    const hasValues = g.current !== null && g.current !== undefined && g.threshold !== null && g.threshold !== undefined
    const cmp = g.comparator === '>' ? '>' : '≥'
    const display = !hasValues
      ? (g.pass ? 'Met' : 'Not met')
      : g.metric === 'offer'
        ? fmtMetric(g.current, 'usd')
        : `${fmtMetric(g.current, g.unit ?? null)} ${g.pass ? cmp : '<'} ${fmtMetric(g.threshold, g.unit ?? null)}`
    const gap = hasValues && !g.pass ? (g.threshold as number) - (g.current as number) + (g.comparator === '>' ? 1 : 0) : null
    return {
      ...g,
      display,
      gapText: gap !== null && gap > 0 ? `${g.unit === 'usd' ? usd(gap) : int(gap)} short` : null,
      definition: copy.definition,
      why: copy.why,
      change: change[g.key] ?? change[key] ?? '',
    }
  })
}

/* ══ ECONOMIC THESIS (the engine's own chain, as a bridge) ═════════════════ */

export interface BridgeStep {
  key: string
  label: string
  /** signed change (negative = deduction); totals carry the running value */
  value: number
  kind: 'total' | 'minus'
  from: number
  to: number
  tag: 'modeled' | 'policy' | 'estimated' | 'authorized' | 'record'
  note: string | null
}

export function economicBridge(d: DiDecision): { steps: BridgeStep[]; scaleMax: number } | null {
  const mid = pos(d.valuation?.mid)
  const o = d.offer
  if (!mid || !o) return null
  const factor = fin(o.maxArvFactor) ?? fin(d.scenario?.inputs?.max_arv_factor)
  const repairs = fin(o.repairs.amount) ?? fin(d.scenario?.inputs?.repairs)
  const rec = pos(o.recommended)
  const ceiling = pos(o.effectiveCeiling)
  const steps: BridgeStep[] = []
  steps.push({ key: 'value', label: 'Engine value', value: mid, kind: 'total', from: 0, to: mid, tag: 'modeled', note: `weighted value of ${d.comps?.selected ?? 0} comps` })
  let running = mid
  if (factor !== null && factor > 0 && factor < 1) {
    const cut = mid * (1 - factor)
    steps.push({ key: 'factor', label: `× ${factor.toFixed(2)} buyer factor`, value: -cut, kind: 'minus', from: running - cut, to: running, tag: 'policy', note: 'the engine’s max-ARV factor for this asset' })
    running -= cut
  }
  if (repairs !== null && repairs > 0) {
    steps.push({ key: 'repairs', label: 'Repairs', value: -repairs, kind: 'minus', from: Math.max(0, running - repairs), to: running, tag: 'estimated', note: [o.repairs.source, o.repairs.confidence ? `confidence ${o.repairs.confidence}` : null].filter(Boolean).join(' · ') || null })
    running = Math.max(0, running - repairs)
  }
  if (ceiling) {
    // Behavior can only lower the ceiling; when it does, show the step.
    if (running - ceiling > 150) {
      steps.push({ key: 'behavior', label: 'Observed buyers', value: -(running - ceiling), kind: 'minus', from: ceiling, to: running, tag: 'modeled', note: 'nearby investor purchases constrain the ceiling' })
    }
    steps.push({ key: 'ceiling', label: 'Buyer ceiling', value: ceiling, kind: 'total', from: 0, to: ceiling, tag: 'modeled', note: 'what an investor buyer pays — the modeled exit' })
    running = ceiling
  }
  if (rec && ceiling) {
    steps.push({ key: 'offer', label: 'Engine offer', value: -rec, kind: 'minus', from: ceiling - rec, to: ceiling, tag: 'modeled', note: 'the recommended purchase price' })
    const fee = fin(o.expectedFee) ?? ceiling - rec
    steps.push({ key: 'fee', label: 'Modeled fee', value: fee, kind: 'total', from: 0, to: Math.max(0, fee), tag: 'modeled', note: 'assignment spread at the engine offer — not profit' })
  }
  return { steps, scaleMax: mid }
}

/* ══ SELLER IDENTITY ═══════════════════════════════════════════════════════ */

const norm = (s: string | null | undefined) => String(s ?? '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((t) => t.length > 1)

/** Same person per the two records? Only a token-level name match is asserted — never inferred. */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const x = norm(a)
  const y = norm(b)
  if (!x.length || !y.length) return null
  const overlap = x.filter((t) => y.includes(t)).length
  return overlap >= Math.min(2, Math.min(x.length, y.length))
}

export function recordField(d: DiDecision, section: string, label: string): string | null {
  return d.record.sections.find((s) => s.title === section)?.fields.find((f) => f.label === label)?.value ?? null
}

export interface SellerIdentity {
  name: string
  role: 'conversation' | 'prospect' | 'owner_entity' | 'owner_of_record' | 'unknown'
  roleLabel: string
  recordOwner: string | null
  namesMatch: boolean | null
  entity: { corporate: boolean; trust: boolean; bank: boolean }
}

export function sellerIdentity(d: DiDecision): SellerIdentity {
  const recordOwner = recordField(d, 'Ownership', 'Owner of record') ?? recordField(d, 'Ownership', 'Owner 1')
  const primary = d.record.prospects.find((p) => p.primary) ?? null
  const entity = {
    corporate: recordField(d, 'Ownership', 'Corporate owner') === 'Yes',
    trust: recordField(d, 'Ownership', 'Trust') === 'Yes',
    bank: recordField(d, 'Ownership', 'Bank-owned') === 'Yes',
  }
  let name: string | null = null
  let role: SellerIdentity['role'] = 'unknown'
  if (d.contact?.sellerName) { name = d.contact.sellerName; role = 'conversation' } else if (primary?.name) { name = primary.name; role = 'prospect' } else if (d.record.owner?.name) { name = d.record.owner.name; role = 'owner_entity' } else if (recordOwner) { name = recordOwner; role = 'owner_of_record' }
  const roleLabel = role === 'conversation' ? 'Seller in conversation' : role === 'prospect' ? 'Primary prospect' : role === 'owner_entity' ? 'Owner (portfolio record)' : role === 'owner_of_record' ? 'Owner of record' : 'Seller not identified'
  return {
    name: name ?? 'Seller not identified',
    role,
    roleLabel,
    recordOwner,
    namesMatch: role === 'owner_of_record' ? null : namesMatch(name, recordOwner),
    entity,
  }
}

/* ══ EVIDENCE GAPS + NEXT BEST INFORMATION ═════════════════════════════════ */

export interface EvidenceGap {
  key: string
  label: string
  kind: 'seller' | 'model' | 'contract' | 'evidence'
  reason: string
}

const factOf = (facts: DiSellerFact[], ...keys: string[]) => facts.find((f) => keys.includes(f.key)) ?? null

/**
 * Only what is actually missing, each with the reason it matters taken from
 * the payload. Ranked by a fixed rule (stated in the UI as GAP_RULE):
 *   1. the seller's ask, when it is not captured (fit cannot be judged)
 *   2. property condition, when the seller has not described it (repairs
 *      then rest on a provider estimate)
 *   3. contract facts, once the deal is at offer or later
 *   4. seller timeline / motivation / occupancy
 *   5. contract facts before the offer stage
 *   6. engine inputs the confidence model reports missing
 *   7. comp coverage below the 4-comp gate
 */
export const GAP_RULE = 'Ranked: asking price → condition → contract facts (at offer) → timeline, motivation, occupancy → engine inputs → comp coverage.'

export function evidenceGaps(d: DiDecision): EvidenceGap[] {
  const gaps: EvidenceGap[] = []
  const f = offerFigures(d)
  const facts = d.sellerFacts
  const auth = availableOf(d)?.authorization ?? null
  const conf = confidenceModel(d)
  const stageIdx = STAGE_ORDER.indexOf(d.pipeline?.stage ?? '')
  if (!f.ask) {
    gaps.push({ key: 'ask', label: 'Asking price', kind: 'seller', reason: auth?.economicFit && /unknown/i.test(auth.economicFit) ? 'The negotiation cannot judge economic fit without it (fit: Unknown).' : 'The seller has not named a price; the gap to the offer cannot be measured.' })
  }
  const conditionSaid = factOf(facts, 'condition_seller', 'repairs_seller')
  const disclosed = factOf(facts, 'condition_disclosed')
  const repairs = d.offer?.repairs
  if (!conditionSaid) {
    const basis = repairs?.amount ? `Repairs (${usd(repairs.amount)}) are a ${String(repairs.source ?? 'provider').toLowerCase()} estimate` : 'No repair estimate is recorded'
    gaps.push({ key: 'condition', label: disclosed ? 'Condition detail' : 'Property condition', kind: 'seller', reason: disclosed ? `${basis}; the seller disclosed condition but it was not itemized.` : `${basis}; the seller has not described condition.` })
  }
  const contract = d.automation?.negotiation?.unresolvedContractFields ?? []
  if (contract.length && stageIdx >= STAGE_ORDER.indexOf('offer')) {
    gaps.push({ key: 'contract', label: `${contract.length} contract fact${contract.length === 1 ? '' : 's'}`, kind: 'contract', reason: `${contract.map((c) => c.label).join(' · ')} — required before contracting (readiness: ${d.automation?.negotiation?.contractReadiness ?? 'not ready'}).` })
  }
  if (!factOf(facts, 'timeline')) gaps.push({ key: 'timeline', label: 'Seller timeline', kind: 'seller', reason: 'Not captured from the conversation.' })
  if (!factOf(facts, 'motivation')) gaps.push({ key: 'motivation', label: 'Motivation', kind: 'seller', reason: 'No motivation signal has been extracted from the seller’s messages.' })
  const occSeller = factOf(facts, 'occupancy_seller')
  if (!occSeller || /unknown/i.test(String(occSeller.display ?? ''))) {
    const rec = factOf(facts, 'occupancy_record')
    gaps.push({ key: 'occupancy', label: 'Occupancy (from seller)', kind: 'seller', reason: rec ? `Only the record speaks to it (${rec.display}).` : 'Neither the seller nor the record states it.' })
  }
  if (contract.length && stageIdx < STAGE_ORDER.indexOf('offer')) {
    gaps.push({ key: 'contract', label: `${contract.length} contract fact${contract.length === 1 ? '' : 's'}`, kind: 'contract', reason: `${contract.map((c) => c.label).join(' · ')} — needed later, at contracting.` })
  }
  const missing = availableOf(d)?.confidenceBreakdown?.missing ?? []
  for (const m of missing) {
    const row = conf?.rows.find((r) => r.missing.includes(m))
    gaps.push({ key: `model:${m}`, label: m, kind: 'model', reason: row ? `Engine input missing — ${row.label.toLowerCase()} completeness ${row.score ?? '—'}.` : 'Engine input missing.' })
  }
  if (d.comps && d.comps.selected < 4) gaps.push({ key: 'comps', label: 'Comparable sales', kind: 'evidence', reason: `${d.comps.selected} qualified — the hard-offer gate needs 4.` })
  return gaps
}

export const STAGE_ORDER = ['ownership_confirmation', 'offer_interest', 'asking_price', 'property_condition', 'offer', 'formal_contract', 'disposition', 'under_contract', 'prepared_to_close', 'closed']
export const STAGE_SHORT: Record<string, string> = {
  ownership_confirmation: 'Ownership', offer_interest: 'Interest', asking_price: 'Asking price', property_condition: 'Condition', offer: 'Offer',
  formal_contract: 'Contract', disposition: 'Disposition', under_contract: 'Under contract', prepared_to_close: 'To close', closed: 'Closed',
}

/* ══ THESIS ════════════════════════════════════════════════════════════════ */

export interface ThesisLine { key: 'best' | 'system' | 'seller' | 'evidence' | 'constraint' | 'next'; label: string; text: string; tone?: 'ok' | 'attn' | 'crit' | 'exec' | 'flow' | null }

export function thesis(d: DiDecision): ThesisLine[] {
  const dec = availableOf(d)
  if (!dec) return []
  const f = offerFigures(d)
  const basis = dec.strategyBasis
  const lines: ThesisLine[] = []
  if (dec.bestStrategyLabel) {
    let why = ''
    if (basis?.cashViable === true && /cash/i.test(dec.bestStrategyLabel)) why = ` — cash is viable: fee ${usd(basis.fee)} ≥ ${usd(basis.feeNeeded)} and valuation confidence ${basis.valuationConfidence} ≥ 60`
    else if (basis?.cashViable === false) why = ` — cash not viable${basis.valuationConfidence !== null && basis.valuationConfidence < 60 ? ` (valuation confidence ${basis.valuationConfidence} < 60)` : basis.fee !== null && basis.feeNeeded !== null && basis.fee < basis.feeNeeded ? ` (fee ${usd(basis.fee)} < ${usd(basis.feeNeeded)})` : ''}`
    lines.push({ key: 'best', label: 'Best', text: `${dec.bestStrategyLabel}${why}`, tone: 'exec' })
  }
  const auth = dec.authorization
  const engine = f.engineFloor && f.engineRec ? `${usd(f.engineFloor)}–${usd(f.engineRec)} engine range` : f.engineRec ? `${usd(f.engineRec)} engine offer` : 'no engine offer'
  const authText = auth?.presentable === true && f.authFloor && f.authCeiling ? `; ${usd(f.authFloor)}–${usd(f.authCeiling)} authorized to present` : auth?.presentable === false ? '; withheld from the seller' : ''
  lines.push({ key: 'system', label: 'System', text: `${engine}${authText}`, tone: auth?.presentable === true ? 'ok' : null })
  const sig = d.conversation
  const askText = f.ask ? `Asking ${usd(f.ask)}${f.gapToRec !== null ? ` — ${usd(Math.abs(f.gapToRec))} ${f.gapToRec > 0 ? 'above' : 'below'} the engine offer` : ''}` : 'Ask not captured'
  lines.push({ key: 'seller', label: 'Seller', text: `${askText}${sig ? ` · signal ${sig.band.replace('_', ' ')} (${sig.score ?? '—'})` : ''}`, tone: f.ask ? 'attn' : null })
  const c = d.comps
  if (c) lines.push({ key: 'evidence', label: 'Evidence', text: c.selected ? `${c.selected} qualified comps of ${c.raw ?? '—'} screened${c.dispersion !== null ? ` · ${Math.round(c.dispersion * 100)}% spread` : ''}${c.avgDistanceMiles !== null ? ` · ${c.avgDistanceMiles} mi avg` : ''}` : 'No qualified comps — value rests on a fallback', tone: c.selected >= 4 ? null : 'crit' })
  const failed = gateViews(d).filter((g) => !g.pass)
  const constraint = failed[0]
    ? `${failed[0].label}: ${failed[0].display}${failed.length > 1 ? ` (+${failed.length - 1} more gate${failed.length > 2 ? 's' : ''})` : ''}`
    : d.risks[0] ? d.risks[0].title : 'All hard-offer gates met'
  lines.push({ key: 'constraint', label: 'Constraint', text: constraint, tone: failed.length ? 'attn' : 'ok' })
  const lane = d.automation?.lane
  const next = [auth?.nextMove ?? d.automation?.negotiation?.nextMoveLabel, lane ? `${lane.label}${lane.detail ? ` — ${lane.detail}` : ''}` : null].filter(Boolean).join(' · ')
  if (next) lines.push({ key: 'next', label: 'Next', text: next, tone: lane?.key === 'blocked' ? 'crit' : lane?.key === 'operator' ? 'attn' : 'flow' })
  return lines
}

/* ══ SCENARIO LAB ══════════════════════════════════════════════════════════ */

export type PresetKey = 'base' | 'conservative' | 'upside' | 'custom'

/**
 * Deterministic presets, defined from the engine's own recorded sensitivity
 * probes (deal-scenario-model.js offerSensitivity: value ±5%, repairs ±$10K,
 * valuation confidence −10) applied together. No other presets exist.
 */
export const SCENARIO_PRESETS: ReadonlyArray<{ key: Exclude<PresetKey, 'custom'>; label: string; definition: string }> = [
  { key: 'base', label: 'Base', definition: 'The engine’s recorded inputs' },
  { key: 'conservative', label: 'Conservative', definition: 'Value −5% · repairs +$10K · valuation confidence −10' },
  { key: 'upside', label: 'Upside', definition: 'Value +5% · repairs −$10K' },
]

export function presetInputs(base: ScenarioInputs, key: Exclude<PresetKey, 'custom'>): ScenarioInputs {
  if (key === 'conservative') return { ...base, valuation_mid: base.valuation_mid * 0.95, repairs: base.repairs + 10000, valuation_confidence: Math.max(0, base.valuation_confidence - 10) }
  if (key === 'upside') return { ...base, valuation_mid: base.valuation_mid * 1.05, repairs: Math.max(0, base.repairs - 10000) }
  return { ...base }
}

export interface ScenarioOutcome {
  inputs: ScenarioInputs
  result: ScenarioResult
  price: number
  /** buyer ceiling − purchase price: the engine's definition of the assignment fee */
  spread: number
  zone: 'target' | 'minimum' | 'below'
  maxForTarget: number
  maxForMinimum: number
  feeGate: boolean
  valuationGate: boolean
}

export function scenarioOutcome(inputs: ScenarioInputs, price?: number | null): ScenarioOutcome {
  const result = computeScenarioOffer(inputs)
  const p = price ?? result.recommended_offer
  const ceiling = result.effective_ceiling ?? 0
  const spread = ceiling - p
  const floor = result.protected_margin
  const target = result.target_margin
  return {
    inputs,
    result,
    price: p,
    spread,
    zone: spread >= target ? 'target' : spread >= floor ? 'minimum' : 'below',
    maxForTarget: ceiling - target,
    maxForMinimum: ceiling - floor,
    feeGate: result.expected_fee >= floor,
    valuationGate: inputs.valuation_confidence >= 80,
  }
}

export interface SensitivityCell { price: number; repairs: number; ceiling: number; spread: number; zone: 'target' | 'minimum' | 'below' }

/**
 * PURCHASE PRICE × REPAIRS. Each cell: the buyer ceiling the engine would
 * compute at those repairs, minus the price — the modeled assignment spread —
 * graded against the same policy's target and minimum margins.
 */
export function sensitivityGrid(base: ScenarioInputs, prices: number[], repairs: number[]): SensitivityCell[][] {
  return repairs.map((r) => {
    const res = computeScenarioOffer({ ...base, repairs: Math.max(0, r) })
    const ceiling = res.effective_ceiling ?? 0
    return prices.map((p) => {
      const spread = ceiling - p
      return { price: p, repairs: Math.max(0, r), ceiling, spread, zone: spread >= res.target_margin ? 'target' : spread >= res.protected_margin ? 'minimum' : 'below' }
    })
  })
}

/** Purchase prices across the decision neighbourhood, rounded to $1K, ascending. */
export function priceSteps(floor: number, ceiling: number, n = 8): number[] {
  const lo = Math.floor((floor * 0.92) / 1000) * 1000
  const hi = Math.ceil(ceiling / 1000) * 1000
  if (!(hi > lo)) return [lo]
  const step = Math.max(1000, Math.round((hi - lo) / (n - 1) / 1000) * 1000)
  const out: number[] = []
  for (let v = lo; out.length < n; v += step) out.push(v)
  return out
}

/* ══ COMPS ═════════════════════════════════════════════════════════════════ */

export interface CompStats { count: number; low: number | null; high: number | null; median: number | null; engine: number | null; medianPpsf: number | null }

export function compStats(d: DiDecision): CompStats {
  const vals = (d.comps?.top ?? []).map((c) => pos(c.adjustedValue) ?? pos(c.salePrice)).filter((v): v is number => v !== null).sort((a, b) => a - b)
  const ppsf = (d.comps?.top ?? []).map((c) => pos(c.ppsf)).filter((v): v is number => v !== null).sort((a, b) => a - b)
  const med = (xs: number[]) => (xs.length ? (xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2) : null)
  return { count: vals.length, low: vals[0] ?? null, high: vals[vals.length - 1] ?? null, median: med(vals), engine: pos(d.valuation?.mid), medianPpsf: med(ppsf) }
}

/** Months between a sale date and the analysis clock. */
export function monthsSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.max(0, Math.round(((now - t) / (30.44 * 86_400_000)) * 10) / 10) : null
}

/** Bearing + distance of a comp from the subject (for the evidence plot). */
export function polarOf(subject: { lat: number | null; lng: number | null }, comp: { lat?: number | null; lng?: number | null; distanceMiles: number | null }): { angle: number; miles: number } | null {
  if (subject.lat === null || subject.lng === null || comp.lat === null || comp.lat === undefined || comp.lng === null || comp.lng === undefined) return null
  const toRad = (x: number) => (x * Math.PI) / 180
  const dLng = toRad(comp.lng - subject.lng)
  const y = Math.sin(dLng) * Math.cos(toRad(comp.lat))
  const x = Math.cos(toRad(subject.lat)) * Math.sin(toRad(comp.lat)) - Math.sin(toRad(subject.lat)) * Math.cos(toRad(comp.lat)) * Math.cos(dLng)
  const angle = Math.atan2(y, x)
  const miles = comp.distanceMiles ?? (() => {
    const dLat = toRad(comp.lat - subject.lat)
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(subject.lat)) * Math.cos(toRad(comp.lat)) * Math.sin(dLng / 2) ** 2
    return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  })()
  return { angle, miles }
}

/* ══ RECORDS ═══════════════════════════════════════════════════════════════ */

export interface DebtGroups {
  liens: DiRecordedDocument[]
  conflicts: DiRecordedDocument[]
  releases: DiRecordedDocument[]
  documents: DiRecordedDocument[]
  byKind: Array<{ kind: string; label: string; count: number; amount: number | null }>
}

export function debtGroups(d: DiDecision): DebtGroups {
  const docs = d.economics.recordedDocuments ?? []
  const liens = docs.filter((x) => x.status === 'lien')
  const kinds = new Map<string, { label: string; count: number; amount: number | null }>()
  for (const l of liens) {
    const k = kinds.get(l.kind) ?? { label: l.kindLabel, count: 0, amount: null }
    k.count += 1
    if (l.amount) k.amount = (k.amount ?? 0) + l.amount
    kinds.set(l.kind, k)
  }
  return {
    liens,
    conflicts: docs.filter((x) => x.status === 'conflict'),
    releases: docs.filter((x) => x.status === 'release'),
    documents: docs.filter((x) => x.status === 'document'),
    byKind: [...kinds.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.count - a.count),
  }
}

export interface SnapshotRow {
  index: number
  at: string
  mid: number | null
  offer: number | null
  floor: number | null
  confidence: number | null
  comps: number | null
  tier: string | null
  delta: { mid: number | null; offer: number | null; confidence: number | null; comps: number | null; tierChanged: boolean } | null
}

/** Newest first; each row compared with the snapshot before it. Nothing is rewritten. */
export function snapshotRows(d: DiDecision): SnapshotRow[] {
  const list = d.valuationHistory
  const rows = list.map((s, i) => {
    const prev = i > 0 ? list[i - 1] : null
    const dlt = (a: number | null | undefined, b: number | null | undefined) => (typeof a === 'number' && typeof b === 'number' ? a - b : null)
    return {
      index: i,
      at: s.at,
      mid: s.mid,
      offer: s.offer,
      floor: s.floor ?? null,
      confidence: s.confidence ?? null,
      comps: s.comps,
      tier: s.tier,
      delta: prev ? { mid: dlt(s.mid, prev.mid), offer: dlt(s.offer, prev.offer), confidence: dlt(s.confidence, prev.confidence), comps: dlt(s.comps, prev.comps), tierChanged: s.tier !== prev.tier } : null,
    }
  })
  return rows.reverse()
}

export interface UnderwritingStatus { key: 'analyzed' | 'stale' | 'not_analyzed' | 'recomputing' | 'error' | 'loading'; label: string; tone: 'ok' | 'attn' | 'crit' | 'exec' | 'neutral' }

/** ANALYZED · STALE · NOT ANALYZED · RECOMPUTING · ERROR — one compact state, never a spinner. */
export function underwritingStatus(input: { d: DiDecision | null; pending: boolean; error: string | null; recomputing: boolean }): UnderwritingStatus {
  const { d, pending, error, recomputing } = input
  if (recomputing) return { key: 'recomputing', label: 'Recomputing', tone: 'exec' }
  if (pending) return { key: 'loading', label: 'Loading subject', tone: 'neutral' }
  if (error) return { key: 'error', label: d ? 'Refresh failed' : 'Unavailable', tone: d ? 'attn' : 'crit' }
  if (!d || !availableOf(d)) return { key: 'not_analyzed', label: 'Not analyzed', tone: 'neutral' }
  if (rerunReasons(d).length) return { key: 'stale', label: 'Stale', tone: 'attn' }
  return { key: 'analyzed', label: 'Analyzed', tone: 'ok' }
}

/** Inputs that changed after the last analysis — what makes a re-run meaningful. */
export function rerunReasons(d: DiDecision): string[] {
  const out: string[] = []
  for (const r of d.risks) {
    if (r.key === 'ask_changed_after_analysis') out.push(r.detail ?? r.title)
    if (r.key === 'stale_policy') out.push(r.detail ?? r.title)
    if (r.key === 'stale_analysis') out.push(r.title)
  }
  if (availableOf(d) === null) out.push('This property has never been analysed.')
  return out
}

/* ══ EVIDENCE FAMILIES ═════════════════════════════════════════════════════ */

export type EvidenceFamily = 'comps' | 'seller' | 'debt' | 'market' | 'transactions' | 'communication'

/** A real count per family, or null when the family has no source here. */
export function familyCount(d: DiDecision, f: EvidenceFamily): number | null {
  switch (f) {
    case 'comps': return d.comps?.selected ?? null
    case 'seller': return d.sellerFacts.length
    case 'debt': return d.economics.debt.mortgages.length + (d.economics.lienSummary?.liens ?? d.economics.liens.length)
    case 'market': return d.market?.ok ? d.market.totals.sales : null
    case 'transactions': return d.history.filter((h) => h.kind !== 'analysis').length
    case 'communication': return d.conversation?.counts.inbound ?? null
  }
}


/* ══ RECORD CATEGORIES ═════════════════════════════════════════════════════ */

export type RecordCategoryKey = 'valuation' | 'property' | 'debt' | 'tax' | 'ownership' | 'distress' | 'transactions' | 'other'

export interface RecordCategory {
  key: RecordCategoryKey
  label: string
  count: number
  source: string
  summary: Array<{ label: string; value: string; group: string }>
  groups: Array<{ title: string; fields: Array<{ label: string; value: string }> }>
}

/** A field that is a provider estimate rather than something recorded. */
export function fieldNature(label: string): 'estimated' | 'recorded' {
  return /\bAVM\b|equity|\(est\.\)|estimate|repair|calc\.|valued on|improvement share/i.test(label) ? 'estimated' : 'recorded'
}

const PARCEL_SOURCE = 'Provider parcel record (seller.property)'
const SUMMARY_KEYS: Record<string, string[]> = {
  valuation: ['AVM', 'AVM low', 'AVM high', 'AVM confidence', 'Equity', 'Equity %', 'Assessed total', 'Repair estimate'],
  property: ['Property type', 'Units', 'Bedrooms', 'Bathrooms', 'Living area', 'Year built', 'Condition', 'Lot size'],
  debt: ['Open balance (est.)', 'Original loans', 'Payment (est.)', 'Open mortgages', 'Liens', 'Active lien'],
  tax: ['Annual tax', 'Tax year', 'Delinquent'],
  ownership: ['Owner of record', 'Occupancy', 'Owner location', 'Corporate owner', 'Trust', 'Out-of-state owner', 'Owns other property', 'Mailing address'],
  distress: ['Signals', 'Preforeclosure', 'Auction date', 'Market status', 'Listed on MLS'],
}

/**
 * The record, grouped the way an underwriter reads it. Server sections map
 * onto categories; each category leads with its key values (only the ones
 * that are populated) and keeps the full field list behind it.
 */
export function recordCategories(d: DiDecision): RecordCategory[] {
  const sec = (title: string) => d.record.sections.find((s) => s.title === title) ?? null
  const pick = (key: string, groups: Array<{ title: string; fields: Array<{ label: string; value: string }> }>) => {
    const want = SUMMARY_KEYS[key] ?? []
    const out: RecordCategory['summary'] = []
    for (const label of want) {
      for (const g of groups) {
        const f = g.fields.find((x) => x.label === label)
        if (f) { out.push({ label, value: f.value, group: g.title }); break }
      }
    }
    return out
  }
  const cats: RecordCategory[] = []
  const add = (key: RecordCategoryKey, label: string, groups: Array<{ title: string; fields: Array<{ label: string; value: string }> } | null>, source = PARCEL_SOURCE, extraCount = 0) => {
    const gs = groups.filter((g): g is NonNullable<typeof g> => Boolean(g && g.fields.length))
    const count = gs.reduce((s, g) => s + g.fields.length, 0) + extraCount
    if (!count) return
    cats.push({ key, label, count, source, summary: pick(key, gs), groups: gs })
  }
  add('valuation', 'Valuation', [sec('Value & equity')])
  add('property', 'Property', [sec('Structure'), sec('Lot & location')])
  add('debt', 'Debt & liens', [sec('Debt & liens')], `${PARCEL_SOURCE} · recorded loans and instruments`, (d.economics.recordedDocuments ?? []).length)
  add('tax', 'Tax', [sec('Tax')])
  add('ownership', 'Ownership', [sec('Ownership'), ...(d.record.owner?.sections ?? []).map((s) => ({ ...s, title: `Owner · ${s.title}` }))], `${PARCEL_SOURCE} · master owner record`)
  add('distress', 'Distress & market', [sec('Distress & market')])
  const tx = d.history.filter((h) => h.kind === 'sale' || h.kind === 'mortgage' || h.kind === 'lien' || h.kind === 'foreclosure').length
  if (tx) cats.push({ key: 'transactions', label: 'Transactions', count: tx, source: 'County record: sales, loans, liens, filings', summary: [], groups: [] })
  add('other', 'Other recorded fields', [sec('Other recorded fields')])
  return cats
}

/**
 * Do two sources really disagree? Only when both say something substantive:
 * "Unknown" or "disclosed — not itemized" is an absence, not a conflict.
 */
export function factsDiffer(list: ReadonlyArray<{ display: string | null }>): boolean {
  const substantive = list.map((f) => String(f.display ?? '').trim().toLowerCase()).filter((v) => v && !/^unknown$|not itemized|^not captured/.test(v))
  return substantive.length > 1 && new Set(substantive).size > 1
}
