import type { EntityGraphTab, EntitySearchResult, UniversalEntityContext } from './entity-graph.types'
import { universalContextFromSearchResult } from './universal-entity-context'

export type SelectedEntityType =
  | 'property'
  | 'master_owner'
  | 'person'
  | 'ownership_entity'
  | 'phone'
  | 'email'
  | 'market'
  | 'zip'
  | 'thread'
  | null

export type SelectedEntity = {
  type: SelectedEntityType
  id: string | null
}

export const EMPTY_SELECTED_ENTITY: SelectedEntity = { type: null, id: null }

const RESULT_TYPE_MAP: Record<string, SelectedEntityType> = {
  property: 'property',
  master_owner: 'master_owner',
  prospect: 'person',
  organization: 'ownership_entity',
  phone: 'phone',
  email: 'email',
  market: 'market',
  zip: 'zip',
  thread: 'thread',
}

const TAB_ENTITY_TYPES: Record<EntityGraphTab, SelectedEntityType[]> = {
  properties: ['property'],
  master_owners: ['master_owner'],
  people: ['person'],
  organizations: ['ownership_entity'],
  contact_methods: ['phone', 'email'],
  markets: ['market'],
  zips: ['zip'],
}

export function selectedEntityFromResult(result: EntitySearchResult): SelectedEntity {
  return {
    type: RESULT_TYPE_MAP[result.entityType] ?? null,
    id: result.entityId,
  }
}

export function selectedEntityFromGraphNode(nodeType: string, entityId: string): SelectedEntity {
  const normalized = nodeType === 'prospect' ? 'person' : nodeType === 'organization' ? 'ownership_entity' : nodeType
  return {
    type: (RESULT_TYPE_MAP[nodeType] ?? normalized as SelectedEntityType) || null,
    id: entityId,
  }
}

export function dossierApiType(entity: SelectedEntity): string | null {
  if (!entity.type || !entity.id) return null
  if (entity.type === 'person') return 'prospect'
  if (entity.type === 'ownership_entity') return 'organization'
  return entity.type
}

export function tabAllowsSelectedEntity(tab: EntityGraphTab, entity: SelectedEntity): boolean {
  if (!entity.type || !entity.id) return true
  return TAB_ENTITY_TYPES[tab]?.includes(entity.type) ?? false
}

export function dossierMatchesSelection(
  dossier: { entityType?: string; entityId?: string } | null,
  entity: SelectedEntity,
): boolean {
  if (!dossier || !entity.type || !entity.id) return false
  const apiType = dossierApiType(entity)
  return dossier.entityType === apiType && dossier.entityId === entity.id
}

export function selectionKey(entity: SelectedEntity): string {
  if (!entity.type || !entity.id) return ''
  return `${entity.type}:${entity.id}`
}

export function resultMatchesSelection(result: EntitySearchResult, entity: SelectedEntity): boolean {
  if (!entity.type || !entity.id) return false
  return selectionKey(selectedEntityFromResult(result)) === selectionKey(entity)
}

export function selectedEntityFromUniversalContext(context: UniversalEntityContext): SelectedEntity {
  if (context.entityType === 'property') {
    const id = context.propertyId || context.entityId
    return id ? { type: 'property', id } : EMPTY_SELECTED_ENTITY
  }
  if (context.entityType === 'master_owner') {
    const id = context.masterOwnerId || context.entityId
    return id ? { type: 'master_owner', id } : EMPTY_SELECTED_ENTITY
  }
  if (context.entityType === 'prospect') {
    const id = context.prospectId || context.entityId
    return id ? { type: 'person', id } : EMPTY_SELECTED_ENTITY
  }
  if (context.entityType === 'organization') {
    const id = context.masterOwnerId || context.entityId
    return id ? { type: 'ownership_entity', id } : EMPTY_SELECTED_ENTITY
  }
  if (context.entityType === 'phone' || context.entityType === 'email') {
    const id = context.contactMethodId || context.entityId
    return id ? { type: context.entityType, id } : EMPTY_SELECTED_ENTITY
  }
  if (context.entityType === 'market') {
    const id = context.entityId
    return id ? { type: 'market', id } : EMPTY_SELECTED_ENTITY
  }
  if (context.entityType === 'zip') {
    const id = context.entityId
    return id ? { type: 'zip', id } : EMPTY_SELECTED_ENTITY
  }
  if (context.threadKey) {
    return { type: 'thread', id: context.threadKey }
  }
  if (context.propertyId) {
    return { type: 'property', id: context.propertyId }
  }
  if (context.masterOwnerId) {
    return { type: 'master_owner', id: context.masterOwnerId }
  }
  if (context.prospectId) {
    return { type: 'person', id: context.prospectId }
  }
  return EMPTY_SELECTED_ENTITY
}

export function universalContextMatchesSelection(
  context: UniversalEntityContext,
  entity: SelectedEntity,
): boolean {
  const fromContext = selectedEntityFromUniversalContext(context)
  if (!fromContext.type || !fromContext.id) return !entity.type && !entity.id
  return selectionKey(fromContext) === selectionKey(entity)
}

export function selectedEntityToContext(
  entity: SelectedEntity,
  result?: EntitySearchResult | null,
): UniversalEntityContext {
  if (!entity.type || !entity.id) {
    return {
      entityType: null,
      entityId: null,
      propertyId: null,
      masterOwnerId: null,
      prospectId: null,
      contactMethodType: null,
      contactMethodId: null,
      threadKey: null,
      opportunityId: null,
    }
  }
  if (result) return universalContextFromSearchResult(result)
  const apiType = dossierApiType(entity)
  const patch: UniversalEntityContext = {
    entityType: (apiType === 'prospect' ? 'prospect' : apiType === 'organization' ? 'organization' : entity.type) as UniversalEntityContext['entityType'],
    entityId: entity.id,
    propertyId: entity.type === 'property' ? entity.id : null,
    masterOwnerId: entity.type === 'master_owner' ? entity.id : null,
    prospectId: entity.type === 'person' ? entity.id : null,
    contactMethodType: entity.type === 'phone' || entity.type === 'email' ? entity.type : null,
    contactMethodId: entity.type === 'phone' || entity.type === 'email' ? entity.id : null,
    threadKey: entity.type === 'thread' ? entity.id : null,
    opportunityId: null,
  }
  return patch
}

export function inspectorEntityLabel(entity: SelectedEntity): string {
  if (!entity.type) return 'record'
  if (entity.type === 'person') return 'person'
  if (entity.type === 'ownership_entity') return 'ownership entity'
  return entity.type.replace(/_/g, ' ')
}