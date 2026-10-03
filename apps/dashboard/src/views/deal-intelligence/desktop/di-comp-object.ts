import { propertyObject, type ObjectRef } from '../../../modules/desktop/objects'
import type { DiComp } from './di-types'

/**
 * A Deal Intelligence evidence comp as its property object. canonicalProperty ===
 * false (one batched existence read per decision) marks a recorded sale only: the
 * registry then offers Inspect + Show on Map and no Open / Open beside that would 404.
 * Canonical and unknown comps are ordinary properties.
 */
export const diCompObject = (x: DiComp): ObjectRef | null =>
  x.propertyId
    ? propertyObject({ propertyId: x.propertyId, label: x.address, source: 'deal-intelligence', lat: x.lat ?? null, lng: x.lng ?? null, canonical: x.canonicalProperty === false ? false : null })
    : null
