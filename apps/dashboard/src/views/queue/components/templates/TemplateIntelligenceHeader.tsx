import type { TemplateKpiCard } from '../../../../domain/templates/template-intelligence.types'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface TemplateIntelligenceHeaderProps {
  cards: TemplateKpiCard[]
  loading?: boolean
  onCardClick?: (key: string) => void
}

function formatValue(card: TemplateKpiCard) {
  if (card.unavailable) return '—'
  if (card.insufficientData) return 'Insufficient data'
  if (card.current == null) return '—'
  if (card.denominator != null) return `${card.current}%`
  if (card.key === 'cost') return `$${Number(card.current).toFixed(2)}`
  return String(card.current)
}

export function TemplateIntelligenceHeader({ cards, loading, onCardClick }: TemplateIntelligenceHeaderProps) {
  return (
    <div className="occ-tpl-intel-header">
      <div className="occ-tpl-intel-header__title-row">
        <span className="occ-tpl-intel-header__title">Template Intelligence</span>
        <span className="occ-tpl-intel-header__sub">Distinct from global queue KPIs · denominators shown</span>
      </div>
      <div className="occ-tpl-intel-header__cards">
        {cards.map((card) => (
          <button
            key={card.key}
            type="button"
            className={cls('occ-tpl-kpi-card', loading && 'is-loading', card.unavailable && 'is-unavailable')}
            onClick={() => onCardClick?.(card.key)}
            title={card.unavailable ? card.unavailableReason : undefined}
          >
            <span className="occ-tpl-kpi-card__label">{card.label}</span>
            <span className="occ-tpl-kpi-card__value">{loading ? '—' : formatValue(card)}</span>
            {card.unavailable && !loading && (
              <span className="occ-tpl-kpi-card__denom">{card.unavailableReason ?? 'Unavailable'}</span>
            )}
            {card.numerator != null && card.denominator != null && !card.unavailable && (
              <span className="occ-tpl-kpi-card__denom">{card.numerator}/{card.denominator}</span>
            )}
            {card.priorDelta != null && !loading && !card.unavailable && (
              <span className={cls('occ-tpl-kpi-card__delta', card.priorDelta >= 0 ? 'is-up' : 'is-down')}>
                {card.priorDelta >= 0 ? '+' : ''}{card.priorDelta}{card.denominator != null ? 'pp' : ''}
                {card.priorLabel ? ` ${card.priorLabel}` : ''}
              </span>
            )}
            {card.baseline != null && !loading && !card.unavailable && (
              <span className="occ-tpl-kpi-card__baseline">all-time {card.baseline}{card.denominator != null ? '%' : card.key === 'cost' ? '' : ''}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}