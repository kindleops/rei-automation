/**
 * Dashboard mirror of apps/api/src/lib/domain/lead-state/universal-lead-state-registry.js
 * Keep aligned — do not invent values here.
 */

export const LIFECYCLE_STAGE_ORDER = [
  'ownership_confirmation',
  'offer_interest',
  'asking_price',
  'property_condition',
  'offer',
  'formal_contract',
  'under_contract',
  'disposition',
  'prepared_to_close',
  'closed',
] as const

export type LifecycleStageCode = typeof LIFECYCLE_STAGE_ORDER[number]

export const LIFECYCLE_STAGE_META: Record<LifecycleStageCode, {
  number: number
  label: string
  shortLabel: string
  color: string
  icon: string
}> = {
  ownership_confirmation: { number: 1, label: 'Ownership Check', shortLabel: 'S1', color: '#aab3c5', icon: 'shield-check' },
  offer_interest: { number: 2, label: 'Interest Probe', shortLabel: 'S2', color: '#64d2ff', icon: 'message-circle' },
  asking_price: { number: 3, label: 'Asking Price', shortLabel: 'S3', color: '#bf5af2', icon: 'dollar-sign' },
  property_condition: { number: 4, label: 'Property Condition', shortLabel: 'S4', color: '#ff9f0a', icon: 'home' },
  offer: { number: 5, label: 'Offer', shortLabel: 'S5', color: '#ff453a', icon: 'file-text' },
  formal_contract: { number: 6, label: 'Formal Contract', shortLabel: 'S6', color: '#ff9f0a', icon: 'file-signature' },
  under_contract: { number: 7, label: 'Under Contract', shortLabel: 'S7', color: '#34c759', icon: 'check-circle' },
  disposition: { number: 8, label: 'Disposition', shortLabel: 'S8', color: '#5ac8fa', icon: 'users' },
  prepared_to_close: { number: 9, label: 'Prepared to Close', shortLabel: 'S9', color: '#30d158', icon: 'flag' },
  closed: { number: 10, label: 'Closed', shortLabel: 'S10', color: '#7d8797', icon: 'lock' },
}

export const OPERATIONAL_STATUS_ORDER = [
  'not_contacted',
  'scheduled',
  'new_reply',
  'active_communication',
  'waiting_on_seller',
  'follow_up_due',
  'needs_review',
  'snoozed',
  'paused',
] as const

export type OperationalStatusCode = typeof OPERATIONAL_STATUS_ORDER[number]

export const OPERATIONAL_STATUS_META: Record<OperationalStatusCode, { label: string; color: string; icon: string }> = {
  not_contacted: { label: 'Not Contacted', color: '#94a3b8', icon: 'circle-dashed' },
  scheduled: { label: 'Scheduled', color: '#5bb6ff', icon: 'calendar' },
  new_reply: { label: 'New Reply', color: '#0a84ff', icon: 'inbox' },
  active_communication: { label: 'Active Communication', color: '#30d158', icon: 'messages-square' },
  waiting_on_seller: { label: 'Waiting on Seller', color: '#ffd60a', icon: 'clock' },
  follow_up_due: { label: 'Follow-Up Due', color: '#ff9f43', icon: 'alarm-clock' },
  needs_review: { label: 'Needs Review', color: '#ff9f43', icon: 'alert-triangle' },
  snoozed: { label: 'Snoozed', color: '#a78bfa', icon: 'moon' },
  paused: { label: 'Paused', color: '#7d8797', icon: 'pause-circle' },
}

export const LEAD_TEMPERATURE_ORDER = ['unscored', 'cold', 'warm', 'hot'] as const
export type LeadTemperatureCode = typeof LEAD_TEMPERATURE_ORDER[number]

export const LEAD_TEMPERATURE_META: Record<LeadTemperatureCode, { label: string; color: string }> = {
  unscored: { label: 'Unscored', color: '#94a3b8' },
  cold: { label: 'Cold', color: '#5ac8fa' },
  warm: { label: 'Warm', color: '#ff9f43' },
  hot: { label: 'Hot', color: '#ff6b35' },
}

export const DISPOSITION_ORDER = [
  'interested', 'not_interested', 'wrong_person', 'wrong_number', 'referred',
  'sold', 'duplicate', 'unqualified', 'no_response', 'none',
] as const

export type DispositionCode = typeof DISPOSITION_ORDER[number]

export const DISPOSITION_META: Record<DispositionCode, { label: string; color: string }> = {
  interested: { label: 'Interested', color: '#30d158' },
  not_interested: { label: 'Not Interested', color: '#7d8797' },
  wrong_person: { label: 'Wrong Person', color: '#ff9f43' },
  wrong_number: { label: 'Wrong Number', color: '#ff453a' },
  referred: { label: 'Referred', color: '#5ac8fa' },
  sold: { label: 'Sold', color: '#34c759' },
  duplicate: { label: 'Duplicate', color: '#94a3b8' },
  unqualified: { label: 'Unqualified', color: '#7d8797' },
  no_response: { label: 'No Response', color: '#aab3c5' },
  none: { label: 'None', color: '#64748b' },
}

export const CONTACTABILITY_ORDER = [
  'contactable', 'opted_out', 'dnc', 'provider_blacklisted', 'invalid_number', 'do_not_text',
] as const

export type ContactabilityCode = typeof CONTACTABILITY_ORDER[number]

export const CONTACTABILITY_META: Record<ContactabilityCode, { label: string; color: string; blocksSend: boolean }> = {
  contactable: { label: 'Contactable', color: '#30d158', blocksSend: false },
  opted_out: { label: 'Opted Out', color: '#ff453a', blocksSend: true },
  dnc: { label: 'DNC', color: '#ff453a', blocksSend: true },
  provider_blacklisted: { label: 'Provider Blacklisted', color: '#ff6b64', blocksSend: true },
  invalid_number: { label: 'Invalid Number', color: '#ff9f43', blocksSend: true },
  do_not_text: { label: 'Do Not Text', color: '#ff453a', blocksSend: true },
}

export const ARCHIVE_SCOPE_CODES = {
  CONVERSATION: 'conversation',
  LEAD: 'lead',
} as const

export const STATE_SOURCE_CODES = {
  AI: 'ai',
  MANUAL: 'manual',
  SYSTEM: 'system',
  AUTOPILOT: 'autopilot',
} as const

export const UNIVERSAL_LEAD_STATE_PATCH_FIELDS = [
  'lifecycle_stage',
  'operational_status',
  'lead_temperature',
  'disposition',
  'contactability_status',
  'stage_source',
  'status_source',
  'temperature_source',
  'disposition_source',
  'contactability_source',
  'manual_stage_lock',
  'manual_temperature_lock',
  'snoozed_until',
  'snooze_reason',
  'archived_at',
  'archive_scope',
  'archive_reason',
  'paused_reason',
  'is_archived',
  'is_read',
  'is_pinned',
  'is_starred',
  'updated_by',
] as const

export const LEGACY_FIELD_ALIASES: Record<string, string> = {
  seller_stage: 'lifecycle_stage',
  conversation_status: 'operational_status',
  temperature: 'lead_temperature',
  stage: 'lifecycle_stage',
  status: 'operational_status',
}

const normalizeKey = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[\s-/]+/g, '_')

const STAGE_ALIASES: Record<string, LifecycleStageCode> = {
  ownership_check: 'ownership_confirmation',
  ownership_confirmed: 'offer_interest',
  ownership: 'ownership_confirmation',
  identity_question: 'ownership_confirmation',
  interest_probe: 'offer_interest',
  interest: 'offer_interest',
  consider_selling: 'offer_interest',
  seller_response: 'offer_interest',
  interest_qualification: 'offer_interest',
  pricing: 'asking_price',
  price_discovery: 'asking_price',
  asking_price: 'asking_price',
  condition: 'property_condition',
  condition_details: 'property_condition',
  condition_collection: 'property_condition',
  property_condition: 'property_condition',
  offer_reveal: 'offer',
  offer_sent: 'offer',
  offer_pending: 'offer',
  negotiation: 'offer',
  offer_negotiation: 'offer',
  contract_sent: 'formal_contract',
  contract_path: 'formal_contract',
  contract_requested: 'formal_contract',
  formal_contract: 'formal_contract',
  under_contract: 'under_contract',
  disposition: 'disposition',
  closing: 'prepared_to_close',
  prepared_to_close: 'prepared_to_close',
  title_closing: 'prepared_to_close',
  closed: 'closed',
  dead: 'closed',
  follow_up: 'offer_interest',
  s1_ownership: 'ownership_confirmation',
  s2_interest: 'offer_interest',
  s3_pricing: 'asking_price',
  s4_condition: 'property_condition',
  s5_offer: 'offer',
  s6_negotiation: 'offer',
  s7_follow_up: 'offer_interest',
  s8_closing: 'formal_contract',
  waiting: 'offer_interest',
  needs_response: 'offer_interest',
  s1: 'ownership_confirmation',
  s2: 'offer_interest',
}

const STATUS_ALIASES: Record<string, OperationalStatusCode> = {
  open: 'not_contacted',
  not_contacted: 'not_contacted',
  scheduled: 'scheduled',
  queued: 'scheduled',
  new_reply: 'new_reply',
  new_replies: 'new_reply',
  needs_reply: 'new_reply',
  active: 'active_communication',
  active_communication: 'active_communication',
  seller_replied: 'active_communication',
  waiting: 'waiting_on_seller',
  waiting_on_seller: 'waiting_on_seller',
  awaiting_response: 'waiting_on_seller',
  follow_up: 'follow_up_due',
  follow_up_due: 'follow_up_due',
  needs_review: 'needs_review',
  manual_review: 'needs_review',
  snoozed: 'snoozed',
  paused: 'paused',
  offer_sent: 'waiting_on_seller',
  contract_sent: 'waiting_on_seller',
  under_contract: 'active_communication',
  closed: 'paused',
  suppressed: 'paused',
  read: 'active_communication',
  unread: 'new_reply',
  dead: 'paused',
}

const TEMP_ALIASES: Record<string, LeadTemperatureCode> = {
  unscored: 'unscored',
  unknown: 'unscored',
  cold: 'cold',
  warming: 'warm',
  warm: 'warm',
  engaged: 'warm',
  hot: 'hot',
  dead: 'cold',
  priority: 'hot',
}

const DISPOSITION_ALIASES: Record<string, DispositionCode> = {
  interested: 'interested',
  not_interested: 'not_interested',
  wrong_person: 'wrong_person',
  wrong_number: 'wrong_number',
  referred: 'referred',
  sold: 'sold',
  duplicate: 'duplicate',
  unqualified: 'unqualified',
  no_response: 'no_response',
  none: 'none',
  null: 'none',
  '': 'none',
}

const CONTACTABILITY_ALIASES: Record<string, ContactabilityCode> = {
  contactable: 'contactable',
  opted_out: 'opted_out',
  opt_out: 'opted_out',
  dnc: 'dnc',
  do_not_contact: 'dnc',
  provider_blacklisted: 'provider_blacklisted',
  invalid_number: 'invalid_number',
  do_not_text: 'do_not_text',
  suppressed: 'opted_out',
}

const STAGE_INDEX = new Map(LIFECYCLE_STAGE_ORDER.map((code, index) => [code, index]))

export const normalizeLifecycleStage = (value: unknown, fallback: LifecycleStageCode = 'ownership_confirmation'): LifecycleStageCode => {
  const key = normalizeKey(value)
  if (!key) return fallback
  if (STAGE_INDEX.has(key as LifecycleStageCode)) return key as LifecycleStageCode
  if (STAGE_ALIASES[key]) return STAGE_ALIASES[key]
  if (key.includes('contract') && key.includes('under')) return 'under_contract'
  if (key.includes('contract') || key.includes('closing')) return 'formal_contract'
  if (key.includes('offer') || key.includes('negotiat')) return 'offer'
  if (key.includes('condition') || key.includes('underwrit')) return 'property_condition'
  if (key.includes('price') || key.includes('asking')) return 'asking_price'
  if (key.includes('interest') || key.includes('consider')) return 'offer_interest'
  if (key.includes('ownership')) return 'ownership_confirmation'
  if (key.includes('disposition')) return 'disposition'
  if (key.includes('prepared') || key.includes('clear_to_close')) return 'prepared_to_close'
  if (key.includes('closed') || key.includes('dead')) return 'closed'
  return fallback
}

export const normalizeOperationalStatus = (value: unknown, fallback: OperationalStatusCode = 'not_contacted'): OperationalStatusCode => {
  const key = normalizeKey(value)
  if (!key) return fallback
  if ((OPERATIONAL_STATUS_ORDER as readonly string[]).includes(key)) return key as OperationalStatusCode
  if (STATUS_ALIASES[key]) return STATUS_ALIASES[key]
  return fallback
}

export const normalizeLeadTemperature = (value: unknown, fallback: LeadTemperatureCode = 'unscored'): LeadTemperatureCode => {
  const key = normalizeKey(value)
  if (!key) return fallback
  if ((LEAD_TEMPERATURE_ORDER as readonly string[]).includes(key)) return key as LeadTemperatureCode
  if (TEMP_ALIASES[key]) return TEMP_ALIASES[key]
  return fallback
}

export const normalizeDisposition = (value: unknown, fallback: DispositionCode = 'none'): DispositionCode => {
  const key = normalizeKey(value)
  if (!key) return fallback
  if ((DISPOSITION_ORDER as readonly string[]).includes(key)) return key as DispositionCode
  if (DISPOSITION_ALIASES[key]) return DISPOSITION_ALIASES[key]
  return fallback
}

export const normalizeContactability = (value: unknown, fallback: ContactabilityCode = 'contactable'): ContactabilityCode => {
  const key = normalizeKey(value)
  if (!key) return fallback
  if ((CONTACTABILITY_ORDER as readonly string[]).includes(key)) return key as ContactabilityCode
  if (CONTACTABILITY_ALIASES[key]) return CONTACTABILITY_ALIASES[key]
  return fallback
}

export const normalizePatchToCanonical = (patch: Record<string, unknown> = {}): Record<string, unknown> => {
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch || {})) {
    const canonicalKey = LEGACY_FIELD_ALIASES[key] || key
    if (
      !UNIVERSAL_LEAD_STATE_PATCH_FIELDS.includes(canonicalKey as typeof UNIVERSAL_LEAD_STATE_PATCH_FIELDS[number])
      && !['autopilot_mode', 'assigned_user', 'manual_review'].includes(canonicalKey)
    ) {
      continue
    }
    if (canonicalKey === 'lifecycle_stage') normalized.lifecycle_stage = normalizeLifecycleStage(value)
    else if (canonicalKey === 'operational_status') normalized.operational_status = normalizeOperationalStatus(value)
    else if (canonicalKey === 'lead_temperature') normalized.lead_temperature = normalizeLeadTemperature(value)
    else if (canonicalKey === 'disposition') normalized.disposition = normalizeDisposition(value)
    else if (canonicalKey === 'contactability_status') normalized.contactability_status = normalizeContactability(value)
    else normalized[canonicalKey] = value
  }
  return normalized
}

export const contactabilityBlocksSend = (code: unknown): boolean => {
  const key = normalizeKey(code) as ContactabilityCode
  return CONTACTABILITY_META[key]?.blocksSend === true
}