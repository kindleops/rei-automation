/**
 * ENTITY GRAPH · HEADER KPIs — six exact counts, each with its definition.
 *
 * Every number is an exact `count` (head request) over the canonical table;
 * one that fails is null ("not available"), never 0 and never an estimate.
 * Measured 2026-10-07 (read-only, prod): properties 176,610 · linked to an
 * owner 41,533 · owners 102,252 · owners with 2+ properties 11,363 · title
 * entities 96,103 · owners with a ranked phone 83,521; each 0.07-1.3 s.
 *
 * "Contactable" states a fact (a ranked phone is on file), not send
 * eligibility: suppression, windows and identity are decided at send time.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

const TTL_MS = 10 * 60_000
let cached = null

export const ENTITY_GRAPH_KPI_DEFINITIONS = Object.freeze({
  properties: 'Every property record in the universe.',
  linkedProperties: 'Properties linked to a resolved master owner (properties.master_owner_id).',
  owners: 'Resolved master owners.',
  portfolioOwners: 'Owners holding two or more properties (master_owners.property_count ≥ 2).',
  entities: 'Title-holding entities and names (sub_owners): LLCs, trusts, estates, individuals.',
  ownersWithPhone: 'Owners with a ranked best phone on file (master_owners.best_phone_1). Send eligibility is decided at send.',
})

async function exactCount(supabase, table, column, apply = (q) => q) {
  try {
    const { count, error } = await apply(supabase.from(table).select(column, { count: 'exact', head: true }))
    if (error) return null
    return typeof count === 'number' ? count : null
  } catch {
    return null
  }
}

export async function getEntityGraphKpis(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const now = deps.now ?? Date.now()
  if (!deps.supabase && cached && now - cached.at < TTL_MS) return cached.data
  const [properties, linkedProperties, owners, portfolioOwners, entities, ownersWithPhone] = await Promise.all([
    exactCount(supabase, 'properties', 'property_id'),
    exactCount(supabase, 'properties', 'property_id', (q) => q.not('master_owner_id', 'is', null)),
    exactCount(supabase, 'master_owners', 'master_owner_id'),
    exactCount(supabase, 'master_owners', 'master_owner_id', (q) => q.gte('property_count', 2)),
    exactCount(supabase, 'sub_owners', 'sub_owner_id'),
    exactCount(supabase, 'master_owners', 'master_owner_id', (q) => q.not('best_phone_1', 'is', null)),
  ])
  const data = {
    properties,
    linkedProperties,
    owners,
    portfolioOwners,
    entities,
    ownersWithPhone,
    definitions: ENTITY_GRAPH_KPI_DEFINITIONS,
    measuredAt: new Date(now).toISOString(),
  }
  if (!deps.supabase) cached = { at: now, data }
  return data
}
