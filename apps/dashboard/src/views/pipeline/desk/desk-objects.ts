import { dealObject, propertyObject, type ObjectRef } from '../../../modules/desktop/objects'
import type { DeskCard } from './pipeline-desk-api'

type CardLike = Partial<Pick<DeskCard, 'propertyId' | 'threadKey' | 'masterOwnerId' | 'address' | 'seller' | 'stage'>> & { id: string }

/** A Pipeline deal as its canonical object: opportunity id + property / seller / stage (8.2 §2). */
export function deskDealObject(c: CardLike): ObjectRef {
  return dealObject({ opportunityId: c.id, propertyId: c.propertyId ?? null, threadKey: c.threadKey ?? null, masterOwnerId: c.masterOwnerId ?? null, stage: c.stage ?? null, label: c.address || c.seller || null, source: 'pipeline' })
}

/** The deal's property (Show property, Open beside). Callers check propertyId first. */
export function deskPropertyObject(c: CardLike): ObjectRef {
  return propertyObject({ propertyId: c.propertyId ?? '', threadKey: c.threadKey ?? null, opportunityId: c.id, masterOwnerId: c.masterOwnerId ?? null, label: c.address ?? null, source: 'pipeline' })
}
