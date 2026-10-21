// Built-in runtime handler `ops.health_check` — deterministic, no LLM, $0.
//
// Reads (through agent.ops_health_snapshot, SECURITY DEFINER, bounded + indexed):
//   public.system_control  the five scheduler heartbeat keys below (+ queue modes as context)
//   public.send_queue      count(queued|retry overdue > 15 min), count(processing > 10 min), each LIMIT 1000
// Writes an agent.finding for every stale / missing / unparseable heartbeat and for
// overdue or stuck queue rows. A missing or unparseable heartbeat is reported as
// such — unknown is never treated as fresh. Writes nothing anywhere else.
//
// NOTE (prod, 10-12): system_control.updated_at is NOT maintained for these keys
// (e.g. 2026-07-01 while the value is today), so staleness is judged from the
// ISO timestamp stored in `value`, never from updated_at.
//
// EVENT-DRIVEN heartbeats (8.5.15): followup_no_response_heartbeat_at is written by
// the delivery-receipt leg (delivery-triggered-followup.js, throttled 60 s per
// process), not by a cron lane. Overnight there are no deliveries, so its wall-clock
// age says nothing; judging it against a fixed 30 min raised a false "stale" every
// night. It is judged against the newest provider-confirmed delivery instead
// (snapshot.deliveries.last_delivered_at = max(send_queue.delivered_at), added to
// agent.ops_health_snapshot by PROPOSED_20261014150000_ops_health_snapshot_delivery_ref.sql):
//   stale  ⇔ a delivery landed more than grace_seconds AFTER the heartbeat (the leg
//            did not run for it); no delivery since ⇒ fresh (idle), whatever the age.
// Without that reference (older snapshot function) the key is NOT judged stale on
// age alone: it is 'unverified' (reported in the result, never 'fresh'), and only an
// age beyond the 24 h ceiling raises a finding.
export const OPS_HEALTH_CHECK_KIND = 'ops.health_check'

/** Heartbeats written per event (not per cron tick): judged relative to their trigger. */
export const EVENT_DRIVEN_HEARTBEATS = Object.freeze({
  followup_no_response_heartbeat_at: Object.freeze({ reference: 'last_delivered_at', grace_seconds: 900, unverified_ceiling_seconds: 86_400 }),
})

/** Max acceptable age (seconds) per heartbeat key. */
export const DEFAULT_HEARTBEAT_THRESHOLDS = Object.freeze({
  queue_processor_heartbeat_at: 600, // queue/run, every minute
  campaign_feeder_heartbeat_at: 1800, // */5 lane
  followup_no_response_heartbeat_at: 1800,
  seller_state_reconcile_heartbeat_at: 1800, // */5 lane
  webhook_delivery_recovery_last_at: 1800, // */5 lane
})

const MODE_KEYS = ['queue_processor_mode', 'queue_execution_mode']
const modeValue = (v) => (typeof v === 'string' && /^[a-z_]{1,40}$/.test(v.trim()) ? v.trim() : v == null ? null : 'other')

function evaluateEventDriven(key, ev, { t, age, at, deliveries }) {
  const base = { key, age_seconds: age, observed_at: new Date(t).toISOString(), mode: 'event_driven', grace_seconds: ev.grace_seconds }
  const hasRef = deliveries && typeof deliveries === 'object' && Object.prototype.hasOwnProperty.call(deliveries, ev.reference)
  if (!hasRef) {
    // older snapshot function: no delivery reference ⇒ never 'fresh', never 'stale' on age alone
    return { ...base, status: age > ev.unverified_ceiling_seconds ? 'stale' : 'unverified', threshold_seconds: ev.unverified_ceiling_seconds, reference: null }
  }
  const raw = deliveries[ev.reference]
  if (raw == null || String(raw).trim() === '') return { ...base, status: 'fresh', idle: true, reference: null, threshold_seconds: ev.grace_seconds }
  const r = Date.parse(String(raw))
  if (!Number.isFinite(r)) return { ...base, status: 'unverified', reference: 'unparseable', threshold_seconds: ev.grace_seconds }
  const lag = Math.round((Math.min(r, at) - t) / 1000) // delivery AFTER the heartbeat, seconds
  return { ...base, status: lag > ev.grace_seconds ? 'stale' : 'fresh', idle: lag <= 0, lag_seconds: Math.max(0, lag), reference: new Date(r).toISOString(), threshold_seconds: ev.grace_seconds }
}

/** Pure: snapshot → evaluations (exported for tests). */
export function evaluateHealthSnapshot(snapshot, thresholds = DEFAULT_HEARTBEAT_THRESHOLDS) {
  const at = Date.parse(snapshot?.at)
  if (!Number.isFinite(at)) throw new Error('health snapshot has no valid server time')
  const keys = snapshot?.keys || {}
  const heartbeats = []
  for (const [key, max] of Object.entries(thresholds)) {
    const raw = keys[key]
    if (raw == null || String(raw).trim() === '') { heartbeats.push({ key, status: 'missing', threshold_seconds: max }); continue }
    const t = Date.parse(String(raw).trim())
    if (!Number.isFinite(t)) { heartbeats.push({ key, status: 'unparseable', threshold_seconds: max }); continue }
    const age = Math.round((at - t) / 1000)
    const ev = EVENT_DRIVEN_HEARTBEATS[key]
    if (ev) { heartbeats.push(evaluateEventDriven(key, ev, { t, age, at, deliveries: snapshot?.deliveries })); continue }
    heartbeats.push({ key, status: age > max ? 'stale' : 'fresh', age_seconds: age, threshold_seconds: max, observed_at: new Date(t).toISOString() })
  }
  const q = snapshot?.queue || {}
  const modes = Object.fromEntries(MODE_KEYS.map((k) => [k, modeValue(keys[k])]))
  const queue = {
    overdue_queued_or_retry: Number(q.overdue_queued_or_retry || 0),
    stale_processing: Number(q.stale_processing || 0),
    cap: Number(q.cap || 1000),
    overdue_minutes: Number(q.overdue_minutes || 15),
    processing_stale_minutes: Number(q.processing_stale_minutes || 10),
  }
  return { at: new Date(at).toISOString(), heartbeats, queue, modes }
}

export const opsHealthCheckHandler = Object.freeze({
  kind: OPS_HEALTH_CHECK_KIND,
  async run(ctx) {
    const input = ctx.job.input || {}
    const thresholds = { ...DEFAULT_HEARTBEAT_THRESHOLDS }
    for (const [k, v] of Object.entries(input.thresholds || {})) if (k in thresholds && Number.isInteger(v) && v >= 60 && v <= 86_400) thresholds[k] = v
    const overdue_minutes = Number.isInteger(input.overdue_minutes) && input.overdue_minutes >= 1 && input.overdue_minutes <= 1440 ? input.overdue_minutes : 15
    const processing_stale_minutes = Number.isInteger(input.processing_stale_minutes) && input.processing_stale_minutes >= 1 && input.processing_stale_minutes <= 1440 ? input.processing_stale_minutes : 10

    await ctx.step('read_snapshot', { progress: { step: 'read_snapshot', steps_done: 0, steps_total: 3, pct: 0 } })
    const snapshot = await ctx.read.healthSnapshot({ overdue_minutes, processing_stale_minutes })
    const ev = evaluateHealthSnapshot(snapshot, thresholds)

    await ctx.step('evaluate', { progress: { step: 'evaluate', steps_done: 1, steps_total: 3, pct: 33 }, payload: { heartbeats_checked: ev.heartbeats.length } })
    const problems = []
    for (const h of ev.heartbeats) {
      if (h.status === 'fresh' || h.status === 'unverified') continue
      problems.push({
        finding_type: h.status === 'stale' ? 'ops.heartbeat_stale' : 'ops.heartbeat_missing',
        key: h.key,
        source_id: 'public.system_control',
        value: { status: h.status, threshold_seconds: h.threshold_seconds, ...(h.age_seconds != null ? { age_seconds: h.age_seconds, observed_at: h.observed_at } : {}), ...(h.mode ? { mode: h.mode, lag_seconds: h.lag_seconds ?? null, reference: h.reference ?? null } : {}), checked_at: ev.at },
      })
    }
    if (ev.queue.overdue_queued_or_retry > 0) {
      problems.push({ finding_type: 'ops.queue_overdue', key: 'send_queue.queued_or_retry', source_id: 'public.send_queue', value: { count: ev.queue.overdue_queued_or_retry, capped: ev.queue.overdue_queued_or_retry >= ev.queue.cap, overdue_minutes: ev.queue.overdue_minutes, ...ev.modes, checked_at: ev.at } })
    }
    if (ev.queue.stale_processing > 0) {
      problems.push({ finding_type: 'ops.queue_stuck', key: 'send_queue.processing', source_id: 'public.send_queue', value: { count: ev.queue.stale_processing, capped: ev.queue.stale_processing >= ev.queue.cap, processing_stale_minutes: ev.queue.processing_stale_minutes, ...ev.modes, checked_at: ev.at } })
    }

    await ctx.step('write_findings', { progress: { step: 'write_findings', steps_done: 2, steps_total: 3, pct: 66 }, payload: { problems: problems.length } })
    for (const p of problems) await ctx.recordFinding({ ...p, confidence: 1 })

    return {
      result: {
        healthy: problems.length === 0,
        checked_at: ev.at,
        heartbeats: Object.fromEntries(ev.heartbeats.map((h) => [h.key, h.status])),
        queue: { overdue_queued_or_retry: ev.queue.overdue_queued_or_retry, stale_processing: ev.queue.stale_processing },
        findings: problems.length,
      },
    }
  },
})
