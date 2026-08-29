import { useState } from 'react'

/**
 * The single error-state primitive — constitution §10.
 *
 * §10.1 every error names WHAT FAILED, the OPERATOR IMPACT, and the NEXT STEP.
 *       All three are required props — "Inbox could not load. Retry." cannot be
 *       expressed with this component, which is the point.
 * §10.4 degraded ≠ broken: `severity="degraded"` keeps the surrounding data.
 * §10.5 technical detail lives behind a disclosure, never in the headline.
 * §10.6 retry is always available and shows in-flight state.
 */

export interface ErrorStateProps {
  /** What failed — the headline. e.g. "Comp search did not return". */
  what: string
  /** The operator impact. e.g. "Valuation on this deal is unavailable." */
  impact: string
  /** The next step. e.g. "Retry, or underwrite from the last saved comp set." */
  nextStep: string
  /** `degraded` keeps siblings visible; `blocking` means the surface is dead. */
  severity?: 'degraded' | 'blocking'
  onRetry?: () => void
  retrying?: boolean
  /** Status code, request id, stack — disclosed, never in the headline. */
  detail?: string
  className?: string
}

export const ErrorState = ({
  what,
  impact,
  nextStep,
  severity = 'degraded',
  onRetry,
  retrying = false,
  detail,
  className,
}: ErrorStateProps) => {
  const [showDetail, setShowDetail] = useState(false)

  return (
    <div
      className={[
        'lc-ui',
        'lc-state',
        severity === 'blocking' ? 'lc-state--critical' : 'lc-state--caution',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      role="alert"
      aria-live="assertive"
    >
      <span className="lc-state__eyebrow">
        {severity === 'blocking' ? 'Failed' : 'Partially unavailable'}
      </span>
      <h3 className="lc-state__title">{what}</h3>
      <div className="lc-state__body">
        <p style={{ margin: 0 }}>{impact}</p>
        <p style={{ margin: 0 }}>{nextStep}</p>
      </div>
      <div className="lc-state__actions">
        {onRetry ? (
          <button type="button" className="lc-ui-btn lc-ui-btn--primary" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        ) : null}
        {detail ? (
          <button
            type="button"
            className="lc-ui-btn lc-ui-btn--quiet"
            aria-expanded={showDetail}
            onClick={() => setShowDetail((open) => !open)}
          >
            {showDetail ? 'Hide technical detail' : 'Technical detail'}
          </button>
        ) : null}
      </div>
      {detail && showDetail ? (
        <div className="lc-state__detail">
          <pre>{detail}</pre>
        </div>
      ) : null}
    </div>
  )
}
