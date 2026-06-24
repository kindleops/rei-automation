import type { TemplateIntelligenceFilters, TemplateKpiCard } from '../../../../domain/templates/template-intelligence.types'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const RANGE_OPTIONS = [
  { key: 'today', label: 'Today' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: 'all', label: 'All time' },
] as const

interface TemplateIntelligenceHeaderProps {
  cards: TemplateKpiCard[]
  loading?: boolean
  filters: TemplateIntelligenceFilters
  globalRangeLabel?: string
  onFiltersChange: (patch: Partial<TemplateIntelligenceFilters>) => void
  onCardClick?: (key: string) => void
}

function formatValue(card: TemplateKpiCard) {
  if (card.unavailable) return 'Unattributed'
  if (card.insufficientData) return 'Not enough data'
  if (card.current == null) return '—'
  if (card.key === 'cost') return `$${Number(card.current).toFixed(2)}`
  if (card.key === 'average_reply_time') return `${Number(card.current).toFixed(1)}h`
  if (card.denominator != null) return `${card.current}%`
  return String(card.current)
}

export function TemplateIntelligenceHeader({
  cards,
  loading,
  filters,
  globalRangeLabel,
  onFiltersChange,
  onCardClick,
}: TemplateIntelligenceHeaderProps) {
  return (
    <header className="occ-tpl-intel-header">
      <div className="occ-tpl-intel-header__top">
        <div className="occ-tpl-intel-header__intro">
          <h2 className="occ-tpl-intel-header__title">Templates</h2>
          <p className="occ-tpl-intel-header__sub">
            Message performance, health, and optimization recommendations — recommendations only, sending disabled.
          </p>
        </div>
        <div className="occ-tpl-intel-header__controls">
          <label className="occ-tpl-intel-header__range-label">
            <span>Template range</span>
            <select
              className="occ-filter-select"
              value={filters.range}
              onChange={(e) => onFiltersChange({ range: e.target.value as TemplateIntelligenceFilters['range'] })}
            >
              {RANGE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </label>
          <select
            className="occ-filter-select"
            value={filters.stage ?? 'all'}
            onChange={(e) => onFiltersChange({ stage: e.target.value === 'all' ? undefined : e.target.value })}
          >
            <option value="all">All stages</option>
            <option value="S1">S1 Ownership</option>
            <option value="S1F">S1F Follow-up</option>
            <option value="S2">S2 Selling interest</option>
            <option value="S3">S3 Asking price</option>
            <option value="S4">S4 Condition</option>
            <option value="S5">S5 Offer</option>
            <option value="S6">S6 Contract</option>
          </select>
          {globalRangeLabel && (
            <span className="occ-tpl-intel-header__global-hint" title="Queue KPIs use the global command center date range">
              Queue: {globalRangeLabel}
            </span>
          )}
        </div>
      </div>
      {globalRangeLabel && (
        <p className="occ-tpl-intel-header__range-note">
          Template metrics use the template date range selector — independent from the {globalRangeLabel} queue KPI range.
        </p>
      )}
      <div className="occ-tpl-intel-header__cards">
        {cards.map((card) => (
          <button
            key={card.key}
            type="button"
            className={cls(
              'occ-tpl-kpi-card',
              loading && 'is-loading',
              card.unavailable && 'is-unavailable',
              card.insufficientData && 'is-insufficient',
            )}
            onClick={() => onCardClick?.(card.key)}
            title={card.unavailable ? card.unavailableReason : undefined}
          >
            <span className="occ-tpl-kpi-card__label">{card.label}</span>
            <span className="occ-tpl-kpi-card__value">{loading ? '—' : formatValue(card)}</span>
            {card.numerator != null && card.denominator != null && !card.unavailable && !loading && (
              <span className="occ-tpl-kpi-card__denom">{card.numerator}/{card.denominator}</span>
            )}
            {card.unavailable && !loading && (
              <span className="occ-tpl-kpi-card__denom">{card.unavailableReason ?? 'Unavailable'}</span>
            )}
            {card.priorDelta != null && !loading && !card.unavailable && (
              <span className={cls('occ-tpl-kpi-card__delta', card.priorDelta >= 0 ? 'is-up' : 'is-down')}>
                {card.priorDelta >= 0 ? '+' : ''}{card.priorDelta}{card.denominator != null ? 'pp' : ''}
                {card.priorLabel ? ` ${card.priorLabel}` : ''}
              </span>
            )}
          </button>
        ))}
      </div>
    </header>
  )
}