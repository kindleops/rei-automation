import type { ClosingCase } from '../../../domain/closing-desk/closing-desk.types'
import { boardColumnLabel } from '../../../domain/closing-desk/closing-board'
import { isActivelyBlocking } from '../../../domain/closing-desk/closing-issues'

function formatDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString()
}

export interface ClosingDeskIntelligenceRailProps {
  cases: ClosingCase[]
  degraded: boolean
}

export function ClosingDeskIntelligenceRail({ cases, degraded }: ClosingDeskIntelligenceRailProps) {
  const now = Date.now()

  const deadlines = cases
    .flatMap((c) => [
      { caseName: c.displayName, label: 'EMD due', date: c.dates.emdDueDate, lane: c.boardColumn },
      { caseName: c.displayName, label: 'Scheduled close', date: c.dates.scheduledClosingDate, lane: c.boardColumn },
      { caseName: c.displayName, label: 'Cure deadline', date: c.dates.cureDeadline, lane: c.boardColumn },
    ])
    .filter((d) => d.date && new Date(d.date).getTime() >= now)
    .sort((a, b) => new Date(a.date!).getTime() - new Date(b.date!).getTime())
    .slice(0, 5)

  const blockers = cases
    .flatMap((c) =>
      c.issues
        .filter(isActivelyBlocking)
        .map((i) => ({ caseName: c.displayName, issue: i.title, severity: i.severity, lane: c.boardColumn })),
    )
    .slice(0, 5)

  const activity = [...cases]
    .filter((c) => c.lastActivityAt)
    .sort((a, b) => new Date(b.lastActivityAt!).getTime() - new Date(a.lastActivityAt!).getTime())
    .slice(0, 5)

  return (
    <section className="cd-intel-rail" data-testid="cd-intel-rail" aria-label="Closing intelligence">
      <div className="cd-intel-panel">
        <h3>Upcoming deadlines</h3>
        {deadlines.length === 0 ? (
          <p className="cd-intel-empty">{degraded ? 'Dates not projected for active cases.' : 'No upcoming deadlines in view.'}</p>
        ) : (
          <ul className="cd-intel-list">
            {deadlines.map((d, i) => (
              <li key={`${d.caseName}-${d.label}-${i}`}>
                <span className="cd-intel-list__primary">{d.caseName}</span>
                <span className="cd-intel-list__meta">{d.label} · {formatDate(d.date)} · {boardColumnLabel(d.lane)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="cd-intel-panel">
        <h3>Highest-risk blockers</h3>
        {blockers.length === 0 ? (
          <p className="cd-intel-empty">{degraded ? 'Issue catalog awaiting Podio projection.' : 'No active blockers in view.'}</p>
        ) : (
          <ul className="cd-intel-list">
            {blockers.map((b, i) => (
              <li key={`${b.caseName}-${b.issue}-${i}`}>
                <span className="cd-intel-list__primary">{b.issue}</span>
                <span className="cd-intel-list__meta">{b.caseName} · {b.severity} · {boardColumnLabel(b.lane)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="cd-intel-panel">
        <h3>Recent closing activity</h3>
        {activity.length === 0 ? (
          <p className="cd-intel-empty">{degraded ? 'Activity stream not yet mirrored.' : 'No recent activity in view.'}</p>
        ) : (
          <ul className="cd-intel-list">
            {activity.map((c) => (
              <li key={c.identity.closingCaseId}>
                <span className="cd-intel-list__primary">{c.displayName}</span>
                <span className="cd-intel-list__meta">
                  {boardColumnLabel(c.boardColumn)} · {formatDate(c.lastActivityAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}