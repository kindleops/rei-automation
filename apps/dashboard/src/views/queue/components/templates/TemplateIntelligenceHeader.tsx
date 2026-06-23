import type { TemplateKpiCard } from '../../../../domain/templates/template-intelligence.types'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface TemplateIntelligenceHeaderProps {
  cards: TemplateKpiCard[]
  loading?: boolean
  onCardClick?: (key: string) => void
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
            className={cls('occ-tpl-kpi-card', loading && 'is-loading')}
            onClick={() => onCardClick?.(card.key)}
          >
            <span className="occ-tpl-kpi-card__label">{card.label}</span>
            <span className="occ-tpl-kpi-card__value">
              {loading ? '—' : card.current != null ? (card.denominator != null ? `${card.current}%` : card.current) : '—'}
            </span>
            {card.numerator != null && card.denominator != null && (
              <span className="occ-tpl-kpi-card__denom">{card.numerator}/{card.denominator}</span>
            )}
            {card.priorDelta != null && !loading && (
              <span className={cls('occ-tpl-kpi-card__delta', card.priorDelta >= 0 ? 'is-up' : 'is-down')}>
                {card.priorDelta >= 0 ? '+' : ''}{card.priorDelta}{card.denominator != null ? 'pp' : ''}
              </span>
            )}
            {card.baseline != null && !loading && (
              <span className="occ-tpl-kpi-card__baseline">all-time {card.baseline}{card.denominator != null ? '%' : ''}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}