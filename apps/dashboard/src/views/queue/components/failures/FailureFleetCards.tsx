import { Icon } from '../../../../shared/icons'
import type { FailureCauseStat } from '../../failure-taxonomy-stats'
import { FAILURE_CATEGORY_TONE, FAILURE_SEVERITY_ACCENT } from '../../failure-taxonomy-stats'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface MetricChipProps {
  label: string
  value: string | number
  tone?: string
  title?: string
}

function MetricChip({ label, value, tone, title }: MetricChipProps) {
  return (
    <div className={cls('occ-fail-tchip', tone && `is-${tone}`)} role="listitem" title={title}>
      <span className="occ-fail-tchip__lbl">{label}</span>
      <strong className="occ-fail-tchip__val">{value}</strong>
    </div>
  )
}

interface FailureFleetCardsProps {
  causes: FailureCauseStat[]
  selectedCause: string | null
  onSelect: (cause: string | null) => void
  onViewRows: (cause: string) => void
}

export function FailureFleetCards({
  causes,
  selectedCause,
  onSelect,
  onViewRows,
}: FailureFleetCardsProps) {
  if (causes.length === 0) {
    return <div className="occ-module-empty">No failures match this filter.</div>
  }

  return (
    <div className="occ-fail-card-list">
      {causes.map((s) => {
        const selected = selectedCause === s.cause
        const tone = FAILURE_CATEGORY_TONE[s.category] ?? 'amber'
        const accent = FAILURE_SEVERITY_ACCENT[s.severity] ?? '#f59e0b'

        return (
          <article
            key={s.cause}
            className={cls('occ-fail-card', `is-${tone}`, `is-sev-${s.severity}`, selected && 'is-selected')}
            onClick={() => onSelect(selected ? null : s.cause)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(selected ? null : s.cause) } }}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            style={{ '--occ-fail-accent': accent } as React.CSSProperties}
          >
            <span className="occ-fail-card__accent" aria-hidden="true" />
            <div className="occ-fail-card__shell">
              <div className="occ-fail-card__atmo" aria-hidden="true" />

              <header className="occ-fail-card__top">
                <div className="occ-fail-card__signals">
                  <span className={cls('occ-fail-cat', `is-${tone}`)}>{s.category}</span>
                  <span className={cls('occ-fail-sev', `is-${s.severity}`)}>{s.severity}</span>
                  {s.suppression && <span className="occ-fail-tag is-suppress">Suppress</span>}
                </div>
                <span className="occ-fail-card__chev" aria-hidden="true">
                  <Icon name="chevron-right" size={14} />
                </span>
              </header>

              <strong className="occ-fail-card__name" title={s.label}>{s.label}</strong>

              <div className="occ-fail-card__context">
                <span className={cls('occ-fail-disposition', s.retryable ? 'is-green' : 'is-red')}>
                  {s.retryable ? 'Retryable' : 'Non-retryable'}
                </span>
                {s.topMarket && <span className="occ-fail-market-chip">{s.topMarket.replace(/, [A-Z]{2}$/, '')}</span>}
              </div>

              <p className="occ-fail-card__action">{s.action}</p>

              <div className="occ-fail-card__telemetry">
                <div className="occ-fail-card__telemetry-track" role="list">
                  <MetricChip label="Count" value={s.count} tone={tone === 'red' ? 'red' : 'amber'} />
                  <MetricChip label="Share" value={`${s.pctOfTotal}%`} tone="muted" />
                  <MetricChip label="Fail" value={s.failedCount} tone={s.failedCount > 0 ? 'red' : undefined} />
                  <MetricChip label="Blk" value={s.blockedCount} tone={s.blockedCount > 0 ? 'amber' : undefined} />
                  <MetricChip label="Mkts" value={s.markets.length} tone="cyan" />
                  <MetricChip label="Send" value={s.senders.length} tone="muted" />
                  <MetricChip label="Tpl" value={s.templates.length} tone="muted" />
                </div>
              </div>

              {s.markets.length > 0 && (
                <div className="occ-fail-card__chips">
                  {s.markets.slice(0, 3).map((m) => (
                    <span key={m} className="occ-chip">{m.replace(/, [A-Z]{2}$/, '')}</span>
                  ))}
                  {s.markets.length > 3 && <span className="occ-chip is-muted">+{s.markets.length - 3}</span>}
                </div>
              )}

              <footer className="occ-fail-card__foot">
                <span className="occ-fail-card__foot-meta">{s.cause.replace(/_/g, ' ')}</span>
                <button
                  type="button"
                  className="occ-fail-card__foot-cta"
                  onClick={(e) => { e.stopPropagation(); onViewRows(s.cause) }}
                >
                  View {s.count} rows
                  <Icon name="chevron-right" size={12} />
                </button>
              </footer>
            </div>
          </article>
        )
      })}
    </div>
  )
}