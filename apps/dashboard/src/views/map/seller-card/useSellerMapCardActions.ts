import { useCallback, useState } from 'react'
import type { InboxThread } from '../../../domain/inbox/inbox-model-types'
import type { ThreadContext, ThreadMessage } from '../../../lib/data/inboxData'
import {
  queueReplyFromInbox,
  sendInboxMessageNow,
} from '../../../lib/data/inboxData'
import { resolveDialablePhoneFromThread } from '../../../domain/inbox/resolveCanonicalThreadStateKey'
import { resolveCommandMapSellerPhone } from '../../../lib/data/commandMapData'
import { normalizeState } from '../../../lib/data/textgridRouting'
import {
  buildTemplateContextFromThread,
  getRecommendedTemplates,
  renderTemplate,
} from '../../../lib/data/templateData'
import { pickOwnershipCheckTemplateForMap } from './ownership-check-template-picker'
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

const parseStateFromAddress = (address: string): string | undefined => {
  const match = address.match(/,\s*([A-Za-z]{2})\s*(?:\d{5}(?:-\d{4})?)?\s*$/)
  return match?.[1]?.toUpperCase()
}

const parseStateFromMarket = (market: string): string | undefined => {
  const match = market.match(/,\s*([A-Za-z]{2})\s*$/i)
  return match?.[1]?.toUpperCase()
}

const buildMapTemplateManualValues = (record: Record<string, unknown>): Record<string, string> => {
  const ownerName = text(firstDefined(record, [
    'owner_display_name',
    'owner_name',
    'owner_full_name',
    'entity_name',
    'seller_display_name',
    'seller_name',
  ]))
  const prospectName = text(firstDefined(record, [
    'prospect_full_name',
    'prospect_name',
    'prospect_first_name',
  ]))
  const resolvedName = ownerName || prospectName
  const first = resolvedName.split(/\s+/).filter(Boolean)[0] ?? resolvedName
  return {
    seller_name: resolvedName,
    seller_first_name: first,
    owner_name: resolvedName,
    agent_name: 'Chris',
    agent_first_name: 'Chris',
  }
}

const hasBlankGreeting = (message: string): boolean =>
  /^(hi|hey|hello|hola|ola|marhaba)\s*,/i.test(message.trim())

const hasUnresolvedTemplateTokens = (message: string): boolean =>
  /\[\[[a-z0-9_]+\]\]/i.test(message) || /\{\{[^}]+\}\}/.test(message)

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
    seller_name: vm.masterOwner.displayName,
    prospect_full_name: text(firstDefined(record, ['prospect_full_name', 'prospect_name'])),
    prospect_first_name: text(firstDefined(record, ['prospect_first_name'])),
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
      let sendThread = thread
      const ensureCanonicalSendThread = async (): Promise<InboxThread | null> => {
        let candidate = sendThread
        let dialablePhone = resolveDialablePhoneFromThread(candidate as unknown as Record<string, unknown>)

        if (!dialablePhone) {
          const resolved = await resolveCommandMapSellerPhone(viewModel.propertyId, {
            prospectId: text(firstDefined(record, ['prospect_id', 'prospectId'])) || null,
            masterOwnerId: viewModel.masterOwner.id
              || text(firstDefined(record, ['master_owner_id', 'masterOwnerId']))
              || null,
          })
          if (!resolved.phone) return null

          candidate = buildThreadFromViewModel(viewModel, record, {
            phone: resolved.phone,
            prospectId: resolved.prospectId,
          })
          dialablePhone = resolveDialablePhoneFromThread(candidate as unknown as Record<string, unknown>)
        }

        if (!dialablePhone) return null

        return {
          ...candidate,
          threadKey: dialablePhone,
          id: dialablePhone,
          phoneNumber: dialablePhone,
          canonicalE164: dialablePhone,
          sellerPhone: dialablePhone,
          bestPhone: dialablePhone,
          display_phone: dialablePhone,
          prospect_best_phone: dialablePhone,
        }
      }

      const resolvedSendThread = await ensureCanonicalSendThread()
      if (!resolvedSendThread) {
        setFollowUpError('No valid seller phone on file')
        setFollowUpState('blocked')
        window.setTimeout(() => {
          setFollowUpState('idle')
          setFollowUpError(null)
        }, 2400)
        return
      }
      sendThread = resolvedSendThread

      let followUpTemplate: SmsTemplate | null = null
      const manualTemplateValues = buildMapTemplateManualValues(record)
      const templateContext = {
        ...buildTemplateContextFromThread(sendThread, threadContext ?? null, manualTemplateValues),
        ...manualTemplateValues,
      }

      if (eligibility.isUncontacted) {
        followUpTemplate = await pickOwnershipCheckTemplateForMap(
          record,
          templateContext,
          viewModel.masterOwner.id
            || text(firstDefined(record, ['master_owner_id', 'masterOwnerId']))
            || null,
        )
      } else {
        const templates = await getRecommendedTemplates(sendThread, threadContext ?? null)
        followUpTemplate = templates.find((template) => template.isFollowUp)
          || templates.find((template) => template.useCaseSlug.includes('follow'))
          || templates[0]
          || null
      }

      if (!followUpTemplate) {
        setFollowUpError('Ownership check template unavailable')
        setFollowUpState('failed')
        window.setTimeout(() => {
          setFollowUpState('idle')
          setFollowUpError(null)
        }, 4000)
        return
      }

      const { renderedText: rawMessageText } = renderTemplate(followUpTemplate, templateContext)
      let messageText = rawMessageText
        .replace(/^(hi|hey|hello|hola|ola|marhaba)\s+,/i, '$1 there,')
        .replace(/^(hi|hey|hello|hola|ola|marhaba)\s*,/i, '$1 there,')
        .replace(/\[\[[a-z0-9_]+\]\]/gi, '')
        .trim()
      if (!messageText.trim() || hasBlankGreeting(messageText) || hasUnresolvedTemplateTokens(messageText)) {
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