import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ThreadMessage } from '../../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { Icon } from '../../../shared/icons'
import { InboxStreetViewThumb } from './InboxStreetViewThumb'
import { formatCurrency, formatMessageDateTime, formatPercent } from '../../../shared/formatters'
import { buildConversationDecision } from '../../../domain/inbox/inbox-decisioning'
import { resolveThreadTemperature } from '../status-visuals'
import { buildPropertyExternalLinks } from '../../../domain/inbox/inbox-normalization'
import { getThreadMatchedKeywords, resolveThreadAddressLine, resolveThreadMarketBadge, resolveThreadOwnerName, resolveThreadPrimaryName } from '../inbox-ui-helpers'
import type { PropertyParticipant } from '../utils/participantLabels'
import { ThreadStateBar } from './ThreadStateBar'
import { usePhase3Intelligence } from '../hooks/usePhase3Intelligence'
import { markDealDeskMount } from '../../../domain/inbox/deal-desk-runtime-proof'
import type { ViewLayoutMode } from '../../../domain/inbox/view-layout'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

function MobileHeaderActionsMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; minWidth: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    if (!open || !btnRef.current) {
      setMenuPos(null)
      return
    }
    const update = () => {
      const rect = btnRef.current?.getBoundingClientRect()
      if (!rect) return
      setMenuPos({ top: rect.bottom + 4, left: rect.left, minWidth: 156 })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (btnRef.current?.contains(target)) return
      if (target.closest('[data-mobile-header-actions-menu]')) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const menu = open && menuPos && typeof document !== 'undefined'
    ? createPortal(
      <div
        className="nx-conv-dropdown-portal nx-mobile-header-actions-portal"
        role="menu"
        data-mobile-header-actions-menu
        style={{ top: menuPos.top, left: menuPos.left, minWidth: menuPos.minWidth }}
        onClick={() => setOpen(false)}
      >
        {children}
      </div>,
      document.body,
    )
    : null

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={cls('nx-conv-back', 'nx-mobile-header-actions-trigger', open && 'is-open')}
        aria-label="Thread actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="nx-conv-back__glyph" aria-hidden="true">
          <Icon name="more" />
        </span>
      </button>
      {menu}
    </>
  )
}

interface ChatThreadProps {
  thread: InboxWorkflowThread | null
  messages: ThreadMessage[]
  loading: boolean
  isSuppressed: boolean
  isStarred?: boolean
  onTogglePin?: () => void
  onToggleStar?: () => void
  onToggleArchive?: () => void
  onThreadAction?: (id: string, action: string, payload?: Record<string, unknown>) => void
  onOpenDebug?: () => void
  searchQuery?: string
  layoutMode?: ViewLayoutMode
  threadTranslations?: Record<string, string>
  sellerLanguageLabel?: string
  isTranslatingThread?: boolean
  onTranslateThread?: () => void
  backgroundLoading?: boolean
  isRecovered?: boolean
  hasOlderMessages?: boolean
  olderMessagesLoading?: boolean
  onLoadOlder?: () => void
  selectedParticipant?: PropertyParticipant | null
  masterOwnerHouseholdLabel?: string | null
  onBack?: () => void
}

const fallback = (value: unknown, placeholder = '') => {
  const text = String(value ?? '').trim()
  return text || placeholder
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const highlightText = (text: string, terms: string[]) => {
  const cleanTerms = (terms || []).map((term) => String(term || '').trim()).filter((term) => term.length > 1).slice(0, 8)
  if (cleanTerms.length === 0) return text
  const re = new RegExp(`(${cleanTerms.map(escapeRegExp).join('|')})`, 'ig')
  return text.split(re).map((part, index) => (
    cleanTerms.some((term) => term.toLowerCase() === part.toLowerCase())
      ? <mark key={`${part}-${index}`} className="nx-keyword-highlight">{part}</mark>
      : part
  ))
}

const messageTimestampIso = (message: ThreadMessage): string =>
  message.createdAt || message.sentAt || message.timelineAt || new Date().toISOString()

const messageTimestampMs = (message: ThreadMessage): number => {
  const ts = new Date(messageTimestampIso(message)).getTime()
  return Number.isFinite(ts) ? ts : 0
}

type DeliveryBadge = 'sending' | 'sent' | 'delivered' | 'failed' | 'scheduled' | 'cancelled'

const normalizeDeliveryBadge = (message: ThreadMessage): DeliveryBadge => {
  const status = String(message.deliveryStatusDisplay || message.deliveryStatus || '').toLowerCase()
  const raw = String(message.rawStatus || '').toLowerCase()
  const source = String(message.source || '').toLowerCase()
  const failedAt = String((message as { failedAt?: string | null; failed_at?: string | null }).failedAt
    ?? (message as { failed_at?: string | null }).failed_at
    ?? '').trim()
  const isFinalFailure = Boolean(
    (message as { isFinalFailure?: boolean; is_final_failure?: boolean }).isFinalFailure
    ?? (message as { is_final_failure?: boolean }).is_final_failure,
  )
  const statusEvidence = [status, raw].filter(Boolean)

  if (statusEvidence.some((value) => value.includes('cancel'))) return 'cancelled'

  const hasFailure = isFinalFailure
    || Boolean(failedAt)
    || Boolean(message.error)
    || statusEvidence.some((value) => (
      value.includes('fail')
      || value.includes('undeliv')
      || value.includes('rejected')
      || value === 'error'
      || value.includes('error')
    ))
  if (hasFailure) return 'failed'

  const isScheduled = source === 'send_queue'
    && statusEvidence.some((value) => value.includes('schedul') || value === 'queued' || value === 'approval' || value === 'pending')
    && !message.sentAt
  if (isScheduled) return 'scheduled'

  if (message.deliveredAt) return 'delivered'
  if (statusEvidence.some((value) => value.includes('deliver') && !value.includes('undeliv'))) return 'delivered'

  const messageAt = String(message.sentAt || message.deliveredAt || message.createdAt || '').trim()
  const messageAgeMs = messageAt ? Math.max(0, Date.now() - new Date(messageAt).getTime()) : Number.POSITIVE_INFINITY
  const isActivelySending = messageAgeMs < 45_000 && statusEvidence.some((value) => (
    value.includes('pending')
    || value.includes('queue')
    || value.includes('process')
    || value === 'queued'
    || value === 'sending'
  ))
  if (isActivelySending) return 'sending'

  if (message.sentAt) return 'delivered'
  if (statusEvidence.some((value) => value === 'sent' || value === 'success' || value === 'accepted')) return 'delivered'

  return 'delivered'
}

const deliveryBadgeMeta = (badge: DeliveryBadge): { icon: string; label: string } => {
  switch (badge) {
    case 'sending': return { icon: '◷', label: 'Sending' }
    case 'sent': return { icon: '✓', label: 'Sent' }
    case 'delivered': return { icon: '✓✓', label: 'Delivered' }
    case 'failed': return { icon: '!', label: 'Failed' }
    case 'scheduled': return { icon: '◷', label: 'Scheduled' }
    case 'cancelled': return { icon: '×', label: 'Cancelled' }
    default: return { icon: '•', label: badge }
  }
}

const isUnknownValue = (value: string): boolean => {
  const normalized = value.trim().toLowerCase()
  return !normalized || normalized === 'unknown' || normalized === 'unknown market' || normalized === '—'
}

const formatFlagLabel = (flag: string): string => (flag === 'Absentee' ? 'Absentee Owner' : flag)

interface PropertyIntelCell {
  key: string
  label: string
  value: string
  className?: string
}

const threadRecord = (thread: InboxWorkflowThread): Record<string, unknown> =>
  thread as unknown as Record<string, unknown>

const readNumber = (thread: InboxWorkflowThread, ...keys: string[]): number | null => {
  const record = threadRecord(thread)
  for (const key of keys) {
    const value = Number(record[key])
    if (Number.isFinite(value) && value > 0) return value
  }
  return null
}

const readString = (thread: InboxWorkflowThread, ...keys: string[]): string => {
  const record = threadRecord(thread)
  for (const key of keys) {
    const value = String(record[key] ?? '').trim()
    if (value) return value
  }
  return ''
}

const resolvePropertyTypeLabel = (propertyType: string): string => {
  const t = propertyType.toLowerCase()
  if (!t || t === 'unknown type') return ''
  if (t.includes('single') || t === 'sfr') return 'SFR'
  if (t.includes('multi')) return 'Multifamily'
  if (t.includes('condo')) return 'Condo'
  if (t.includes('town')) return 'Townhome'
  if (t.includes('land')) return 'Land'
  if (t.includes('commercial')) return 'Commercial'
  return propertyType
}

const resolveBuildingCondition = (thread: InboxWorkflowThread): string | null => {
  const raw = readString(thread, 'buildingCondition', 'building_condition', 'condition')
  const normalized = raw.trim()
  if (!normalized) return null
  if (['unknown', 'n/a', 'na', 'none', 'null'].includes(normalized.toLowerCase())) return null
  return normalized
}

const resolveConversationPropertyFlags = (thread: InboxWorkflowThread): string[] => {
  const decision = buildConversationDecision(thread)
  const flags = new Set<string>()
  const equityPercent = readNumber(thread, 'equityPercent', 'equity_percent')
  const propertyType = readString(thread, 'propertyType', 'property_type')
  const typeText = resolvePropertyTypeLabel(propertyType).toLowerCase()

  const addIf = (condition: boolean, label: string) => { if (condition) flags.add(label) }

  addIf(Boolean((thread as { absenteeOwner?: boolean }).absenteeOwner || (decision as { absentee_owner?: boolean }).absentee_owner), 'Absentee Owner')
  addIf(Boolean((thread as { probate?: boolean }).probate || (decision as { probate?: boolean }).probate), 'Probate')
  addIf(Boolean((thread as { vacant?: boolean }).vacant || (decision as { vacant?: boolean }).vacant), 'Vacant')
  addIf(Boolean((thread as { highEquity?: boolean }).highEquity || (decision as { high_equity?: boolean }).high_equity), 'High Equity')
  if (equityPercent != null && equityPercent >= 50) flags.add('High Equity')
  if (typeText.includes('multi')) flags.add('Multifamily')
  if (typeText.includes('commercial')) flags.add('Commercial')

  const order = ['Absentee Owner', 'Probate', 'High Equity', 'Vacant', 'Multifamily', 'Commercial']
  return order.filter((label) => flags.has(label))
}

const formatCompactMoney = (value: number | null): string => {
  if (value == null || value <= 0) return '—'
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`
  return formatCurrency(value)
}

const formatEquityDisplay = (amount: number | null, percent: number | null): string => {
  const pct = percent != null && percent > 0 ? formatPercent(percent) : null
  const amt = amount != null && amount > 0 ? formatCompactMoney(amount) : null
  if (pct && amt) return `${amt} / ${pct}`
  return pct || amt || '—'
}

const formatDateSeparator = (iso: string): string => {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return 'Earlier'
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86_400_000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const sameCalendarDay = (leftIso: string, rightIso: string): boolean => {
  const left = new Date(leftIso)
  const right = new Date(rightIso)
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

// ── Conversation atmosphere class ─────────────────────────────────────────
const getAtmosphereClass = (thread: InboxWorkflowThread, isSuppressed: boolean): string => {
  const status = String(thread.inboxStatus || '').toLowerCase()
  const stage = String(thread.conversationStage || '').toLowerCase()
  const intent = String((thread as any).uiIntent || (thread as any).detected_intent || '').toLowerCase()

  if (
    isSuppressed ||
    intent.includes('dnc') ||
    intent.includes('opt_out') ||
    intent.includes('hostile') ||
    intent.includes('angry') ||
    status.includes('dnc') ||
    status.includes('suppress')
  ) return 'is-atmo-dnc'

  if (status === 'new_reply' || status.includes('new_reply')) return 'is-atmo-reply'
  if (status === 'hot' || status.includes('hot')) return 'is-atmo-hot'
  if (stage.includes('negotiat') || stage.includes('stage_6')) return 'is-atmo-negotiation'
  if (stage.includes('contract') || stage.includes('close') || stage.includes('stage_7')) return 'is-atmo-premium'
  if (stage.includes('offer') || stage.includes('stage_5')) return 'is-atmo-premium'
  if (status.includes('follow') || status.includes('nurture')) return 'is-atmo-followup'
  if ((thread as any).dealType === 'commercial' || String((thread as any).propertyType || '').includes('commercial')) return 'is-atmo-commercial'

  return 'is-atmo-default'
}

// ── Adaptive reply suggestions ─────────────────────────────────────────────
interface SuggestionChip {
  id: string
  label: string
  text: string
  tone: 'soft' | 'direct' | 'internal' | 'danger'
}

export const buildAdaptiveSuggestions = (thread: InboxWorkflowThread, isSuppressed: boolean): SuggestionChip[] => {
  const intent = String((thread as any).uiIntent || (thread as any).detected_intent || '').toLowerCase()
  const stage = String(thread.conversationStage || '').toLowerCase()
  const persona = String((thread as any).sellerPersona || '').toLowerCase()
  const lang = String((thread as any).language || (thread as any).detected_language || '').toLowerCase()
  const isSpanish = lang.includes('spanish') || lang.includes('es')

  // Always show internal-only chips for suppressed / DNC / wrong number
  if (
    isSuppressed ||
    intent.includes('dnc') ||
    intent.includes('opt_out') ||
    intent.includes('wrong_number') ||
    intent.includes('not_interested')
  ) {
    return [
      { id: 'mark_dnc', label: 'Mark DNC', text: '', tone: 'danger' },
      { id: 'mark_wrong', label: 'Wrong Number', text: '', tone: 'internal' },
      { id: 'suppress', label: 'Suppress', text: '', tone: 'danger' },
      { id: 'review', label: 'Review', text: '', tone: 'internal' },
    ]
  }

  // Hostile / angry
  if (intent.includes('hostile') || intent.includes('angry') || intent.includes('attorney')) {
    return [
      { id: 'deescalate', label: 'De-escalate', text: isSpanish ? 'Entiendo su frustración. No volveré a contactarle.' : "I understand your frustration. I'll remove you from my list.", tone: 'soft' },
      { id: 'review', label: 'Human Review', text: '', tone: 'internal' },
    ]
  }

  // Stage-aware suggestions
  if (stage.includes('ownership') || stage.includes('stage_1')) {
    if (intent.includes('yes') || intent.includes('positive')) {
      return [
        { id: 'ask_selling', label: 'Ask Selling Interest', text: isSpanish ? '¡Qué bueno! ¿Ha considerado vender?' : "Great! Have you thought about selling?", tone: 'soft' },
        { id: 'motivation_probe', label: 'Motivation Probe', text: isSpanish ? '¿Qué situación le haría considerar una oferta?' : "What would make you consider an offer?", tone: 'soft' },
        { id: 'ask_timeline', label: 'Ask Timeline', text: isSpanish ? '¿Cuánto tiempo lleva siendo propietario?' : "How long have you owned the property?", tone: 'soft' },
      ]
    }
  }

  if (stage.includes('consider') || stage.includes('stage_2')) {
    return [
      { id: 'ask_price', label: 'Ask Price', text: isSpanish ? '¿Qué precio tendría en mente para la propiedad?' : "What price would you have in mind for the property?", tone: 'direct' },
      { id: 'condition_probe', label: 'Condition Probe', text: isSpanish ? '¿Cómo describiría la condición actual de la propiedad?' : "How would you describe the current condition?", tone: 'soft' },
      { id: 'soft_close', label: 'Soft Close', text: isSpanish ? 'Puedo hacer una oferta rápida, sin comisiones ni obligación.' : "I can put together a quick offer — no commissions, no obligation.", tone: 'direct' },
    ]
  }

  if (stage.includes('asking') || stage.includes('stage_3') || intent.includes('price')) {
    return [
      { id: 'confirm_basics', label: 'Confirm Basics', text: isSpanish ? 'Perfecto. ¿Podría confirmarme los dormitorios y baños?' : "Great. Could you confirm the beds and baths for me?", tone: 'soft' },
      { id: 'condition_probe', label: 'Condition Probe', text: isSpanish ? '¿Hay reparaciones pendientes que deba conocer?' : "Are there any repairs I should know about?", tone: 'soft' },
      { id: 'bridge_offer', label: 'Bridge to Offer', text: isSpanish ? 'Con esa información puedo preparar una oferta. ¿Le parece bien?' : "With that info I can prepare an offer. Does that work for you?", tone: 'direct' },
    ]
  }

  if (intent.includes('question') || intent.includes('uncertain')) {
    return [
      { id: 'local_cred', label: 'Local Credibility', text: isSpanish ? 'Soy inversor local. Compro propiedades directamente, sin comisiones.' : "I'm a local investor. I buy properties directly, no agents or fees.", tone: 'soft' },
      { id: 'low_pressure', label: 'Low-Pressure Reply', text: isSpanish ? 'Sin compromiso — solo quiero entender su situación.' : "No obligation at all — I just want to understand your situation.", tone: 'soft' },
      { id: 'ask_timeline', label: 'Timeline Ask', text: isSpanish ? '¿Está pensando en vender a corto o largo plazo?' : "Are you thinking short-term or longer-term for selling?", tone: 'soft' },
    ]
  }

  // Persona-aware fallback
  if (persona.includes('burnt') || persona.includes('landlord')) {
    return [
      { id: 'tenant_pain', label: 'Ask Tenant/Repairs Pain', text: isSpanish ? '¿Ha tenido problemas con inquilinos o reparaciones?' : "Have tenant or repair issues been stressful?", tone: 'soft' },
      { id: 'cash_out', label: 'Cash-Out Angle', text: isSpanish ? 'Muchos propietarios cansados eligen recibir efectivo rápido.' : "Many tired landlords choose a quick cash-out.", tone: 'soft' },
    ]
  }

  if (persona.includes('probate') || persona.includes('heir')) {
    return [
      { id: 'empathy', label: 'Empathetic Open', text: isSpanish ? 'Entiendo que puede ser una situación difícil. Estoy aquí para ayudar.' : "I understand this can be a difficult situation. I'm here to help.", tone: 'soft' },
      { id: 'decision_makers', label: 'Ask Decision Makers', text: isSpanish ? '¿Hay otros familiares involucrados en la decisión?' : "Are there other family members involved in the decision?", tone: 'soft' },
    ]
  }

  // Generic fallback
  return [
    { id: 'ownership_check', label: 'Ownership Check', text: isSpanish ? 'Hola, ¿sigue siendo propietario de esta propiedad?' : "Hi, are you still the owner of this property?", tone: 'soft' },
    { id: 'soft_intro', label: 'Local Investor Intro', text: isSpanish ? 'Soy inversor local y me interesa hacer una oferta por su propiedad.' : "I'm a local investor interested in making you an offer on your property.", tone: 'soft' },
  ]
}

export const ChatThread = ({
  thread,
  messages,
  loading,
  isSuppressed,
  isStarred = false,
  onTogglePin,
  onToggleStar,
  onToggleArchive,
  onThreadAction,
  onOpenDebug,
  searchQuery = '',
  layoutMode = 'full',
  threadTranslations,
  sellerLanguageLabel,
  isTranslatingThread = false,
  onTranslateThread,
  backgroundLoading = false,
  isRecovered = false,
  hasOlderMessages = false,
  olderMessagesLoading = false,
  onLoadOlder,
  selectedParticipant = null,
  masterOwnerHouseholdLabel = null,
  onBack,
}: ChatThreadProps) => {
  // Remount counter for the N.1 performance guardrails (silent, dev/harness only).
  useEffect(() => {
    markDealDeskMount('conversation')
  }, [])
  const { data: phase3 } = usePhase3Intelligence(thread?.threadKey)
  const listRef = useRef<HTMLDivElement | null>(null)
  const scrollSnapshotRef = useRef<{ height: number; top: number; nearBottom: boolean }>({
    height: 0, top: 0, nearBottom: true,
  })
  // Which thread the snapshot above belongs to, and per-thread session positions
  // for operators who deliberately scrolled back through history.
  const snapshotThreadKeyRef = useRef<string | null>(null)
  const threadScrollMemory = useRef<Map<string, number>>(new Map())

  useLayoutEffect(() => {
    const node = listRef.current
    if (!node) return

    // Thread IDENTITY gate. scrollSnapshotRef used to survive a thread change,
    // so opening seller B inherited seller A's height/offset: `previous.height`
    // was non-zero, the "jump to latest" branch was skipped, and the new thread
    // opened at a stale offset from a different conversation. A saved position
    // for thread A must never influence thread B.
    const threadId = String(thread?.id ?? thread?.threadKey ?? '')
    if (snapshotThreadKeyRef.current !== threadId) {
      const outgoing = snapshotThreadKeyRef.current
      if (outgoing) {
        // Keep the operator's own position if they deliberately scrolled up.
        const snap = scrollSnapshotRef.current
        if (snap.height > 0 && !snap.nearBottom) {
          threadScrollMemory.current.set(outgoing, snap.top)
        } else {
          threadScrollMemory.current.delete(outgoing)
        }
      }
      snapshotThreadKeyRef.current = threadId
      // Zero-state: this thread has contributed no geometry yet.
      scrollSnapshotRef.current = { height: 0, top: 0, nearBottom: true }
    }

    // Never scroll before hydration. Measuring an empty/loading list yields a
    // scrollHeight that is not the real content height, which is what produced
    // the visible jump.
    if (loading) return
    if (!messages || messages.length === 0) return

    const previous = scrollSnapshotRef.current
    const nextHeight = node.scrollHeight

    if (previous.height > 0) {
      if (previous.nearBottom) {
        node.scrollTop = Math.max(0, nextHeight - node.clientHeight)
        /*
         * Re-pin after paint. A message appended by realtime can still be
         * laying out when this layout effect reads scrollHeight, so pinning to
         * the height measured here lands on the PREVIOUS bottom and leaves the
         * new bubble hanging below the fold -- measured at 1563 against a real
         * 1642, almost exactly one message short. One frame later the geometry
         * is final.
         */
        /*
         * SETTLE, don't re-pin once. A single extra frame still landed on a
         * stale height when the arriving message was itself still laying out:
         * measured top=98 against a real max=192 after an inbound. Same bounded
         * settle the initial positioning uses, for the same reason.
         */
        const repinThreadId = threadId
        let repinLast = nextHeight
        let repinStable = 0
        let repinFrames = 0
        const repin = () => {
          const live = listRef.current
          if (!live) return
          /*
           * Gated on THREAD IDENTITY only -- the same lesson the initial pin
           * had to learn. Re-reading scrollSnapshotRef.nearBottom here is
           * circular: the tail of this effect has already rewritten it from the
           * pre-growth geometry, so the loop cancelled itself on its first
           * frame and the timeline stopped at 114 of a real 192. The decision
           * that we were at the bottom was made once, above, before the
           * content grew.
           */
          if (snapshotThreadKeyRef.current !== repinThreadId) return
          if (repinFrames++ > 40) return
          const height = live.scrollHeight
          if (height === repinLast) {
            if (++repinStable >= 2) return
          } else {
            repinStable = 0
            repinLast = height
          }
          programmaticScrollRef.current = Date.now()
          live.scrollTop = Math.max(0, height - live.clientHeight)
          scrollSnapshotRef.current = { height, top: live.scrollTop, nearBottom: true }
          requestAnimationFrame(repin)
        }
        requestAnimationFrame(repin)
      } else {
        node.scrollTop = previous.top + (nextHeight - previous.height)
      }
    } else {
      // First measured paint for THIS thread. Restore a deliberate saved
      // position if the operator had scrolled up earlier in the session;
      // otherwise the contract is simply: latest message visible.
      const saved = threadScrollMemory.current.get(threadId)
      if (saved != null && saved > 0 && saved < nextHeight - node.clientHeight) {
        node.scrollTop = saved
        initialisedThreadRef.current = threadId
      } else if (nextHeight <= node.clientHeight) {
        // Nothing to scroll: this thread is settled the moment it paints.
        initialisedThreadRef.current = threadId
      } else if (nextHeight > node.clientHeight) {
        node.scrollTop = nextHeight - node.clientHeight
        /*
         * KEEP PINNING UNTIL THE HEIGHT STOPS GROWING.
         *
         * This pinned ONCE against whatever scrollHeight happened to be at the
         * first measured paint, and message content is still laying out then.
         * Measured across repeated opens of the same thread, it landed at 219,
         * 503, 537, 677 and 683 of 683 -- correct only when layout happened to
         * finish first. The sampled sequence shows the height settling in
         * stages (0 -> 587 -> 683), so one pin can never be reliable.
         *
         * Re-pins frame by frame while the height is still changing, stops as
         * soon as it holds still for two frames, and gives up after a bounded
         * number of frames so a pathological layout cannot spin.
         *
         * §7 — every frame re-checks that THIS thread is still the selected one
         * and that the operator has not taken over by scrolling. A callback
         * captured for thread A must never move thread B.
         */
        const pinThreadId = threadId
        let lastHeight = nextHeight
        let stableFrames = 0
        let frames = 0
        const settle = () => {
          const live = listRef.current
          if (!live) return
          /*
           * §7 — THREAD IDENTITY IS THE ONLY GATE.
           *
           * A first attempt also bailed when the shared snapshot said the list
           * was no longer near the bottom. That snapshot is rewritten by the
           * tail of this very effect the moment content grows, so the loop
           * cancelled itself on its first frame and the thread still landed at
           * 325 or 0 of 683. Programmatic scrollTop also fires scroll events,
           * so the snapshot cannot distinguish "content grew" from "the
           * operator scrolled" -- gating on it is unsound either way.
           *
           * Instead this is bounded to ~1s of frames and stops as soon as the
           * height holds still, which is short enough that it cannot fight a
           * real operator, and it refuses to touch a list that now belongs to
           * a different thread.
           */
          if (snapshotThreadKeyRef.current !== pinThreadId) return
          /*
           * STOP THE MOMENT THE OPERATOR TAKES OVER -- AND NOT BEFORE.
           *
           * Exiting on two stable frames of scrollHeight was too eager:
           * messages arrive in batches with gaps wider than two frames, so the
           * loop declared the layout finished between batches and a
           * seven-message thread landed at 549 of 705 -- roughly one bubble
           * short. The ResizeObserver could not rescue it either, because it
           * watches the scroller's BOX, which does not change when its
           * CONTENT grows.
           *
           * So the bottom is simply held for the frame budget. This is safe
           * because the gate is a real gesture: programmatic scrollTop also
           * fires scroll events, and handleScroll already tells the two apart
           * via programmaticScrollRef, so our own pinning can never look like
           * the operator scrolling away.
           */
          if (userTookOverRef.current) { initialisedThreadRef.current = pinThreadId; return }
          // ~2s of frames: content that loads asynchronously can still be
          // growing past one second, and a thread that stops short of its own
          // bottom is the defect this loop exists to remove.
          if (frames++ > 120) { initialisedThreadRef.current = pinThreadId; return }
          const height = live.scrollHeight
          // Stability only means something once there is a bottom to hold; a
          // list with nothing to scroll is trivially "stable" every frame.
          const scrollable = height > live.clientHeight
          // ~0.5s of held-still height, not two frames: batched arrivals pause
          // for longer than two frames between bubbles.
          if (height === lastHeight && scrollable) {
            if (++stableFrames >= 30) { initialisedThreadRef.current = pinThreadId; return }
          } else {
            stableFrames = 0
            lastHeight = height
          }
          programmaticScrollRef.current = Date.now()
          live.scrollTop = Math.max(0, height - live.clientHeight)
          scrollSnapshotRef.current = { height, top: live.scrollTop, nearBottom: true }
          requestAnimationFrame(settle)
        }
        requestAnimationFrame(settle)
      }
    }

    // The scroller's own box does not change when its CONTENT grows, so the
    // ResizeObserver cannot be the only place this is decided.
    node.classList.toggle('is-short-timeline', node.scrollHeight <= node.clientHeight)

    const distanceFromBottom = node.scrollHeight - node.clientHeight - node.scrollTop
    scrollSnapshotRef.current = { height: node.scrollHeight, top: node.scrollTop, nearBottom: distanceFromBottom < 48 }
  }, [messages, loading, thread?.id])

  /*
   * §5/§14 — THE NEW-MESSAGE AFFORDANCE.
   *
   * The viewport already preserves an operator's reading position when a
   * message lands while they are scrolled up (the anchor-offset branch above).
   * What it did not do is TELL them. A message would arrive, the position would
   * correctly not move, and nothing indicated anything had happened -- so the
   * only way to discover a reply was to scroll down and look.
   *
   * Tracked by message COUNT rather than by a realtime hook, so it is true for
   * any path that appends to the timeline and cannot drift out of step with
   * the list it describes.
   */
  const [pendingBelow, setPendingBelow] = useState(0)
  const lastCountRef = useRef(0)
  /**
   * Which thread has finished establishing its initial position.
   *
   * Without this, a thread's FIRST load counted as "messages arrived while you
   * were scrolled up": the count went 0 -> 7 while the list was still being
   * positioned and therefore not yet near the bottom, so a freshly opened
   * conversation announced "7 new messages" about messages the operator had
   * just asked to see. The affordance is only meaningful for arrivals AFTER
   * the thread is settled.
   */
  const initialisedThreadRef = useRef<string | null>(null)
  /**
   * Set only by a scroll the operator performed, never by one we performed.
   * The initial pin holds the bottom until this flips -- see the settle loop.
   */
  const userTookOverRef = useRef(false)
  /**
   * Scrolls this component performs itself.
   *
   * Programmatic scrollTop assignment fires the same scroll event a finger
   * does, so handleScroll cleared the affordance every time the timeline
   * re-pinned, and the next message re-created it. The pill detached and
   * re-attached fast enough that Playwright could not click it -- "element is
   * not stable", then "detached from the DOM" -- which is a fair description
   * of what a thumb would have been chasing.
   */
  const programmaticScrollRef = useRef(0)

  useEffect(() => {
    const count = messages?.length ?? 0
    const previousCount = lastCountRef.current
    lastCountRef.current = count
    const threadId = String(thread?.id ?? thread?.threadKey ?? '')
    // Before this thread has settled, adopt the count silently.
    if (initialisedThreadRef.current !== threadId) return
    // A thread switch resets the counter rather than inheriting A's backlog.
    if (count < previousCount) { setPendingBelow(0); return }
    const added = count - previousCount
    if (added <= 0) return
    if (scrollSnapshotRef.current.nearBottom) return
    setPendingBelow((n) => n + added)
  }, [messages, thread?.id, thread?.threadKey])

  useEffect(() => {
    setPendingBelow(0)
    lastCountRef.current = 0
    initialisedThreadRef.current = null
    userTookOverRef.current = false
  }, [thread?.id])

  const jumpToLatest = useCallback(() => {
    const node = listRef.current
    if (!node) return
    programmaticScrollRef.current = Date.now()
    node.scrollTo({ top: node.scrollHeight - node.clientHeight, behavior: 'smooth' })
    setPendingBelow(0)
  }, [])

  /*
   * GROWTH CAN HAPPEN WITHOUT A RENDER.
   *
   * The re-pin chains hang off the layout effect, so they only run when
   * `messages`, `loading` or the thread identity change. A bubble that lays
   * out late -- or any content that resizes after React is done -- grows the
   * timeline with no effect to react to, and the view is left short of the
   * bottom: measured at 98 against a real 176 straight after an inbound.
   *
   * A ResizeObserver watches the scroller itself, which is the one signal that
   * is true for every growth path. It only acts when the operator was already
   * at the bottom, so it can never pull someone out of history, and it marks
   * the scroll as ours so the affordance is not dismissed by our own movement.
   */
  useEffect(() => {
    const node = listRef.current
    if (!node || typeof ResizeObserver === 'undefined') return undefined
    let lastHeight = node.scrollHeight
    let lastClient = node.clientHeight
    const observer = new ResizeObserver(() => {
      const live = listRef.current
      if (!live) return
      const height = live.scrollHeight
      const client = live.clientHeight

      /*
       * §26 -- THE KEYBOARD SHRINKS THE VIEWPORT, NOT THE CONTENT.
       *
       * This gated purely on scrollHeight, which the keyboard does not touch:
       * it shrinks clientHeight instead. So an operator sitting on the latest
       * message tapped the composer, the list lost ~300px of height, and the
       * message they were reading slid up out of view with nothing to re-pin
       * it -- the keyboard appeared to scroll the thread backwards.
       *
       * A shrinking viewport is treated exactly like growing content: re-anchor
       * ONLY if they were already at the bottom. Someone reading history keeps
       * their place, which is the other half of §26.
       */
      const shrankViewport = client < lastClient
      lastClient = client

      /*
       * §2/§25 -- BOTTOM-ALIGN ONLY WHILE THERE IS NOTHING TO SCROLL.
       *
       * Bottom-aligning in CSS unconditionally (margin-top:auto on the first
       * child) changed scrollHeight for SHORT threads, and the initial-pin
       * settle loop reads scrollHeight to decide when layout has finished. A
       * seven-message thread landed at top=324 of max=705, and a two-message
       * one reported max=4 where it had reported 705 moments earlier.
       *
       * Gating the alignment on "not scrollable" means a thread with real
       * history lays out EXACTLY as it did before this pass -- the scroll
       * machinery sees nothing new -- while a short thread still sits on the
       * composer instead of hanging under the header.
       */
      live.classList.toggle('is-short-timeline', height <= client)

      if (height === lastHeight && !shrankViewport) return
      const grew = height > lastHeight
      lastHeight = height
      if (!grew && !shrankViewport) return
      if (!scrollSnapshotRef.current.nearBottom) return
      programmaticScrollRef.current = Date.now()
      live.scrollTop = Math.max(0, height - live.clientHeight)
      scrollSnapshotRef.current = { height, top: live.scrollTop, nearBottom: true }
    })
    observer.observe(node)
    // Children resizing is what actually changes scrollHeight.
    for (const child of Array.from(node.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [messages, thread?.id])

  const handleScroll = () => {
    const node = listRef.current
    if (!node) return
    const distanceFromBottom = node.scrollHeight - node.clientHeight - node.scrollTop
    const nearBottom = distanceFromBottom < 48
    scrollSnapshotRef.current = { height: node.scrollHeight, top: node.scrollTop, nearBottom }
    // Returning to the latest message is itself the acknowledgement -- but only
    // when the OPERATOR did the returning. Our own re-pins land here too.
    const selfScrolled = Date.now() - programmaticScrollRef.current < 250
    if (!selfScrolled) userTookOverRef.current = true
    if (nearBottom && !selfScrolled) setPendingBelow((n) => (n === 0 ? n : 0))
  }

  const timelineMessages = useMemo(() => (
    [...messages].sort((left, right) => (
      messageTimestampMs(left) - messageTimestampMs(right) ||
      String(left.id || '').localeCompare(String(right.id || ''))
    ))
  ), [messages])

  useEffect(() => {
    const outboundMessages = timelineMessages.filter((message) => message.direction === 'outbound')
    const deliveredCount = outboundMessages.filter((message) => normalizeDeliveryBadge(message) === 'delivered').length
    const failedCount = outboundMessages.filter((message) => normalizeDeliveryBadge(message) === 'failed').length
    const lastMessage = timelineMessages[timelineMessages.length - 1] ?? null
    if (typeof localStorage !== 'undefined' && localStorage.getItem('nexus.inbox.debug') === '1') console.log('[THREAD_MESSAGES_RENDER_AUDIT]', {
      selectedConversationThreadId: thread ? ((thread as any).conversationThreadId || (thread as any).conversation_thread_id || thread.threadKey || thread.id) : null,
      messagesReceived: messages.length,
      inboundCount: timelineMessages.filter((message) => message.direction === 'inbound').length,
      outboundCount: outboundMessages.length,
      deliveredCount,
      failedCount,
      firstMessageAt: timelineMessages[0] ? messageTimestampIso(timelineMessages[0]) : null,
      lastMessageAt: lastMessage ? messageTimestampIso(lastMessage) : null,
      renderedMessageCount: timelineMessages.length,
    })
  }, [messages.length, thread, timelineMessages])

  if (!thread) return (
    <div className="nx-chat-container is-empty">
      <div className="nx-inbox__workspace-empty">
        <Icon name="mail" style={{ width: 40, height: 40, opacity: 0.08, marginBottom: 16 }} />
        <p>Select a thread to open the conversation.</p>
      </div>
    </div>
  )

  if (loading && messages.length === 0) return (
    <div className="nx-chat-container">
      <div className="nx-chat-skeleton">
        <div className="nx-chat-skeleton__bubble is-inbound shimmer" />
        <div className="nx-chat-skeleton__bubble is-outbound shimmer" />
        <div className="nx-chat-skeleton__bubble is-inbound shimmer" />
        <div className="nx-chat-skeleton__bubble is-outbound shimmer" />
        <div className="nx-chat-skeleton__bubble is-inbound shimmer" />
      </div>
    </div>
  )

  const prospectName = selectedParticipant?.display_name || resolveThreadPrimaryName(thread)
  const householdLabel = masterOwnerHouseholdLabel
    || (resolveThreadOwnerName(thread) ? `${resolveThreadOwnerName(thread)} household` : null)
  const phoneNumber = fallback(
    selectedParticipant?.canonical_e164 || thread.phoneNumber || thread.canonicalE164,
    '',
  )
  const propertyAddress = resolveThreadAddressLine(thread)
  const market = resolveThreadMarketBadge(thread)
  const matchedKeywords = getThreadMatchedKeywords(thread, searchQuery)
  const isCompact = layoutMode === 'compact'
  const atmosphereClass = getAtmosphereClass(thread, isSuppressed)

  const propertyTypeRaw = readString(thread, 'propertyType', 'property_type')
  const propertyTypeLabel = resolvePropertyTypeLabel(propertyTypeRaw) || (isUnknownValue(propertyTypeRaw) ? '' : propertyTypeRaw)
  const unitCount = readNumber(thread, 'unitCount', 'unit_count', 'units', 'number_of_units', 'units_count')
  const estimatedValue = readNumber(thread, 'estimatedValue', 'estimated_value')
  const equityAmount = readNumber(thread, 'equityAmount', 'equity_amount')
  const equityPercent = readNumber(thread, 'equityPercent', 'equity_percent')
  const buildingCondition = resolveBuildingCondition(thread)
  const propertyFlags = resolveConversationPropertyFlags(thread)
  const visibleFlags = propertyFlags.slice(0, 2).map(formatFlagLabel)
  const overflowFlagCount = Math.max(0, propertyFlags.length - 2)
  const equityDisplay = formatEquityDisplay(equityAmount, equityPercent)
  const cleanMarket = market && !isUnknownValue(market) ? market : ''
  const threadTemperature = resolveThreadTemperature(thread)
  const temperatureClass = threadTemperature === 'hot'
    ? 'is-temp-hot'
    : threadTemperature === 'warm'
      ? 'is-temp-warm'
      : 'is-temp-cold'

  const propertyCells: PropertyIntelCell[] = []
  if (cleanMarket) propertyCells.push({ key: 'market', label: 'Market', value: cleanMarket, className: 'is-market' })
  if (propertyTypeLabel) propertyCells.push({ key: 'type', label: 'Type', value: propertyTypeLabel })
  if (unitCount != null && unitCount > 1) propertyCells.push({ key: 'units', label: 'Units', value: String(unitCount) })
  if (estimatedValue) propertyCells.push({ key: 'value', label: 'Value', value: formatCompactMoney(estimatedValue) })
  if (equityDisplay !== '—') propertyCells.push({ key: 'equity', label: 'Equity', value: equityDisplay })
  if (buildingCondition) propertyCells.push({ key: 'condition', label: 'Condition', value: buildingCondition })
  visibleFlags.forEach((flag) => propertyCells.push({ key: `flag-${flag}`, label: 'Flag', value: flag, className: 'is-flag' }))
  if (overflowFlagCount > 0) propertyCells.push({ key: 'flags-more', label: 'Flags', value: `+${overflowFlagCount}`, className: 'is-flag' })
  if (isSuppressed) propertyCells.push({ key: 'suppressed', label: 'Status', value: 'Suppressed', className: 'is-status' })
  if (backgroundLoading) propertyCells.push({ key: 'sync', label: 'Sync', value: 'Syncing…' })

  /*
   * §11 -- A RESTRAINED SET, NOT A WALL.
   *
   * On a phone this rendered as five large chips across the full width --
   * "Dallas, TX / SFR / 100% / Good / High Equity" -- under an already heavy
   * title and address, before a single message was visible. §3 asks for "a
   * restrained set of useful property facts", not everything the record holds.
   *
   * Priority, not truncation of the list's tail: market and asset class orient
   * the operator, equity is the one number that changes how they negotiate,
   * and status (Suppressed / Syncing) is never dropped because it governs
   * whether they may send at all. The rest stays on the desktop strip, which
   * has the room.
   */
  const MOBILE_CELL_PRIORITY = ['suppressed', 'sync', 'market', 'type', 'equity']
  const mobilePropertyCells = onBack
    ? MOBILE_CELL_PRIORITY
      .map((key) => propertyCells.find((cell) => cell.key === key))
      .filter((cell): cell is PropertyIntelCell => Boolean(cell))
    : propertyCells

  const externalLinks = buildPropertyExternalLinks(propertyAddress || null)
  const zillowUrl = readString(thread, 'zillow_url', 'zillowUrl') || externalLinks.zillow

  /**
   * NO STREET VIEW IN THE OPEN-THREAD HEADER, AND NO TILE EITHER.
   *
   * This mounted a Street View Static <img> every time a thread was opened, on
   * top of the one each list card already fired. That image is gone.
   *
   * It is NOT replaced by a Property Signal Tile. The header already carries a
   * property intelligence strip (.nx-conv-property-strip: market, asset class,
   * equity, flags, status), so a tile beside it said everything twice —
   * measured on Bertha A Daniels, the header read "SFR · 75% EQ · MIAMI, FL"
   * in the tile and "Miami, FL · SFR · 75% · High Equity · Suppressed" in the
   * strip. Strip everything the strip already states and the tile has nothing
   * left but a glyph, which is decoration, not information.
   *
   * `externalLinks.streetView` is a maps.google.com LINK, not an image
   * request, so the operator can still jump to Street View deliberately.
   * Street View imagery stays in Property / Deal / Comp Intelligence and Map.
   */

  const renderHeaderActions = (withLabels = false, includeZillow = false) => (
    <>
      {includeZillow && zillowUrl ? (
        <a
          href={zillowUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="nx-chat-action-icon nx-chat-action-icon--link"
          title="Open on Zillow"
        >
          <Icon name="external-link" />
          {withLabels && <span>Zillow</span>}
        </a>
      ) : null}
      <button
        type="button"
        className={cls('nx-chat-action-icon', isStarred && 'is-active')}
        title={isStarred ? 'Unstar thread' : 'Star thread'}
        aria-pressed={isStarred}
        onClick={() => onToggleStar?.()}
      >
        <Icon name="star" />
        {withLabels && <span>{isStarred ? 'Unstar' : 'Star'}</span>}
      </button>
      <button
        type="button"
        className={cls('nx-chat-action-icon', thread.isPinned && 'is-active')}
        title={thread.isPinned ? 'Unpin thread' : 'Pin thread'}
        aria-pressed={thread.isPinned}
        onClick={() => onTogglePin?.()}
      >
        <Icon name="bookmark" />
        {withLabels && <span>{thread.isPinned ? 'Unpin' : 'Pin'}</span>}
      </button>
      <button
        type="button"
        className="nx-chat-action-icon"
        title="Thread notes and details"
        onClick={() => onThreadAction?.(thread.id, 'open_dossier')}
      >
        <Icon name="file-text" />
        {withLabels && <span>Notes</span>}
      </button>
      <button
        type="button"
        className={cls('nx-chat-action-icon', thread.isArchived && 'is-active')}
        title={thread.isArchived ? 'Restore to active inbox' : 'Archive thread (stays in All Messages)'}
        onClick={() => onToggleArchive?.()}
      >
        <Icon name="archive" />
        {withLabels && <span>{thread.isArchived ? 'Restore' : 'Archive'}</span>}
      </button>
    </>
  )

  return (
    <div className={cls('nx-chat-container', 'nx-conv-live', `is-layout-${layoutMode}`, atmosphereClass)}>
      <div className="nx-chat-atmosphere" aria-hidden="true" />

      <header className={cls(
        'nx-conv-header',
        temperatureClass,
        onBack && 'has-mobile-back',
        onBack && 'is-mobile-header',
      )}>
        <div className="nx-conv-header__atmosphere" aria-hidden="true">
          <span className="nx-conv-header__liquid nx-conv-header__liquid--field" />
          <span className="nx-conv-header__liquid nx-conv-header__liquid--bloom" />
          <span className="nx-conv-header__liquid nx-conv-header__liquid--edge" />
        </div>
        <div className="nx-conv-header__glow" aria-hidden="true" />

        {onBack ? (
          <div className="nx-conv-mobile-hero">
            <div className="nx-conv-mobile-controls">
              <button
                type="button"
                className="nx-conv-back nx-conv-back--tl"
                aria-label="Back to inbox"
                onClick={onBack}
              >
                <span className="nx-conv-back__glyph" aria-hidden="true">
                  <Icon name="chevron-left" />
                </span>
              </button>
              <MobileHeaderActionsMenu>
                {renderHeaderActions(true, true)}
              </MobileHeaderActionsMenu>
            </div>

            {/*
              §3 -- PROPERTY RECOGNITION, NOT A PROPERTY APP.

              One small image beside the identity so the operator knows which
              house they are talking about before they start typing. It is a
              SINGLE request on a detail surface -- the fan-out rule this
              product follows bars Street View on lists (a 25-row Inbox page
              fired 25 billed requests per load and again on every filter), not
              on the one thread that is open.

              It renders nothing at all when there is no imagery or no API key:
              `collapseWhenUnavailable` skips the placeholder, so an unknown
              address costs no vertical space rather than reserving a grey box.
            */}
            <div className="nx-conv-mobile-identity">
              <InboxStreetViewThumb
                address={propertyAddress}
                size="header"
                className="nx-conv-mobile-identity__sv"
                collapseWhenUnavailable
              />
              <div className="nx-conv-mobile-identity__text">
                <h2 className="nx-conv-seller-name nx-conv-seller-name--mobile">{prospectName}</h2>
                {propertyAddress ? (
                  <p className="nx-conv-identity-address nx-conv-identity-address--mobile">{propertyAddress}</p>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="nx-conv-layer-a">
            <div className="nx-conv-layer-a__identity">
              <h2 className="nx-conv-seller-name">{prospectName}</h2>
              <div className="nx-conv-identity-row">
                {phoneNumber && (
                  <span className="nx-conv-identity-phone">
                    <Icon name="phone" />
                    {phoneNumber}
                  </span>
                )}
                {selectedParticipant?.relationship_to_property ? (
                  <span className="nx-conv-identity-relationship">
                    {selectedParticipant.relationship_to_property.replace(/_/g, ' ')}
                  </span>
                ) : null}
                {cleanMarket && (
                  <span className="nx-conv-identity-market">
                    <Icon name="pin" />
                    {cleanMarket}
                  </span>
                )}
                {isRecovered && import.meta.env.DEV && (
                  <span className="nx-chat-recovered-badge" title="Recovered from local selection history fallback.">
                    Recovered
                  </span>
                )}
                {import.meta.env.DEV && (
                  <button type="button" className="nx-debug-btn-mini" onClick={onOpenDebug} title="Debug thread">
                    <Icon name="cpu" />
                  </button>
                )}
              </div>
              {householdLabel ? (
                <div className="nx-conv-identity-household">{householdLabel}</div>
              ) : null}
              {propertyAddress && (
                <div className="nx-conv-identity-address">{propertyAddress}</div>
              )}
            </div>

            {isCompact ? (
              <details className="nx-chat-actions-disclosure">
                <summary aria-label="Thread actions"><Icon name="more" /></summary>
                <div className="nx-chat-actions-disclosure__menu">
                  {renderHeaderActions(true)}
                </div>
              </details>
            ) : (
              <div className="nx-conv-layer-a__actions">
                {renderHeaderActions(false)}
              </div>
            )}
          </div>
        )}

        {mobilePropertyCells.length > 0 && (
          <div className={cls('nx-conv-layer-b', onBack && 'nx-conv-layer-b--mobile')}>
            <div className="nx-conv-property-strip" aria-label="Property intelligence">
              {mobilePropertyCells.map((cell) => (
                <span key={cell.key} className={cls('nx-intel-cell', cell.className)}>
                  {!cell.className?.includes('is-flag') && !onBack && (
                    <span className="nx-intel-cell__label">{cell.label}</span>
                  )}
                  <span className="nx-intel-cell__value">{cell.value}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </header>

      {/* ── THREAD STATE BAR: status / stage / temperature / autopilot ── */}
      <ThreadStateBar
        thread={thread}
        onRefetch={(threadKey) => onThreadAction?.(thread.id, 'refetch', { threadKey })}
        compact={Boolean(onBack)}
        autopilotDisabled={isSuppressed}
      />

      {/* ── MESSAGE TIMELINE ──────────────────────────────────────────── */}
      {pendingBelow > 0 ? (
        <button
          type="button"
          className="nx-new-message-pill"
          onClick={jumpToLatest}
          aria-label={`${pendingBelow} new ${pendingBelow === 1 ? 'message' : 'messages'} — jump to latest`}
        >
          <Icon name="arrow-down-left" size={14} strokeWidth={2} />
          <span>{pendingBelow} new {pendingBelow === 1 ? 'message' : 'messages'}</span>
        </button>
      ) : null}
      <div className="nx-message-list" ref={listRef} onScroll={handleScroll}>
        {hasOlderMessages && (
          <div className="nx-load-older-row">
            <button type="button" className="nx-btn nx-btn--secondary" onClick={onLoadOlder} disabled={olderMessagesLoading}>
              <Icon name="chevron-up" />
              <span>{olderMessagesLoading ? 'Loading older' : 'Load Older'}</span>
            </button>
          </div>
        )}
        {(() => {
          const hasRowLatestActivity = Boolean(String((thread as any).latestMessageBody || (thread as any).latest_message_body || '').trim())
          const isUncontacted = !thread || ((thread as any).is_uncontacted && !hasRowLatestActivity) || thread.threadKey?.startsWith('property:') || (thread.inbound_count === 0 && thread.outbound_count === 0 && messages.length === 0 && !hasRowLatestActivity)
          if (isUncontacted && !loading) {
            return (
              <div className="nx-uncontacted-state">
                <div className="nx-uncontacted-state__card">
                  <Icon name="message" />
                  <h3>No conversation yet</h3>
                  <p>This seller has not been contacted or there is no SMS history.</p>
                  <div className="nx-uncontacted-state__actions">
                    <button type="button" className="nx-btn nx-btn--secondary" onClick={() => onThreadAction?.(thread?.id || '', 'open_map')}>
                      <Icon name="map" /> <span>Open Map</span>
                    </button>
                    <button type="button" className="nx-btn nx-btn--secondary" onClick={() => onThreadAction?.(thread?.id || '', 'open_property')}>
                      <Icon name="home" /> <span>Open Property</span>
                    </button>
                  </div>
                </div>
              </div>
            )
          }

          return timelineMessages.map((msg, index) => {
            const isOutbound = msg.direction === 'outbound'
            const deliveryBadge = normalizeDeliveryBadge(msg)
            const isFailed = deliveryBadge === 'failed'
            const isScheduled = deliveryBadge === 'scheduled'
            const isSending = deliveryBadge === 'sending'
            const timestampIso = messageTimestampIso(msg)
            const previousIso = index > 0 ? messageTimestampIso(timelineMessages[index - 1]) : null
            const showDateSeparator = !previousIso || !sameCalendarDay(previousIso, timestampIso)
            const queueId = String(msg.developerMeta?.queue_id ?? '').trim()

            const turn = phase3?.recentTurns?.find(t =>
              t.metadata?.inbound_message_id === msg.id ||
              t.metadata?.outbound_message_id === msg.id ||
              t.metadata?.message_event_id === msg.id
            )

            const isMessageTranslated = Boolean(threadTranslations?.[msg.id])

            const receiptMeta = deliveryBadgeMeta(deliveryBadge)

            return (
              <div key={msg.id} className={cls('nx-msg-lane', isOutbound ? 'is-outbound' : 'is-inbound')}>
                {showDateSeparator && (
                  <div className="nx-msg-day" role="separator" aria-label={formatDateSeparator(timestampIso)}>
                    <span>{formatDateSeparator(timestampIso)}</span>
                  </div>
                )}

                <div className={cls(
                  'nx-msg',
                  isOutbound ? 'is-outbound' : 'is-inbound',
                  isFailed && 'is-failed',
                  isScheduled && 'is-scheduled',
                  isSending && 'is-sending',
                  !isOutbound && isTranslatingThread && 'is-translating',
                )}>
                  <div className="nx-msg__bubble">
                    <span className="nx-msg__tail" aria-hidden="true" />
                    {highlightText(msg.body, matchedKeywords.length ? matchedKeywords : [searchQuery])}

                    {turn && (turn.intent_detected || turn.confidence_score) && (
                      <div className="nx-turn-intel">
                        {turn.intent_detected && (
                          <span className="nx-turn-intent">
                            {String(turn.intent_detected || '').replace(/_/g, ' ')}
                          </span>
                        )}
                        {turn.confidence_score && (
                          <span className="nx-turn-conf">
                            {Math.round(turn.confidence_score * 100)}%
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="nx-msg__meta">
                    <time className="nx-msg__time" dateTime={timestampIso}>
                      {formatMessageDateTime(timestampIso)}
                    </time>

                    {isOutbound && (
                      <>
                        <span
                          className={cls('nx-msg__receipt', `is-${deliveryBadge}`)}
                          title={deliveryBadge === 'failed' && msg.error ? String(msg.error) : undefined}
                        >
                          <span aria-hidden="true">{receiptMeta.icon}</span>
                          <span>{receiptMeta.label}</span>
                        </span>

                        {isScheduled && queueId && (
                          <div className="nx-msg__scheduled-actions">
                            <button
                              type="button"
                              onClick={() => onThreadAction?.(thread.id, `edit_queue:${queueId}`, { text: msg.body })}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => onThreadAction?.(thread.id, `cancel_queue:${queueId}`)}
                            >
                              Cancel
                            </button>
                          </div>
                        )}

                        {deliveryBadge === 'failed' && (
                          <button type="button" className="nx-retry-btn" onClick={() => onThreadAction?.(thread.id, 'retry_send')} title="Retry send">
                            <Icon name="refresh-cw" />
                          </button>
                        )}
                      </>
                    )}
                  </div>

                  {!isOutbound && (
                    isTranslatingThread ? (
                      <div className="nx-msg__translate is-translating" aria-live="polite">
                        <span className="nx-translate-badge__spinner" />
                        <span>Translating…</span>
                      </div>
                    ) : isMessageTranslated ? (
                      <div className="nx-msg__translate is-translated">
                        <Icon name="globe" />
                        <span>
                          {sellerLanguageLabel && sellerLanguageLabel !== 'Unknown'
                            ? `Translated from ${sellerLanguageLabel}`
                            : 'Translated'}
                        </span>
                        <button type="button" onClick={() => onTranslateThread?.()}>Show Original</button>
                      </div>
                    ) : sellerLanguageLabel && sellerLanguageLabel !== 'Unknown' ? (
                      <div className="nx-msg__translate is-available">
                        <Icon name="globe" />
                        <span>{sellerLanguageLabel}</span>
                        <button type="button" onClick={() => onTranslateThread?.()}>Show Translation</button>
                      </div>
                    ) : null
                  )}

                  <div className="nx-bubble-hover-actions">
                    {isFailed && isOutbound && (
                      <button type="button" title="Retry send" className="nx-bubble-action" onClick={() => onThreadAction?.(thread.id, 'retry_send')}>
                        <Icon name="refresh-cw" />
                      </button>
                    )}
                    <button type="button" title="Add note" className="nx-bubble-action" onClick={() => onThreadAction?.(thread.id, 'add_note')}>
                      <Icon name="file-text" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })
        })()}

        {messages.length === 0 && !loading && (
          <div className="nx-inbox__messages-empty">
            <Icon name="message" style={{ opacity: 0.08, width: 36, height: 36, marginBottom: 10 }} />
            <p>No messages in this thread.</p>
            <button
              type="button"
              className="nx-btn nx-btn--secondary"
              style={{ marginTop: 10 }}
              onClick={() => onThreadAction?.(thread.id, 'refetch', { threadKey: thread.threadKey || thread.id })}
            >
              <Icon name="refresh-cw" style={{ width: 13, height: 13 }} />
              <span>Retry</span>
            </button>
          </div>
        )}
      </div>

    </div>
  )
}
