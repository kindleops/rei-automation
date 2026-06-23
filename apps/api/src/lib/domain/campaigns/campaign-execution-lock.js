/**
 * Campaign execution lock (Phase 2B).
 *
 * A persisted, TTL'd lease that prevents two activation/hydration workers from
 * writing send_queue rows for the same campaign at the same time. Backed by the
 * Postgres `campaign_acquire/renew/release_execution_lock` functions (advisory
 * locked). Degrades safely when the functions are not yet deployed: acquisition
 * reports a non-enforced lease so behavior matches the legacy (pre-migration)
 * path rather than blocking all launches.
 *
 * The lock governs WRITE serialization only. Live sending remains gated by the
 * existing flags (auto_send_enabled / confirm_live / *_LIVE_SENDS_ENABLED).
 */

import crypto from 'node:crypto'

export const DEFAULT_EXECUTION_LOCK_TTL_SECONDS = 120

function rpcFunctionMissing(error) {
  if (!error) return false
  const code = error.code || ''
  const msg = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase()
  return (
    code === '42883' ||
    code === 'PGRST202' ||
    msg.includes('could not find the function') ||
    msg.includes('does not exist')
  )
}

export function newExecutionLockToken() {
  return crypto.randomUUID()
}

/**
 * Attempt to acquire the execution lease.
 * @returns {Promise<{ acquired: boolean, enforced: boolean, token: string, owner: string|null, reason?: string }>}
 */
export async function acquireCampaignExecutionLock(supabase, campaignId, options = {}) {
  const token = options.token || newExecutionLockToken()
  const owner = options.owner || `plan:${token.slice(0, 8)}`
  const ttlSeconds = Number(options.ttlSeconds || DEFAULT_EXECUTION_LOCK_TTL_SECONDS)

  const { data, error } = await supabase.rpc('campaign_acquire_execution_lock', {
    p_campaign_id: campaignId,
    p_token: token,
    p_owner: owner,
    p_ttl_seconds: ttlSeconds,
  })

  if (!error) {
    return { acquired: data === true, enforced: true, token, owner }
  }
  if (rpcFunctionMissing(error)) {
    // Pre-migration: lock not enforced. Report acquired so launches are not
    // blocked, but flag that the mutex is not actually protecting the write.
    return { acquired: true, enforced: false, token, owner, reason: 'lock_function_unavailable' }
  }
  return { acquired: false, enforced: true, token, owner, reason: error.message || 'acquire_failed' }
}

/** Renew the lease heartbeat. Best-effort; never throws. */
export async function renewCampaignExecutionLock(supabase, campaignId, token) {
  if (!token) return false
  try {
    const { data, error } = await supabase.rpc('campaign_renew_execution_lock', {
      p_campaign_id: campaignId,
      p_token: token,
    })
    if (error) return rpcFunctionMissing(error) ? true : false
    return data === true
  } catch {
    return false
  }
}

/** Release the lease. Best-effort; never throws. */
export async function releaseCampaignExecutionLock(supabase, campaignId, token) {
  if (!token) return false
  try {
    const { data, error } = await supabase.rpc('campaign_release_execution_lock', {
      p_campaign_id: campaignId,
      p_token: token,
    })
    if (error) return rpcFunctionMissing(error) ? true : false
    return data === true
  } catch {
    return false
  }
}

/**
 * Write a resumable hydration checkpoint onto the campaign. Best-effort and
 * tolerant of the column not existing yet (pre-migration).
 */
export async function checkpointCampaignHydration(supabase, campaignId, cursor) {
  try {
    const { error } = await supabase
      .from('campaigns')
      .update({ hydration_cursor: cursor })
      .eq('id', campaignId)
    if (error && !rpcFunctionMissing(error)) return false
    return true
  } catch {
    return false
  }
}
