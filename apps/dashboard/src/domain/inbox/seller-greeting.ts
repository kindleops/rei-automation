import type { InboxThread } from './inbox-model-types'
import {
  resolveInboxOwnerName,
  resolveInboxProspectName,
  resolveSellerFirstName,
} from '../../lib/data/inboxData'

const UNKNOWN_PROSPECT = 'Unknown Contact'
const UNKNOWN_OWNER = 'Unknown Owner'

const isKnownName = (value: string, unknownLabel: string): boolean =>
  Boolean(value.trim()) && value !== unknownLabel

export type SellerGreetingValues = {
  seller_name: string
  seller_first_name: string
  owner_name: string
}

const buildPersonalizationRecord = (record: Record<string, unknown>): Record<string, unknown> => ({
  ...record,
  seller_first_name: record.seller_first_name ?? record.sellerFirstName,
  prospect_first_name: record.prospect_first_name ?? record.prospectFirstName ?? record.first_name ?? record.firstName,
  prospect_full_name: record.prospect_full_name
    ?? record.prospectFullName
    ?? record.prospect_name
    ?? record.prospectName
    ?? record.full_name
    ?? record.fullName,
  owner_display_name: record.owner_display_name ?? record.ownerDisplayName ?? record.entity_name ?? record.entityName,
  master_owner_display_name: record.master_owner_display_name ?? record.masterOwnerDisplayName,
  owner_name: record.owner_name ?? record.ownerName,
  primary_display_name: record.seller_display_name ?? record.sellerDisplayName,
})

export const buildSellerGreetingValues = (
  record: Record<string, unknown>,
): SellerGreetingValues => {
  const prospectName = resolveInboxProspectName(record)
  const ownerName = resolveInboxOwnerName(record)

  const sellerName = isKnownName(prospectName, UNKNOWN_PROSPECT)
    ? prospectName
    : isKnownName(ownerName, UNKNOWN_OWNER)
      ? ownerName
      : ''

  const personalization = buildPersonalizationRecord(record)
  const firstNameResolution = resolveSellerFirstName({
    seller_first_name: personalization.seller_first_name,
    prospect_first_name: personalization.prospect_first_name,
    prospect_full_name: personalization.prospect_full_name,
    owner_display_name: personalization.owner_display_name,
    master_owner_display_name: personalization.master_owner_display_name,
    owner_name: personalization.owner_name,
    primary_display_name: personalization.primary_display_name,
    phone_first_name: null,
    phone_full_name: null,
    first_name: personalization.prospect_first_name,
    property_owner_name: personalization.owner_name,
  })

  const sellerFirstName = firstNameResolution.value
    || (sellerName ? sellerName.split(/\s+/).filter(Boolean)[0] ?? '' : '')

  const resolvedOwnerName = isKnownName(ownerName, UNKNOWN_OWNER) ? ownerName : ''

  return {
    seller_name: sellerName,
    seller_first_name: sellerFirstName,
    owner_name: resolvedOwnerName,
  }
}

export const buildSellerGreetingFromThread = (
  thread: InboxThread | null,
): SellerGreetingValues => {
  if (!thread) {
    return { seller_name: '', seller_first_name: '', owner_name: '' }
  }

  const threadRecord = thread as unknown as Record<string, unknown>
  return buildSellerGreetingValues({
    ...threadRecord,
    owner_name: thread.owner_name ?? thread.ownerName ?? threadRecord.owner_name,
    owner_display_name: thread.ownerDisplayName ?? threadRecord.owner_display_name,
    prospect_full_name: threadRecord.prospect_full_name ?? thread.prospect_name ?? thread.full_name,
    prospect_first_name: threadRecord.prospect_first_name ?? thread.first_name,
    seller_display_name: thread.sellerName ?? threadRecord.seller_display_name,
    seller_name: thread.seller_name ?? thread.sellerName ?? threadRecord.seller_name,
  })
}

export const buildMapTemplateManualValues = (
  record: Record<string, unknown>,
  overrides: Partial<Record<'agent_name' | 'agent_first_name' | 'seller_first_name' | 'seller_name' | 'owner_name' | 'property_address', string>> = {},
): Record<string, string> => {
  const greeting = buildSellerGreetingValues(record)
  return {
    seller_name: overrides.seller_name ?? greeting.seller_name,
    seller_first_name: overrides.seller_first_name ?? greeting.seller_first_name,
    owner_name: overrides.owner_name ?? greeting.owner_name,
    agent_name: overrides.agent_name ?? '',
    agent_first_name: overrides.agent_first_name ?? '',
    ...(overrides.property_address ? { property_address: overrides.property_address } : {}),
  }
}