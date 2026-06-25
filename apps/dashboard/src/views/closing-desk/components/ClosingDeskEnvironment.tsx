import { useState } from 'react'
import type { ClosingDeskSurfaceState } from '../closing-desk-state'

export interface ClosingDeskEnvironmentProps {
  surfaceState: ClosingDeskSurfaceState
  degradedNotes: string[]
  diagnostics: string[]
}

export function ClosingDeskEnvironment({ surfaceState, degradedNotes, diagnostics }: ClosingDeskEnvironmentProps) {
  const [expanded, setExpanded] = useState(false)

  if (surfaceState === 'demo') {
    return (
      <div className="cd-env cd-env--demo" data-testid="cd-env-demo" role="status">
        <div className="cd-env__main">
          <span className="cd-env__pill">Synthetic Demo Data</span>
          <span className="cd-env__copy">Fixture portfolio for layout and workflow QA — not a live closing book.</span>
          <button type="button" className="cd-env__toggle" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            {expanded ? 'Hide details' : 'Details'}
          </button>
        </div>
        {expanded ? (
          <p className="cd-env__detail">{diagnostics[0] ?? 'All cases are synthetic fixtures with provenance identity=fixture.'}</p>
        ) : null}
      </div>
    )
  }

  if (surfaceState === 'degraded' || surfaceState === 'zero') {
    const lead = degradedNotes[0] ?? diagnostics[0]
    return (
      <div className={`cd-env cd-env--${surfaceState}`} data-testid="cd-env-degraded" role="status">
        <span className="cd-env__pill">{surfaceState === 'zero' ? 'Zero-state' : 'Projection gap'}</span>
        <span className="cd-env__copy">{lead}</span>
      </div>
    )
  }

  return null
}