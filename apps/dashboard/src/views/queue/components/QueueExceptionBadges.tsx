import type { ExceptionItem } from '../queue-ui-helpers'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface QueueExceptionBadgesProps {
  exceptions: ExceptionItem[]
  activeCause: string | null
  open: boolean
  onToggle: () => void
  onFilter: (causeKey: string) => void
}

export function QueueExceptionBadges({
  exceptions, activeCause, open, onToggle, onFilter,
}: QueueExceptionBadgesProps) {
  if (exceptions.length === 0) return null
  const total = exceptions.reduce((n, e) => n + e.count, 0)

  return (
    <div className={cls('occ-ex-badges', open && 'is-open')}>
      <button type="button" className="occ-ex-badges__toggle" onClick={onToggle}>
        Exceptions · {total}
        <span className="occ-ex-badges__chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="occ-ex-badges__list">
          {exceptions.map(ex => (
            <button
              key={ex.id}
              type="button"
              className={cls('occ-ex-badge', `is-${ex.urgency}`, activeCause === ex.causeKey && 'is-active')}
              onClick={() => ex.causeKey && onFilter(ex.causeKey)}
              title={ex.action}
            >
              <span className="occ-ex-badge__count">{ex.count}</span>
              <span className="occ-ex-badge__label">{ex.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}