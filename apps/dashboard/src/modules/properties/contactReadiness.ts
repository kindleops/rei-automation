import type { PropertyContactContext, PropertyIntelligenceContext } from './property.types'

export type ContactReadiness = {
  canSendSms: boolean
  canCreateDraft: boolean
  canCreateOffer: boolean
  canGenerateContract: boolean
  primaryAction: 'link_contact' | 'send_sms' | 'open_thread'
  blockReason: string | null
  hasProspect: boolean
  hasPhone: boolean
  hasThread: boolean
}

const WRONG_NUMBER_STATUSES = new Set(['wrong_number', 'wrong number', 'invalid', 'disconnected'])
const OPT_OUT_STATUSES = new Set(['opt_out', 'opted_out', 'opt-out', 'do_not_contact', 'dnc'])
const SUPPRESSED_STATUSES = new Set(['suppressed', 'blocked', 'blacklisted'])

function isBlockedStatus(value: string | null | undefined): boolean {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return false
  return WRONG_NUMBER_STATUSES.has(normalized)
    || OPT_OUT_STATUSES.has(normalized)
    || SUPPRESSED_STATUSES.has(normalized)
}

function phoneEligible(phone: PropertyContactContext['primaryPhone']): boolean {
  if (!phone?.phoneNumber) return false
  if (isBlockedStatus(phone.status) || isBlockedStatus(phone.smsStatus)) return false
  return true
}

export function evaluateContactReadiness(context: PropertyIntelligenceContext): ContactReadiness {
  const hasProspect = context.contacts.prospects.length > 0
  const hasPhone = Boolean(context.contacts.primaryPhone?.phoneNumber)
  const phoneOk = phoneEligible(context.contacts.primaryPhone)
  const hasThread = context.messages.length > 0 || Boolean(context.queue.latest)
  const latestOffer = context.offerPathway.latestOffer
  const activeContract = context.offerPathway.activeContract

  let blockReason: string | null = null
  if (!hasProspect) blockReason = 'No linked prospect record.'
  else if (!hasPhone) blockReason = 'No linked phone on file.'
  else if (!phoneOk) blockReason = 'Selected phone is wrong-number, opted out, or suppressed.'
  else if (isBlockedStatus(context.queue.deliveryState)) blockReason = 'Delivery state blocks outreach.'

  const canSendSms = !blockReason
  const canCreateDraft = hasProspect || hasPhone
  const canCreateOffer = Boolean(latestOffer) || canSendSms
  const canGenerateContract = Boolean(activeContract) || Boolean(latestOffer)

  return {
    canSendSms,
    canCreateDraft,
    canCreateOffer: canCreateOffer && hasProspect,
    canGenerateContract,
    primaryAction: !canSendSms ? 'link_contact' : hasThread ? 'open_thread' : 'send_sms',
    blockReason,
    hasProspect,
    hasPhone,
    hasThread,
  }
}