// rc-8.5.21 v3 (RT-16 / crash recovery C): the next silence follow-up is planned by the DELIVERY webhook
// (delivery-triggered-followup.js) — after the webhook row is already marked processed. A crash between
// the delivery sync and the schedule lost the next action for good: nothing re-reads a delivered anchor.
//
// THE SWEEP. Every outbound row delivered in the lookback window (older than a grace period, so the live
// webhook had its chance) is re-offered to the SAME trigger with the SAME inputs. The trigger is the one
// authority (every guard: a later inbound, a newer outbound, a pending follow-up, the stage policy and
// cap, suppression, the follow-up mode) and its schedule is idempotent per delivered anchor
// (followup_dedupe_scope delivered:<sid> ⇒ the same lifecycle intent key / the same legacy dedupe key):
// a missed next action is planned EXACTLY ONCE; one that exists is a replay. It never sends anything —
// the follow-up is a planned intent / deferred row that the lifecycle materializes and re-checks.
import { maybeScheduleFollowUpAfterDelivery } from './delivery-triggered-followup.js'

export const MISSED_FOLLOWUP_SWEEP_VERSION = 'recover-missed-delivery-followups.v1'
const clean = (v) => String(v ?? '').trim()

/**
 * @returns {Promise<{ ok: boolean, examined: number, scheduled: number, not_needed: Record<string, number>, failed: Array<{ queue_row_id: string, reason: string }> }>}
 */
export async function recoverMissedDeliveryFollowUps({ supabase, now = new Date().toISOString(), lookbackHours = 48, graceMinutes = 15, limit = 200, schedule = maybeScheduleFollowUpAfterDelivery } = {}) {
  const out = { ok: true, version: MISSED_FOLLOWUP_SWEEP_VERSION, examined: 0, scheduled: 0, not_needed: {}, failed: [] }
  if (!supabase?.from) return { ...out, ok: false, failed: [{ queue_row_id: null, reason: 'sweep_unwired' }] }
  const t = Date.parse(now) || Date.now()
  const { data, error } = await supabase.from('send_queue')
    .select('id,provider_message_id,delivered_at,queue_status')
    .gte('delivered_at', new Date(t - lookbackHours * 3_600_000).toISOString())
    .lte('delivered_at', new Date(t - graceMinutes * 60_000).toISOString())
    .order('delivered_at', { ascending: true }).limit(limit)
  if (error) return { ...out, ok: false, failed: [{ queue_row_id: null, reason: `delivered_read_failed:${clean(error.message).slice(0, 80)}` }] }
  // the follow-up mode is read through the SAME client (an unreadable switch ⇒ the trigger fails closed)
  const getSystemValueImpl = async (key) => {
    const r = await supabase.from('system_control').select('value').eq('key', key).maybeSingle()
    if (r?.error) throw r.error
    return r?.data?.value ?? null
  }
  for (const row of data || []) {
    const sid = clean(row.provider_message_id)
    if (!sid) continue
    out.examined += 1
    let r
    try { r = await schedule({ provider_message_sid: sid, final_delivery_status: 'delivered', supabase, getSystemValueImpl }) } catch (e) { r = { ok: false, reason: clean(e?.message) || 'schedule_threw' } }
    if (!r?.ok) { out.failed.push({ queue_row_id: String(row.id), reason: clean(r?.reason) || 'schedule_failed' }); continue }
    if (r.scheduled) out.scheduled += 1
    else { const k = clean(r.reason) || 'not_needed'; out.not_needed[k] = (out.not_needed[k] || 0) + 1 }
  }
  if (out.failed.length) out.ok = false
  return out
}
