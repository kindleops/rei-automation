// ─── automation-hold-release.js ─────────────────────────────────────────────
// The ONE application writer that RELEASES an automation hold, and only for a NAMED HUMAN: it is called by the
// capability plane's holds.prepare_release_approval after a verified operator approved an agent's release
// request (agent/capabilities/defs/action-gateway-requests.js). An agent can never reach it: the Action Gateway
// role has no write on public.automation_holds and no tool releases a hold.
//
// The release is the registry's own audited UPDATE (released_at / released_by / release_reason; its trigger
// refuses any other change and audits hold_released). Refused, whoever asks:
//   * a permanent_exclusion (Maxwell, owner decision 2026-10-14) and every static exclusion;
//   * the Hartford hold (CLOSED LOST, owner 2026-10-19: never revive) and anything scoped to it;
//   * a released / unknown hold; a releaser that is not a uuid (a named operator) or a missing reason.
import { neverReviveCode } from '../action-gateway/actions/t2/shared.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const clean = (v) => String(v ?? '').trim()

/**
 * @param {{ hold_id: string, released_by: string, release_reason: string }} input
 * @param {{ supabase: object }} deps  a write-capable client (the API's service client)
 * @returns {Promise<{ ok: boolean, code: string, hold_id?: string, state?: string }>}
 */
export async function releaseAutomationHoldByOperator({ hold_id, released_by, release_reason } = {}, { supabase } = {}) {
  if (!supabase?.from) return { ok: false, code: 'NO_CLIENT' }
  if (!UUID_RE.test(clean(hold_id))) return { ok: false, code: 'HOLD_ID_INVALID' }
  if (!UUID_RE.test(clean(released_by))) return { ok: false, code: 'RELEASER_NOT_A_NAMED_OPERATOR' }
  const reason = clean(release_reason).slice(0, 300)
  if (!reason) return { ok: false, code: 'RELEASE_REASON_REQUIRED' }
  const r = await supabase.from('automation_holds').select('id,hold_key,hold_type,thread_key,inbox_thread_id,property_id,opportunity_id,released_at').eq('id', clean(hold_id)).limit(1)
  if (r?.error) return { ok: false, code: 'HOLD_READ_FAILED' }
  const h = Array.isArray(r?.data) ? r.data[0] : r?.data
  if (!h) return { ok: false, code: 'HOLD_NOT_FOUND' }
  if (h.released_at) return { ok: true, code: 'ALREADY_RELEASED', hold_id: h.id, state: 'released' }
  if (h.hold_type === 'permanent_exclusion') return { ok: false, code: 'PERMANENT_EXCLUSION' }
  const never = neverReviveCode({ hold_key: h.hold_key, thread_id: h.inbox_thread_id, thread_key: h.thread_key, property_id: h.property_id, opportunity_id: h.opportunity_id })
  if (never) return { ok: false, code: never }
  const u = await supabase.from('automation_holds').update({ released_at: new Date().toISOString(), released_by: `operator:${clean(released_by)}`, release_reason: reason })
    .eq('id', h.id).is('released_at', null).select('id')
  if (u?.error) return { ok: false, code: 'HOLD_RELEASE_FAILED' }
  const done = Array.isArray(u?.data) ? u.data.length : u?.data ? 1 : 0
  return done ? { ok: true, code: 'HOLD_RELEASED', hold_id: h.id, state: 'released' } : { ok: true, code: 'ALREADY_RELEASED', hold_id: h.id, state: 'released' }
}
