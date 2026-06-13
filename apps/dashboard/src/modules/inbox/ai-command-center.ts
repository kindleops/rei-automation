import type { ThreadContext, ThreadIntelligenceRecord, ThreadMessage } from '../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'

export type CommandTone = 'default' | 'accent' | 'success' | 'warning' | 'danger'

export interface CommandSuggestion {
  id: string
  label: string
  text: string
  tone?: CommandTone
}

export interface CommandTimelineEvent {
  id: string
  label: string
  detail: string
  time: string | null
  tone: CommandTone
}

export interface AgentSignal {
  id: string
  label: string
  summary: string
  confidence: number
}

export interface ThreadCommandIntel {
  sellerPersona: string
  sellerPsychology: string
  sentimentLabel: string
  timelineLabel: string
  likelyObjection: string
  recommendedOfferRange: string | null
  nextBestAction: string
  nextBestActionReason: string
  sendWindow: string
  motivationScore: number
  urgencyScore: number
  sentimentScore: number
  negotiationFlexibility: number
  responsivenessScore: number
  closeProbability: number
  dncRisk: number
  hostilityRisk: number
  aiConfidence: number
  estimatedDealValue: number | null
  acquisitionComplexity: number
  underwritingConfidence: number
  ghostingRisk: number
  bestAgent: string
  suggestions: CommandSuggestion[]
  automationEvents: CommandTimelineEvent[]
  liveEvents: CommandTimelineEvent[]
  agentSignals: AgentSignal[]
  fallbackDisplayOnly?: boolean
}

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value))

const asText = (value: unknown): string => String(value ?? '').trim()

const asNumber = (value: unknown): number | null => {
  const text = asText(value).replace(/[^\d.-]/g, '')
  if (!text) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

const formatMoney = (value: number | null): string | null => {
  if (!Number.isFinite(value ?? NaN) || !value) return null
  if ((value ?? 0) >= 1_000_000) return `$${((value ?? 0) / 1_000_000).toFixed(2)}M`
  if ((value ?? 0) >= 1_000) return `$${Math.round((value ?? 0) / 1_000)}K`
  return `$${Math.round(value ?? 0).toLocaleString()}`
}

const hoursSince = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return null
  return (Date.now() - time) / 3_600_000
}

const latestByDirection = (messages: ThreadMessage[], direction: 'inbound' | 'outbound'): ThreadMessage | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.direction === direction) return messages[index]
  }
  return null
}

const keywordScore = (text: string, patterns: string[]): number =>
  patterns.reduce((score, pattern) => score + (text.includes(pattern) ? 1 : 0), 0)

const getThreadField = (thread: InboxWorkflowThread | null, intelligence: ThreadIntelligenceRecord | null, keys: string[]): unknown => {
  const threadRecord = (thread ?? {}) as Record<string, unknown>
  const intelligenceRecord = (intelligence ?? {}) as Record<string, unknown>
  for (const key of keys) {
    if (threadRecord[key] !== undefined && threadRecord[key] !== null && String(threadRecord[key]).trim() !== '') return threadRecord[key]
    if (intelligenceRecord[key] !== undefined && intelligenceRecord[key] !== null && String(intelligenceRecord[key]).trim() !== '') return intelligenceRecord[key]
  }
  return null
}

const inferPersona = (thread: InboxWorkflowThread, combinedText: string, motivation: number): string => {
  const ownerType = asText(getThreadField(thread, null, ['ownerType', 'owner_type'])).toLowerCase()
  if (thread.isOptOut || thread.isSuppressed || combinedText.includes('stop') || combinedText.includes('wrong number')) return 'Suppressed / DNC'
  if (ownerType.includes('llc') || combinedText.includes('tenant') || combinedText.includes('rent')) return 'Landlord / Investor'
  if (combinedText.includes('probate') || combinedText.includes('inherited') || combinedText.includes('estate')) return 'Estate / Inherited'
  if (combinedText.includes('divorce') || combinedText.includes('foreclosure') || combinedText.includes('behind on')) return 'Distressed Owner'
  if (motivation >= 75) return 'Motivated Seller'
  if (thread.isAbsentee) return 'Absentee Owner'
  return 'Standard Homeowner'
}

const inferPsychology = (
  combinedText: string,
  urgency: number,
  hostilityRisk: number,
  flexibility: number,
): string => {
  if (hostilityRisk >= 65) return 'Defensive and protection-oriented. Keep replies short, factual, and low-pressure.'
  if (urgency >= 70) return 'Emotionally engaged with time pressure. Move quickly, acknowledge urgency, and reduce friction.'
  if (flexibility >= 70) return 'Open posture with room to guide the conversation. Advance toward terms and scheduling.'
  if (combinedText.includes('thinking') || combinedText.includes('maybe') || combinedText.includes('not sure')) {
    return 'Hesitant but still engaged. Reduce commitment pressure and ask one narrowing question at a time.'
  }
  return 'Measured engagement. Maintain rapport, clarify motivation, and avoid revealing pricing too early.'
}

const buildSuggestions = (
  thread: InboxWorkflowThread,
  persona: string,
  nextAction: string,
  likelyObjection: string,
): CommandSuggestion[] => {
  const sellerFirstName = thread.sellerFirstName || thread.ownerDisplayName?.split(' ')[0] || thread.ownerName?.split(' ')[0] || 'there'
  const suggestions: CommandSuggestion[] = [
    {
      id: 'empathetic_followup',
      label: 'Empathetic follow-up',
      text: `Hi ${sellerFirstName}, I appreciate you getting back to me. I want to make this easy on your timeline. What would feel like the best next step from your side?`,
      tone: 'accent',
    },
    {
      id: 'discovery_probe',
      label: 'Motivation probe',
      text: `Hi ${sellerFirstName}, what would need to happen for selling this property to make sense for you right now?`,
      tone: 'default',
    },
  ]

  if (persona.includes('Landlord') || likelyObjection.includes('tenant')) {
    suggestions.push({
      id: 'landlord_relief',
      label: 'Landlord relief',
      text: `Hi ${sellerFirstName}, if tenants or turnover are part of the challenge here, we can structure the timing around that. What is the toughest part of the property for you right now?`,
      tone: 'success',
    })
  } else if (persona.includes('Distressed') || nextAction.toLowerCase().includes('underwriting')) {
    suggestions.push({
      id: 'distress_clarifier',
      label: 'Pressure clarifier',
      text: `Hi ${sellerFirstName}, I want to be respectful of your timing. Is speed the biggest priority here, or is it getting to the right number?`,
      tone: 'warning',
    })
  } else {
    suggestions.push({
      id: 'soft_close',
      label: 'Soft close',
      text: `Hi ${sellerFirstName}, if the numbers make sense, would you be open to us outlining the cleanest next step for you?`,
      tone: 'success',
    })
  }

  return suggestions
}

export const buildThreadCommandIntel = (
  thread: InboxWorkflowThread | null,
  messages: ThreadMessage[],
  context: ThreadContext | null,
  intelligence: ThreadIntelligenceRecord | null,
): ThreadCommandIntel | null => {
  if (!thread) return null

  const orderedMessages = [...messages].sort((a, b) => (
    new Date(a.timelineAt || a.createdAt).getTime() - new Date(b.timelineAt || b.createdAt).getTime()
  ))
  const inbound = orderedMessages.filter((message) => message.direction === 'inbound')
  const outbound = orderedMessages.filter((message) => message.direction === 'outbound')
  const latestInbound = latestByDirection(orderedMessages, 'inbound')
  const combinedText = inbound.map((message) => asText(message.body).toLowerCase()).join(' \n ')

  const backendDncRisk = asNumber(getThreadField(thread, intelligence, ['dncRisk', 'dnc_risk']))
  const backendHostilityRisk = asNumber(getThreadField(thread, intelligence, ['hostilityRisk', 'hostility_risk']))
  const backendMotivationScore = asNumber(getThreadField(thread, intelligence, ['motivationScore', 'motivation_score', 'finalAcquisitionScore', 'priorityScore']))
  const fallbackDisplayOnly = backendDncRisk === null && backendMotivationScore === null

  const urgencyKeywordHits = keywordScore(combinedText, ['asap', 'urgent', 'today', 'this week', 'need to sell', 'moving', 'behind on'])
  const distressKeywordHits = keywordScore(combinedText, ['divorce', 'probate', 'inherited', 'foreclosure', 'vacant', 'code violation', 'tenant'])
  const positiveKeywordHits = keywordScore(combinedText, ['interested', 'open', 'yes', 'sure', 'okay', 'works', 'can do'])
  const hostileKeywordHits = keywordScore(combinedText, ['stop', 'wrong number', 'annoy', 'quit', 'leave me alone', 'not interested'])
  const anchorKeywordHits = keywordScore(combinedText, ['firm', 'lowest', 'best and final', '$', 'price'])

  const recencyHours = hoursSince(thread.lastInboundAt || thread.lastMessageAt)
  const inboundRecencyBoost = recencyHours === null ? 0 : recencyHours <= 2 ? 12 : recencyHours <= 24 ? 6 : 0

  const motivationScore = backendMotivationScore ?? clamp(50 + urgencyKeywordHits * 8 + distressKeywordHits * 6 + positiveKeywordHits * 4 - hostileKeywordHits * 18 + inboundRecencyBoost)
  const urgencyScore = clamp(35 + urgencyKeywordHits * 14 + distressKeywordHits * 8 + inboundRecencyBoost + (thread.inboxStatus === 'new_reply' ? 18 : 0))
  const sentimentScore = clamp(50 + positiveKeywordHits * 10 - hostileKeywordHits * 20)
  const negotiationFlexibility = clamp(52 + positiveKeywordHits * 6 - anchorKeywordHits * 8 - hostileKeywordHits * 10)

  const responsivenessBase = inbound.length > 0 ? Math.min(70, 38 + inbound.length * 9) : 18
  const outboundPenalty = outbound.length > inbound.length + 2 ? 12 : 0
  const stalePenalty = recencyHours !== null && recencyHours > 72 ? 24 : recencyHours !== null && recencyHours > 24 ? 12 : 0
  const responsivenessScore = clamp(responsivenessBase - outboundPenalty - stalePenalty)

  const dncRisk = backendDncRisk ?? clamp((thread.isOptOut || thread.isSuppressed ? 85 : 8) + hostileKeywordHits * 20 + (combinedText.includes('wrong number') ? 30 : 0))
  const hostilityRisk = backendHostilityRisk ?? clamp(10 + hostileKeywordHits * 24 + (thread.inboxStatus === 'needs_review' ? 12 : 0))

  const underwritingFields = [
    getThreadField(thread, intelligence, ['arv', 'afterRepairValue', 'after_repair_value']),
    getThreadField(thread, intelligence, ['estimatedRepairCost', 'estimated_repair_cost']),
    getThreadField(thread, intelligence, ['equityPercent', 'equity_percent']),
    getThreadField(thread, intelligence, ['cashOffer', 'cash_offer', 'mao']),
  ]
  const underwritingCompleteness = underwritingFields.filter((field) => field !== null && field !== undefined && String(field).trim() !== '').length / underwritingFields.length
  const underwritingConfidence = clamp(underwritingCompleteness * 100)

  const dataCompleteness = [
    thread.ownerId,
    thread.propertyId,
    thread.phoneNumber || thread.canonicalE164,
    context?.seller?.id,
    context?.property?.id,
  ].filter(Boolean).length
  const aiConfidence = clamp(42 + dataCompleteness * 10 + Math.min(orderedMessages.length, 6) * 4 + underwritingCompleteness * 18 - hostilityRisk * 0.15)

  const closeProbability = clamp(
    motivationScore * 0.34 +
      urgencyScore * 0.14 +
      responsivenessScore * 0.16 +
      negotiationFlexibility * 0.12 +
      underwritingConfidence * 0.12 +
      sentimentScore * 0.08 -
      dncRisk * 0.18,
  )

  const ghostingRisk = clamp(58 - responsivenessScore + (thread.inboxStatus === 'waiting' ? 14 : 0) + (recencyHours !== null && recencyHours > 48 ? 18 : 0))
  const acquisitionComplexity = clamp(
    18 +
      (1 - underwritingCompleteness) * 34 +
      (thread.hasLien ? 18 : 0) +
      (thread.isProbate ? 16 : 0) +
      (thread.isTaxDelinquent ? 12 : 0) +
      (thread.isVacant ? 8 : 0) +
      (asText(getThreadField(thread, intelligence, ['propertyType', 'property_type'])).toLowerCase().includes('multi') ? 14 : 0),
  )

  const equityPercent = asNumber(getThreadField(thread, intelligence, ['equityPercent', 'equity_percent']))
  const estimatedValue = asNumber(getThreadField(thread, intelligence, ['estimatedValue', 'estimated_value', 'zestimate']))
  const equityAmount = asNumber(getThreadField(thread, intelligence, ['equityAmount', 'equity_amount']))
  const estimatedDealValue = equityAmount ?? (estimatedValue && equityPercent ? estimatedValue * (equityPercent / 100) * 0.18 : null)

  const likelyObjection = dncRisk >= 70
    ? 'Contact resistance / opt-out sensitivity'
    : anchorKeywordHits >= 2
      ? 'Price anchoring and expectation management'
      : underwritingConfidence < 60
        ? 'Needs confidence-building through property detail gathering'
        : ghostingRisk >= 60
          ? 'Likely to go quiet without a concrete next step'
          : 'No major objection surfaced yet'

  const sellerPersona = inferPersona(thread, combinedText, motivationScore)
  const sellerPsychology = inferPsychology(combinedText, urgencyScore, hostilityRisk, negotiationFlexibility)

  const recommendedOfferRange = (() => {
    const backendRange = asText(getThreadField(thread, intelligence, ['recommendedOfferRange', 'recommended_offer_range']))
    if (backendRange) return backendRange
    const cashOffer = asNumber(getThreadField(thread, intelligence, ['cashOffer', 'cash_offer', 'mao']))
    const aiOffer = asNumber(getThreadField(thread, intelligence, ['aiRecommendedOffer', 'ai_recommended_opening_offer', 'ai_offer']))
    const walkaway = asNumber(getThreadField(thread, intelligence, ['walkawayPrice', 'walkaway_price', 'walkaway_internal']))
    const low = cashOffer ?? aiOffer
    const high = walkaway ?? aiOffer ?? cashOffer
    if (!low && !high) return null
    if (low && high) return `${formatMoney(Math.min(low, high))} – ${formatMoney(Math.max(low, high))}`
    return formatMoney(low ?? high)
  })()

  const nextBestAction = dncRisk >= 70
    ? 'Pause automation and shift to compliance-safe review'
    : hostilityRisk >= 65
      ? 'Switch to human review and de-escalate tone'
      : underwritingConfidence < 55 && (thread.conversationStage === 'price_discovery' || thread.conversationStage === 'offer_reveal' || thread.conversationStage === 'negotiation')
        ? 'Collect underwriting inputs before discussing numbers'
        : thread.inboxStatus === 'new_reply'
          ? 'Respond within 2 hours while engagement is live'
          : ghostingRisk >= 60
            ? 'Send a low-friction follow-up with one clear question'
            : closeProbability >= 72
              ? 'Move toward offer framing and schedule the next commitment'
              : 'Continue discovery and tighten seller motivation'

  const nextBestActionReason = dncRisk >= 70
    ? 'Suppression or opt-out language is present; avoid automated outreach.'
    : hostilityRisk >= 65
      ? 'Seller language shows resistance, so a human tone reset is safer than continued automation.'
      : underwritingConfidence < 55 && (thread.conversationStage === 'price_discovery' || thread.conversationStage === 'offer_reveal' || thread.conversationStage === 'negotiation')
        ? 'Offer-stage discussion is under-supported by property or pricing data.'
        : thread.inboxStatus === 'new_reply'
          ? 'The thread is active now and response speed is likely to improve close probability.'
          : ghostingRisk >= 60
            ? 'The seller may disengage without a simple next step.'
            : closeProbability >= 72
              ? 'Signals suggest meaningful intent and a path toward commitment.'
              : 'The seller is engaged enough to continue discovery, but not yet ready for a hard push.'

  const sendWindow = urgencyScore >= 70
    ? 'Within 2 hours'
    : responsivenessScore >= 65
      ? 'Same business block'
      : ghostingRisk >= 60
        ? 'Late afternoon / early evening'
        : 'Next planned touch window'

  const bestAgent = dncRisk >= 70
    ? 'Compliance Agent'
    : underwritingConfidence < 55
      ? 'Underwriting Agent'
      : hostilityRisk >= 65
        ? 'Negotiation Agent'
        : closeProbability >= 72
          ? 'Acquisitions Agent'
          : 'Follow-up Timing Agent'

  const suggestions = buildSuggestions(thread, sellerPersona, nextBestAction, likelyObjection)

  const automationEvents: CommandTimelineEvent[] = [
    {
      id: 'route',
      label: 'Automation posture',
      detail: thread.automationState === 'active' ? 'Automation is live on this thread.' : 'Operator-led control is preferred.',
      time: thread.updatedAt ?? thread.lastMessageAt ?? null,
      tone: thread.automationState === 'active' ? 'accent' : 'warning',
    },
    {
      id: 'queue',
      label: 'Queue status',
      detail: thread.queueStatus || context?.queueContext?.items?.[0]?.status || 'No queued follow-up detected.',
      time: context?.queueContext?.items?.[0]?.scheduleAt ?? thread.updatedAt ?? null,
      tone: thread.queueStatus === 'stuck' ? 'danger' : 'default',
    },
    {
      id: 'next-touch',
      label: 'Next touch',
      detail: nextBestAction,
      time: thread.lastInboundAt || thread.lastOutboundAt || thread.lastMessageAt || null,
      tone: 'success',
    },
  ]

  const liveEvents: CommandTimelineEvent[] = [
    {
      id: 'motivation',
      label: motivationScore >= 75 ? 'High-motivation seller detected' : 'Seller engagement stable',
      detail: `Motivation ${motivationScore}/100 · Close probability ${closeProbability}/100`,
      time: thread.lastInboundAt || thread.lastMessageAt || null,
      tone: motivationScore >= 75 ? 'success' : 'default',
    },
    {
      id: 'sentiment',
      label: hostilityRisk >= 60 ? 'Sentiment risk increased' : sentimentScore >= 65 ? 'Seller sentiment improved' : 'Tone holding neutral',
      detail: `Sentiment ${sentimentScore}/100 · Hostility risk ${hostilityRisk}/100`,
      time: latestInbound?.createdAt || thread.lastMessageAt || null,
      tone: hostilityRisk >= 60 ? 'danger' : sentimentScore >= 65 ? 'accent' : 'default',
    },
    {
      id: 'underwriting',
      label: underwritingConfidence >= 75 ? 'Underwriting readiness strong' : 'Underwriting still incomplete',
      detail: recommendedOfferRange ? `Offer lane ${recommendedOfferRange}` : 'Offer range not yet trustworthy.',
      time: thread.updatedAt || null,
      tone: underwritingConfidence >= 75 ? 'success' : 'warning',
    },
  ]

  const agentSignals: AgentSignal[] = [
    {
      id: 'acq',
      label: 'Acquisitions Agent',
      summary: motivationScore >= 70 ? 'Priority follow-up recommended while seller is warm.' : 'Keep discovery active; motivation is still forming.',
      confidence: clamp(closeProbability),
    },
    {
      id: 'negotiation',
      label: 'Negotiation Agent',
      summary: likelyObjection,
      confidence: clamp((negotiationFlexibility + sentimentScore) / 2),
    },
    {
      id: 'underwriting',
      label: 'Underwriting Agent',
      summary: underwritingConfidence >= 70 ? 'Offer inputs look usable.' : 'Missing valuation or condition detail is limiting pricing confidence.',
      confidence: underwritingConfidence,
    },
    {
      id: 'compliance',
      label: 'Compliance Agent',
      summary: dncRisk >= 70 ? 'Suppression-sensitive thread. Slow down outbound.' : 'No immediate compliance blockers detected.',
      confidence: clamp(100 - dncRisk),
    },
  ]

  return {
    sellerPersona,
    sellerPsychology,
    sentimentLabel: sentimentScore >= 70 ? 'Positive / engaged' : hostilityRisk >= 60 ? 'Defensive / elevated risk' : 'Measured / neutral',
    timelineLabel: urgencyScore >= 70 ? 'Immediate' : closeProbability >= 65 ? 'Near-term opportunity' : 'Longer nurture cycle',
    likelyObjection,
    recommendedOfferRange,
    nextBestAction,
    nextBestActionReason,
    sendWindow,
    motivationScore,
    urgencyScore,
    sentimentScore,
    negotiationFlexibility,
    responsivenessScore,
    closeProbability,
    dncRisk,
    hostilityRisk,
    aiConfidence,
    estimatedDealValue,
    acquisitionComplexity,
    underwritingConfidence,
    ghostingRisk,
    bestAgent,
    suggestions,
    automationEvents,
    liveEvents,
    agentSignals,
    fallbackDisplayOnly,
  }
}
