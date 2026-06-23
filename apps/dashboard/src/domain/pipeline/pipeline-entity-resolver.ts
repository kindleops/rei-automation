import type { UniversalEntityContext } from '../entity-graph/entity-graph.types'
import type { PipelineOpportunity } from './pipeline-opportunity.types'

/** Stable universal identity for a pipeline opportunity — single resolver for all views. */
export interface PipelineEntityIdentity {
  opportunityId: string
  threadKey: string | null
  masterOwnerId: string | null
  prospectId: string | null
  propertyId: string | null
  propertyAddress: string | null
  phoneId: string | null
  workflowEnrollmentId: string | null
  queueRowId: string | null
  campaignTargetId: string | null
  dealIntelligenceKey: string | null
  compIntelligenceKey: string | null
  buyerMatchKey: string | null
  market: string | null
  state: string | null
  propertyType: string | null
  assetClass: string | null
}

const text = (v: unknown): string | null => {
  const s = String(v ?? '').trim()
  return s || null
}

const textField = (v: unknown): string | undefined => text(v) ?? undefined

export function resolvePipelineEntityIdentity(
  opp: PipelineOpportunity | null | undefined,
): PipelineEntityIdentity | null {
  if (!opp?.id) return null
  const meta = opp.metadata && typeof opp.metadata === 'object' ? opp.metadata : {}
  const propertyId = text(opp.primary_property_id)
  const threadKey = text(opp.primary_thread_key)
  const masterOwnerId = text(opp.master_owner_id)
  return {
    opportunityId: opp.id,
    threadKey,
    masterOwnerId,
    prospectId: text(opp.prospect_id ?? meta.prospect_id),
    propertyId,
    propertyAddress: text(opp.property_address_full),
    phoneId: text(opp.primary_phone_id ?? meta.phone_id ?? meta.primary_phone_id),
    workflowEnrollmentId: text(opp.workflow_enrollment_id),
    queueRowId: text(opp.latest_queue_id ?? meta.queue_id ?? meta.latest_queue_id),
    campaignTargetId: text(opp.campaign_target_id ?? meta.campaign_target_id),
    dealIntelligenceKey: propertyId || threadKey || opp.id,
    compIntelligenceKey: propertyId,
    buyerMatchKey: propertyId,
    market: text(opp.market),
    state: text(opp.property_state ?? meta.property_state),
    propertyType: text(opp.property_type ?? meta.property_type),
    assetClass: text(opp.asset_class ?? meta.asset_class),
  }
}

export function universalContextFromPipelineIdentity(
  identity: PipelineEntityIdentity,
): UniversalEntityContext {
  return {
    entityType: identity.propertyId ? 'property' : identity.masterOwnerId ? 'master_owner' : null,
    entityId: identity.propertyId || identity.masterOwnerId || identity.opportunityId,
    propertyId: identity.propertyId,
    masterOwnerId: identity.masterOwnerId,
    prospectId: identity.prospectId,
    contactMethodType: identity.phoneId || identity.threadKey ? 'phone' : null,
    contactMethodId: identity.phoneId || identity.threadKey,
    threadKey: identity.threadKey,
    opportunityId: identity.opportunityId,
  }
}

export function resolvePipelineEntityIdentityFromContext(
  ctx: UniversalEntityContext,
): Partial<PipelineEntityIdentity> {
  return {
    opportunityId: textField(ctx.opportunityId),
    threadKey: textField(ctx.threadKey),
    propertyId: textField(ctx.propertyId),
    masterOwnerId: textField(ctx.masterOwnerId),
    prospectId: textField(ctx.prospectId),
    phoneId: textField(ctx.contactMethodId),
  }
}