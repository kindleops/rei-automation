import type { ExceptionItem } from '../queue-ui-helpers'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface ExceptionsCenterProps {
  exceptions: ExceptionItem[]
  selectedCause: string | null
  onSelect: (causeKey: string | null) => void
  onViewRows: (causeKey: string) => void
  compact?: boolean
}

export function ExceptionsCenter({ exceptions, selectedCause, onSelect, onViewRows, compact }: ExceptionsCenterProps) {
  if (exceptions.length === 0) {
    return (
      <div className="occ-exceptions occ-exceptions--empty">
        <span className="occ-exceptions__title">Exceptions Center</span>
        <p>No active exceptions in loaded range.</p>
      </div>
    )
  }

  return (
    <section className={cls('occ-exceptions', compact && 'is-compact')}>
      <header className="occ-exceptions__head">
        <span className="occ-exceptions__title">Exceptions Center</span>
        <span className="occ-exceptions__total">{exceptions.reduce((n, e) => n + e.count, 0)} rows</span>
      </header>
      <div className="occ-exceptions__list">
        {exceptions.map(ex => (
          <button
            key={ex.id}
            type="button"
            className={cls('occ-exception-card', `is-${ex.urgency}`, selectedCause === ex.causeKey && 'is-selected')}
            onClick={() => onSelect(selectedCause === ex.causeKey ? null : ex.causeKey)}
          >
            <div className="occ-exception-card__head">
              <span className="occ-exception-card__priority">{ex.priority + 1}</span>
              <span className="occ-exception-card__label">{ex.label}</span>
              <span className="occ-exception-card__count">{ex.count}</span>
            </div>
            <p className="occ-exception-card__action">{ex.action}</p>
            <div className="occ-exception-card__meta">
              {ex.market && <span>{ex.market}</span>}
              {ex.sender && <span>…{ex.sender.slice(-4)}</span>}
              {ex.age && <span>{ex.age}</span>}
            </div>
            {ex.causeKey && (
              <span
                role="button"
                tabIndex={0}
                className="occ-exception-card__cta"
                onClick={e => { e.stopPropagation(); onViewRows(ex.causeKey!) }}
                onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); onViewRows(ex.causeKey!) } }}
              >
                View rows →
              </span>
            )}
          </button>
        ))}
      </div>
    </section>
  )
}