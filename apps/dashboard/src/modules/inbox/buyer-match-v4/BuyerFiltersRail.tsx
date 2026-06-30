import type { BuyerFilterState, BuyerMatchV4Projection } from './buyer-match-v4.types'
import { DIRECTORY_MODE_OPTIONS } from './buyer-match-v4.types'
import { countBuyers, SORT_OPTIONS } from './buyerFilters'

interface Props {
  projection: BuyerMatchV4Projection | null
  filters: BuyerFilterState
  onChange: (patch: Partial<BuyerFilterState>) => void
  onClear: () => void
}

export function BuyerFiltersRail({ projection, filters, onChange, onClear }: Props) {
  const buyers = projection?.rankedBuyers ?? []
  const counts = countBuyers(buyers)
  const market = projection?.market

  return (
    <aside className="bmv4-rail bmv4-rail--filters">
      <div className="bmv4-rail__head">
        <span className="bmv4-eyebrow">Buyer Mode</span>
        <button type="button" className="bmv4-btn is-ghost is-sm" onClick={onClear}>Clear</button>
      </div>

      <p className="bmv4-rail__summary bmv4-tabular">
        {market?.eligibleBuyerFamilies ?? counts.total} eligible
        {' · '}{counts.highFit} high fit
        {' · '}{market?.localRegionalFamilies ?? counts.localRegional} local/regional
        {' · '}{market?.institutionalPlatforms ?? counts.institutional} institutional
        {' · '}{market?.builderFamilies ?? counts.builders} builders
      </p>

      <div className="bmv4-segmented is-vertical">
        {DIRECTORY_MODE_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            type="button"
            className={`bmv4-segmented__btn${filters.directoryMode === opt.key ? ' is-active' : ''}`}
            onClick={() => onChange({ directoryMode: opt.key })}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <label className="bmv4-field">
        <span>Grade</span>
        <select value={filters.grade} onChange={(e) => onChange({ grade: e.target.value as BuyerFilterState['grade'] })}>
          <option value="all">All grades</option>
          <option value="A+">A+</option>
          <option value="A">A</option>
          <option value="B">B</option>
          <option value="C">C</option>
        </select>
      </label>

      <label className="bmv4-check">
        <input type="checkbox" checked={filters.active90d} onChange={(e) => onChange({ active90d: e.target.checked })} />
        Active 90 days
      </label>
      <label className="bmv4-check">
        <input type="checkbox" checked={filters.active180d} onChange={(e) => onChange({ active180d: e.target.checked })} />
        Active 180 days
      </label>
      <label className="bmv4-check">
        <input type="checkbox" checked={filters.contactReady} onChange={(e) => onChange({ contactReady: e.target.checked })} />
        Contact ready
      </label>
      <label className="bmv4-check">
        <input type="checkbox" checked={filters.exactZip} onChange={(e) => onChange({ exactZip: e.target.checked })} />
        Exact ZIP buyer
      </label>

      <label className="bmv4-field">
        <span>Sort</span>
        <select value={filters.sort} onChange={(e) => onChange({ sort: e.target.value as BuyerFilterState['sort'] })}>
          {SORT_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
      </label>
    </aside>
  )
}