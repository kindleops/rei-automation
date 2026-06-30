import type { ActivityFilterState } from './buyer-match-v4.types'

interface Props {
  filters: ActivityFilterState
  eventCount: number
  mappedCount: number
  onChange: (patch: Partial<ActivityFilterState>) => void
}

const PERIODS = [30, 60, 90, 180, 365, 0] as const

export function ActivityControlsRail({ filters, eventCount, mappedCount, onChange }: Props) {
  return (
    <aside className="bmv4-rail bmv4-rail--activity">
      <div className="bmv4-rail__head">
        <span className="bmv4-eyebrow">Purchase Activity</span>
        <span className="bmv4-tabular">{eventCount} events · {mappedCount} mapped</span>
      </div>

      <div className="bmv4-segmented">
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            className={`bmv4-segmented__btn${filters.periodDays === p ? ' is-active' : ''}`}
            onClick={() => onChange({ periodDays: p })}
          >
            {p === 0 ? 'Life' : p === 365 ? '1y' : `${p}d`}
          </button>
        ))}
      </div>

      <label className="bmv4-field">
        <span>Radius (mi)</span>
        <input
          type="range"
          min={1}
          max={10}
          value={filters.radiusMiles}
          onChange={(e) => onChange({ radiusMiles: Number(e.target.value) })}
        />
        <span className="bmv4-tabular">{filters.radiusMiles} mi</span>
      </label>

      <label className="bmv4-field">
        <span>Map style</span>
        <select
          value={filters.mapStyle}
          onChange={(e) => onChange({ mapStyle: e.target.value as ActivityFilterState['mapStyle'] })}
        >
          <option value="satellite">Satellite</option>
          <option value="street">Street</option>
          <option value="hybrid">Hybrid</option>
        </select>
      </label>

      <label className="bmv4-check">
        <input type="checkbox" checked={filters.institutionalOnly} onChange={(e) => onChange({ institutionalOnly: e.target.checked })} />
        Institutional
      </label>
      <label className="bmv4-check">
        <input type="checkbox" checked={filters.localRegionalOnly} onChange={(e) => onChange({ localRegionalOnly: e.target.checked })} />
        Local / regional
      </label>
      <label className="bmv4-check">
        <input type="checkbox" checked={filters.singleAssetOnly} onChange={(e) => onChange({ singleAssetOnly: e.target.checked })} />
        Single asset
      </label>
      <label className="bmv4-check">
        <input type="checkbox" checked={filters.packageOnly} onChange={(e) => onChange({ packageOnly: e.target.checked })} />
        Package
      </label>
      <label className="bmv4-check">
        <input type="checkbox" checked={filters.pricingEligibleOnly} onChange={(e) => onChange({ pricingEligibleOnly: e.target.checked })} />
        Pricing eligible
      </label>
      <label className="bmv4-check">
        <input type="checkbox" checked={filters.demandOnly} onChange={(e) => onChange({ demandOnly: e.target.checked })} />
        Demand only
      </label>
      <label className="bmv4-check">
        <input type="checkbox" checked={filters.nonMarketOnly} onChange={(e) => onChange({ nonMarketOnly: e.target.checked })} />
        Non-market transfers
      </label>
      <label className="bmv4-check">
        <input type="checkbox" checked={filters.unknownIdentityOnly} onChange={(e) => onChange({ unknownIdentityOnly: e.target.checked })} />
        Unknown identity
      </label>
    </aside>
  )
}