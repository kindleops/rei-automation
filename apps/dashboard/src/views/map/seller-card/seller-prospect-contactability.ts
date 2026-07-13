import { safeHumanName } from '../../../lib/identity/entityDetection'
import {
  asBoolean,
  asNumber,
  firstDefined,
  formatInteger,
  nullIfZeroish,
  text,
} from './seller-map-card-formatters'

export type ProspectContactabilityProfile = {
  resolvedName: string | null
  relationshipConfidence: 'high' | 'medium' | 'low' | 'none'
  smsEligible: boolean | null
  hasPhone: boolean
  hasEmail: boolean
  contactScore: number | null
  phoneScore: number | null
  language: string | null
  prospectRank: number | null
  suppressed: boolean
  restrictionLabel: string | null
  meterPercent: number
  meterLabel: string
  badges: Array<{ key: string; label: string; tone: 'ready' | 'warn' | 'neutral' }>
  emptyState: string | null
  activityLine: string | null
  channelLine: string | null
  ownershipCheckAvailable: boolean
}

const hasDialablePhone = (record: Record<string, unknown>): boolean => {
  const phone = text(firstDefined(record, [
    'canonical_e164',
    'seller_phone',
    'prospect_best_phone',
    'display_phone',
  ]))
  return Boolean(phone) && phone.toLowerCase() !== 'no phone'
}

const resolveRelationshipConfidence = (
  name: string | null,
  smsEligible: boolean | null,
  hasPhone: boolean,
): ProspectContactabilityProfile['relationshipConfidence'] => {
  if (!name) return 'none'
  if (smsEligible === true && hasPhone) return 'high'
  if (hasPhone) return 'medium'
  if (smsEligible === false) return 'low'
  return 'medium'
}

const hasValidSendPath = (
  prospectName: string | null,
  smsEligible: boolean | null,
  hasPhone: boolean,
  suppressed: boolean,
): boolean => {
  if (suppressed) return false
  if (prospectName && smsEligible === true && hasPhone) return true
  return false
}

const computeMeter = (
  prospectName: string | null,
  smsEligible: boolean | null,
  hasPhone: boolean,
  hasEmail: boolean,
  contactScore: number | null,
  phoneScore: number | null,
  suppressed: boolean,
): { percent: number; label: string } => {
  if (suppressed) return { percent: 0, label: 'Restricted' }

  if (prospectName && smsEligible === true && hasPhone) {
    let percent = 82
    if (hasEmail) percent += 6
    if ((contactScore ?? 0) > 0) percent += Math.min(8, Math.round((contactScore ?? 0) * 0.08))
    if ((phoneScore ?? 0) > 0) percent += Math.min(4, Math.round((phoneScore ?? 0) * 0.04))
    const clamped = Math.max(0, Math.min(100, percent))
    return { percent: clamped, label: 'Ready' }
  }

  if (!prospectName && hasPhone) {
    return { percent: 42, label: 'Partial' }
  }

  if (!prospectName && !hasPhone && hasEmail) {
    return { percent: 18, label: 'Limited' }
  }

  return { percent: 0, label: 'Not ready' }
}

export const buildProspectContactabilityProfile = (
  record: Record<string, unknown>,
  options: {
    suppressed: boolean
    suppressionReason: string | null
    isUncontacted?: boolean
    hasPriorContact?: boolean
  },
): ProspectContactabilityProfile => {
  const prospectName = safeHumanName(text(firstDefined(record, [
    'prospect_full_name',
    'prospect_first_name',
    'prospect_name',
  ])))

  const smsEligible = record.sms_eligible === true
    ? true
    : record.sms_eligible === false
      ? false
      : null

  const hasPhone = hasDialablePhone(record)
  const hasEmail = Boolean(text(firstDefined(record, ['prospect_email', 'email', 'best_email'])))
  const contactScore = nullIfZeroish(asNumber(firstDefined(record, [
    'prospect_contact_score',
    'contact_score_final',
    'contact_score',
  ])))
  const phoneScore = nullIfZeroish(asNumber(firstDefined(record, [
    'prospect_phone_score',
    'phone_score_final',
    'phone_score',
  ])))
  const language = text(firstDefined(record, [
    'prospect_language_preference',
    'language_preference',
    'best_language',
  ])) || null
  const prospectRank = nullIfZeroish(asNumber(firstDefined(record, ['prospect_rank', 'rank'])))

  const restricted = options.suppressed
    || asBoolean(firstDefined(record, ['is_suppressed'])) === true
    || text(firstDefined(record, ['inbox_category'])).includes('suppressed')
    || text(firstDefined(record, ['suppression_reason'])).length > 0

  const restrictionLabel = restricted
    ? (options.suppressionReason || text(firstDefined(record, ['suppression_reason'])) || 'Suppressed')
    : null

  const meter = computeMeter(prospectName, smsEligible, hasPhone, hasEmail, contactScore, phoneScore, restricted)
  const ownershipCheckAvailable = options.isUncontacted === true && !restricted

  const badges: ProspectContactabilityProfile['badges'] = []
  if (restricted) {
    badges.push({ key: 'restricted', label: 'Contact restricted', tone: 'warn' })
  } else if (prospectName && smsEligible === true) {
    badges.push({ key: 'sms', label: 'SMS eligible', tone: 'ready' })
  }
  if (hasPhone && !restricted) badges.push({ key: 'phone', label: 'Phone coverage', tone: hasPhone && !prospectName ? 'neutral' : 'ready' })
  if (hasEmail && !restricted) badges.push({ key: 'email', label: 'Email', tone: 'neutral' })
  if (restricted) badges.push({ key: 'suppressed', label: 'Suppressed', tone: 'warn' })

  let emptyState: string | null = null
  let activityLine: string | null = null
  let channelLine: string | null = null

  if (restricted) {
    emptyState = 'Contact restricted'
    activityLine = restrictionLabel
  } else if (!prospectName && hasPhone) {
    emptyState = 'No resolved prospect'
    channelLine = 'Phone coverage available'
    activityLine = options.hasPriorContact ? null : 'No contact activity yet'
  } else if (!prospectName) {
    emptyState = 'No resolved prospect yet'
    activityLine = options.hasPriorContact ? null : 'No contact activity yet'
  } else if (!hasValidSendPath(prospectName, smsEligible, hasPhone, restricted)) {
    channelLine = hasPhone ? 'Phone on file — SMS path not confirmed' : 'No dialable phone on file'
  }

  if (ownershipCheckAvailable && !options.hasPriorContact && !restricted) {
    activityLine = activityLine
      ? `${activityLine} · Ownership check available`
      : 'Ownership check available'
  }

  return {
    resolvedName: prospectName,
    relationshipConfidence: resolveRelationshipConfidence(prospectName, smsEligible, hasPhone),
    smsEligible,
    hasPhone,
    hasEmail,
    contactScore,
    phoneScore,
    language,
    prospectRank,
    suppressed: restricted,
    restrictionLabel,
    meterPercent: meter.percent,
    meterLabel: meter.label,
    badges,
    emptyState,
    activityLine,
    channelLine,
    ownershipCheckAvailable,
  }
}

export const buildProspectContactabilityFields = (
  profile: ProspectContactabilityProfile,
): Array<{ label: string; value: string }> => {
  if (profile.suppressed) {
    return [
      { label: 'Status', value: 'Contact restricted' },
      { label: 'Restriction', value: profile.restrictionLabel || 'Suppressed' },
    ]
  }

  if (profile.emptyState && !profile.resolvedName) {
    const fields: Array<{ label: string; value: string }> = [
      { label: 'Prospect', value: profile.emptyState },
      { label: 'Contactability', value: profile.meterLabel },
    ]
    if (profile.channelLine) fields.push({ label: 'Channel', value: profile.channelLine })
    if (profile.activityLine) fields.push({ label: 'Activity', value: profile.activityLine })
    return fields
  }

  return [
    { label: 'Primary Prospect', value: profile.resolvedName || '—' },
    { label: 'Relationship', value: profile.relationshipConfidence === 'none' ? '—' : titleizeConfidence(profile.relationshipConfidence) },
    { label: 'SMS Eligible', value: profile.smsEligible === true ? 'Yes' : profile.smsEligible === false ? 'No' : '—' },
    { label: 'Phone', value: profile.hasPhone ? 'Yes' : 'No' },
    { label: 'Email', value: profile.hasEmail ? 'Yes' : 'No' },
    { label: 'Contact Score', value: profile.contactScore != null ? formatInteger(profile.contactScore) : '—' },
    { label: 'Phone Score', value: profile.phoneScore != null ? formatInteger(profile.phoneScore) : '—' },
    { label: 'Language', value: profile.language || '—' },
    { label: 'Prospect Rank', value: profile.prospectRank != null ? formatInteger(profile.prospectRank) : '—' },
    { label: 'Restriction', value: profile.restrictionLabel || 'None' },
  ].filter((field) => field.value !== '—' || ['Primary Prospect', 'SMS Eligible', 'Phone'].includes(field.label))
}

const titleizeConfidence = (value: ProspectContactabilityProfile['relationshipConfidence']): string => {
  if (value === 'high') return 'High'
  if (value === 'medium') return 'Medium'
  if (value === 'low') return 'Low'
  return 'None'
}