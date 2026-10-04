/**
 * LEAD VISIBILITY GATE — is the shared Inbox⇄Pipeline archive overlay live?
 *
 * Two conditions, both required:
 *   1. system_control flag `lead_visibility_sync_enabled` is true (missing → false);
 *   2. the schema from PROPOSED_20261005*_lead_visibility.sql exists
 *      (acquisition_opportunities.archived_at… and lead_visibility_actions).
 *
 * WHY THE ORDER MATTERS ("phantom column kills a guard", 2026-09-03): one
 * unknown column fails a whole PostgREST query. Nothing outside this module may
 * name the new columns until this gate says so, and this module only probes
 * them AFTER the flag is on — with the flag off, not a single query touches
 * them. The probe is isolated (`limit(0)`), so a missing column costs a cached
 * "schema_missing", never a caller's query.
 *
 * Cached for 60 s per process; `resetLeadVisibilityGate()` for tests.
 */

export const LEAD_VISIBILITY_FLAG = 'lead_visibility_sync_enabled'
export const OPPORTUNITY_VISIBILITY_COLUMNS = Object.freeze(['archived_at', 'archived_by', 'archive_reason', 'archive_action_id'])
export const VISIBILITY_ACTIONS_TABLE = 'lead_visibility_actions'
const TTL_MS = 60_000

let cache = null

export function resetLeadVisibilityGate() {
  cache = null
}

/**
 * @param {{ supabase: any, getFlag: (key: string) => Promise<boolean>, now?: number }} deps
 * @returns {Promise<{ enabled: boolean, flag: boolean, schemaReady: boolean|null, reason: string }>}
 */
export async function resolveLeadVisibilityGate({ supabase, getFlag, now = Date.now() }) {
  if (cache && now - cache.at < TTL_MS) return cache.value
  let value
  let flag = false
  try {
    flag = (await getFlag(LEAD_VISIBILITY_FLAG)) === true
  } catch {
    flag = false
  }
  if (!flag) {
    value = { enabled: false, flag: false, schemaReady: null, reason: 'flag_off' }
  } else {
    const schemaReady = await probeSchema(supabase)
    value = schemaReady
      ? { enabled: true, flag: true, schemaReady: true, reason: 'enabled' }
      : { enabled: false, flag: true, schemaReady: false, reason: 'schema_missing' }
  }
  cache = { at: now, value }
  return value
}

async function probeSchema(supabase) {
  try {
    const [opps, actions] = await Promise.all([
      supabase.from('acquisition_opportunities').select(OPPORTUNITY_VISIBILITY_COLUMNS.join(',')).limit(0),
      supabase.from(VISIBILITY_ACTIONS_TABLE).select('action_id,thread_key,status').limit(0),
    ])
    return !opps?.error && !actions?.error
  } catch {
    return false
  }
}

/** Production gate: the shared supabase client + system_control. */
export async function getLeadVisibilityGate() {
  const [{ supabase }, { getSystemFlag }] = await Promise.all([
    import('@/lib/supabase/client.js'),
    import('@/lib/system-control.js'),
  ])
  return resolveLeadVisibilityGate({ supabase, getFlag: (key) => getSystemFlag(key) })
}
