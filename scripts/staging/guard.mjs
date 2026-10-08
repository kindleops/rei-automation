/**
 * Staging guard — positive identity + production denylist. Fails closed.
 *
 *   import { assertStaging } from './guard.mjs'; await assertStaging({ url, serviceKey })
 *   node scripts/staging/guard.mjs <env-file>      (CLI: exit 0 only on staging)
 *
 * 1. The URL host must be <ref>.supabase.co with ref on the staging allowlist
 *    and NOT on the production denylist (a string check alone is not enough…)
 * 2. …so the database must also answer public.staging_identity() — a function
 *    that exists only on the staging branch — with the same ref, environment
 *    'staging' and no production fingerprint. Production has no such
 *    function; any error, timeout or mismatch is a refusal.
 */
import { readFileSync } from 'node:fs'

export const STAGING_REFS = Object.freeze(['eiawfeddmmwwavzlfwia'])
export const PRODUCTION_REFS = Object.freeze(['lcppdrmrdfblstpcbgpf'])

export class StagingGuardError extends Error {}

export async function assertStaging({ url, serviceKey, fetchImpl = fetch } = {}) {
  let host
  try { host = new URL(String(url)).host } catch { throw new StagingGuardError('REFUSED: invalid Supabase URL') }
  const ref = host.endsWith('.supabase.co') ? host.split('.')[0] : null
  if (!ref) throw new StagingGuardError(`REFUSED: ${host} is not a Supabase project host`)
  if (PRODUCTION_REFS.includes(ref) || PRODUCTION_REFS.some((p) => String(url).includes(p) || String(serviceKey).includes(p))) throw new StagingGuardError('REFUSED: production project')
  if (!STAGING_REFS.includes(ref)) throw new StagingGuardError(`REFUSED: ${ref} is not an approved staging ref`)
  if (!serviceKey) throw new StagingGuardError('REFUSED: no staging service key')
  let rows
  try {
    const res = await fetchImpl(`https://${host}/rest/v1/rpc/staging_identity`, { method: 'POST', headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(String(res.status))
    rows = await res.json()
  } catch (e) {
    throw new StagingGuardError(`REFUSED: database did not prove staging identity (${e.message})`)
  }
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row || row.project_ref !== ref || row.environment !== 'staging' || row.production_fingerprint !== false) throw new StagingGuardError('REFUSED: staging identity mismatch')
  return { ref, claimed_at: row.claimed_at }
}

export function readEnvFile(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = readEnvFile(process.argv[2] || 'apps/api/.env.scheduling-staging.local')
  assertStaging({ url: env.STAGING_SUPABASE_URL, serviceKey: env.STAGING_SUPABASE_SERVICE_ROLE_KEY })
    .then((r) => { console.log(`STAGING VERIFIED: ${r.ref} (claimed ${r.claimed_at})`) })
    .catch((e) => { console.error(e.message); process.exit(2) })
}
