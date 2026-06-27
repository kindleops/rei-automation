/**
 * Comp Intelligence V4 — search / filter control bar.
 * Checkpoint 1 wires radius, lookback, evidence tier, and map style live.
 * Advanced filters (source, asset matching, tolerances) land in Checkpoint 4.
 */

import {
  LOOKBACK_OPTIONS,
  RADIUS_OPTIONS,
  type EvidenceTierFilter,
  type MapStyleMode,
} from '../hooks/useCompV4Search'

export type TierCounts = Record<EvidenceTierFilter, number>

interface SearchControlBarProps {
  radiusMiles: number
  monthsBack: number
  tier: EvidenceTierFilter
  mapStyle: MapStyleMode
  counts: TierCounts
  busy: boolean
  onRadius: (m: number) => void
  onMonthsBack: (m: number) => void
  onTier: (t: EvidenceTierFilter) => void
  onMapStyle: (s: MapStyleMode) => void
}

const TIERS: Array<{ id: EvidenceTierFilter; label: string }> = [
  { id: 'qualified', label: 'Qualified' },
  { id: 'candidate', label: 'Candidate' },
  { id: 'review', label: 'Review' },
  { id: 'demand_only', label: 'Demand' },
  { id: 'excluded', label: 'Excluded' },
  { id: 'all', label: 'All' },
]

const STYLES: Array<{ id: MapStyleMode; label: string }> = [
  { id: 'street', label: 'Street' },
  { id: 'satellite', label: 'Satellite' },
  { id: 'hybrid', label: 'Hybrid' },
]

export function SearchControlBar(props: SearchControlBarProps) {
  const { radiusMiles, monthsBack, tier, mapStyle, counts, busy } = props
  const tierCount = (id: EvidenceTierFilter) => counts[id]

  return (
    <div className="civ4-controls" aria-label="Comp search controls">
      <label className="civ4-control">
        <span className="civ4-control__label">Radius</span>
        <select
          className="civ4-select"
          value={radiusMiles}
          onChange={(e) => props.onRadius(Number(e.target.value))}
        >
          {RADIUS_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r} mi
            </option>
          ))}
        </select>
      </label>

      <label className="civ4-control">
        <span className="civ4-control__label">Lookback</span>
        <select
          className="civ4-select"
          value={monthsBack}
          onChange={(e) => props.onMonthsBack(Number(e.target.value))}
        >
          {LOOKBACK_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m} mo
            </option>
          ))}
        </select>
      </label>

      <div className="civ4-control">
        <span className="civ4-control__label">Evidence</span>
        <div className="civ4-segment" role="tablist">
          {TIERS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tier === t.id}
              className={`civ4-segment__btn ${tier === t.id ? 'is-active' : ''}`}
              onClick={() => props.onTier(t.id)}
            >
              {t.label}
              <span className="civ4-segment__count">{tierCount(t.id)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="civ4-control civ4-control--right">
        <span className="civ4-control__label">Map</span>
        <div className="civ4-segment">
          {STYLES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`civ4-segment__btn ${mapStyle === s.id ? 'is-active' : ''}`}
              onClick={() => props.onMapStyle(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {busy && <span className="civ4-spinner" aria-label="Refreshing" />}
      </div>
    </div>
  )
}
