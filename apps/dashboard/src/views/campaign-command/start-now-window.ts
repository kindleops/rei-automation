/**
 * START NOW — contact-window check (rc-7.1 D4).
 *
 * A missed scheduled start is never fired late by the worker; the operator
 * starts it now through the existing activation sheet. Before they confirm,
 * the sheet states whether texting hours are open in the campaign's zone right
 * now. Starting outside them is allowed and safe — the activation path
 * schedules the first text into the next valid window — but it must be said,
 * not discovered. Multi-zone cohorts are honest about it: each seller's own
 * hours apply.
 */
import { isInsideContactWindow } from './campaign-builder-launch'
import type { CampaignSummary } from './campaigns.types'

export interface StartNowWindow {
  state: 'open' | 'closed' | 'per_recipient' | 'unknown'
  /** Plain words for the operator. */
  words: string
}

const hhmm = (value: string | null | undefined) => (value && /^\d{1,2}:\d{2}/.test(value) ? value.slice(0, 5) : null)

function zoneLabel(zone: string, now: Date): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(now).find((p) => p.type === 'timeZoneName')
    return part?.value || zone
  } catch {
    return zone
  }
}

export function startNowWindow(campaign: Pick<CampaignSummary, 'send_window_start' | 'send_window_end' | 'lineage'>, now = new Date()): StartNowWindow {
  const start = hhmm(campaign.send_window_start)
  const end = hhmm(campaign.send_window_end)
  if (!start || !end) return { state: 'unknown', words: 'Texting hours are not set on this campaign; every text still waits for each seller’s allowed hours.' }
  const zone = campaign.lineage?.timezone ?? null
  if (!zone) {
    return { state: 'per_recipient', words: `Each seller’s own texting hours apply (${start}–${end} local); sellers whose hours are closed get their first text when they open.` }
  }
  const label = zoneLabel(zone, now)
  return isInsideContactWindow(zone, start, end, now)
    ? { state: 'open', words: `Texting hours are open now (${start}–${end} ${label}).` }
    : { state: 'closed', words: `Texting hours are closed now (${start}–${end} ${label}). Starting now prepares messages; the first text goes when hours open — nothing sends outside them.` }
}

/**
 * The worker's missed-start rule, mirrored for display (API:
 * campaign-schedule-missed.js). One activation tick of tolerance — not a
 * grace: a scheduled start older than this that is still `scheduled` was
 * missed, even before the worker has stamped schedule_missed_for.
 */
export const SCHEDULE_ACTIVATION_TOLERANCE_MS = 10 * 60 * 1000

export function missedStartAt(
  status: string | null | undefined,
  scheduledFor: string | null | undefined,
  markedMissedFor: string | null | undefined,
  now = Date.now(),
): string | null {
  if (String(status ?? '').toLowerCase() !== 'scheduled') return null
  if (markedMissedFor) return markedMissedFor
  const at = Date.parse(scheduledFor ?? '')
  return Number.isFinite(at) && now - at > SCHEDULE_ACTIVATION_TOLERANCE_MS ? (scheduledFor ?? null) : null
}
