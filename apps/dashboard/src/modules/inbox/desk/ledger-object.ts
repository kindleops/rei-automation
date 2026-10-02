import { propertyObject, sellerObject, type ObjectRef } from '../../desktop/objects'

/** An Inbox ledger row as its canonical object (8.2 §2): the seller's thread (property as a hint), or the property alone. */
export function ledgerRowObject(m: { threadKey: string | null; propertyId: string | null; street?: string | null; name?: string | null }): ObjectRef | null {
  if (m.threadKey) return sellerObject({ threadKey: m.threadKey, propertyId: m.propertyId, propertyLabel: m.street ?? null, label: m.name ?? null, source: 'inbox' })
  return m.propertyId ? propertyObject({ propertyId: m.propertyId, label: m.street ?? null, source: 'inbox' }) : null
}
