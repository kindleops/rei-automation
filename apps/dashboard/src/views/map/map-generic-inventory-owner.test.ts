import { describe, expect, it } from 'vitest'
import {
  GENERIC_INVENTORY_LAYER_IDS,
  MARKET_AGGREGATE_LAYER_IDS,
  PROPERTY_UNIVERSE_LAYER_IDS,
  SELLER_PINS_LAYER_IDS,
  resolveGenericInventoryOwner,
  type GenericInventoryInputs,
} from './map-generic-inventory-owner'
import { PROPERTY_TILES_LAYER_IDS } from './map-property-tile-source'

/**
 * The regression these guard is not "a layer was wrong". It is "two resolvers disagreed
 * and whichever ran last won", which showed up as the same zoom rendering 6/6 tile
 * layers on one arrival and 0/6 on the next. So the assertions are about EXCLUSIVITY,
 * TOTALITY and DETERMINISM rather than about any particular layer being on.
 */

/** Every zoom the map can be at, at finer granularity than the band edges. */
const ZOOM_SWEEP = Array.from({ length: 45 }, (_, i) => i * 0.5)

const FAMILIES = {
  mvt: Object.values(PROPERTY_TILES_LAYER_IDS),
  aggregates: Object.values(MARKET_AGGREGATE_LAYER_IDS),
  legacyUniverse: Object.values(PROPERTY_UNIVERSE_LAYER_IDS),
  legacySellerField: Object.values(SELLER_PINS_LAYER_IDS),
}

const visibleFamilies = (decision: { visibility: Record<string, string> }) =>
  Object.entries(FAMILIES)
    .filter(([, ids]) => ids.some((id) => decision.visibility[id] === 'visible'))
    .map(([name]) => name)

describe('generic inventory owner', () => {
  it('has exactly one generic family visible at every zoom, in every mode', () => {
    for (const zoom of ZOOM_SWEEP) {
      for (const masterFilterActive of [false, true]) {
        const decision = resolveGenericInventoryOwner({ zoom, propertyFieldEnabled: true, masterFilterActive })
        expect(visibleFamilies(decision), `z${zoom} masterFilter=${masterFilterActive}`).toHaveLength(1)
      }
    }
  })

  it('makes MVT the generic universe at z>=9 and aggregates below it', () => {
    for (const zoom of ZOOM_SWEEP) {
      const decision = resolveGenericInventoryOwner({ zoom, propertyFieldEnabled: true, masterFilterActive: false })
      expect(decision.owner, `z${zoom}`).toBe(zoom >= 9 ? 'mvt' : 'aggregates')
    }
  })

  it('never shows a partial family — a ring can never render without its icon', () => {
    for (const zoom of ZOOM_SWEEP) {
      const decision = resolveGenericInventoryOwner({ zoom, propertyFieldEnabled: true, masterFilterActive: false })
      for (const [name, ids] of Object.entries(FAMILIES)) {
        const values = new Set(ids.map((id) => decision.visibility[id]))
        expect(values.size, `z${zoom} ${name} split across visibilities`).toBe(1)
      }
    }
  })

  it('answers for every managed layer on every call, with no gaps', () => {
    for (const zoom of ZOOM_SWEEP) {
      for (const propertyFieldEnabled of [false, true]) {
        const decision = resolveGenericInventoryOwner({ zoom, propertyFieldEnabled, masterFilterActive: false })
        for (const layerId of GENERIC_INVENTORY_LAYER_IDS) {
          expect(decision.visibility[layerId], `z${zoom} ${layerId} unanswered`).toMatch(/^(visible|none)$/)
        }
        expect(Object.keys(decision.visibility).sort()).toEqual([...GENERIC_INVENTORY_LAYER_IDS].sort())
      }
    }
  })

  it('treats a Master Filter as a filter over the canonical universe, not another architecture', () => {
    for (const zoom of ZOOM_SWEEP) {
      const plain = resolveGenericInventoryOwner({ zoom, propertyFieldEnabled: true, masterFilterActive: false })
      const filtered = resolveGenericInventoryOwner({ zoom, propertyFieldEnabled: true, masterFilterActive: true })
      expect(filtered.owner, `z${zoom}`).toBe(plain.owner)
      expect(filtered.visibility, `z${zoom}`).toEqual(plain.visibility)
    }
  })

  it('draws no generic inventory when the property field is off', () => {
    for (const zoom of ZOOM_SWEEP) {
      const decision = resolveGenericInventoryOwner({ zoom, propertyFieldEnabled: false, masterFilterActive: false })
      expect(decision.owner).toBe('none')
      expect(visibleFamilies(decision), `z${zoom}`).toHaveLength(0)
    }
  })

  it('keeps the superseded bounded-GeoJSON stacks dark in every state', () => {
    for (const zoom of ZOOM_SWEEP) {
      for (const masterFilterActive of [false, true]) {
        for (const propertyFieldEnabled of [false, true]) {
          const decision = resolveGenericInventoryOwner({ zoom, propertyFieldEnabled, masterFilterActive })
          for (const id of [...FAMILIES.legacyUniverse, ...FAMILIES.legacySellerField]) {
            expect(decision.visibility[id], `z${zoom} ${id}`).toBe('none')
          }
        }
      }
    }
  })

  /**
   * The determinism clause, stated as the phase states it: a run that resolves one way
   * and then differently on identical inputs is an automatic failure. The resolver takes
   * no map, no ref and no arrival state, so this holds by construction — asserted anyway,
   * because the way this broke last time was someone adding an input that varies.
   */
  it('resolves identically across repeated runs with identical inputs', () => {
    const cases: GenericInventoryInputs[] = ZOOM_SWEEP.flatMap((zoom) => [
      { zoom, propertyFieldEnabled: true, masterFilterActive: false },
      { zoom, propertyFieldEnabled: true, masterFilterActive: true },
      { zoom, propertyFieldEnabled: false, masterFilterActive: false },
    ])
    for (const input of cases) {
      const first = resolveGenericInventoryOwner(input)
      for (let run = 0; run < 3; run += 1) {
        expect(resolveGenericInventoryOwner(input), `z${input.zoom} run ${run}`).toEqual(first)
      }
    }
  })
})
