import { useEffect, useMemo, useState } from 'react'
import type { TraceEvent } from './copilot-state'

interface MissionTraceProps {
  events: TraceEvent[]
  maxVisible?: number
  variant?: 'sidecar' | 'deck'
  forceExpanded?: boolean
  pinnedDefault?: boolean
}

const TYPE_ICONS: Record<TraceEvent['type'], string> = {
  context: '◈',
  parse: '⟐',
  search: '⌁',
  analysis: '◉',
  draft: '✎',
  execution: '▶',
  completion: '✓',
  error: '⚠',
  voice: '◌',
  greeting: '●',
  confirmation: '⟡',
  system: '⎔',
}

const FILTERS = ['all', 'error', 'execution', 'analysis', 'voice'] as const

function formatTimestamp(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function getSeverity(type: TraceEvent['type']): 'critical' | 'warning' | 'info' | 'trace' {
  if (type === 'error') return 'critical'
  if (type === 'execution' || type === 'confirmation') return 'warning'
  if (type === 'analysis' || type === 'completion') return 'info'
  return 'trace'
}

export function MissionTrace({
  events,
  maxVisible = 50,
  variant = 'sidecar',
  forceExpanded = false,
  pinnedDefault = false,
}: MissionTraceProps) {
  const [expanded, setExpanded] = useState(forceExpanded || variant === 'deck')
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all')
  const [pinnedIds, setPinnedIds] = useState<string[]>([])

  useEffect(() => {
    if (forceExpanded) setExpanded(true)
  }, [forceExpanded])

  useEffect(() => {
    if (!pinnedDefault || pinnedIds.length > 0) return
    setPinnedIds(events.slice(0, Math.min(3, events.length)).map((event) => event.id))
  }, [events, pinnedDefault, pinnedIds.length])

  const filtered = useMemo(() => {
    return filter === 'all' ? events : events.filter((event) => event.type === filter)
  }, [events, filter])

  const visible = useMemo(() => {
    const limit = expanded ? maxVisible : variant === 'deck' ? 14 : 8
    return filtered.slice(0, limit)
  }, [expanded, filtered, maxVisible, variant])

  const pinned = useMemo(() => {
    return events.filter((event) => pinnedIds.includes(event.id)).slice(0, 3)
  }, [events, pinnedIds])

  if (events.length === 0) {
    return (
      <div className={`nx-trace nx-trace--${variant} nx-trace--empty`}>
        <span className="nx-trace__empty-label">Trace is waiting for activity.</span>
      </div>
    )
  }

  return (
    <section className={`nx-trace nx-trace--${variant} ${expanded ? 'nx-trace--expanded' : ''}`}>
      <header className="nx-trace__header">
        <div>
          <span className="nx-trace__eyebrow">Trace</span>
          <h3 className="nx-trace__title">Live intelligence feed</h3>
        </div>

        <div className="nx-trace__header-actions">
          <span className="nx-trace__count">{events.length}</span>
          {events.length > (variant === 'deck' ? 14 : 8) && !forceExpanded ? (
            <button type="button" className="nx-trace__toggle" onClick={() => setExpanded((current) => !current)}>
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          ) : null}
        </div>
      </header>

      <div className="nx-trace__filters">
        {FILTERS.map((item) => (
          <button
            key={item}
            type="button"
            className={`nx-trace__filter ${filter === item ? 'is-active' : ''}`}
            onClick={() => setFilter(item)}
          >
            {item === 'all' ? 'All' : item.charAt(0).toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>

      {pinned.length > 0 && (
        <div className="nx-trace__pinned-grid">
          {pinned.map((event) => (
            <article key={event.id} className={`nx-trace__event nx-trace__event--pinned is-${getSeverity(event.type)}`}>
              <div className="nx-trace__event-top">
                <span className="nx-trace__icon">{TYPE_ICONS[event.type]}</span>
                <span className="nx-trace__event-label">{event.label}</span>
                <span className="nx-trace__ts">{formatTimestamp(event.ts)}</span>
              </div>
              {event.detail ? <p className="nx-trace__detail">{event.detail}</p> : null}
            </article>
          ))}
        </div>
      )}

      <div className="nx-trace__feed">
        {visible.map((event, index) => {
          const severity = getSeverity(event.type)
          const isPinned = pinnedIds.includes(event.id)
          return (
            <article
              key={event.id}
              className={`nx-trace__event is-${severity} ${isPinned ? 'is-pinned' : ''}`}
              style={{ animationDelay: `${index * 28}ms` }}
            >
              <div className="nx-trace__event-top">
                <span className="nx-trace__severity-dot" data-severity={severity} />
                <span className="nx-trace__icon">{TYPE_ICONS[event.type]}</span>
                <span className="nx-trace__event-label">{event.label}</span>
                <button
                  type="button"
                  className={`nx-trace__pin ${isPinned ? 'is-pinned' : ''}`}
                  onClick={() => setPinnedIds((current) => current.includes(event.id) ? current.filter((id) => id !== event.id) : [...current, event.id])}
                >
                  ⊡
                </button>
                <span className="nx-trace__ts">{formatTimestamp(event.ts)}</span>
              </div>

              {event.detail ? <p className="nx-trace__detail">{event.detail}</p> : null}

              <div className="nx-trace__meta-row">
                {event.contextLabel ? <span className="nx-trace__meta-chip">{event.contextLabel}</span> : null}
                {event.state ? <span className="nx-trace__meta-chip">{event.state}</span> : null}
                <span className="nx-trace__meta-chip">{event.type}</span>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}