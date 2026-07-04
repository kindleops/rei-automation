import { buildStreetViewUrl } from '../../../domain/inbox/inbox-normalization'
import type { SellerMapCardViewModel } from './seller-map-card.types'
import {
  buildAssetInput,
  buildContextualLine,
  resolveSellerAssetPresentation,
} from './seller-asset-presentation-registry'
import { buildCanonicalLeadStatePresentation } from './seller-lead-state-presentation'
import { resolveFollowUpEligibility } from './seller-follow-up-eligibility'
import {
  asBoolean,
  asNumber,
  classifyPriorityScore,
  firstDefined,
  formatDate,
  formatInteger,
  formatMoney,
  formatPercent,
  formatRelativeUpper,
  nullIfZeroish,
  parseTagValues,
  text,
  titleize,
} from './seller-map-card-formatters'

const PRIORITY_FLAG_ORDER = [
  'High Equity',
  'Free And Clear',
  'Tax Delinquent',
  'Absentee Owner',
  'Out Of State Owner',
  'Vacant',
  'Tired Landlord',
  'Probate',
  'Active Lien',
  'Senior Owner',
]

const resolveMasterOwnerName = (record: Record<string, unknown>): string => {
  const name = text(firstDefined(record, [
    'master_owner_display_name',
    'owner_display_name',
    'ownerDisplayName',
    'owner_full_name',
    'owner_name',
    'ownerName',
    'entity_name',
    'entityName',
    'mo_display_name',
  ]))
  return name || 'Unknown Owner'
}

const resolvePropertyImage = (record: Record<string, unknown>, address: string): string | null => {
  const direct = text(firstDefined(record, [
    'streetview_image',
    'streetViewImage',
    'street_view_image',
    'map_image',
    'mapImage',
    'satellite_image',
    'satelliteImage',
  ]))
  if (direct) return direct.replace(/^http:\/\//i, 'https://')
  if (address && address !== 'Property Unknown') {
    return buildStreetViewUrl(address) || null
  }
  return null
}

const buildFlags = (record: Record<string, unknown>, equityPercent: number | null): SellerMapCardViewModel['flags'] => {
  const tags = new Set<string>([
    ...parseTagValues(firstDefined(record, ['property_flags_json', 'property_flags_text', 'property_tags_json', 'property_tags_text', 'seller_tags_json', 'seller_tags_text', 'podio_tags'])),
  ].map(titleize))

  if ((equityPercent ?? 0) >= 65) tags.add('High Equity')
  if ((equityPercent ?? 0) >= 95) tags.add('Free And Clear')
  if (asBoolean(firstDefined(record, ['tax_delinquent', 'taxDelinquent'])) === true) tags.add('Tax Delinquent')
  if (asBoolean(firstDefined(record, ['absentee_owner', 'absenteeOwner'])) === true) tags.add('Absentee Owner')
  if (asBoolean(firstDefined(record, ['out_of_state_owner', 'outOfStateOwner'])) === true) tags.add('Out Of State Owner')
  if (asBoolean(firstDefined(record, ['active_lien', 'activeLien'])) === true) tags.add('Active Lien')
  if (asBoolean(firstDefined(record, ['vacant', 'is_vacant'])) === true) tags.add('Vacant')

  const sorted = Array.from(tags).sort((left, right) => {
    const leftIndex = PRIORITY_FLAG_ORDER.indexOf(left)
    const rightIndex = PRIORITY_FLAG_ORDER.indexOf(right)
    if (leftIndex >= 0 || rightIndex >= 0) {
      return (leftIndex >= 0 ? leftIndex : 999) - (rightIndex >= 0 ? rightIndex : 999)
    }
    return left.localeCompare(right)
  })

  return sorted.slice(0, 8).map((label, index) => ({
    key: label.toLowerCase().replace(/\s+/g, '_'),
    label,
    severity: index < 3 ? 'high' : index < 5 ? 'medium' : 'low',
  }))
}

const buildActivity = (
  record: Record<string, unknown>,
  canonical: ReturnType<typeof buildCanonicalLeadStatePresentation>,
): SellerMapCardViewModel['activity'] => {
  const suppressionReason = text(firstDefined(record, ['suppression_reason', 'suppressionReason']))
  if (canonical.messagingBlocked || text(firstDefined(record, ['inbox_category'])).includes('suppressed')) {
    return {
      kind: 'suppressed',
      headline: 'SUPPRESSED',
      detail: suppressionReason || 'No messaging action permitted',
      timestamp: null,
    }
  }

  const deliveryStatus = text(firstDefined(record, ['delivery_status', 'deliveryStatus', 'latest_delivery_status']))
  const deliveryFailedAt = text(firstDefined(record, ['delivery_failed_at', 'failed_at', 'latest_failed_at']))
  if (deliveryStatus.toLowerCase() === 'failed' || deliveryFailedAt) {
    return {
      kind: 'delivery_failed',
      headline: `DELIVERY FAILED${deliveryFailedAt ? ` · ${formatRelativeUpper(deliveryFailedAt)}` : ''}`,
      detail: text(firstDefined(record, ['delivery_error', 'error_message', 'failure_reason'])) || 'Provider rejected destination number',
      timestamp: deliveryFailedAt || null,
    }
  }

  const lastInboundText = text(firstDefined(record, ['last_inbound_text', 'lastInboundText', 'latest_inbound_body', 'last_reply_body']))
  const lastInboundAt = text(firstDefined(record, ['last_inbound_at', 'lastInboundAt', 'last_reply_at', 'lastReplyAt']))
  if (lastInboundText || canonical.status === 'new_reply') {
    return {
      kind: 'last_reply',
      headline: `LAST REPLY${lastInboundAt ? ` · ${formatRelativeUpper(lastInboundAt)}` : ''}`,
      detail: lastInboundText || text(firstDefined(record, ['latest_message_body', 'latestMessageBody'])) || null,
      timestamp: lastInboundAt || null,
    }
  }

  const lastOutboundAt = text(firstDefined(record, ['last_outbound_at', 'lastOutboundAt', 'last_contact_at', 'lastContactAt', 'latest_message_at']))
  const followUpDueAt = text(firstDefined(record, ['next_follow_up_at', 'follow_up_due_at', 'followUpDueAt']))
  const followUpDetail = canonical.status === 'follow_up_due' || followUpDueAt
    ? 'Follow-up due today'
    : text(firstDefined(record, ['last_outbound_text', 'lastOutboundText', 'latest_message_body'])) || null

  return {
    kind: lastOutboundAt ? 'last_contacted' : 'none',
    headline: lastOutboundAt ? `LAST CONTACTED · ${formatRelativeUpper(lastOutboundAt)}` : 'NO CONTACT YET',
    detail: followUpDetail,
    timestamp: lastOutboundAt || null,
  }
}

const resolveEdgeAccent = (
  activity: SellerMapCardViewModel['activity'],
  canonical: ReturnType<typeof buildCanonicalLeadStatePresentation>,
): SellerMapCardViewModel['edgeAccent'] => {
  if (activity.kind === 'suppressed') return 'suppressed'
  if (activity.kind === 'delivery_failed') return 'failed'
  if (canonical.status === 'follow_up_due') return 'due'
  if (canonical.temperature === 'hot') return 'hot'
  if (activity.kind === 'last_reply' || canonical.status === 'new_reply') return 'reply'
  return 'default'
}

export const buildSellerMapCardViewModel = (record: Record<string, unknown>): SellerMapCardViewModel => {
  const address = text(firstDefined(record, [
    'property_address_full',
    'propertyAddressFull',
    'property_address',
    'propertyAddress',
    'address',
    'situs_address',
  ])) || 'Property Unknown'

  const assetInput = buildAssetInput(record)
  const presentation = resolveSellerAssetPresentation(assetInput.assetType, assetInput.units)
  const canonical = buildCanonicalLeadStatePresentation(record)

  const priorityScore = nullIfZeroish(asNumber(firstDefined(record, [
    'owner_priority_score',
    'master_owner_priority_score',
    'mo_priority_score',
  ])))
  const priorityTier = text(firstDefined(record, ['owner_priority_tier', 'priority_tier', 'priorityTier'])) || null
  const priority = classifyPriorityScore(priorityScore, priorityTier)

  const equityPercent = assetInput.equityPercent
  const flags = buildFlags(record, equityPercent)
  const activity = buildActivity(record, canonical)

  const yearsOwned = nullIfZeroish(asNumber(firstDefined(record, ['ownership_years', 'ownershipYears', 'years_owned'])))
  const portfolioCount = nullIfZeroish(asNumber(firstDefined(record, ['portfolio_count', 'property_count', 'owner_property_count'])))

  const focusFinancialFields = [
    { label: 'Estimated Value', value: formatMoney(assetInput.estimatedValue) },
    { label: 'Equity Amount', value: formatMoney(assetInput.equityAmount) },
    { label: 'Equity %', value: formatPercent(assetInput.equityPercent) },
    { label: 'Repairs', value: formatMoney(assetInput.repairs) },
    { label: 'Mortgage Balance', value: formatMoney(nullIfZeroish(asNumber(firstDefined(record, ['mortgage_balance', 'loan_balance'])))) },
    { label: 'Assessed Value', value: formatMoney(nullIfZeroish(asNumber(firstDefined(record, ['assessed_total_value', 'total_assessed_value', 'assessed_value'])))) },
    { label: 'Annual Taxes', value: formatMoney(nullIfZeroish(asNumber(firstDefined(record, ['annual_taxes', 'tax_amount'])))) },
    { label: 'Last Sale', value: formatMoney(nullIfZeroish(asNumber(firstDefined(record, ['last_sale_amount', 'lastSaleAmount'])))) },
    { label: 'Last Sale Date', value: formatDate(text(firstDefined(record, ['last_sale_date', 'lastSaleDate', 'sale_date']))) },
  ].filter((field) => field.value !== '—')

  const focusOwnerFields = [
    { label: 'Mailing Address', value: text(firstDefined(record, ['mailing_address_full', 'owner_mailing_address', 'mailing_address'])) || '—' },
    { label: 'Years Owned', value: yearsOwned != null ? `${formatInteger(yearsOwned)} yrs` : '—' },
    { label: 'Absentee', value: asBoolean(firstDefined(record, ['absentee_owner'])) === true ? 'Yes' : asBoolean(firstDefined(record, ['absentee_owner'])) === false ? 'No' : '—' },
    { label: 'Out of State', value: asBoolean(firstDefined(record, ['out_of_state_owner'])) === true ? 'Yes' : asBoolean(firstDefined(record, ['out_of_state_owner'])) === false ? 'No' : '—' },
    { label: 'Free & Clear', value: (equityPercent ?? 0) >= 95 ? 'Yes' : equityPercent != null ? 'No' : '—' },
    { label: 'Portfolio', value: portfolioCount != null ? formatInteger(portfolioCount) : '—' },
    { label: 'Contactability', value: canonical.contactabilityLabel },
  ].filter((field) => field.value !== '—')

  const mortgageBalance = nullIfZeroish(asNumber(firstDefined(record, ['mortgage_balance', 'loan_balance'])))
  const fourthFocusMetric = presentation.key === 'land'
    ? { label: 'Value Per Acre', value: formatMoney(assetInput.valuePerAcre) }
    : presentation.key === 'multifamily_2_4'
      ? { label: 'Price Per Unit', value: formatMoney(assetInput.pricePerUnit) }
      : presentation.key === 'multifamily_5_plus'
        ? { label: 'Avg Sqft / Unit', value: formatInteger(assetInput.avgSqftPerUnit) }
        : { label: 'Mortgage Balance', value: formatMoney(mortgageBalance) }

  const focusMetrics = [
    ...presentation.buildPeekMetrics(assetInput).slice(0, 3),
    fourthFocusMetric,
  ]

  const intelligenceStrip = [
    { label: 'Condition', value: text(assetInput.condition) || '—' },
    { label: 'Effective Built', value: formatInteger(assetInput.effectiveYearBuilt) },
    { label: 'Construction', value: text(assetInput.constructionType) ? titleize(text(assetInput.constructionType)) : '—' },
    { label: 'Priority', value: priorityScore != null ? String(Math.round(priorityScore)) : 'UNSCORED' },
  ]

  const threadKey = text(firstDefined(record, ['thread_key', 'threadKey', 'conversation_id'])) || null
  const suppressionReason = text(firstDefined(record, ['suppression_reason'])) || null
  const messagingBlockReason = canonical.messagingBlocked
    ? (suppressionReason || canonical.contactabilityLabel)
    : null
  const followUpEligibility = resolveFollowUpEligibility(record, {
    threadKey,
    messagingBlocked: canonical.messagingBlocked,
    messagingBlockReason,
    status: canonical.status,
    suppressed: canonical.messagingBlocked,
    dnc: canonical.contactability === 'dnc' || canonical.contactability === 'opted_out',
    suppressionReason,
  })

  const focusOperationFields = [
    { label: 'Campaign', value: text(firstDefined(record, ['campaign_name', 'campaignName'])) || '—' },
    { label: 'Automation', value: text(firstDefined(record, ['automation_state', 'automationState', 'execution_state'])) || '—' },
    { label: 'Follow-Up Due', value: formatDate(text(firstDefined(record, ['next_follow_up_at', 'follow_up_due_at']))) },
    { label: 'Next Action', value: formatDate(text(firstDefined(record, ['next_action_at', 'next_scheduled_for']))) },
    { label: 'Last Inbound', value: formatDate(text(firstDefined(record, ['last_inbound_at', 'last_reply_at']))) },
    { label: 'Last Outbound', value: formatDate(text(firstDefined(record, ['last_outbound_at', 'latest_message_at']))) },
    { label: 'Delivery', value: text(firstDefined(record, ['delivery_status', 'latest_delivery_status'])) || '—' },
  ].filter((field) => field.value !== '—')

  return {
    propertyId: text(firstDefined(record, ['property_id', 'propertyId', 'id'])),
    threadKey,
    masterOwner: {
      id: text(firstDefined(record, ['master_owner_id', 'masterOwnerId'])) || null,
      displayName: resolveMasterOwnerName(record),
      mailingAddress: text(firstDefined(record, ['mailing_address_full', 'owner_mailing_address', 'mailing_address'])) || null,
      yearsOwned,
      absentee: asBoolean(firstDefined(record, ['absentee_owner', 'absenteeOwner'])),
      outOfState: asBoolean(firstDefined(record, ['out_of_state_owner', 'outOfStateOwner'])),
      freeAndClear: equityPercent != null ? equityPercent >= 95 : null,
      portfolioCount,
      contactability: canonical.contactabilityLabel,
      suppressed: canonical.messagingBlocked,
      dnc: canonical.contactability === 'dnc' || canonical.contactability === 'opted_out',
      priorityScore,
      priorityClassification: priority.classification,
      prioritySignals: flags.slice(0, 3).map((flag) => flag.label),
    },
    property: {
      address,
      imageUrl: resolvePropertyImage(record, address),
      assetType: presentation.label,
      assetClassKey: presentation.key,
      subtype: assetInput.subtype,
      units: assetInput.units,
      beds: assetInput.beds,
      baths: assetInput.baths,
      sqft: assetInput.sqft,
      lotSqft: assetInput.lotSqft,
      acreage: assetInput.acreage,
      yearBuilt: assetInput.yearBuilt,
      effectiveYearBuilt: assetInput.effectiveYearBuilt,
      constructionType: assetInput.constructionType,
      condition: assetInput.condition,
      stories: assetInput.stories,
      zoning: assetInput.zoning,
      landUse: assetInput.landUse,
      roadAccess: assetInput.roadAccess,
      avgSqftPerUnit: assetInput.avgSqftPerUnit,
      avgBedsPerUnit: assetInput.avgBedsPerUnit,
      avgBathsPerUnit: assetInput.avgBathsPerUnit,
      occupancyCode: text(firstDefined(record, ['occupancy_code', 'occupancy'])) || null,
    },
    financials: {
      estimatedValue: assetInput.estimatedValue,
      estimatedEquity: assetInput.equityAmount,
      equityPercent: assetInput.equityPercent,
      repairs: assetInput.repairs,
      mortgageBalance: nullIfZeroish(asNumber(firstDefined(record, ['mortgage_balance', 'loan_balance']))),
      loanCount: nullIfZeroish(asNumber(firstDefined(record, ['loan_count']))),
      loanType: text(firstDefined(record, ['loan_type'])) || null,
      assessedLandValue: nullIfZeroish(asNumber(firstDefined(record, ['assessed_land_value']))),
      assessedImprovementValue: nullIfZeroish(asNumber(firstDefined(record, ['assessed_improvement_value']))),
      assessedTotalValue: nullIfZeroish(asNumber(firstDefined(record, ['assessed_total_value', 'assessed_value']))),
      annualTaxes: nullIfZeroish(asNumber(firstDefined(record, ['annual_taxes', 'tax_amount']))),
      lastSaleAmount: nullIfZeroish(asNumber(firstDefined(record, ['last_sale_amount', 'lastSaleAmount']))),
      lastSaleDate: text(firstDefined(record, ['last_sale_date', 'lastSaleDate'])) || null,
      pricePerSqft: assetInput.pricePerSqft,
      pricePerUnit: assetInput.pricePerUnit,
      valuePerAcre: assetInput.valuePerAcre,
    },
    operations: {
      stage: canonical.stage,
      stageLabel: canonical.stageLabel,
      status: canonical.status,
      statusLabel: canonical.statusLabel,
      temperature: canonical.temperature,
      temperatureLabel: canonical.temperatureLabel,
      followUpEligible: followUpEligibility.canExecute,
      followUpDueAt: text(firstDefined(record, ['next_follow_up_at', 'follow_up_due_at'])) || null,
      nextActionAt: text(firstDefined(record, ['next_action_at', 'next_scheduled_for'])) || null,
      campaignName: text(firstDefined(record, ['campaign_name'])) || null,
      automationState: text(firstDefined(record, ['automation_state', 'execution_state'])) || 'none',
      suppressionReason: text(firstDefined(record, ['suppression_reason'])) || null,
    },
    conversation: {
      lastInboundText: text(firstDefined(record, ['last_inbound_text', 'latest_inbound_body'])) || null,
      lastInboundAt: text(firstDefined(record, ['last_inbound_at', 'last_reply_at'])) || null,
      lastOutboundText: text(firstDefined(record, ['last_outbound_text', 'latest_outbound_body'])) || null,
      lastOutboundAt: text(firstDefined(record, ['last_outbound_at', 'latest_message_at'])) || null,
      deliveryStatus: text(firstDefined(record, ['delivery_status', 'latest_delivery_status'])) || null,
    },
    flags,
    assetSummaryLine: presentation.buildSummaryLine(assetInput) || '—',
    contextualLine: buildContextualLine(record) || null,
    peekMetrics: presentation.buildPeekMetrics(assetInput),
    focusMetrics,
    intelligenceStrip,
    followUpEligibility,
    focusProfileFields: presentation.buildFocusProfileFields(assetInput).filter((field) => field.value !== '—'),
    focusFinancialFields,
    focusOwnerFields,
    focusOperationFields,
    activity,
    edgeAccent: resolveEdgeAccent(activity, canonical),
    messagingBlocked: canonical.messagingBlocked,
    messagingBlockReason,
  }
}