import { useRef, useState, useEffect, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { TemplatePopover, type TemplateActionPayload } from './TemplatePopover'
import type { InboxThread } from '../inbox.adapter'
import type { ThreadContext } from '../../../lib/data/inboxData'
import type { CommandSuggestion } from '../ai-command-center'
import {
  buildTemplateContextFromThread,
  getRecommendedTemplates,
  renderTemplate,
  type SmsTemplate,
} from '../../../lib/data/templateData'
import { getBackendBaseUrl, getBackendSecret } from '../../../lib/api/backendClient'
import type { ViewLayoutMode } from '../../../domain/inbox/view-layout'
import { useBreakpoint } from '../../mobile/useBreakpoint'
import { useMobileKeyboardInset } from '../../mobile/useMobileKeyboardInset'


const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

interface ComposerProps {
  draftText: string
  onSend: (text: string) => void
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
  sellerLanguageLabel?: string
  isSellerLanguageEnglish?: boolean
  isTranslatingDraft?: boolean
  onTranslateDraft?: (text: string) => void
  autoTranslateDraft?: boolean
  layoutMode?: ViewLayoutMode
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

interface PolishPreview {
  original: string
  polished: string
}

const getSpeechRecognition = (): SpeechRecognitionConstructor | null => {
  const w = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

const formatRecordingDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export const Composer = ({
  draftText,
  onSend,
  onOpenSchedule,
  onAI,
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
  layoutMode = 'full',
}: ComposerProps) => {
  const { isMobile } = useBreakpoint()
  const keyboardInset = useMobileKeyboardInset(isMobile)
  const [localDraft, setLocalDraft] = useState(draftText)
  const [micState, setMicState] = useState<MicState>('idle')
  const [voiceUnsupported, setVoiceUnsupported] = useState(false)
  const [quickActionsOpen, setQuickActionsOpen] = useState(false)
  const [templatePopoverOpen, setTemplatePopoverOpen] = useState(false)
  const [voiceLevel, setVoiceLevel] = useState(0)
  const [transcription, setTranscription] = useState('')
  const [recommendedTemplates, setRecommendedTemplates] = useState<SmsTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [polishPreview, setPolishPreview] = useState<PolishPreview | null>(null)
  const [isPolishing, setIsPolishing] = useState(false)
  const [polishError, setPolishError] = useState<string | null>(null)
  const [recordingElapsed, setRecordingElapsed] = useState(0)
  const [qapPosition, setQapPosition] = useState<{ left: number; bottom: number } | null>(null)

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const baseDraftRef = useRef('')
  const latestDraftRef = useRef('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const dockRef = useRef<HTMLDivElement | null>(null)
  const quickActionsBtnRef = useRef<HTMLButtonElement | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animationFrameRef = useRef<number | undefined>(undefined)
  const recordingTimerRef = useRef<number | undefined>(undefined)
  const lastAutoTranslatedDraftRef = useRef<string>('')

  const isListening = micState === 'recording'
  const isProcessing = micState === 'processing'
  const hasDraft = localDraft.trim().length > 0
  const composerDisabled = disabled || isSending || isPolishing

  useEffect(() => {
    latestDraftRef.current = localDraft
  }, [localDraft])

  const polishDraftText = useCallback(async (text: string): Promise<string | null> => {
    if (!text.trim()) return null
    setIsPolishing(true)
    setPolishError(null)
    try {
      const res = await fetch(`${getBackendBaseUrl()}/api/cockpit/inbox/polish-draft`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ops-dashboard-secret': getBackendSecret(),
        },
        body: JSON.stringify({ text }),
      })
      const data: { ok: boolean; polishedText: string } = await res.json()
      if (data.ok && data.polishedText?.trim()) {
        return data.polishedText.trim()
      }
      setPolishError('Polish unavailable — using original draft.')
      return null
    } catch {
      setPolishError('Polish unavailable — using original draft.')
      return null
    } finally {
      setIsPolishing(false)
    }
  }, [])

  const runOperatorPolish = useCallback(async () => {
    const text = localDraft.trim()
    if (!text || composerDisabled) return
    const polished = await polishDraftText(text)
    if (polished) {
      setPolishPreview({ original: text, polished })
    }
  }, [composerDisabled, localDraft, polishDraftText])

  useEffect(() => {
    setLocalDraft(draftText)
    lastAutoTranslatedDraftRef.current = draftText
    if (!draftText.trim()) setPolishPreview(null)
  }, [draftText])

  useEffect(() => {
    setQuickActionsOpen(false)
    setPolishPreview(null)
  }, [thread?.id])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
  }, [localDraft])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea || composerDisabled || isMobile) return
    textarea.focus({ preventScroll: true })
  }, [thread?.id, composerDisabled, isMobile])

  useEffect(() => {
    const trimmed = localDraft.trim()
    if (!autoTranslateDraft || !trimmed || isTranslatingDraft || polishPreview) return
    if (trimmed === lastAutoTranslatedDraftRef.current) return
    const timer = setTimeout(() => { onTranslateDraft?.(localDraft) }, 2000)
    return () => clearTimeout(timer)
  }, [localDraft, autoTranslateDraft, isTranslatingDraft, onTranslateDraft, polishPreview])

  useEffect(() => {
    if (!quickActionsOpen || !thread) {
      setRecommendedTemplates([])
      return
    }
    let cancelled = false
    setTemplatesLoading(true)
    void getRecommendedTemplates(thread, threadContext)
      .then((templates) => {
        if (!cancelled) setRecommendedTemplates(templates)
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoading(false)
      })
    return () => { cancelled = true }
  }, [quickActionsOpen, thread, threadContext])

  const updateQuickActionsPosition = useCallback(() => {
    const anchor = quickActionsBtnRef.current ?? dockRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    setQapPosition({ left: Math.max(12, rect.left), bottom: window.innerHeight - rect.top + 8 })
  }, [])

  useLayoutEffect(() => {
    if (!quickActionsOpen) {
      setQapPosition(null)
      return
    }
    updateQuickActionsPosition()
    const onResize = () => updateQuickActionsPosition()
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [quickActionsOpen, updateQuickActionsPosition, layoutMode])

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

  const clearRecordingTimer = () => {
    if (recordingTimerRef.current) {
      window.clearInterval(recordingTimerRef.current)
      recordingTimerRef.current = undefined
    }
    setRecordingElapsed(0)
  }

  const stopVoice = (cancelTranscript = false) => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setMicState('idle')
    stopVoiceAnalysis()
    clearRecordingTimer()
    if (cancelTranscript) {
      setLocalDraft(baseDraftRef.current)
    }
    setTranscription('')
  }

  const startVoice = () => {
    if (disabled) return
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
      const nextDraft = [baseDraftRef.current, cleaned].filter(Boolean).join(' ').trim()
      setLocalDraft(nextDraft)
      latestDraftRef.current = nextDraft
    }
    recognition.onerror = () => {
      recognitionRef.current = null
      setMicState('idle')
      stopVoiceAnalysis()
      clearRecordingTimer()
      setTranscription('')
    }
    recognition.onend = () => {
      recognitionRef.current = null
      setMicState('processing')
      stopVoiceAnalysis()
      clearRecordingTimer()
      setTranscription('')

      const finalDraft = latestDraftRef.current.trim()
      if (!isSellerLanguageEnglish && finalDraft && onTranslateDraft) {
        window.setTimeout(() => onTranslateDraft(finalDraft), 120)
      }

      window.setTimeout(() => setMicState('idle'), 500)
    }

    recognitionRef.current = recognition
    recognition.start()
    setVoiceUnsupported(false)
    setMicState('recording')
    setRecordingElapsed(0)
    recordingTimerRef.current = window.setInterval(() => {
      setRecordingElapsed((value) => value + 1)
    }, 1000)
    void startVoiceAnalysis()
  }

  const toggleVoice = () => {
    if (composerDisabled) return
    if (isListening || isProcessing) {
      stopVoice(false)
      return
    }
    startVoice()
  }

  const submitDraft = useCallback(() => {
    if (composerDisabled || !hasDraft) return
    onSend(localDraft)
    setLocalDraft('')
    setPolishPreview(null)
  }, [composerDisabled, hasDraft, localDraft, onSend])

  const handleInsertTemplate = useCallback((text: string) => {
    setLocalDraft((prev) => (prev.trim() ? `${prev.trim()}\n\n${text}` : text))
    setPolishPreview(null)
  }, [])

  const handleReplaceTemplate = useCallback((text: string) => {
    setLocalDraft(text)
    setPolishPreview(null)
  }, [])

  const insertRenderedTemplate = useCallback((template: SmsTemplate) => {
    const context = buildTemplateContextFromThread(thread, threadContext)
    const { renderedText } = renderTemplate(template, context)
    setLocalDraft(renderedText)
    setPolishPreview(null)
    setQuickActionsOpen(false)
  }, [thread, threadContext])

  const acceptPolish = () => {
    if (!polishPreview) return
    setLocalDraft(polishPreview.polished)
    setPolishPreview(null)
  }

  const undoPolish = () => {
    if (!polishPreview) return
    setLocalDraft(polishPreview.original)
    setPolishPreview(null)
  }

  const regeneratePolish = async () => {
    if (!polishPreview) return
    const polished = await polishDraftText(polishPreview.original)
    if (polished) setPolishPreview({ original: polishPreview.original, polished })
  }

  const quickActionsPortal = quickActionsOpen && qapPosition && typeof document !== 'undefined'
    ? createPortal(
      <>
        <div
          className="nx-qap-backdrop"
          role="presentation"
          onMouseDown={() => setQuickActionsOpen(false)}
        />
        <div
          className="nx-qap-anchor nx-quick-actions-popover"
          role="dialog"
          aria-label="Quick actions"
          style={{ left: qapPosition.left, bottom: qapPosition.bottom }}
        >
          <div className="nx-qap-header">
            <span className="nx-qap-title">Quick Actions</span>
            <button type="button" className="nx-qap-close" onClick={() => setQuickActionsOpen(false)} aria-label="Close">
              <Icon name="x" />
            </button>
          </div>

          <div className="nx-qap-section">
            <div className="nx-qap-section-label">Templates</div>
            <div className="nx-qap-templates">
              {templatesLoading && (
                <button type="button" className="nx-qap-template-btn" disabled>
                  <Icon name="activity" /><span>Loading templates…</span>
                </button>
              )}
              {!templatesLoading && recommendedTemplates.length === 0 && (
                <button type="button" className="nx-qap-template-btn" disabled>
                  <Icon name="file-text" /><span>No templates for this thread</span>
                </button>
              )}
              {recommendedTemplates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="nx-qap-template-btn"
                  onClick={() => insertRenderedTemplate(template)}
                  title={template.templateText}
                >
                  <Icon name="file-text" />
                  <span>{template.useCase || template.useCaseSlug}</span>
                </button>
              ))}
              <button
                type="button"
                className="nx-qap-template-btn"
                onClick={() => { setQuickActionsOpen(false); setTemplatePopoverOpen(true) }}
              >
                <Icon name="search" /><span>Browse all templates</span>
              </button>
            </div>
          </div>

          <div className="nx-qap-divider" />

          <div className="nx-qap-section">
            <div className="nx-qap-section-label">Writing tools</div>
            <div className="nx-qap-actions">
              <button
                type="button"
                className="nx-qap-action-btn"
                disabled={composerDisabled || !hasDraft || isPolishing}
                onClick={() => { void runOperatorPolish(); setQuickActionsOpen(false) }}
              >
                <Icon name="spark" /><span>Operator Polish</span>
              </button>
              {aiSuggestions.slice(0, 3).map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className={cls('nx-qap-action-btn', suggestion.tone && `is-${suggestion.tone}`)}
                  disabled={composerDisabled || !suggestion.text}
                  onClick={() => {
                    if (suggestion.text) setLocalDraft(suggestion.text)
                    if (suggestion.id === 'ai_assist') onAI()
                    setQuickActionsOpen(false)
                  }}
                >
                  <Icon name="spark" /><span>{suggestion.label}</span>
                </button>
              ))}
              <button
                type="button"
                className="nx-qap-action-btn"
                disabled={composerDisabled || !hasDraft || isTranslatingDraft}
                onClick={() => { onTranslateDraft?.(localDraft); setQuickActionsOpen(false) }}
              >
                <Icon name="globe" /><span>Translate Draft</span>
              </button>
            </div>
          </div>

          <div className="nx-qap-divider" />

          <div className="nx-qap-section">
            <div className="nx-qap-section-label">Message actions</div>
            <div className="nx-qap-actions">
              <button
                type="button"
                className="nx-qap-action-btn"
                disabled={composerDisabled}
                onClick={() => { onOpenSchedule(localDraft); setQuickActionsOpen(false) }}
              >
                <Icon name="calendar" /><span>Schedule Message</span>
              </button>
              <button type="button" className="nx-qap-action-btn is-not-ready" disabled title="Coming soon">
                <Icon name="paperclip" /><span>Attachment</span><span className="nx-qap-badge">Soon</span>
              </button>
              <button
                type="button"
                className="nx-qap-action-btn"
                onClick={() => { onQuickAction?.('add_note'); setQuickActionsOpen(false) }}
              >
                <Icon name="file-text" /><span>Internal Note</span>
              </button>
              <button
                type="button"
                className="nx-qap-action-btn"
                onClick={() => { onQuickAction?.('snooze'); setQuickActionsOpen(false) }}
              >
                <Icon name="clock" /><span>Follow-Up</span>
              </button>
              <button
                type="button"
                className="nx-qap-action-btn"
                onClick={() => { onQuickAction?.('open_property'); setQuickActionsOpen(false) }}
              >
                <Icon name="zap" /><span>Offer / Deal</span>
              </button>
              <button
                type="button"
                className="nx-qap-action-btn"
                onClick={() => { onQuickAction?.('mark_reviewed'); setQuickActionsOpen(false) }}
              >
                <Icon name="check" /><span>Mark Reviewed</span>
              </button>
              {!disabled && (
                <button
                  type="button"
                  className="nx-qap-action-btn is-danger"
                  onClick={() => { onQuickAction?.('suppress'); setQuickActionsOpen(false) }}
                >
                  <Icon name="slash" /><span>Suppress / DNC</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </>,
      document.body,
    )
    : null

  return (
    <div
      className={cls('nx-composer', `is-layout-${layoutMode}`, isListening && 'is-listening', isTranslatingDraft && 'is-translating-draft', isMobile && keyboardInset > 0 && 'is-keyboard-open')}
      style={isMobile && keyboardInset > 0 ? { paddingBottom: `${keyboardInset}px` } : undefined}
    >
      {polishPreview && (
        <div className="nx-polish-preview" role="region" aria-label="Operator polish preview">
          <div className="nx-polish-preview__label">Operator Polish Preview</div>
          <div className="nx-polish-preview__text">{polishPreview.polished}</div>
          <div className="nx-polish-preview__actions">
            <button type="button" className="is-primary" onClick={acceptPolish}>Accept</button>
            <button type="button" onClick={undoPolish}>Undo</button>
            <button type="button" onClick={regeneratePolish} disabled={isPolishing}>Regenerate</button>
          </div>
        </div>
      )}

      {polishError && !polishPreview && (
        <div className="nx-polish-preview" role="alert">
          <div className="nx-polish-preview__text">{polishError}</div>
        </div>
      )}

      {isListening && (
        <div className="nx-voice-recording-panel" role="status" aria-live="polite">
          <div className="nx-voice-recording-ring" aria-hidden="true">
            <Icon name="mic" />
          </div>
          <div className="nx-voice-recording-meta">
            <strong>Recording</strong>
            <span>{formatRecordingDuration(recordingElapsed)}</span>
            {transcription && <span>{transcription}</span>}
          </div>
          <div className="nx-voice-recording-actions">
            <button type="button" onClick={() => stopVoice(false)}>Stop</button>
            <button type="button" onClick={() => stopVoice(true)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="nx-composer-dock" ref={dockRef}>
        <div className="nx-composer-dock__side">
          <button
            ref={quickActionsBtnRef}
            type="button"
            className={cls('nx-composer-tool-btn nx-composer-tool-btn--essential', quickActionsOpen && 'is-active')}
            title="Templates and quick actions"
            onClick={() => setQuickActionsOpen((open) => !open)}
            aria-label="Open quick actions"
            aria-expanded={quickActionsOpen}
            disabled={composerDisabled}
          >
            <Icon name="command" />
          </button>
        </div>

        <div className="nx-composer-dock__main">
          <div className={cls('nx-composer-dock__input-wrap', isListening && 'is-listening')}>
            <textarea
              ref={textareaRef}
              placeholder={disabled ? (disabledReason ?? 'Messaging disabled for this thread') : 'Type a message…'}
              value={localDraft}
              onChange={(e) => {
                setLocalDraft(e.target.value)
                setPolishPreview(null)
              }}
              rows={1}
              disabled={composerDisabled}
              onKeyDown={(e) => {
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

            <div className="nx-composer-dock__tools">
              <button
                type="button"
                className={cls('nx-composer-tool-btn', isPolishing && 'is-active')}
                title="Operator Polish"
                disabled={composerDisabled || !hasDraft || isPolishing}
                onClick={() => { void runOperatorPolish() }}
                aria-label="Operator polish"
              >
                <Icon name="spark" />
              </button>

              <button
                type="button"
                className={cls(
                  'nx-composer-tool-btn nx-composer-tool-btn--essential',
                  isTranslatingDraft && 'is-active',
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

              <button
                type="button"
                className="nx-composer-tool-btn nx-composer-tool-btn--essential"
                title="Schedule message"
                disabled={composerDisabled}
                onClick={() => onOpenSchedule(localDraft)}
                aria-label="Schedule message"
              >
                <Icon name="calendar" />
              </button>

              <button
                type="button"
                className={cls(
                  'nx-composer-tool-btn nx-composer-tool-btn--essential',
                  isListening && 'is-active',
                  isProcessing && 'is-active',
                )}
                title={
                  voiceUnsupported
                    ? 'Voice dictation not supported'
                    : isProcessing
                      ? 'Processing transcription…'
                      : isListening
                        ? 'Stop recording'
                        : 'Voice input'
                }
                disabled={composerDisabled}
                onClick={toggleVoice}
                aria-pressed={isListening}
                aria-label="Voice input"
              >
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
            </div>
          </div>
        </div>

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

      {quickActionsPortal}

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