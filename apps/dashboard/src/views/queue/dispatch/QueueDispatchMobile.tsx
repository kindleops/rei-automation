/**
 * Queue — mobile dispatch control.
 *
 *   header    title, live summary sentence, search, filters, other views
 *   segments  Ready · Scheduled · Sending · Attention · History, each with the
 *             server's own count for exactly what tapping it lists
 *   cards     who · what · when (property-local) · from · why · status
 *
 * Rows come from the queue page API already filtered to the segment; this
 * component only presents them. Opening a card hands the row to the page,
 * which owns the detail sheet and every action.
 */
import { memo, useEffect, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { QueueItem } from '../../../domain/queue/queue.types'
import { resolveSellerIdentity } from '../queue-ui-helpers'
import { resolveTouchStageDisplay } from '../../../domain/queue/queue-status-truth'
import {
  SEGMENTS,
  dispatchReason,
  dispatchRecovery,
  dispatchStatus,
  dispatchWhen,
  phoneTail,
  type QueueSegment,
} from './queue-dispatch-model'
import { QueueShell, type QueueShellProps, type QueueView } from './QueueShell'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const fmtCount = (n: number | null | undefined) =>
  typeof n !== 'number' ? '–' : n > 9999 ? `${Math.round(n / 1000)}k` : n.toLocaleString()

// ── Card ─────────────────────────────────────────────────────────────────────

export const QueueDispatchCard = memo(function QueueDispatchCard({
  item,
  isOpen,
  onOpen,
}: {
  item: QueueItem
  isOpen: boolean
  onOpen: (item: QueueItem) => void
}) {
  const identity = resolveSellerIdentity(item)
  const status = dispatchStatus(item)
  const reason = dispatchReason(item)
  const recovery = dispatchRecovery(item)
  const when = dispatchWhen(item)
  const stage = resolveTouchStageDisplay(item)
  const place = [item.propertyCity, item.propertyState].filter(Boolean).join(', ')
  const address = [item.propertyAddress, place].filter(Boolean).join(' · ')
  const from = phoneTail(item.fromPhoneNumber)
  const body = (item.messageText || '').trim()

  return (
    <article
      className={cls('qx-card', `tone-${status.tone}`, isOpen && 'is-open', recovery?.kind === 'recovered' && 'is-recovered')}
      data-queue-id={item.id}
      data-recovery={recovery?.kind}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(item) } }}
    >
      <span className="qx-card__glow" aria-hidden="true" />
      <div className="qx-card__top">
        <strong className="qx-card__name">{identity.primary}</strong>
        <span className={cls('qx-pill', `tone-${status.tone}`)}>
          {status.tone === 'cyan' && <span className="qx-pill__pulse" aria-hidden="true" />}
          {status.label}
        </span>
      </div>
      {address && <p className="qx-card__addr">{address}</p>}
      {body && <p className="qx-card__msg"><span>{body}</span></p>}
      {reason && (
        <p className={cls('qx-card__why', `tone-${reason.tone}`)}>
          <Icon name={reason.tone === 'red' ? 'alert-circle' : reason.tone === 'blue' ? 'clock' : 'alert'} size={12} />
          <strong>{reason.title}</strong>
        </p>
      )}
      {recovery && (
        <p className={cls('qx-card__why', recovery.kind === 'recovering' ? 'tone-cyan' : 'tone-green')}>
          <Icon name={recovery.kind === 'recovering' ? 'refresh-cw' : 'check'} size={12} />
          <strong>{recovery.title}</strong>
        </p>
      )}
      <div className="qx-card__foot">
        <span className="qx-card__when">
          <span className="qx-card__when-main">{when.primary}</span>
          {when.secondary && <span className="qx-card__when-sub">{when.secondary}</span>}
        </span>
        <span className="qx-card__meta">
          {stage.stageCode && <span className="qx-chip">{stage.stageCode}</span>}
          {from && <span className="qx-chip is-mono" title="Sending number">{from}</span>}
        </span>
      </div>
    </article>
  )
})

function CardSkeleton() {
  return (
    <div className="qx-card is-skeleton" aria-hidden="true">
      <span className="qx-skel" style={{ width: '46%' }} />
      <span className="qx-skel" style={{ width: '72%' }} />
      <span className="qx-skel is-tall" style={{ width: '92%' }} />
      <span className="qx-skel" style={{ width: '38%' }} />
    </div>
  )
}

// ── Empty states ─────────────────────────────────────────────────────────────

function EmptyState({
  segment,
  rangeLabel,
  search,
  counts,
  onSegment,
}: {
  segment: QueueSegment
  rangeLabel: string
  search: string
  counts?: Partial<Record<QueueSegment, number | null>>
  onSegment: (s: QueueSegment) => void
}) {
  if (search.trim()) {
    return (
      <div className="qx-empty">
        <Icon name="search" size={18} />
        <strong>No matches for “{search.trim()}”</strong>
        <span>Search looks at the address, the message and the recipient number.</span>
      </div>
    )
  }
  const scheduled = counts?.scheduled ?? 0
  const copy: Record<QueueSegment, { icon: 'check' | 'clock' | 'send' | 'shield' | 'list'; title: string; sub: string }> = {
    ready: { icon: 'check', title: 'Nothing waiting on the processor', sub: 'Rows land here when their send time arrives.' },
    scheduled: { icon: 'clock', title: 'Nothing scheduled', sub: 'Campaign and follow-up sends appear here before their window.' },
    sending: { icon: 'send', title: 'Nothing in flight', sub: 'Messages show here while the carrier has them.' },
    attention: { icon: 'shield', title: 'All clear', sub: `No failed or held messages · ${rangeLabel}` },
    history: { icon: 'list', title: 'No sends yet', sub: `Nothing went out · ${rangeLabel}` },
  }
  const c = copy[segment]
  return (
    <div className="qx-empty">
      <Icon name={c.icon} size={18} />
      <strong>{c.title}</strong>
      <span>{c.sub}</span>
      {segment === 'ready' && typeof scheduled === 'number' && scheduled > 0 && (
        <button type="button" className="qx-empty__cta" onClick={() => onSegment('scheduled')}>
          {scheduled.toLocaleString()} scheduled
          <Icon name="chevron-right" size={13} />
        </button>
      )}
    </div>
  )
}

// ── Surface ──────────────────────────────────────────────────────────────────

export interface QueueDispatchMobileProps {
  items: QueueItem[]
  segment: QueueSegment
  counts?: Partial<Record<QueueSegment, number | null>>
  totalCount: number
  loading: boolean
  search: string
  rangeLabel: string
  activeFilters: number
  openId: string | null
  hasMore: boolean
  loadingMore: boolean
  onSegment: (s: QueueSegment) => void
  onSearch: (q: string) => void
  onOpen: (item: QueueItem) => void
  onOpenFilters: () => void
  onView: (view: QueueView) => void
  badges?: QueueShellProps['badges']
  /** A cross-view filter in force ("Market: Houston"), with a clear control. */
  filterNote?: string | null
  onClearNote?: () => void
  onRefresh: () => void
  onLoadMore: () => void
}

export function QueueDispatchMobile(props: QueueDispatchMobileProps) {
  const {
    items, segment, counts, totalCount, loading, search, rangeLabel, activeFilters, openId,
    hasMore, loadingMore, onSegment, onSearch, onOpen, onOpenFilters, onView, badges, filterNote, onClearNote, onRefresh, onLoadMore,
  } = props
  const [draft, setDraft] = useState(search)
  const timer = useRef<number | null>(null)
  useEffect(() => { setDraft(search) }, [search])
  const commit = (v: string) => {
    setDraft(v)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => onSearch(v), 350)
  }
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  const showSkeleton = loading && items.length === 0

  const controls = (
    <>
        <div className="qx-search-row">
          <label className="qx-search" data-queue-search>
            <Icon name="search" size={14} />
            <input
              className="qx-search__input"
              type="search"
              inputMode="search"
              enterKeyHint="search"
              placeholder="Address, message or number"
              value={draft}
              onChange={(e) => commit(e.target.value)}
              aria-label="Search the queue"
            />
            {draft && (
              <button type="button" className="qx-search__clear" aria-label="Clear search" onClick={() => { setDraft(''); onSearch('') }}>
                <Icon name="close" size={12} />
              </button>
            )}
          </label>
          <button type="button" className={cls('qx-filter', activeFilters > 0 && 'is-active')} onClick={onOpenFilters} data-queue-filters aria-label="Filters">
            <Icon name="filter" size={14} />
            <span>{rangeLabel}</span>
            {activeFilters > 0 && <span className="qx-filter__badge">{activeFilters}</span>}
          </button>
        </div>

        <nav className="qx-seg" role="tablist" aria-label="Queue state">
          {SEGMENTS.map((s) => {
            const n = counts?.[s.key]
            const active = segment === s.key
            return (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={active}
                data-queue-segment={s.key}
                className={cls('qx-seg__tab', active && 'is-active', s.key === 'attention' && typeof n === 'number' && n > 0 && 'has-alert')}
                onClick={() => onSegment(s.key)}
              >
                <span className="qx-seg__label">{s.label}</span>
                <span className="qx-seg__count">{fmtCount(n)}</span>
              </button>
            )
          })}
        </nav>
        {filterNote && (
          <div className="qx-scope">
            <span>{filterNote}</span>
            <button type="button" onClick={onClearNote} aria-label="Clear filter"><Icon name="close" size={11} /></button>
          </div>
        )}
    </>
  )

  return (
    <QueueShell
      view="dispatch"
      onView={onView}
      counts={counts}
      badges={badges}
      loading={loading}
      onRefresh={onRefresh}
      controls={controls}
      scrollKey={segment}
    >
      <div className="qx-list" aria-busy={loading}>
        {showSkeleton && [0, 1, 2].map((i) => <CardSkeleton key={i} />)}
        {!showSkeleton && items.map((item) => (
          <QueueDispatchCard key={item.id} item={item} isOpen={openId === item.id} onOpen={onOpen} />
        ))}
        {!showSkeleton && items.length === 0 && (
          <EmptyState segment={segment} rangeLabel={rangeLabel} search={search} counts={counts} onSegment={onSegment} />
        )}
        {!showSkeleton && items.length > 0 && (
          <footer className="qx-more">
            <span>{items.length.toLocaleString()} of {totalCount.toLocaleString()}</span>
            {hasMore && (
              <button type="button" className="qx-more__btn" onClick={onLoadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Show more'}
              </button>
            )}
          </footer>
        )}
      </div>
    </QueueShell>
  )
}
