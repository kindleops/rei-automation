/**
 * CopilotStream — Premium activity conversation.
 *
 * Renders: operator messages, assistant replies, system action cards,
 * approval cards (Approve / Hold / Edit), execution steps, suggestions.
 * Clean hierarchy — no debug noise.
 */

import { useRef, useEffect } from 'react'
import type {
  ConversationMessage,
  CopilotSuggestion,
  PlanStep,
  ResolvedIntent,
} from './copilot-state'

interface CopilotStreamProps {
  messages: ConversationMessage[]
  pendingIntent: ResolvedIntent | null
  livePreview: ResolvedIntent | null
  planSteps: PlanStep[]
  suggestions: CopilotSuggestion[]
  onConfirm: () => void
  onReject: () => void
  onSuggestion: (s: CopilotSuggestion) => void
  variant: 'sidecar' | 'deck'
}

export function CopilotStream({
  messages,
  pendingIntent,
  livePreview,
  planSteps,
  suggestions,
  onConfirm,
  onReject,
  onSuggestion,
  variant,
}: CopilotStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages.length, pendingIntent])

  const maxSuggestions = variant === 'deck' ? 4 : 3
  const activeSteps = planSteps.filter((s) => s.status === 'active' || s.status === 'done')

  return (
    <div className="co-activity" ref={scrollRef}>
      {/* Empty state */}
      {messages.length === 0 && !pendingIntent && suggestions.length === 0 && (
        <p className="co-activity__empty">Ask anything to get started.</p>
      )}

      {/* Suggestions — near top when idle */}
      {suggestions.length > 0 && messages.length < 2 && (
        <div className="co-activity__suggestions">
          {suggestions.slice(0, maxSuggestions).map((s) => (
            <button key={s.id} type="button" className="co-activity__sug" onClick={() => onSuggestion(s)}>
              <span className="co-activity__sug-title">{s.title}</span>
              {s.detail && <span className="co-activity__sug-sub">{s.detail}</span>}
            </button>
          ))}
        </div>
      )}

      {/* Messages */}
      {[...messages].reverse().map((msg) => (
        <div key={msg.id} className={`co-activity__msg co-activity__msg--${msg.role}`}>
          {msg.role === 'copilot' && <span className="co-activity__author">Copilot</span>}
          {msg.role === 'system' && <span className="co-activity__author co-activity__author--sys">System</span>}
          <p className="co-activity__text">{msg.text}</p>
        </div>
      ))}

      {/* Active plan steps — inline */}
      {activeSteps.length > 0 && (
        <div className="co-activity__steps">
          {activeSteps.map((step) => (
            <div key={step.id} className={`co-activity__step is-${step.status}`}>
              <span className="co-activity__step-dot" />
              <span>{step.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Live parse — subtle */}
      {livePreview && !pendingIntent && (
        <div className="co-activity__parse">
          <span>{livePreview.domain}.{livePreview.action}</span>
          <span className="co-activity__parse-conf">{Math.round(livePreview.confidence)}%</span>
        </div>
      )}

      {/* Approval card — premium, compact */}
      {pendingIntent && (
        <div className="co-activity__approval">
          <div className="co-activity__approval-head">
            <span className="co-activity__approval-tag">Approval Required</span>
            <span className="co-activity__approval-conf">{Math.round(pendingIntent.confidence)}%</span>
          </div>
          <div className="co-activity__approval-body">
            <span className="co-activity__approval-action">{pendingIntent.domain}.{pendingIntent.action}</span>
            <p className="co-activity__approval-preview">{pendingIntent.preview}</p>
            {pendingIntent.params.target && (
              <span className="co-activity__approval-target">{pendingIntent.params.target}</span>
            )}
          </div>
          <div className="co-activity__approval-row">
            <button type="button" className="co-activity__btn co-activity__btn--approve" onClick={onConfirm}>Approve</button>
            <button type="button" className="co-activity__btn co-activity__btn--hold" onClick={onReject}>Hold</button>
            <button type="button" className="co-activity__btn co-activity__btn--edit" onClick={onReject}>Edit</button>
          </div>
        </div>
      )}
    </div>
  )
}
