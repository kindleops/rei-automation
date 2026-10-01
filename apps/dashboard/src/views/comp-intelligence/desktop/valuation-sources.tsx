import type { ReplayResult } from '../../../domain/comp-intelligence/comps-valuation-replay'
import { fmtDate, fmtMoment, fmtMoney } from '../../../domain/comp-intelligence/comps-workstation-model'
import type { Workstation } from './derive-workstation'
import type { SpectrumBand, SpectrumMarker } from './charts/ValuationSpectrum'

export const money = (v: number) => fmtMoney(v, { exact: true }) ?? '—'

export const COMPONENT_LABEL: Record<keyof ReplayResult['components'], { label: string; weight: number; hint: string }> = {
  depth: { label: 'Depth', weight: 0.32, hint: 'comps priced ÷ 8, capped at 100' },
  compScore: { label: 'Comparability', weight: 0.25, hint: 'weight-averaged engine comparability score' },
  completeness: { label: 'Completeness', weight: 0.18, hint: 'weight-averaged share of features the engine could compare' },
  consistency: { label: 'Consistency', weight: 0.2, hint: '100 − 180 × (std. deviation ÷ central value)' },
  sourceDiversity: { label: 'Source mix', weight: 0.05, hint: '100 with two or more sale sources, else 70' },
}

/** Every value source on one axis, each saying what it is (§32, §132–135). */
export function spectrumInputs(m: Workstation): { bands: SpectrumBand[]; markers: SpectrumMarker[] } {
  const c = m.w.conclusion
  const s = m.w.subject
  const run = m.run
  const bands: SpectrumBand[] = []
  if (m.comparableValuation && c?.valueLow && c.valueMid && c.valueHigh) {
    bands.push({
      id: 'engine', label: 'Engine', low: c.valueLow, mid: c.valueMid, high: c.valueHigh,
      provenance: <><b className="ciw-num-strong">{money(c.valueLow)} – {money(c.valueHigh)} · central {money(c.valueMid)}</b><span>Engine value range · weighted 25th–75th percentile of {m.systemKeys.size} adjusted comps, widened to the minimum spread · acquisition engine {run?.version ?? ''} · {fmtMoment(run?.computedAt ?? c.computedAt) ?? 'run date not recorded'} · confidence {c.valuationConfidence ?? '—'}</span></>,
    })
  }
  const op = m.operatorReplay?.result
  if (op && m.operatorKeys) {
    bands.push({
      id: 'operator', label: 'Your set', low: op.low, mid: op.mid, high: op.high,
      provenance: <><b className="ciw-num-strong">{money(op.low)} – {money(op.high)} · central {money(op.mid)}</b><span>The engine’s formula replayed over your {op.count} comps in this browser session · confidence {op.confidence} · not stored</span></>,
    })
  }
  const markers: SpectrumMarker[] = []
  if (s.estimatedValue) markers.push({ id: 'avm', label: 'Record estimate', value: s.estimatedValue, tone: 'context', provenance: <><b className="ciw-num-strong">{money(s.estimatedValue)}</b><span>Property record — the data provider’s estimate. Not computed by LeadCommand and not comp evidence.</span></> })
  if (c?.ask) markers.push({ id: 'ask', label: 'Seller ask', value: c.ask, tone: 'attn', provenance: <><b className="ciw-num-strong">{money(c.ask)}</b><span>What the seller asked (acquisition negotiation record). Not a valuation.</span></> })
  if (c?.recommendedOffer) markers.push({ id: 'offer', label: 'Engine offer', value: c.recommendedOffer, tone: 'context', provenance: <><b className="ciw-num-strong">{money(c.recommendedOffer)}</b><span>Deal Intelligence’s recommended cash offer — acquisition terms, shown for context only. Not a comp-derived value.</span></> })
  if (s.lastSale) markers.push({ id: 'last', label: `Last sale ${fmtDate(s.lastSale.date) ?? ''}`, value: s.lastSale.price, tone: 'context', provenance: <><b className="ciw-num-strong">{money(s.lastSale.price)}</b><span>The subject’s last recorded sale, {fmtDate(s.lastSale.date, 'long')} (property record).</span></> })
  if (s.assessedValue) markers.push({ id: 'assessed', label: 'Assessed', value: s.assessedValue, tone: 'context', provenance: <><b className="ciw-num-strong">{money(s.assessedValue)}</b><span>Tax-assessed value on the property record.</span></> })
  return { bands, markers }
}
