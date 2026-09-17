import { useMemo } from 'react'
import { USA_STATE_PATHS } from '../../../lib/data/usaStatePaths'
import type { StatePerformance } from '../../../lib/data/kpiDashboardData'
import { metricCount, metricIntensity, type GeoMetric } from './geo-metric'
import { NATIONAL_VIEWBOX, stateViewBox } from './state-path-bounds'

/**
 * THE UNITED STATES, as an interactive touch map.
 *
 * §7 asks for a cinematic analytical map rather than a decorative thumbnail, and
 * §30.24 forbids any core interpretation that depends on hover. So:
 *
 *   * every state is a TAP target, and the selection state is visible, not a tooltip
 *   * the label beside the selected state carries its value, so nothing has to be
 *     hovered to be read
 *   * drilling into a state animates the viewBox to frame it — the same map, moved,
 *     rather than a second component
 *
 * States with no data are painted as absent rather than as zero. A national map that
 * renders 46 quiet states in the same ramp as the four live ones says the business is
 * nationwide, which it is not.
 */

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

/** Labels are omitted for the states whose shapes cannot hold one at 390px. */
const NO_LABEL = new Set(['DC', 'RI', 'DE', 'CT', 'NJ', 'MA', 'NH', 'VT', 'MD', 'HI'])

export interface GeoChoroplethProps {
  states: StatePerformance[]
  metric: GeoMetric
  selectedState: string | null
  onSelectState: (abbr: string | null) => void
  loading: boolean
}

export const GeoChoropleth = ({
  states,
  metric,
  selectedState,
  onSelectState,
  loading,
}: GeoChoroplethProps) => {
  const byState = useMemo(() => new Map(states.map((row) => [row.state, row])), [states])

  const max = useMemo(
    () => states.reduce((best, row) => Math.max(best, metricCount(row, metric)), 0),
    [states, metric],
  )

  const viewBox = useMemo(() => stateViewBox(selectedState), [selectedState])

  return (
    <div className={cls('geo-map', loading && 'is-loading')}>
      <svg
        className="geo-map__svg"
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`United States, shaded by ${metric.label}`}
      >
        <defs>
          <filter id="geo-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feComposite in="SourceGraphic" in2="b" operator="over" />
          </filter>
        </defs>

        {/* Painted in two passes so an active state is never overdrawn by a
            neighbour's border, which is what made the desktop map's selection
            read as a thin sliver of outline. */}
        {Object.entries(USA_STATE_PATHS).map(([abbr, shape]) => {
          const row = byState.get(abbr)
          const intensity = metricIntensity(row, metric, max)
          const hasData = Boolean(row) && metricCount(row!, metric) > 0
          /**
           * A state can be in the leaderboard and still be zero on the CURRENT
           * metric — Connecticut has three replies and no sends. Painting it as
           * inert would make the map say the business is not operating there,
           * which is not what a zero on one metric means. It gets the active
           * outline without the fill.
           */
          const isActiveScope = Boolean(row) && !hasData
          const isSelected = selectedState === abbr
          const dimmed = Boolean(selectedState) && !isSelected

          return (
            <path
              key={abbr}
              d={shape.path}
              className={cls(
                'geo-map__state',
                hasData && 'has-data',
                isActiveScope && 'is-scoped',
                isSelected && 'is-selected',
                dimmed && 'is-dimmed',
              )}
              style={{
                fill: hasData
                  ? `rgba(${metric.inverse ? '239, 68, 68' : 'var(--nexus-accent-rgb, 94, 234, 212)'}, ${0.14 + intensity * 0.62})`
                  : undefined,
                filter: isSelected ? 'url(#geo-glow)' : undefined,
              }}
              tabIndex={row ? 0 : -1}
              role="button"
              aria-label={`${row?.stateName ?? abbr}: ${metricCount(row ?? { sent: 0, delivered: 0, replied: 0, positive: 0, optOut: 0 } as StatePerformance, metric).toLocaleString()} ${metric.shortLabel}`}
              aria-pressed={isSelected}
              onClick={() => { if (!row) return; onSelectState(isSelected ? null : abbr) }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                if (!row) return
                event.preventDefault()
                onSelectState(isSelected ? null : abbr)
              }}
            />
          )
        })}

        {/* Value labels are the hover replacement: the number sits ON the map,
            permanently, for the states that reported activity.
            
            Suppressed once a state is selected. SVG text scales with the viewBox,
            so at a state-level zoom a 13px label becomes a ~40px blocky stamp
            across the shape — and it is redundant anyway, because the headline
            immediately below states the same value at the right size. */}
        {!selectedState ? Object.entries(USA_STATE_PATHS).map(([abbr, shape]) => {
          const row = byState.get(abbr)
          if (!row) return null
          if (NO_LABEL.has(abbr) && selectedState !== abbr) return null
          return (
            <g key={`label-${abbr}`} className="geo-map__label" pointerEvents="none">
              <text x={shape.cx} y={shape.cy - 2} textAnchor="middle">{abbr}</text>
              <text x={shape.cx} y={shape.cy + 14} textAnchor="middle" className="geo-map__label-value">
                {metricCount(row, metric) > 0 ? metricCount(row, metric).toLocaleString() : '0'}
              </text>
            </g>
          )
        }) : null}
      </svg>

      {selectedState ? (
        <button type="button" className="geo-map__back" onClick={() => onSelectState(null)}>
          United States
        </button>
      ) : null}

      {loading ? <div className="geo-map__loading" role="status">Reading metrics…</div> : null}
    </div>
  )
}

export { NATIONAL_VIEWBOX }
