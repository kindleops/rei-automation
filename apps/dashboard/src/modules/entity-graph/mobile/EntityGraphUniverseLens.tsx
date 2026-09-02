import { useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { EntityGraphLens, EntityGraphLensDimension } from '../../../domain/entity-graph/entity-graph-api'
import { compactCount } from './entity-graph-mobile-format'
import { useCountUp } from './useCountUp'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/**
 * Universe Lens — live composition of the cohort currently on screen.
 *
 * Every bar is a real `count(*)` over the same filter set the list is running;
 * nothing is sampled or extrapolated. A bucket the backend has not counted yet
 * renders as counting, never as zero, because "0 tax-delinquent properties" and
 * "we haven't counted tax delinquency yet" are different claims and only one of
 * them is true.
 *
 * Motion is doing a job here, not decoration: the count animates so a filter
 * change is legible as cause and effect, and segments morph in place (keyed by
 * bucket) so the operator can see *which* part of the cohort moved rather than
 * watching the whole bar redraw.
 */

const DIMENSION_PALETTE = ['#488aec', '#3ecf8e', '#f5a524', '#c084fc', '#f472b6', '#38bdf8']

const SIGNAL_TONES: Record<string, string> = {
  tax_delinquent: '#ff5a4e',
  active_lien: '#f5a524',
  is_hot_preforeclosure: '#f472b6',
  out_of_state_owner: '#38bdf8',
  is_corporate_owner: '#c084fc',
}

function pct(value: number, total: number): number {
  if (!total || total <= 0) return 0
  return Math.max(0, Math.min(100, (value / total) * 100))
}

/**
 * Signals overlap (a property can be both tax delinquent and absentee), so they
 * render as independent penetration bars against the cohort total — not as a
 * stacked composition that would imply they sum to the whole.
 */
function isOverlappingDimension(dimension: EntityGraphLensDimension): boolean {
  return dimension.key === 'signals'
}

function CountingBar({ label }: { label: string }) {
  return (
    <div className="egl-chart is-pending">
      <div className="egl-chart__pendingbar" />
      <span className="egl-chart__pendinglabel">
        <span className="egl-dot-pulse" aria-hidden />
        Counting {label.toLowerCase()}…
      </span>
    </div>
  )
}

function DimensionChart({
  dimension,
  total,
  activeBucketKeys,
  onSelectBucket,
}: {
  dimension: EntityGraphLensDimension
  total: number
  activeBucketKeys: Set<string>
  onSelectBucket?: (dimensionKey: string, bucketKey: string) => void
}) {
  const counted = dimension.buckets.filter((b) => typeof b.value === 'number')
  if (dimension.pending || counted.length === 0) return <CountingBar label={dimension.label} />

  if (isOverlappingDimension(dimension)) {
    return (
      <div className="egl-signals">
        {counted.map((bucket) => {
          const value = bucket.value as number
          const shareOf = pct(value, total)
          return (
            <button
              key={bucket.key}
              type="button"
              className={cls('egl-signal', activeBucketKeys.has(bucket.key) && 'is-active')}
              onClick={onSelectBucket ? () => onSelectBucket(dimension.key, bucket.key) : undefined}
            >
              <span className="egl-signal__label">{bucket.label}</span>
              <span className="egl-signal__track">
                <span
                  className="egl-signal__fill"
                  style={{
                    width: `${Math.max(shareOf, value > 0 ? 1.5 : 0)}%`,
                    background: SIGNAL_TONES[bucket.key] ?? '#488aec',
                  }}
                />
              </span>
              <span className="egl-signal__value">{compactCount(value)}</span>
            </button>
          )
        })}
      </div>
    )
  }

  const sum = counted.reduce((acc, b) => acc + (b.value as number), 0)
  // Buckets can under-cover the cohort (a row whose value falls in no band, or
  // is null). Showing the remainder keeps the bar honest about what it covers.
  const uncovered = Math.max(0, total - sum)
  const anyActive = counted.some((b) => activeBucketKeys.has(b.key))

  return (
    <div className="egl-chart">
      <div className="egl-stack" role="img" aria-label={`${dimension.label} composition`}>
        {counted.map((bucket, index) => {
          const value = bucket.value as number
          const width = pct(value, total)
          const isActive = activeBucketKeys.has(bucket.key)
          return (
            <button
              // Keyed by bucket so React reuses the node and the width
              // transition morphs in place instead of the bar redrawing.
              key={bucket.key}
              type="button"
              className={cls(
                'egl-stack__seg',
                isActive && 'is-active',
                anyActive && !isActive && 'is-dimmed',
                value <= 0 && 'is-zero',
              )}
              style={{
                width: `${width}%`,
                background: DIMENSION_PALETTE[index % DIMENSION_PALETTE.length],
              }}
              aria-label={`${bucket.label}: ${value.toLocaleString()}`}
              onClick={onSelectBucket ? () => onSelectBucket(dimension.key, bucket.key) : undefined}
            />
          )
        })}
        {uncovered > 0 ? (
          <span
            className="egl-stack__seg is-uncovered"
            style={{ width: `${pct(uncovered, total)}%` }}
            aria-label={`Not in a listed bucket: ${uncovered.toLocaleString()}`}
          />
        ) : null}
      </div>

      <div className="egl-legend">
        {counted.map((bucket, index) => (
          <button
            key={bucket.key}
            type="button"
            className={cls('egl-legend__item', activeBucketKeys.has(bucket.key) && 'is-active')}
            onClick={onSelectBucket ? () => onSelectBucket(dimension.key, bucket.key) : undefined}
          >
            <span
              className="egl-legend__dot"
              style={{ background: DIMENSION_PALETTE[index % DIMENSION_PALETTE.length] }}
            />
            <span className="egl-legend__label">{bucket.label}</span>
            <span className="egl-legend__value">{compactCount(bucket.value as number)}</span>
          </button>
        ))}
        {uncovered > 0 ? (
          <span className="egl-legend__item is-uncovered">
            <span className="egl-legend__dot" />
            <span className="egl-legend__label">Unbanded</span>
            <span className="egl-legend__value">{compactCount(uncovered)}</span>
          </span>
        ) : null}
      </div>
    </div>
  )
}

function HeadlineStat({ label, value, total }: { label: string; value: number | null; total: number }) {
  const animated = useCountUp(value)
  return (
    <div className="egl-headline__item">
      <em>{label}</em>
      <strong>{animated === null ? '—' : compactCount(animated)}</strong>
      {value !== null && total > 0 ? <small>{pct(value, total).toFixed(0)}%</small> : null}
    </div>
  )
}

type Props = {
  lens: EntityGraphLens | null
  deepLens: EntityGraphLens | null
  loading: boolean
  cohortLabel: string
  filtered: boolean
  /** Bucket keys the current filter set corresponds to, for active state. */
  activeBucketKeys: Set<string>
  hasSavedCohort: boolean
  /** Collapse regardless of the operator's own toggle (e.g. the selection dock
   *  is open and the results below need the room). */
  forceCollapsed?: boolean
  /** Label of the saved cohort, shown so "compare with A" names what A is. */
  savedCohortLabel?: string | null
  onSelectBucket?: (dimensionKey: string, bucketKey: string) => void
  onSaveCohort?: () => void
  onOpenCompare?: () => void
  onClearSaved?: () => void
}

export function EntityGraphUniverseLens({
  lens,
  deepLens,
  loading,
  cohortLabel,
  filtered,
  activeBucketKeys,
  hasSavedCohort,
  forceCollapsed,
  savedCohortLabel,
  onSelectBucket,
  onSaveCohort,
  onOpenCompare,
  onClearSaved,
}: Props) {
  const [dimensionKey, setDimensionKey] = useState<string | null>(null)
  const [selfCollapsed, setSelfCollapsed] = useState(false)
  const collapsed = selfCollapsed || Boolean(forceCollapsed)

  // The deep part arrives separately; merge it over the fast skeleton so
  // pending dimensions resolve in place rather than re-ordering the rail.
  const dimensions = useMemo(() => {
    const base = lens?.dimensions ?? []
    if (!deepLens?.dimensions?.length) return base
    const byKey = new Map(deepLens.dimensions.map((d) => [d.key, d]))
    return base.map((d) => byKey.get(d.key) ?? d)
  }, [deepLens, lens])

  const total = lens?.total ?? 0
  const animatedTotal = useCountUp(lens?.total ?? null)
  const active = dimensions.find((d) => d.key === dimensionKey) ?? dimensions[0]

  if (loading && !lens) {
    return (
      <section className="egl">
        <div className="egl-skeleton" aria-label="Loading cohort composition" />
      </section>
    )
  }

  if (!lens) return null

  return (
    <section className={cls('egl', collapsed && 'is-collapsed', filtered && 'is-filtered')} aria-label="Universe Lens">
      <header className="egl-head">
        <button
          type="button"
          className="egl-head__toggle"
          onClick={() => setSelfCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand lens' : 'Collapse lens'}
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} />
        </button>
        <div className="egl-head__id">
          <strong aria-live="polite">
            {animatedTotal === null ? '—' : animatedTotal.toLocaleString()}
          </strong>
          <span>{cohortLabel}</span>
        </div>
        {filtered ? <span className="egl-head__chip">Cohort</span> : null}
      </header>

      {/* Labelled, not icon-only. The two cohort controls were a bookmark and a
          stack glyph, which is unguessable for a workflow the operator has to
          perform in a specific order (save A, change filters, compare). The
          saved cohort's own label is the clear-state affordance. */}
      {collapsed ? null : (onSaveCohort || onOpenCompare) ? (
        <div className="egl-cohortbar">
          {onSaveCohort ? (
            <button type="button" className="egl-cohortbtn" onClick={onSaveCohort}>
              <Icon name="bookmark" />
              {hasSavedCohort ? 'Replace cohort A' : 'Save cohort A'}
            </button>
          ) : null}
          {onOpenCompare ? (
            <button
              type="button"
              className={cls('egl-cohortbtn', hasSavedCohort && 'is-armed')}
              onClick={onOpenCompare}
            >
              <Icon name="layers" />
              {hasSavedCohort ? 'Compare with A' : 'Compare cohorts'}
            </button>
          ) : null}
          {hasSavedCohort && savedCohortLabel ? (
            <span className="egl-cohortsaved" title={`Saved cohort A: ${savedCohortLabel}`}>
              A · {savedCohortLabel}
              {onClearSaved ? (
                <button type="button" onClick={onClearSaved} aria-label="Clear saved cohort A">×</button>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}

      {collapsed ? null : (
        <>
          {lens.headline?.length ? (
            <div className="egl-headline">
              {lens.headline.map((item) => (
                <HeadlineStat key={item.key} label={item.label} value={item.value} total={total} />
              ))}
            </div>
          ) : null}

          {dimensions.length > 0 && active ? (
            <>
              <div className="egl-dimrail" role="tablist" aria-label="Lens dimensions">
                {dimensions.map((dimension) => {
                  const isActive = dimension.key === active.key
                  const hasFilter = dimension.buckets.some((b) => activeBucketKeys.has(b.key))
                  return (
                    <button
                      key={dimension.key}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      className={cls('egl-dimrail__item', isActive && 'is-active', hasFilter && 'is-filtered')}
                      onClick={() => setDimensionKey(dimension.key)}
                    >
                      {dimension.label}
                      {dimension.pending ? <span className="egl-dot-pulse" aria-label="counting" /> : null}
                      {hasFilter ? <span className="egl-dimrail__flag" aria-label="filtered" /> : null}
                    </button>
                  )
                })}
              </div>

              <DimensionChart
                dimension={active}
                total={total}
                activeBucketKeys={activeBucketKeys}
                onSelectBucket={onSelectBucket}
              />
            </>
          ) : (
            <div className="egl-empty">No composition dimensions for this scope.</div>
          )}
        </>
      )}
    </section>
  )
}
