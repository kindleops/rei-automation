import { useRef, useState, useEffect, useCallback } from 'react'
import { Icon } from '../../../shared/icons'
import { TemplatePopover, type TemplateActionPayload } from './TemplatePopover'
import type { InboxThread } from '../inbox.adapter'
import type { ThreadContext } from '../../../lib/data/inboxData'
import type { CommandSuggestion } from '../ai-command-center'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

type IconName = Parameters<typeof Icon>[0]['name']

// ── Quick template presets ──────────────────────────────────────────────────
const QUICK_TEMPLATES: Array<{ id: string; label: string; text: string }> = [
  { id: 'ownership_check', label: 'Ownership Check', text: 'Hi, are you still the owner of this property?' },
  { id: 'investor_intro', label: 'Local Investor Intro', text: "I'm a local investor interested in making you an offer — no agents, no commissions." },
  { id: 'asking_price', label: 'Asking Price', text: 'What price did you have in mind for the property?' },
  { id: 'condition_probe', label: 'Condition Probe', text: 'How would you describe the current condition of the property?' },
  { id: 'motivation_probe', label: 'Motivation Probe', text: 'What situation would make you consider selling?' },
  { id: 'soft_close', label: 'Soft Close', text: "I can put together a quick offer — no commissions, no obligation. Interested?" },
  { id: 'follow_up', label: 'Follow-Up', text: 'Just following up on my previous message. Still open to a quick conversation?' },
  { id: 'not_interested', label: 'Not Interested Response', text: "Completely understood — I'll remove you from my outreach list. No further contact." },
  { id: 'wrong_number', label: 'Wrong Number Response', text: "My apologies for the confusion. Removing this number from my list right away." },
  { id: 'dnc_safe', label: 'DNC Safe Response', text: "Understood — you've been removed from all future outreach. Sorry for the inconvenience." },
]

const QUICK_ACTIONS: Array<{ id: string; label: string; icon: IconName; ready: boolean; action?: string }> = [
  { id: 'browse_templates', label: 'Browse Templates', icon: 'file-text', ready: true },
  { id: 'rewrite_draft', label: 'Rewrite Draft', icon: 'spark', ready: false },
  { id: 'change_tone', label: 'Change Tone', icon: 'spark', ready: false },
  { id: 'summarize_thread', label: 'Summarize Thread', icon: 'spark', ready: false },
  { id: 'offer_language', label: 'Generate Offer Language', icon: 'zap', ready: false },
  { id: 'add_note', label: 'Add Internal Note', icon: 'file-text', ready: true, action: 'add_note' },
  { id: 'mark_hot', label: 'Mark Hot', icon: 'zap', ready: true, action: 'mark_hot' },
  { id: 'mark_reviewed', label: 'Mark Reviewed', icon: 'check', ready: true, action: 'mark_reviewed' },
]

interface ComposerProps {
  // Parent pushes values into Composer via this prop (translation results, template inserts, clear-after-send).
  // Typing updates localDraft only — parent never re-renders on each keystroke.
  draftText: string
  onSend: (text: string) => void
  // Receives current draft so parent can set schedule payload without tracking it.
  onOpenSchedule: (currentDraft: string) => void
  onAI: () => void
  thread: InboxThread | null
  threadContext: ThreadContext | null
  onSendTemplate: (payload: TemplateActionPayload) => void
  onQueueTemplate: (payload: TemplateActionPayload) => void
  onScheduleTemplate: (payload: TemplateActionPayload) => void
  onQuickAction?: (action: string) => void
  isSending?: boolean
  disabled?: boolean
  disabledReason?: string
  aiSuggestions?: CommandSuggestion[]
  // Translate
  sellerLanguageLabel?: string
  isSellerLanguageEnglish?: boolean
  isTranslatingDraft?: boolean
  onTranslateDraft?: (text: string) => void
  // When true, auto-translate fires after 2s of typing inactivity.
  autoTranslateDraft?: boolean
}

type SpeechRecognitionResultLike = {
  isFinal: boolean
  0: { transcript: string }
}

type SpeechRecognitionEventLike = {
  results: { length: number; [index: number]: SpeechRecognitionResultLike }
}

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike
type MicState = 'idle' | 'recording' | 'processing'

const getSpeechRecognition = (): SpeechRecognitionConstructor | null => {
  const w = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const Composer = ({
  draftText,
  onSend,
  onOpenSchedule,
  onAI: _onAI,
  thread,
  threadContext,
  onSendTemplate,
  onQueueTemplate,
  onScheduleTemplate,
  onQuickAction,
  isSending = false,
  disabled = false,
  disabledReason,
  aiSuggestions = [],
  sellerLanguageLabel = 'Unknown',
  isSellerLanguageEnglish = true,
  isTranslatingDraft = false,
  onTranslateDraft,
  autoTranslateDraft = false,
}: ComposerProps) => {
  const [localDraft, setLocalDraft] = useState(draftText)
  const [micState, setMicState] = useState<MicState>('idle')
  const [voiceUnsupported, setVoiceUnsupported] = useState(false)
  const [quickActionsOpen, setQuickActionsOpen] = useState(false)
  const [templatePopoverOpen, setTemplatePopoverOpen] = useState(false)
  const [voiceLevel, setVoiceLevel] = useState(0)
  const [transcription, setTranscription] = useState('')
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const baseDraftRef = useRef('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animationFrameRef = useRef<number | undefined>(undefined)
  // Tracks the last value we pushed to onTranslateDraft to prevent re-triggering.
  const lastAutoTranslatedDraftRef = useRef<string>('')

  const isListening = micState === 'recording'
  const isProcessing = micState === 'processing'
  const hasDraft = localDraft.trim().length > 0
  const composerDisabled = disabled || isSending

  // Sync: parent pushes new text (translation result, template insert, post-send clear) → update localDraft.
  // Mark the pushed text as already-translated so auto-translate doesn't fire on it.
  useEffect(() => {
    setLocalDraft(draftText)
    lastAutoTranslatedDraftRef.current = draftText
  }, [draftText])

  useEffect(() => {
    setQuickActionsOpen(false)
  }, [thread?.id])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
  }, [localDraft])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea || composerDisabled) return
    textarea.focus({ preventScroll: true })
  }, [thread?.id, composerDisabled])

  // Auto-translate: fires 2s after typing stops when seller language is known non-English.
  useEffect(() => {
    const trimmed = localDraft.trim()
    if (!autoTranslateDraft || !trimmed || isTranslatingDraft) return
    if (trimmed === lastAutoTranslatedDraftRef.current) return
    const timer = setTimeout(() => { onTranslateDraft?.(localDraft) }, 2000)
    return () => clearTimeout(timer)
  }, [localDraft, autoTranslateDraft, isTranslatingDraft, onTranslateDraft])

  const stopVoiceAnalysis = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = undefined
    }
    analyserRef.current = null
    setVoiceLevel(0)
  }

  const startVoiceAnalysis = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const audioContext = new AudioContext()
      const analyser = audioContext.createAnalyser()
      const microphone = audioContext.createMediaStreamSource(stream)
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.8
      microphone.connect(analyser)
      analyserRef.current = analyser
      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const updateVoiceLevel = () => {
        if (!analyserRef.current) return
        analyserRef.current.getByteFrequencyData(dataArray)
        const average = dataArray.reduce((sum, v) => sum + v, 0) / dataArray.length
        setVoiceLevel(Math.min(average / 128, 1))
        animationFrameRef.current = requestAnimationFrame(updateVoiceLevel)
      }
      updateVoiceLevel()
    } catch (error) {
      console.warn('Could not start voice analysis:', error)
    }
  }

  const stopVoice = () => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setMicState('idle')
    stopVoiceAnalysis()
    setTranscription('')
  }

  const toggleVoice = () => {
    if (disabled) return
    if (isListening || isProcessing) { stopVoice(); return }
    const Recognition = getSpeechRecognition()
    if (!Recognition) { setVoiceUnsupported(true); return }
    const recognition = new Recognition()
    baseDraftRef.current = localDraft.trim()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'
    recognition.onresult = (event) => {
      const parts: string[] = []
      for (let i = 0; i < event.results.length; i++) parts.push(event.results[i][0].transcript.trim())
      const current = parts.join(' ').trim()
      setTranscription(current)
      const cleaned = current
        .replace(/\bi\b/g, 'I')
        .replace(/(\w)\s*([.!?])/g, '$1$2')
        .replace(/([.!?])\s*(\w)/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim()
      setLocalDraft([baseDraftRef.current, cleaned].filter(Boolean).join(' ').trim())
    }
    recognition.onerror = () => {
      recognitionRef.current = null
      setMicState('idle')
      stopVoiceAnalysis()
      setTranscription('')
    }
    recognition.onend = () => {
      recognitionRef.current = null
      setMicState('processing')
      stopVoiceAnalysis()
      setTranscription('')
      setTimeout(() => setMicState('idle'), 600)
    }
    recognitionRef.current = recognition
    recognition.start()
    setVoiceUnsupported(false)
    setMicState('recording')
    startVoiceAnalysis()
  }

  const submitDraft = useCallback(() => {
    if (composerDisabled || !hasDraft) return
    onSend(localDraft)
    setLocalDraft('')
  }, [composerDisabled, hasDraft, localDraft, onSend])

  const handleInsertTemplate = useCallback((text: string) => {
    setLocalDraft(prev => prev.trim() ? `${prev.trim()}\n\n${text}` : text)
  }, [])

  const handleReplaceTemplate = useCallback((text: string) => {
    setLocalDraft(text)
  }, [])

  const micTitle = voiceUnsupported
    ? 'Voice dictation not supported'
    : isProcessing ? 'Processing…' : isListening ? 'Stop recording' : 'Talk to type'

  return (
    <div className={cls('nx-sticky-composer', isTranslatingDraft && 'is-translating-draft')}>

      {/* ── Quick Actions Popover ─────────────────────────────────── */}
      {quickActionsOpen && (
        <div className="nx-quick-actions-popover" role="dialog" aria-label="Templates and quick actions">
          <div className="nx-qap-header">
            <span className="nx-qap-title">Templates &amp; Actions</span>
            <button type="button" className="nx-qap-close" onClick={() => setQuickActionsOpen(false)} aria-label="Close">
              <Icon name="x" />
            </button>
          </div>

          <div className="nx-qap-section">
            <div className="nx-qap-section-label">Quick Templates</div>
            <div className="nx-qap-templates">
              {QUICK_TEMPLATES.map(t => (
                <button
                  key={t.id}
                  type="button"
                  className="nx-qap-template-btn"
                  onClick={() => { setLocalDraft(t.text); setQuickActionsOpen(false) }}
                  title={t.text}
                >
                  <Icon name="file-text" />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="nx-qap-divider" />

          <div className="nx-qap-section">
            <div className="nx-qap-section-label">Quick Actions</div>
            <div className="nx-qap-actions">
              {QUICK_ACTIONS.map(a => {
                if (a.id === 'browse_templates') {
                  return (
                    <button key={a.id} type="button" className="nx-qap-action-btn" onClick={() => { setQuickActionsOpen(false); setTemplatePopoverOpen(true) }}>
                      <Icon name={a.icon} /><span>{a.label}</span>
                    </button>
                  )
                }
                if (!a.ready) {
                  return (
                    <button key={a.id} type="button" className="nx-qap-action-btn is-not-ready" disabled title="Coming soon">
                      <Icon name={a.icon} /><span>{a.label}</span><span className="nx-qap-badge">Soon</span>
                    </button>
                  )
                }
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={cls('nx-qap-action-btn', a.id === 'mark_hot' && 'is-hot')}
                    onClick={() => { if (a.action) onQuickAction?.(a.action); setQuickActionsOpen(false) }}
                  >
                    <Icon name={a.icon} /><span>{a.label}</span>
                  </button>
                )
              })}
              {!disabled && (
                <button type="button" className="nx-qap-action-btn is-danger" onClick={() => { onQuickAction?.('suppress'); setQuickActionsOpen(false) }}>
                  <Icon name="slash" /><span>Suppress / DNC</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Adaptive suggestion chips ─────────────────────────────── */}
      {aiSuggestions.length > 0 && (
        <div className="nx-composer-ai-suggestions">
          {aiSuggestions.slice(0, 3).map((s) => (
            <button
              key={s.id}
              type="button"
              className={cls('nx-composer-ai-chip', s.tone && `is-${s.tone}`)}
              onClick={() => setLocalDraft(s.text)}
              disabled={composerDisabled}
              title={s.label}
            >
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Main input area ──────────────────────────────────────────
          [cmd] [textarea] [globe?] [cal] [mic] [send]
      ──────────────────────────────────────────────────────────────── */}
      <div
        className={cls('nx-composer-input-area inbox-center-width', isListening && 'is-listening')}
        aria-disabled={composerDisabled}
      >
        {/* LEFT: Templates & Quick Actions */}
        <button
          type="button"
          className={cls('nx-composer-icon-btn nx-composer-cmd-btn', quickActionsOpen && 'is-active')}
          title="Templates & Quick Actions"
          onClick={() => setQuickActionsOpen(prev => !prev)}
          aria-label="Open templates and quick actions"
          aria-expanded={quickActionsOpen}
        >
          <Icon name="command" />
        </button>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          placeholder={disabled ? (disabledReason ?? 'Messaging disabled for this thread') : 'Type a message…'}
          value={localDraft}
          onChange={e => setLocalDraft(e.target.value)}
          rows={1}
          disabled={composerDisabled}
          onKeyDown={e => {
            if (composerDisabled) return
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitDraft(); return }
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && localDraft.trim()) { e.preventDefault(); submitDraft() }
          }}
          onInput={(e) => {
            const el = e.target as HTMLTextAreaElement
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, 200)}px`
          }}
        />

        {/* Globe — translate draft to seller language (always visible) */}
        <button
          type="button"
          className={cls(
            'nx-composer-icon-btn nx-translate-globe-btn',
            isTranslatingDraft && 'is-spinning',
            isSellerLanguageEnglish && 'is-english-confirmed',
          )}
          title={isTranslatingDraft ? 'Translating…' : (
            !isSellerLanguageEnglish && sellerLanguageLabel && sellerLanguageLabel !== 'Unknown'
              ? `Translate to ${sellerLanguageLabel}`
              : 'Translate draft'
          )}
          disabled={composerDisabled || !hasDraft || isTranslatingDraft}
          onClick={() => onTranslateDraft?.(localDraft)}
          aria-label="Translate draft"
        >
          <Icon name="globe" />
        </button>

        {/* Calendar */}
        <button
          type="button"
          className="nx-composer-icon-btn nx-calendar-btn"
          title="Schedule message"
          disabled={composerDisabled}
          onClick={() => onOpenSchedule(localDraft)}
          aria-label="Schedule message"
        >
          <Icon name="calendar" />
        </button>

        {/* Mic */}
        <button
          type="button"
          className={cls('nx-composer-icon-btn nx-voice-button', isListening && 'is-listening', isProcessing && 'is-processing')}
          title={micTitle}
          disabled={composerDisabled}
          onClick={toggleVoice}
          aria-pressed={isListening}
          aria-label={micTitle}
        >
          {isListening && <span className="nx-voice-rings" aria-hidden="true"><i /><i /><i /></span>}
          {isListening ? (
            <span className="nx-voice-waveform" aria-hidden="true">
              {Array.from({ length: 5 }, (_, i) => (
                <span
                  key={i}
                  className="nx-voice-waveform-bar"
                  style={{ height: `${Math.max(4, voiceLevel * 22 + 4)}px`, animationDelay: `${i * 0.1}s` }}
                />
              ))}
            </span>
          ) : (
            <Icon name="mic" />
          )}
        </button>

        {/* Send */}
        <button
          type="button"
          className={cls('nx-send-button', hasDraft && !composerDisabled && 'is-ready', isSending && 'is-sending')}
          disabled={composerDisabled || !hasDraft}
          onClick={submitDraft}
          aria-label="Send message"
          title="Send (Enter)"
        >
          {isSending ? <Icon name="activity" style={{ width: 18 }} /> : <Icon name="send" style={{ width: 18 }} />}
        </button>
      </div>

      {/* Live transcription */}
      {isListening && transcription && (
        <div className="nx-voice-transcription">
          <div className="nx-voice-transcription__label"><Icon name="mic" /><span>Listening…</span></div>
          <div className="nx-voice-transcription__text">{transcription}</div>
        </div>
      )}

      {/* Template popover (portal) */}
      <TemplatePopover
        open={templatePopoverOpen}
        onClose={() => setTemplatePopoverOpen(false)}
        thread={thread}
        threadContext={threadContext}
        onInsert={handleInsertTemplate}
        onReplace={handleReplaceTemplate}
        onSendNow={onSendTemplate}
        onQueue={onQueueTemplate}
        onSchedule={onScheduleTemplate}
      />
    </div>
  )
}
