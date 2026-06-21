import type { ExecutionSummaryCard } from '../../lib/data/calendarData'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type ExecutionSnapshotStripProps = {
  cards: ExecutionSummaryCard[]
  compact?: boolean
  onCardClick?: (id: string) => void
}

export function ExecutionSnapshotStrip({
  cards,
  compact = false,
  onCardClick,
}: ExecutionSnapshotStripProps) {
  return (
    <div className={cls('calendar-command__kpis', 'nx-cal__snapshot-strip', compact && 'is-compact')}>
      {cards.map((card) => (
        <button
          key={card.id}
          type="button"
          className={cls('calendar-command__kpi', 'nx-cal__snapshot-card', `is-${card.tone}`)}
          onClick={() => onCardClick?.(card.id)}
        >
          <span>{card.label}</span>
          <strong>{card.value}</strong>
          <small>{card.value === 0 ? 'quiet' : card.value > 0 ? 'active' : 'watching'}</small>
        </button>
      ))}
    </div>
  )
}
