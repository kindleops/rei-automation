/**
 * Missed campaign starts — the single rule (dependency-free so read models such
 * as the Calendar timeline can share it with the activation worker without
 * importing the activation orchestrator).
 *
 * The activation cron was gone for a while (vercel.json crons removed), so
 * campaigns sat `scheduled` for days past their start. Wiring it back must not
 * turn a days-old schedule into an immediate, unannounced send the moment a
 * deploy lands: a missed schedule is surfaced for the operator to reschedule or
 * activate, never auto-fired.
 */
export const SCHEDULE_MISSED_GRACE_MS = 2 * 60 * 60 * 1000

export function isScheduleMissed(campaign = {}, now = Date.now()) {
  const at = Date.parse(campaign.scheduled_for || '')
  return Number.isFinite(at) && now - at > SCHEDULE_MISSED_GRACE_MS
}

/**
 * The ONE missed-start rule, shared by the activation worker and every read
 * model (Calendar timeline, Campaign Command): a campaign still `scheduled`
 * whose start is more than SCHEDULE_MISSED_GRACE_MS in the past is MISSED. It
 * is never auto-activated late; the operator reschedules or activates it.
 */
export function isCampaignStartMissed(campaign = {}, now = Date.now()) {
  return String(campaign.status ?? '').trim().toLowerCase() === 'scheduled' && isScheduleMissed(campaign, now)
}

