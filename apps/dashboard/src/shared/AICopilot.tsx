/**
 * NEXUS AI Copilot — Sentient Intelligence Companion
 *
 * A living operator intelligence panel that expresses real states:
 * greeting → ready → listening → analyzing → thinking → drafting →
 * routing → sending → confirming → completed → waiting
 *
 * Features:
 * - Animated voice orb / neural core with reactive waveform
 * - Personalized operator greeting system
 * - Context-aware intelligence suggestions with confidence
 * - Action execution with progress feedback
 * - Transcript log with timestamps
 * - Voice mode activation
 *
 * Activated via ⌘J or the spark icon in the dock.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { playSound } from './sounds'
import { loadSettings } from './settings'

// ── Types ─────────────────────────────────────────────────────────────────

export type CopilotState =
  | 'greeting'
  | 'ready'
  | 'listening'
  | 'analyzing'
  | 'searching'
  | 'thinking'
  | 'drafting'
  | 'routing'
  | 'sending'
  | 'confirming'
  | 'completed'
  | 'waiting'
  | 'voice-active'

export interface CopilotSuggestion {
  id: string
  type: 'action' | 'insight' | 'warning' | 'brief'
  title: string
  detail: string
  confidence: number
  action?: string
  actionLabel?: string
}

export interface CopilotContext {
  surface: string
  entityType?: string
  entityId?: string
  entityLabel?: string
  hotCount?: number
  alertCount?: number
  pendingActions?: number
}

interface AICopilotProps {
  open: boolean
  context: CopilotContext
  onClose: () => void
  onAction?: (actionId: string) => void
}

// ── Greeting system ───────────────────────────────────────────────────────

function getTimeGreeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Late night session'
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  if (h < 21) return 'Good evening'
  return 'Late session'
}

function buildGreeting(ctx: CopilotContext): string[] {
  const settings = loadSettings()
  const name = settings.operatorName || 'Operator'
  const lines: string[] = []

  lines.push(`${getTimeGreeting()}, ${name}.`)
  lines.push('Dashboard is live.')

  if (ctx.hotCount && ctx.hotCount > 0) {
    lines.push(`${ctx.hotCount} hot lead${ctx.hotCount > 1 ? 's' : ''} require attention.`)
  }
  if (ctx.alertCount && ctx.alertCount > 3) {
    lines.push(`${ctx.alertCount} active alerts — review recommended.`)
  }
  if (ctx.pendingActions && ctx.pendingActions > 0) {
    lines.push(`${ctx.pendingActions} autopilot action${ctx.pendingActions > 1 ? 's' : ''} pending review.`)
  }

  return lines
}

// ── State expression ──────────────────────────────────────────────────────

const STATE_META: Record<CopilotState, { label: string; orbClass: string }> = {
  greeting:       { label: 'Initializing…',      orbClass: 'is-greeting' },
  ready:          { label: 'Ready',               orbClass: 'is-ready' },
  listening:      { label: 'Listening…',          orbClass: 'is-listening' },
  analyzing:      { label: 'Analyzing…',          orbClass: 'is-analyzing' },
  searching:      { label: 'Searching…',          orbClass: 'is-searching' },
  thinking:       { label: 'Thinking…',           orbClass: 'is-thinking' },
  drafting:       { label: 'Drafting…',           orbClass: 'is-drafting' },
  routing:        { label: 'Routing…',            orbClass: 'is-routing' },
  sending:        { label: 'Sending…',            orbClass: 'is-sending' },
  confirming:     { label: 'Confirming…',         orbClass: 'is-confirming' },
  completed:      { label: 'Intelligence Ready',  orbClass: 'is-completed' },
  waiting:        { label: 'Awaiting input…',     orbClass: 'is-waiting' },
  'voice-active': { label: 'Voice Active',        orbClass: 'is-voice' },
}

const TYPE_META: Record<CopilotSuggestion['type'], { icon: string; cls: string }> = {
  action:  { icon: 'zap',         cls: 'is-action' },
  insight: { icon: 'trending-up', cls: 'is-insight' },
  warning: { icon: 'alert',       cls: 'is-warning' },
  brief:   { icon: 'radar',       cls: 'is-brief' },
}

// ── Simulated intelligence ────────────────────────────────────────────────

function generateSuggestions(ctx: CopilotContext): CopilotSuggestion[] {
  const suggestions: CopilotSuggestion[] = []

  switch (ctx.surface) {
    case '/dashboard/live':
      suggestions.push({
        id: 'brief-home', type: 'brief', title: 'Dashboard Briefing',
        detail: `${ctx.hotCount ?? 0} hot leads require attention. ${ctx.alertCount ?? 0} alerts active. ${ctx.pendingActions ?? 0} autopilot actions pending review.`,
        confidence: 95,
      })
      if ((ctx.hotCount ?? 0) > 0) {
        suggestions.push({
          id: 'act-hot-leads', type: 'action', title: 'Prioritize Hot Leads',
          detail: 'Hot leads have been waiting. Engage top-urgency leads within the next hour for maximum conversion probability.',
          confidence: 88, action: 'focus-hot', actionLabel: 'Focus Hot',
        })
      }
      if ((ctx.alertCount ?? 0) > 3) {
        suggestions.push({
          id: 'warn-alerts', type: 'warning', title: 'Alert Volume Elevated',
          detail: `${ctx.alertCount} active alerts exceeds the daily average. Review critical alerts in Alerts.`,
          confidence: 92, action: 'go-alerts', actionLabel: 'Open Alerts',
        })
      }
      suggestions.push({
        id: 'insight-pipeline', type: 'insight', title: 'Pipeline Velocity',
        detail: 'Pipeline velocity is tracking 12% above weekly average. Market pressure concentrated in Dallas and Phoenix metros.',
        confidence: 76,
      })
      break
    case '/inbox':
      suggestions.push({
        id: 'brief-inbox', type: 'brief', title: 'Inbox Intelligence',
        detail: 'Threads requiring response detected. AI drafts ready for review. Prioritize hot sentiment threads first.',
        confidence: 90,
      })
      suggestions.push({
        id: 'act-batch-reply', type: 'action', title: 'Batch AI Replies',
        detail: 'AI has pre-drafted responses for unread threads. Review and approve in batch for faster throughput.',
        confidence: 82, action: 'batch-reply', actionLabel: 'Review Drafts',
      })
      suggestions.push({
        id: 'insight-comms', type: 'insight', title: 'Response Pattern',
        detail: 'Reply rates peak between 10am–2pm local. Scheduling sends in this window increases engagement by 23%.',
        confidence: 71,
      })
      break
    case '/alerts':
      suggestions.push({
        id: 'brief-alerts', type: 'brief', title: 'Alerts Briefing',
        detail: 'Active alerts span multiple markets. Critical items need immediate acknowledgment. P0 alerts age faster.',
        confidence: 94,
      })
      suggestions.push({
        id: 'act-ack-critical', type: 'action', title: 'Acknowledge Critical',
        detail: 'Unacknowledged P0 alerts degrade system health score. Clear highest-severity items first.',
        confidence: 90, action: 'ack-alerts', actionLabel: 'Review P0',
      })
      break
    case '/markets':
      suggestions.push({
        id: 'brief-markets', type: 'brief', title: 'Operations Intelligence',
        detail: 'Market coverage nominal. Delivery rates stable. Phoenix showing accelerating pressure.',
        confidence: 87,
      })
      break
    case '/buyer':
      suggestions.push({
        id: 'brief-buyer', type: 'brief', title: 'Capital Deployment Brief',
        detail: 'Active buyer pool healthy. Match quality averaging 78%. Pre-approved buyers: 62% of active pool.',
        confidence: 83,
      })
      break
    case '/title':
      suggestions.push({
        id: 'brief-title', type: 'brief', title: 'Execution Status',
        detail: 'Title pipeline normal. No critical blockers. Average days-in-phase within acceptable range.',
        confidence: 89,
      })
      break
    default:
      suggestions.push({
        id: 'brief-general', type: 'brief', title: 'NEXUS Intelligence',
        detail: 'System operating normally. No anomalies detected across active markets.',
        confidence: 85,
      })
      break
  }
  return suggestions
}

// ── Voice Orb ─────────────────────────────────────────────────────────────

const VoiceOrb = ({ state, voiceActive, onVoiceToggle }: {
  state: CopilotState; voiceActive: boolean; onVoiceToggle: () => void
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const size = 120
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.scale(dpr, dpr)

    let frame = 0
    const isActive = voiceActive || state === 'listening' || state === 'analyzing' || state === 'thinking' || state === 'searching'

    const draw = () => {
      frame++
      ctx.clearRect(0, 0, size, size)
      const cx = size / 2, cy = size / 2

      const glowR = 48 + (isActive ? Math.sin(frame * 0.04) * 4 : Math.sin(frame * 0.015) * 1.5)
      const grad = ctx.createRadialGradient(cx, cy, glowR * 0.6, cx, cy, glowR)

      let hue = '56, 208, 240'
      if (state === 'thinking' || state === 'analyzing' || state === 'searching') hue = '153, 102, 255'
      if (state === 'drafting' || state === 'sending') hue = '44, 184, 122'
      if (state === 'greeting') hue = '56, 208, 240'
      if (state === 'completed') hue = '44, 184, 122'
      if (voiceActive) hue = '56, 208, 240'

      const intensity = isActive ? 0.35 : 0.15
      grad.addColorStop(0, `rgba(${hue}, ${intensity})`)
      grad.addColorStop(1, `rgba(${hue}, 0)`)
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(cx, cy, glowR, 0, Math.PI * 2)
      ctx.fill()

      const coreR = isActive ? 22 + Math.sin(frame * 0.06) * 3 : 20 + Math.sin(frame * 0.02) * 1
      const coreG = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR)
      coreG.addColorStop(0, `rgba(${hue}, 0.8)`)
      coreG.addColorStop(0.5, `rgba(${hue}, 0.4)`)
      coreG.addColorStop(1, `rgba(${hue}, 0.05)`)
      ctx.fillStyle = coreG
      ctx.beginPath()
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
      ctx.fill()

      if (isActive) {
        const rings = voiceActive ? 5 : 3
        for (let i = 0; i < rings; i++) {
          const phase = (frame * 0.03 + i * 0.7) % (Math.PI * 2)
          const ringR = coreR + 6 + i * 6 + Math.sin(phase) * 3
          ctx.strokeStyle = `rgba(${hue}, ${Math.max(0.15 - i * 0.03, 0.02)})`
          ctx.lineWidth = 1.2
          ctx.beginPath()
          ctx.arc(cx, cy, ringR, 0, Math.PI * 2)
          ctx.stroke()
        }
      }

      ctx.fillStyle = `rgba(255, 255, 255, ${isActive ? 0.9 : 0.5})`
      ctx.beginPath()
      ctx.arc(cx, cy, 2.5, 0, Math.PI * 2)
      ctx.fill()

      animRef.current = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(animRef.current)
  }, [state, voiceActive])

  return (
    <div className="nx-copilot__orb-wrap">
      <canvas ref={canvasRef} className="nx-copilot__orb-canvas" style={{ width: 120, height: 120 }} />
      <button
        type="button"
        className={`nx-copilot__voice-btn ${voiceActive ? 'is-active' : ''}`}
        onClick={onVoiceToggle}
        title={voiceActive ? 'Stop voice' : 'Start voice'}
      >
        <Icon name={voiceActive ? 'pause' : 'play'} className="nx-copilot__voice-icon" />
      </button>
    </div>
  )
}

// ── Thinking indicator ────────────────────────────────────────────────────

const ThinkingIndicator = ({ state }: { state: CopilotState }) => {
  const labels: Partial<Record<CopilotState, string>> = {
    analyzing: 'Analyzing signals…', searching: 'Searching intelligence…',
    thinking: 'Processing…', drafting: 'Drafting response…',
    routing: 'Routing action…', sending: 'Sending…', confirming: 'Confirming…',
  }
  const label = labels[state]
  if (!label) return null
  return (
    <div className="nx-copilot__thinking">
      <div className="nx-copilot__thinking-dots"><span /><span /><span /></div>
      <span className="nx-copilot__thinking-label">{label}</span>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────

export const AICopilot = ({ open, context, onClose, onAction }: AICopilotProps) => {
  const [state, setState] = useState<CopilotState>('ready')
  const [suggestions, setSuggestions] = useState<CopilotSuggestion[]>([])
  const [transcript, setTranscript] = useState<string[]>([])
  const [greeting, setGreeting] = useState<string[]>([])
  const [greetingIdx, setGreetingIdx] = useState(0)
  const [voiceActive, setVoiceActive] = useState(false)
  const [actionProgress, setActionProgress] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const prevContextRef = useRef<string>('')

  const addTranscript = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    setTranscript((prev) => [...prev.slice(-29), `[${ts}] ${msg}`])
  }, [])

  // Greeting sequence on open
  useEffect(() => {
    if (!open) return
    const lines = buildGreeting(context)
    setGreeting(lines)
    setGreetingIdx(0)
    setState('greeting')
    addTranscript('Session initialized')

    let idx = 0
    const timer = setInterval(() => {
      idx++
      if (idx < lines.length) {
        setGreetingIdx(idx)
      } else {
        clearInterval(timer)
        setState('analyzing')
        addTranscript(`Context: ${context.surface}`)
      }
    }, 600)
    return () => clearInterval(timer)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Analysis sequence
  useEffect(() => {
    if (!open || state !== 'analyzing') return
    const t1 = setTimeout(() => { setState('searching'); addTranscript('Searching intelligence…') }, 400)
    const t2 = setTimeout(() => { setState('thinking'); addTranscript('Processing signals…'); playSound('ai-response') }, 900)
    const t3 = setTimeout(() => {
      const results = generateSuggestions(context)
      setSuggestions(results)
      setState('completed')
      addTranscript(`Generated ${results.length} intelligence items`)
    }, 1600)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [open, state === 'analyzing']) // eslint-disable-line react-hooks/exhaustive-deps

  // Context change detection
  useEffect(() => {
    if (!open) return
    if (prevContextRef.current && prevContextRef.current !== context.surface && state === 'completed') {
      setState('analyzing')
      addTranscript(`Context shift: ${context.surface}`)
    }
    prevContextRef.current = context.surface
  }, [open, context.surface]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleVoice = useCallback(() => {
    setVoiceActive((prev) => {
      if (!prev) { setState('voice-active'); playSound('copilot-wake'); addTranscript('Voice mode activated') }
      else { setState(suggestions.length > 0 ? 'completed' : 'ready'); addTranscript('Voice mode deactivated') }
      return !prev
    })
  }, [suggestions.length, addTranscript])

  const executeAction = useCallback((actionId: string, label: string) => {
    setActionProgress(actionId)
    setState('routing')
    addTranscript(`Executing: ${label}`)
    playSound('ui-confirm')
    setTimeout(() => setState('sending'), 300)
    setTimeout(() => { setState('confirming'); addTranscript(`Confirmed: ${label}`) }, 700)
    setTimeout(() => { setState('completed'); setActionProgress(null); onAction?.(actionId) }, 1100)
  }, [onAction, addTranscript])

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) { setState('ready'); setSuggestions([]); setVoiceActive(false); setActionProgress(null) }
    else { panelRef.current?.scrollTo({ top: 0 }) }
  }, [open])

  if (!open) return null

  const meta = STATE_META[state]
  const settings = loadSettings()
  const assistantName = settings.assistantName || 'NEXUS'

  return (
    <aside className="nx-copilot" ref={panelRef} role="complementary" aria-label="AI Copilot">
      <header className="nx-copilot__header">
        <div className="nx-copilot__title-row">
          <div className={`nx-copilot__status-orb ${meta.orbClass}`} />
          <div className="nx-copilot__title-text">
            <h2 className="nx-copilot__title">{assistantName}</h2>
            <span className="nx-copilot__state">{meta.label}</span>
          </div>
        </div>
        <button type="button" className="nx-copilot__close" onClick={onClose} title="Close (Escape)">
          <Icon name="close" className="nx-copilot__close-icon" />
        </button>
      </header>

      <VoiceOrb state={state} voiceActive={voiceActive} onVoiceToggle={toggleVoice} />

      {greeting.length > 0 && (
        <div className="nx-copilot__greeting">
          {greeting.slice(0, greetingIdx + 1).map((line, i) => (
            <p key={i} className={`nx-copilot__greeting-line ${i === greetingIdx ? 'is-latest' : ''}`}>{line}</p>
          ))}
        </div>
      )}

      <ThinkingIndicator state={state} />

      {suggestions.length > 0 && (
        <div className="nx-copilot__suggestions">
          {suggestions.map((s) => {
            const tm = TYPE_META[s.type]
            const isExec = actionProgress === (s.action ?? s.id)
            return (
              <div key={s.id} className={`nx-copilot-card ${tm.cls} ${isExec ? 'is-executing' : ''}`}>
                <div className="nx-copilot-card__header">
                  <Icon name={tm.icon as Parameters<typeof Icon>[0]['name']} className="nx-copilot-card__icon" />
                  <span className="nx-copilot-card__title">{s.title}</span>
                  <span className="nx-copilot-card__confidence">{s.confidence}%</span>
                </div>
                <p className="nx-copilot-card__detail">{s.detail}</p>
                {s.actionLabel && (
                  <button type="button" className="nx-copilot-card__action" disabled={!!actionProgress}
                    onClick={() => executeAction(s.action ?? s.id, s.actionLabel!)}>
                    {isExec ? 'Executing…' : s.actionLabel}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {transcript.length > 0 && (
        <div className="nx-copilot__transcript">
          <span className="nx-copilot__transcript-label">ACTIVITY LOG</span>
          {transcript.map((msg, i) => (
            <span key={`${msg}-${i}`} className="nx-copilot__transcript-line">{msg}</span>
          ))}
        </div>
      )}
    </aside>
  )
}
