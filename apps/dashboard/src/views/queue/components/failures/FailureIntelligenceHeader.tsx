import type { FailureCategoryFilter, FailureRetryFilter, FailureTaxonomySummary } from '../../failure-taxonomy-stats'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const CATEGORY_FILTERS: Array<{ key: FailureCategoryFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'Compliance', label: 'Compliance' },
  { key: 'Carrier', label: 'Carrier' },
  { key: 'Routing', label: 'Routing' },
  { key: 'Template', label: 'Template' },
  { key: 'Payload', label: 'Payload' },
  { key: 'Webhook', label: 'Webhook' },
  { key: 'Guard', label: 'Guard' },
  { key: 'Unknown', label: 'Unknown' },
]

const RETRY_FILTERS: Array<{ key: FailureRetryFilter; label: string }> = [
  { key: 'all', label: 'Any disposition' },
  { key: 'retryable', label: 'Retryable' },
  { key: 'non-retryable', label: 'Non-retryable' },
  { key: 'suppression', label: 'Suppress required' },
]

interface FailureIntelligenceHeaderProps {
  summary: FailureTaxonomySummary
  rangeLabel: string
  isMobileLayout?: boolean
  categoryFilter: FailureCategoryFilter
  retryFilter: FailureRetryFilter
  onCategoryFilter: (filter: FailureCategoryFilter) => void
  onRetryFilter: (filter: FailureRetryFilter) => void
}

interface KpiDef {
  key: string
  label: string
  value: string | number
  sub?: string
  tone?: string
}

export function FailureIntelligenceHeader({
  summary,
  rangeLabel,
  isMobileLayout = false,
  categoryFilter,
  retryFilter,
  onCategoryFilter,
  onRetryFilter,
}: FailureIntelligenceHeaderProps) {
  const cards: KpiDef[] = isMobileLayout
    ? [
        { key: 'total', label: 'Rows', value: summary.total, sub: `${summary.causeCount} causes` },
        { key: 'retry', label: 'Retry', value: summary.retryable, tone: 'green' },
        { key: 'block', label: 'No Retry', value: summary.nonRetryable, tone: 'red' },
        { key: 'comp', label: 'Compliance', value: summary.compliance, tone: summary.compliance > 0 ? 'red' : 'muted' },
        { key: 'suppress', label: 'Suppress', value: summary.suppressionRequired, tone: summary.suppressionRequired > 0 ? 'amber' : 'muted' },
      ]
    : [
        { key: 'total', label: 'Affected Rows', value: summary.total, sub: `${summary.causeCount} failure families` },
        { key: 'retryable', label: 'Retryable', value: summary.retryable, tone: 'green' },
        { key: 'non-retryable', label: 'Non-retryable', value: summary.nonRetryable, tone: 'red' },
        { key: 'compliance', label: 'Compliance', value: summary.compliance, tone: summary.compliance > 0 ? 'red' : 'muted' },
        { key: 'carrier', label: 'Carrier', value: summary.carrier, tone: summary.carrier > 0 ? 'red' : 'muted' },
        { key: 'routing', label: 'Routing/Config', value: summary.routing + summary.template + summary.payload + summary.guard, tone: 'amber' },
        { key: 'suppression', label: 'Suppress Required', value: summary.suppressionRequired, tone: summary.suppressionRequired > 0 ? 'amber' : 'muted' },
        { key: 'blocked', label: 'Blocked', value: summary.blocked, sub: `${summary.failed} failed` },
        { key: 'scope', label: 'Blast Radius', value: summary.uniqueMarkets, sub: `${summary.uniqueSenders} senders · ${summary.uniqueTemplates} templates` },
      ]

  return (
    <header className={cls('occ-fail-intel-header', isMobileLayout && 'occ-fail-intel-header--mobile')}>
      <div className={cls('occ-fail-kpi-rail', isMobileLayout && 'occ-fail-kpi-rail--mobile')}>
        {cards.map((card) => (
          <div key={card.key} className={cls('occ-fail-kpi-card', card.tone && `is-${card.tone}`)}>
            <span className="occ-fail-kpi-card__label">{card.label}</span>
            <span className="occ-fail-kpi-card__value">{card.value}</span>
            {card.sub && <span className="occ-fail-kpi-card__sub">{card.sub}</span>}
          </div>
        ))}
      </div>

      {!isMobileLayout && (
        <p className="occ-fail-intel-header__sub">
          Failure taxonomy across {rangeLabel} · webhook {summary.webhook} · unknown {summary.unknown}
        </p>
      )}

      <div className="occ-fail-filter-row">
        <div className="occ-fail-filter-chips occ-fail-filter-chips--category" role="tablist" aria-label="Filter by category">
          {CATEGORY_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={categoryFilter === f.key}
              className={cls('occ-fail-fchip', categoryFilter === f.key && 'is-active')}
              onClick={() => onCategoryFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="occ-fail-filter-chips occ-fail-filter-chips--retry" role="tablist" aria-label="Filter by disposition">
          {RETRY_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={retryFilter === f.key}
              className={cls('occ-fail-fchip occ-fail-fchip--retry', retryFilter === f.key && 'is-active')}
              onClick={() => onRetryFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
    </header>
  )
}