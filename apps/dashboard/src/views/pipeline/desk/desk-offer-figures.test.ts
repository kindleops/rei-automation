import { describe, expect, it } from 'vitest'
import { gapToAsk, offerShareOfValue, offerSummary, offerValue, signedMoney } from './desk-offer-figures'
import type { DeskOfferRow } from './pipeline-desk-api'

const row = (over: { engine?: Partial<NonNullable<DeskOfferRow['engine']>> | null; asking?: number | null; value?: number | null; askImplausible?: boolean; implausible?: boolean; engineValueOff?: boolean; offer?: DeskOfferRow['offer'] } = {}) => ({
  card: { id: 'O1', address: '1 Main St', seller: 'A', money: { asking: over.asking ?? null, value: over.value ?? null } },
  engine: over.engine === null ? null : { mid: 200_000, recommended: 120_000, floor: 100_000, tierLabel: 'Range offer', compCount: 6, ...(over.engine ?? {}) },
  autonomy: { implausible: Boolean(over.implausible) },
  plausibility: { engineValueOff: Boolean(over.engineValueOff), recommendedOff: false },
  askImplausible: Boolean(over.askImplausible),
  offer: over.offer ?? null,
} as unknown as DeskOfferRow)

describe('offer figures', () => {
  it('share of value and gap only when both sides are real', () => {
    expect(offerShareOfValue(row())).toBe(60)
    expect(gapToAsk(row({ asking: 150_000 }))).toBe(30_000)
    expect(gapToAsk(row())).toBeNull()
    expect(gapToAsk(row({ asking: 150_000, askImplausible: true }))).toBeNull()
    expect(offerShareOfValue(row({ implausible: true }))).toBeNull()
  })
  it('an implausible engine value falls back to the deal estimate', () => {
    expect(offerValue(row({ engineValueOff: true, value: 180_000 }))).toBe(180_000)
  })
  it('the summary names every figure with its kind; absent is a dash', () => {
    const s = offerSummary(row({ engine: null }))
    expect(s).toContain('Engine offer — (modeled)')
    expect(s).toContain('Ask — (stated)')
    expect(s).toContain('Offer on record none')
  })
  it('signed money', () => {
    expect(signedMoney(30_000)).toBe('+$30K')
    expect(signedMoney(-5_000)).toBe('−$5K')
    expect(signedMoney(null)).toBeNull()
  })
})
