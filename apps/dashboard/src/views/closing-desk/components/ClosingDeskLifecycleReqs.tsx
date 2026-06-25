import { CLOSING_BOARD_COLUMNS, LANE_GUIDANCE } from '../../../domain/closing-desk/closing-board'

export function ClosingDeskLifecycleReqs() {
  return (
    <section id="cd-lifecycle-reqs" className="cd-lifecycle-reqs" data-testid="cd-lifecycle-reqs" aria-labelledby="cd-lifecycle-title">
      <h3 id="cd-lifecycle-title">Lifecycle lane requirements</h3>
      <p className="cd-lifecycle-reqs__lead">
        Stages 6–10 span Formal Contract through Closed. Cases derive their board lane from universal stage,
        title/disposition/funding status, and active blockers — never from a stored column field.
      </p>
      <ol className="cd-lifecycle-reqs__list">
        {CLOSING_BOARD_COLUMNS.map((col) => (
          <li key={col.id}>
            <strong>{col.label}</strong>
            <span>{LANE_GUIDANCE[col.id].qualifies}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}