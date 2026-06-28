import type { DealContext } from '../../../lib/data/dealContext'
import { resolveCoordinatesFromContext } from '../../../domain/comp-intelligence/coordinate-resolver'
import type { BuyerMatchSubjectContext } from './buyer-match-v4.types'

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(String(value).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : null
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s || null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Build canonical Buyer Match subject context from universal deal context.
 * Does not derive identity from visible address text alone — uses property_id and dossier fields.
 */
export function buildBuyerMatchSubjectContext(
  dealContext: DealContext | null | undefined,
  overrides: Partial<BuyerMatchSubjectContext> = {},
): BuyerMatchSubjectContext {
  const ctx = dealContext ?? ({} as DealContext)
  const property = record(ctx.property)
  const acquisition = record(ctx.acquisition_decision ?? ctx.acquisitionDecision)
  const valuation = record(ctx.valuation)
  const v3Value = record(acquisition.value_contract ?? valuation.value_contract)
  const buyerExit = record(
    v3Value.qualified_buyer_exit ??
      v3Value.scenario_buyer_exit ??
      acquisition.buyer_exit ??
      acquisition.qualified_buyer_exit,
  )
  const marketValueBlock = record(v3Value.qualified_market_value ?? v3Value.scenario_market_value)

  const coords = resolveCoordinatesFromContext({
    dealContext: ctx as Record<string, unknown>,
    property,
    propertyRecord: property,
  })

  const propertyId = str(overrides.propertyId ?? ctx.propertyId ?? ctx.property_id ?? property.property_id)
  const canonicalAddress =
    overrides.canonicalAddress ??
    str(ctx.propertyAddress) ??
    str(property.property_address_full) ??
    str(property.property_address) ??
    'Property address unavailable'

  const assetLane =
    overrides.assetLane ??
    str(acquisition.canonical_asset_lane) ??
    str(property.normalized_asset_class) ??
    str(property.asset_class) ??
    str(ctx.property_type)

  const engineVersion =
    str(acquisition.engine_version) ??
    str(acquisition.version) ??
    (acquisition.canonical_asset_lane ? 'acquisition_decision_engine_v3' : null)

  const risksRaw = acquisition.major_buyer_facing_risks ?? acquisition.buyer_facing_risks
  const majorBuyerFacingRisks = Array.isArray(risksRaw)
    ? risksRaw.map(String).filter(Boolean)
    : undefined

  return {
    propertyId,
    opportunityId: str(overrides.opportunityId ?? ctx.opportunityId ?? ctx.opportunity_id),
    threadKey: str(overrides.threadKey ?? ctx.threadKey ?? ctx.thread_key),
    canonicalAddress,
    latitude: overrides.latitude ?? coords.latitude,
    longitude: overrides.longitude ?? coords.longitude,
    assetLane,
    propertySubtype: str(overrides.propertySubtype ?? property.property_subtype ?? property.property_type ?? ctx.property_type),
    units: num(overrides.units ?? property.units_count ?? property.units),
    buildingSquareFeet: num(
      overrides.buildingSquareFeet ??
        ctx.building_square_feet ??
        ctx.square_feet ??
        property.building_square_feet,
    ),
    lotSquareFeet: num(overrides.lotSquareFeet ?? property.lot_square_feet),
    yearBuilt: num(overrides.yearBuilt ?? property.year_built),
    acquisitionDecisionVersion: str(overrides.acquisitionDecisionVersion ?? engineVersion),
    marketValue: num(
      overrides.marketValue ??
        marketValueBlock.mid ??
        valuation.qualified_market_value_mid ??
        ctx.estimatedValue ??
        ctx.estimated_value,
    ),
    buyerExitLow: num(overrides.buyerExitLow ?? buyerExit.conservative ?? buyerExit.low),
    buyerExitBase: num(overrides.buyerExitBase ?? buyerExit.base ?? buyerExit.mid),
    buyerExitHigh: num(overrides.buyerExitHigh ?? buyerExit.optimistic ?? buyerExit.high),
    strategy: str(overrides.strategy ?? acquisition.strategy ?? acquisition.basis_strategy),
    repairEstimate: num(
      overrides.repairEstimate ??
        ctx.estimatedRepairCost ??
        ctx.estimated_repair_cost ??
        valuation.repair_estimate ??
        property.estimated_repair_cost,
    ),
    executionState: str(overrides.executionState ?? acquisition.execution_state),
    majorBuyerFacingRisks,
    valuationSnapshotId: str(
      overrides.valuationSnapshotId ??
        valuation.valuation_snapshot_id ??
        acquisition.valuation_snapshot_id,
    ),
  }
}

export function subjectContextKey(subject: BuyerMatchSubjectContext): string {
  return subject.propertyId ?? subject.threadKey ?? subject.canonicalAddress
}