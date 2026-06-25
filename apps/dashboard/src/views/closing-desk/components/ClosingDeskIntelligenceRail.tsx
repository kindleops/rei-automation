import type { ClosingCase } from '../../../domain/closing-desk/closing-desk.types'
import { boardColumnLabel } from '../../../domain/closing-desk/closing-board'
import { isActivelyBlocking } from '../../../domain/closing-desk/closing-issues'
import { daysRemaining, formatDate, primaryBlocker, stageLabel } from '../closing-desk-utils'

const NOW = () => Date.now()

export interface ClosingDeskIntelligenceRailProps {
  cases: ClosingCase[]
  degraded: boolean
}

export function ClosingDeskIntelligenceRail({ cases, degraded }: ClosingDeskIntelligenceRailProps) {
  const now = NOW()

  const deadlines = cases
    .flatMap((c) => [
      { caseName: c.displayName, label: 'EMD due', date: c.dates.emdDueDate, owner: c.health.responsibleParty, lane: c.boardColumn, severity: c.readiness.emdReceived === false ? 'critical' : 'medium' },
      { caseName: c.displayName, label: 'Scheduled close', date: c.dates.scheduledClosingDate, owner: c.health.responsibleParty, lane: c.boardColumn, severity: 'high' },
      { caseName: c.displayName, label: 'Cure deadline', date: c.dates.cureDeadline, owner: c.health.responsibleParty, lane: c.boardColumn, severity: 'high' },
    ])
    .filter((d) => d.date && new Date(d.date).getTime() >= now - 86_400_000)
    .sort((a, b) => new Date(a.date!).getTime() - new Date(b.date!).getTime())
    .slice(0, 6)

  const blockers = cases
    .flatMap((c) => {
      const b = primaryBlocker(c)
      if (!b || !isActivelyBlocking(b)) return []
      const slaDays = daysRemaining(b.dueAt, now)
      return [{
        caseName: c.displayName,
        issue: b.title,
        category: b.category,
        severity: b.severity,
        owner: b.owner ?? c.health.responsibleParty ?? 'Unassigned',
        slaDays,
        lane: c.boardColumn,
        milestone: b.blockingMilestones[0] ?? 'clear_to_close',
      }]
    })
    .slice(0, 6)

  const activity = [...cases]
    .filter((c) => c.lastActivityAt || c.milestones.length > 0)
    .flatMap((c) => {
      const items: { ts: string; property: string; event: string; source: string; stage: string }[] = []
      if (c.lastActivityAt) {
        items.push({ ts: c.lastActivityAt, property: c.displayName, event: 'Last activity', source: 'derived', stage: stageLabel(c.universalStage) })
      }
      const lastMs = c.milestones[c.milestones.length - 1]
      if (lastMs?.occurredAt) {
        items.push({ ts: lastMs.occurredAt, property: c.displayName, event: lastMs.type.replace(/_/g, ' '), source: lastMs.sourceSystem, stage: boardColumnLabel(c.boardColumn) })
      }
      return items
    })
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, 6)

  return (
    <section className="cd-ops-rail" data-testid="cd-intel-rail" aria-label="Operations intelligence">
      <article className="cd-ops-module">
        <header><h3>Upcoming Deadlines</h3><span className="cd-ops-module__count">{deadlines.length}</span></header>
        {deadlines.length === 0 ? (
          <p className="cd-ops-empty">{degraded ? 'Dates not projected for active cases.' : 'No upcoming deadlines in view.'}</p>
        ) : (
          <ul className="cd-ops-timeline">
            {deadlines.map((d, i) => {
              const countdown = daysRemaining(d.date, now)
              return (
                <li key={`${d.caseName}-${d.label}-${i}`} data-sev={d.severity}>
                  <div className="cd-ops-timeline__date">
                    <strong>{formatDate(d.date)}</strong>
                    {countdown !== null ? <span className="cd-chip">{countdown <= 0 ? 'Due' : `${countdown}d`}</span> : null}
                  </div>
                  <div className="cd-ops-timeline__body">
                    <span className="cd-ops-timeline__title">{d.label}</span>
                    <span className="cd-ops-timeline__meta">{d.caseName} · {d.owner ?? '—'} · {boardColumnLabel(d.lane)}</span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </article>

      <article className="cd-ops-module">
        <header><h3>Highest-Risk Blockers</h3><span className="cd-ops-module__count">{blockers.length}</span></header>
        {blockers.length === 0 ? (
          <p className="cd-ops-empty">{degraded ? 'Issue catalog awaiting projection.' : 'No active blockers in view.'}</p>
        ) : (
          <ul className="cd-ops-timeline">
            {blockers.map((b, i) => (
              <li key={`${b.caseName}-${b.issue}-${i}`} data-sev={b.severity}>
                <div className="cd-ops-timeline__date">
                  <span className={`cd-chip cd-chip--${b.severity}`}>{b.severity}</span>
                  {b.slaDays !== null ? <span className="cd-chip">{b.slaDays <= 0 ? 'SLA breach' : `${b.slaDays}d SLA`}</span> : null}
                </div>
                <div className="cd-ops-timeline__body">
                  <span className="cd-ops-timeline__title">{b.issue}</span>
                  <span className="cd-ops-timeline__meta">{b.category} · {b.caseName} · {b.owner} · blocks {b.milestone}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </article>

      <article className="cd-ops-module">
        <header><h3>Recent Closing Activity</h3><span className="cd-ops-module__count">{activity.length}</span></header>
        {activity.length === 0 ? (
          <p className="cd-ops-empty">{degraded ? 'Activity stream not mirrored.' : 'No recent activity in view.'}</p>
        ) : (
          <ul className="cd-ops-timeline">
            {activity.map((a, i) => (
              <li key={`${a.property}-${a.ts}-${i}`}>
                <div className="cd-ops-timeline__date">
                  <strong>{formatDate(a.ts)}</strong>
                  <span className="cd-ops-icon" aria-hidden>◆</span>
                </div>
                <div className="cd-ops-timeline__body">
                  <span className="cd-ops-timeline__title">{a.event}</span>
                  <span className="cd-ops-timeline__meta">{a.property} · {a.source} · {a.stage}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </article>
    </section>
  )
}