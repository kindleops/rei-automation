import {
  CONTACTABILITY_META,
  LIFECYCLE_STAGE_META,
  LEAD_TEMPERATURE_META,
  OPERATIONAL_STATUS_META,
  contactabilityBlocksSend,
  normalizeContactability,
  normalizeLeadTemperature,
  normalizeLifecycleStage,
  normalizeOperationalStatus,
} from '../../../domain/lead-state/universal-lead-state-registry'
import { firstDefined, text } from './seller-map-card-formatters'

export type CanonicalLeadStatePresentation = {
  stage: string
  stageLabel: string
  status: string
  statusLabel: string
  temperature: string
  temperatureLabel: string
  contactability: string
  contactabilityLabel: string
  messagingBlocked: boolean
}

export const buildCanonicalLeadStatePresentation = (
  record: Record<string, unknown>,
): CanonicalLeadStatePresentation => {
  const stage = normalizeLifecycleStage(
    firstDefined(record, [
      'lifecycle_stage',
      'universal_stage',
      'conversation_stage',
      'seller_stage',
      'pipeline_stage',
      'stage',
    ]),
  )
  const status = normalizeOperationalStatus(
    firstDefined(record, [
      'operational_status',
      'conversation_status',
      'seller_status',
      'inbox_status',
      'status',
      'contact_status',
    ]),
  )
  const temperature = normalizeLeadTemperature(
    firstDefined(record, [
      'lead_temperature',
      'temperature',
      'deal_temperature',
    ]),
  )
  const contactability = normalizeContactability(
    firstDefined(record, [
      'contactability_status',
      'contactability',
      'suppression_status',
      'contact_status',
    ]),
  )

  return {
    stage,
    stageLabel: LIFECYCLE_STAGE_META[stage]?.label ?? text(stage),
    status,
    statusLabel: OPERATIONAL_STATUS_META[status]?.label ?? text(status),
    temperature,
    temperatureLabel: LEAD_TEMPERATURE_META[temperature]?.label ?? text(temperature),
    contactability,
    contactabilityLabel: CONTACTABILITY_META[contactability]?.label ?? text(contactability),
    messagingBlocked: contactabilityBlocksSend(contactability)
      || text(firstDefined(record, ['suppression_reason', 'suppressionReason'])).length > 0
      || text(firstDefined(record, ['inbox_category', 'inboxCategory'])).includes('suppressed'),
  }
}