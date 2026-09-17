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
  const revenueUnavailable =
    summary == null ||
    summary.expectedRevenue === null ||
    summary.metricSources?.expectedRevenue === 'absent'
  const revenueNote = revenueUnavailable
    ? summary?.metricNotes?.expectedRevenue ?? 'Expected revenue is not available from the closing authority.'
    : null
  const now = new Date()
  const timeLabel = now.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

  /**
   * 'error' had no branch here, so a failed read fell through to the final
   * else and was badged "Live Data" — a confident claim of freshness on a desk
   * that loaded nothing. The board was correctly empty and every KPI correctly
   * read '—', which made the badge the single most misleading thing on screen.
   */
  const status =
    surfaceState === 'error'
      ? { label: 'Read Failed', tone: 'warn' as const }
      : surfaceState === 'demo'
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
          {/*
            `money(summary?.expectedRevenue ?? 0)` rendered a hard "$0" whenever
            the revenue authority had nothing to say — no summary loaded, the
            read failed, or no case carries expected_gross_revenue. "$0 revenue
            in motion" is a claim about the business; "—" is the truth about the
            data. The `?? '—'` after money() could never fire because the `?? 0`
            before it had already removed the null.
          */}
          <span className="cd-pulse-metric__value" title={revenueNote ?? undefined}>
            {loading ? '…' : revenueUnavailable ? '—' : money(summary?.expectedRevenue) ?? '—'}
          </span>
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