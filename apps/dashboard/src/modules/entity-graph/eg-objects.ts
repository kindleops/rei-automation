import { companyObject, propertyObject, sellerObject, type ObjectRef } from '../desktop/objects'

/**
 * An Entity Graph node / result as a canonical object (8.2 §2) — only for the
 * types the shell's object registry knows (property, company, seller thread).
 * Owners, people, phones and markets stay Entity Graph's own selections.
 */
export function egObject(type: string | null | undefined, id: string | null | undefined, label?: string | null): ObjectRef | null {
  if (!type || !id) return null
  switch (type) {
    case 'property': return propertyObject({ propertyId: id, label: label ?? null, source: 'entity-graph' })
    case 'organization':
    case 'ownership_entity': return companyObject({ organizationId: id, label: label ?? null, source: 'entity-graph' })
    case 'thread': return sellerObject({ threadKey: id, label: label ?? null, source: 'entity-graph' })
    default: return null
  }
}
