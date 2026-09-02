import type { CampaignBuilderPhase } from '../components/CampaignBuilderMobileNav'

/**
 * Creator stage rail — BUILD → REACH → LAUNCH.
 *
 * One slim bar, not a tab bar: a hairline track fills to the current stage so
 * the operator can see how far through the build they are, and the live
 * candidate count rides on the right at every stage so the number being shaped
 * is never off-screen.
 *
 * The count is marked STALE the moment targeting changes after a preview —
 * previews are expensive, so BUILD edits invalidate the number rather than
 * silently re-running the query.
 */

const STAGES: Array<{ key: CampaignBuilderPhase; label: string }> = [
  { key: 'build', label: 'BUILD' },
  { key: 'reach', label: 'REACH' },
  { key: 'launch', label: 'LAUNCH' },
]

export function CampaignStageRail({
  phase,
  onPhaseChange,
  count,
  stale,
  loading,
  scopeLabel,
}: {
  phase: CampaignBuilderPhase
  onPhaseChange: (phase: CampaignBuilderPhase) => void
  count: number | null
  stale: boolean
  loading: boolean
  /** What the number means at this stage — 'match' on BUILD, 'ready' on REACH. */
  scopeLabel: string
}) {
  const index = STAGES.findIndex((s) => s.key === phase)

  return (
    <nav className="csr" aria-label="Campaign builder stages">
      <div className="csr__stages">
        {STAGES.map((stage, i) => (
          <button
            key={stage.key}
            type="button"
            className={`csr__stage${i === index ? ' is-current' : ''}${i < index ? ' is-done' : ''}`}
            onClick={() => onPhaseChange(stage.key)}
            aria-current={i === index ? 'step' : undefined}
          >
            <span className="csr__dot" aria-hidden="true" />
            <span className="csr__label">{stage.label}</span>
          </button>
        ))}
      </div>

      <div className={`csr__count${stale ? ' is-stale' : ''}${loading ? ' is-loading' : ''}`}>
        <span className="csr__count-value">
          {loading ? '…' : count == null ? '—' : count.toLocaleString()}
        </span>
        {/* "ready" would be a claim about a number we do not have yet. */}
        <span className="csr__count-label">
          {loading ? 'counting' : count == null ? 'not counted' : stale ? 'stale' : scopeLabel}
        </span>
      </div>
    </nav>
  )
}
