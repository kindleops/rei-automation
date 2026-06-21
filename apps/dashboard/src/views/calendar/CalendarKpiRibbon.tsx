import type { ExecutionSummaryCard } from '../../lib/data/calendarData'
import { Icon, type IconName } from '../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const KPI_ICONS: Record<string, IconName> = {
  'due-today': 'calendar',
  overdue: 'alert-circle',
  'seller-replies': 'message',
  'scheduled-sms': 'send',
  'workflow-wakes': 'cpu',
  'offers-due': 'dollar-sign',
  'contracts-awaiting': 'file-text',
  'title-milestones': 'briefcase',
  'buyer-follow-ups': 'users',
  closings: 'check',
}

type CalendarKpiRibbonProps = {
  cards: ExecutionSummaryCard[]
  activeId?: string | null
  onCardClick?: (id: string) => void
}

export function CalendarKpiRibbon({ cards, activeId, onCardClick }: CalendarKpiRibbonProps) {
  return (
    <div className="nx-cal__kpi-ribbon" role="toolbar" aria-label="Calendar intelligence metrics">
      {cards.map((card) => (
        <button
          key={card.id}
          type="button"
          className={cls('nx-cal__kpi-capsule', `is-${card.tone}`, activeId === card.id && 'is-active')}
          onClick={() => onCardClick?.(card.id)}
        >
          <span className="nx-cal__kpi-icon" aria-hidden="true">
            <Icon name={KPI_ICONS[card.id] || 'activity'} />
          </span>
          <span className="nx-cal__kpi-value">{card.value}</span>
          <span className="nx-cal__kpi-label">{card.label}</span>
        </button>
      ))}
    </div>
  )
}