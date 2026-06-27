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

const normalizeKey = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[\s-/]+/g, '_')

const STAGE_ALIASES: Record<string, LifecycleStageCode> = {
  s1_ownership: 'ownership_confirmation',
  s2_interest: 'offer_interest',
  s3_pricing: 'asking_price',
  s4_condition: 'property_condition',
  s5_offer: 'offer',
  s6_negotiation: 'offer',
  s7_follow_up: 'offer_interest',
  s8_closing: 'formal_contract',
  ownership_check: 'ownership_confirmation',
  interest_probe: 'offer_interest',
  price_discovery: 'asking_price',
  condition_details: 'property_condition',
  offer_reveal: 'offer',
  negotiation: 'offer',
  contract_path: 'formal_contract',
  contract_sent: 'formal_contract',
  closing: 'prepared_to_close',
}

const STATUS_ALIASES: Record<string, OperationalStatusCode> = {
  waiting: 'waiting_on_seller',
  follow_up: 'follow_up_due',
  offer_sent: 'waiting_on_seller',
  contract_sent: 'waiting_on_seller',
  under_contract: 'active_communication',
  closed: 'paused',
}

const TEMP_ALIASES: Record<string, LeadTemperatureCode> = {
  unknown: 'unscored',
  warming: 'warm',
  engaged: 'warm',
  dead: 'cold',
  priority: 'hot',
}

export const normalizeLifecycleStage = (value: unknown, fallback: LifecycleStageCode = 'ownership_confirmation'): LifecycleStageCode => {
  const key = normalizeKey(value)
  if ((LIFECYCLE_STAGE_ORDER as readonly string[]).includes(key)) return key as LifecycleStageCode
  if (STAGE_ALIASES[key]) return STAGE_ALIASES[key]
  return fallback
}

export const normalizeOperationalStatus = (value: unknown, fallback: OperationalStatusCode = 'not_contacted'): OperationalStatusCode => {
  const key = normalizeKey(value)
  if ((OPERATIONAL_STATUS_ORDER as readonly string[]).includes(key)) return key as OperationalStatusCode
  if (STATUS_ALIASES[key]) return STATUS_ALIASES[key]
  return fallback
}

export const normalizeLeadTemperature = (value: unknown, fallback: LeadTemperatureCode = 'unscored'): LeadTemperatureCode => {
  const key = normalizeKey(value)
  if ((LEAD_TEMPERATURE_ORDER as readonly string[]).includes(key)) return key as LeadTemperatureCode
  if (TEMP_ALIASES[key]) return TEMP_ALIASES[key]
  return fallback
}

export const contactabilityBlocksSend = (code: unknown): boolean => {
  const key = normalizeKey(code) as ContactabilityCode
  return CONTACTABILITY_META[key]?.blocksSend === true
}