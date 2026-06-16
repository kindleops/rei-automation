/**
 * Campaign lifecycle state machine (Phase 2A).
 *
 * Single source of truth for legal campaign status transitions. The canonical,
 * concurrency-safe path is the Postgres `campaign_transition_status` function
 * (advisory-locked, edge-validated). This module mirrors the same edge set in
 * JS so callers can validate cheaply, and so the wrapper can degrade to a
 * guarded direct update when the DB function is not yet deployed.
 *
 * Live SENDING is gated elsewhere (auto_send_enabled / confirm_live /
 * AUTOMATION|WORKFLOW_LIVE_SENDS_ENABLED). This module governs STATE only.
 */

export const CAMPAIGN_STATES = Object.freeze([
  'draft',
  'previewed',
  'scheduled',
  'activating',
  'active',
  'paused',
  'completed',
  'failed',
  'archived',
])

const CAMPAIGN_STATE_SET = new Set(CAMPAIGN_STATES)

/** Terminal states: no outbound edges except archival/cleanup. */
export const TERMINAL_CAMPAIGN_STATES = Object.freeze(new Set(['archived']))

/**
 * Lifecycle states a campaign must be in for queue hydration / send-queue
 * writes to proceed. Legacy readiness values are accepted for backward compat
 * with campaigns saved before the lifecycle migration.
 */
export const QUEUEABLE_CAMPAIGN_STATES = Object.freeze(
  new Set(['scheduled', 'activating', 'active', 'ready', 'live_limited'])
)

/**
 * Legacy status -> lifecycle status. Older rows used readiness markers
 * ('ready'/'live_limited') in the same column; map them onto the lifecycle.
 */
export const LEGACY_STATUS_ALIASES = Object.freeze({
  ready: 'previewed',
  live_limited: 'active',
  started: 'activating',
  live_scheduled: 'scheduled',
})

/** Directed legal edges. Kept in sync with campaign_status_transitions table. */
const TRANSITIONS = Object.freeze({
  draft: ['previewed', 'scheduled', 'archived'],
  previewed: ['scheduled', 'draft', 'archived'],
  scheduled: ['activating', 'draft', 'paused', 'archived'],
  activating: ['active', 'failed', 'paused'],
  active: ['paused', 'completed', 'failed'],
  paused: ['active', 'scheduled', 'completed', 'archived'],
  failed: ['paused', 'activating', 'archived'],
  completed: ['archived'],
  archived: [],
})

export function normalizeCampaignStatus(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value) return 'draft'
  if (CAMPAIGN_STATE_SET.has(value)) return value
  if (LEGACY_STATUS_ALIASES[value]) return LEGACY_STATUS_ALIASES[value]
  return 'draft'
}

export function isQueueableStatus(status) {
  return QUEUEABLE_CAMPAIGN_STATES.has(String(status ?? '').trim().toLowerCase())
}

/** Campaigns that are live/running right now (counts toward "active"). */
export const LIVE_CAMPAIGN_STATES = Object.freeze(
  new Set(['active', 'activating', 'live_limited'])
)

export function isLiveCampaignStatus(status) {
  return LIVE_CAMPAIGN_STATES.has(String(status ?? '').trim().toLowerCase())
}

export function isTransitionAllowed(from, to) {
  const fromState = normalizeCampaignStatus(from)
  const toState = String(to ?? '').trim().toLowerCase()
  if (!CAMPAIGN_STATE_SET.has(toState)) return false
  if (fromState === toState) return true // idempotent no-op
  return (TRANSITIONS[fromState] || []).includes(toState)
}

export function allowedTransitionsFrom(from) {
  return [...(TRANSITIONS[normalizeCampaignStatus(from)] || [])]
}

export class CampaignTransitionError extends Error {
  constructor(message, { from, to, code } = {}) {
    super(message)
    this.name = 'CampaignTransitionError'
    this.from = from
    this.to = to
    this.code = code || 'illegal_campaign_transition'
  }
}

function rpcFunctionMissing(error) {
  if (!error) return false
  const code = error.code || ''
  const msg = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase()
  // 42883 undefined_function (Postgres) / PGRST202 (PostgREST RPC not found)
  return (
    code === '42883' ||
    code === 'PGRST202' ||
    msg.includes('could not find the function') ||
    msg.includes('does not exist')
  )
}

function illegalTransition(error) {
  if (!error) return false
  const msg = `${error.message || ''}`.toLowerCase()
  return msg.includes('illegal_campaign_transition')
}

/**
 * Transition a campaign's lifecycle status through the concurrency-safe DB
 * function. Falls back to a guarded direct update (validated against the same
 * edge set) when the DB function is not yet deployed.
 *
 * @returns {Promise<{ ok: boolean, campaign?: object, from?: string, to?: string, error?: string }>}
 */
export async function transitionCampaignStatus(supabase, campaignId, toStatus, options = {}) {
  const to = String(toStatus ?? '').trim().toLowerCase()
  if (!campaignId) return { ok: false, error: 'campaign_id_required' }
  if (!CAMPAIGN_STATE_SET.has(to)) return { ok: false, error: `unknown_target_status:${to}` }

  const reason = options.reason ?? null
  const scheduledFor = options.scheduledFor ?? options.scheduled_for ?? null

  // Canonical path: advisory-locked, edge-validated DB function.
  const { data, error } = await supabase.rpc('campaign_transition_status', {
    p_campaign_id: campaignId,
    p_to_status: to,
    p_reason: reason,
    p_scheduled_for: scheduledFor,
  })

  if (!error) {
    const campaign = Array.isArray(data) ? data[0] : data
    return { ok: true, campaign: campaign || null, to, from: campaign?.last_transition_from ?? null }
  }

  if (illegalTransition(error)) {
    return { ok: false, error: 'illegal_campaign_transition', to }
  }

  if (!rpcFunctionMissing(error)) {
    return { ok: false, error: error.message || 'transition_failed', to }
  }

  // Degraded fallback (pre-migration): validate edge in JS, guarded update.
  return transitionCampaignStatusFallback(supabase, campaignId, to, { reason, scheduledFor })
}

/**
 * Minimal legal walk from any status to a target, executed one edge at a time
 * through the concurrency-safe transition. Used by activation, which may need
 * scheduled -> activating -> active. Returns the final transition result.
 */
const WALK_PATHS = Object.freeze({
  active: {
    draft: ['scheduled', 'activating', 'active'],
    previewed: ['scheduled', 'activating', 'active'],
    scheduled: ['activating', 'active'],
    activating: ['active'],
    paused: ['active'],
    failed: ['activating', 'active'],
  },
})

export async function walkCampaignStatus(supabase, campaignId, target, options = {}) {
  const { data: existing, error } = await supabase
    .from('campaigns')
    .select('id,status')
    .eq('id', campaignId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message || 'campaign_read_failed', to: target }
  if (!existing) return { ok: false, error: 'campaign_not_found', to: target }

  const from = normalizeCampaignStatus(existing.status)
  if (from === target) return { ok: true, campaign: existing, from, to: target }

  const path = (WALK_PATHS[target] || {})[from]
  if (!path) {
    // No known legal path (legacy/unexpected) — best-effort single transition.
    return transitionCampaignStatus(supabase, campaignId, target, options)
  }

  let last = { ok: true, campaign: existing, from, to: from }
  for (const step of path) {
    last = await transitionCampaignStatus(supabase, campaignId, step, options)
    if (!last.ok) return last
  }
  return last
}

/** Convenience: drive a campaign to `active` via the minimal legal path. */
export function activateCampaign(supabase, campaignId, options = {}) {
  return walkCampaignStatus(supabase, campaignId, 'active', options)
}

async function transitionCampaignStatusFallback(supabase, campaignId, to, { reason, scheduledFor }) {
  const { data: existing, error: readError } = await supabase
    .from('campaigns')
    .select('id,status')
    .eq('id', campaignId)
    .maybeSingle()
  if (readError) return { ok: false, error: readError.message || 'campaign_read_failed', to }
  if (!existing) return { ok: false, error: 'campaign_not_found', to }

  const rawFrom = String(existing.status ?? '').trim().toLowerCase()
  const from = normalizeCampaignStatus(existing.status)
  if (from === to) {
    // Idempotent — but canonicalize a legacy stored alias in place rather than
    // leaving it stale (parity with the DB function).
    if (rawFrom !== to) {
      const { data } = await supabase
        .from('campaigns')
        .update({ status: to, updated_at: new Date().toISOString() })
        .eq('id', campaignId)
        .eq('status', existing.status)
        .select('id,status')
        .maybeSingle()
      return { ok: true, campaign: data || existing, from, to, degraded: true }
    }
    return { ok: true, campaign: existing, from, to }
  }

  if (!isTransitionAllowed(from, to)) {
    return { ok: false, error: 'illegal_campaign_transition', from, to }
  }

  const nowIso = new Date().toISOString()
  const patch = {
    status: to,
    last_transition_from: from,
    last_transition_reason: reason,
    last_transition_at: nowIso,
    updated_at: nowIso,
  }
  if (to === 'scheduled') {
    patch.scheduled_at = nowIso
    patch.scheduled_for = scheduledFor || nowIso
  }
  if (to === 'activating') patch.activating_at = nowIso
  if (to === 'active') patch.activated_at = nowIso
  if (to === 'paused') patch.paused_at = nowIso
  if (to === 'completed') patch.completed_at = nowIso
  if (to === 'failed') {
    patch.failed_at = nowIso
    patch.failure_reason = reason
  }
  if (to === 'archived') patch.archived_at = nowIso

  // Optimistic concurrency: only transition if status is still `from`.
  const { data, error } = await supabase
    .from('campaigns')
    .update(patch)
    .eq('id', campaignId)
    .eq('status', existing.status)
    .select('*')
    .maybeSingle()

  if (error) {
    // Column-missing (pre-migration) tolerance: retry with minimal patch.
    if (rpcFunctionMissing(error)) {
      const { data: minimal, error: minimalError } = await supabase
        .from('campaigns')
        .update({ status: to, updated_at: nowIso })
        .eq('id', campaignId)
        .eq('status', existing.status)
        .select('id,status')
        .maybeSingle()
      if (minimalError) return { ok: false, error: minimalError.message || 'transition_failed', from, to }
      if (!minimal) return { ok: false, error: 'transition_conflict', from, to }
      return { ok: true, campaign: minimal, from, to, degraded: true }
    }
    return { ok: false, error: error.message || 'transition_failed', from, to }
  }
  if (!data) return { ok: false, error: 'transition_conflict', from, to }
  return { ok: true, campaign: data, from, to, degraded: true }
}
