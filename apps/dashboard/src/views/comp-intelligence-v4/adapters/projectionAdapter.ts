/**
 * Comp Intelligence V4 — canonical projection adapter.
 *
 * Turns the read-only server projection (`CompIntelligencePayload`) into the
 * typed `V4Model` the UI consumes.
 *
 * Qualification authority (Phase 2): `qualified` is produced ONLY by the
 * canonical Acquisition Engine V3 transaction pipeline (`transaction_evidence`).
 * When that is unavailable, the discovery path yields `candidate` records and a
 * conservative defensive classifier may only DEMOTE them — it can never invent
 * a qualified pricing comp. See `qualification.ts`.
 *
 * Single canonical state per record (Phase 5). Qualified statistics are computed
 * strictly from `qualified` records (Phase 6).
 */

import type {
  EvidenceState,
  LatLng,
  TransactionBadge,
  V4Evidence,
  V4DecisionRibbon,
  V4MarketSummary,
  V4Model,
  V4Subject,
} from '../state/types'
import {
  assetLaneLabel,
  classifySource,
  executionStateLabel,
  matchTierFromScore,
  reasonLabel,
  strategyLabel,
  valueClassificationLabel,
} from './labels'
import {
  classifyDefensive,
  classifyFromV3,
  type CandidateSignals,
  type ClassifyContext,
  type SubjectAnchor,
} from './qualification'
import { resolveCompMediaUrl, resolveSubjectMediaUrl } from './media'

type Raw = Record<string, unknown>

interface AdapterContext {
  propertyId: string
  opportunityId?: string | null
  threadKey?: string | null
  masterOwnerId?: string | null
  radiusMiles: number
  monthsBack: number
}

// ── primitive readers ──────────────────────────────────────────────────────

function ev<T = unknown>(field: unknown): T | null {
  if (field == null) return null
  if (typeof field === 'object' && field !== null && 'value' in (field as Raw)) {
    return ((field as Raw).value ?? null) as T | null
  }
  return field as T
}

function str(field: unknown): string | null {
  const v = ev<unknown>(field)
  if (v == null) return null
  const s = String(v).trim()
  return s.length ? s : null
}

function n(field: unknown): number | null {
  const v = ev<unknown>(field)
  if (v == null || v === '') return null
  const num = Number(v)
  return Number.isFinite(num) ? num : null
}

function coordOf(latField: unknown, lngField: unknown): LatLng | null {
  const lat = n(latField)
  const lng = n(lngField)
  if (lat == null || lng == null) return null
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  if (lat === 0 && lng === 0) return null
  return { lat, lng }
}

function median(values: number[]): number | null {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!arr.length) return null
  const mid = Math.floor(arr.length / 2)
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2
}

const UNIT_ADDRESS_RE = /(#|\bapt\b|\bunit\b|\bste\b|\bbldg\b)/i

function isUnitAddress(address: string | null): boolean {
  return address != null && UNIT_ADDRESS_RE.test(address)
}

const SINGLE_ASSET_LANES = new Set(['single_family', 'sfr', 'condo', 'townhome', 'duplex'])

function subjectIsSingleAsset(lane: string | null, units: number | null): boolean {
  const l = String(lane ?? '').toLowerCase()
  if ((units ?? 1) > 4) return false
  if (SINGLE_ASSET_LANES.has(l)) return true
  return (units ?? 1) <= 4 && !l.includes('apartment') && !l.includes('multi')
}

function sourceBadge(label: string | null): TransactionBadge | null {
  if (!label) return null
  return { label, tone: 'neutral' }
}

// ── subject ────────────────────────────────────────────────────────────────

function adaptSubject(raw: Raw, ctx: AdapterContext): V4Subject {
  const lane = str(raw.asset_type) ?? str(raw.property_type)
  const coord = coordOf(raw.latitude, raw.longitude)
  const address = str(raw.canonical_address) ?? str(raw.normalized_address)
  return {
    propertyId: str(raw.property_id) ?? ctx.propertyId,
    opportunityId: str(raw.opportunity_id) ?? ctx.opportunityId ?? null,
    threadKey: str(raw.thread_key) ?? ctx.threadKey ?? null,
    masterOwnerId: str(raw.master_owner_id) ?? ctx.masterOwnerId ?? null,
    address,
    coord,
    hasCoord: coord != null,
    coordSource: str(raw.coordinate_source),
    coordConfidence: n(raw.coordinate_confidence),
    isResolved: Boolean(ev<boolean>(raw.is_subject_resolved)),
    isMarketFallback: Boolean(ev<boolean>(raw.is_market_fallback)),
    coordFailureReason: str(raw.coordinate_failure_reason),
    assetLane: lane,
    assetLaneLabel: assetLaneLabel(lane),
    propertySubtype: str(raw.property_subtype) ?? str(raw.property_type),
    units: n(raw.units),
    beds: n(raw.bedrooms),
    baths: n(raw.bathrooms),
    buildingSqft: n(raw.square_feet),
    lotSqft: n(raw.lot_square_feet) ?? n(raw.lot_size),
    lotAcreage: n(raw.lot_acreage),
    yearBuilt: n(raw.year_built),
    condition: str(raw.condition),
    constructionType: str(raw.construction_type),
    zoning: str(raw.zoning),
    imageUrl: resolveSubjectMediaUrl(address, coord?.lat ?? null, coord?.lng ?? null),
    providerEstimate: n(raw.estimated_value) ?? n(raw.market_value),
    taxAssessedValue: n(raw.tax_assessed_value),
    lastSalePrice: n(raw.last_sale_price),
    lastSaleDate: str(raw.last_sale_date),
    ownerName: str(raw.owner_name),
    ownerType: str(raw.owner_type),
    dataFreshness: str(raw.data_freshness),
  }
}

// ── candidate signal extraction (discovery path) ───────────────────────────

function discoverySignals(cand: Raw): { signals: CandidateSignals; raw: Raw; address: string | null } {
  const raw = (cand.raw ?? {}) as Raw
  // Physical facts live in `raw.*`; top-level normalized fields are often null.
  const address = str(cand.address) ?? str(raw.address)
  const assetClass = str(raw.asset_class) ?? str(cand.asset_type)
  const propertyType = str(raw.property_type) ?? str(cand.property_subtype)
  const units = n(raw.units_count) ?? n(cand.units)
  const salePrice = n(raw.sale_price) ?? n(cand.sold_price) ?? n(cand.sale_list_price)
  const sqft = n(raw.sqft) ?? n(cand.square_feet)
  const beds = n(raw.beds) ?? n(cand.bedrooms)
  const baths = n(raw.baths) ?? n(cand.bathrooms)
  const ppsf = n(raw.ppsf) ?? n(cand.ppsf)
  return {
    raw,
    address,
    signals: {
      assetClass,
      propertyType,
      propertySubtype: str(cand.property_subtype) ?? propertyType,
      units,
      salePrice,
      sqft,
      beds,
      baths,
      yearBuilt: n(raw.year_built) ?? n(cand.year_built),
      ppsf,
      isUnitAddress: isUnitAddress(address),
      pricingEligible: null,
      demandEligible: null,
      packageProbability: null,
      parcelCount: null,
      essContribution: null,
      routedUniverse: null,
      evidenceRole: null,
    },
  }
}

function v3Signals(row: Raw): CandidateSignals {
  const geo = (row.geography ?? {}) as Raw
  void geo
  const address = str(row.address)
  return {
    assetClass: str(row.canonical_asset_lane),
    propertyType: str(row.property_type),
    propertySubtype: str(row.property_type),
    units: n(row.units),
    salePrice: n(row.sale_price),
    sqft: n(row.square_feet),
    beds: n(row.bedrooms),
    baths: n(row.bathrooms),
    yearBuilt: n(row.year_built),
    ppsf: null,
    isUnitAddress: isUnitAddress(address),
    pricingEligible: row.pricing_eligibility == null ? null : Boolean(row.pricing_eligibility),
    demandEligible: row.demand_eligibility == null ? null : Boolean(row.demand_eligibility),
    packageProbability: n(row.package_probability),
    parcelCount: n(row.parcel_count),
    essContribution: n(row.ess_contribution),
    routedUniverse: str(row.routed_universe),
    evidenceRole: str(row.evidence_role),
  }
}

function buildBadges(signals: CandidateSignals, sourceLabel: string | null): TransactionBadge[] {
  const badges: TransactionBadge[] = []
  const src = sourceBadge(sourceLabel)
  if (src) badges.push(src)
  const lane = String(signals.assetClass ?? signals.propertyType ?? '').toLowerCase()
  if (lane.includes('apartment') || lane.includes('multi') || (signals.units ?? 1) > 4) {
    badges.push({ label: 'Multifamily', tone: 'institutional' })
  }
  return badges
}

function evidenceFrom(
  idSeed: string,
  address: string | null,
  signals: CandidateSignals,
  state: EvidenceState,
  basisReasonFromList: string[],
  opts: {
    propertyId: string | null
    coord: LatLng | null
    distanceMiles: number | null
    saleDate: string | null
    ppu: number | null
    sourceLabel: string | null
    sourceKindSeed: string | null
    condition: string | null
    constructionType: string | null
    providerEstimate: number | null
    matchScore: number | null
    matchLabel: string | null
    imageUrl: string | null
    rawStatus: string | null
    dataFreshness: string | null
    buyerName: string | null
    buyerArchetype: string | null
    basis: V4Evidence['basis']
  },
): V4Evidence {
  const source = classifySource(opts.sourceKindSeed)
  const reasons = [opts.basis.reason, ...basisReasonFromList].filter(Boolean)
  return {
    id: opts.propertyId ?? idSeed,
    propertyId: opts.propertyId,
    state,
    rawStatus: opts.rawStatus,
    imageUrl: opts.imageUrl,
    address,
    city: null,
    state_region: null,
    zip: null,
    coord: opts.coord,
    distanceMiles: opts.distanceMiles,
    salePrice: signals.salePrice,
    saleDate: opts.saleDate,
    ppsf: signals.ppsf,
    ppu: opts.ppu,
    sourceKind: source.kind,
    sourceLabel: opts.sourceLabel ?? source.label,
    transactionBadges: buildBadges(signals, opts.sourceLabel ?? source.label),
    assetLane: signals.assetClass,
    propertySubtype: signals.propertySubtype,
    propertyType: signals.propertyType,
    units: signals.units,
    beds: signals.beds,
    baths: signals.baths,
    buildingSqft: signals.sqft,
    lotSqft: null,
    yearBuilt: signals.yearBuilt,
    condition: opts.condition,
    constructionType: opts.constructionType,
    providerEstimate: opts.providerEstimate,
    isUnitAddress: signals.isUnitAddress,
    buyerName: opts.buyerName,
    buyerEntityType: null,
    buyerArchetype: opts.buyerArchetype,
    matchScore: opts.matchScore,
    matchTier: matchTierFromScore(opts.matchScore),
    matchLabel: opts.matchLabel,
    reasons,
    basis: opts.basis,
    dataFreshness: opts.dataFreshness,
  }
}

// ── evidence assembly ────────────────────────────────────────────────────

function adaptDiscoveryEvidence(
  candidates: Raw[],
  subjectAnchor: SubjectAnchor,
): V4Evidence[] {
  const parsed = candidates.map((c) => {
    const { signals, raw, address } = discoverySignals(c)
    return { c, raw, address, signals }
  })

  // Peer anchor: median sale of priced, asset-compatible single-asset peers.
  const peerPrices = parsed
    .filter(
      (p) =>
        p.signals.salePrice != null &&
        p.signals.salePrice > 0 &&
        (p.signals.units ?? 1) <= 4 &&
        !String(p.signals.assetClass ?? '').toLowerCase().includes('apartment'),
    )
    .map((p) => p.signals.salePrice!) as number[]
  const ctx: ClassifyContext = { subject: subjectAnchor, peerMedianSale: median(peerPrices) }

  return parsed.map((p, idx) => {
    const { state, basis } = classifyDefensive(p.signals, ctx)
    const coord = coordOf(p.c.latitude ?? p.raw.latitude, p.c.longitude ?? p.raw.longitude)
    const sourceSeed = str(p.c.sold_source) ?? str(p.c.source) ?? str(p.raw.property_type)
    return evidenceFrom(`comp-${idx}`, p.address, p.signals, state, [], {
      propertyId: str(p.c.comp_property_id) ?? str(p.c.property_id) ?? str(p.raw.property_id),
      coord,
      distanceMiles: n(p.c.distance_miles) ?? n(p.raw.distance_miles),
      saleDate: str(p.raw.sale_date) ?? str(p.c.sold_date),
      ppu: n(p.raw.ppu) ?? n(p.c.ppu),
      sourceLabel: classifySource(sourceSeed).label,
      sourceKindSeed: sourceSeed,
      condition: str(p.raw.building_condition) ?? str(p.c.condition),
      constructionType: str(p.raw.construction_type),
      providerEstimate: n(p.raw.estimated_value) ?? n(p.c.estimated_value),
      matchScore: n(p.c.similarity_score) ?? n(p.raw.similarity_score),
      matchLabel: null,
      imageUrl: resolveCompMediaUrl(p.raw, p.address, coord?.lat ?? null, coord?.lng ?? null),
      rawStatus: state.toUpperCase(),
      dataFreshness: str(p.raw.sale_date) ?? str(p.c.sold_date),
      buyerName: null,
      buyerArchetype: null,
      basis,
    })
  })
}

function adaptV3Evidence(rows: Raw[]): V4Evidence[] {
  return rows.map((row, idx) => {
    const signals = v3Signals(row)
    const { state, basis } = classifyFromV3(signals, str(row.qualification_status))
    const geo = (row.geography ?? {}) as Raw
    const coord = coordOf(geo.latitude, geo.longitude)
    const reasons = Array.isArray(row.rejection_review_reasons)
      ? (row.rejection_review_reasons as unknown[]).map((r) => reasonLabel(String(r))).filter(Boolean)
      : []
    const address = str(row.address)
    return evidenceFrom(`txn-${idx}`, address, signals, state, reasons, {
      propertyId: str(row.property_id),
      coord,
      distanceMiles: n(geo.distance_miles),
      saleDate: str(row.sale_date),
      ppu: null,
      sourceLabel: classifySource(str(row.transaction_channel)).label,
      sourceKindSeed: str(row.transaction_channel),
      condition: null,
      constructionType: null,
      providerEstimate: null,
      matchScore: n(row.qualification_score) ?? n(row.similarity),
      matchLabel: str(row.comp_match_label),
      imageUrl: resolveCompMediaUrl(null, address, coord?.lat ?? null, coord?.lng ?? null),
      rawStatus: str(row.qualification_status),
      dataFreshness: str(row.sale_date),
      buyerName: str(row.buyer),
      buyerArchetype: str(row.buyer_archetype),
      basis,
    })
  })
}

const STATE_PRIORITY: Record<EvidenceState, number> = {
  qualified: 5,
  review: 4,
  candidate: 3,
  demand_only: 2,
  excluded: 1,
}

function dedupeEvidence(items: V4Evidence[]): V4Evidence[] {
  const byKey = new Map<string, V4Evidence>()
  for (const item of items) {
    const key = item.propertyId ?? item.id
    const existing = byKey.get(key)
    if (!existing || STATE_PRIORITY[item.state] > STATE_PRIORITY[existing.state]) {
      byKey.set(key, item)
    }
  }
  return Array.from(byKey.values())
}

// ── summary (Phase 6: qualified-only statistics) ───────────────────────────

function buildSummary(evidence: V4Evidence[]): V4MarketSummary {
  const byState = (s: EvidenceState) => evidence.filter((e) => e.state === s)
  const qualified = byState('qualified')
  const review = byState('review')
  const excluded = byState('excluded')
  const demand = byState('demand_only')
  const candidate = byState('candidate')

  const qSales = qualified.map((e) => e.salePrice).filter((v): v is number => v != null && v > 0)
  const qPpsf = qualified.map((e) => e.ppsf).filter((v): v is number => v != null && v > 0)
  const qDist = qualified.map((e) => e.distanceMiles).filter((v): v is number => v != null)
  const qDates = qualified.map((e) => e.saleDate).filter((v): v is string => v != null)
  const qEss = qualified
    .map((e) => e.basis.essContribution)
    .filter((v): v is number => v != null)

  // Discovered range = all priced records (context only).
  const allSales = evidence.map((e) => e.salePrice).filter((v): v is number => v != null && v > 0)

  // Largest excluded transaction + reason (Phase 9).
  const largestExcluded = [...excluded, ...demand]
    .filter((e) => e.salePrice != null && e.salePrice > 0)
    .sort((a, b) => (b.salePrice ?? 0) - (a.salePrice ?? 0))[0]

  return {
    discovered: evidence.length,
    candidate: candidate.length,
    qualified: qualified.length,
    review: review.length,
    excluded: excluded.length,
    demandOnly: demand.length,
    hasQualified: qualified.length > 0,
    qualifiedMedianSale: qSales.length ? median(qSales) : null,
    qualifiedSaleLow: qSales.length ? Math.min(...qSales) : null,
    qualifiedSaleHigh: qSales.length ? Math.max(...qSales) : null,
    qualifiedMedianPpsf: qPpsf.length ? median(qPpsf) : null,
    qualifiedEss: qEss.length ? qEss.reduce((a, b) => a + b, 0) : null,
    closestQualifiedMiles: qDist.length ? Math.min(...qDist) : null,
    newestQualifiedDate: qDates.length ? qDates.sort().slice(-1)[0] : null,
    discoveredSaleLow: allSales.length ? Math.min(...allSales) : null,
    discoveredSaleHigh: allSales.length ? Math.max(...allSales) : null,
    largestExcludedSale: largestExcluded?.salePrice ?? null,
    largestExcludedReason: largestExcluded?.basis.reason ?? null,
  }
}

// ── decision ribbon ─────────────────────────────────────────────────────────

const V3_UNAVAILABLE_NOTE =
  'Official underwriting is temporarily unavailable. Comp research remains available.'

function buildDecisionRibbon(projection: Raw | null, qualifiedCount: number): V4DecisionRibbon {
  const v3Enabled = Boolean(projection?.v3_enabled)
  const valueContract = (projection?.value_contract ?? null) as Raw | null
  const offer = (projection?.offer_authorization ?? null) as Raw | null
  const qmv = valueContract?.qualified_market_value as Raw | null
  const buyerExit = valueContract?.qualified_buyer_exit as Raw | null
  const available = v3Enabled && valueContract != null

  if (!available) {
    return {
      available: false,
      v3Enabled,
      assetLaneLabel: assetLaneLabel(str(projection?.canonical_asset_lane)),
      executionLabel: executionStateLabel(str(projection?.execution_state)),
      valueClassificationLabel: null,
      qualifiedMarketValue: null,
      conservativeBuyerExit: null,
      recommendedShadowOffer: null,
      primaryStrategyLabel: null,
      confidence: n(projection?.final_confidence),
      qualifiedEvidenceCount: qualifiedCount,
      largestBlocker: null,
      unavailableNote: V3_UNAVAILABLE_NOTE,
    }
  }

  const anomaly = (projection?.anomaly_materiality ?? null) as Raw | null
  const blockers = Array.isArray(anomaly?.material_anomaly_reasons)
    ? (anomaly!.material_anomaly_reasons as unknown[]).map((r) => reasonLabel(String(r)))
    : []
  return {
    available: true,
    v3Enabled,
    assetLaneLabel: assetLaneLabel(str(projection?.canonical_asset_lane)),
    executionLabel: executionStateLabel(str(projection?.execution_state)),
    valueClassificationLabel: valueClassificationLabel(str(projection?.value_classification)),
    qualifiedMarketValue: n(qmv?.mid),
    conservativeBuyerExit: n(buyerExit?.conservative),
    recommendedShadowOffer:
      n(offer?.scenario_recommended_offer) ?? n(offer?.authorized_recommended_offer),
    primaryStrategyLabel: strategyLabel(str(projection?.primary_strategy)),
    confidence: n(projection?.final_confidence),
    qualifiedEvidenceCount: qualifiedCount,
    largestBlocker: blockers.filter(Boolean)[0] ?? null,
    unavailableNote: null,
  }
}

// ── entry point ──────────────────────────────────────────────────────────

export function adaptProjection(payload: Raw, ctx: AdapterContext): V4Model {
  const subjectRaw = (payload.subject ?? {}) as Raw
  const subject = adaptSubject(subjectRaw, ctx)
  const subjectAnchor: SubjectAnchor = {
    assetLane: subject.assetLane,
    units: subject.units,
    providerEstimate: subject.providerEstimate,
    isSingleAsset: subjectIsSingleAsset(subject.assetLane, subject.units),
  }

  const txnEvidence = Array.isArray(payload.transaction_evidence)
    ? (payload.transaction_evidence as Raw[])
    : []
  const discovery = (payload.discovery ?? {}) as Raw
  const candidates = Array.isArray(discovery.candidates)
    ? (discovery.candidates as Raw[])
    : [
        ...(Array.isArray(discovery.included) ? (discovery.included as Raw[]) : []),
        ...(Array.isArray(discovery.excluded) ? (discovery.excluded as Raw[]) : []),
      ]

  // Prefer the authoritative V3 transaction-evidence path; otherwise the
  // discovery path (defensive classifier — never qualifies).
  const rawEvidence =
    txnEvidence.length > 0
      ? adaptV3Evidence(txnEvidence)
      : adaptDiscoveryEvidence(candidates, subjectAnchor)

  const evidence = dedupeEvidence(rawEvidence)
  const summary = buildSummary(evidence)
  const projection = (payload.decision_projection ?? null) as Raw | null
  const decision = buildDecisionRibbon(projection, summary.qualified)
  const projectionMeta = (payload.projection_meta ?? null) as Raw | null

  return {
    subject,
    evidence,
    summary,
    decision,
    search: {
      radiusMiles: ctx.radiusMiles,
      monthsBack: ctx.monthsBack,
      searchMode: str(discovery.search_mode),
      isMarketFallback: Boolean(ev<boolean>(discovery.is_market_fallback)),
    },
    meta: {
      readOnly: projectionMeta?.read_only !== false,
      queryMs: n(payload.queryMs) ?? n(projectionMeta?.queryMs),
      source: 'live',
    },
  }
}
