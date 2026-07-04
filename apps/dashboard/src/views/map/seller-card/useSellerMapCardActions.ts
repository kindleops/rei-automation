import { useCallback, useState } from 'react'
import type { InboxThread } from '../../../domain/inbox/inbox-model-types'
import type { ThreadContext, ThreadMessage } from '../../../lib/data/inboxData'
import {
  queueReplyFromInbox,
  sendInboxMessageNow,
} from '../../../lib/data/inboxData'
import { resolveCanonicalThreadStateKey } from '../../../domain/inbox/resolveCanonicalThreadStateKey'
import { resolveCommandMapSellerPhone } from '../../../lib/data/commandMapData'
import {
  buildTemplateContextFromThread,
  fetchTemplatesByUseCase,
  getRecommendedTemplates,
  renderTemplate,
} from '../../../lib/data/templateData'
import type { SmsTemplate } from '../../../lib/data/templateData'
import type { TemplateActionPayload } from '../../../modules/inbox/components/TemplatePopover'
import { translateText } from '../../../modules/inbox/translate.api'
import type { SellerMapCardViewModel } from './seller-map-card.types'
import { asNumber, firstDefined, text } from './seller-map-card-formatters'

export type FollowUpButtonState = 'idle' | 'sending' | 'sent' | 'blocked' | 'failed'

const MAP_THREAD_PHONE_KEYS = [
  'canonical_e164',
  'canonicalE164',
  'seller_phone',
  'sellerPhone',
  'phone_number',
  'phoneNumber',
  'to_phone_number',
  'prospect_best_phone',
  'prospectBestPhone',
  'display_phone',
  'displayPhone',
  'best_phone',
  'bestPhone',
  'phone',
]

export const resolveMapThreadPhone = (record: Record<string, unknown>): string => {
  const raw = text(firstDefined(record, MAP_THREAD_PHONE_KEYS))
  if (!raw || raw.toLowerCase() === 'no phone') return ''
  return raw
}

const resolveMapThreadKey = (
  vm: SellerMapCardViewModel,
  record: Record<string, unknown>,
): string => {
  const explicit = text(firstDefined(record, ['thread_key', 'threadKey', 'conversation_id']))
  if (explicit) return explicit
  if (vm.threadKey) return vm.threadKey
  if (vm.propertyId) return `property:${vm.propertyId}`
  return ''
}

const pickOwnershipCheckTemplate = (templates: SmsTemplate[]): SmsTemplate | null => {
  if (!templates.length) return null
  const english = templates.find((template) => template.language?.toLowerCase() === 'english')
  return english || templates.find((template) => template.isFirstTouch) || templates[0]
}

export const buildThreadFromViewModel = (
  vm: SellerMapCardViewModel,
  record: Record<string, unknown>,
  overrides: { phone?: string | null; prospectId?: string | null } = {},
): InboxThread => {
  const threadKey = resolveMapThreadKey(vm, record)
  const phone = text(overrides.phone) || resolveMapThreadPhone(record)
  const ownerId = text(firstDefined(record, ['master_owner_id', 'masterOwnerId'])) || vm.masterOwner.id || undefined
  const prospectId = text(overrides.prospectId) || text(firstDefined(record, ['prospect_id', 'prospectId'])) || undefined
  const market = text(firstDefined(record, ['market', 'filter_market', 'display_market'])) || 'unknown'
  const propertyState = text(firstDefined(record, ['property_address_state', 'propertyAddressState', 'state'])) || undefined

  return {
    id: threadKey || vm.propertyId,
    leadId: ownerId || vm.propertyId,
    marketId: market,
    market,
    marketName: market,
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
    ownerId,
    prospectId,
    phoneNumber: phone,
    canonicalE164: phone,
    sellerPhone: phone,
    display_phone: phone,
    prospect_best_phone: phone,
    bestPhone: phone,
    propertyAddressFull: vm.property.address,
    propertyAddress: vm.property.address,
    property_address_state: propertyState,
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
      let sendThread = thread
      const ensureCanonicalSendThread = async (): Promise<InboxThread | null> => {
        let candidate = sendThread
        let canonicalKey = resolveCanonicalThreadStateKey(candidate as unknown as Record<string, unknown>)
        if (canonicalKey) {
          return canonicalKey === candidate.threadKey
            ? candidate
            : { ...candidate, threadKey: canonicalKey, id: canonicalKey }
        }

        const resolved = await resolveCommandMapSellerPhone(viewModel.propertyId, {
          prospectId: text(firstDefined(record, ['prospect_id', 'prospectId'])) || null,
          masterOwnerId: viewModel.masterOwner.id,
        })
        if (!resolved.phone) return null

        candidate = buildThreadFromViewModel(viewModel, record, {
          phone: resolved.phone,
          prospectId: resolved.prospectId,
        })
        canonicalKey = resolveCanonicalThreadStateKey(candidate as unknown as Record<string, unknown>)
        if (!canonicalKey) return null
        return { ...candidate, threadKey: canonicalKey, id: canonicalKey }
      }

      const resolvedSendThread = await ensureCanonicalSendThread()
      if (!resolvedSendThread) {
        setFollowUpState('blocked')
        window.setTimeout(() => setFollowUpState('idle'), 2400)
        return
      }
      sendThread = resolvedSendThread

      let followUpTemplate: SmsTemplate | null = null
      if (eligibility.isUncontacted) {
        followUpTemplate = pickOwnershipCheckTemplate(await fetchTemplatesByUseCase('ownership_check'))
      } else {
        const templates = await getRecommendedTemplates(sendThread, threadContext ?? null)
        followUpTemplate = templates.find((template) => template.isFollowUp)
          || templates.find((template) => template.useCaseSlug.includes('follow'))
          || templates[0]
          || null
      }

      if (!followUpTemplate) {
        setFollowUpState('failed')
        window.setTimeout(() => setFollowUpState('idle'), 2400)
        return
      }

      const context = buildTemplateContextFromThread(sendThread, threadContext ?? null)
      const { renderedText: messageText } = renderTemplate(followUpTemplate, context)
      if (!messageText.trim()) {
        setFollowUpState('failed')
        window.setTimeout(() => setFollowUpState('idle'), 2400)
        return
      }

      const result = await sendInboxMessageNow(sendThread, messageText, {
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
    record,
    thread,
    threadContext,
    viewModel.followUpEligibility,
    viewModel.masterOwner.id,
    viewModel.propertyId,
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