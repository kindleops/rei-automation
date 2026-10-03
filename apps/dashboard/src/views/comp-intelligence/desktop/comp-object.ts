import { propertyObject, type ObjectRef } from '../../../modules/desktop/objects'
import type { EvidenceComp } from '../../../domain/comp-intelligence/comps-evidence-api'

/**
 * A comparable sale as its canonical property (8.2 §2). Identity is the
 * comp's property_id; a comp without one is a local evidence row only (it can
 * still be framed in a set by its recorded coordinates, never selected).
 */
export function compObject(c: EvidenceComp): ObjectRef | null {
  if (!c.propertyId) return null
  // canonicalProperty === false: a parcel that was sold but never entered the property
  // universe — Inspect shows its recorded sale; no property surface can open it.
  return propertyObject({ propertyId: c.propertyId, label: c.address ?? null, source: 'comp-intelligence', lat: c.lat ?? null, lng: c.lng ?? null, canonical: c.canonicalProperty === false ? false : null })
}
