import { useRef, useState, useEffect, useCallback, useLayoutEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { MobileTemplateBrowser } from '../templates/MobileTemplateBrowser'
import { resolveThreadStage, threadStageVisuals } from '../status-visuals'
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
import { callBackend } from '../../../lib/api/backendClient'
import { cleanDictation } from './dictation-cleanup'
import './voice-stage.css'
import type { ViewLayoutMode } from '../../../domain/inbox/view-layout'
import { useBreakpoint } from '../../mobile/useBreakpoint'
import { useMobileKeyboardInset, isKeyboardInsetOpen } from '../../mobile/useMobileKeyboardInset'
import { ComposerPhaseLine } from '../desk/ComposerPhaseLine'
import type { ComposerPhase } from '../desk/composer-phase'


const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

interface ComposerProps {
  /** §22 — the person the draft is addressed to, so templates follow a switch. */
  selectedParticipant?: { display_name?: string | null; canonical_e164?: string | null } | null
  draftText: string
  onSend: (text: string) => void
  onOpenSchedule: (currentDraft: string) => void
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
  /**
   * Inbox Desktop 4.0: the conversation's automation phase, derived from its
   * messages (desk/composer-phase.ts). When given, the composer owns the one
   * automation signal and the conversation's typing mirror is not used.
   */
  phase?: ComposerPhase | null
  /** the existing retry path, for a failed send */
  onRetryPhase?: () => void
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
  thread,
  selectedParticipant = null,
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
  phase,
  onRetryPhase,
}: ComposerProps) => {
  // Every use below is a DEVICE decision (soft keyboard inset, auto-focus,
  // sheet vs popover, tools in the field): a phone, not "the modern product" —
  // the modern desktop gets the full desktop composer (polish, translate,
  // schedule, voice) in the field.
  const { isPhone: isMobile } = useBreakpoint()
  const keyboardInset = useMobileKeyboardInset(isMobile)

  const [localDraft, setLocalDraft] = useState(draftText)
  const [micState, setMicState] = useState<MicState>('idle')
  const [voiceUnsupported, setVoiceUnsupported] = useState(false)
  const [quickActionsOpen, setQuickActionsOpen] = useState(false)
  // Second-press confirmation for Suppress / DNC. Disarms whenever the menu
  // closes, so an armed button can never survive to a later, unrelated tap.
  const [suppressArmed, setSuppressArmed] = useState(false)
  useEffect(() => {
    if (!quickActionsOpen) setSuppressArmed(false)
  }, [quickActionsOpen])
  const [templatePopoverOpen, setTemplatePopoverOpen] = useState(false)
  const [templateGap, setTemplateGap] = useState<{ template: string; missing: string[] } | null>(null)

  /*
   * The stage the conversation is actually in, as a template stage_code (S1,
   * S2, ...). Resolved from the same helper the command strip uses so the
   * browser highlights the same stage the pill shows -- two places disagreeing
   * about the stage would be worse than not showing it at all.
   */
  const currentStageCode = useMemo(() => {
    if (!thread) return null
    const stage = resolveThreadStage(thread as Parameters<typeof resolveThreadStage>[0])
    return threadStageVisuals[stage]?.shortLabel ?? null
  }, [thread])
  const [voiceLevel, setVoiceLevel] = useState(0)
  const [voiceBars, setVoiceBars] = useState<number[]>(() => Array(28).fill(0))
  const [voiceStage, setVoiceStage] = useState<'polishing' | 'translating' | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const voiceCancelledRef = useRef(false)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const [, setTranscription] = useState('')
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
      const res = await callBackend<{ ok: boolean; polishedText: string }>('/api/cockpit/inbox/polish-draft', {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
      const data = res.ok ? res.data : null
      if (data?.ok && data.polishedText?.trim()) {
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

  // The conversation announces when the automation is typing a reply to the
  // seller (ChatThread → 'nx:auto-reply-typing'); the composer shows the dots too.
  const [autoReplyTyping, setAutoReplyTyping] = useState(false)
  useEffect(() => {
    setAutoReplyTyping(false)
    const onTyping = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string | null; active: boolean }>).detail
      if (!detail) return
      if (detail.threadId && thread?.id && detail.threadId !== thread.id) return
      setAutoReplyTyping(Boolean(detail.active))
    }
    window.addEventListener('nx:auto-reply-typing', onTyping)
    return () => window.removeEventListener('nx:auto-reply-typing', onTyping)
  }, [thread?.id])

  // Typing energy: each keystroke lifts the composer's glow (--nx-type, 0–1 on
  // the dock); it settles back to a slow breathe ~1.5s after the last key.
  const energyRef = useRef(0)
  const energyRafRef = useRef(0)
  const pumpTypingEnergy = useCallback(() => {
    energyRef.current = Math.min(1, energyRef.current + 0.16)
    if (energyRafRef.current) return
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      energyRef.current = Math.max(0, energyRef.current - dt * 0.65)
      dockRef.current?.style.setProperty('--nx-type', energyRef.current.toFixed(3))
      if (energyRef.current > 0.002) {
        energyRafRef.current = requestAnimationFrame(tick)
      } else {
        energyRafRef.current = 0
        dockRef.current?.style.setProperty('--nx-type', '0')
      }
    }
    energyRafRef.current = requestAnimationFrame(tick)
  }, [])
  useEffect(() => () => { if (energyRafRef.current) cancelAnimationFrame(energyRafRef.current) }, [])

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
      // Same reference when already empty: a fresh [] re-rendered the host,
      // and a host that rebuilds `thread` per render (the Map card) looped.
      setRecommendedTemplates((cur) => (cur.length ? [] : cur))
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
    // Release the microphone: the level meter held its own stream open, so the
    // phone's mic indicator stayed on after the recording ended.
    try { mediaStreamRef.current?.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
    mediaStreamRef.current = null
    try { void audioCtxRef.current?.close() } catch { /* ignore */ }
    audioCtxRef.current = null
    setVoiceLevel(0)
    setVoiceBars(Array(28).fill(0))
  }

  const startVoiceAnalysis = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      const audioContext = new AudioContext()
      audioCtxRef.current = audioContext
      const analyser = audioContext.createAnalyser()
      const microphone = audioContext.createMediaStreamSource(stream)
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.8
      microphone.connect(analyser)
      analyserRef.current = analyser
      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      let frame = 0
      const updateVoiceLevel = () => {
        if (!analyserRef.current) return
        analyserRef.current.getByteFrequencyData(dataArray)
        const average = dataArray.reduce((sum, v) => sum + v, 0) / dataArray.length
        setVoiceLevel(Math.min(average / 128, 1))
        // Spectrum for the recording stage: 28 bands over the voice range, ~30fps.
        if ((frame++ & 1) === 0) {
          const bands = 28
          const span = Math.floor(dataArray.length * 0.7)
          const next: number[] = []
          for (let b = 0; b < bands; b++) {
            const from = Math.floor((b / bands) * span)
            const to = Math.max(from + 1, Math.floor(((b + 1) / bands) * span))
            let sum = 0
            for (let i = from; i < to; i++) sum += dataArray[i]
            next.push(Math.min(1, sum / (to - from) / 200))
          }
          setVoiceBars(next)
        }
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
    voiceCancelledRef.current = cancelTranscript
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
    voiceCancelledRef.current = false
    setVoiceStage(null)
    baseDraftRef.current = localDraft.trim()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'
    recognition.onresult = (event) => {
      const parts: string[] = []
      for (let i = 0; i < event.results.length; i++) parts.push(event.results[i][0].transcript.trim())
      const current = parts.join(' ').trim()
      setTranscription(current)
      // Live: capitals, spoken punctuation, no filler — while they speak.
      const cleaned = cleanDictation(current, { terminate: false })
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

      /*
       * A VOICE MESSAGE COMES OUT READY TO SEND: finished sentences locally,
       * then the server polish (grammar/punctuation; a model when configured),
       * then — for a seller who does not read English — their language. Each
       * step only replaces the draft if the operator has not edited it since.
       */
      if (voiceCancelledRef.current) {
        voiceCancelledRef.current = false
        setLocalDraft(baseDraftRef.current)
        latestDraftRef.current = baseDraftRef.current
        setMicState('idle')
        return
      }
      const spoken = latestDraftRef.current.trim()
      if (!spoken || spoken === baseDraftRef.current) { window.setTimeout(() => setMicState('idle'), 300); return }
      const finished = cleanDictation(spoken, { terminate: true })
      setLocalDraft(finished)
      latestDraftRef.current = finished
      void (async () => {
        setVoiceStage('polishing')
        const polished = await polishDraftText(finished)
        let current = latestDraftRef.current.trim()
        if (polished && current === finished) {
          setLocalDraft(polished)
          latestDraftRef.current = polished
          current = polished
        }
        setVoiceStage(null)
        if (!isSellerLanguageEnglish && current && onTranslateDraft) onTranslateDraft(current)
        setMicState('idle')
      })()
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
    const context = buildTemplateContextFromThread(thread, threadContext, {}, selectedParticipant)
    const { renderedText, missingVariables } = renderTemplate(template, context)

    /*
     * §23 -- BROKEN COPY DOES NOT REACH THE COMPOSER.
     *
     * renderTemplate already reports what it could not resolve, and this path
     * threw that away: an unresolved variable was substituted as
     * `[[agent_name]]` and pasted into the draft, one Send away from a real
     * seller. The most common one is agent_name, which resolves to '' by
     * design when the owner has no assigned agent -- precisely the case where
     * guessing is wrong.
     *
     * The refusal names what is missing and sends the operator to the Template
     * Library, which is the surface that can actually fill a variable in.
     */
    if (missingVariables.length > 0) {
      setTemplateGap({ template: template.useCase || template.useCaseSlug || 'Template', missing: missingVariables })
      setQuickActionsOpen(false)
      return
    }

    setTemplateGap(null)
    setLocalDraft(renderedText)
    setPolishPreview(null)
    setQuickActionsOpen(false)
  }, [thread, threadContext, selectedParticipant])

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

  /**
   * The four tools that sit inline in the composer on desktop. On mobile that inline
   * row is collapsed into this panel, so they are hoisted here and rendered as their
   * own section at the TOP of the panel — ahead of the template list — instead of
   * being buried under it. Desktop keeps them in their original sections.
   */
  const qaPolishButton = (
    <button
      key="polish"
      type="button"
      className="nx-qap-action-btn"
      disabled={composerDisabled || !hasDraft || isPolishing}
      onClick={() => { void runOperatorPolish(); setQuickActionsOpen(false) }}
    >
      <Icon name="spark" /><span>Operator Polish</span>
    </button>
  )

  const qaTranslateButton = (
    <button
      key="translate"
      type="button"
      className="nx-qap-action-btn"
      disabled={composerDisabled || !hasDraft || isTranslatingDraft}
      onClick={() => { onTranslateDraft?.(localDraft); setQuickActionsOpen(false) }}
    >
      <Icon name="globe" /><span>Translate Draft</span>
    </button>
  )

  const qaScheduleButton = (
    <button
      key="schedule"
      type="button"
      className="nx-qap-action-btn"
      disabled={composerDisabled}
      onClick={() => { onOpenSchedule(localDraft); setQuickActionsOpen(false) }}
    >
      <Icon name="calendar" /><span>Schedule Message</span>
    </button>
  )

  const qaVoiceButton = (
    <button
      key="voice"
      type="button"
      className={cls('nx-qap-action-btn', isListening && 'is-active')}
      disabled={composerDisabled || voiceUnsupported}
      onClick={() => { toggleVoice(); setQuickActionsOpen(false) }}
      aria-pressed={isListening}
    >
      <Icon name="mic" />
      <span>
        {voiceUnsupported
          ? 'Voice Input (unsupported)'
          : isListening ? 'Stop Recording' : 'Voice Input'}
      </span>
    </button>
  )

  const qaAiSuggestionButtons = aiSuggestions.slice(0, 3).map((suggestion) => (
    <button
      key={suggestion.id}
      type="button"
      className={cls('nx-qap-action-btn', suggestion.tone && `is-${suggestion.tone}`)}
      disabled={composerDisabled || !suggestion.text}
      onClick={() => {
        if (suggestion.text) setLocalDraft(suggestion.text)
        setQuickActionsOpen(false)
      }}
    >
      <Icon name="spark" /><span>{suggestion.label}</span>
    </button>
  ))

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

          {isMobile ? (
            <>
              <div className="nx-qap-section">
                <div className="nx-qap-section-label">Composer tools</div>
                <div className="nx-qap-actions">
                  {qaScheduleButton}
                  {qaPolishButton}
                  {qaTranslateButton}
                  {qaVoiceButton}
                </div>
              </div>
              <div className="nx-qap-divider" />
            </>
          ) : null}

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
              {/*
                §3 — THE STAGE COMES FROM THE TEMPLATE, NOT FROM ITS TEXT.

                sms_templates.stage_code / stage_label are the canonical
                association (S1 · Ownership Confirmation, S2 · Soft Intent
                Probe, and the MF / follow-up codes). Showing them is the
                difference between choosing a message and guessing one. A
                template with no stage recorded says so rather than being
                assigned a plausible one.
              */}
              {recommendedTemplates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="nx-qap-template-btn is-staged"
                  onClick={() => insertRenderedTemplate(template)}
                  title={template.templateText}
                >
                  <Icon name="file-text" />
                  <span className="nx-qap-template-btn__text">
                    <span className="nx-qap-template-btn__stage">
                      {template.stageCode
                        ? `${template.stageCode}${template.stageLabel ? ` · ${template.stageLabel}` : ''}`
                        : 'No stage recorded'}
                    </span>
                    <span className="nx-qap-template-btn__name">
                      {template.useCase || template.useCaseSlug}
                    </span>
                  </span>
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

          {/* On mobile Polish/Translate are promoted to the Composer tools section above,
              so this section carries only the AI suggestions and is dropped when empty. */}
          {!isMobile || qaAiSuggestionButtons.length > 0 ? (
            <div className="nx-qap-section">
              <div className="nx-qap-section-label">Writing tools</div>
              <div className="nx-qap-actions">
                {!isMobile ? qaPolishButton : null}
                {qaAiSuggestionButtons}
                {!isMobile ? qaTranslateButton : null}
              </div>
            </div>
          ) : null}

          <div className="nx-qap-divider" />

          <div className="nx-qap-section">
            <div className="nx-qap-section-label">Message actions</div>
            <div className="nx-qap-actions">
              {!isMobile ? qaScheduleButton : null}
              <button
                type="button"
                className="nx-qap-action-btn"
                onClick={() => { onQuickAction?.('snooze'); setQuickActionsOpen(false) }}
              >
                <Icon name="clock" /><span>Snooze 24h</span>
              </button>
              <button
                type="button"
                className="nx-qap-action-btn"
                onClick={() => { onQuickAction?.('mark_reviewed'); setQuickActionsOpen(false) }}
              >
                <Icon name="check" /><span>Mark Read</span>
              </button>
              {!disabled && (
                /**
                 * DNC IS NOT A ONE-TAP ACTION.
                 *
                 * It fired immediately on a single press, inside a menu, on a
                 * phone. A mis-tap permanently marked a seller do-not-contact,
                 * stopped every future touch and cancelled their pending sends.
                 * The second press is the confirmation: it names the consequence
                 * and it is the only thing that mutates. Anything else -- closing
                 * the menu, pressing another action -- disarms it.
                 */
                <button
                  type="button"
                  className={cls('nx-qap-action-btn is-danger', suppressArmed && 'is-armed')}
                  onClick={() => {
                    if (!suppressArmed) { setSuppressArmed(true); return }
                    setSuppressArmed(false)
                    onQuickAction?.('suppress')
                    setQuickActionsOpen(false)
                  }}
                >
                  <Icon name="slash" />
                  <span>
                    {suppressArmed
                      ? 'Confirm — stop all outreach'
                      : 'Suppress / DNC'}
                  </span>
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
      className={cls('nx-composer', `is-layout-${layoutMode}`, isListening && 'is-listening', isTranslatingDraft && 'is-translating-draft', isMobile && isKeyboardInsetOpen(keyboardInset) && 'is-keyboard-open')}
      data-phase={phase?.kind}
      /**
       * NO inline paddingBottom.
       *
       * It used to pad the composer by the keyboard overlap, which does not lift
       * anything: the composer is the last child of a `height:100%; overflow:hidden`
       * flex column, so padding grows it DOWNWARD, off-screen. The send row ended
       * up under the keyboard with a blank band above it. The overlap is now
       * reserved by the thread surface (mobile-operating-shell.css, `.is-keyboard-open`),
       * which shrinks the column so its last child lands on the keyboard's edge.
       */
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
        <div className="nx-voice-stage" role="status" aria-live="polite" style={{ ['--lvl' as string]: voiceLevel.toFixed(3) }}>
          <div className="nx-voice-stage__aura" aria-hidden="true" />
          <div className="nx-voice-stage__head">
            <span className="nx-voice-stage__rec"><i aria-hidden="true" />REC</span>
            <span className="nx-voice-stage__time">{formatRecordingDuration(recordingElapsed)}</span>
            {!isSellerLanguageEnglish && sellerLanguageLabel && sellerLanguageLabel !== 'Unknown' ? (
              <span className="nx-voice-stage__lang">→ {sellerLanguageLabel}</span>
            ) : null}
          </div>
          <div className="nx-voice-stage__core">
            <div className="nx-voice-stage__orb" aria-hidden="true">
              <span className="nx-voice-stage__ring is-1" />
              <span className="nx-voice-stage__ring is-2" />
              <span className="nx-voice-stage__ring is-3" />
              <span className="nx-voice-stage__glass"><Icon name="mic" /></span>
            </div>
            <div className="nx-voice-stage__spectrum" aria-hidden="true">
              {voiceBars.map((v, i) => (
                <span key={i} style={{ transform: `scaleY(${Math.max(0.08, v).toFixed(3)})`, animationDelay: `${(i % 7) * 70}ms` }} />
              ))}
            </div>
          </div>
          <p className={cls('nx-voice-stage__words', !localDraft.trim() && 'is-empty')}>
            {localDraft.trim() || 'Listening… speak naturally — punctuation and capitals are handled.'}
          </p>
          <div className="nx-voice-stage__actions">
            <button type="button" className="nx-voice-stage__btn is-cancel" onClick={() => stopVoice(true)} aria-label="Cancel recording">
              <Icon name="close" />
            </button>
            <button type="button" className="nx-voice-stage__btn is-done" onClick={() => { recognitionRef.current?.stop() }} aria-label="Finish recording">
              <Icon name="check" /><span>Done</span>
            </button>
          </div>
        </div>
      )}
      {phase !== undefined ? (
        phase && phase.kind !== 'resting' && !isListening && !voiceStage
          ? <ComposerPhaseLine phase={phase} onRetry={onRetryPhase} />
          : null
      ) : autoReplyTyping && !isListening && !voiceStage ? (
        <div className="nx-voice-status is-auto-reply" role="status" aria-live="polite">
          <span className="nx-voice-status__dot" aria-hidden="true" />
          Automation is replying…
        </div>
      ) : null}
      {(voiceStage || (isTranslatingDraft && micState !== 'idle')) && !isListening ? (
        <div className="nx-voice-status" role="status" aria-live="polite">
          <span className="nx-voice-status__dot" aria-hidden="true" />
          {voiceStage === 'polishing' ? 'Polishing your message…' : `Translating to ${sellerLanguageLabel}…`}
        </div>
      ) : null}

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
                pumpTypingEnergy()
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

            {!isMobile ? (
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
            ) : null}
          </div>
        </div>

        {isMobile ? (
          <button
            type="button"
            className={cls('nx-voice-mic', isListening && 'is-live', isProcessing && 'is-working')}
            onClick={toggleVoice}
            disabled={composerDisabled || voiceUnsupported}
            aria-pressed={isListening}
            aria-label={isListening ? 'Stop recording' : 'Voice message'}
            title={voiceUnsupported ? 'Voice dictation is not supported in this browser' : 'Voice message'}
            data-composer-action="voice"
          >
            <Icon name="mic" />
          </button>
        ) : null}
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

      {templateGap ? (
        <div className="nx-composer-template-gap" role="status">
          <Icon name="alert-circle" />
          <div className="nx-composer-template-gap__body">
            <strong>{templateGap.template} needs {templateGap.missing.length === 1 ? 'a value' : 'values'}</strong>
            <span>{templateGap.missing.map((v) => v.replace(/_/g, ' ')).join(', ')}</span>
          </div>
          <button
            type="button"
            className="nx-composer-template-gap__open"
            onClick={() => { setTemplateGap(null); setTemplatePopoverOpen(true) }}
          >
            Fill in
          </button>
          <button
            type="button"
            className="nx-composer-template-gap__close"
            aria-label="Dismiss"
            onClick={() => setTemplateGap(null)}
          >
            <Icon name="close" />
          </button>
        </div>
      ) : null}

      {/*
        §4 — one entry point, two surfaces. The desktop popover is a two-pane
        layout with a filter rail; on a phone that was the dead end this pass
        was asked to fix. Same data, same renderer, different hands.
      */}
      <MobileTemplateBrowser
        open={isMobile && templatePopoverOpen}
        onClose={() => setTemplatePopoverOpen(false)}
        thread={thread}
        threadContext={threadContext}
        selectedParticipant={selectedParticipant}
        currentStageCode={currentStageCode}
        onInsert={(text) => {
          // Insert only. Sending stays an explicit, separate press.
          setLocalDraft(text)
          setPolishPreview(null)
          setTemplateGap(null)
        }}
      />

      <TemplatePopover
        open={!isMobile && templatePopoverOpen}
        onClose={() => setTemplatePopoverOpen(false)}
        thread={thread}
        threadContext={threadContext}
        selectedParticipant={selectedParticipant}
        onInsert={handleInsertTemplate}
        onReplace={handleReplaceTemplate}
        onSendNow={onSendTemplate}
        onQueue={onQueueTemplate}
        onSchedule={onScheduleTemplate}
      />
    </div>
  )
}