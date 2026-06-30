import { Icon } from '../../../../shared/icons'
import type { SenderStat } from '../../sender-fleet-stats'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const STATE_LABEL: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  degraded: 'Degraded',
  blocked: 'Blocked',
  unregistered: 'Unregistered',
}

const STATE_ACCENT: Record<string, string> = {
  active: '#3ecf8e',
  paused: '#64748b',
  degraded: '#f59e0b',
  blocked: '#f87171',
  unregistered: '#94a3b8',
}

interface MetricChipProps {
  label: string
  value: string | number
  tone?: string
  title?: string
}

function MetricChip({ label, value, tone, title }: MetricChipProps) {
  return (
    <div className={cls('occ-sender-tchip', tone && `is-${tone}`)} role="listitem" title={title}>
      <span className="occ-sender-tchip__lbl">{label}</span>
      <strong className="occ-sender-tchip__val">{value}</strong>
    </div>
  )
}

function pctTone(pct: number, sent: number): string | undefined {
  if (sent === 0) return 'muted'
  if (pct > 70) return 'green'
  if (pct > 40) return 'amber'
  return 'red'
}

interface SenderFleetCardsProps {
  senders: SenderStat[]
  selectedPhone: string | null
  onSelect: (phone: string | null) => void
  lastUsedLabel: (iso: string | null) => string
}

export function SenderFleetCards({
  senders,
  selectedPhone,
  onSelect,
  lastUsedLabel,
}: SenderFleetCardsProps) {
  if (senders.length === 0) {
    return <div className="occ-module-empty">No TextGrid numbers configured.</div>
  }

  return (
    <div className="occ-sender-card-list">
      {senders.map((s) => {
        const selected = selectedPhone === s.phone
        const accent = STATE_ACCENT[s.state] ?? '#64748b'
        const displayName = s.friendlyName || s.phone

        return (
          <article
            key={s.phone}
            className={cls('occ-sender-card', `is-${s.state}`, selected && 'is-selected', s.violations21610 > 0 && 'is-critical')}
            onClick={() => onSelect(selected ? null : s.phone)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(selected ? null : s.phone) } }}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            style={{ '--occ-sender-accent': accent } as React.CSSProperties}
          >
            <span className="occ-sender-card__accent" aria-hidden="true" />
            <div className="occ-sender-card__shell">
              <div className="occ-sender-card__atmo" aria-hidden="true" />

              <header className="occ-sender-card__top">
                <div className="occ-sender-card__signals">
                  <span className={cls('occ-sender-state', `is-${s.state}`)}>
                    {STATE_LABEL[s.state] ?? s.state}
                  </span>
                  {s.stateCode && <span className="occ-sender-region">{s.stateCode}</span>}
                  {!s.registered && <span className="occ-sender-tag is-warn">Unregistered</span>}
                </div>
                <span className="occ-sender-card__chev" aria-hidden="true">
                  <Icon name="chevron-right" size={14} />
                </span>
              </header>

              <strong className="occ-sender-card__phone occ-mono" title={s.phone}>{displayName}</strong>
              {s.friendlyName && <span className="occ-sender-card__raw occ-mono">{s.phone}</span>}

              <div className="occ-sender-card__context">
                <span className="occ-sender-market-chip">{s.market}</span>
                {s.dailyCap != null && (
                  <span className="occ-sender-cap-chip">Cap {s.dailyCap.toLocaleString()}/d</span>
                )}
                <span className={cls('occ-sender-health', `is-${s.health}`)}>{s.health}</span>
              </div>

              <p className="occ-sender-card__ops">{s.operationalLabel}</p>

              <div className="occ-sender-card__telemetry">
                <div className="occ-sender-card__telemetry-track" role="list">
                  <MetricChip label="Today" value={s.messagesSentToday} tone={s.messagesSentToday > 0 ? 'cyan' : 'muted'} title="messages_sent_today (registry)" />
                  <MetricChip label="Sent" value={s.sent} />
                  <MetricChip label="Del" value={s.delivered} tone={s.delivered > 0 ? 'green' : 'muted'} />
                  <MetricChip label="Fail" value={s.failed} tone={s.failed > 0 ? 'red' : undefined} />
                  <MetricChip label="Blk" value={s.blocked} tone={s.blocked > 0 ? 'amber' : undefined} />
                  <MetricChip label="Del%" value={s.sent > 0 ? `${s.deliveryPct}%` : '—'} tone={pctTone(s.deliveryPct, s.sent)} />
                  <MetricChip label="Fail%" value={s.sent > 0 ? `${s.failPct}%` : '—'} tone={pctTone(100 - s.failPct, s.sent)} />
                  <MetricChip label="Opt" value={s.optOuts} tone={s.optOuts > 0 ? 'red' : undefined} />
                  <MetricChip label="21610" value={s.violations21610} tone={s.violations21610 > 0 ? 'red' : undefined} />
                  <MetricChip label="Rows" value={s.rangeRows} tone="muted" />
                  {s.dailyCap != null && (
                    <MetricChip label="Cap" value={s.dailyCap} tone="cyan" title="Daily send cap" />
                  )}
                  {s.healthScore != null && (
                    <MetricChip label="Health" value={Math.round(s.healthScore * 100)} tone={s.healthScore >= 0.85 ? 'green' : s.healthScore >= 0.7 ? 'amber' : 'red'} title="health_score (registry)" />
                  )}
                </div>
              </div>

              <footer className="occ-sender-card__foot">
                <span className="occ-sender-card__foot-meta">
                  {(s.lastUsed || s.registryLastUsedAt)
                    ? `Last used ${lastUsedLabel(s.lastUsed || s.registryLastUsedAt)}`
                    : 'No activity logged'}
                </span>
                <span className="occ-sender-card__foot-cta">
                  {selected ? 'Selected' : 'Inspect'}
                  <Icon name="chevron-right" size={12} />
                </span>
              </footer>
            </div>
          </article>
        )
      })}
    </div>
  )
}