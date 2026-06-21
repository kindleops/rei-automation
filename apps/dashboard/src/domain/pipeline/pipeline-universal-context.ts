import type { ActiveInboxContext } from '../../modules/inbox/active-context'
import { buildContextFromOpportunity } from '../../modules/inbox/active-context'
import type { UniversalEntityContext } from '../entity-graph/entity-graph.types'
import type { PipelineOpportunity } from './pipeline-opportunity.types'
import { resolvePipelineEntityIdentity, universalContextFromPipelineIdentity } from './pipeline-entity-resolver'

export function universalContextFromOpportunity(
  opportunity: PipelineOpportunity | null | undefined,
): UniversalEntityContext {
  const identity = resolvePipelineEntityIdentity(opportunity)
  if (identity) return universalContextFromPipelineIdentity(identity)
  const active = buildContextFromOpportunity(opportunity, 'pipeline')
  return {
    entityType: active.propertyId ? 'property' : active.masterOwnerId ? 'master_owner' : null,
    entityId: active.propertyId || active.masterOwnerId || active.opportunityId || null,
    propertyId: active.propertyId ?? null,
    masterOwnerId: active.masterOwnerId ?? null,
    prospectId: active.prospectId ?? null,
    contactMethodType: active.threadKey ? 'phone' : null,
    contactMethodId: active.threadKey ?? null,
    threadKey: active.threadKey ?? null,
    opportunityId: active.opportunityId ?? opportunity?.id ?? null,
  }
}

export function activeContextFromOpportunity(opportunity: PipelineOpportunity | null | undefined): ActiveInboxContext {
  return buildContextFromOpportunity(opportunity, 'pipeline')
}