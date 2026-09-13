import { buildAerialViewUrl, buildStreetViewUrl } from '../../../domain/inbox/inbox-normalization'
import { safeHumanName } from '../../../lib/identity/entityDetection'
import type { SellerMapCardViewModel } from './seller-map-card.types'
import {
  buildAssetInput,
  resolveSellerAssetPresentation,
} from './seller-asset-presentation-registry'
import { buildCanonicalLeadStatePresentation } from './seller-lead-state-presentation'
import { resolveFollowUpEligibility, hasPriorOutboundContact } from './seller-follow-up-eligibility'
import { resolveSellerActionBar } from './seller-action-bar'
import { buildPropertyDossierContract, buildOperationalStateLine } from './seller-property-dossier-contract'
import { buildWeightedTags, collapseWeightedTags } from './seller-weighted-tags'
import {
  asNumber,
  firstDefined,
  nullIfZeroish,
  text,
} from './seller-map-card-formatters'

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

const resolveHeaderDisplayName = (record: Record<string, unknown>): string => {
  const prospectName = safeHumanName(text(firstDefined(record, [
    'prospect_full_name',
    'prospect_first_name',
    'prospect_name',
  ])))
  if (prospectName && record.sms_eligible !== false) return prospectName
  return resolveMasterOwnerName(record)
}

const httpsOnly = (value: string | null): string | null =>
  value ? value.replace(/^http:\/\//i, 'https://') : null

const recordCoords = (record: Record<string, unknown>): { lat: number | null; lng: number | null } => {
  const num = (value: unknown): number | null => {
    const n = Number(value)
    return Number.isFinite(n) && Math.abs(n) > 0.001 ? n : null
  }
  return {
    lat: num(firstDefined(record, ['lat', 'latitude', 'property_lat'])),
    lng: num(firstDefined(record, ['lng', 'longitude', 'property_lng'])),
  }
}

/**
 * THE HERO IMAGE — Street View first.
 *
 * The previous priority list put `map_image` and `satellite_image` ABOVE the
 * Street View fallback, so any property carrying a stored static-map URL rendered a
 * flat roadmap tile and Street View never ran. That is the reported "street view
 * doesn't work": it was not failing, it was being outranked.
 *
 * Observed on property 232714379 (1115 Nw 64th St, Miami FL): the card rendered a
 * roadmap tile centred on 35.94336,-77.783619 — Rocky Mount, North Carolina — because
 * a stale stored `map_image` won the priority contest. A stored value is only trusted
 * now when it is genuinely a Street View asset; anything else is demoted to fallback.
 *
 * Coordinates are preferred over the address string because the address goes through
 * Google's geocoder, and a geocoder miss is exactly how imagery ends up in the wrong
 * state.
 */
const resolvePropertyImage = (record: Record<string, unknown>, address: string): string | null => {
  const storedStreetView = text(firstDefined(record, [
    'streetview_image',
    'streetViewImage',
    'street_view_image',
  ]))
  if (storedStreetView) return httpsOnly(storedStreetView)

  const { lat, lng } = recordCoords(record)
  if (lat !== null && lng !== null) return buildStreetViewUrl(null, lat, lng)
  if (address && address !== 'Property Unknown') return buildStreetViewUrl(address) || null
  return null
}

/** Aerial/roadmap imagery, used only when Street View reports no panorama. */
const resolvePropertyFallbackImage = (
  record: Record<string, unknown>,
  address: string,
): string | null => {
  const stored = text(firstDefined(record, [
    'satellite_image',
    'satelliteImage',
    'map_image',
    'mapImage',
  ]))
  const { lat, lng } = recordCoords(record)
  // A stored static map is only trustworthy when we cannot derive one ourselves —
  // see the Rocky Mount case above.
  if (lat !== null && lng !== null) return buildAerialViewUrl(null, lat, lng)
  if (stored) return httpsOnly(stored)
  if (address && address !== 'Property Unknown') return buildAerialViewUrl(address) || null
  return null
}

const buildHeaderBadges = (
  canonical: ReturnType<typeof buildCanonicalLeadStatePresentation>,
  presentation: ReturnType<typeof resolveSellerAssetPresentation>,
  priorityScore: number | null,
  units: number | null,
): SellerMapCardViewModel['headerBadges'] => {
  const badges: SellerMapCardViewModel['headerBadges'] = [
    { key: 'stage', label: canonical.stageLabel, tone: 'stage' },
    { key: 'status', label: canonical.statusLabel, tone: 'status' },
  ]
  if (priorityScore != null) {
    badges.push({ key: 'score', label: `Score ${Math.round(priorityScore)}`, tone: 'score' })
  }
  badges.push({ key: 'asset', label: presentation.label.toUpperCase(), tone: 'asset' })
  if (units != null && units > 1) {
    badges.push({ key: 'units', label: `${units} Units`, tone: 'units' })
  }
  return badges
}

const resolveEdgeAccent = (
  canonical: ReturnType<typeof buildCanonicalLeadStatePresentation>,
  messagingBlocked: boolean,
): SellerMapCardViewModel['edgeAccent'] => {
  if (messagingBlocked) return 'suppressed'
  if (canonical.status === 'follow_up_due') return 'due'
  if (canonical.temperature === 'hot') return 'hot'
  if (canonical.status === 'new_reply') return 'reply'
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
    'priority_score',
  ])))

  const hasPriorContact = hasPriorOutboundContact(record)
  const equityPercent = assetInput.equityPercent
  const yearsOwned = nullIfZeroish(asNumber(firstDefined(record, ['ownership_years', 'ownershipYears', 'years_owned'])))
  const portfolioCount = nullIfZeroish(asNumber(firstDefined(record, [
    'portfolio_count',
    'property_count',
    'owner_property_count',
  ])))
  const ownerType = text(firstDefined(record, ['owner_type'])) || null

  const weightedTags = buildWeightedTags(record, {
    equityPercent,
    assetClassKey: presentation.key,
    units: assetInput.units,
    portfolioCount,
    ownershipYears: yearsOwned,
    ownerType,
    hasPriorContact,
    ownerPriorityScore: priorityScore,
  })
  const { visible: weightedSignals } = collapseWeightedTags(weightedTags, 10)

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

  const actionBar = resolveSellerActionBar({
    followUpEligibility,
    status: canonical.status,
    messagingBlocked: canonical.messagingBlocked,
    messagingBlockReason,
    hasThread: Boolean(threadKey) && !threadKey?.startsWith('property:'),
  })

  const dossierReady = record.dossier_hydrated === true || record._dossierHydrated === true
  const dossier = dossierReady ? buildPropertyDossierContract(record, presentation.key) : null

  return {
    propertyId: text(firstDefined(record, ['property_id', 'propertyId', 'id'])),
    threadKey,
    headerDisplayName: resolveHeaderDisplayName(record),
    property: {
      address,
      imageUrl: resolvePropertyImage(record, address),
      fallbackImageUrl: resolvePropertyFallbackImage(record, address),
      assetType: presentation.label,
      assetClassKey: presentation.key,
      units: assetInput.units,
    },
    operations: {
      stage: canonical.stage,
      status: canonical.status,
      stageLabel: canonical.stageLabel,
      statusLabel: canonical.statusLabel,
    },
    headerBadges: buildHeaderBadges(canonical, presentation, priorityScore, assetInput.units),
    assetSummaryLine: presentation.buildSummaryLine(assetInput) || '—',
    peekMetrics: presentation.buildPeekMetrics(assetInput),
    weightedSignals: weightedSignals.map((tag) => ({
      key: tag.key,
      label: tag.label,
      severity: tag.severity,
      tier: tag.tier,
      tooltip: tag.tooltip,
    })),
    operationalState: buildOperationalStateLine(record, canonical.statusLabel, canonical.messagingBlocked, messagingBlockReason),
    dossier,
    dossierReady,
    followUpEligibility,
    actionBar,
    edgeAccent: resolveEdgeAccent(canonical, canonical.messagingBlocked),
    messagingBlocked: canonical.messagingBlocked,
    messagingBlockReason,
    masterOwner: {
      id: text(firstDefined(record, ['master_owner_id', 'masterOwnerId', 'owner_id', 'ownerId'])) || null,
      displayName: resolveMasterOwnerName(record),
      priorityScore,
    },
  }
}