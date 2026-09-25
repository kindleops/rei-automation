/**
 * The one Queue chrome on mobile. Every Queue view — Dispatch, Events,
 * Failures, Markets, Senders, Templates — sits under the same frosted header:
 * title + live state + the queue's summary sentence, then a view rail, then
 * the view's own controls. Only the body changes between views.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import type { QueueSegment } from './queue-dispatch-model'
import { summarySentence } from './queue-dispatch-model'

export type QueueView = 'dispatch' | 'events' | 'failures' | 'market' | 'senders' | 'templates'

export const QUEUE_VIEWS: ReadonlyArray<{ key: QueueView; label: string; icon: IconName }> = [
  { key: 'dispatch', label: 'Dispatch', icon: 'send' },
  { key: 'events', label: 'Events', icon: 'activity' },
  { key: 'failures', label: 'Failures', icon: 'alert-circle' },
  { key: 'market', label: 'Markets', icon: 'map' },
  { key: 'senders', label: 'Senders', icon: 'phone' },
  { key: 'templates', label: 'Templates', icon: 'file-text' },
]

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export interface QueueShellProps {
  view: QueueView
  onView: (view: QueueView) => void
  counts?: Partial<Record<QueueSegment, number | null>>
  /** Small numbers on the rail, e.g. failures needing attention. */
  badges?: Partial<Record<QueueView, { value: number; tone?: 'amber' | 'red' | 'muted' }>>
  loading: boolean
  onRefresh: () => void
  /** The view's own controls (search, segments, filter chips). */
  controls?: ReactNode
  /** Changing this scrolls the body back to the top. */
  scrollKey?: string
  children: ReactNode
}

export function QueueShell({ view, onView, counts, badges, loading, onRefresh, controls, scrollKey, children }: QueueShellProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { rootRef.current?.scrollTo({ top: 0 }) }, [scrollKey, view])
  // Keep the active view in sight on the rail.
  useEffect(() => {
    const rail = railRef.current
    const active = rail?.querySelector<HTMLElement>('.qx-rail__tab.is-active')
    if (!rail || !active) return
    const left = active.offsetLeft - (rail.clientWidth - active.clientWidth) / 2
    rail.scrollTo({ left: Math.max(0, left), behavior: 'smooth' })
  }, [view])

  const sentence = summarySentence(counts)

  return (
    <div className="qx-root" ref={rootRef} data-queue-shell={view}>
      <span className="qx-aurora" aria-hidden="true" />
      <header className="qx-head">
        <div className="qx-head__top">
          <div className="qx-head__id">
            <h1 className="qx-head__title">
              Queue
              <span className={cls('qx-live', loading && 'is-syncing')} aria-label={loading ? 'Syncing' : 'Live'} />
            </h1>
            <p className="qx-head__sum">{sentence ?? 'Reading the queue…'}</p>
          </div>
          <div className="qx-head__tools">
            <button type="button" className={cls('qx-icon', loading && 'is-busy')} onClick={onRefresh} aria-label="Refresh queue">
              <Icon name="refresh-cw" size={15} />
            </button>
          </div>
        </div>

        <nav className="qx-rail" ref={railRef} role="tablist" aria-label="Queue views">
          {QUEUE_VIEWS.map((v) => {
            const badge = badges?.[v.key]
            const active = v.key === view
            return (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={active}
                data-queue-view={v.key}
                className={cls('qx-rail__tab', active && 'is-active')}
                onClick={() => onView(v.key)}
              >
                <Icon name={v.icon} size={13} />
                <span>{v.label}</span>
                {badge && badge.value > 0 && (
                  <span className={cls('qx-rail__badge', `tone-${badge.tone ?? 'muted'}`)}>
                    {badge.value > 999 ? `${Math.round(badge.value / 1000)}k` : badge.value}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        {controls}
      </header>
      <div className="qx-body" key={view}>
        {children}
      </div>
    </div>
  )
}
