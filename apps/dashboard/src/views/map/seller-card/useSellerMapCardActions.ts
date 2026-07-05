import { useCallback, useState } from 'react'
import type { InboxThread } from '../../../domain/inbox/inbox-model-types'
import type { ThreadContext, ThreadMessage } from '../../../lib/data/inboxData'
import {
  queueReplyFromInbox,
  sendInboxMessageNow,
} from '../../../lib/data/inboxData'

import { normalizeState } from '../../../lib/data/textgridRouting'
import {
  buildTemplateContextFromThread,
  getRecommendedTemplates,
  renderTemplate,
} from '../../../lib/data/templateData'
import {
  canonicalizeOwnerLanguage,
  pickOwnershipCheckTemplateForMap,
} from './ownership-check-template-picker'
import type { SmsTemplate } from '../../../lib/data/templateData'
import type { TemplateActionPayload } from '../../../modules/inbox/components/TemplatePopover'
import { translateText } from '../../../modules/inbox/translate.api'
import { buildSellerGreetingValues } from '../../../domain/inbox/seller-greeting'
import {
  buildOwnershipCheckTemplateContext,
  resolveMapOwnershipCheckIdentity,
} from '../../../domain/map/resolve-map-ownership-check'
import { sendMapOwnershipCheck } from '../../../domain/map/send-map-ownership-check'
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

const parseStateFromAddress = (address: string): string | undefined => {
  const match = address.match(/,\s*([A-Za-z]{2})\s*(?:\d{5}(?:-\d{4})?)?\s*$/)
  return match?.[1]?.toUpperCase()
}

const parseStateFromMarket = (market: string): string | undefined => {
  const match = market.match(/,\s*([A-Za-z]{2})\s*$/i)
  return match?.[1]?.toUpperCase()
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
  const propertyStateRaw = text(firstDefined(record, ['property_address_state', 'propertyAddressState', 'state']))
    || parseStateFromAddress(vm.property.address)
    || parseStateFromMarket(market)
  const propertyState = propertyStateRaw ? normalizeState(propertyStateRaw).toUpperCase() : undefined
  const greeting = buildSellerGreetingValues({
    ...record,
    prospect_first_name: overrides.prospectId
      ? (record.prospect_first_name ?? record.prospectFirstName)
      : record.prospect_first_name,
    prospect_full_name: record.prospect_full_name ?? record.prospectFullName,
    owner_display_name: vm.masterOwner.displayName,
    master_owner_display_name: vm.masterOwner.displayName,
    owner_name: vm.masterOwner.displayName,
  })
  const sellerDisplayName = greeting.seller_name || text(firstDefined(record, ['prospect_full_name', 'prospectFullName'])) || ''

  return {
    id: threadKey || vm.propertyId,
    leadId: ownerId || vm.propertyId,
    marketId: market,
    market,
    marketName: market,
    ownerName: vm.masterOwner.displayName,
    sellerName: sellerDisplayName,
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
    seller_name: sellerDisplayName,
    prospect_full_name: text(firstDefined(record, ['prospect_full_name', 'prospect_name', 'prospectFullName'])),
    prospect_first_name: text(firstDefined(record, ['prospect_first_name', 'prospectFirstName'])),
    owner_display_name: vm.masterOwner.displayName,
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
  const [followUpError, setFollowUpError] = useState<string | null>(null)
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
    setFollowUpError(null)
    try {
      if (eligibility.isUncontacted) {
        const identityResult = await resolveMapOwnershipCheckIdentity(viewModel.propertyId)
        if (!identityResult.ok) {
          setFollowUpError(identityResult.error)
          setFollowUpState('blocked')
          window.setTimeout(() => {
            setFollowUpState('idle')
            setFollowUpError(null)
          }, 4000)
          return
        }

        const identity = identityResult.identity
        const templateContext = buildOwnershipCheckTemplateContext(identity)
        const ownerLanguage = canonicalizeOwnerLanguage(identity.ownerLanguage)
        const templateSelection = await pickOwnershipCheckTemplateForMap(
          templateContext,
          ownerLanguage,
          {
            propertyId: identity.propertyId,
            recipientPhone: identity.recipientPhone,
          },
        )

        if (!templateSelection) {
          setFollowUpError('Ownership check template unavailable')
          setFollowUpState('failed')
          window.setTimeout(() => {
            setFollowUpState('idle')
            setFollowUpError(null)
          }, 4000)
          return
        }

        const sendThread = buildThreadFromViewModel(viewModel, record, {
          phone: identity.recipientPhone,
          prospectId: identity.prospectId,
        })
        const canonicalThread: InboxThread = {
          ...sendThread,
          threadKey: identity.recipientPhone,
          id: identity.recipientPhone,
          phoneNumber: identity.recipientPhone,
          canonicalE164: identity.recipientPhone,
          sellerPhone: identity.recipientPhone,
          bestPhone: identity.recipientPhone,
          display_phone: identity.recipientPhone,
          prospect_best_phone: identity.recipientPhone,
          phoneNumberId: identity.phoneId,
          ownerId: identity.masterOwnerId,
          prospectId: identity.prospectId,
          sellerName: identity.sellerDisplayName,
          seller_name: identity.sellerDisplayName,
          prospect_first_name: identity.prospectFirstName,
          prospect_full_name: identity.prospectFullName,
          ownerDisplayName: identity.ownerDisplayName,
          ownerName: identity.ownerDisplayName,
          propertyAddressFull: identity.propertyAddress,
          propertyAddress: identity.propertyAddress,
        }

        const result = await sendMapOwnershipCheck({
          identity,
          selection: templateSelection,
          thread: canonicalThread,
          threadContext: threadContext ?? null,
        })

        if (!result.ok) {
          setFollowUpError(result.errorMessage || 'Send failed')
          setFollowUpState('failed')
          window.setTimeout(() => {
            setFollowUpState('idle')
            setFollowUpError(null)
          }, 4000)
          return
        }

        setFollowUpState('sent')
        onActivityRefresh?.()
        onMessagesRefresh?.()
        window.setTimeout(() => setFollowUpState('idle'), 2400)
        return
      }

      let followUpTemplate: SmsTemplate | null = null
      const sendThread = thread
      const templateContext = buildTemplateContextFromThread(sendThread, threadContext ?? null)

      const templates = await getRecommendedTemplates(sendThread, threadContext ?? null)
      followUpTemplate = templates.find((template) => template.isFollowUp)
        || templates.find((template) => template.useCaseSlug.includes('follow'))
        || templates[0]
        || null

      if (!followUpTemplate) {
        setFollowUpError('Follow-up template unavailable')
        setFollowUpState('failed')
        window.setTimeout(() => {
          setFollowUpState('idle')
          setFollowUpError(null)
        }, 4000)
        return
      }

      const { renderedText: messageText } = renderTemplate(followUpTemplate, templateContext)
      if (!messageText.trim()) {
        setFollowUpError('Template missing seller name or property details')
        setFollowUpState('failed')
        window.setTimeout(() => {
          setFollowUpState('idle')
          setFollowUpError(null)
        }, 4000)
        return
      }

      const result = await sendInboxMessageNow(sendThread, messageText, {
        selectedTemplate: followUpTemplate,
        threadContext: threadContext ?? null,
      })

      if (!result.ok) {
        setFollowUpError(result.errorMessage || result.guardReason || 'Send failed')
        setFollowUpState(result.suppressionBlocked ? 'blocked' : 'failed')
        window.setTimeout(() => {
          setFollowUpState('idle')
          setFollowUpError(null)
        }, 4000)
        return
      }

      setFollowUpState('sent')
      onActivityRefresh?.()
      onMessagesRefresh?.()
      window.setTimeout(() => setFollowUpState('idle'), 2400)
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : 'Send failed')
      setFollowUpState('failed')
      window.setTimeout(() => {
        setFollowUpState('idle')
        setFollowUpError(null)
      }, 4000)
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
    followUpError,
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