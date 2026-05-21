/**
 * CopilotSidecar — Premium right-side assistant rail.
 *
 * Layout:
 * 1. Slim header  (NEXUS · state | model · perm · voice · ×)
 * 2. Presence     (orb + greeting + context line)
 * 3. Stream       (messages, approvals, reasoning, suggestions)
 * 4. Composer     (pinned input)
 */

import { useEffect, useMemo, useRef } from 'react'
import type { CopilotContext, CopilotState, ResolvedIntent } from './copilot-state'
import { STATE_META } from './copilot-state'
import { CopilotCommandSurface } from './CopilotCommandSurface'
import { CopilotPresence } from './CopilotIntelligenceCore'
import { CopilotStream } from './CopilotStream'
import { CopilotReasoning } from './CopilotReasoning'
import { useCopilotDeck } from './useCopilotDeck'

const STATE_LABEL: Partial<Record<CopilotState, string>> = {
  idle: 'Standing by',
  greeting: 'Standing by',
  listening: 'Listening',
  transcribing: 'Listening',
  speaking: 'Speaking',
  understanding: 'Understanding',
  searching: 'Thinking',
  analyzing: 'Thinking',
  planning: 'Thinking',
  drafting: 'Thinking',
  executing: 'Executing',
  confirming: 'Awaiting approval',
  completed: 'Complete',
  error: 'Error',
}

interface CopilotSidecarProps {
  open: boolean
  context: CopilotContext
  onClose: () => void
  onAction: (intent: ResolvedIntent) => void
  onPresenceChange?: (state: CopilotState, amplitude: number) => void
}

export function CopilotSidecar({ open, context, onClose, onAction, onPresenceChange }: CopilotSidecarProps) {
  const deck = useCopilotDeck({ open, context, onAction, surface: 'sidecar' })
  const railRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const amp = deck.voice.listening ? deck.voice.amplitude : (deck.copilotState === 'speaking' ? 0.5 : 0)
    onPresenceChange?.(deck.copilotState, amp)
  }, [deck.copilotState, deck.voice.amplitude, deck.voice.listening, onPresenceChange])

  // Listen for global voice activation (⌘/Ctrl+V) and toggle deck voice
  useEffect(() => {
    const handler = () => {
      if (deck.voice && typeof deck.voice.toggleListening === 'function') {
        deck.voice.toggleListening()
      }
    }
    window.addEventListener('nx:copilot-voice-activate', handler)
    return () => window.removeEventListener('nx:copilot-voice-activate', handler)
  }, [deck.voice])

  // Broadcast transcripts (interim + final) so floating orb can display text overlays
  useEffect(() => {
    if (!deck.voice) return
    const detail = { transcript: deck.voice.transcript, interim: deck.voice.interimTranscript, state: deck.copilotState }
    window.dispatchEvent(new CustomEvent('nx:copilot-voice-text', { detail }))
  }, [deck.voice.transcript, deck.voice.interimTranscript, deck.copilotState])

  const meta = STATE_META[deck.copilotState]

  const greeting = useMemo(() => {
    const first = deck.messages.find((m) => m.role === 'copilot')
    return first?.text
  }, [deck.messages])

  const contextLine = useMemo(() => {
    return deck.helperText !== meta.helper ? deck.helperText : undefined
  }, [deck.helperText, meta.helper])

  if (!open) return null

  const stateLabel = STATE_LABEL[deck.copilotState] ?? 'Standing by'
  const isActive = deck.copilotState !== 'idle' && deck.copilotState !== 'greeting'

  return (
    <aside ref={railRef} className={`co-rail ${isActive ? 'is-active' : ''} ${meta.accentClass}`} aria-label="Copilot">
      {/* 1 ── Slim header */}
      <header className="co-rail__head">
        <div className="co-rail__id">
          <span className="co-rail__name">{deck.settings.assistantName || 'NEXUS'}</span>
          <span className={`co-rail__state is-${deck.copilotState}`}>{stateLabel}</span>
        </div>
        <div className="co-rail__controls">
          <span className="co-rail__meta">{deck.model.label}</span>
          <span className="co-rail__meta">{deck.permissionMeta.label}</span>
          {deck.voice.supported && (
            <button
              type="button"
              className={`co-rail__icon-btn ${deck.voice.listening ? 'is-active' : ''}`}
              onClick={deck.voice.toggleListening}
              aria-label={deck.voice.listening ? 'Stop listening' : 'Voice'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            </button>
          )}
          <button type="button" className="co-rail__icon-btn" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" x2="6" y1="6" y2="18" /><line x1="6" x2="18" y1="6" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      {/* 2 ── Presence */}
      <CopilotPresence
        state={deck.copilotState}
        amplitude={deck.voice.listening ? deck.voice.amplitude : 0}
        greeting={greeting}
        contextLine={contextLine}
        compact
      />

      {/* 3 ── Stream + reasoning */}
      <div className="co-rail__body">
        <CopilotReasoning
          state={deck.copilotState}
          livePreview={deck.livePreview}
          pendingIntent={deck.pendingIntent}
          trace={deck.trace}
        />

        <CopilotStream
          messages={deck.recentMessages}
          pendingIntent={deck.pendingIntent}
          livePreview={deck.livePreview}
          planSteps={deck.planSteps}
          suggestions={deck.suggestions}
          onConfirm={deck.confirmIntent}
          onReject={deck.rejectIntent}
          onSuggestion={deck.handleSuggestionAction}
          variant="sidecar"
        />
      </div>

      {/* 4 ── Composer */}
      <CopilotCommandSurface
        variant="sidecar"
        state={deck.copilotState}
        input={deck.input}
        inputRef={deck.inputRef}
        slashHints={deck.slashHints}
        quickActions={deck.quickActions}
        livePreview={deck.livePreview}
        pendingIntent={deck.pendingIntent}
        voice={deck.voice}
        onInputChange={deck.setInput}
        onInputKeyDown={deck.handleInputKeyDown}
        onQuickAction={(qa) => deck.handleSubmit(qa.intent.raw)}
        onSubmit={() => deck.handleSubmit()}
      />
    </aside>
  )
}

export type { CopilotContext } from './copilot-state'
