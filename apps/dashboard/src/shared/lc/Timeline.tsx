import { Fragment, type ReactNode } from 'react'
import { Icon, type IconName } from '../icons'
import { cx } from './cx'
import './lc-data.css'

/**
 * LCTimeline — a vertical spine with temporal hierarchy, for Closing Desk,
 * workflow runs, property / campaign / deal history and seller activity.
 *
 * Past is solid, the present is marked, the future (scheduled) is hollow —
 * so "what happened" and "what will happen" never read the same. Day
 * headings group long histories.
 */

export interface LCTimelineItem {
  id: string
  /** epoch ms; omit for undated steps */
  at?: number | null
  title: ReactNode
  body?: ReactNode
  meta?: ReactNode
  icon?: IconName
  /** done = happened · now = in progress · next = scheduled · blocked · waiting */
  state?: 'done' | 'now' | 'next' | 'blocked' | 'waiting' | 'failed'
  onOpen?: () => void
}

export interface LCTimelineProps {
  items: ReadonlyArray<LCTimelineItem>
  tz?: string
  /** group under day headings */
  byDay?: boolean
  label?: string
  className?: string
  dense?: boolean
}

const dayOf = (ms: number, tz?: string) => new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(tz ? { timeZone: tz } : {}) })
const timeOf = (ms: number, tz?: string) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) })

export function LCTimeline({ items, tz, byDay, label = 'Timeline', className, dense }: LCTimelineProps) {
  const days = items.map((it) => (byDay && it.at ? dayOf(it.at, tz) : ''))
  const opensDay: boolean[] = []
  let last = ''
  for (const d of days) {
    opensDay.push(Boolean(d) && d !== last)
    if (d) last = d
  }
  return (
    <ol className={cx('lc-tl', dense && 'is-dense', className)} aria-label={label}>
      {items.map((it, i) => {
        const day = days[i]
        const showDay = opensDay[i]
        const state = it.state ?? 'done'
        const body = (
          <>
            <span className="lc-tl__node" aria-hidden="true">{it.icon ? <Icon name={it.icon} size={11} /> : null}</span>
            <span className="lc-tl__main">
              <span className="lc-tl__head">
                <span className="lc-tl__title">{it.title}</span>
                {it.at ? <time className="lc-tl__time lc-t-stamp" dateTime={new Date(it.at).toISOString()}>{byDay ? timeOf(it.at, tz) : `${dayOf(it.at, tz)} · ${timeOf(it.at, tz)}`}</time> : null}
              </span>
              {it.body ? <span className="lc-tl__body">{it.body}</span> : null}
              {it.meta ? <span className="lc-tl__meta">{it.meta}</span> : null}
            </span>
          </>
        )
        return (
          <Fragment key={it.id}>
            {showDay ? <li className="lc-tl__day" aria-hidden="false"><span className="lc-eyebrow">{day}</span></li> : null}
            <li className="lc-tl__item" data-state={state}>
              {it.onOpen ? <button type="button" className="lc-tl__row" onClick={it.onOpen}>{body}</button> : <div className="lc-tl__row">{body}</div>}
            </li>
          </Fragment>
        )
      })}
    </ol>
  )
}
