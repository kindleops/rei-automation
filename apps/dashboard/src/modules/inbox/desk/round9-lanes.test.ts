/** Round 9 lanes are listable lenses (2026-10-12): Unclear and Price gap, never alerting. */
import { describe, expect, it } from 'vitest'
import { MORE_LENSES, NON_ALERTING_LENSES, PRIMARY_LENSES, lensCount, lensDef, resolveDeskLens } from './ledger-model'
import { liveFilterForLens } from '../multi/pane-data'

describe('Unclear and Price gap lenses', () => {
  for (const id of ['unclear', 'price_gap'] as const) {
    it(`${id}: a secondary lens whose list filter and chip key are the server flag's name`, () => {
      const def = lensDef(id)
      expect(def.id).toBe(id)
      expect(MORE_LENSES.some((l) => l.id === id)).toBe(true)
      expect(PRIMARY_LENSES.some((l) => l.id === id)).toBe(false)
      expect(def.countKey).toBe(id)
      expect(liveFilterForLens(id)).toBe(id)
      expect(resolveDeskLens(id)).toBe(id)
      expect(lensCount({ [id]: 7 }, def)).toBe(7)
      expect(NON_ALERTING_LENSES.has(id)).toBe(true)
    })
  }
})
