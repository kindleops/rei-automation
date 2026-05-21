/**
 * CopilotCommandSurface — Premium composer dock.
 *
 * Visually the strongest element in the rail. Glowing border on focus,
 * sweep animation while typing, clean parse preview, quick chips.
 */

import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import type {
  CopilotState,
  QuickAction,
  ResolvedIntent,
  SlashCommand,
} from './copilot-state'

interface VoiceControl {
  supported: boolean
  listening: boolean
  toggleListening: () => void
}

interface CopilotComposerProps {
  variant: 'sidecar' | 'deck'
  state: CopilotState
  input: string
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>
  slashHints: SlashCommand[]
  quickActions: QuickAction[]
  livePreview: ResolvedIntent | null
  pendingIntent: ResolvedIntent | null
  voice: VoiceControl
  onInputChange: (value: string) => void
  onInputKeyDown: (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void
  onQuickAction: (qa: QuickAction) => void
  onSubmit: () => void
}

const stateHint: Partial<Record<CopilotState, string>> = {
  understanding: 'Understanding…',
  searching: 'Searching…',
  analyzing: 'Analyzing…',
  planning: 'Planning…',
  drafting: 'Drafting…',
  executing: 'Executing…',
  confirming: 'Awaiting approval',
  listening: 'Listening…',
  transcribing: 'Transcribing…',
}

export function CopilotCommandSurface({
  variant,
  state,
  input,
  inputRef,
  slashHints,
  quickActions,
  livePreview,
  pendingIntent,
  voice,
  onInputChange,
  onInputKeyDown,
  onQuickAction,
  onSubmit,
}: CopilotComposerProps) {
  const hint = stateHint[state]
  const hasInput = input.trim().length > 0
  const maxChips = variant === 'deck' ? 6 : 4
  const isTyping = hasInput
  const isWaiting = !!hint

  return (
    <div className={`co-cmd ${isTyping ? 'is-typing' : ''} ${isWaiting ? 'is-waiting' : ''}`}>
      {/* Parse preview / state hint */}
      {(livePreview || hint) && (
        <div className="co-cmd__preview">
          {hint
            ? <span className="co-cmd__state-hint">{hint}</span>
            : livePreview && (
              <span className="co-cmd__parse">
                <span className="co-cmd__parse-action">{livePreview.domain}.{livePreview.action}</span>
                <span className="co-cmd__parse-conf">{Math.round(livePreview.confidence)}%</span>
              </span>
            )
          }
        </div>
      )}

      {/* Quick chips — only when empty */}
      {quickActions.length > 0 && !hasInput && !hint && (
        <div className="co-cmd__chips">
          {quickActions.slice(0, maxChips).map((qa) => (
            <button key={qa.id} type="button" className="co-cmd__chip" onClick={() => onQuickAction(qa)}>
              {qa.label}
            </button>
          ))}
        </div>
      )}

      {/* Input surface */}
      <div className={`co-cmd__surface ${hasInput ? 'has-input' : ''} ${voice.listening ? 'is-mic' : ''}`}>
        {variant === 'deck' ? (
          <textarea
            ref={inputRef as RefObject<HTMLTextAreaElement>}
            className="co-cmd__input co-cmd__input--multi"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onInputKeyDown as (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void}
            rows={2}
            placeholder="Ask anything or type a command…"
          />
        ) : (
          <input
            ref={inputRef as RefObject<HTMLInputElement>}
            className="co-cmd__input"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onInputKeyDown as (e: ReactKeyboardEvent<HTMLInputElement>) => void}
            placeholder="Ask anything…"
          />
        )}
        <div className="co-cmd__actions">
          {voice.supported && (
            <button
              type="button"
              className={`co-cmd__mic ${voice.listening ? 'is-active' : ''}`}
              onClick={voice.toggleListening}
              aria-label={voice.listening ? 'Stop listening' : 'Voice input'}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className={`co-cmd__send ${hasInput ? 'is-ready' : ''}`}
            onClick={onSubmit}
            disabled={!hasInput}
            aria-label={pendingIntent ? 'Stage command' : 'Send'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" x2="12" y1="19" y2="5" /><polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Slash hints */}
      {slashHints.length > 0 && (
        <div className="co-cmd__slash">
          {slashHints.map((h) => (
            <button
              key={h.command}
              type="button"
              className="co-cmd__slash-item"
              onClick={() => onInputChange(`${h.command} `)}
            >
              <span className="co-cmd__slash-cmd">{h.command}</span>
              <span className="co-cmd__slash-desc">{h.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
