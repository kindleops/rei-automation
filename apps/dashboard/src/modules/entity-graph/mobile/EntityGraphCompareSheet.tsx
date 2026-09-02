import { Icon } from '../../../shared/icons'
import { MobileSheet } from '../../mobile/MobileSheet'
import type { EntityGraphLens, EntityGraphLensDimension } from '../../../domain/entity-graph/entity-graph-api'
import type { EntityGraphFilters } from '../../../domain/entity-graph/entity-graph.types'
import { activeFilterEntries, type EntityScope } from './entity-graph-mobile-format'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/**
 * A cohort snapshot: the lens result plus enough of the query to say what it
 * was. Stored verbatim so a comparison always describes the cohort that was
 * actually measured, not whatever the filters happen to be now.
 */
export type CohortSnapshot = {
  label: string
  scope: EntityScope
  filters: EntityGraphFilters
  savedAt: number
  lens: EntityGraphLens
  deepLens: EntityGraphLens | null
}

function mergeDimensions(snapshot: CohortSnapshot | null): EntityGraphLensDimension[] {
  if (!snapshot) return []
  const base = snapshot.lens.dimensions ?? []
  if (!snapshot.deepLens?.dimensions?.length) return base
  const byKey = new Map(snapshot.deepLens.dimensions.map((d) => [d.key, d]))
  return base.map((d) => byKey.get(d.key) ?? d)
}

/** Share of the cohort a bucket represents, or null when either side is unknown. */
function share(value: number | null | undefined, total: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (!total || total <= 0) return null
  return (value / total) * 100
}

function formatDelta(delta: number | null): { text: string; tone: 'up' | 'down' | 'flat' | 'unknown' } {
  if (delta === null) return { text: '—', tone: 'unknown' }
  const rounded = Math.round(delta * 10) / 10
  if (Math.abs(rounded) < 0.1) return { text: 'same', tone: 'flat' }
  return { text: `${rounded > 0 ? '+' : ''}${rounded}pp`, tone: rounded > 0 ? 'up' : 'down' }
}

function describeFilters(snapshot: CohortSnapshot): string {
  const entries = activeFilterEntries(snapshot.filters, snapshot.scope)
  if (entries.length === 0) return 'no filters — full universe'
  return entries.map((e) => `${e.label} ${e.value}`).join(' · ')
}

type Props = {
  open: boolean
  saved: CohortSnapshot | null
  current: CohortSnapshot | null
  onClose: () => void
  onSaveCurrent: () => void
  onClearSaved: () => void
}

/**
 * Compare Cohorts.
 *
 * Deliberately not an analytics dashboard: it answers one question — how does
 * the cohort I am looking at now differ from the one I saved. Sizes compare as
 * counts, everything else compares as *share of its own cohort*, because two
 * cohorts of different size have no meaningful count-to-count comparison.
 *
 * A dimension that either side has not counted renders as unknown, never as a
 * zero delta. That matters most for the deep facets, which arrive after the
 * fast ones — a "0pp change" that really means "not measured yet" would be the
 * most misleading thing this screen could say.
 */
export function EntityGraphCompareSheet({
  open,
  saved,
  current,
  onClose,
  onSaveCurrent,
  onClearSaved,
}: Props) {
  const savedDims = mergeDimensions(saved)
  const currentDims = mergeDimensions(current)
  const savedTotal = saved?.lens.total ?? null
  const currentTotal = current?.lens.total ?? null

  const sizeDelta = savedTotal !== null && currentTotal !== null ? currentTotal - savedTotal : null
  const sizePct = savedTotal && savedTotal > 0 && sizeDelta !== null
    ? Math.round((sizeDelta / savedTotal) * 1000) / 10
    : null

  return (
    <MobileSheet
      open={open}
      title="Compare cohorts"
      subtitle={saved ? `B vs ${saved.label}` : 'Save a cohort to compare against'}
      height="full"
      className="egm-sheet"
      onClose={onClose}
    >
      <div className="egcmp">
        {!saved ? (
          <div className="egcmp-empty">
            <Icon name="layers" />
            <strong>No saved cohort yet</strong>
            <span>
              Filter down to an audience, save it as A, then change the filters and come
              back here to see what moved.
            </span>
            <button type="button" className="egm-btn is-primary" onClick={onSaveCurrent}>
              Save current cohort as A
            </button>
          </div>
        ) : (
          <>
            <section className="egcmp-heads">
              <div className="egcmp-head is-a">
                <em>A · {saved.label}</em>
                <strong>{savedTotal === null ? '—' : savedTotal.toLocaleString()}</strong>
                <small>{describeFilters(saved)}</small>
              </div>
              <div className="egcmp-head is-b">
                <em>B · current</em>
                <strong>{currentTotal === null ? '—' : currentTotal.toLocaleString()}</strong>
                <small>{current ? describeFilters(current) : '—'}</small>
              </div>
            </section>

            {saved.scope !== current?.scope ? (
              <p className="egcmp-warn">
                A is a <b>{saved.scope.replace(/_/g, ' ')}</b> cohort and B is{' '}
                <b>{current?.scope.replace(/_/g, ' ')}</b>. Only size is comparable across
                different entity types — the dimensions below are not.
              </p>
            ) : null}

            <section className="egcmp-size">
              <div className="egcmp-size__label">Cohort size</div>
              <div className={cls('egcmp-size__delta', sizeDelta !== null && (sizeDelta > 0 ? 'is-up' : sizeDelta < 0 ? 'is-down' : 'is-flat'))}>
                {sizeDelta === null ? '—' : `${sizeDelta > 0 ? '+' : ''}${sizeDelta.toLocaleString()}`}
                {sizePct !== null ? <small>{sizePct > 0 ? '+' : ''}{sizePct}%</small> : null}
              </div>
            </section>

            {saved.scope === current?.scope
              ? savedDims.map((dimension) => {
                  const other = currentDims.find((d) => d.key === dimension.key)
                  if (!other) return null
                  return (
                    <section key={dimension.key} className="egcmp-dim">
                      <h4>{dimension.label}</h4>
                      <div className="egcmp-rows">
                        {dimension.buckets.map((bucket) => {
                          const bBucket = other.buckets.find((x) => x.key === bucket.key)
                          const aShare = share(bucket.value, savedTotal)
                          const bShare = share(bBucket?.value, currentTotal)
                          const delta = aShare !== null && bShare !== null ? bShare - aShare : null
                          const { text, tone } = formatDelta(delta)
                          return (
                            <div key={bucket.key} className="egcmp-row">
                              <span className="egcmp-row__label">{bucket.label}</span>
                              <span className="egcmp-row__bars">
                                <span className="egcmp-bar is-a">
                                  <span style={{ width: `${aShare ?? 0}%` }} />
                                </span>
                                <span className="egcmp-bar is-b">
                                  <span style={{ width: `${bShare ?? 0}%` }} />
                                </span>
                              </span>
                              <span className="egcmp-row__nums">
                                <em>{aShare === null ? '—' : `${Math.round(aShare)}%`}</em>
                                <em>{bShare === null ? '—' : `${Math.round(bShare)}%`}</em>
                              </span>
                              <span className={cls('egcmp-row__delta', `is-${tone}`)}>{text}</span>
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  )
                })
              : null}

            {saved.lens.headline?.length && current?.lens.headline?.length ? (
              <section className="egcmp-dim">
                <h4>Coverage</h4>
                <div className="egcmp-rows">
                  {saved.lens.headline.map((item) => {
                    const bItem = current.lens.headline?.find((x) => x.key === item.key)
                    const aShare = share(item.value, savedTotal)
                    const bShare = share(bItem?.value, currentTotal)
                    const delta = aShare !== null && bShare !== null ? bShare - aShare : null
                    const { text, tone } = formatDelta(delta)
                    return (
                      <div key={item.key} className="egcmp-row">
                        <span className="egcmp-row__label">{item.label}</span>
                        <span className="egcmp-row__bars">
                          <span className="egcmp-bar is-a"><span style={{ width: `${aShare ?? 0}%` }} /></span>
                          <span className="egcmp-bar is-b"><span style={{ width: `${bShare ?? 0}%` }} /></span>
                        </span>
                        <span className="egcmp-row__nums">
                          <em>{aShare === null ? '—' : `${Math.round(aShare)}%`}</em>
                          <em>{bShare === null ? '—' : `${Math.round(bShare)}%`}</em>
                        </span>
                        <span className={cls('egcmp-row__delta', `is-${tone}`)}>{text}</span>
                      </div>
                    )
                  })}
                </div>
              </section>
            ) : null}

            <p className="egcmp-note">
              Shares are each bucket as a percentage of its own cohort — two cohorts of
              different size have no meaningful count-to-count comparison. A dimension
              neither side has finished counting shows “—”, not a zero delta.
            </p>

            <div className="egm-filters__footer">
              <button type="button" className="egm-btn is-ghost" onClick={onClearSaved}>Clear A</button>
              <button type="button" className="egm-btn is-primary" onClick={onSaveCurrent}>
                Replace A with current
              </button>
            </div>
          </>
        )}
      </div>
    </MobileSheet>
  )
}
