/**
 * CopilotReasoning — Elegant collapsed-by-default reasoning row.
 *
 * Shows a small "Reasoning" row with a pulse dot during thinking states.
 * Expands to show structured intent details + recent trace events.
 */

import { useState, useEffect } from 'react'
import type { CopilotState, ResolvedIntent, TraceEvent } from './copilot-state'

interface CopilotReasoningProps {
  state: CopilotState
  livePreview: ResolvedIntent | null
  pendingIntent: ResolvedIntent | null
  trace: TraceEvent[]
}

const thinkingStates = new Set<CopilotState>([
  'understanding', 'searching', 'analyzing', 'planning', 'drafting',
])

export function CopilotReasoning({ state, livePreview, pendingIntent, trace }: CopilotReasoningProps) {
  const [expanded, setExpanded] = useState(false)
  const isThinking = thinkingStates.has(state)
  const intent = pendingIntent ?? livePreview
  const recentTrace = trace.slice(0, 5)

  // Auto-collapse when idle
  useEffect(() => {
    if (state === 'idle' || state === 'greeting') setExpanded(false)
  }, [state])

  if (!isThinking && !expanded && !intent) return null

  return (
    <div className={`co-reason ${expanded ? 'is-open' : ''} ${isThinking ? 'is-thinking' : ''}`}>
      <button type="button" className="co-reason__bar" onClick={() => setExpanded((v) => !v)}>
        <span className="co-reason__dot" />
        <span className="co-reason__label">
          {isThinking ? 'Reasoning' : intent ? 'Reasoning' : 'Activity'}
        </span>
        <svg className="co-reason__caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <div className="co-reason__body">
          {intent && (
            <dl className="co-reason__dl">
              <div className="co-reason__field">
                <dt>Intent</dt>
                <dd>{intent.domain}.{intent.action}</dd>
              </div>
              <div className="co-reason__field">
                <dt>Confidence</dt>
                <dd>{Math.round(intent.confidence)}%</dd>
              </div>
              {intent.params.target && (
                <div className="co-reason__field">
                  <dt>Target</dt>
                  <dd>{intent.params.target}</dd>
                </div>
              )}
              <div className="co-reason__field">
                <dt>Preview</dt>
                <dd>{intent.preview}</dd>
              </div>
            </dl>
          )}

          {recentTrace.length > 0 && (
            <div className="co-reason__trace">
              {recentTrace.map((evt) => (
                <div key={evt.id} className={`co-reason__evt is-${evt.type}`}>
                  <span className="co-reason__evt-label">{evt.label}</span>
                  {evt.detail && <span className="co-reason__evt-detail">{evt.detail}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
