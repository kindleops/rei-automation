import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { ThreadMessage } from '../../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { Icon } from '../../../shared/icons'
import { formatCurrency, formatMessageDateTime, formatPercent } from '../../../shared/formatters'
import { buildConversationDecision } from '../../../domain/inbox/inbox-decisioning'
import { resolveThreadTemperature } from '../status-visuals'
import { getThreadMatchedKeywords, resolveThreadAddressLine, resolveThreadMarketBadge, resolveThreadPrimaryName } from '../inbox-ui-helpers'
import { ThreadStateBar } from './ThreadStateBar'
import { usePhase3Intelligence } from '../hooks/usePhase3Intelligence'
import type { ViewLayoutMode } from '../../../domain/inbox/view-layout'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

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

  if (message.sentAt) return 'sent'
  if (statusEvidence.some((value) => value === 'sent' || value === 'success' || value === 'accepted')) return 'sent'

  if (statusEvidence.some((value) => (
    value.includes('pending')
    || value.includes('queue')
    || value.includes('process')
    || value === 'queued'
    || value === 'sending'
  ))) return 'sending'

  return 'sending'
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
    { id: 'ai_assist', label: 'AI Assist', text: '', tone: 'internal' },
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
}: ChatThreadProps) => {
  const { data: phase3 } = usePhase3Intelligence(thread?.threadKey)
  const listRef = useRef<HTMLDivElement | null>(null)
  const scrollSnapshotRef = useRef<{ height: number; top: number; nearBottom: boolean }>({
    height: 0, top: 0, nearBottom: true,
  })

  useLayoutEffect(() => {
    const node = listRef.current
    if (!node) return
    const previous = scrollSnapshotRef.current
    const nextHeight = node.scrollHeight
    if (previous.height > 0) {
      if (previous.nearBottom) {
        node.scrollTop = Math.max(0, nextHeight - node.clientHeight)
      } else {
        node.scrollTop = previous.top + (nextHeight - previous.height)
      }
    } else if (nextHeight > node.clientHeight) {
      node.scrollTop = nextHeight - node.clientHeight
    }
    const distanceFromBottom = node.scrollHeight - node.clientHeight - node.scrollTop
    scrollSnapshotRef.current = { height: node.scrollHeight, top: node.scrollTop, nearBottom: distanceFromBottom < 48 }
  }, [messages, loading, thread?.id])

  const handleScroll = () => {
    const node = listRef.current
    if (!node) return
    const distanceFromBottom = node.scrollHeight - node.clientHeight - node.scrollTop
    scrollSnapshotRef.current = { height: node.scrollHeight, top: node.scrollTop, nearBottom: distanceFromBottom < 48 }
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

  const ownerName = resolveThreadPrimaryName(thread)
  const phoneNumber = fallback(thread.phoneNumber || thread.canonicalE164, '')
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

  const renderHeaderActions = (withLabels = false) => (
    <>
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
        {withLabels && <span>{thread.isArchived ? 'Unarchive' : 'Archive'}</span>}
      </button>
    </>
  )

  return (
    <div className={cls('nx-chat-container', 'nx-conv-live', `is-layout-${layoutMode}`, atmosphereClass)}>
      <div className="nx-chat-atmosphere" aria-hidden="true" />

      <header className={cls('nx-conv-header', temperatureClass)}>
        <div className="nx-conv-header__atmosphere" aria-hidden="true">
          <span className="nx-conv-header__liquid nx-conv-header__liquid--field" />
          <span className="nx-conv-header__liquid nx-conv-header__liquid--bloom" />
          <span className="nx-conv-header__liquid nx-conv-header__liquid--edge" />
        </div>
        <div className="nx-conv-header__glow" aria-hidden="true" />

        <div className="nx-conv-layer-a">
          <div className="nx-conv-layer-a__identity">
            <h2 className="nx-conv-seller-name">{ownerName}</h2>
            <div className="nx-conv-identity-row">
              {phoneNumber && (
                <span className="nx-conv-identity-phone">
                  <Icon name="phone" />
                  {phoneNumber}
                </span>
              )}
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

        {propertyCells.length > 0 && (
          <div className="nx-conv-layer-b">
            <div className="nx-conv-property-strip" aria-label="Property intelligence">
              {propertyCells.map((cell) => (
                <span key={cell.key} className={cls('nx-intel-cell', cell.className)}>
                  {!cell.className?.includes('is-flag') && (
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
        disabled={isSuppressed}
      />

      {/* ── MESSAGE TIMELINE ──────────────────────────────────────────── */}
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
