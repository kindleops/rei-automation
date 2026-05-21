import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import type { ThreadContext, ThreadIntelligenceRecord } from '../../../lib/data/inboxData'
import { Icon } from '../../../shared/icons'
import { COPILOT_AGENTS, DEFAULT_AGENT_ID, getAgentById, type CopilotAgent } from './agents'
import { extractCopilotContext, type BigPickleDraft } from './copilot-context'
import { detectPropertyCategory } from '../helpers/propertyHelpers'
import { CopilotOrb } from '../../../shared/copilot/CopilotOrb'
import * as BigPickle from '../../copilot/providers/bigPickleProvider'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')


export const CopilotOrbTrigger = ({
  onClick,
  active = false,
  isReady = true,
  size = 'md',
}: {
  onClick?: any
  active?: boolean
  isReady?: boolean
  size?: string
}) => (
  <button
    type="button"
    className={cls('nx-copilot-orb-trigger', active && 'is-active', !isReady && 'is-disabled', `is-${size}`)}
    onClick={(event) => onClick?.(event)}
  >
    <CopilotOrb
      state={active ? 'listening' : 'idle'}
      amplitude={active ? 0.4 : 0}
      onClick={() => onClick?.()}
      onPushToTalk={() => {}}
      onPushToTalkRelease={() => {}}
    />
  </button>
)

/* ── Types ─────────────────────────────────────────────────────── */

interface CopilotMessage {
  id: string
  role: 'agent' | 'operator' | 'system'
  agentId: string
  body: string
  timestamp: string
  status?: 'thinking' | 'complete' | 'error'
  steps?: Array<{ label: string; status: 'pending' | 'active' | 'done' | 'error' }>
  draft?: BigPickleDraft | null
  actions?: string[]
  voiceList?: SpeechSynthesisVoice[]
  underwritingData?: any
}

const SLASH_COMMANDS = [
  { cmd: '/draft', label: 'Draft Reply', desc: 'Generate a Big Pickle draft' },
  { cmd: '/voice', label: 'Voices', desc: 'Switch auditory agent profiles' },
  { cmd: '/summarize', label: 'Summarize', desc: 'Summarize this thread' },
  { cmd: '/underwrite', label: 'Underwrite', desc: 'Run AI Comps & Numbers' },
  { cmd: '/help', label: 'Help', desc: 'Show available commands' },
]

/* ── Components ────────────────────────────────────────────────── */

const UnderwritingResultCard = ({ data }: { data: any }) => (
  <div className="nx-copilot-underwrite-card nx-liquid-panel">
    <div className="nx-underwrite-header">
      <div className="nx-underwrite-title">
        <Icon name="spark" />
        <span>OFFER INTELLIGENCE</span>
      </div>
      <div className={cls('nx-underwrite-badge', `is-${data.valuation.verdict}`)}>
        {data.valuation.verdict.toUpperCase()} ({data.valuation.score}/100)
      </div>
    </div>
    
    <div className="nx-underwrite-stats">
      <div className="nx-underwrite-stat">
        <label>ARV</label>
        <strong>{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(data.valuation.arv_estimate)}</strong>
      </div>
      <div className="nx-underwrite-stat">
        <label>MAO</label>
        <strong>{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(data.valuation.mao)}</strong>
      </div>
      <div className="nx-underwrite-stat">
        <label>PROFIT</label>
        <strong>{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(data.valuation.assignmentFee)}</strong>
      </div>
    </div>

    <div className="nx-underwrite-comps">
      <div className="nx-comps-label">Verified Sold Comps:</div>
      {data.comps.slice(0, 3).map((comp: any, i: number) => (
        <a key={i} href={comp.source_url} target="_blank" rel="noreferrer" className="nx-comp-row">
          <span>{comp.address}</span>
          <strong>${comp.price.toLocaleString()}</strong>
        </a>
      ))}
    </div>
  </div>
)

const VoiceWaves = ({ isActive, color }: { isActive: boolean, color: string }) => (
  <div className="nx-copilot-voice-waves" style={{ '--agent-accent': color } as any}>
    {Array.from({ length: 5 }).map((_, i) => (
      <div 
        key={i} 
        className={cls('nx-voice-wave-bar', isActive && 'is-active')} 
        style={{ animationDelay: `${i * 0.1}s` }} 
      />
    ))}
  </div>
)

const MessageCard = ({ msg, onAction }: { msg: CopilotMessage; onAction: (action: string) => void }) => {
  const agent = getAgentById(msg.agentId)
  const isAgent = msg.role === 'agent'
  const isSystem = msg.role === 'system'
  return (
    <div className={cls('nx-copilot-msg', isAgent && 'is-agent', !isAgent && !isSystem && 'is-operator', isSystem && 'is-system', msg.status === 'thinking' && 'is-thinking')}>
      {isAgent && <span className="nx-copilot-msg__avatar">{agent.avatarEmoji}</span>}
      <div className="nx-copilot-msg__content">
        {isAgent && <span className="nx-copilot-msg__name">{agent.name}</span>}
        <div className="nx-copilot-msg__body">{msg.body}</div>
        
        {msg.steps && (
          <div className="nx-copilot-steps">
            {msg.steps.map((step, i) => (
              <div key={i} className={cls('nx-copilot-step', `is-${step.status}`)}>
                <span className="nx-step-icon">
                  {step.status === 'done' ? '✅' : step.status === 'active' ? '🧬' : step.status === 'error' ? '❌' : '◦'}
                </span>
                <span className="nx-step-label">{step.label}</span>
              </div>
            ))}
          </div>
        )}

        {msg.underwritingData && <UnderwritingResultCard data={msg.underwritingData} />}

        {msg.draft && (
          <div className="nx-copilot-draft-card nx-liquid-panel">
            <div className="nx-copilot-draft-card__header">
              <span>🥒 Big Pickle Draft</span>
              <span className="nx-copilot-draft-card__badge">{msg.draft.sellerSafe ? '✅ Seller Safe' : '⚠️ Review'}</span>
            </div>
            <p className="nx-copilot-draft-card__body">{msg.draft.draftBody}</p>
            <div className="nx-copilot-draft-card__actions">
              <button type="button" className="nx-copilot-action-btn is-primary" onClick={() => onAction('queue_draft')}>
                <Icon name="clock" /> Queue Reply
              </button>
              <button type="button" className="nx-copilot-action-btn" onClick={() => onAction('edit_draft')}>
                <Icon name="file-text" /> Edit
              </button>
            </div>
          </div>
        )}
        {msg.voiceList && (
          <div className="nx-copilot-voice-grid nx-liquid-panel">
            <div className="nx-copilot-voice-grid__header">
              <span>🔊 Available Neural Voices</span>
              <small>{msg.voiceList.length} discovered</small>
            </div>
            <div className="nx-copilot-voice-list">
              {msg.voiceList.map(v => (
                <button 
                  key={v.voiceURI} 
                  type="button" 
                  className="nx-copilot-voice-item"
                  onClick={() => onAction(`select_voice:${v.voiceURI}`)}
                >
                  <Icon name="volume" />
                  <div className="nx-copilot-voice-info">
                    <strong>{v.name}</strong>
                    <small>{v.lang}</small>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
        <time className="nx-copilot-msg__time">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      </div>
    </div>
  )
}

const AgentSwitcher = ({ agents, activeId, onSelect, open, onToggle }: {
  agents: CopilotAgent[]
  activeId: string
  onSelect: (id: string) => void
  open: boolean
  onToggle: () => void
}) => (
  <div className="nx-copilot-switcher">
    <button type="button" className="nx-copilot-switcher__trigger" onClick={onToggle}>
      <span className="nx-copilot-switcher__emoji">{getAgentById(activeId).avatarEmoji}</span>
      <span>{getAgentById(activeId).name}</span>
      <Icon name="chevron-down" />
    </button>
    {open && (
      <div className="nx-copilot-switcher__menu nx-liquid-panel">
        {agents.map(a => (
          <button key={a.id} type="button"
            className={cls('nx-copilot-switcher__item', a.id === activeId && 'is-active')}
            onClick={() => { onSelect(a.id); onToggle() }}>
            <span className="nx-copilot-switcher__item-emoji">{a.avatarEmoji}</span>
            <div className="nx-copilot-switcher__item-info">
              <strong>{a.name}</strong>
              <small>{a.role}</small>
            </div>
          </button>
        ))}
      </div>
    )}
  </div>
)

/* ── Main Panel ────────────────────────────────────────────────── */

export const AICopilotPanel = ({
  thread, context, intelligence, onClose, onInsertDraft,
}: {
  thread: InboxWorkflowThread | null
  context: ThreadContext | null
  intelligence: ThreadIntelligenceRecord | null
  onClose: () => void
  onInsertDraft?: (text: string) => void
}) => {
  const [agentId, setAgentId] = useState(DEFAULT_AGENT_ID)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [inputText, setInputText] = useState('')
  const [messages, setMessages] = useState<CopilotMessage[]>([])
  const [isTyping, setIsTyping] = useState(false)
  const [isVoiceMode, setIsVoiceMode] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoiceURI, setSelectedVoiceURI] = useState<string>('')
  const [slashOpen, setSlashOpen] = useState(false)
  
  const synthesisRef = useRef<SpeechSynthesis | null>(typeof window !== 'undefined' ? window.speechSynthesis : null)
  const recognitionRef = useRef<any>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)

  const agent = useMemo(() => getAgentById(agentId), [agentId])
  const copilotCtx = useMemo(() => extractCopilotContext(thread, context, intelligence), [thread, context, intelligence])

  /* ── Voice Engine ──────────────────────────────────────────────── */

  useEffect(() => {
    if (!synthesisRef.current) return
    const loadVoices = () => {
      const voices = synthesisRef.current!.getVoices()
      setAvailableVoices(voices)
      if (voices.length > 0 && !selectedVoiceURI) {
        const preferred = voices.find(v => v.name.includes('Samantha') || v.name.includes('Google') || v.lang.startsWith('en-US'))
        setSelectedVoiceURI(preferred?.voiceURI || voices[0].voiceURI)
      }
    }
    loadVoices()
    synthesisRef.current.onvoiceschanged = loadVoices
  }, [selectedVoiceURI])

  const speakMessage = useCallback((text: string) => {
    if (!synthesisRef.current || !isVoiceMode) return
    synthesisRef.current.cancel()
    
    const utterance = new SpeechSynthesisUtterance(text.replace(/\*\*.*?\*\*/g, '').replace(/🥒|🎯|🔥|✨/g, ''))
    const voice = availableVoices.find(v => v.voiceURI === selectedVoiceURI)
    if (voice) utterance.voice = voice
    utterance.pitch = agent.voiceProfile.pitch
    utterance.rate = agent.voiceProfile.rate
    
    utterance.onstart = () => setIsSpeaking(true)
    utterance.onend = () => setIsSpeaking(false)
    utterance.onerror = () => setIsSpeaking(false)
    
    synthesisRef.current.speak(utterance)
  }, [isVoiceMode, availableVoices, selectedVoiceURI, agent])

  /* ── Dictation Logic ─────────────────────────────────────────── */

  useEffect(() => {
    if (typeof window === 'undefined') return
    const SpeechRec = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition
    if (isVoiceMode && SpeechRec && !recognitionRef.current) {
      const rec = new SpeechRec()
      rec.continuous = true
      rec.interimResults = true
      rec.lang = 'en-US'
      
      rec.onresult = (event: any) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            const transcript = event.results[i][0].transcript
            setInputText(prev => (prev.trim() + ' ' + transcript).trim())
          }
        }
      }
      recognitionRef.current = rec
    }

    if (isVoiceMode && recognitionRef.current) {
      try { recognitionRef.current.start() } catch (e) {}
    } else {
      recognitionRef.current?.stop()
    }

    return () => recognitionRef.current?.stop()
  }, [isVoiceMode])

  /* ── Handlers ────────────────────────────────────────────────── */

  const handleSend = useCallback(async (manualText?: string) => {
    const text = manualText || inputText.trim()
    if (!text) return

    setMessages(prev => [...prev, {
      id: `op-${Date.now()}`,
      role: 'operator',
      agentId,
      body: text,
      timestamp: new Date().toISOString(),
    }])

    setInputText('')
    setIsTyping(true)

    const lowerText = text.toLowerCase()

    // ── Command: /underwrite ────────────────────────────────────
    if (lowerText.includes('/underwrite') || lowerText.includes('underwrite')) {
      setIsTyping(false)
      if (!thread) {
        const body = "I need thread context to run underwriting. Select a conversation first!"
        setMessages(prev => [...prev, { id: `agent-${Date.now()}`, role: 'agent', agentId, body, timestamp: new Date().toISOString() }])
        speakMessage(body)
        return
      }

      const msgId = `agent-${Date.now()}`
      const initialSteps: CopilotMessage['steps'] = [
        { label: 'Initializing Research Engine', status: 'active' },
        { label: 'Scraping Market Sold Comps', status: 'pending' },
        { label: 'Analyzing Neighborhood Velocity', status: 'pending' },
        { label: 'Deterministic Financial Validation', status: 'pending' },
      ]

      setMessages(prev => [...prev, { 
        id: msgId, 
        role: 'agent', 
        agentId, 
        body: `I'm initiating an ELITE deep-dive underwriting for **${thread.propertyAddress || thread.subject}**. Standing by...`, 
        timestamp: new Date().toISOString(),
        status: 'thinking',
        steps: initialSteps
      }])

      // Self-executing async wrapper
      const run = async () => {
        try {
          await new Promise(r => setTimeout(r, 1000))
          setMessages(prev => prev.map(m => m.id === msgId ? {
            ...m,
            steps: m.steps?.map((s, i) => i === 0 ? { ...s, status: 'done' } : i === 1 ? { ...s, status: 'active' } : s)
          } : m))

          const res = await fetch('/api/internal/offers/underwrite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              address: thread.propertyAddress || thread.subject, 
              propertyType: detectPropertyCategory(thread)
            })
          })
          const data = await res.json()
          if (data.error) throw new Error(data.error)

          await new Promise(r => setTimeout(r, 1000))
          setMessages(prev => prev.map(m => m.id === msgId ? {
            ...m,
            steps: m.steps?.map((s, i) => i === 1 ? { ...s, status: 'done' } : i === 2 ? { ...s, status: 'active' } : s)
          } : m))

          await new Promise(r => setTimeout(r, 1000))
          setMessages(prev => prev.map(m => m.id === msgId ? {
            ...m,
            steps: m.steps?.map((s, i) => i === 2 ? { ...s, status: 'done' } : i === 3 ? { ...s, status: 'active' } : s)
          } : m))

          await new Promise(r => setTimeout(r, 800))
          const finalBody = `Elite underwriting complete. I've analyzed verified sold data and neighborhood trends. **${data.valuation.verdict.toUpperCase()}** opportunity identified.`
          
          setMessages(prev => prev.map(m => m.id === msgId ? {
            ...m,
            body: finalBody,
            status: 'complete',
            steps: m.steps?.map(s => ({ ...s, status: 'done' })),
            underwritingData: data
          } : m))
          
          speakMessage(`Research complete. Verdict is ${data.valuation.verdict}.`)
        } catch (err) {
          setMessages(prev => prev.map(m => m.id === msgId ? {
            ...m,
            body: `❌ **Underwriting Error:** ${err instanceof Error ? err.message : String(err)}`,
            status: 'error',
            steps: m.steps?.map(s => s.status === 'active' ? { ...s, status: 'error' } : s)
          } : m))
        }
      }
      void run()
      return
    }

    // ── Command: /draft ─────────────────────────────────────────
    if (lowerText.includes('/draft') || lowerText.includes('pickle')) {
      if (!copilotCtx) {
        setIsTyping(false)
        const body = "I need thread context to generate a draft. Select a conversation first!"
        setMessages(prev => [...prev, { id: `agent-${Date.now()}`, role: 'agent', agentId, body, timestamp: new Date().toISOString() }])
        speakMessage(body)
        return
      }
      const { data: draft, state } = await BigPickle.draftSellerReply(copilotCtx)
      setIsTyping(false)
      const body = state === 'connected' ? `✨ **Big Pickle Draft** ready.` : `🥒 Draft prepared (Mock).`
      setMessages(prev => [...prev, { id: `agent-${Date.now()}`, role: 'agent', agentId, body, timestamp: new Date().toISOString(), draft }])
      speakMessage(body)
      return
    }

    // ── Command: /summarize ─────────────────────────────────────
    if (lowerText.includes('/summarize')) {
      if (!copilotCtx) { setIsTyping(false); return }
      const { data: summary } = await BigPickle.summarizeThread(copilotCtx)
      setIsTyping(false)
      setMessages(prev => [...prev, { id: `agent-${Date.now()}`, role: 'agent', agentId, body: `📝 **Summary:** ${summary}`, timestamp: new Date().toISOString() }])
      speakMessage(summary)
      return
    }

    // ── Fallback Chat ───────────────────────────────────────────
    setTimeout(() => {
      setIsTyping(false)
      const body = `I've acknowledged your request. As your ${agent.name}, I'm standing by to assist with drafting, summarizing, or underwriting this deal.`
      setMessages(prev => [...prev, { id: `agent-${Date.now()}`, role: 'agent', agentId, body, timestamp: new Date().toISOString() }])
      speakMessage(body)
    }, 800)

  }, [inputText, agentId, thread, agent.name, speakMessage, copilotCtx])

  const handleAction = useCallback((action: string) => {
    if (action.startsWith('select_voice:')) {
      const uri = action.split(':')[1]
      setSelectedVoiceURI(uri)
      const voice = availableVoices.find(v => v.voiceURI === uri)
      const body = `Auditory profile switched to **${voice?.name || 'Selected Voice'}**. How do I sound?`
      setMessages(prev => [...prev, {
        id: `sys-${Date.now()}`,
        role: 'system',
        agentId,
        body,
        timestamp: new Date().toISOString()
      }])
      const synthesis = window.speechSynthesis
      synthesis.cancel()
      const utterance = new SpeechSynthesisUtterance("Voice profile updated. Standing by for commands.")
      if (voice) utterance.voice = voice
      synthesis.speak(utterance)
      return
    }

    if (action === 'queue_draft' || action === 'edit_draft') {
      const lastDraft = [...messages].reverse().find(m => m.draft)
      if (lastDraft?.draft && onInsertDraft) {
        onInsertDraft(lastDraft.draft.draftBody)
      }
    }
  }, [messages, onInsertDraft, agentId, availableVoices])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping])

  // Welcome message
  useEffect(() => {
    if (messages.length === 0) {
      const body = `Hey! I'm your **${agent.name}** — ${agent.role}. I'm standing by to help you accelerate this deal. What would you like me to do?`
      setMessages([{
        id: `sys-welcome`,
        role: 'agent',
        agentId: agent.id,
        body,
        timestamp: new Date().toISOString(),
      }])
    }
  }, [agent.id, agent.name, agent.role, messages.length])

  const providerState = useMemo(() => BigPickle.getProviderState(), [])

  return (
    <aside className="nx-copilot-panel">
      <header className="nx-copilot-header">
        <div className="nx-copilot-header__identity">
          <CopilotOrb 
            state={isTyping ? 'analyzing' : isSpeaking ? 'speaking' : 'idle'}
            amplitude={isSpeaking ? 0.3 : 0}
            onClick={() => {}}
            onPushToTalk={() => {}}
            onPushToTalkRelease={() => {}}
            className="is-sm"
          />
          <div className="nx-copilot-header__info">
            <div className="nx-copilot-header__title-row">
              <strong>{agent.name}</strong>
              <span className="nx-copilot-header__version">v2.1-ELITE</span>
              <span className={cls('nx-provider-badge', `is-${providerState}`)}>
                {providerState === 'connected' ? 'CONNECTED' : providerState === 'mock_mode' ? 'MOCK MODE' : 'OFFLINE'}
              </span>
            </div>
            <span className="nx-copilot-header__status">{agent.role}</span>
          </div>
          <VoiceWaves isActive={isSpeaking} color={agent.accentColor} />
        </div>

        <div className="nx-copilot-header__actions">
          <button 
            type="button" 
            className={cls('nx-copilot-header__badge nx-voice-mode-toggle', isVoiceMode && 'is-active')}
            onClick={() => setIsVoiceMode(!isVoiceMode)}
          >
            <Icon name={isVoiceMode ? 'mic' : 'volume'} />
            <span>VOICE</span>
          </button>
          <button type="button" onClick={onClose} className="nx-copilot-close-btn">
            <Icon name="close" />
          </button>
        </div>
      </header>

      <AgentSwitcher agents={COPILOT_AGENTS} activeId={agentId} onSelect={setAgentId} open={switcherOpen} onToggle={() => setSwitcherOpen(!switcherOpen)} />

      <div className="nx-copilot-chat">
        {messages.map(msg => <MessageCard key={msg.id} msg={msg} onAction={handleAction} />)}
        {isTyping && <div className="nx-copilot-typing nx-liquid-panel">Thinking...</div>}
        <div ref={chatEndRef} />
      </div>

      <div className="nx-copilot-input-area">
        {slashOpen && (
          <div className="nx-copilot-slash-menu nx-liquid-panel">
            {SLASH_COMMANDS.map(c => (
              <button 
                key={c.cmd} 
                type="button" 
                className="nx-copilot-slash-item"
                onClick={() => { setInputText(c.cmd + ' '); setSlashOpen(false) }}
              >
                <kbd>{c.cmd}</kbd>
                <span>{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        <div className="nx-copilot-input-row">
          <textarea
            value={inputText}
            onChange={e => {
              setInputText(e.target.value)
              setSlashOpen(e.target.value === '/')
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
              if (e.key === 'Escape') setSlashOpen(false)
            }}
            placeholder={`Ask ${agent.name}... (/ for commands)`}
            rows={1}
          />
          <button type="button" className="nx-copilot-send-btn" onClick={() => handleSend()}>
            <Icon name="send" />
          </button>
        </div>
      </div>
    </aside>
  )
}
