/**
 * Missed campaign starts — the single rule (dependency-free so read models such
 * as the Calendar timeline can share it with the activation worker without
 * importing the activation orchestrator).
 *
 * NO LATE AUTO-ACTIVATION (rc-7.1, owner decision 4). A scheduled campaign
 * whose start passed without activation is MISSED. There used to be a 2-hour
 * grace during which the worker kept retrying and could start a campaign up to
 * two hours late, unannounced ("75+ ACQ SCORE", 2026-09-30). That grace is gone.
 *
 * What remains is a SCHEDULER-TICK TOLERANCE, not a grace: the activation
 * worker runs every 5 minutes, so a 09:00 start is picked up by the 09:00–09:05
 * tick. SCHEDULE_ACTIVATION_TOLERANCE_MS covers one tick plus one missed tick
 * (a lock or cold start), nothing more. And a start the worker ATTEMPTED and
 * readiness refused is missed at once (metadata.schedule_missed_for ===
 * scheduled_for) — it is not retried every five minutes.
 *
 * A missed start is surfaced for the operator: Start now (the existing
 * activation path, which validates the contact window) or Reschedule.
 */
export const SCHEDULE_ACTIVATION_TOLERANCE_MS = 10 * 60 * 1000

/** @deprecated name kept for existing importers; it is the tick tolerance, not a grace. */
export const SCHEDULE_MISSED_GRACE_MS = SCHEDULE_ACTIVATION_TOLERANCE_MS

/** The start is older than one activation tick (plus slack). */
export function isScheduleMissed(campaign = {}, now = Date.now()) {
  const at = Date.parse(campaign.scheduled_for || '')
  return Number.isFinite(at) && now - at > SCHEDULE_ACTIVATION_TOLERANCE_MS
}

/** The worker already declared THIS schedule missed (e.g. readiness refused it). */
export function isScheduleMarkedMissed(campaign = {}) {
  const md = campaign.metadata && typeof campaign.metadata === 'object' ? campaign.metadata : {}
  const marked = md.schedule_missed_for
  return Boolean(marked) && Boolean(campaign.scheduled_for) && Date.parse(marked) === Date.parse(campaign.scheduled_for)
}

/**
 * The ONE missed-start rule, shared by the activation worker and every read
 * model (Calendar timeline, Campaign Command): a campaign still `scheduled`
 * whose start passed without activation — older than one activation tick, or
 * already marked missed for this exact schedule. It is never auto-activated
 * late; the operator starts it now or reschedules it.
 */
export function isCampaignStartMissed(campaign = {}, now = Date.now()) {
  return String(campaign.status ?? '').trim().toLowerCase() === 'scheduled'
    && (isScheduleMissed(campaign, now) || isScheduleMarkedMissed(campaign))
}
