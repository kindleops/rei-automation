import { Icon } from '../../../shared/icons'
import { LCButton, cx } from '../../../shared/lc'
import type { WfAssignment } from '../api/wf-types'
import { DECISION_SCOPE_NOTE, DECISION_SCOPE_TERSE, decisionFailureText, decisionHint, decisionOptions, type DecisionState } from '../model/wf-decisions'
import { useWfNav } from './wf-context'

/**
 * The CEO's decision buttons for one queued item, with its live state:
 * recording (optimistic, buttons locked), failed (the reason + retry). A
 * recorded item leaves the open list and shows as a WfDecisionRecorded line.
 */
export function WfDecideBar({ a, state, onDecide, compact, terse }: { a: WfAssignment; state: DecisionState | null; onDecide: (a: WfAssignment, d: 'approve' | 'decline' | 'done') => void; compact?: boolean; terse?: boolean }) {
  const nav = useWfNav()
  const options = decisionOptions(a, nav.employees)
  if (!options) return null
  const busy = state?.phase === 'recording'
  return (
    <div className={cx('wf-decide', compact && 'is-compact', busy && 'is-busy', state?.phase === 'failed' && 'is-failed')}>
      <div className="wf-decide__btns" role="group" aria-label="Your decision">
        {options.map((o) => (
          <LCButton
            key={o.decision}
            size="sm"
            variant={o.primary ? 'secondary' : 'quiet'}
            disabled={busy}
            loading={busy && state?.decision === o.decision}
            title={decisionHint(o.decision, a)}
            onClick={() => onDecide(a, o.decision)}
          >
            {o.label}
          </LCButton>
        ))}
      </div>
      {state?.phase === 'failed' && state.failure ? (
        <p className="wf-decide__fail" role="alert"><Icon name="alert" size={11} />{decisionFailureText(state.failure)}</p>
      ) : (
        <p className="wf-decide__note">{busy ? 'Recording your decision' : terse ? DECISION_SCOPE_TERSE : DECISION_SCOPE_NOTE}</p>
      )}
    </div>
  )
}

/** A recorded decision: the server's own words about what happened (and what did not). */
export function WfDecisionRecorded({ s, onDismiss }: { s: DecisionState; onDismiss: () => void }) {
  const label = s.decision === 'approve' ? 'Approved' : s.decision === 'decline' ? 'Declined' : 'Done'
  return (
    <li className="wf-recorded" data-decision={s.decision}>
      <div className="wf-recorded__h">
        <Icon name="check" size={12} />
        <span className="wf-recorded__k">{label}{s.replayed ? ' (already recorded)' : ''}</span>
        <button type="button" className="wf-recorded__x" aria-label="Dismiss" onClick={onDismiss}><Icon name="x" size={11} /></button>
      </div>
      <p className="wf-recorded__m">{s.message}</p>
    </li>
  )
}
