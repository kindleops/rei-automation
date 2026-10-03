/**
 * WHICH COMP PROPERTY IDS ARE CANONICAL PROPERTIES.
 *
 * Comps carry the sale corpus's property_id; most of those parcels were sold but
 * never entered `properties`, and every property surface (Deal Intelligence,
 * Comps, Buyer Match) 404s on them. One batched existence read per page — never
 * per row. Returns the set of ids that exist, or null when the read itself
 * failed (unknown must never be reported as "not tracked").
 *
 * Shared by the Comps workspace and the Deal Intelligence decision.
 */
const CANONICAL_CHUNK = 200

const clean = (v) => String(v ?? '').trim()
const arr = (v) => (Array.isArray(v) ? v : [])

export async function canonicalPropertyIds(client, ids) {
  const wanted = [...new Set(arr(ids).map(clean).filter(Boolean))]
  const found = new Set()
  if (!wanted.length) return found
  try {
    for (let i = 0; i < wanted.length; i += CANONICAL_CHUNK) {
      const chunk = wanted.slice(i, i + CANONICAL_CHUNK)
      const { data, error } = await client.from('properties').select('property_id').in('property_id', chunk)
      if (error) return null
      for (const r of arr(data)) if (clean(r.property_id)) found.add(clean(r.property_id))
    }
  } catch {
    return null
  }
  return found
}

/** true / false per id, or null for every id when the check could not run; an absent id is false. */
export function canonicalFlag(found, propertyId) {
  const id = clean(propertyId)
  if (!id) return false
  return found ? found.has(id) : null
}

export default { canonicalPropertyIds, canonicalFlag }
