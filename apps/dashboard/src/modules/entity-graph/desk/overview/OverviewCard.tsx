/**
 * One Overview field card (spec 9 §4.1): title · coverage ("known N of M ·
 * 82.4%" + a thin meter, "Not recorded" its own bucket, never folded) · the
 * chart · a readout of the hovered bucket · the exact table (toggle) · CSV.
 *
 * Every bar is a button carrying the rail's own chip: click = that chip,
 * shift-click = add to the field's set, alt-click = exclude. "Show records"
 * (table rows) applies it and switches to the grid. Bars are scaled to the
 * largest VALUE bucket; "Not recorded" is hatched neutral, "Everything else"
 * plain neutral; a filtered field shows its unfiltered context as ghost bars.
 */
import { useMemo, useState, type MouseEvent } from 'react'
import { cx, lcToast } from '../../../../shared/lc'
import { Icon } from '../../../../shared/icons'
import type { EntityGraphFieldFilter } from '../../../../domain/entity-graph/entity-graph-field-filters'
import { applyBucketClick, barScale, bucketActive, bucketExcluded, bucketsCsv, chartForm, clickModeFromEvent, fieldFiltered, fmtInt, fmtShare, fmtValue, staggerDelay } from './overview-model'
import type { OverviewBucket, OverviewField } from './overview-types'

type Props = {
  field: OverviewField
  filters: EntityGraphFieldFilter[]
  onFiltersChange: (next: EntityGraphFieldFilter[], opts?: { showRecords?: boolean }) => void
  compact?: boolean
  /** position in its grid: the staggered entrance starts this card a little after the previous one */
  enterIndex?: number
  /** re-read the section (a field that ran past its budget says retry) */
  onRetry?: () => void
}

const toneClass = (b: OverviewBucket) => (b.tone === 'none' ? 'is-none' : b.tone === 'other' ? 'is-other' : b.tone === 'no' ? 'is-no' : b.tone === 'yes' ? 'is-yes' : 'is-value')

export function OverviewCard({ field, filters, onFiltersChange, compact = false, enterIndex = 0, onRetry }: Props) {
  const [table, setTable] = useState(false)
  const [hover, setHover] = useState<OverviewBucket | null>(null)
  const total = field.coverage?.total ?? 0
  const known = field.coverage?.known ?? 0
  const buckets = field.buckets ?? []
  const form = chartForm(field)
  const filtered = fieldFiltered(filters, field.key)
  const ghost = useMemo(() => (field.ghost ? new Map(field.ghost.buckets.map((b) => [b.key, b.count])) : null), [field.ghost])

  const click = (b: OverviewBucket, e: MouseEvent | null, showRecords = false) => {
    if (!b.filter) {
      lcToast({ title: b.tone === 'other' ? '“Everything else” is a remainder, not a value — pick a bar.' : 'This bucket has no filter of its own.', severity: 'info' })
      return
    }
    const r = applyBucketClick(filters, b.filter, e ? clickModeFromEvent(e) : 'replace')
    if (!r.applied) { lcToast({ title: r.reason ?? 'Not applied', severity: 'info' }); return }
    onFiltersChange(r.filters, { showRecords })
  }
  const copyCsv = async () => {
    try {
      await navigator.clipboard.writeText(bucketsCsv(field))
      lcToast({ title: `${field.label} copied as CSV`, severity: 'success' })
    } catch {
      lcToast({ title: 'The clipboard is not available here.', severity: 'info' })
    }
  }

  if (field.unavailable) {
    return (
      <article className={cx('egov-card', 'egov-enter', 'is-unavailable', compact && 'is-compact')} style={{ animationDelay: `${staggerDelay(enterIndex)}ms` }} aria-label={field.label}>
        <header className="egov-card__head"><h4 className="egov-card__title">{field.label}{field.sensitive ? <SensitiveMark /> : null}</h4></header>
        <p className="egov-card__na"><Icon name="clock" size={12} /> {field.unavailable}{field.retry && onRetry ? <> <button type="button" className="egov-link" onClick={onRetry}>Retry</button></> : null}</p>
      </article>
    )
  }

  const share = total ? known / total : 0
  const readout = hover
    ? `${hover.label} · ${fmtInt(hover.count)} · ${fmtShare(hover.count, total)}${ghost && ghost.get(hover.key) !== undefined ? ` · ${fmtInt(ghost.get(hover.key) ?? null)} without this filter` : ''}`
    : null
  /**
   * A filtered categorical field lists its UNFILTERED context (the ghost's
   * values) with the cohort's own count on each — so the market card still
   * offers every other market to switch to; values outside the cohort read 0.
   */
  const barRows = useMemo(() => {
    if (form !== 'bars' || !field.ghost) return buckets
    const own = new Map(buckets.map((b) => [b.key, b]))
    const rows = field.ghost.buckets.filter((g) => g.tone !== 'other').map((g) => ({ ...g, count: own.get(g.key)?.count ?? 0, filter: own.get(g.key)?.filter ?? g.filter }))
    for (const b of buckets) if (!rows.some((r) => r.key === b.key) && b.tone !== 'other') rows.push(b)
    // the cohort's own values first (the chip's), then the context to switch to
    const rank = (r: OverviewBucket) => (bucketActive(filters, r.filter) ? 0 : r.tone === 'none' ? 2 : 1)
    return [...rows.filter((r) => r.count > 0).sort((a, b) => rank(a) - rank(b) || b.count - a.count), ...rows.filter((r) => r.count === 0)]
  }, [form, field.ghost, buckets, filters])
  const max = barScale(form === 'bars' && field.ghost ? barRows : buckets)
  const ghostMax = field.ghost ? barScale(field.ghost.buckets) : 1

  return (
    <article className={cx('egov-card', 'egov-enter', `is-${form}`, filtered && 'is-filtered', compact && 'is-compact', field.emptySource && 'is-empty', field.sensitive && 'is-sensitive')} style={{ animationDelay: `${staggerDelay(enterIndex)}ms` }} aria-label={field.label} data-field={field.key}>
      <header className="egov-card__head">
        <h4 className="egov-card__title" title={field.caution || undefined}>{field.label}{field.sensitive ? <SensitiveMark /> : null}{filtered ? <span className="egov-card__dot" aria-label="filtered" /> : null}</h4>
        <div className="egov-card__tools">
          {buckets.length ? <button type="button" className={cx('egov-tool', table && 'is-on')} aria-pressed={table} onClick={() => setTable((t) => !t)} title="Exact table"><Icon name="list" size={12} /></button> : null}
          {buckets.length ? <button type="button" className="egov-tool" onClick={() => { void copyCsv() }} title="Copy as CSV"><Icon name="file-text" size={12} /></button> : null}
        </div>
      </header>
      <div className="egov-cov" title={`${fmtInt(known)} of ${fmtInt(total)} properties have a value`}>
        <span className="egov-cov__text">known <b>{fmtInt(known)}</b> of {fmtInt(total)} · {fmtShare(known, total)}</span>
        <span className="egov-cov__meter" aria-hidden="true"><i style={{ width: `${Math.min(100, share * 100)}%` }} /></span>
      </div>

      {field.emptySource && !known ? (
        <p className="egov-card__na">No values in the system for this field.</p>
      ) : table ? (
        <table className="egov-table">
          <thead><tr><th scope="col">Bucket</th><th scope="col">Properties</th><th scope="col">Share</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.key} className={toneClass(b)}>
                <th scope="row">{b.label}</th>
                <td>{fmtInt(b.count)}</td>
                <td>{fmtShare(b.count, total)}</td>
                <td>{b.filter ? <button type="button" className="egov-link" onClick={() => click(b, null, true)}>Show records</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : form === 'coverage' ? (
        <div className="egov-coverage">
          <b className="egov-coverage__n">{field.distinct !== null && field.distinct !== undefined ? fmtInt(field.distinct) : '—'}</b>
          <span className="egov-coverage__l">{field.distinct !== null && field.distinct !== undefined ? 'distinct values' : 'distinct not counted for cohorts above 50,000'}</span>
        </div>
      ) : form === 'split' ? (
        <div className="egov-split">
          <div className="egov-split__bar" role="img" aria-label={buckets.map((b) => `${b.label} ${fmtInt(b.count)}`).join(', ')}>
            {buckets.filter((b) => b.count > 0).map((b) => (
              <button key={b.key} type="button" className={cx('egov-split__seg', toneClass(b), bucketActive(filters, b.filter) && 'is-active')} style={{ flexGrow: b.count }} onClick={(e) => click(b, e)} onMouseEnter={() => setHover(b)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(b)} onBlur={() => setHover(null)} aria-label={`${b.label}: ${fmtInt(b.count)}`} />
            ))}
          </div>
          <ul className="egov-split__legend">
            {buckets.map((b) => (
              <li key={b.key}>
                <button type="button" className={cx('egov-legend', toneClass(b), bucketActive(filters, b.filter) && 'is-active')} onClick={(e) => click(b, e)} disabled={!b.filter}>
                  <i aria-hidden="true" /><span>{b.label}</span><b>{fmtInt(b.count)}</b><small>{fmtShare(b.count, total)}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : form === 'histogram' ? (
        <div className="egov-hist" role="group" aria-label={`${field.label} histogram`}>
          <div className="egov-hist__plot">
            {buckets.map((b) => {
              // "Not recorded" sits beside the histogram on its own (capped) scale — it never sets the bins' scale
              const h = Math.min(100, (b.count / (b.tone === 'none' ? Math.max(max, b.count) : max)) * 100)
              const g = ghost?.get(b.key)
              return (
                <button key={b.key} type="button" className={cx('egov-col', toneClass(b), bucketActive(filters, b.filter) && 'is-active', !b.filter && 'is-static')}
                  onClick={(e) => click(b, e)} onMouseEnter={() => setHover(b)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(b)} onBlur={() => setHover(null)}
                  aria-label={`${b.label}: ${fmtInt(b.count)} (${fmtShare(b.count, total)})`}>
                  {g !== undefined && g !== null ? <span className="egov-col__ghost" style={{ height: `${Math.min(100, (g / ghostMax) * 100)}%` }} aria-hidden="true" /> : null}
                  <span className="egov-col__fill" style={{ height: `${b.count > 0 ? Math.max(2, h) : 0}%` }} aria-hidden="true" />
                </button>
              )
            })}
          </div>
          {buckets.length <= 9 ? (
            // few bins (beds, baths, age buckets, income bands…): every bar is labelled
            <div className="egov-hist__ticks" aria-hidden="true">
              {buckets.map((b) => <span key={b.key} className={cx(b.tone === 'none' && 'is-none')} title={b.label}>{b.tone === 'none' ? '—' : b.label}</span>)}
            </div>
          ) : (
            <div className="egov-hist__axis" aria-hidden="true">
              <span>{buckets[0]?.label ?? ''}</span>
              <span>{buckets.filter((b) => b.tone !== 'none').at(-1)?.label ?? ''}</span>
            </div>
          )}
        </div>
      ) : (
        <ol className="egov-bars">
          {(compact ? barRows.slice(0, 5) : barRows).map((b) => {
            const g = ghost?.get(b.key)
            return (
              <li key={b.key}>
                <button type="button" className={cx('egov-bar', toneClass(b), bucketActive(filters, b.filter) && 'is-active', bucketExcluded(filters, b.filter) && 'is-excluded', !b.filter && 'is-static')}
                  onClick={(e) => click(b, e)} onMouseEnter={() => setHover(b)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(b)} onBlur={() => setHover(null)}
                  title={b.filter ? 'Click: filter · Shift: add · Alt: exclude' : undefined}>
                  <span className="egov-bar__label">{b.label}</span>
                  <span className="egov-bar__track" aria-hidden="true">
                    {g !== undefined && g !== null ? <i className="egov-bar__ghost" style={{ width: `${Math.min(100, (g / ghostMax) * 100)}%` }} /> : null}
                    <i className="egov-bar__fill" style={{ width: `${b.tone === 'none' || b.tone === 'other' ? Math.min(100, (b.count / Math.max(max, b.count)) * 100) : (b.count / max) * 100}%` }} />
                  </span>
                  <span className="egov-bar__n">{fmtInt(b.count)}</span>
                  <span className="egov-bar__s">{fmtShare(b.count, total)}</span>
                </button>
              </li>
            )
          })}
        </ol>
      )}

      <footer className="egov-card__foot">
        {readout ? <span className="egov-readout">{readout}</span>
          : field.stats && typeof field.stats.min === 'number' ? (
            <span className="egov-stats" title="Exact, over the cohort (percentile_cont)">
              {fmtValue(field.stats.min, field.format)} · <em>p25</em> {fmtValue(field.stats.p25 ?? null, field.format)} · <em>median</em> <b>{fmtValue(field.stats.p50 ?? null, field.format)}</b> · <em>p75</em> {fmtValue(field.stats.p75 ?? null, field.format)} · {fmtValue(field.stats.max, field.format)}
            </span>
          ) : field.stats && typeof field.stats.min === 'string' ? (
            <span className="egov-stats">{field.stats.min} → {String(field.stats.max ?? '')}</span>
          ) : field.note ? <span className="egov-note">{field.note}</span> : <span className="egov-note">{field.distinct ? `${fmtInt(field.distinct)} distinct values` : ' '}</span>}
        {field.windows?.length ? (
          <span className="egov-windows">
            {field.windows.map((w) => (
              <button key={w.key} type="button" className={cx('egov-chip', bucketActive(filters, w.filter) && 'is-active')} onClick={(e) => click(w, e)}>{w.label.replace('Within ', '≤ ')} · {fmtInt(w.count)}</button>
            ))}
          </span>
        ) : null}
      </footer>
    </article>
  )
}

/** Protected-class-adjacent field (age, gender, marital status, language…): charted as descriptive analytics, never priced. */
function SensitiveMark() {
  return <i className="egov-sensitive" title="Sensitive field — descriptive analytics only; never used in pricing or negotiation" aria-label="sensitive field">S</i>
}
