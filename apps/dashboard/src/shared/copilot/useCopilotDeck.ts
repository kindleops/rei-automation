import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  ActionPermission,
  ConversationMessage,
  CopilotContext,
  CopilotState,
  CopilotSuggestion,
  PlanStep,
  QuickAction,
  ResolvedIntent,
  TraceEvent,
} from './copilot-state'
import {
  ACTION_PERMISSION_META,
  MODEL_OPTIONS,
  STATE_META,
  buildGreeting,
  createMessage,
  createTraceEvent,
  decomposePlan,
  generateQuickActions,
  generateRoomSuggestions,
  matchSlashCommands,
  parseIntent,
  resolveRoom,
} from './copilot-state'
import { useVoiceMode } from './copilot-voice'
import { loadSettings, subscribeSettings } from '../settings'
import type { NexusSettings } from '../settings'

interface UseCopilotDeckOptions {
  open: boolean
  context: CopilotContext
  onAction: (intent: ResolvedIntent) => void
  surface: 'sidecar' | 'deck'
}

interface DeckPhase {
  state: CopilotState
  delay: number
  type: TraceEvent['type']
  label: string
  detail?: string
  planDoneCount?: number
  planActiveIndex?: number | null
  message?: string
}

const deckPromptBySurface = {
  sidecar: 'Deploy command',
  deck: 'Command the deck',
} as const

function buildLifecycle(intent: ResolvedIntent): DeckPhase[] {
  const domainLabel = `${intent.domain}.${intent.action}`
  const phases: DeckPhase[] = [
    {
      state: 'understanding',
      delay: 140,
      type: 'parse',
      label: `Command parsed: ${domainLabel}`,
      detail: intent.raw,
      planDoneCount: 2,
      planActiveIndex: 2,
      message: intent.preview,
    },
  ]

  const needsSearch = intent.domain === 'system' || intent.domain === 'inbox' || intent.domain === 'alerts' || intent.domain === 'briefing' || intent.domain === 'settings'
  const needsAnalysis = intent.domain !== 'room' && intent.domain !== 'copilot' && intent.domain !== 'split_view'
  const needsDraft = intent.domain === 'inbox' || intent.domain === 'system' || intent.domain === 'briefing'

  if (needsSearch) {
    phases.push({
      state: 'searching',
      delay: 260,
      type: 'search',
      label: 'Context sweep engaged',
      detail: intent.preview,
      planDoneCount: 2,
      planActiveIndex: 2,
    })
  }

  if (needsAnalysis) {
    phases.push({
      state: 'analyzing',
      delay: 300,
      type: 'analysis',
      label: 'Evaluating live signals',
      detail: intent.preview,
      planDoneCount: 3,
      planActiveIndex: 3,
    })
  }

  phases.push({
    state: 'planning',
    delay: 260,
    type: 'analysis',
    label: 'Generated candidate actions',
    detail: intent.preview,
    planDoneCount: 4,
    planActiveIndex: 4,
  })

  if (needsDraft) {
    phases.push({
      state: 'drafting',
      delay: 220,
      type: 'draft',
      label: 'Drafting operator response',
      detail: intent.preview,
      planDoneCount: 4,
      planActiveIndex: 4,
    })
  }

  return phases
}

function markPlanSteps(steps: PlanStep[], doneCount: number, activeIndex: number | null) {
  return steps.map((step, index): PlanStep => {
    const status: PlanStep['status'] = index < doneCount
      ? 'done'
      : activeIndex != null && index === activeIndex
        ? 'active'
        : 'pending'

    return {
      ...step,
      status,
    }
  })
}

export function useCopilotDeck({ open, context, onAction, surface }: UseCopilotDeckOptions) {
  const [settings, setSettings] = useState<NexusSettings>(loadSettings)
  const [copilotState, setCopilotState] = useState<CopilotState>('idle')
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [trace, setTrace] = useState<TraceEvent[]>([])
  const [suggestions, setSuggestions] = useState<CopilotSuggestion[]>([])
  const [quickActions, setQuickActions] = useState<QuickAction[]>([])
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([])
  const [slashHints, setSlashHints] = useState<ReturnType<typeof matchSlashCommands>>([])
  const [pendingIntent, setPendingIntent] = useState<ResolvedIntent | null>(null)
  const [commandHistory, setCommandHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [lastContext, setLastContext] = useState(context.roomPath)

  const planRef = useRef<PlanStep[]>([])
  const timersRef = useRef<number[]>([])
  const prevOpenRef = useRef(open)
  const voiceTraceRaisedRef = useRef(false)
  const lastSpokenMessageRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  const room = resolveRoom(context.roomPath)
  const meta = STATE_META[copilotState]
  const permission = (settings.actionPermission ?? 'confirm-before') as ActionPermission
  const permissionMeta = ACTION_PERMISSION_META[permission]
  const model = MODEL_OPTIONS.find((option) => option.id === settings.copilotModel) ?? MODEL_OPTIONS[1]
  const livePreview = useMemo(() => (input.trim() ? parseIntent(input.trim()) : null), [input])
  const recentCommands = useMemo(() => commandHistory.slice(0, surface === 'deck' ? 6 : 4), [commandHistory, surface])
  const recentMessages = useMemo(() => messages.slice(0, surface === 'deck' ? 4 : 3), [messages, surface])
  const recentTrace = useMemo(() => trace.slice(0, surface === 'deck' ? 8 : 5), [trace, surface])
  const promptLabel = deckPromptBySurface[surface]

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((timerId) => window.clearTimeout(timerId))
    timersRef.current = []
  }, [])

  const schedule = useCallback((callback: () => void, delay: number) => {
    const timerId = window.setTimeout(callback, delay)
    timersRef.current.push(timerId)
  }, [])

  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), [])
  useEffect(() => () => clearTimers(), [clearTimers])

  const addMessage = useCallback((role: ConversationMessage['role'], text: string, extra?: Partial<ConversationMessage>) => {
    const next = createMessage(role, text, extra?.state, extra?.intent)
    setMessages((current) => [next, ...current].slice(0, 18))
    return next
  }, [])

  const addTrace = useCallback((type: TraceEvent['type'], label: string, detail?: string, state?: CopilotState) => {
    setTrace((current) => [createTraceEvent(type, label, detail, context.roomPath, state ?? copilotState), ...current].slice(0, 120))
  }, [context.roomPath, copilotState])

  const setLifecycleState = useCallback((state: CopilotState, traceType?: TraceEvent['type'], label?: string, detail?: string) => {
    setCopilotState(state)
    if (traceType && label) {
      addTrace(traceType, label, detail, state)
    }
  }, [addTrace])

  const initializeRoomIntel = useCallback((announce = false) => {
    const roomSuggestions = generateRoomSuggestions(context.roomPath, {
      hotCount: context.hotCount,
      alertCount: context.alertCount,
      pendingActions: context.pendingActions,
    })
    setSuggestions(roomSuggestions)
    setQuickActions(generateQuickActions(context.roomPath))
    if (announce) {
      addTrace('context', `Context synced: ${context.roomPath}`, room.room, 'analyzing')
    }
  }, [addTrace, context.alertCount, context.hotCount, context.pendingActions, context.roomPath, room.room])

  const finalizeCompletedState = useCallback((intent: ResolvedIntent, completionDetail: string) => {
    setPlanSteps(markPlanSteps(planRef.current, planRef.current.length, null))
    setLifecycleState('completed', 'completion', 'Action executed successfully', completionDetail)
    addMessage('copilot', completionDetail, { state: 'speaking', intent: `${intent.domain}.${intent.action}` })
    schedule(() => setCopilotState('idle'), 1450)
  }, [addMessage, schedule, setLifecycleState])

  const executeIntent = useCallback((intent: ResolvedIntent) => {
    setPlanSteps(markPlanSteps(planRef.current, Math.max(planRef.current.length - 1, 0), planRef.current.length - 1))
    setLifecycleState('executing', 'execution', 'Executing approved action', intent.preview)
    schedule(() => {
      onAction(intent)
      finalizeCompletedState(intent, intent.preview)
      setPendingIntent(null)
    }, 680)
  }, [finalizeCompletedState, onAction, schedule, setLifecycleState])

  const determineConfirmation = useCallback((intent: ResolvedIntent, src: 'operator' | 'voice' = 'operator') => {
    const isNavigation = intent.domain === 'room' || intent.domain === 'map' || intent.domain === 'split_view'
    // If autonomous mode is enabled in settings, bypass confirmation for all actions
    if (settings.copilotAutonomous) return { mode: 'execute' as const, needsConfirm: false }
    // Allow voice-originated commands to execute automatically when the deck is not open (background voice)
    if (src === 'voice' && !open) return { mode: 'execute' as const, needsConfirm: false }
    if (permission === 'read-only') return { mode: 'observe' as const, needsConfirm: false }
    if (permission === 'suggest-only' || permission === 'confirm-before') return { mode: 'confirm' as const, needsConfirm: true }
    if (permission === 'low-risk-auto' && !isNavigation) return { mode: 'confirm' as const, needsConfirm: true }
    return { mode: 'execute' as const, needsConfirm: false }
  }, [permission, settings.copilotAutonomous, open])

  const handleSubmit = useCallback((override?: string, source: 'operator' | 'voice' = 'operator') => {
    const raw = override ?? input.trim()
    if (!raw) return

    clearTimers()
    setPendingIntent(null)
    setInput('')
    setCommandHistory((current) => [raw, ...current.filter((entry) => entry !== raw)].slice(0, 12))
    setHistoryIndex(-1)
    addMessage('operator', raw, { state: 'understanding' })

    const intent = parseIntent(raw)
    if (!intent) {
      setLifecycleState('error', 'error', 'Command parse failed', raw)
      addMessage('system', 'Command grammar mismatch. Try /help for guidance.', { state: 'error' })
      schedule(() => setCopilotState('idle'), 1400)
      return
    }

    // Announce command activity globally so visuals and other listeners can react
    try { window.dispatchEvent(new CustomEvent('nx:copilot-command', { detail: { text: raw, intent } })) } catch (_) { }

    const plan = decomposePlan(intent)
    planRef.current = plan
    setPlanSteps(markPlanSteps(plan, 1, 1))

    const phases = buildLifecycle(intent)
    let elapsed = 0
    phases.forEach((phase) => {
      elapsed += phase.delay
      schedule(() => {
        setLifecycleState(phase.state, phase.type, phase.label, phase.detail)
        setPlanSteps(markPlanSteps(planRef.current, phase.planDoneCount ?? 2, phase.planActiveIndex ?? 2))
        if (phase.message) {
          addMessage('copilot', phase.message, { state: phase.state, intent: `${intent.domain}.${intent.action}` })
        }
      }, elapsed)
    })

    schedule(() => {
      const confirmationMode = determineConfirmation(intent, source)
      if (confirmationMode.mode === 'observe') {
        setLifecycleState('completed', 'system', 'Read-only mode: action logged only', intent.preview)
        addMessage('system', 'Read-only mode engaged. Intent retained in mission trace.', { state: 'completed' })
        setPlanSteps(markPlanSteps(planRef.current, planRef.current.length, null))
        schedule(() => setCopilotState('idle'), 1200)
        return
      }

      if (confirmationMode.needsConfirm) {
        setPendingIntent(intent)
        setPlanSteps(markPlanSteps(planRef.current, Math.max(planRef.current.length - 1, 0), planRef.current.length - 1))
        setLifecycleState('confirming', 'confirmation', 'Awaiting confirmation', intent.preview)
        addMessage('system', `${permissionMeta.label} requires explicit approval.`, { state: 'confirming' })
        return
      }

      executeIntent(intent)
    }, elapsed + 120)
  }, [addMessage, clearTimers, determineConfirmation, executeIntent, input, permissionMeta.label, schedule, setLifecycleState])

  const confirmIntent = useCallback(() => {
    if (!pendingIntent) return
    executeIntent(pendingIntent)
  }, [executeIntent, pendingIntent])

  const rejectIntent = useCallback(() => {
    setPendingIntent(null)
    setPlanSteps(planRef.current.map((step, index) => ({ ...step, status: index < planRef.current.length - 1 ? 'done' : 'error' })))
    setLifecycleState('error', 'system', 'Operator held staged action', 'Execution stopped before dispatch.')
    addMessage('system', 'Staged action held. Mission trace preserved for later review.', { state: 'error' })
    schedule(() => setCopilotState('idle'), 1320)
  }, [addMessage, schedule, setLifecycleState])

  const handleSuggestionAction = useCallback((suggestion: CopilotSuggestion) => {
    const command = suggestion.command ?? suggestion.actionLabel
    if (command) {
      handleSubmit(command)
    }
  }, [handleSubmit])

  const handleInputKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSubmit()
      return
    }

    if (event.key === 'ArrowUp' && !input.trim() && commandHistory.length > 0) {
      event.preventDefault()
      const nextIndex = Math.min(historyIndex + 1, commandHistory.length - 1)
      setHistoryIndex(nextIndex)
      setInput(commandHistory[nextIndex] ?? '')
      return
    }

    if (event.key === 'ArrowDown' && historyIndex >= 0) {
      event.preventDefault()
      const nextIndex = historyIndex - 1
      setHistoryIndex(nextIndex)
      setInput(nextIndex >= 0 ? (commandHistory[nextIndex] ?? '') : '')
    }
  }, [commandHistory, handleSubmit, historyIndex, input])

  useEffect(() => {
    if (input.startsWith('/')) {
      setSlashHints(matchSlashCommands(input))
    } else {
      setSlashHints([])
    }
    // Broadcast typing activity so orb visuals can react in real-time
    if (input.trim().length > 0) {
      const amp = Math.min(1, Math.sqrt(input.trim().length / 60))
      try { window.dispatchEvent(new CustomEvent('nx:copilot-typing', { detail: { amplitude: amp } })) } catch (_) { }
    }
    // Shift to understanding when user is actively typing (only from idle)
    if (input.trim().length > 0 && copilotState === 'idle') {
      setCopilotState('understanding')
    } else if (input.trim().length === 0 && copilotState === 'understanding') {
      setCopilotState('idle')
    }
  }, [input, copilotState])

  const focusInput = useCallback(() => {
    if (inputRef.current) {
      inputRef.current.focus()
      return
    }
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  // Focus on open — uses its own timer, NOT the shared schedule() that clearTimers() wipes
  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(focusInput, 80)
    return () => window.clearTimeout(id)
  }, [open, focusInput])

  // Cmd/Ctrl+L to focus input from anywhere
  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
        e.preventDefault()
        focusInput()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, focusInput])

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      clearTimers()
      setLastContext(context.roomPath)
      setPendingIntent(null)
      setPlanSteps([])
      const greetingLines = buildGreeting(
        settings.operatorName,
        settings.greetingStyle,
        context.roomPath,
        {
          hotCount: context.hotCount,
          alertCount: context.alertCount,
          pendingActions: context.pendingActions,
        },
        {
          operatorTitle: settings.operatorTitle,
          assistantName: settings.assistantName,
        },
      )

      setMessages([])
      setLifecycleState('greeting', 'greeting', 'Session initialized', `${room.room} secure deck online`)
      greetingLines.forEach((line, index) => {
        schedule(() => {
          setCopilotState('speaking')
          addMessage('copilot', line, { state: 'speaking' })
        }, index * 320)
      })

      schedule(() => {
        setCopilotState('analyzing')
        initializeRoomIntel(true)
      }, greetingLines.length * 320 + 220)

      schedule(() => {
        if (settings.voiceModeDefault) {
          addTrace('voice', 'Voice mode primed', 'Mic shortcut ready for immediate activation.', 'idle')
        }
        setCopilotState('idle')
        focusInput()
      }, greetingLines.length * 320 + 720)
    }

    prevOpenRef.current = open
  }, [addMessage, addTrace, clearTimers, context.alertCount, context.hotCount, context.pendingActions, context.roomPath, initializeRoomIntel, open, room.room, schedule, setLifecycleState, settings.assistantName, settings.greetingStyle, settings.operatorName, settings.operatorTitle, settings.voiceModeDefault])

  useEffect(() => {
    if (!open) return
    if (context.roomPath === lastContext) return

    clearTimers()
    setLastContext(context.roomPath)
    setLifecycleState('analyzing', 'context', `Context synced: ${context.roomPath}`, room.room)
    addMessage('system', `Active room updated to ${room.room}.`, { state: 'analyzing' })
    schedule(() => {
      initializeRoomIntel()
      setCopilotState('idle')
    }, 520)
  }, [addMessage, clearTimers, context.roomPath, initializeRoomIntel, lastContext, open, room.room, schedule, setLifecycleState])

  // --- TTS: speak copilot & system messages when voice mode is set to 'full'
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return

    // If full TTS isn't enabled, cancel any active synthesis and reset tracking
    if (settings.copilotVoiceMode !== 'full') {
      try {
        if (window.speechSynthesis.speaking) window.speechSynthesis.cancel()
      } catch (e) {
        // ignore
      }
      lastSpokenMessageRef.current = null
      return
    }

    const latest = messages[0]
    if (!latest) return
    // speak copilot and system messages (so system notifications are voiced)
    if (!(latest.role === 'copilot' || latest.role === 'system')) return
    // avoid repeating the same message
    if (latest.id === lastSpokenMessageRef.current) return

    // skip explicit error states
    if (latest.state === 'error') return

    lastSpokenMessageRef.current = latest.id

    try {
      // Queue utterances rather than canceling previous speech so greetings and multi-line messages are not skipped.
      const utter = new SpeechSynthesisUtterance(latest.text)

      // persona modifiers
      const persona = settings.ttsPersona ?? 'neutral'
      const PERSONA: Record<string, { rate: number; pitch: number; vol: number }> = {
        neutral: { rate: 1, pitch: 1, vol: 1 },
        warm: { rate: 0.95, pitch: 0.92, vol: 0.98 },
        energetic: { rate: 1.12, pitch: 1.06, vol: 1 },
        calm: { rate: 0.88, pitch: 0.86, vol: 0.95 },
        robotic: { rate: 1.0, pitch: 0.56, vol: 1 },
        friendly: { rate: 1.02, pitch: 1.05, vol: 1 },
        authoritative: { rate: 0.95, pitch: 0.9, vol: 1.05 },
        narrator: { rate: 0.92, pitch: 0.88, vol: 1 },
      }

      const p = PERSONA[persona] ?? PERSONA.neutral

      // use settings for TTS controls, modified by persona
      utter.volume = (typeof settings.ttsVolume === 'number' ? settings.ttsVolume : 1) * p.vol
      utter.rate = (typeof settings.ttsRate === 'number' ? settings.ttsRate : 1) * p.rate
      utter.pitch = (typeof settings.ttsPitch === 'number' ? settings.ttsPitch : 1) * p.pitch

      // apply selected voice if present
      try {
        if (settings.ttsVoice) {
          const voices = window.speechSynthesis.getVoices() || []
          const match = voices.find(v => v.name === settings.ttsVoice || v.voiceURI === settings.ttsVoice)
          if (match) utter.voice = match
        }
      } catch (e) {
        // ignore voice selection errors
      }

      let phase = Math.random() * Math.PI * 2
      let ampInterval: number | null = null
      let spikeTimeout: number | null = null
      const startAmplitudeLoop = () => {
        // simulate a smoother amplitude envelope while speaking and dispatch global events
        ampInterval = window.setInterval(() => {
          const base = 0.08
          const mod = 0.9
          const raw = base + Math.abs(Math.sin(phase)) * mod
          const amp = Math.min(1, Math.max(0, raw * (settings.ttsVolume ?? 1)))
          window.dispatchEvent(new CustomEvent('nx:copilot-tts-amplitude', { detail: { amplitude: amp } }))
          phase += 0.35 + Math.random() * 0.25
        }, 64) as unknown as number
      }

      utter.onstart = () => {
        startAmplitudeLoop()
        window.dispatchEvent(new CustomEvent('nx:copilot-tts-amplitude', { detail: { amplitude: 0.5 * (settings.ttsVolume ?? 1) } }))
      }
      utter.onboundary = () => {
        // stronger spike on word boundaries, then decay to a mid-level value
        window.dispatchEvent(new CustomEvent('nx:copilot-tts-amplitude', { detail: { amplitude: Math.min(1, 0.95 * (settings.ttsVolume ?? 1)) } }))
        if (spikeTimeout) {
          window.clearTimeout(spikeTimeout)
          spikeTimeout = null
        }
        spikeTimeout = window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('nx:copilot-tts-amplitude', { detail: { amplitude: 0.55 * (settings.ttsVolume ?? 1) } }))
          spikeTimeout = null
        }, 120) as unknown as number
      }
      utter.onend = () => {
        if (ampInterval) {
          window.clearInterval(ampInterval)
          ampInterval = null
        }
        if (spikeTimeout) {
          window.clearTimeout(spikeTimeout)
          spikeTimeout = null
        }
        window.dispatchEvent(new CustomEvent('nx:copilot-tts-amplitude', { detail: { amplitude: 0 } }))
      }
      utter.onerror = (ev) => {
        // eslint-disable-next-line no-console
        console.error('Copilot TTS error', ev)
        if (ampInterval) {
          window.clearInterval(ampInterval)
          ampInterval = null
        }
        if (spikeTimeout) {
          window.clearTimeout(spikeTimeout)
          spikeTimeout = null
        }
        window.dispatchEvent(new CustomEvent('nx:copilot-tts-amplitude', { detail: { amplitude: 0 } }))
      }

      window.speechSynthesis.speak(utter)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Copilot TTS init error', err)
    }
  }, [messages, settings.copilotVoiceMode, settings.ttsPersona])

  const voice = useVoiceMode({
    onStart() {
      clearTimers()
      voiceTraceRaisedRef.current = false
      setLifecycleState('listening', 'voice', 'Voice mode activated', 'Live capture channel open.')
    },
    onInterim(text) {
      setCopilotState('transcribing')
      if (!voiceTraceRaisedRef.current) {
        addTrace('voice', 'Transcribing live input', text, 'transcribing')
        voiceTraceRaisedRef.current = true
      }
    },
    onTranscript(text) {
      addTrace('voice', 'Voice transcript captured', text, 'transcribing')
      handleSubmit(text, 'voice')
    },
    onEnd() {
      voiceTraceRaisedRef.current = false
      setCopilotState((current) => current === 'listening' || current === 'transcribing' ? 'idle' : current)
    },
    onError(error) {
      setLifecycleState('error', 'error', 'Voice channel degraded', error)
      addMessage('system', error, { state: 'error' })
    },
  })

  const helperText = useMemo(() => {
    if (voice.listening && voice.interimTranscript) return voice.interimTranscript
    if (voice.transcript) return voice.transcript
    return messages.find((message) => message.role !== 'operator')?.text ?? meta.helper
  }, [messages, meta.helper, voice.interimTranscript, voice.listening, voice.transcript])

  return {
    settings,
    copilotState,
    meta,
    room,
    model,
    permission,
    permissionMeta,
    input,
    setInput,
    inputRef,
    trace,
    recentTrace,
    messages,
    recentMessages,
    suggestions,
    quickActions,
    slashHints,
    planSteps,
    pendingIntent,
    commandHistory,
    recentCommands,
    livePreview,
    promptLabel,
    helperText,
    voice,
    handleSubmit,
    handleSuggestionAction,
    confirmIntent,
    rejectIntent,
    handleInputKeyDown,
    initializeRoomIntel,
    focusInput,
  }
}