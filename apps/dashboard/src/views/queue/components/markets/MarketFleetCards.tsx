import { Icon } from '../../../../shared/icons'
import type { MarketStat } from '../../market-fleet-stats'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const HEALTH_ACCENT: Record<string, string> = {
  healthy: '#3ecf8e',
  watch: '#22d3ee',
  degraded: '#f59e0b',
  critical: '#f87171',
  idle: '#64748b',
}

interface MetricChipProps {
  label: string
  value: string | number
  tone?: string
  title?: string
}

function MetricChip({ label, value, tone, title }: MetricChipProps) {
  return (
    <div className={cls('occ-market-tchip', tone && `is-${tone}`)} role="listitem" title={title}>
      <span className="occ-market-tchip__lbl">{label}</span>
      <strong className="occ-market-tchip__val">{value}</strong>
    </div>
  )
}

function pctTone(pct: number, base: number): string | undefined {
  if (base === 0) return 'muted'
  if (pct > 70) return 'green'
  if (pct > 40) return 'amber'
  return 'red'
}

interface MarketFleetCardsProps {
  markets: MarketStat[]
  selectedMarket: string | null
  onSelect: (market: string | null) => void
  onViewRows: (market: string) => void
}

export function MarketFleetCards({
  markets,
  selectedMarket,
  onSelect,
  onViewRows,
}: MarketFleetCardsProps) {
  if (markets.length === 0) {
    return <div className="occ-module-empty">No markets match this filter.</div>
  }

  return (
    <div className="occ-market-card-list">
      {markets.map((m) => {
        const selected = selectedMarket === m.market
        const accent = HEALTH_ACCENT[m.health] ?? '#64748b'
        const shortMarket = m.market.replace(/, [A-Z]{2}$/, '')

        return (
          <article
            key={m.market}
            className={cls(
              'occ-market-card',
              `is-${m.health}`,
              selected && 'is-selected',
              !m.configured && 'is-unregistered',
            )}
            onClick={() => onSelect(selected ? null : m.market)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(selected ? null : m.market) } }}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            style={{ '--occ-market-accent': accent } as React.CSSProperties}
          >
            <span className="occ-market-card__accent" aria-hidden="true" />
            <div className="occ-market-card__shell">
              <div className="occ-market-card__atmo" aria-hidden="true" />

              <header className="occ-market-card__top">
                <div className="occ-market-card__signals">
                  <span className={cls('occ-market-health', `is-${m.health}`)}>{m.health}</span>
                  {m.stateCode && <span className="occ-market-region">{m.stateCode}</span>}
                  {!m.configured && <span className="occ-market-tag is-warn">Unregistered</span>}
                </div>
                <span className="occ-market-card__chev" aria-hidden="true">
                  <Icon name="chevron-right" size={14} />
                </span>
              </header>

              <strong className="occ-market-card__name" title={m.market}>{shortMarket}</strong>
              <span className="occ-market-card__full">{m.market}</span>

              <div className="occ-market-card__context">
                <span className={cls('occ-market-sender-chip', m.active ? 'is-green' : m.senderExists ? 'is-amber' : 'is-red')}>
                  {m.senderReadiness}
                </span>
                {m.senderCount > 0 && (
                  <span className="occ-market-sender-chip is-muted">{m.senderCount} number{m.senderCount === 1 ? '' : 's'}</span>
                )}
                {m.dailyCapTotal != null && (
                  <span className="occ-market-cap-chip">Cap {m.dailyCapTotal.toLocaleString()}/d</span>
                )}
              </div>

              <p className="occ-market-card__ops">{m.suggestedAction}</p>

              <div className="occ-market-card__telemetry">
                <div className="occ-market-card__telemetry-track" role="list">
                  <MetricChip label="Rows" value={m.total} />
                  <MetricChip label="Today" value={m.messagesSentToday} tone={m.messagesSentToday > 0 ? 'cyan' : 'muted'} />
                  <MetricChip label="Sent" value={m.sent} />
                  <MetricChip label="Del" value={m.delivered} tone={m.delivered > 0 ? 'green' : 'muted'} />
                  <MetricChip label="Fail" value={m.failed} tone={m.failed > 0 ? 'red' : undefined} />
                  <MetricChip label="Blk" value={m.blocked} tone={m.blocked > 0 ? 'amber' : undefined} />
                  <MetricChip label="Del%" value={m.sent > 0 ? `${m.deliveryPct}%` : '—'} tone={pctTone(m.deliveryPct, m.sent)} />
                  <MetricChip label="Fail%" value={m.sent > 0 ? `${m.failPct}%` : '—'} tone={pctTone(100 - m.failPct, m.sent)} />
                  <MetricChip label="Opt" value={m.optOuts} tone={m.optOuts > 0 ? 'red' : undefined} />
                  <MetricChip label="21610" value={m.violations21610} tone={m.violations21610 > 0 ? 'red' : undefined} />
                  <MetricChip label="Exc" value={m.exceptionCount} tone={m.exceptionCount > 0 ? 'amber' : undefined} />
                </div>
              </div>

              <footer className="occ-market-card__foot">
                <span className="occ-market-card__foot-meta">{m.performanceHealth} performance</span>
                <button
                  type="button"
                  className="occ-market-card__foot-cta"
                  onClick={(e) => { e.stopPropagation(); if (m.total > 0) onViewRows(m.market) }}
                  disabled={m.total === 0}
                >
                  {m.total > 0 ? `View ${m.total} rows` : 'No rows'}
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