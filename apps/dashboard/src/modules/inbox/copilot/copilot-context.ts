/**
 * NEXUS AI Copilot — Thread Context Extraction
 *
 * Extracts and normalizes selected-thread context into a capsule
 * that the copilot can display and inject into AI conversations.
 */

import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import type { ThreadContext, ThreadIntelligenceRecord } from '../../../lib/data/inboxData'

export interface CopilotThreadContext {
  sellerName: string
  propertyAddress: string
  market: string
  sellerStage: string
  inboxStatus: string
  urgency: string
  lastInbound: string | null
  lastOutbound: string | null
  phoneNumber: string | null
  ownerId: string | null
  propertyId: string | null
  prospectId: string | null
  equityPercent: string | null
  motivationScore: number | null
  arv: string | null
  cashOffer: string | null
  aiOffer: string | null
  walkaway: string | null
  missingFields: string[]
  linkedUrls: Record<string, string | null>
}

const str = (v: unknown): string => String(v ?? '').trim()
const present = (v: unknown): boolean => {
  const s = str(v).toLowerCase()
  return Boolean(s) && s !== 'unknown' && s !== 'n/a' && s !== 'null' && s !== 'undefined'
}

const get = (t: InboxWorkflowThread, key: string): unknown => {
  const row = t as unknown as Record<string, unknown>
  return row[key] ?? row[key.replace(/_/g, '')] ?? null
}

const formatMoney = (v: unknown): string | null => {
  const raw = String(v ?? '').replace(/[,$\s]/g, '')
  const n = Number(raw)
  if (!Number.isFinite(n) || n === 0) return null
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`
  return `$${Math.round(n).toLocaleString()}`
}

const relativeTime = (iso: string | null): string | null => {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export const extractCopilotContext = (
  thread: InboxWorkflowThread | null,
  _context?: ThreadContext | null,
  _intelligence?: ThreadIntelligenceRecord | null,
): CopilotThreadContext | null => {
  if (!thread) return null

  const sellerName = thread.ownerDisplayName || thread.ownerName || str(get(thread, 'sellerName')) || 'Seller Unknown'
  const propertyAddress = thread.propertyAddress || thread.subject || 'Property Unknown'
  const market = thread.market || thread.marketId || 'Unknown Market'

  const stageLabel = (thread.conversationStage || 'ownership_check').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const statusLabel = (thread.inboxStatus || 'needs_review').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

  const urgencyMap: Record<string, string> = {
    urgent: '🔴 Urgent',
    high: '🟠 High',
    normal: '🟡 Normal',
    low: '🟢 Low',
  }
  const urgency = urgencyMap[thread.priority || 'normal'] || '🟡 Normal'

  // Missing fields detection
  const missingFields: string[] = []
  if (!present(get(thread, 'arv') || get(thread, 'afterRepairValue'))) missingFields.push('ARV')
  if (!present(get(thread, 'estimatedRepairCost') || get(thread, 'estimated_repair_cost'))) missingFields.push('Repair Cost')
  if (!present(get(thread, 'equityPercent') || get(thread, 'equity_percent'))) missingFields.push('Equity %')
  if (!present(get(thread, 'rentRoll') || get(thread, 'rent_roll'))) missingFields.push('Rent Roll')
  if (!present(get(thread, 'sellerAsk') || get(thread, 'seller_ask'))) missingFields.push('Seller Ask')
  if (!present(get(thread, 'beds') || get(thread, 'bedrooms'))) missingFields.push('Beds')
  if (!present(get(thread, 'baths') || get(thread, 'bathrooms'))) missingFields.push('Baths')

  const linkedUrls: Record<string, string | null> = {
    podioUrl: str(get(thread, 'podioUrl') || get(thread, 'podio_url')) || null,
    zillowUrl: propertyAddress !== 'Property Unknown' ? `https://www.zillow.com/homes/${encodeURIComponent(propertyAddress)}` : null,
  }

  console.log('[AICopilotContext] selectedThreadContext', {
    sellerName,
    propertyAddress,
    market,
    stage: thread.conversationStage,
    status: thread.inboxStatus,
    urgency: thread.priority,
    missingFields: missingFields.length,
  })

  return {
    sellerName,
    propertyAddress,
    market,
    sellerStage: stageLabel,
    inboxStatus: statusLabel,
    urgency,
    lastInbound: relativeTime(thread.lastInboundAt),
    lastOutbound: relativeTime(thread.lastOutboundAt),
    phoneNumber: thread.phoneNumber || thread.canonicalE164 || null,
    ownerId: thread.ownerId || null,
    propertyId: thread.propertyId || null,
    prospectId: thread.prospectId || null,
    equityPercent: str(get(thread, 'equityPercent') || get(thread, 'equity_percent')) || null,
    motivationScore: Number(get(thread, 'motivationScore') || get(thread, 'motivation_score')) || null,
    arv: formatMoney(get(thread, 'arv') || get(thread, 'afterRepairValue')),
    cashOffer: formatMoney(get(thread, 'cashOffer') || get(thread, 'cash_offer')),
    aiOffer: formatMoney(get(thread, 'aiRecommendedOffer') || get(thread, 'ai_offer')),
    walkaway: formatMoney(get(thread, 'walkawayPrice') || get(thread, 'walkaway_price')),
    missingFields,
    linkedUrls,
  }
}

// Big Pickle Draft Generator
export interface BigPickleDraft {
  draftBody: string
  tone: string
  intent: string
  confidence: number
  suggestedNextStage: string | null
  internalNotes: string
  sellerSafe: boolean
}

export const generateBigPickleDraft = (
  ctx: CopilotThreadContext,
  thread: InboxWorkflowThread,
): BigPickleDraft => {
  console.log('[BigPickleCopilot] draftGenerated', {
    seller: ctx.sellerName,
    stage: ctx.sellerStage,
    status: ctx.inboxStatus,
  })

  const sellerFirst = ctx.sellerName.split(' ')[0] || 'there'
  const stage = thread.conversationStage || 'ownership_check'
  const latestReply = thread.latestMessageBody || thread.lastMessageBody || ''

  let draftBody = ''
  let tone = 'friendly-professional'
  let intent = 'advance-conversation'
  let confidence = 0.72
  let suggestedNextStage: string | null = null
  let internalNotes = ''

  switch (stage) {
    case 'ownership_check':
      draftBody = `Hi ${sellerFirst}! 👋 Thanks for getting back to me. I wanted to reach out because I noticed your property and was curious — are you the current owner? We work with homeowners who might be considering selling, and I'd love to learn more about your situation if you're open to it.`
      tone = 'warm-casual'
      intent = 'verify-ownership'
      confidence = 0.8
      suggestedNextStage = 'interest_probe'
      internalNotes = 'Standard ownership verification. No pricing disclosed.'
      break
    case 'interest_probe':
      draftBody = `Hey ${sellerFirst}, appreciate you confirming! 🙌 I work with a team that buys properties directly — no agents, no fees, and we close on your timeline. Have you thought about what it would take for you to consider an offer?`
      tone = 'engaging-curious'
      intent = 'probe-motivation'
      confidence = 0.75
      suggestedNextStage = 'price_discovery'
      internalNotes = 'Probing seller motivation without anchoring on price.'
      break
    case 'price_discovery':
      draftBody = `Thanks for sharing that, ${sellerFirst}! That really helps me understand where you're coming from. Let me put together some numbers based on the property details and I'll get back to you with what we can do. 📊 Do you have a general range in mind for what you'd be looking for?`
      tone = 'professional-warm'
      intent = 'gather-ask-price'
      confidence = 0.7
      suggestedNextStage = 'offer_reveal'
      internalNotes = `Attempting to get seller anchor. DO NOT reveal walkaway (${ctx.walkaway ?? 'not set'}). AI offer: ${ctx.aiOffer ?? 'pending'}.`
      break
    case 'condition_details':
      draftBody = `Hi ${sellerFirst}, thanks again for the conversation! 🏠 To make sure we give you the best possible offer, could you tell me a bit about the property's current condition? Things like the roof, HVAC, any repairs needed — that kind of thing. It helps us put together a fair number for you.`
      tone = 'professional-curious'
      intent = 'gather-condition'
      confidence = 0.73
      suggestedNextStage = 'offer_reveal'
      internalNotes = 'Need condition details for underwriting. Missing: ' + ctx.missingFields.join(', ')
      break
    case 'offer_reveal':
      draftBody = `Hey ${sellerFirst}! 🎉 Great news — I've had my team review the property details and I'd love to set up a quick call to walk you through what we can offer. When works best for a 5-minute chat? We move fast and can close whenever works for you.`
      tone = 'confident-excited'
      intent = 'schedule-offer-call'
      confidence = 0.65
      suggestedNextStage = 'negotiation'
      internalNotes = `NEVER text the actual offer amount. Schedule call instead. Internal offer: ${ctx.aiOffer ?? ctx.cashOffer ?? 'needs underwriting'}.`
      break
    case 'negotiation':
      draftBody = `Hi ${sellerFirst}, I appreciate you being upfront about your expectations! 🤝 Let me go back to my team and see if there's any flexibility on our end. I want to make this work for both of us. Can I follow up with you ${latestReply.toLowerCase().includes('tomorrow') ? 'tomorrow' : 'later today'}?`
      tone = 'collaborative-firm'
      intent = 'negotiate-bridge'
      confidence = 0.6
      suggestedNextStage = 'contract_path'
      internalNotes = `Active negotiation. Walkaway: ${ctx.walkaway ?? 'not set'}. Do NOT reveal internal ceiling.`
      break
    case 'contract_path':
      draftBody = `Hey ${sellerFirst}! 🎯 Looks like we're on the same page. I'm going to have our title team start the process. They'll reach out with next steps — it's super easy and we handle everything. Excited to get this done for you!`
      tone = 'confident-closing'
      intent = 'advance-to-contract'
      confidence = 0.82
      suggestedNextStage = null
      internalNotes = 'Move to contract. Ensure title is clear before sending PSA.'
      break
    default:
      draftBody = `Hi ${sellerFirst}, just following up on our conversation. Is there anything else you'd like to know about the process? Happy to answer any questions! 😊`
      tone = 'friendly-followup'
      intent = 'general-followup'
      confidence = 0.55
      suggestedNextStage = null
      internalNotes = 'Generic follow-up. Review thread for better targeting.'
  }

  return {
    draftBody,
    tone,
    intent,
    confidence,
    suggestedNextStage,
    internalNotes,
    sellerSafe: !draftBody.includes(ctx.walkaway ?? 'NEVER_MATCH') && !draftBody.includes(ctx.aiOffer ?? 'NEVER_MATCH'),
  }
}

