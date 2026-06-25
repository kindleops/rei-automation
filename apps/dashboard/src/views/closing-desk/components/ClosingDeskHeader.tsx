import type { ClosingDeskSurfaceState } from '../closing-desk-state'
import { money, portfolioPulse } from '../closing-desk-utils'
import type { ClosingCase, ClosingDeskSummary } from '../../../domain/closing-desk/closing-desk.types'

export interface ClosingDeskHeaderProps {
  surfaceState: ClosingDeskSurfaceState
  summary: ClosingDeskSummary | null
  cases: ClosingCase[]
  loading: boolean
}

export function ClosingDeskHeader({ surfaceState, summary, cases, loading }: ClosingDeskHeaderProps) {
  const pulse = portfolioPulse(cases)
  const now = new Date()
  const timeLabel = now.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

  const status =
    surfaceState === 'demo'
      ? { label: 'Synthetic Demo', tone: 'demo' as const }
      : surfaceState === 'degraded'
        ? { label: 'Degraded Projection', tone: 'warn' as const }
        : surfaceState === 'zero'
          ? { label: 'Live · Zero Cases', tone: 'neutral' as const }
          : { label: 'Live Data', tone: 'live' as const }

  return (
    <header className="cd-command-header" data-testid="cd-command-header">
      <div className="cd-command-header__identity">
        <p className="cd-command-header__eyebrow">NEXUS / CLOSING OPERATIONS</p>
        <div className="cd-command-header__title-row">
          <h1>Closing Desk</h1>
          <span className={`cd-status-pill cd-status-pill--${status.tone}`}>
            <span className="cd-status-pill__dot" aria-hidden />
            {status.label}
          </span>
        </div>
        <p className="cd-command-header__descriptor">
          Stages 6–10 · Formal Contract → Under Contract → Disposition → Prepared to Close → Closed
        </p>
      </div>

      <div className="cd-command-header__pulse" aria-label="Portfolio pulse">
        <div className="cd-pulse-metric">
          <span className="cd-pulse-metric__value">{loading ? '…' : pulse.active}</span>
          <span className="cd-pulse-metric__label">Active closings</span>
        </div>
        <div className="cd-pulse-metric is-warn">
          <span className="cd-pulse-metric__value">{loading ? '…' : pulse.atRisk}</span>
          <span className="cd-pulse-metric__label">At risk</span>
        </div>
        <div className="cd-pulse-metric is-accent">
          <span className="cd-pulse-metric__value">{loading ? '…' : pulse.attention}</span>
          <span className="cd-pulse-metric__label">Needs attention</span>
        </div>
        <div className="cd-pulse-metric is-revenue">
          <span className="cd-pulse-metric__value">{loading ? '…' : money(summary?.expectedRevenue ?? 0) ?? '—'}</span>
          <span className="cd-pulse-metric__label">Revenue in motion</span>
        </div>
      </div>

      <div className="cd-command-header__meta">
        <span className="cd-command-header__clock">{timeLabel}</span>
        <span className="cd-command-header__sync">Read-only · No outbound sync</span>
      </div>
    </header>
  )
}