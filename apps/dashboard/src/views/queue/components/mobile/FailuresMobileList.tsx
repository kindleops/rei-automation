import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../../shared/icons'
import { MobileBottomSheet } from '../../../../modules/mobile/MobileBottomSheet'
import type { QueueItem } from '../../../../domain/queue/queue.types'
import {
  buildFailureStats,
  deriveFailureCause,
  filterFailureStats,
  summarizeFailureTaxonomy,
  FAILURE_CATEGORY_TONE,
  type FailureCategoryFilter,
  type FailureCauseStat,
} from '../../failure-taxonomy-stats'
import { resolveSellerIdentity } from '../../queue-ui-helpers'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const truncate = (s: string | null | undefined, max: number) =>
  !s ? '' : s.length > max ? `${s.slice(0, max)}…` : s

const shortMarket = (m: string | null | undefined) => (m ? m.replace(/,\s*[A-Z]{2}$/, '') : null)

const relTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 60) return `${Math.max(min, 1)}m ago`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

/** Where a failure family is concentrated, in one phrase. */
function scopeLine(stat: FailureCauseStat): string {
  const rows = `${stat.count} row${stat.count === 1 ? '' : 's'}`
  const top = shortMarket(stat.topMarket)
  if (!top) return rows
  if (stat.markets.length > 1) return `${rows} · ${top} +${stat.markets.length - 1}`
  return `${rows} · ${top}`
}

const CATEGORY_FILTERS: FailureCategoryFilter[] = ['all', 'Compliance', 'Carrier', 'Routing', 'Template', 'Payload', 'Webhook', 'Guard', 'Unknown']

interface FailuresMobileListProps {
  items: QueueItem[]
  /** Total queue rows in the loaded scope, so the headline can name its universe. */
  loadedRowCount: number
  rangeLabel: string
  selectedCause: string | null
  onSelectCause: (cause: string | null) => void
  onViewRows: (cause: string) => void
}

export function FailuresMobileList({
  items,
  loadedRowCount,
  rangeLabel,
  selectedCause,
  onSelectCause,
  onViewRows,
}: FailuresMobileListProps) {
  const [categoryFilter, setCategoryFilter] = useState<FailureCategoryFilter>('all')

  const stats = useMemo(() => buildFailureStats(items), [items])
  const filtered = useMemo(() => filterFailureStats(stats, categoryFilter, 'all'), [stats, categoryFilter])
  const summary = useMemo(() => summarizeFailureTaxonomy(stats), [stats])
  const selected = stats.find((s) => s.cause === selectedCause) ?? null
  const affected = useMemo(
    () => (selected ? items.filter((i) => deriveFailureCause(i) === selected.cause) : []),
    [items, selected],
  )

  // Only offer categories that actually occur in range.
  const availableCategories = useMemo(() => {
    const present = new Set(stats.map((s) => s.category))
    return CATEGORY_FILTERS.filter((c) => c === 'all' || present.has(c))
  }, [stats])

  const detail = selected && typeof document !== 'undefined' ? createPortal(
    <MobileBottomSheet open snap="expanded" onClose={() => onSelectCause(null)} className="qm-fail-sheet">
      <header className="qm-faildetail__head">
        <div>
          <strong>{selected.label}</strong>
          <span>{selected.count} affected row{selected.count === 1 ? '' : 's'}</span>
        </div>
        <button type="button" className="qms-chrome__btn is-close" onClick={() => onSelectCause(null)} aria-label="Close">
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="qm-faildetail__body">
        <div className="qm-faildetail__tags">
          <span className={cls('qm-tag', selected.retryable ? 'is-green' : 'is-red')}>
            {selected.retryable ? 'Retryable' : 'Non-retryable'}
          </span>
          <span className={cls('qm-tag', `is-${FAILURE_CATEGORY_TONE[selected.category] ?? 'amber'}`)}>{selected.category}</span>
          {selected.suppression && <span className="qm-tag is-red">Suppress required</span>}
          {shortMarket(selected.topMarket) && <span className="qm-tag">{shortMarket(selected.topMarket)}</span>}
        </div>

        <p className="qm-faildetail__action">{selected.action}</p>

        {selected.markets.length > 0 && (
          <section className="qm-faildetail__section">
            <h4>Affected markets</h4>
            <div className="qm-faildetail__chips">
              {selected.markets.slice(0, 8).map((m) => (
                <span key={m} className="qm-tag is-quiet">{truncate(shortMarket(m), 20)}</span>
              ))}
              {selected.markets.length > 8 && <span className="qm-tag is-quiet">+{selected.markets.length - 8}</span>}
            </div>
          </section>
        )}

        {selected.senders.length > 0 && (
          <section className="qm-faildetail__section">
            <h4>Senders</h4>
            <div className="qm-faildetail__chips">
              {selected.senders.slice(0, 6).map((p) => (
                <span key={p} className="qm-tag is-quiet is-mono">···{p.slice(-4)}</span>
              ))}
              {selected.senders.length > 6 && <span className="qm-tag is-quiet">+{selected.senders.length - 6}</span>}
            </div>
          </section>
        )}

        {affected.length > 0 && (
          <section className="qm-faildetail__section">
            <h4>Affected rows</h4>
            <div className="qm-faildetail__rows">
              {affected.slice(0, 6).map((row) => {
                const id = resolveSellerIdentity(row)
                return (
                  <div key={row.id} className="qm-faildetail__row">
                    <strong>{truncate(id.primary, 24)}</strong>
                    <span>{truncate(row.propertyAddress, 30) || 'No address'}</span>
                  </div>
                )
              })}
              {affected.length > 6 && <span className="qm-faildetail__more">+{affected.length - 6} more</span>}
            </div>
          </section>
        )}

        <span className="qm-faildetail__seen">Last seen {relTime(selected.lastSeen)}</span>
      </div>

      <footer className="qm-faildetail__foot">
        <button
          type="button"
          className="qms-action is-primary"
          onClick={() => { onViewRows(selected.cause); onSelectCause(null) }}
        >
          View {selected.count} row{selected.count === 1 ? '' : 's'}
        </button>
      </footer>
    </MobileBottomSheet>,
    document.body,
  ) : null

  return (
    <div className="qm-failures">
      <header className="qm-failures__head">
        {/* Three distinct quantities, never conflated: failed/blocked rows,
            families, and how many of those rows can be retried. */}
        <p className="qm-events__counts">
          <span className={cls('is-red', summary.total > 0 && 'has-value')}>
            {summary.total} failed/blocked
          </span>
          <em>·</em>
          <span>{summary.causeCount} famil{summary.causeCount === 1 ? 'y' : 'ies'}</span>
          <em>·</em>
          <span className="is-green">{summary.retryable} retryable</span>
        </p>
        <p className="qm-failures__scope">
          across {loadedRowCount.toLocaleString()} loaded queue row{loadedRowCount === 1 ? '' : 's'} · {rangeLabel}
        </p>
      </header>

      {availableCategories.length > 2 && (
        <div className="qm-events__bar" role="tablist" aria-label="Filter failure category">
          {availableCategories.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={categoryFilter === c}
              className={cls('qm-chip', categoryFilter === c && 'is-active')}
              onClick={() => setCategoryFilter(c)}
            >
              {c === 'all' ? 'All' : c}
            </button>
          ))}
        </div>
      )}

      {stats.length === 0 ? (
        <div className="qm-empty">No failures or blocks in the last {rangeLabel}.</div>
      ) : filtered.length === 0 ? (
        <div className="qm-empty">No failure families match this filter.</div>
      ) : (
        <div className="qm-failures__list">
          {filtered.map((s) => (
            <article
              key={s.cause}
              className={cls('qm-failrow', `is-sev-${s.severity}`, selectedCause === s.cause && 'is-open')}
              role="button"
              tabIndex={0}
              aria-pressed={selectedCause === s.cause}
              onClick={() => onSelectCause(s.cause)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectCause(s.cause) } }}
            >
              <span className="qm-failrow__accent" aria-hidden="true" />
              <div className="qm-failrow__body">
                <div className="qm-failrow__lead">
                  <strong className="qm-failrow__name">{s.label}</strong>
                  <span className={cls('qm-failrow__disp', s.retryable ? 'is-green' : 'is-red')}>
                    {s.retryable ? 'Retryable' : 'No retry'}
                  </span>
                </div>
                <p className="qm-failrow__scope">{scopeLine(s)}</p>
                <p className="qm-failrow__action">{s.action}</p>
                <button
                  type="button"
                  className="qm-failrow__cta"
                  onClick={(e) => { e.stopPropagation(); onViewRows(s.cause) }}
                >
                  View affected row{s.count === 1 ? '' : 's'}
                  <Icon name="chevron-right" size={12} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {detail}
    </div>
  )
}
