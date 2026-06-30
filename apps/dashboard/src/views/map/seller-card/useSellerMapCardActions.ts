import { useCallback, useState } from 'react'
import type { InboxThread } from '../../../domain/inbox/inbox-model-types'
import type { ThreadContext, ThreadMessage } from '../../../lib/data/inboxData'
import {
  queueReplyFromInbox,
  sendInboxMessageNow,
} from '../../../lib/data/inboxData'
import {
  buildTemplateContextFromThread,
  getRecommendedTemplates,
  renderTemplate,
} from '../../../lib/data/templateData'
import type { TemplateActionPayload } from '../../../modules/inbox/components/TemplatePopover'
import { translateText } from '../../../modules/inbox/translate.api'
import type { SellerMapCardViewModel } from './seller-map-card.types'
import { asNumber, text } from './seller-map-card-formatters'

export type FollowUpButtonState = 'idle' | 'sending' | 'sent' | 'blocked' | 'failed'

export const buildThreadFromViewModel = (
  vm: SellerMapCardViewModel,
  record: Record<string, unknown>,
): InboxThread => {
  const threadKey = vm.threadKey || text(record.conversation_id) || vm.propertyId
  const phone = text(record.canonical_e164 || record.phone_number || record.seller_phone || record.to_phone_number)
  return {
    id: threadKey,
    leadId: vm.masterOwner.id || vm.propertyId,
    marketId: text(record.market || record.filter_market) || 'unknown',
    ownerName: vm.masterOwner.displayName,
    sellerName: vm.masterOwner.displayName,
    subject: vm.property.address,
    preview: vm.activity.detail || '',
    status: 'read',
    priority: vm.operations.temperature === 'hot' ? 'urgent' : 'normal',
    sentiment: vm.operations.temperature === 'hot' ? 'hot' : vm.operations.temperature === 'warm' ? 'warm' : 'neutral',
    messageCount: 0,
    lastMessageLabel: vm.activity.headline,
    lastMessageIso: vm.conversation.lastInboundAt || vm.conversation.lastOutboundAt || new Date().toISOString(),
    unreadCount: 0,
    aiDraft: null,
    labels: [],
    threadKey,
    propertyId: vm.propertyId,
    masterOwnerId: vm.masterOwner.id || undefined,
    phoneNumber: phone,
    canonicalE164: phone,
    sellerPhone: phone,
    propertyAddressFull: vm.property.address,
    propertyAddress: vm.property.address,
    ownerDisplayName: vm.masterOwner.displayName,
    lifecycle_stage: vm.operations.stage,
    operational_status: vm.operations.status,
    lead_temperature: vm.operations.temperature,
    isSuppressed: vm.masterOwner.suppressed,
    owner_priority_score: vm.masterOwner.priorityScore ?? undefined,
    finalAcquisitionScore: vm.masterOwner.priorityScore ?? undefined,
    inboxStage: vm.operations.stage,
    inboxStatus: vm.operations.status,
    inbound_count: asNumber(record.inbound_count) ?? 0,
    outbound_count: asNumber(record.outbound_count ?? record.sent_count) ?? 0,
  } as InboxThread
}

export const useSellerMapCardActions = ({
  viewModel,
  record,
  threadContext,
  onActivityRefresh,
  onMessagesRefresh,
}: {
  viewModel: SellerMapCardViewModel
  record: Record<string, unknown>
  threadContext?: ThreadContext | null
  onActivityRefresh?: () => void
  onMessagesRefresh?: () => void
}) => {
  const [followUpState, setFollowUpState] = useState<FollowUpButtonState>('idle')
  const [isSending, setIsSending] = useState(false)
  const [isTranslatingDraft, setIsTranslatingDraft] = useState(false)

  const thread = buildThreadFromViewModel(viewModel, record)

  const executeFollowUp = useCallback(async () => {
    if (followUpState === 'sending') return

    const eligibility = viewModel.followUpEligibility
    if (!eligibility.canExecute) {
      setFollowUpState('blocked')
      window.setTimeout(() => setFollowUpState('idle'), 1800)
      return
    }

    setFollowUpState('sending')
    try {
      const templates = await getRecommendedTemplates(thread, threadContext ?? null)
      const followUpTemplate = eligibility.isUncontacted
        ? templates.find((template) => template.useCaseSlug === 'ownership_check')
          || templates.find((template) => template.useCaseSlug.includes('ownership'))
          || templates.find((template) => !template.isFollowUp)
        : templates.find((template) => template.isFollowUp)
          || templates.find((template) => template.useCaseSlug.includes('follow'))
          || templates[0]

      if (!followUpTemplate) {
        setFollowUpState('failed')
        window.setTimeout(() => setFollowUpState('idle'), 2400)
        return
      }

      const context = buildTemplateContextFromThread(thread, threadContext ?? null)
      const { renderedText: messageText } = renderTemplate(followUpTemplate, context)
      if (!messageText.trim()) {
        setFollowUpState('failed')
        window.setTimeout(() => setFollowUpState('idle'), 2400)
        return
      }

      const result = await sendInboxMessageNow(thread, messageText, {
        selectedTemplate: followUpTemplate,
        threadContext: threadContext ?? null,
      })

      if (!result.ok) {
        setFollowUpState(result.suppressionBlocked ? 'blocked' : 'failed')
        window.setTimeout(() => setFollowUpState('idle'), 2400)
        return
      }

      setFollowUpState('sent')
      onActivityRefresh?.()
      onMessagesRefresh?.()
      window.setTimeout(() => setFollowUpState('idle'), 2400)
    } catch {
      setFollowUpState('failed')
      window.setTimeout(() => setFollowUpState('idle'), 2400)
    }
  }, [
    followUpState,
    onActivityRefresh,
    onMessagesRefresh,
    thread,
    threadContext,
    viewModel.followUpEligibility,
  ])

  const sendMessage = useCallback(async (messageText: string, template?: TemplateActionPayload['template']) => {
    if (!messageText.trim() || isSending || viewModel.messagingBlocked) return { ok: false as const }
    setIsSending(true)
    try {
      const result = await sendInboxMessageNow(thread, messageText.trim(), {
        selectedTemplate: template,
        threadContext: threadContext ?? null,
      })
      if (result.ok) {
        onActivityRefresh?.()
        onMessagesRefresh?.()
      }
      return result
    } finally {
      setIsSending(false)
    }
  }, [isSending, onActivityRefresh, onMessagesRefresh, thread, threadContext, viewModel.messagingBlocked])

  const sendTemplate = useCallback(async (payload: TemplateActionPayload) => {
    return sendMessage(payload.text, payload.template)
  }, [sendMessage])

  const queueTemplate = useCallback(async (payload: TemplateActionPayload) => {
    if (!payload.text.trim() || viewModel.messagingBlocked) return { ok: false as const }
    return queueReplyFromInbox(thread, payload.text, {
      selectedTemplate: payload.template,
      threadContext: threadContext ?? null,
    })
  }, [thread, threadContext, viewModel.messagingBlocked])

  const translateDraft = useCallback(async (draft: string) => {
    const trimmed = draft.trim()
    if (!trimmed) return null
    setIsTranslatingDraft(true)
    try {
      const result = await translateText({
        text: trimmed,
        sourceLanguage: 'en',
        targetLanguage: 'es',
        mode: 'draft',
      })
      return result.translatedText
    } finally {
      setIsTranslatingDraft(false)
    }
  }, [])

  return {
    thread,
    followUpState,
    isSending,
    isTranslatingDraft,
    executeFollowUp,
    sendMessage,
    sendTemplate,
    queueTemplate,
    translateDraft,
  }
}

export type { ThreadMessage }