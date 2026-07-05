import type { InboxThread } from '../inbox/inbox-model-types'
import type { ThreadContext } from '../../lib/data/inboxData'
import { sendInboxMessageNow as dispatchMapOwnershipCheck } from '../../lib/api/backendClient'
import { resolveOutboundTextgridNumber } from '../../lib/data/textgridRouting'
import { asString, type AnyRecord } from '../../lib/data/shared'
import type { MapOwnershipCheckIdentity } from './resolve-map-ownership-check'
import type { OwnershipTemplateSelection } from '../../views/map/seller-card/ownership-check-template-picker'

export type MapOwnershipCheckSendResult = {
  ok: boolean
  errorMessage: string | null
  queueId: string | null
  messageEventId: string | null
  insertPayload: Record<string, unknown> | null
}

const text = (value: unknown): string => asString(value, '').trim()

const isValidUUID = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

export const buildMapOwnershipCheckQueuePayload = ({
  identity,
  selection,
  thread,
  fromPhone,
  textgridNumberId,
}: {
  identity: MapOwnershipCheckIdentity
  selection: OwnershipTemplateSelection
  thread: InboxThread
  fromPhone: string
  textgridNumberId: string | null
}): Record<string, unknown> => {
  const now = new Date().toISOString()
  const threadKey = text(thread.threadKey) || identity.recipientPhone
  const queueKey = `map:ownership_check:${identity.propertyId}:${Date.now()}`
  const templateId = text(selection.templateId)

  const metadata: Record<string, unknown> = {
    source: 'map_command',
    send_source: 'map_command',
    origin_surface: 'command_map',
    action: 'send_ownership_check',
    manual_operator_send: true,
    template_source: 'sms_templates',
    template_id: templateId,
    selected_template_id: templateId,
    template_key: selection.templateKey,
    template_language: selection.language,
    template_selection_reason: selection.selectionReason,
    template_traffic_weight: selection.weight,
    excluded_recent_template_id: selection.excludedRecentTemplateId,
    seller_first_name: identity.prospectFirstName,
    seller_display_name: identity.sellerDisplayName,
    agent_name: identity.agentName,
    agent_first_name: identity.agentFirstName,
    owner_name: identity.ownerDisplayName,
    rendered_message: selection.renderedMessage,
    message_events_source_app: 'LeadCommand Map',
  }

  const payload: Record<string, unknown> = {
    queue_status: 'queued',
    queue_key: queueKey,
    queue_id: queueKey,
    queue_sequence: 1,
    scheduled_for: now,
    scheduled_for_utc: now,
    scheduled_for_local: now,
    send_priority: 10,
    is_locked: false,
    retry_count: 0,
    max_retries: 3,
    message_body: selection.renderedMessage,
    message_text: selection.renderedMessage,
    rendered_message: selection.renderedMessage,
    to_phone_number: identity.recipientPhone,
    from_phone_number: fromPhone,
    thread_key: threadKey,
    property_id: identity.propertyId,
    master_owner_id: identity.masterOwnerId,
    prospect_id: identity.prospectId,
    phone_number_id: identity.phoneId,
    seller_first_name: identity.prospectFirstName,
    seller_display_name: identity.sellerDisplayName,
    agent_name: identity.agentName,
    character_count: selection.renderedMessage.length,
    touch_number: 1,
    current_stage: 'ownership_check',
    message_type: 'ownership_check',
    use_case_template: 'ownership_check',
    source: 'map_command',
    send_source: 'map_command',
    created_from: 'leadcommand_map',
    action: 'send_ownership_check',
    manual_operator_send: true,
    language: selection.language,
    template_id: templateId,
    selected_template_id: templateId,
    template_key: selection.templateKey,
    template_source: 'sms_templates',
    metadata,
  }

  if (identity.smsAgentId) {
    payload.sms_agent_id = identity.smsAgentId
    payload.selected_agent_id = identity.selectedAgentId || identity.smsAgentId
  } else if (identity.selectedAgentId) {
    payload.selected_agent_id = identity.selectedAgentId
  }

  if (textgridNumberId && isValidUUID(textgridNumberId)) {
    payload.textgrid_number_id = textgridNumberId
  }

  if (identity.propertyAddress) {
    payload.property_address = identity.propertyAddress
  }

  return payload
}

export const sendMapOwnershipCheck = async ({
  identity,
  selection,
  thread,
  threadContext,
  dryRun = false,
}: {
  identity: MapOwnershipCheckIdentity
  selection: OwnershipTemplateSelection
  thread: InboxThread
  threadContext?: ThreadContext | null
  dryRun?: boolean
}): Promise<MapOwnershipCheckSendResult> => {
  if (!text(selection.templateId)) {
    return { ok: false, errorMessage: 'Missing template provenance', queueId: null, messageEventId: null, insertPayload: null }
  }
  if (!text(selection.renderedMessage)) {
    return { ok: false, errorMessage: 'Missing rendered message', queueId: null, messageEventId: null, insertPayload: null }
  }
  if (!text(identity.prospectFirstName)) {
    return { ok: false, errorMessage: 'Missing seller first name', queueId: null, messageEventId: null, insertPayload: null }
  }
  if (!text(identity.agentName)) {
    return { ok: false, errorMessage: 'No SMS agent assigned to this property', queueId: null, messageEventId: null, insertPayload: null }
  }

  const routingResult = await resolveOutboundTextgridNumber({
    marketId: thread.marketId,
    market: thread.market || thread.marketName,
    phoneNumber: identity.recipientPhone,
    property_address_state: thread.property_address_state,
    propertyId: identity.propertyId,
    threadKey: thread.threadKey || identity.recipientPhone,
    allow_cluster_routing: true,
  }, false)

  if (!routingResult.ok || !routingResult.from_phone_number) {
    return {
      ok: false,
      errorMessage: routingResult.error || 'No valid sender number for this market.',
      queueId: null,
      messageEventId: null,
      insertPayload: null,
    }
  }

  const insertPayload = buildMapOwnershipCheckQueuePayload({
    identity,
    selection,
    thread,
    fromPhone: routingResult.from_phone_number,
    textgridNumberId: routingResult.textgrid_number_id,
  })

  if (dryRun) {
    return {
      ok: true,
      errorMessage: null,
      queueId: null,
      messageEventId: null,
      insertPayload,
    }
  }

  const sendResult = await dispatchMapOwnershipCheck(insertPayload)
  if (!sendResult.ok) {
    const upstream = ((sendResult as unknown as AnyRecord).upstream as AnyRecord | undefined) || {}
    return {
      ok: false,
      errorMessage: text(upstream.message || sendResult.error || 'Send failed'),
      queueId: null,
      messageEventId: null,
      insertPayload,
    }
  }

  const queueData = (sendResult.data || {}) as AnyRecord
  return {
    ok: true,
    errorMessage: null,
    queueId: text(queueData.queue_audit_id || queueData.queue_row_id || queueData.queue_id) || null,
    messageEventId: text(queueData.message_event_id || queueData.messageEventId) || null,
    insertPayload,
  }
}