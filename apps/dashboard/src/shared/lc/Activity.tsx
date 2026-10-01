import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import { groupActivity, type LCActivityEvent } from './activity-model'
import { LCEmpty, LCSkeleton } from './States'
import { cx } from './cx'
import './lc-data.css'

/**
 * LCActivityFeed — the shared machine/operator activity stream.
 *
 * Event anatomy: icon · event · subject · time · source · result · state.
 * Repetition collapses: 100 "message queued" events in one burst become
 * "100 targets queued · Campaign X · 12:41 PM", expandable to the members.
 * A genuinely new event (one the feed had not seen) arrives with ONE
 * localized highlight; refreshes never re-animate what was already there.
 */

const fmtTime = (ms: number, tz?: string) => {
  const d = new Date(ms)
  const sameDay = new Date().toDateString() === d.toDateString()
  return d.toLocaleString('en-US', { ...(sameDay ? {} : { month: 'short', day: 'numeric' }), hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) })
}

export interface LCActivityFeedProps {
  events: ReadonlyArray<LCActivityEvent>
  loading?: boolean
  windowMs?: number
  /** time zone for stamps, e.g. 'America/Chicago' */
  tz?: string
  empty?: { title: string; body?: ReactNode }
  max?: number
  className?: string
  label?: string
}

export function LCActivityFeed({ events, loading, windowMs, tz, empty, max = 60, className, label = 'Activity' }: LCActivityFeedProps) {
  const entries = useMemo(() => groupActivity(events, windowMs).slice(0, max), [events, windowMs, max])
  const seen = useRef<Set<string> | null>(null)
  const [fresh, setFresh] = useState<Set<string>>(() => new Set())
  const [open, setOpen] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const ids = new Set(events.map((e) => e.id))
    if (seen.current === null) { seen.current = ids; return }
    const arrived = new Set<string>()
    ids.forEach((id) => { if (!seen.current!.has(id)) arrived.add(id) })
    seen.current = ids
    if (!arrived.size) return
    setFresh(arrived)
    const t = window.setTimeout(() => setFresh(new Set()), 1600)
    return () => window.clearTimeout(t)
  }, [events])

  if (loading && !events.length) return <LCSkeleton shape="rows" count={5} className={className} label={`${label} loading`} />
  if (!events.length) return <LCEmpty title={empty?.title ?? 'No activity yet'} body={empty?.body} compact className={className} />

  return (
    <ol className={cx('lc-feed', className)} aria-label={label}>
      {entries.map((en) => {
        if (en.kind === 'one') {
          const e = en.ev
          return (
            <li key={e.id} className={cx('lc-feed__item', fresh.has(e.id) && 'lc-arrive')} data-tone={e.tone}>
              <FeedRow ev={e} tz={tz} />
            </li>
          )
        }
        const head = en.events[0]
        const isOpen = open.has(en.key + head.id)
        const anyFresh = en.events.some((e) => fresh.has(e.id))
        return (
          <li key={`${en.key}-${head.id}`} className={cx('lc-feed__item is-group', anyFresh && 'lc-arrive')} data-tone={head.tone}>
            <button
              type="button"
              className="lc-feed__row"
              aria-expanded={isOpen}
              onClick={() => setOpen((s) => { const n = new Set(s); const k = en.key + head.id; if (n.has(k)) n.delete(k); else n.add(k); return n })}
            >
              <span className="lc-feed__glyph" aria-hidden="true">{head.icon ? <Icon name={head.icon} size={13} /> : <span className="lc-feed__pip" />}</span>
              <span className="lc-feed__main">
                <span className="lc-feed__title"><b className="lc-num">{en.events.length.toLocaleString('en-US')}</b> {en.noun}</span>
                {head.source ? <span className="lc-feed__sub">{head.source}</span> : null}
              </span>
              <span className="lc-feed__time lc-t-stamp">{fmtTime(head.at, tz)}</span>
              <Icon name="chevron-down" size={12} className={cx('lc-feed__chev', isOpen && 'is-open')} />
            </button>
            {isOpen ? (
              <ol className="lc-feed__members">
                {en.events.slice(0, 50).map((e) => <li key={e.id}><FeedRow ev={e} tz={tz} compact /></li>)}
                {en.events.length > 50 ? <li className="lc-t-meta lc-feed__more">+{(en.events.length - 50).toLocaleString('en-US')} more in this burst</li> : null}
              </ol>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

function FeedRow({ ev, tz, compact }: { ev: LCActivityEvent; tz?: string; compact?: boolean }) {
  const inner = (
    <>
      {!compact ? <span className="lc-feed__glyph" aria-hidden="true">{ev.icon ? <Icon name={ev.icon} size={13} /> : <span className="lc-feed__pip" />}</span> : null}
      <span className="lc-feed__main">
        <span className="lc-feed__title">{ev.title}{ev.subject ? <span className="lc-feed__subject"> · {ev.subject}</span> : null}</span>
        {ev.source || ev.result ? (
          <span className="lc-feed__sub">
            {ev.source}
            {ev.source && ev.result ? ' · ' : null}
            {ev.result ? <span className="lc-feed__result">{ev.result}</span> : null}
          </span>
        ) : null}
      </span>
      <span className="lc-feed__time lc-t-stamp">{fmtTime(ev.at, tz)}</span>
    </>
  )
  return ev.onOpen
    ? <button type="button" className={cx('lc-feed__row', compact && 'is-compact')} onClick={ev.onOpen}>{inner}</button>
    : <div className={cx('lc-feed__row', compact && 'is-compact')}>{inner}</div>
}
