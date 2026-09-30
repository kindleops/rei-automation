/**
 * WORLD PROVIDER RUNTIME — one registry mirror, one heartbeat, one lease,
 * one backoff and one run ledger for every Living Map source: camera networks,
 * public-safety feeds, weather alerts.
 *
 * Each domain keeps its own canonical model and tables; this runtime owns only
 * the mechanics that must behave identically everywhere:
 *   · a provider refreshes on ITS cadence, never "every provider every minute"
 *   · one refresher at a time (a lease), so overlapping schedules can't race
 *   · a failure backs off (5, 10, 20 … min, capped) and never deletes data
 *   · every attempt leaves a ledger row and a heartbeat, so a source that
 *     silently stops is visible without waiting for someone to notice
 */

const MIN = 60_000
const LEASE_SEC = 240

/** Enabled = verified by default, not switched off by env, keyed only when the key is installed. */
export function effectiveProvider(p, env = process.env) {
  const list = (k) => String(env[k] || '').split(',').map((s) => s.trim()).filter(Boolean)
  const off = list('WORLD_PROVIDERS_DISABLED').concat(list('CAMERA_PROVIDERS_DISABLED'))
  const on = list('WORLD_PROVIDERS_ENABLED').concat(list('CAMERA_PROVIDERS_ENABLED'))
  const keyConfigured = !p.requires_api_key || Boolean(String(env[p.api_key_env] || '').trim())
  const wanted = (p.enabled_by_default || on.includes(p.provider_id)) && !off.includes(p.provider_id)
  let disabled_reason = null
  if (!wanted) disabled_reason = off.includes(p.provider_id) ? 'disabled_by_operator' : 'not_enabled'
  else if (!keyConfigured) disabled_reason = 'api_key_not_configured'
  return { ...p, enabled: wanted && keyConfigured, key_configured: keyConfigured, disabled_reason }
}

/** Backoff after n consecutive failures: 5, 10, 20, 40 … min, capped at 6 h. */
export function backoffMs(failures, intervalSec) {
  const step = Math.min(6 * 60 * MIN, 5 * MIN * 2 ** Math.max(0, failures - 1))
  return Math.min(step, Math.max(5 * MIN, intervalSec * 1000 * 4))
}

/** Registry facts mirrored into map_world_providers so health can join real rows. */
export function mirrorRow(p, nowIso) {
  return {
    provider_id: p.provider_id,
    domain: p.domain,
    name: p.name,
    jurisdiction: p.jurisdiction || null,
    state: p.state || null,
    region: p.region || null,
    provider_type: p.provider_type,
    adapter_type: p.adapter_type,
    coverage_status: p.coverage_status,
    enabled: Boolean(p.enabled),
    requires_api_key: Boolean(p.requires_api_key),
    attribution: p.attribution,
    terms_url: p.terms_url || null,
    image_policy: p.image_policy || null,
    refresh_interval_sec: p.refresh_interval_sec,
    source_cadence_sec: p.source_cadence_sec ?? p.snapshot_cadence_sec ?? null,
    updated_at: nowIso,
  }
}

export async function mirrorProviders(db, providers, nowIso) {
  if (!providers.length) return { ok: true }
  const { error } = await db.from('map_world_providers').upsert(providers.map((p) => mirrorRow(p, nowIso)), { onConflict: 'provider_id' })
  return error ? { ok: false, error: error.message } : { ok: true }
}

const HEALTH_COLS = 'provider_id, domain, health_state, item_count, stats, last_success_at, last_failure_at, failure_reason, consecutive_failures, next_refresh_at, last_latency_ms, last_attempt_at'

/** provider_id → heartbeat row for one domain; null when the table can't be read. */
export async function readProviderHealth(db, domain) {
  const { data, error } = await db.from('map_world_providers').select(HEALTH_COLS).eq('domain', domain)
  if (error) return null
  return Object.fromEntries((data || []).map((r) => [r.provider_id, r]))
}

/** Take the refresh lease for one provider (single UPDATE; loses cleanly to a live lease). */
export async function claimLease(db, providerId, owner, nowIso, leaseSec = LEASE_SEC) {
  const until = new Date(Date.parse(nowIso) + leaseSec * 1000).toISOString()
  const { data, error } = await db.from('map_world_providers')
    .update({ lease_owner: owner, lease_until: until, last_attempt_at: nowIso })
    .eq('provider_id', providerId)
    .or(`lease_until.is.null,lease_until.lt."${nowIso}"`)
    .select('provider_id')
  return !error && Array.isArray(data) && data.length === 1
}

export async function startRun(db, provider, startedIso) {
  const { data } = await db.from('map_world_provider_runs').insert({ provider_id: provider.provider_id, domain: provider.domain, started_at: startedIso }).select('id').maybeSingle()
  const t0 = Date.now()
  return async (patch) => {
    if (!data?.id) return
    await db.from('map_world_provider_runs').update({ finished_at: new Date().toISOString(), latency_ms: Date.now() - t0, ...patch }).eq('id', data.id)
  }
}

export async function markSuccess(db, provider, { now, itemCount, stats = {}, healthState = 'healthy', latencyMs }) {
  await db.from('map_world_providers').update({
    health_state: healthState,
    last_success_at: new Date(now).toISOString(),
    failure_reason: null,
    consecutive_failures: 0,
    next_refresh_at: new Date(now + provider.refresh_interval_sec * 1000).toISOString(),
    item_count: itemCount,
    stats,
    last_latency_ms: latencyMs,
    lease_owner: null,
    lease_until: null,
    updated_at: new Date().toISOString(),
  }).eq('provider_id', provider.provider_id)
}

export async function markFailure(db, provider, prev, { now, reason, latencyMs }) {
  const failures = (prev?.consecutive_failures || 0) + 1
  await db.from('map_world_providers').update({
    health_state: 'failing',
    last_failure_at: new Date(now).toISOString(),
    failure_reason: reason,
    consecutive_failures: failures,
    next_refresh_at: new Date(now + backoffMs(failures, provider.refresh_interval_sec)).toISOString(),
    last_latency_ms: latencyMs,
    lease_owner: null,
    lease_until: null,
    updated_at: new Date().toISOString(),
  }).eq('provider_id', provider.provider_id)
  return failures
}

/**
 * Refresh every enabled, due provider of one domain. One provider failing
 * never stops the others. `refreshOne(provider, adapter, prevHealth)` does the
 * domain work and returns a result; this wrapper owns leases and ordering.
 */
export async function runDueProviders({ db, domain, providers, adapters, now, owner, force = false, providerIds = null, budgetMs = 100_000, refreshOne }) {
  const started = Date.now()
  const nowIso = new Date(now).toISOString()
  const scoped = providers.filter((p) => !providerIds || providerIds.includes(p.provider_id))
  const mirrored = await mirrorProviders(db, scoped, nowIso)
  if (!mirrored.ok) return { ok: false, error: 'provider_mirror_failed', message: mirrored.error }
  const health = (await readProviderHealth(db, domain)) || {}
  const results = []
  for (const p of scoped) {
    if (!p.enabled) { results.push({ provider_id: p.provider_id, skipped: p.disabled_reason }); continue }
    const nextAt = health[p.provider_id]?.next_refresh_at
    if (!force && nextAt && Date.parse(nextAt) > now) { results.push({ provider_id: p.provider_id, skipped: 'not_due' }); continue }
    if (Date.now() - started > budgetMs) { results.push({ provider_id: p.provider_id, skipped: 'budget_exhausted' }); continue }
    const adapter = adapters[p.adapter_type]
    if (!adapter) { results.push({ provider_id: p.provider_id, skipped: 'adapter_missing' }); continue }
    if (!(await claimLease(db, p.provider_id, owner, nowIso))) { results.push({ provider_id: p.provider_id, skipped: 'leased' }); continue }
    results.push(await refreshOne(p, adapter, health[p.provider_id] || {}))
  }
  return { ok: true, domain, at: nowIso, results, elapsed_ms: Date.now() - started }
}
