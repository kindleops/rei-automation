/**
 * NEXUS Inbox Auto-Reply Engine
 *
 * Deterministically turns inbound classified threads into queued replies.
 */

import { getSupabaseClient } from '../supabaseClient'
import type { InboxWorkflowThread, SellerStage, InboxStatus } from './inboxWorkflowData'
import { persistWorkflowPatch } from './inboxWorkflowData'
import { 
  fetchSmsTemplates, 
  renderTemplate, 
  buildTemplateContextFromThread, 
} from './templateData'
import { extractCopilotContext, generateBigPickleDraft } from './copilotContextData'
import { logInboxActivity } from './inboxActivityData'
import { asString, normalizeStatus, mapErrorMessage, type AnyRecord } from './shared'
import * as backendClient from '../api/backendClient'

const DEV = Boolean(import.meta.env?.DEV)

export interface AutoReplyResult {
  ok: boolean
  action: 'queued' | 'skipped' | 'failed' | 'manual_review_required' | 'suppressed'
  reason: string | null
  queueId?: string | null
  threadKey: string
}

/**
 * Intents that should trigger immediate suppression without a reply.
 */
const HARD_SUPPRESSION_INTENTS = new Set([
  'opt_out',
  'wrong_person',
  'hostile_or_legal',
  'not_interested'
])

/**
 * Intents that require human approval before sending.
 */
const HIGH_RISK_INTENTS = new Set([
  'unclear',
  'info_request',
  'language_switch'
])

/**
 * Maps a UI Intent (from classification) to the appropriate Seller Stage.
 */
export const mapIntentToStage = (intent: string): SellerStage | null => {
  const normalized = normalizeStatus(intent)
  switch (normalized) {
    case 'potential_interest':
      return 'interest_probe'
    case 'asking_price_provided':
      return 'price_discovery'
    case 'condition_details_provided':
      return 'condition_details'
    case 'wrong_person':
    case 'opt_out':
    case 'not_interested':
    case 'hostile_or_legal':
      return 'dead_suppressed'
    default:
      return null
  }
}

/**
 * Maps a Seller Stage to the appropriate Template Use Case Slug.
 */
export const mapStageToUseCase = (stage: SellerStage): string => {
  switch (stage) {
    case 'ownership_check':
      return 'ownership_check'
    case 'interest_probe':
      return 'soft_intent_probe'
    case 'price_discovery':
      return 'asking_price'
    case 'condition_details':
      return 'condition_probe'
    case 'offer_reveal':
      return 'offer_reveal'
    case 'negotiation':
      return 'creative_finance_probe'
    case 'contract_path':
      return 'close_handoff'
    case 'dead_suppressed':
      return 'opt_out_compliance'
    default:
      return 'follow_up'
  }
}

/**
 * Checks if current time is within a safe contact window (8am - 8pm).
 * In production, this would use the seller's local timezone.
 */
const isWithinContactWindow = (): boolean => {
  const now = new Date()
  const hour = now.getUTCHours() - 5 // Assuming EST/UTC-5 for default safety
  const localHour = hour < 0 ? 24 + hour : hour
  return localHour >= 8 && localHour < 20
}

/**
 * Safety Checks before queueing an auto-reply.
 */
const performSafetyChecks = async (
  thread: InboxWorkflowThread,
  latestInbound: AnyRecord | null,
  intent: string
): Promise<{ safe: boolean; action: AutoReplyResult['action']; reason: string | null }> => {
  // 1. Is automation active?
  if (thread.automationState === 'paused' || thread.automationState === 'manual_control') {
    return { safe: false, action: 'skipped', reason: `Automation is in ${thread.automationState} mode.` }
  }

  // 2. Is thread suppressed or archived?
  if (thread.isSuppressed || thread.isArchived) {
    return { safe: false, action: 'skipped', reason: 'Thread is suppressed or archived.' }
  }

  // 3. Hard Suppression check
  if (HARD_SUPPRESSION_INTENTS.has(intent)) {
    return { safe: false, action: 'suppressed', reason: `High-risk intent detected: ${intent}` }
  }

  // 4. Contact Window check
  if (!isWithinContactWindow()) {
    return { safe: false, action: 'manual_review_required', reason: 'Current time is outside of safe contact window (8am-8pm EST).' }
  }

  // 5. Do we have a latest inbound message to reply to?
  if (!latestInbound) {
    return { safe: false, action: 'skipped', reason: 'No inbound message found to reply to.' }
  }

  // 6. Duplicate check: Have we already replied to this message?
  const supabase = getSupabaseClient()
  const latestMessageId = asString(latestInbound.id || latestInbound.message_event_id, '')
  
  const { data: existingQueue } = await supabase
    .from('send_queue')
    .select('id')
    .eq('metadata->>replied_to_message_id', latestMessageId)
    .limit(1)

  if (existingQueue && existingQueue.length > 0) {
    return { safe: false, action: 'skipped', reason: `Already queued a reply for message ID: ${latestMessageId}` }
  }

  // 7. Collision check: Is there any other pending/ready message in queue?
  const { data: pendingQueue } = await supabase
    .from('send_queue')
    .select('id')
    .eq('to_phone_number', thread.phoneNumber || thread.canonicalE164)
    .in('queue_status', ['queued', 'scheduled', 'approval'])
    .limit(1)

  if (pendingQueue && pendingQueue.length > 0) {
    return { safe: false, action: 'skipped', reason: 'A message is already pending delivery for this contact.' }
  }

  return { safe: true, action: 'queued', reason: null }
}

/**
 * Core Auto-Reply Execution Logic.
 */
export const executeAutoReply = async (
  thread: InboxWorkflowThread,
  latestInbound: AnyRecord | null,
  options: { dryRun?: boolean } = {}
): Promise<AutoReplyResult> => {
  const threadKey = thread.threadKey
  const currentIntent = normalizeStatus(thread.uiIntent || (thread as any).detected_intent || 'unclear')
  
  try {
    // 1. Safety Checks
    const safety = await performSafetyChecks(thread, latestInbound, currentIntent)
    
    // Audit Logging for safety check result
    if (!safety.safe) {
      if (safety.action === 'suppressed') {
        await persistWorkflowPatch(thread as any, { isSuppressed: true, inboxStatus: 'suppressed', conversationStage: 'dead_suppressed' } as any)
        await logInboxActivity({
          event_type: 'stage_change',
          thread_key: threadKey,
          actor: 'Auto-Reply Engine',
          title: 'Thread Suppressed',
          description: `Automatically suppressed thread due to intent: ${currentIntent}`,
          metadata: { intent: currentIntent, action: 'suppression' },
          undo_payload: null
        })
      }

      return { ok: false, action: safety.action, reason: safety.reason, threadKey }
    }

    // 2. Determine Stage Transition
    const nextStage = mapIntentToStage(currentIntent)
    
    if (DEV) {
      console.log(`[AutoReply] Processing thread ${threadKey}`, {
        currentIntent,
        currentStage: thread.conversationStage,
        nextStage,
        dryRun: options.dryRun
      })
    }

    // 3. Generate Draft (Template or AI)
    let replyText = ''
    let useCaseUsed = 'manual_reply'
    let templateIdUsed: string | null = null

    // For complex stages, "unclear" intent, or specific negotiations, use AI
    if (thread.conversationStage === 'negotiation' || HIGH_RISK_INTENTS.has(currentIntent)) {
      const copilotCtx = extractCopilotContext(thread as any)
      if (copilotCtx) {
        const aiDraft = generateBigPickleDraft(copilotCtx, thread as any)
        if (aiDraft.sellerSafe) {
          replyText = aiDraft.draftBody
          useCaseUsed = 'ai_pickle_draft'
        } else {
          return { ok: false, action: 'manual_review_required', reason: 'AI draft contains sensitive walkaway/offer price and is not seller-safe.', threadKey }
        }
      }
    }

    // Fallback to Template pool
    if (!replyText) {
      const useCase = mapStageToUseCase(nextStage || thread.conversationStage)
      const templates = await fetchSmsTemplates({ useCase, limit: 5 })
      const template = templates.find(t => t.active) || templates[0]

      if (template) {
        const context = buildTemplateContextFromThread(thread, null)
        const rendered = renderTemplate(template, context)
        if (rendered.missingVariables.length === 0) {
          replyText = rendered.renderedText
          useCaseUsed = template.useCaseSlug
          templateIdUsed = template.templateId
        } else {
          return { ok: false, action: 'manual_review_required', reason: `Template variables missing: ${rendered.missingVariables.join(', ')}`, threadKey }
        }
      }
    }

    if (!replyText) {
      return { ok: false, action: 'manual_review_required', reason: 'Failed to find or generate a valid reply text.', threadKey }
    }

    // 4. Queue the Reply
    // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
    const now = new Date().toISOString()
    const latestMessageId = asString(latestInbound?.id || latestInbound?.message_event_id, '')

    // Production Gate: dryRun mode or uncertain intent requires approval
    const finalQueueStatus = (options.dryRun || HIGH_RISK_INTENTS.has(currentIntent)) ? 'approval' : 'queued'

    const payload = {
      queue_status: finalQueueStatus,
      queue_key: `auto:${threadKey}:${Date.now()}`,
      to_phone_number: thread.phoneNumber || thread.canonicalE164,
      from_phone_number: thread.ourNumber,
      message_body: replyText,
      message_text: replyText,
      scheduled_for: now,
      send_priority: 5,
      use_case_template: useCaseUsed,
      template_id: templateIdUsed,
      master_owner_id: thread.ownerId,
      property_id: thread.propertyId,
      prospect_id: thread.prospectId,
      metadata: {
        source: 'auto_reply_engine',
        replied_to_message_id: latestMessageId,
        inferred_intent: currentIntent,
        original_stage: thread.conversationStage,
        target_stage: nextStage || thread.conversationStage,
        is_dry_run: options.dryRun,
        requires_approval: finalQueueStatus === 'approval'
      },
      created_at: now,
    }

    const queueResult = await backendClient.autoQueueReply(payload)
    if (!queueResult.ok) {
      throw new Error(`Queue insert failed: ${queueResult.message}`)
    }
    const queueData = queueResult.data

    // 5. Persist Thread State
    const statusToSet: InboxStatus = finalQueueStatus === 'approval' ? 'ai_draft_ready' : 'queued'
    const stagePatch: Partial<InboxWorkflowThread> = {
      inboxStatus: statusToSet,
      isRead: true,
      updatedAt: now
    }
    if (nextStage) {
      stagePatch.conversationStage = nextStage
    }

    await persistWorkflowPatch(thread as any, stagePatch as any)

    // 6. Audit Logging
    await logInboxActivity({
      event_type: 'message_sent', // closest match for "reply queued"
      thread_key: threadKey,
      actor: 'Auto-Reply Engine',
      title: finalQueueStatus === 'approval' ? 'Auto-Reply Prepared (Draft)' : 'Auto-Reply Queued',
      description: `Targeting stage: ${nextStage || thread.conversationStage}. UseCase: ${useCaseUsed}`,
      metadata: { queue_id: queueData?.id, intent: currentIntent, dry_run: options.dryRun },
      undo_payload: { queue_id: queueData?.id, action: 'cancel_queue' }
    })

    return { 
      ok: true, 
      action: 'queued', 
      reason: `Queued reply (Status: ${finalQueueStatus}) using ${useCaseUsed}`, 
      queueId: asString((queueData as Record<string, unknown>)?.id || (queueData as Record<string, unknown>)?.queue_id || null, '') || null,
      threadKey 
    }

  } catch (error) {
    if (DEV) console.error(`[AutoReply] execution error on ${threadKey}`, error)
    return { ok: false, action: 'failed', reason: mapErrorMessage(error), threadKey }
  }
}

