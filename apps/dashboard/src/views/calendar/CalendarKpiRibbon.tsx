import { useState } from 'react'
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

const KPI_TOOLTIPS: Record<string, string> = {
  'due-today': 'Actionable events due today across active layers',
  overdue: 'Past-due scheduled automation and operator items',
  'seller-replies': 'Inbound seller replies needing review',
  'scheduled-sms': 'Queue sends scheduled in range',
  'workflow-wakes': 'Workflow resume and task wake times',
  'offers-due': 'Offer follow-ups and expirations',
  'contracts-awaiting': 'Contracts awaiting signature',
  'title-milestones': 'Title routing milestones',
  'buyer-follow-ups': 'Buyer network follow-ups',
  closings: 'Scheduled closings',
}

const KPI_LAYER_MAP: Record<string, string[]> = {
  overdue: ['risks', 'follow_ups'],
  'seller-replies': ['seller_replies'],
  'scheduled-sms': ['sms'],
  'workflow-wakes': ['workflow'],
  'offers-due': ['offers'],
  'contracts-awaiting': ['contracts'],
  'title-milestones': ['title'],
  'buyer-follow-ups': ['buyers'],
  closings: ['closings'],
}

type CalendarKpiRibbonProps = {
  cards: ExecutionSummaryCard[]
  activeId?: string | null
  onCardClick?: (id: string) => void
}

export function CalendarKpiRibbon({ cards, activeId, onCardClick }: CalendarKpiRibbonProps) {
  const [collapsed, setCollapsed] = useState(false)
  const total = cards.reduce((sum, c) => sum + c.value, 0)

  if (collapsed) {
    return (
      <div className="nx-cal__kpi-ribbon is-collapsed" role="toolbar" aria-label="Calendar metrics">
        <button type="button" className="nx-cal__kpi-collapse-btn" onClick={() => setCollapsed(false)}>
          Metrics · {total} active
        </button>
      </div>
    )
  }

  return (
    <div className="nx-cal__kpi-ribbon" role="toolbar" aria-label="Calendar intelligence metrics">
      {cards.map((card) => (
        <button
          key={card.id}
          type="button"
          className={cls(
            'nx-cal__kpi-capsule',
            `is-${card.tone}`,
            activeId === card.id && 'is-active',
            card.value === 0 && 'is-zero',
            card.value > 0 && 'has-value',
          )}
          title={KPI_TOOLTIPS[card.id] || card.label}
          onClick={() => onCardClick?.(card.id)}
        >
          <span className="nx-cal__kpi-icon" aria-hidden="true">
            <Icon name={KPI_ICONS[card.id] || 'activity'} />
          </span>
          <span className="nx-cal__kpi-value">{card.value}</span>
          <span className="nx-cal__kpi-label">{card.label}</span>
          {KPI_LAYER_MAP[card.id] ? (
            <span className="nx-cal__kpi-source" aria-hidden="true">{KPI_LAYER_MAP[card.id].join(', ')}</span>
          ) : null}
        </button>
      ))}
      <button type="button" className="nx-cal__kpi-collapse-btn" onClick={() => setCollapsed(true)} aria-label="Collapse metrics">
        <Icon name="chevron-up" />
      </button>
    </div>
  )
}

export { KPI_LAYER_MAP }