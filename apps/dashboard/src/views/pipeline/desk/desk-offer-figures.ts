/** PIPELINE · OFFERS — the pure figures behind an offer row (tested). Never collapses kinds; absent is null. */
import { compactMoney } from '../../../domain/pipeline/pipeline-command-api'
import type { DeskOfferRow } from './pipeline-desk-api'
import { moneyRange } from './pipeline-desk-model'

/** The engine's value when it is plausible, else the deal's estimate. */
export const offerValue = (r: DeskOfferRow) => (r.engine?.mid && !r.plausibility.engineValueOff ? r.engine.mid : r.card.money.value)

/** Engine offer as a share of value — only when both are real. */
export function offerShareOfValue(r: DeskOfferRow): number | null {
  const rec = r.engine?.recommended
  const v = offerValue(r)
  if (!rec || !v || r.autonomy?.implausible || r.plausibility.recommendedOff) return null
  return Math.round((rec / v) * 100)
}

/** Ask − engine offer (stated − modeled), only when both are plausible. */
export function gapToAsk(r: DeskOfferRow): number | null {
  const rec = r.engine?.recommended
  const ask = r.card.money.asking
  if (!rec || !ask || r.askImplausible || r.autonomy?.implausible || r.plausibility.recommendedOff) return null
  return ask - rec
}

export function offerSummary(r: DeskOfferRow): string {
  const c = r.card
  const parts = [
    c.address || c.seller || 'Unaddressed deal',
    `Engine offer ${r.autonomy?.implausible ? 'out of range' : moneyRange(r.engine?.floor ?? null, r.engine?.recommended ?? null) ?? '—'} (modeled)`,
    `Value ${compactMoney(offerValue(r)) ?? '—'} (estimated)`,
    `Ask ${r.askImplausible ? 'mis-captured' : compactMoney(c.money.asking) ?? '—'} (stated)`,
    `Offer on record ${r.offer?.price && r.offer.status ? `${compactMoney(r.offer.price)} · ${r.offer.status}` : 'none'}`,
    r.engine?.tierLabel ? `Tier ${r.engine.tierLabel}` : null,
    r.engine?.compCount !== null && r.engine?.compCount !== undefined ? `${r.engine.compCount} comps` : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

export const signedMoney = (n: number | null) => (n === null ? null : n === 0 ? '$0' : `${n > 0 ? '+' : '−'}${compactMoney(Math.abs(n))}`)

