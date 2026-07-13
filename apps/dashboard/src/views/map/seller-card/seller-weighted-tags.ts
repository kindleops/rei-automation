import type { SellerMapCardFlag } from './seller-map-card.types'
import {
  asBoolean,
  asNumber,
  firstDefined,
  nullIfZeroish,
  parseTagValues,
  text,
  titleize,
} from './seller-map-card-formatters'

export type WeightedTagTier = 'critical' | 'motivation' | 'positive' | 'context' | 'neutral'

export type WeightedTag = SellerMapCardFlag & {
  category: string
  tier: WeightedTagTier
  weight: number
  sortPriority: number
  tooltip: string
  source: string
  confidence: 'high' | 'medium' | 'low'
}

type TagDefinition = {
  label: string
  tier: WeightedTagTier
  category: string
  weight: number
  sortPriority: number
  tooltip: string
  source: string
}

const TIER_ORDER: Record<WeightedTagTier, number> = {
  critical: 0,
  motivation: 1,
  positive: 2,
  context: 3,
  neutral: 4,
}

const TAG_REGISTRY: Record<string, TagDefinition> = {
  pre_foreclosure: {
    label: 'Pre-Foreclosure',
    tier: 'critical',
    category: 'distress',
    weight: 98,
    sortPriority: 1,
    tooltip: 'Pre-foreclosure signal increases urgency and seller pressure.',
    source: 'property_flags',
  },
  foreclosure: {
    label: 'Foreclosure',
    tier: 'critical',
    category: 'distress',
    weight: 100,
    sortPriority: 0,
    tooltip: 'Active foreclosure indicates imminent disposition risk.',
    source: 'property_flags',
  },
  auction: {
    label: 'Auction',
    tier: 'critical',
    category: 'distress',
    weight: 96,
    sortPriority: 2,
    tooltip: 'Auction timeline compresses acquisition window.',
    source: 'property_flags',
  },
  tax_delinquent: {
    label: 'Tax Delinquent',
    tier: 'critical',
    category: 'distress',
    weight: 94,
    sortPriority: 3,
    tooltip: 'Tax delinquency signals financial pressure on the owner.',
    source: 'properties.tax_delinquent',
  },
  active_lien: {
    label: 'Active Lien',
    tier: 'critical',
    category: 'distress',
    weight: 92,
    sortPriority: 4,
    tooltip: 'Recorded lien exposure can constrain title and motivation.',
    source: 'properties.active_lien',
  },
  probate: {
    label: 'Probate',
    tier: 'critical',
    category: 'distress',
    weight: 90,
    sortPriority: 5,
    tooltip: 'Probate often creates decision friction and timeline opportunity.',
    source: 'property_flags',
  },
  code_violation: {
    label: 'Code Violation',
    tier: 'critical',
    category: 'distress',
    weight: 88,
    sortPriority: 6,
    tooltip: 'Municipal code issues increase carry cost and seller urgency.',
    source: 'property_flags',
  },
  urgent: {
    label: 'Urgent',
    tier: 'critical',
    category: 'operations',
    weight: 95,
    sortPriority: 2,
    tooltip: 'Operator or system flagged this lead as urgent.',
    source: 'inbox_thread_state',
  },
  issue: {
    label: 'Issue',
    tier: 'critical',
    category: 'operations',
    weight: 86,
    sortPriority: 7,
    tooltip: 'Delivery, contact, or automation issue requires attention.',
    source: 'execution_state',
  },
  tired_landlord: {
    label: 'Tired Landlord',
    tier: 'motivation',
    category: 'ownership',
    weight: 72,
    sortPriority: 20,
    tooltip: 'Long-hold landlord fatigue often precedes disposition.',
    source: 'property_flags',
  },
  senior_owner: {
    label: 'Senior Owner',
    tier: 'motivation',
    category: 'ownership',
    weight: 68,
    sortPriority: 21,
    tooltip: 'Aging ownership profile can indicate life-event motivation.',
    source: 'property_flags',
  },
  heavily_dated: {
    label: 'Heavily Dated',
    tier: 'motivation',
    category: 'condition',
    weight: 64,
    sortPriority: 22,
    tooltip: 'Dated condition increases repair burden and seller friction.',
    source: 'property_flags',
  },
  off_market: {
    label: 'Off Market',
    tier: 'motivation',
    category: 'strategy',
    weight: 60,
    sortPriority: 23,
    tooltip: 'Off-market posture reduces retail competition.',
    source: 'property_flags',
  },
  long_term_owner: {
    label: 'Long-Term Owner',
    tier: 'motivation',
    category: 'ownership',
    weight: 58,
    sortPriority: 24,
    tooltip: 'Extended hold period can signal eventual disposition appetite.',
    source: 'properties.ownership_years',
  },
  mid_term_owner: {
    label: 'Mid-Term Owner',
    tier: 'motivation',
    category: 'ownership',
    weight: 52,
    sortPriority: 25,
    tooltip: 'Mid-term hold may indicate moderate ownership friction.',
    source: 'properties.ownership_years',
  },
  vacant: {
    label: 'Vacant',
    tier: 'motivation',
    category: 'occupancy',
    weight: 70,
    sortPriority: 19,
    tooltip: 'Vacancy increases carry cost and seller pressure.',
    source: 'property_flags',
  },
  corporate_complexity: {
    label: 'Corporate Complexity',
    tier: 'motivation',
    category: 'ownership',
    weight: 56,
    sortPriority: 26,
    tooltip: 'Entity ownership can slow decisions but enable portfolio sales.',
    source: 'owner_type',
  },
  high_equity: {
    label: 'High Equity',
    tier: 'positive',
    category: 'financial',
    weight: 78,
    sortPriority: 30,
    tooltip: 'Strong equity improves acquisition flexibility.',
    source: 'properties.equity_percent',
  },
  free_and_clear: {
    label: 'Free And Clear',
    tier: 'positive',
    category: 'financial',
    weight: 82,
    sortPriority: 28,
    tooltip: 'No meaningful mortgage balance reduces seller friction.',
    source: 'properties.equity_percent',
  },
  absentee_owner: {
    label: 'Absentee Owner',
    tier: 'positive',
    category: 'ownership',
    weight: 74,
    sortPriority: 29,
    tooltip: 'Absentee ownership often correlates with disposition appetite.',
    source: 'properties.absentee_owner',
  },
  out_of_state_owner: {
    label: 'Out-Of-State Owner',
    tier: 'positive',
    category: 'ownership',
    weight: 76,
    sortPriority: 29,
    tooltip: 'Remote ownership increases management friction.',
    source: 'properties.out_of_state_owner',
  },
  sms_eligible: {
    label: 'SMS Eligible',
    tier: 'positive',
    category: 'contact',
    weight: 66,
    sortPriority: 31,
    tooltip: 'Linked prospect is eligible for SMS outreach.',
    source: 'prospects.sms_eligible',
  },
  has_phone: {
    label: 'Has Phone',
    tier: 'positive',
    category: 'contact',
    weight: 62,
    sortPriority: 32,
    tooltip: 'Dialable phone is available on the hydrated record.',
    source: 'v_command_map_seller_pin_feed',
  },
  owner_confirmed: {
    label: 'Owner Confirmed',
    tier: 'positive',
    category: 'contact',
    weight: 80,
    sortPriority: 27,
    tooltip: 'Ownership has been confirmed in conversation.',
    source: 'lifecycle_stage',
  },
  strong_contactability: {
    label: 'Strong Contactability',
    tier: 'positive',
    category: 'contact',
    weight: 64,
    sortPriority: 33,
    tooltip: 'Prospect contact signals are favorable for outreach.',
    source: 'prospects',
  },
  multifamily_5_plus: {
    label: 'Multifamily 5+',
    tier: 'context',
    category: 'asset',
    weight: 40,
    sortPriority: 40,
    tooltip: 'Large multifamily asset class — evaluate per-unit economics.',
    source: 'property_type',
  },
  multifamily_2_4: {
    label: '2–4 Units',
    tier: 'context',
    category: 'asset',
    weight: 38,
    sortPriority: 41,
    tooltip: 'Small multifamily profile — residential financing dynamics apply.',
    source: 'property_type',
  },
  commercial: {
    label: 'Commercial',
    tier: 'context',
    category: 'asset',
    weight: 36,
    sortPriority: 42,
    tooltip: 'Commercial asset — underwriting differs from residential.',
    source: 'property_type',
  },
  storage: {
    label: 'Storage',
    tier: 'context',
    category: 'asset',
    weight: 34,
    sortPriority: 43,
    tooltip: 'Self-storage asset — unit count and occupancy drive value.',
    source: 'property_type',
  },
  land: {
    label: 'Land',
    tier: 'context',
    category: 'asset',
    weight: 32,
    sortPriority: 44,
    tooltip: 'Land asset — zoning and utility access are primary drivers.',
    source: 'property_type',
  },
  buyer_demand: {
    label: 'Buyer Demand',
    tier: 'context',
    category: 'market',
    weight: 44,
    sortPriority: 39,
    tooltip: 'Geographic buyer-demand signal supports exit liquidity.',
    source: 'property_flags',
  },
  buyer_demand_area: {
    label: 'Buyer Demand Area',
    tier: 'context',
    category: 'market',
    weight: 42,
    sortPriority: 39,
    tooltip: 'Geographic buyer-demand signal supports exit liquidity.',
    source: 'property_flags',
  },
  portfolio_owner: {
    label: 'Portfolio Owner',
    tier: 'context',
    category: 'ownership',
    weight: 48,
    sortPriority: 38,
    tooltip: 'Owner holds multiple properties — portfolio leverage possible.',
    source: 'master_owners.property_count',
  },
  corporate_owner: {
    label: 'Corporate Owner',
    tier: 'neutral',
    category: 'ownership',
    weight: 20,
    sortPriority: 50,
    tooltip: 'Entity-owned property — route to decision-maker, not entity greeting.',
    source: 'owner_type',
  },
  llc: {
    label: 'LLC',
    tier: 'neutral',
    category: 'ownership',
    weight: 18,
    sortPriority: 51,
    tooltip: 'LLC ownership — use generic outreach until human prospect resolves.',
    source: 'owner_type',
  },
  trust_owner: {
    label: 'Trust Owner',
    tier: 'neutral',
    category: 'ownership',
    weight: 18,
    sortPriority: 52,
    tooltip: 'Trust ownership — trustee or beneficiary may be the real contact.',
    source: 'owner_type',
  },
  unscored: {
    label: 'Unscored',
    tier: 'neutral',
    category: 'intelligence',
    weight: 10,
    sortPriority: 60,
    tooltip: 'No owner priority score is available yet.',
    source: 'master_owners.priority_score',
  },
  no_contact_yet: {
    label: 'No Contact Yet',
    tier: 'neutral',
    category: 'contact',
    weight: 12,
    sortPriority: 55,
    tooltip: 'No outbound contact has been logged for this property.',
    source: 'inbox_thread_state',
  },
}

const normalizeTagKey = (label: string): string =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

const resolveDefinition = (label: string): TagDefinition => {
  const key = normalizeTagKey(label)
  if (TAG_REGISTRY[key]) return TAG_REGISTRY[key]

  const lower = label.toLowerCase()
  if (lower.includes('foreclosure') && lower.includes('pre')) return TAG_REGISTRY.pre_foreclosure
  if (lower.includes('foreclosure')) return TAG_REGISTRY.foreclosure
  if (lower.includes('lien')) return TAG_REGISTRY.active_lien
  if (lower.includes('probate')) return TAG_REGISTRY.probate
  if (lower.includes('vacant')) return TAG_REGISTRY.vacant
  if (lower.includes('tired')) return TAG_REGISTRY.tired_landlord
  if (lower.includes('senior')) return TAG_REGISTRY.senior_owner
  if (lower.includes('llc')) return TAG_REGISTRY.llc
  if (lower.includes('trust')) return TAG_REGISTRY.trust_owner
  if (lower.includes('cash') && lower.includes('buyer')) return TAG_REGISTRY.buyer_demand
  if (lower.includes('buyer') && lower.includes('demand')) return TAG_REGISTRY.buyer_demand

  return {
    label,
    tier: 'neutral',
    category: 'imported',
    weight: 24,
    sortPriority: 70,
    tooltip: `Imported acquisition signal: ${label}.`,
    source: 'property_flags',
  }
}

const tierToSeverity = (tier: WeightedTagTier): SellerMapCardFlag['severity'] => {
  if (tier === 'critical') return 'high'
  if (tier === 'motivation' || tier === 'positive') return 'medium'
  return 'low'
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

export const buildWeightedTags = (
  record: Record<string, unknown>,
  context: {
    equityPercent: number | null
    assetClassKey: string
    units: number | null
    portfolioCount: number | null
    ownershipYears: number | null
    ownerType: string | null
    hasPriorContact: boolean
    ownerPriorityScore: number | null
  },
): WeightedTag[] => {
  const tags = new Map<string, WeightedTag>()

  const add = (definition: TagDefinition, confidence: WeightedTag['confidence'] = 'high') => {
    const key = normalizeTagKey(definition.label)
    if (tags.has(key)) return
    tags.set(key, {
      key,
      label: definition.label,
      severity: tierToSeverity(definition.tier),
      category: definition.category,
      tier: definition.tier,
      weight: definition.weight,
      sortPriority: definition.sortPriority,
      tooltip: definition.tooltip,
      source: definition.source,
      confidence,
    })
  }

  for (const raw of parseTagValues(firstDefined(record, [
    'property_flags_json',
    'property_flags_text',
    'property_tags_json',
    'property_tags_text',
    'seller_tags_json',
    'seller_tags_text',
    'podio_tags',
  ]))) {
    add(resolveDefinition(titleize(raw)), 'medium')
  }

  if ((context.equityPercent ?? 0) >= 95) add(TAG_REGISTRY.free_and_clear)
  else if ((context.equityPercent ?? 0) >= 65) add(TAG_REGISTRY.high_equity)

  if (asBoolean(firstDefined(record, ['tax_delinquent', 'taxDelinquent'])) === true) add(TAG_REGISTRY.tax_delinquent)
  if (asBoolean(firstDefined(record, ['absentee_owner', 'absenteeOwner'])) === true) add(TAG_REGISTRY.absentee_owner)
  if (asBoolean(firstDefined(record, ['out_of_state_owner', 'outOfStateOwner'])) === true) add(TAG_REGISTRY.out_of_state_owner)
  if (asBoolean(firstDefined(record, ['active_lien', 'activeLien'])) === true) add(TAG_REGISTRY.active_lien)
  if (asBoolean(firstDefined(record, ['vacant', 'is_vacant'])) === true) add(TAG_REGISTRY.vacant)

  if (context.ownershipYears != null) {
    if (context.ownershipYears >= 15) add(TAG_REGISTRY.long_term_owner)
    else if (context.ownershipYears >= 7) add(TAG_REGISTRY.mid_term_owner)
  }

  if ((context.portfolioCount ?? 0) >= 2) add(TAG_REGISTRY.portfolio_owner)

  const ownerType = text(context.ownerType).toLowerCase()
  if (ownerType.includes('corporate') || ownerType.includes('llc') || ownerType.includes('trust')) {
    add(TAG_REGISTRY.corporate_complexity)
    if (ownerType.includes('llc')) add(TAG_REGISTRY.llc)
    if (ownerType.includes('trust')) add(TAG_REGISTRY.trust_owner)
    if (ownerType.includes('corporate')) add(TAG_REGISTRY.corporate_owner)
  }

  if (record.sms_eligible === true) add(TAG_REGISTRY.sms_eligible)
  if (hasDialablePhone(record)) add(TAG_REGISTRY.has_phone)

  const stage = text(firstDefined(record, ['lifecycle_stage', 'seller_stage', 'stage'])).toLowerCase()
  if (stage.includes('owner_confirmed') || stage.includes('ownership_confirmation')) add(TAG_REGISTRY.owner_confirmed)

  if (text(firstDefined(record, ['execution_state'])).toLowerCase() === 'issue') add(TAG_REGISTRY.issue)
  if (text(firstDefined(record, ['seller_state'])).toLowerCase() === 'hot'
    || asBoolean(firstDefined(record, ['is_urgent'])) === true) add(TAG_REGISTRY.urgent)

  if (context.assetClassKey === 'multifamily_5_plus') add(TAG_REGISTRY.multifamily_5_plus)
  if (context.assetClassKey === 'multifamily_2_4') add(TAG_REGISTRY.multifamily_2_4)
  if (context.assetClassKey === 'land') add(TAG_REGISTRY.land)
  if (context.assetClassKey === 'storage') add(TAG_REGISTRY.storage)
  if (['retail', 'office', 'industrial', 'other_commercial'].includes(context.assetClassKey)) add(TAG_REGISTRY.commercial)

  if (!context.hasPriorContact) add(TAG_REGISTRY.no_contact_yet)
  if (context.ownerPriorityScore == null) add(TAG_REGISTRY.unscored)

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
  const prospectName = text(firstDefined(record, [
    'prospect_full_name',
    'prospect_first_name',
    'prospect_name',
  ]))
  if (prospectName && (contactScore ?? 0) >= 70 && (phoneScore ?? 0) >= 60) {
    add(TAG_REGISTRY.strong_contactability, 'medium')
  }

  return Array.from(tags.values()).sort((left, right) => {
    const tierDelta = TIER_ORDER[left.tier] - TIER_ORDER[right.tier]
    if (tierDelta !== 0) return tierDelta
    const weightDelta = right.weight - left.weight
    if (weightDelta !== 0) return weightDelta
    return left.sortPriority - right.sortPriority
  })
}

export const collapseWeightedTags = (
  tags: WeightedTag[],
  limit: number,
): { visible: WeightedTag[]; hiddenCount: number } => {
  const visible = tags.slice(0, limit)
  return {
    visible,
    hiddenCount: Math.max(0, tags.length - visible.length),
  }
}