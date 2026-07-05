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
import {
  pickOwnershipCheckTemplateForMap,
  resolveMapOwnerLanguage,
} from './ownership-check-template-picker'
import type { SmsTemplate } from '../../../lib/data/templateData'
import type { TemplateActionPayload } from '../../../modules/inbox/components/TemplatePopover'
import { translateText } from '../../../modules/inbox/translate.api'
import type { SellerMapCardViewModel } from './seller-map-card.types'
import { asNumber, firstDefined, text } from './seller-map-card-formatters'
import { isEntityName, safeHumanName } from '../../../lib/identity/entityDetection'

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

const firstToken = (value: string): string => value.split(/\s+/).filter(Boolean)[0] ?? value

/**
 * Resolves the SMS agent's first name from the loose agent_persona/agent_family
 * signal on the Master Owner (the same fields apps/api's outbound feeder already
 * resolves agent identity from). There is no hardcoded fallback name here — an
 * unresolved agent must block the send (sender_identity_missing), never invent or
 * default to a static human name.
 */
export const resolveMapAgentFirstName = (record: Record<string, unknown>): string => {
  const agentSignal = safeHumanName(text(firstDefined(record, ['agent_persona', 'agent_family'])))
  return agentSignal ? firstToken(agentSignal) : ''
}

export const buildMapTemplateManualValues = (record: Record<string, unknown>): Record<string, string> => {
  // Master Owner / entity name — ownership context only, never the SMS greeting name.
  const ownerName = text(firstDefined(record, [
    'owner_display_name',
    'owner_name',
    'owner_full_name',
    'entity_name',
    'seller_display_name',
    'seller_name',
  ]))
  // sms_eligible === false (explicitly known ineligible) means the linked prospect
  // must not be personalized by name here, even if a name string is present.
  // Undefined/missing (older records that don't carry this field yet) is treated
  // as "unknown," not "ineligible," so it doesn't regress existing personalization.
  const isKnownIneligible = record.sms_eligible === false
  const prospectName = isKnownIneligible
    ? ''
    : safeHumanName(text(firstDefined(record, [
        'prospect_full_name',
        'prospect_name',
        'prospect_first_name',
      ])))
  const first = prospectName ? firstToken(prospectName) : ''
  const agentFirstName = resolveMapAgentFirstName(record)
  return {
    seller_name: prospectName,
    seller_first_name: first,
    owner_name: ownerName,
    agent_name: agentFirstName,
    agent_first_name: agentFirstName,
  }
}

const hasBlankGreeting = (message: string): boolean =>
  /^(hi|hey|hello|hola|ola|marhaba)\s*,\s*(?:\{\{|\[\[|$)/i.test(message.trim())

const hasUnresolvedTemplateTokens = (message: string): boolean =>
  /\[\[[a-z0-9_]+\]\]/i.test(message) || /\{\{[^}]+\}\}/.test(message)

// Final safety rail: never send a greeting addressed to an entity/LLC/trust name,
// regardless of which upstream field it leaked in through.
const GREETING_NAME_PATTERN = /^\s*(?:hi|hey|hello|hola|ola|marhaba)\s+([^,]+),/i

const hasEntityGreeting = (message: string): boolean => {
  const match = message.trim().match(GREETING_NAME_PATTERN)
  if (!match) return false
  return isEntityName(match[1])
}

export const buildThreadFromViewModel = (
  vm: SellerMapCardViewModel,
  record: Record<string, unknown>,
  overrides: { phone?: string | null; prospectId?: string | null } = {},
): InboxThread => {
  const threadKey = resolveMapThreadKey(vm, record)
  const phone = text(overrides.phone) || resolveMapThreadPhone(record)
  const ownerId = text(firstDefined(record, ['master_owner_id', 'masterOwnerId', 'owner_id', 'ownerId']))
    || vm.masterOwner.id
    || undefined
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
      setFollowUpError(eligibility.disabledReason)
      setFollowUpState('blocked')
      window.setTimeout(() => {
        setFollowUpState('idle')
        setFollowUpError(null)
      }, 1800)
      return
    }

    setFollowUpState('sending')
    setFollowUpError(null)
    try {
      let sendThread = thread
      const resolveMasterOwnerId = (): string | null =>
        viewModel.masterOwner.id
        || text(firstDefined(record, ['master_owner_id', 'masterOwnerId', 'owner_id', 'ownerId']))
        || null

      const ensureCanonicalSendThread = async (): Promise<InboxThread | null> => {
        let candidate = sendThread
        let dialablePhone = resolveDialablePhoneFromThread(candidate as unknown as Record<string, unknown>)

        if (!dialablePhone) {
          const resolved = await resolveCommandMapSellerPhone(viewModel.propertyId, {
            prospectId: text(firstDefined(record, ['prospect_id', 'prospectId'])) || null,
            masterOwnerId: resolveMasterOwnerId(),
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

      const manualTemplateValues = buildMapTemplateManualValues(record)
      const templateContext = {
        ...buildTemplateContextFromThread(sendThread, threadContext ?? null, manualTemplateValues),
        ...manualTemplateValues,
        property_address: viewModel.property.address,
      }

      let followUpTemplate: SmsTemplate | null = null
      let messageText = ''

      if (eligibility.isUncontacted) {
        if (!manualTemplateValues.agent_first_name) {
          setFollowUpError('No SMS agent available')
          setFollowUpState('blocked')
          window.setTimeout(() => {
            setFollowUpState('idle')
            setFollowUpError(null)
          }, 4000)
          return
        }

        const ownerLanguage = await resolveMapOwnerLanguage(record, resolveMasterOwnerId())
        let templateSelection = null
        try {
          templateSelection = await pickOwnershipCheckTemplateForMap(
            templateContext,
            ownerLanguage,
            {
              propertyId: viewModel.propertyId,
              recipientPhone: sendThread.canonicalE164 || sendThread.phoneNumber,
            },
          )
        } catch (templateError) {
          const errMessage = templateError instanceof Error ? templateError.message : 'ownership_check_templates_unavailable'
          setFollowUpError(errMessage.slice(0, 42))
          setFollowUpState('failed')
          window.setTimeout(() => {
            setFollowUpState('idle')
            setFollowUpError(null)
          }, 4000)
          return
        }

        if (!templateSelection) {
          setFollowUpError('Ownership check template unavailable')
          setFollowUpState('failed')
          window.setTimeout(() => {
            setFollowUpState('idle')
            setFollowUpError(null)
          }, 4000)
          return
        }

        followUpTemplate = templateSelection.template
        messageText = templateSelection.renderedMessage
      } else {
        const templates = await getRecommendedTemplates(sendThread, threadContext ?? null)
        followUpTemplate = templates.find((template) => template.isFollowUp)
          || templates.find((template) => template.useCaseSlug.includes('follow'))
          || templates[0]
          || null

        if (!followUpTemplate) {
          setFollowUpError('No compatible follow-up template')
          setFollowUpState('failed')
          window.setTimeout(() => {
            setFollowUpState('idle')
            setFollowUpError(null)
          }, 4000)
          return
        }

        messageText = renderTemplate(followUpTemplate, templateContext).renderedText
      }

      if (
        !messageText.trim()
        || hasBlankGreeting(messageText)
        || hasUnresolvedTemplateTokens(messageText)
        || hasEntityGreeting(messageText)
      ) {
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