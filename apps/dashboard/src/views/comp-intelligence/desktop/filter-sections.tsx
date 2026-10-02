import type { LCFilterSection } from '../../../shared/lc'
import { FilterChoice as Choice } from './FilterChoice'
import type { AssetKind, CompFilters } from '../../../domain/comp-intelligence/comps-workstation-model'
import { SALE_TYPE_LABEL, SALE_TYPES } from '../../../domain/comp-intelligence/comp-sale-type'

const num = (v: string): number | null => (v === 'any' ? null : Number(v))
const str = (v: number | null) => (v === null ? 'any' : String(v))

/**
 * The universe filters (§55–59), grouped the way the filter system groups
 * them. They narrow what is reviewed — candidates and excluded sales — and
 * apply at once; they never change the system set or price anything.
 */
export function buildFilterSections(f: CompFilters, set: (f: CompFilters) => void, kind: AssetKind): LCFilterSection[] {
  const sizeWord = kind === 'multifamily' ? 'Units' : kind === 'land' ? 'Lot size' : 'Building sq ft'
  const sections: LCFilterSection[] = [
    {
      id: 'distance', label: 'Distance & geography', keywords: ['radius', 'zip', 'miles'],
      active: (f.maxDistance !== null ? 1 : 0) + (f.sameZip ? 1 : 0),
      render: () => (
        <>
          <Choice label="Within" value={str(f.maxDistance)} onChange={(v) => set({ ...f, maxDistance: num(v) })}
            options={[{ value: 'any', label: 'Search' }, { value: '0.5', label: '0.5 mi' }, { value: '1', label: '1 mi' }, { value: '2', label: '2 mi' }, { value: '3', label: '3 mi' }]} />
          <Choice label="ZIP" value={f.sameZip ? 'same' : 'any'} onChange={(v) => set({ ...f, sameZip: v === 'same' })}
            options={[{ value: 'any', label: 'Any' }, { value: 'same', label: 'Same as subject' }]} />
        </>
      ),
    },
    {
      id: 'time', label: 'Time', keywords: ['sold', 'recent', 'months', 'date'],
      active: f.maxAgeMonths !== null ? 1 : 0,
      render: () => (
        <Choice label="Sold within" value={str(f.maxAgeMonths)} onChange={(v) => set({ ...f, maxAgeMonths: num(v) })}
          options={[{ value: 'any', label: 'Search' }, { value: '1', label: '30 d' }, { value: '3', label: '90 d' }, { value: '6', label: '6 mo' }, { value: '12', label: '12 mo' }, { value: '24', label: '24 mo' }]} />
      ),
    },
    {
      id: 'property', label: 'Property', keywords: ['size', 'sqft', 'beds', 'year', 'units', 'lot'],
      active: (f.sizePct !== null ? 1 : 0) + (f.bedsDelta !== null && kind === 'sfr' ? 1 : 0) + (f.yearDelta !== null ? 1 : 0),
      render: () => (
        <>
          <Choice label={`${sizeWord} within`} value={str(f.sizePct)} onChange={(v) => set({ ...f, sizePct: num(v) })}
            options={[{ value: 'any', label: 'Any' }, { value: '10', label: '±10%' }, { value: '15', label: '±15%' }, { value: '20', label: '±20%' }, { value: '30', label: '±30%' }]} />
          {kind === 'sfr' ? (
            <Choice label="Bedrooms within" value={str(f.bedsDelta)} onChange={(v) => set({ ...f, bedsDelta: num(v) })}
              options={[{ value: 'any', label: 'Any' }, { value: '0', label: 'Same' }, { value: '1', label: '±1' }, { value: '2', label: '±2' }]} />
          ) : null}
          {kind !== 'land' ? (
            <Choice label="Built within" value={str(f.yearDelta)} onChange={(v) => set({ ...f, yearDelta: num(v) })}
              options={[{ value: 'any', label: 'Any' }, { value: '10', label: '±10 yr' }, { value: '20', label: '±20 yr' }, { value: '30', label: '±30 yr' }]} />
          ) : null}
        </>
      ),
    },
    {
      id: 'transaction', label: 'Transaction & source', keywords: ['arms', 'deed', 'mls', 'pool', 'corpus', 'investor', 'off-market', 'public record', 'sale type'],
      active: (f.armsLengthOnly ? 1 : 0) + (f.corpus !== 'all' ? 1 : 0) + (f.saleType !== 'all' ? 1 : 0),
      render: () => (
        <>
          <Choice label="Arm’s-length" value={f.armsLengthOnly ? 'only' : 'any'} onChange={(v) => set({ ...f, armsLengthOnly: v === 'only' })}
            options={[{ value: 'any', label: 'Any' }, { value: 'only', label: 'Exclude non-arm’s-length' }]} />
          <Choice label="Source" value={f.corpus} onChange={(v) => set({ ...f, corpus: v as CompFilters['corpus'] })}
            options={[{ value: 'all', label: 'All' }, { value: 'engine_pool', label: 'Engine pool' }, { value: 'transaction_corpus', label: 'Recorded deeds' }]} />
          <Choice label="Sale type" value={f.saleType} onChange={(v) => set({ ...f, saleType: v as CompFilters['saleType'] })}
            options={[{ value: 'all', label: 'All' }, ...SALE_TYPES.map((t) => ({ value: t, label: SALE_TYPE_LABEL[t].short }))]} />
        </>
      ),
    },
  ]
  return sections
}
