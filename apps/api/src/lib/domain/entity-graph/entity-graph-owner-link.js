/**
 * ENTITY GRAPH · WHO OWNS A PROPERTY, WHO IS LINKED TO IT (owner, 2026-10-08:
 * "MANY FIELDS ARE BLANK, including prospect info and prospect fields").
 *
 * ROOT CAUSE: every owner / person read keyed on properties.master_owner_id,
 * and that column is set on only ~23% of properties (KPI: 41,533 of 176,610).
 * The link is NOT missing — it lives on the other side:
 *   - prospects.linked_property_ids_json (GIN idx_prospects_linked_property_ids_json_gin)
 *     names the properties a person is linked to, with their master_owner_id;
 *   - master_owners.joined_property_ids_json confirms it (measured
 *     2026-10-08: of 35 unlinked properties resolved through a prospect, 35 are
 *     in that owner's joined_property_ids_json; one owner per property).
 * Measured on 120 random properties: master_owner_id 20%; a prospect linked
 * by property 57.5%; an owner reachable through those prospects for 48 of the
 * 96 unlinked ones.
 *
 * Read-only, keyed: `or(linked_property_ids_json.cs.["<id>"], …)` in chunks
 * (one GIN probe per id; 40 ids ≈ 160 ms in prod).
 */
const CHUNK = 40
const clean = (v) => String(v ?? '').trim()
const ids = (v) => (Array.isArray(v) ? v : []).map(clean).filter(Boolean)

/** Prospects linked to each property by linked_property_ids_json: Map(property_id → prospect rows). */
export async function prospectsLinkedToProperties(client, propertyIds, select = 'prospect_id, master_owner_id') {
  const want = [...new Set(ids(propertyIds))].filter((id) => /^[A-Za-z0-9_-]+$/.test(id))
  const out = new Map()
  const cols = [...new Set(['prospect_id', 'master_owner_id', 'linked_property_ids_json', ...select.split(',').map(clean).filter(Boolean)])].join(',')
  for (let i = 0; i < want.length; i += CHUNK) {
    const part = want.slice(i, i + CHUNK)
    const { data, error } = await client.from('prospects').select(cols).or(part.map((id) => `linked_property_ids_json.cs.["${id}"]`).join(',')).limit(part.length * 12)
    if (error) throw error
    const inPart = new Set(part)
    for (const row of data || []) {
      for (const pid of ids(row.linked_property_ids_json)) {
        if (!inPart.has(pid)) continue
        if (!out.has(pid)) out.set(pid, [])
        out.get(pid).push(row)
      }
    }
  }
  return out
}

/**
 * The master owner of each property: properties.master_owner_id when set,
 * else the ONE master owner its linked prospects share (two different owners
 * = ambiguous = no link). Map(property_id → { ownerId, basis }).
 */
export async function resolvePropertyOwners(client, rows, { linked = null } = {}) {
  const out = new Map()
  const missing = []
  for (const r of rows || []) {
    const pid = clean(r.property_id)
    if (!pid) continue
    const oid = clean(r.master_owner_id)
    if (oid) out.set(pid, { ownerId: oid, basis: 'property' })
    else missing.push(pid)
  }
  if (!missing.length) return out
  const byProp = linked || await prospectsLinkedToProperties(client, missing)
  for (const pid of missing) {
    const owners = new Set((byProp.get(pid) || []).map((p) => clean(p.master_owner_id)).filter(Boolean))
    if (owners.size === 1) out.set(pid, { ownerId: [...owners][0], basis: 'prospect_link' })
  }
  return out
}

/** The person to show for a property among its linked prospects: primary, then best rank. */
export function primaryLinkedProspect(rows) {
  const list = [...(rows || [])]
  if (!list.length) return null
  const rank = (p) => (Number.isFinite(Number(p.rank_position)) && p.rank_position !== null ? Number(p.rank_position) : 999)
  return list.sort((a, b) => (b.is_primary_prospect === true) - (a.is_primary_prospect === true) || rank(a) - rank(b))[0]
}
