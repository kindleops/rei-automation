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

const computeMeter = (
  smsEligible: boolean | null,
  hasPhone: boolean,
  hasEmail: boolean,
  contactScore: number | null,
  phoneScore: number | null,
  suppressed: boolean,
): { percent: number; label: string } => {
  if (suppressed) return { percent: 0, label: 'Restricted' }

  let percent = 0
  if (hasPhone) percent += 35
  if (smsEligible === true) percent += 30
  else if (smsEligible === false) percent -= 20
  if (hasEmail) percent += 10
  if ((contactScore ?? 0) > 0) percent += Math.min(15, Math.round((contactScore ?? 0) * 0.15))
  if ((phoneScore ?? 0) > 0) percent += Math.min(10, Math.round((phoneScore ?? 0) * 0.1))

  const clamped = Math.max(0, Math.min(100, percent))
  if (clamped >= 75) return { percent: clamped, label: 'Ready' }
  if (clamped >= 45) return { percent: clamped, label: 'Partial' }
  if (clamped > 0) return { percent: clamped, label: 'Limited' }
  return { percent: 0, label: 'Not ready' }
}

export const buildProspectContactabilityProfile = (
  record: Record<string, unknown>,
  options: { suppressed: boolean; suppressionReason: string | null },
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

  const meter = computeMeter(smsEligible, hasPhone, hasEmail, contactScore, phoneScore, restricted)

  const badges: ProspectContactabilityProfile['badges'] = []
  if (smsEligible === true) badges.push({ key: 'sms', label: 'SMS ready', tone: 'ready' })
  if (hasPhone) badges.push({ key: 'phone', label: 'Phone', tone: 'ready' })
  if (hasEmail) badges.push({ key: 'email', label: 'Email', tone: 'neutral' })
  if (restricted) badges.push({ key: 'suppressed', label: 'Suppressed', tone: 'warn' })

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
    emptyState: prospectName ? null : 'No resolved prospect yet',
  }
}

export const buildProspectContactabilityFields = (
  profile: ProspectContactabilityProfile,
): Array<{ label: string; value: string }> => {
  if (profile.emptyState) return [{ label: 'Prospect', value: profile.emptyState }]

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