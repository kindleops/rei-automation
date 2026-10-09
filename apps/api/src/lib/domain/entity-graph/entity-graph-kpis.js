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
import { excludeTestOwners, excludeTestProperties } from './entity-graph-truth.js'

const TTL_MS = 10 * 60_000
let cached = null

export const ENTITY_GRAPH_KPI_DEFINITIONS = Object.freeze({
  properties: 'Every property record in the universe (internal canary fixtures excluded).',
  linkedProperties: 'Properties linked to a resolved master owner (properties.master_owner_id).',
  owners: 'Resolved master owners.',
  portfolioOwners: 'Owners holding two or more properties (master_owners.property_count ≥ 2).',
  entities: 'Title-holding entities and names (sub_owners): LLCs, trusts, estates, individuals.',
  ownersWithPhone: 'Owners with a ranked best phone on file (master_owners.best_phone_1). Send eligibility is decided at send.',
})

async function exactCount(supabase, table, column, apply = (q) => q) {
  // one retry: these are 2.5–4.2 s exact counts (measured 2026-10-08) that can
  // hit the role's statement timeout under load
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { count, error } = await apply(supabase.from(table).select(column, { count: 'exact', head: true }))
      if (!error && typeof count === 'number') return count
    } catch { /* retry once */ }
  }
  return null
}

/**
 * "Portfolio stacks: Not available" flickered (owner, 2026-10-08): one count
 * timing out came back null and the WHOLE payload — null included — was
 * cached for 10 minutes. Now a null never replaces a value measured within
 * STALE_MS (the tile shows the last good count, said so by measuredAt per
 * field), and a payload with a null is not cached, so the next read retries.
 */
const STALE_MS = 6 * 60 * 60_000
const lastGood = new Map()

export async function getEntityGraphKpis(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const now = deps.now ?? Date.now()
  const memo = deps.lastGood || (deps.supabase ? new Map() : lastGood)
  if (!deps.supabase && cached && now - cached.at < TTL_MS) return cached.data
  const keys = ['properties', 'linkedProperties', 'owners', 'portfolioOwners', 'entities', 'ownersWithPhone']
  const fresh = await Promise.all([
    // Internal canary fixtures are not the universe (entity-graph-truth.js).
    exactCount(supabase, 'properties', 'property_id', (q) => excludeTestProperties(q)),
    exactCount(supabase, 'properties', 'property_id', (q) => excludeTestProperties(q).not('master_owner_id', 'is', null)),
    exactCount(supabase, 'master_owners', 'master_owner_id', (q) => excludeTestOwners(q)),
    exactCount(supabase, 'master_owners', 'master_owner_id', (q) => excludeTestOwners(q).gte('property_count', 2)),
    exactCount(supabase, 'sub_owners', 'sub_owner_id'),
    exactCount(supabase, 'master_owners', 'master_owner_id', (q) => excludeTestOwners(q).not('best_phone_1', 'is', null)),
  ])
  const data = { definitions: ENTITY_GRAPH_KPI_DEFINITIONS, measuredAt: new Date(now).toISOString(), stale: {} }
  let complete = true
  keys.forEach((k, i) => {
    if (fresh[i] !== null) { data[k] = fresh[i]; memo.set(k, { value: fresh[i], at: now }); return }
    const prev = memo.get(k)
    if (prev && now - prev.at < STALE_MS) { data[k] = prev.value; data.stale[k] = new Date(prev.at).toISOString() } else data[k] = null
    complete = false
  })
  if (!deps.supabase && complete) cached = { at: now, data }
  return data
}
