import { pushRoutePath, replaceRoutePath } from '../../app/router'
import type { ActiveInboxContext } from '../../modules/inbox/active-context'
import type { EntitySearchResult, UniversalEntityContext, UniversalEntityType } from './entity-graph.types'

export const EMPTY_UNIVERSAL_ENTITY_CONTEXT: UniversalEntityContext = {
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

const ENTITY_URL_PREFIX = '/entity-graph'

export function universalContextFromActiveInbox(active: ActiveInboxContext): UniversalEntityContext {
  return {
    entityType: active.propertyId ? 'property' : active.masterOwnerId || active.sellerId ? 'master_owner' : active.prospectId ? 'prospect' : null,
    entityId: active.propertyId || active.masterOwnerId || active.sellerId || active.prospectId || null,
    propertyId: active.propertyId ?? null,
    masterOwnerId: active.masterOwnerId ?? active.sellerId ?? null,
    prospectId: active.prospectId ?? null,
    contactMethodType: active.toPhoneNumber ? 'phone' : null,
    contactMethodId: null,
    threadKey: active.threadKey ?? null,
    opportunityId: null,
  }
}

export function activeInboxFromUniversalContext(context: UniversalEntityContext, sourceView: ActiveInboxContext['sourceView'] = 'list'): ActiveInboxContext {
  return {
    sellerId: context.masterOwnerId ?? undefined,
    masterOwnerId: context.masterOwnerId ?? undefined,
    propertyId: context.propertyId ?? undefined,
    prospectId: context.prospectId ?? undefined,
    threadKey: context.threadKey ?? undefined,
    toPhoneNumber: context.contactMethodType === 'phone' ? context.contactMethodId ?? undefined : undefined,
    sourceView,
    intent: context.threadKey ? 'open_thread' : context.propertyId ? 'open_seller' : undefined,
  }
}

export function universalContextFromSearchResult(result: EntitySearchResult): UniversalEntityContext {
  const entityType = (result.entityType === 'phone' || result.entityType === 'email'
    ? result.entityType
    : result.entityType) as UniversalEntityType

  return {
    entityType,
    entityId: result.entityId,
    propertyId: result.contextIds.propertyId ?? null,
    masterOwnerId: result.contextIds.masterOwnerId ?? null,
    prospectId: result.contextIds.prospectId ?? null,
    contactMethodType: result.entityType === 'phone' ? 'phone' : result.entityType === 'email' ? 'email' : null,
    contactMethodId: result.contextIds.contactMethodId ?? (result.entityType === 'phone' || result.entityType === 'email' ? result.entityId : null),
    threadKey: result.contextIds.threadKey ?? null,
    opportunityId: null,
  }
}

export function buildEntityGraphDeepLink(context: UniversalEntityContext): string | null {
  if (!context.entityType || !context.entityId) return null

  switch (context.entityType) {
    case 'property':
      return `${ENTITY_URL_PREFIX}/property/${encodeURIComponent(context.entityId)}`
    case 'master_owner':
      return `${ENTITY_URL_PREFIX}/owner/${encodeURIComponent(context.entityId)}`
    case 'prospect':
      return `${ENTITY_URL_PREFIX}/prospect/${encodeURIComponent(context.entityId)}`
    case 'phone':
      return `${ENTITY_URL_PREFIX}/contact/phone/${encodeURIComponent(context.entityId)}`
    case 'email':
      return `${ENTITY_URL_PREFIX}/contact/email/${encodeURIComponent(context.entityId)}`
    case 'organization':
      return `${ENTITY_URL_PREFIX}/organization/${encodeURIComponent(context.entityId)}`
    case 'market':
      return `${ENTITY_URL_PREFIX}/market/${encodeURIComponent(context.entityId)}`
    case 'zip':
      return `${ENTITY_URL_PREFIX}/zip/${encodeURIComponent(context.entityId)}`
    default:
      return null
  }
}

export function parseEntityGraphDeepLink(pathname: string): UniversalEntityContext | null {
  const normalized = pathname.replace(/\/+$/, '')
  const match = normalized.match(/^\/entity-graph\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?/)
  if (!match) return null

  const [, segment, id, subId] = match
  if (segment === 'property' && id) {
    return { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'property', entityId: decodeURIComponent(id), propertyId: decodeURIComponent(id) }
  }
  if (segment === 'owner' && id) {
    return { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'master_owner', entityId: decodeURIComponent(id), masterOwnerId: decodeURIComponent(id) }
  }
  if (segment === 'prospect' && id) {
    return { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'prospect', entityId: decodeURIComponent(id), prospectId: decodeURIComponent(id) }
  }
  if (segment === 'contact' && id && subId) {
    const contactType = id === 'phone' || id === 'email' ? id : null
    if (!contactType) return null
    return {
      ...EMPTY_UNIVERSAL_ENTITY_CONTEXT,
      entityType: contactType,
      entityId: decodeURIComponent(subId),
      contactMethodType: contactType,
      contactMethodId: decodeURIComponent(subId),
    }
  }
  if (segment === 'organization' && id) {
    return { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'organization', entityId: decodeURIComponent(id), masterOwnerId: decodeURIComponent(id) }
  }
  if (segment === 'market' && id) {
    return { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'market', entityId: decodeURIComponent(id) }
  }
  if (segment === 'zip' && id) {
    return { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'zip', entityId: decodeURIComponent(id) }
  }
  return null
}

function preserveSearchParams(path: string): string {
  if (typeof window === 'undefined') return path
  const search = window.location.search
  return search ? `${path}${search}` : path
}

export function syncUniversalContextToUrl(context: UniversalEntityContext, mode: 'push' | 'replace' = 'replace'): void {
  const link = preserveSearchParams(buildEntityGraphDeepLink(context) ?? '/entity-graph')
  if (mode === 'push') pushRoutePath(link)
  else replaceRoutePath(link)
}

export function mergeUniversalContexts(
  current: UniversalEntityContext,
  patch: Partial<UniversalEntityContext>,
): UniversalEntityContext {
  if (patch.entityType && patch.entityId) {
    const next: UniversalEntityContext = {
      ...EMPTY_UNIVERSAL_ENTITY_CONTEXT,
      entityType: patch.entityType,
      entityId: patch.entityId,
      threadKey: patch.threadKey ?? current.threadKey,
      opportunityId: patch.opportunityId ?? current.opportunityId,
    }
    if (patch.entityType === 'property') next.propertyId = patch.entityId
    if (patch.entityType === 'master_owner') next.masterOwnerId = patch.entityId
    if (patch.entityType === 'prospect') next.prospectId = patch.entityId
    if (patch.entityType === 'phone' || patch.entityType === 'email') {
      next.contactMethodType = patch.entityType
      next.contactMethodId = patch.entityId
    }
    if (patch.propertyId) next.propertyId = patch.propertyId
    if (patch.masterOwnerId) next.masterOwnerId = patch.masterOwnerId
    if (patch.prospectId) next.prospectId = patch.prospectId
    return next
  }
  return { ...current, ...patch }
}