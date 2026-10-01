import { LCButton } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import type { ComposerPhase } from './composer-phase'

/**
 * The composer's one automation signal (desktop). Rendered only for a phase
 * other than `resting`. Copy is the product's: "Automation is replying…",
 * "Response queued ✓", "NEEDS YOUR REVIEW", "SEND FAILED".
 */
export function ComposerPhaseLine({ phase, onRetry }: { phase: ComposerPhase; onRetry?: () => void }) {
  if (phase.kind === 'processing') {
    return (
      <div className="nx-composer-phase" data-phase="processing" role="status" aria-live="polite">
        <span className="nx-composer-phase__dots" aria-hidden="true"><i /><i /><i /></span>
        <span>Automation is replying…</span>
      </div>
    )
  }
  if (phase.kind === 'queued') {
    return (
      <div className="nx-composer-phase" data-phase="queued" role="status" aria-live="polite">
        <Icon name="check" size={13} aria-hidden="true" />
        <span>Response queued</span>
        {phase.detail ? <span className="nx-composer-phase__detail">· {phase.detail}</span> : null}
      </div>
    )
  }
  if (phase.kind === 'held') {
    return (
      <div className="nx-composer-phase" data-phase="held" role="status" aria-live="polite">
        <span className="nx-composer-phase__eyebrow">Needs your review</span>
        {phase.detail ? <span className="nx-composer-phase__detail">{phase.detail}</span> : null}
      </div>
    )
  }
  if (phase.kind === 'failed') {
    return (
      <div className="nx-composer-phase" data-phase="failed" role="alert">
        <span className="nx-composer-phase__eyebrow">Send failed</span>
        {phase.detail ? <span className="nx-composer-phase__detail">{phase.detail}</span> : null}
        {phase.canRetry && onRetry ? (
          <LCButton variant="quiet" size="sm" icon="refresh-cw" className="nx-composer-phase__retry" onClick={onRetry}>
            Retry
          </LCButton>
        ) : null}
      </div>
    )
  }
  return null
}
