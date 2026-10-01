/**
 * CALENDAR TIMELINE — the acquisition operation organised through time.
 *
 * A READ-ONLY projection over the canonical records that actually carry time in
 * production. It owns no state: every event points back at its source row, and
 * a change to that row is the only way an event changes.
 *
 * Why a new projection and not calendar-nexus: the nexus reads twelve sources
 * and six of them (`offers`, `contracts`, `closings`, `title_routing_closing_
 * engine`, `buyer_match`, `calendar_manual_events`) do not exist in production,
 * while the sources that do hold real time — inbox_thread_state follow-ups,
 * campaign send windows, closing_cases deadlines, seller_offers EMD/closing
 * dates — were never read.
 *
 * Contract per event (phone + desk):
 *   id, type, source (canonical table), app (owning surface), title, subtitle,
 *   start, end, all_day, time_kind (scheduled | due | expected | window |
 *   occurred), tz (the zone the time is DEFINED in), actor (system | operator |
 *   external | blocked | completed), status, priority (high | normal | info),
 *   overdue, attention, reason, count (groups), links {thread_key,
 *   opportunity_id, campaign_id, property_id, closing_case_id, run_id}, detail.
 *
 * Desk contract (view=desk, CALENDAR 3.0) adds per event:
 *   source_id, subject {type,id}, owner (you | system | seller | buyer | title |
 *   external), state (upcoming | live | waiting | needs_you | overdue |
 *   completed | cancelled | superseded), attention_state, attention_category,
 *   lane, kind (window | start | group | message | capsule | deadline |
 *   milestone | timer), editable {mode, owner_app, how, effects},
 *   provenance {scheduled_by, basis, timezone, timezone_basis}, why, next,
 *   contact_window {tz, planned_within, earliest_at}, deep_link, updated_at —
 *   and the response adds day aggregates, the attention board and telemetry.
 *
 * Rules that are easy to get wrong, each pinned by a test:
 *   - Campaign sends are ONE group per campaign per operator day, never a row
 *     per message. Send windows are windows, in the CAMPAIGN's market zone.
 *   - A system follow-up whose time passed without running is "automation has
 *     not acted", not an operator overdue — unless a message DID go out after
 *     it (completed) or the seller wrote again (superseded).
 *   - The queue row is the dispatch authority for a follow-up: a thread's
 *     follow_up_at that mirrors a cancelled queue row is cancelled, not upcoming.
 *   - Suppressed / archived / dead work is not an event (thread keys are joined
 *     as E.164 — 23 opportunities store the key without the +1).
 *   - Date-only deadlines (closing, EMD, inspection) are all-day DUE dates; they
 *     are never given an invented clock time.
 *   - A closing date recorded on both the offer and the closing case is one
 *     event (the closing case wins). Closings come from the Closing Desk model.
 *   - Nothing here writes. Workflow timers come from wf_runs.wake_at; email
 *     from email_queue (sending is off in production — waiting, never failure).
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { loadConfiguredPerSenderCap } from '@/lib/domain/campaigns/sender-capacity.js'
import { deriveTimezoneFromGeography } from '@/lib/domain/campaigns/contact-window-timezone.js'
import { isCampaignStartMissed } from '@/lib/domain/campaigns/campaign-schedule-missed.js'
import { campaignWindowZones } from '@/lib/domain/campaigns/campaign-market-identity.js'
import { getClosingPortfolio } from '@/lib/domain/closings/closing-execution-service.js'

const DAY = 86_400_000
const MIN = 60_000
const MAX_RANGE_DAYS = 62
const LOOKBACK_DAYS = 14 // overdue/attention context before the requested range

const ACTIVE_QUEUE = ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending', 'held', 'retry']
const DONE_QUEUE = ['sent', 'delivered']
const BLOCKED_QUEUE_PREFIX = /^(blocked|failed|paused)/
const LIVE_CAMPAIGN = new Set(['active', 'activating', 'live_limited'])
const DEAD_OPP = new Set(['suppressed', 'dead', 'closed', 'lost', 'archived', 'do_not_contact'])
const OPERATOR_ACTIONS = new Set(['human_review', 'call_seller', 'manual_review', 'operator_review', 'review', 'call'])
const WF_LIVE = ['running', 'waiting', 'awaiting_approval', 'held']
const EMAIL_OPEN = ['scheduled', 'queued', 'pending', 'approved', 'waiting', 'deferred', 'ready', 'pending_approval', 'retry']
/** Campaign send density is reported per slot of this many minutes (operator zone). */
export const SLOT_MINUTES = 30
const THREAD_COLUMNS = 'thread_key,property_id,market,stage,status,next_action,follow_up_at,next_action_at,is_suppressed,is_archived,last_inbound_at,last_outbound_at,inbox_bucket,updated_at'
const STALE_REVIEW_DAYS = 90

const clean = (v) => String(v ?? '').trim()
// Same minute: a campaign's start reads before its first sends.
const TYPE_ORDER = { campaign_start: 0, campaign_window: 1, campaign_sends: 2 }
const iso = (ms) => new Date(ms).toISOString()

/** Offset (ms) of `timezone` at instant `at`. */
export function zoneOffsetMs(at, timezone) {
  const d = new Date(at)
  const inZone = Date.parse(d.toLocaleString('en-US', { timeZone: timezone }))
  const inUtc = Date.parse(d.toLocaleString('en-US', { timeZone: 'UTC' }))
  return inZone - inUtc
}

/** UTC instant of local wall-clock `YYYY-MM-DD` + `HH:MM` in `timezone`. */
export function zonedInstant(dateStr, hhmm, timezone) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm] = clean(hhmm || '00:00').split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh || 0, mm || 0)
  // Two passes settle DST boundaries.
  let at = guess - zoneOffsetMs(guess, timezone)
  at = guess - zoneOffsetMs(at, timezone)
  return at
}

/** Local calendar date of an instant in `timezone`. */
export function localDate(at, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))
}

/** Minutes after local midnight of an instant in `timezone`. */
function localMinutes(at, timezone) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at))
  const h = Number(p.find((x) => x.type === 'hour')?.value) % 24
  const m = Number(p.find((x) => x.type === 'minute')?.value)
  return h * 60 + m
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d) + n * DAY).toISOString().slice(0, 10)
}

export function isValidZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return Boolean(tz) } catch { return false }
}

const ZONE_ABBR = {
  'America/New_York': 'ET', 'America/Detroit': 'ET', 'America/Indiana/Indianapolis': 'ET',
  'America/Chicago': 'CT', 'America/Denver': 'MT', 'America/Phoenix': 'MST', 'America/Los_Angeles': 'PT',
  'America/Anchorage': 'AKT', 'Pacific/Honolulu': 'HT',
}
export const zoneAbbr = (tz) => ZONE_ABBR[tz] || clean(tz).split('/').pop()?.replace(/_/g, ' ') || tz

/** Thread keys are E.164 in inbox_thread_state; 23 opportunities store 10 digits. */
export function normThreadKey(v) {
  const s = clean(v)
  if (!s) return ''
  const digits = s.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return s
}

/**
 * The seller's contact window around a planned send, in the SELLER's zone
 * (property geography — the canonical contact-window rule). A planned time
 * outside 08:00–21:00 local cannot go out until the window opens; a past-due
 * item can only go out from now on. Unresolvable geography → null (never a
 * guessed zone).
 */
export function contactWindowFor(atMs, tz, { start = '08:00', end = '21:00', now = atMs } = {}) {
  if (!tz || !isValidZone(tz) || !Number.isFinite(atMs)) return null
  const [sh, sm] = clean(start).split(':').map(Number)
  const [eh, em] = clean(end).split(':').map(Number)
  const open = sh * 60 + (sm || 0)
  const close = eh * 60 + (em || 0)
  const within = (at) => { const m = localMinutes(at, tz); return m >= open && m < close }
  const base = Math.max(atMs, now)
  const mins = localMinutes(base, tz)
  const day = localDate(base, tz)
  let earliest = base
  if (mins < open) earliest = zonedInstant(day, start, tz)
  else if (mins >= close) earliest = zonedInstant(addDays(day, 1), start, tz)
  return { tz, abbr: zoneAbbr(tz), window: `${start}–${end}`, planned_within: within(atMs), earliest_at: iso(earliest), deferred: earliest > atMs + MIN }
}

/* ─────────────────────────── builders (pure) ─────────────────────────── */

function queueState(status) {
  const s = clean(status)
  if (DONE_QUEUE.includes(s)) return 'sent'
  if (s === 'cancelled' || s === 'expired') return 'cancelled'
  if (BLOCKED_QUEUE_PREFIX.test(s)) return 'blocked'
  if (s === 'processing' || s === 'sending') return 'sending'
  return 'scheduled'
}

/**
 * What kind of send a non-campaign queue row is. The distinction the operator
 * cares about: a message YOU scheduled vs one automation planned.
 */
export function messageClass(row = {}) {
  const mt = clean(row.message_type).toLowerCase()
  const src = clean(row.source).toLowerCase()
  if (mt === 'followup' || (mt === 'follow-up' && src !== 'auto_reply')) return 'follow_up'
  if (mt === 'follow-up' && src === 'auto_reply') return 'auto_reply'
  if (mt === 'manual_scheduled_reply') return 'scheduled_manual'
  if (mt === 'manual_reply' || mt === 'discord manual reply') return 'manual_reply'
  if (mt === 'ownership_check') return 'ownership_check'
  return 'message'
}
const CLASS_TITLE = {
  follow_up: 'Seller follow-up', auto_reply: 'Auto-reply', scheduled_manual: 'Scheduled message',
  manual_reply: 'Manual reply', ownership_check: 'Ownership check', message: 'Scheduled message',
}
const SCHEDULER_LABEL = {
  seller_inbound_orchestrator: 'Seller Conversation (inbound orchestrator)',
  inbound_sms_handler: 'Seller Conversation (inbound handler)',
  auto_reply: 'Seller Conversation (auto-reply)',
  inbox_bulk_follow_up: 'Inbox · bulk follow-up (operator)',
  inbox: 'Inbox (operator)',
  manual_inbox: 'Inbox (operator)',
  map_command: 'Map · ownership check (operator)',
  campaign_launch_execution: 'Campaign feeder',
}
const humanFollowupReason = (r) => {
  const t = clean(r)
  const m = /^nurture_followup:(.+)$/.exec(t)
  if (m) return `Nurture follow-up after “${m[1].replace(/_/g, ' ')}”`
  return t ? humanize(t) : null
}

/**
 * Campaign rows → one group per campaign per operator-local day. Non-campaign
 * rows (Inbox scheduled replies, automation) stay individual.
 *
 * `history`: keep cancelled singles as auditable history (desk). The phone
 * never receives them.
 */
export function buildQueueEvents(rows = [], { tz, now = Date.now(), campaigns = new Map(), people = new Map(), history = false, window = null, keepFollowUps = false } = {}) {
  const groups = new Map()
  const singles = []
  for (const row of rows) {
    const at = Date.parse(row.scheduled_for || row.sent_at || '')
    if (!Number.isFinite(at)) continue
    const state = queueState(row.queue_status)
    if (row.campaign_id) {
      const key = `${row.campaign_id}:${localDate(at, tz)}`
      const g = groups.get(key) || { campaign_id: row.campaign_id, day: localDate(at, tz), start: at, end: at, counts: { scheduled: 0, sending: 0, sent: 0, blocked: 0, cancelled: 0 }, delivered: 0, pastDue: 0, nextAt: null, reasons: {}, slots: new Map() }
      g.start = Math.min(g.start, at)
      g.end = Math.max(g.end, at)
      g.counts[state] += 1
      // Where in the day the rows sit, per 30-minute slot (operator zone): the
      // queue's own schedule, so a band can draw real send density.
      if (state !== 'cancelled') {
        const slot = Math.floor(localMinutes(at, tz) / SLOT_MINUTES)
        const cell = g.slots.get(slot) || { done: 0, waiting: 0, failed: 0 }
        if (state === 'sent') cell.done += 1
        else if (state === 'blocked') cell.failed += 1
        else cell.waiting += 1
        g.slots.set(slot, cell)
      }
      // The next row still to go out (the queue's own schedule, not a forecast).
      if ((state === 'scheduled' || state === 'sending') && at >= now && (g.nextAt === null || at < g.nextAt)) g.nextAt = at
      if (clean(row.queue_status) === 'delivered') g.delivered += 1
      if (state === 'scheduled' && at < now - 15 * MIN) g.pastDue += 1
      if (state === 'blocked') {
        const r = clean(row.blocked_reason || row.guard_reason || row.failed_reason || row.paused_reason || row.queue_status)
        g.reasons[r] = (g.reasons[r] || 0) + 1
      }
      groups.set(key, g)
      continue
    }
    const cls = messageClass(row)
    // A cancelled send is not a calendar fact anyone acts on — except as history.
    if (state === 'cancelled' && !history) continue
    const tk = normThreadKey(row.thread_key)
    const person = people.get(tk) || {}
    const pastDue = state === 'scheduled' && at < now - 15 * MIN
    const reason = state === 'blocked' ? clean(row.blocked_reason || row.guard_reason || row.failed_reason || row.paused_reason || row.queue_status) : null
    const cancelReason = state === 'cancelled' ? clean(row.cancellation_reason || row.skip_reason || row.failed_reason || row.guard_reason) || null : null
    const sellerZone = zoneFromGeography(row.property_address_state, row.property_address_zip)
    const followUp = cls === 'follow_up'
    const manual = cls === 'scheduled_manual' || cls === 'manual_reply'
    const e = {
      id: `queue:${row.id}`,
      type: followUp ? 'seller_follow_up' : 'scheduled_message',
      source: 'send_queue',
      source_id: String(row.id),
      app: 'inbox',
      title: CLASS_TITLE[cls],
      subtitle: clean(row.seller_display_name || person.seller) || null,
      place: clean(row.property_address || person.address) || null,
      start: iso(at),
      end: null,
      all_day: false,
      time_kind: state === 'sent' ? 'occurred' : 'scheduled',
      tz: null,
      actor: state === 'blocked' ? 'blocked' : state === 'sent' ? 'completed' : 'system',
      status: state === 'cancelled' ? 'cancelled' : pastDue ? 'past_due' : state,
      priority: state === 'blocked' || pastDue ? 'high' : 'normal',
      overdue: pastDue,
      attention: state === 'blocked' || pastDue,
      reason: reason || (pastDue ? 'Send time passed and the message has not gone out' : cancelReason ? `Cancelled · ${humanize(cancelReason)}` : null),
      count: 1,
      links: { thread_key: tk || null, property_id: row.property_id ? String(row.property_id) : null, opportunity_id: person.opportunity_id || null, queue_id: String(row.id) },
      detail: {
        queue_status: row.queue_status,
        message_type: row.message_type || null,
        message_class: cls,
        scheduled_by: SCHEDULER_LABEL[clean(row.source)] || (clean(row.source) ? humanize(row.source) : null),
        followup_reason: humanFollowupReason(row.followup_reason),
        cancelled_by: clean(row.cancelled_by) || null,
        cancel_reason: cancelReason,
        policy_version: clean(row.execution_policy_version) || null,
        seller_zone: sellerZone,
      },
      // The queue has the ball either way; `manual` records that YOU scheduled it.
      owner: 'system',
      manual,
      history_only: state === 'cancelled',
      updated_at: row.updated_at || null,
    }
    // Contact window vs planned action — only for sends still to go out.
    if (window && sellerZone && (state === 'scheduled' || pastDue)) e.contact_window = contactWindowFor(at, sellerZone, { ...window, now })
    singles.push(e)
  }
  const grouped = []
  for (const g of groups.values()) {
    const c = campaigns.get(g.campaign_id) || {}
    const live = LIVE_CAMPAIGN.has(clean(c.status))
    const total = Object.values(g.counts).reduce((a, b) => a + b, 0)
    const waiting = g.counts.scheduled + g.counts.sending
    // Rows of a campaign that is not live cannot leave (queue/run refuses them).
    const heldByCampaign = g.pastDue > 0 && !live
    const allDone = waiting === 0
    const failed = g.counts.blocked
    const doneStatus = g.counts.sent > 0 ? 'sent' : failed > 0 ? 'failed' : 'cancelled'
    grouped.push({
      id: `campaign-sends:${g.campaign_id}:${g.day}`,
      type: 'campaign_sends',
      source: 'send_queue',
      source_id: `${g.campaign_id}:${g.day}`,
      app: 'campaigns',
      title: `${total} campaign message${total === 1 ? '' : 's'}`,
      subtitle: clean(c.name) || 'Campaign',
      place: null,
      start: iso(g.start),
      end: g.end > g.start ? iso(g.end) : null,
      all_day: false,
      time_kind: allDone ? 'occurred' : 'scheduled',
      tz: c.tz || null,
      // A finished day is done even when some sends failed: the count says how many.
      actor: allDone ? 'completed' : 'system',
      status: heldByCampaign ? 'held' : allDone ? doneStatus : g.pastDue > 0 ? 'past_due' : 'scheduled',
      priority: heldByCampaign ? 'high' : 'normal',
      overdue: g.pastDue > 0,
      attention: heldByCampaign || g.pastDue > 0,
      reason: heldByCampaign
        ? `${g.pastDue} message${g.pastDue === 1 ? '' : 's'} past send time — the campaign is ${clean(c.status) || 'not live'}, so they cannot go out`
        : g.pastDue > 0 ? `${g.pastDue} past their send time and not yet sent`
          : allDone && doneStatus === 'failed' ? `None of ${total} went out`
            : allDone && failed ? `${failed} of ${total} did not go out` : null,
      count: total,
      links: { campaign_id: g.campaign_id },
      detail: { counts: g.counts, delivered: g.delivered, failed, blocked_reasons: g.reasons, campaign_status: c.status || null, past_due: g.pastDue, next_send_at: g.nextAt !== null ? iso(g.nextAt) : null, last_send_at: iso(g.end), slot_minutes: SLOT_MINUTES, slots: [...g.slots.entries()].sort((a, b) => a[0] - b[0]).map(([slot, v]) => [slot, v.done, v.waiting, v.failed]) },
      owner: 'system',
    })
  }
  return [...grouped, ...collapseSingles(singles, tz, 4, { keepFollowUps })]
}

/**
 * Many individual sends in the same state on the same day read as one group
 * ("14 scheduled replies failed"), with the members kept for drill-in. Four or
 * more collapse; fewer stay individual. With `keepFollowUps` (the desk, which
 * groups follow-ups by time slot itself) follow-ups stay individual so each
 * seller stays reachable; the phone keeps its day groups exactly as before.
 */
export function collapseSingles(singles = [], tz = 'UTC', threshold = 4, { keepFollowUps = false } = {}) {
  const buckets = new Map()
  const out = []
  for (const e of singles) {
    if (keepFollowUps && e.type === 'seller_follow_up') { out.push(e); continue }
    const key = `${localDate(Date.parse(e.start), tz)}:${e.status}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(e)
  }
  for (const [key, list] of buckets) {
    if (list.length < threshold) { out.push(...list); continue }
    const first = list[0]
    const starts = list.map((e) => Date.parse(e.start))
    const reasons = {}
    for (const e of list) if (e.reason) reasons[e.reason] = (reasons[e.reason] || 0) + 1
    const label = { blocked: 'failed or blocked', past_due: 'past send time', sent: 'sent', scheduled: 'scheduled', sending: 'sending', cancelled: 'cancelled' }[first.status] || first.status
    const manual = list.filter((e) => e.manual).length
    out.push({
      ...first,
      id: `messages:${key}`,
      type: 'scheduled_message_group',
      source_id: key,
      title: `${list.length} messages ${label}`,
      subtitle: Object.keys(reasons).length ? Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r, n]) => `${n} ${humanize(r).toLowerCase()}`).join(' · ') : null,
      place: null,
      start: iso(Math.min(...starts)),
      end: iso(Math.max(...starts)),
      count: list.length,
      links: {},
      reason: first.status === 'blocked' ? 'These sends did not go out. Each one names its reason.' : first.reason,
      detail: { reasons, manual, members: list.slice(0, 60).map((e) => ({ id: e.id, start: e.start, subtitle: e.subtitle, place: e.place, reason: e.reason, thread_key: e.links.thread_key, status: e.status, title: e.title })) },
      contact_window: undefined,
    })
  }
  return out
}

/**
 * What became of a follow-up instant once its time passed. Read from the
 * thread's own message clock — never inferred from the time passing:
 *   completed  — a message went out after it (the system or you acted)
 *   superseded — the seller wrote again after it, and nothing went out
 *   not_acted  — nothing happened
 * The brain stamps next_action_at at the moment it processes an inbound, a few
 * seconds after the message itself — so "wrote again" means > 2 minutes later.
 */
export function followUpOutcome({ at, now = Date.now(), lastOutbound = null, lastInbound = null } = {}) {
  if (!Number.isFinite(at) || at > now) return { state: 'upcoming' }
  const out = Date.parse(lastOutbound || '')
  const inn = Date.parse(lastInbound || '')
  if (Number.isFinite(out) && out > at) return { state: 'completed', at: out }
  if (Number.isFinite(inn) && inn > at + 2 * MIN) return { state: 'superseded', at: inn }
  return { state: 'not_acted' }
}

const clockIn = (ms, tz) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
const dateIn = (ms, tz) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })

/**
 * inbox_thread_state follow-ups. follow_up_at and next_action_at usually carry
 * the same instant for the same thread; one event per thread per instant.
 */
export function buildFollowUpEvents(rows = [], { now = Date.now(), people = new Map(), history = false, tz = 'America/Chicago', window = null } = {}) {
  const out = []
  for (const row of rows) {
    if (row.is_suppressed || row.is_archived) continue
    const tk = normThreadKey(row.thread_key)
    const person = people.get(tk) || {}
    if (person.opportunity_status && DEAD_OPP.has(clean(person.opportunity_status))) {
      // The thread still names a follow-up time, but its deal is suppressed /
      // dead / closed: nothing will act on it. The phone never sees it; the
      // desk keeps it as HISTORY so a recorded follow-up never silently
      // vanishes from the day it was planned for (2026-10-01: 13 thread
      // follow-ups on Oct 11, every one on a suppressed deal).
      if (history) out.push(...unqueuedFollowUps(row, { tk, person, now }))
      continue
    }
    const instants = []
    const fu = Date.parse(row.follow_up_at || '')
    const na = Date.parse(row.next_action_at || '')
    if (Number.isFinite(fu)) instants.push({ at: fu, field: 'follow_up_at' })
    if (Number.isFinite(na) && !(Number.isFinite(fu) && Math.abs(na - fu) < 5 * MIN)) instants.push({ at: na, field: 'next_action_at' })
    const action = clean(row.next_action)
    const operator = OPERATOR_ACTIONS.has(action)
    const lastIn = Date.parse(row.last_inbound_at || '')
    for (const { at, field } of instants) {
      const past = at < now
      // The brain's "reply now" marker: stamped as it processes an inbound.
      const replyMarker = !operator && Number.isFinite(lastIn) && Math.abs(lastIn - at) < 2 * MIN && field === 'next_action_at'
      const outcome = operator ? { state: past ? 'overdue' : 'upcoming' } : followUpOutcome({ at, now, lastOutbound: row.last_outbound_at, lastInbound: row.last_inbound_at })
      if ((outcome.state === 'completed' || outcome.state === 'superseded') && !history) continue
      const title = operator ? 'Review seller' : replyMarker ? 'Reply due' : 'Seller follow-up'
      let status; let reason; let actor
      if (operator) {
        status = past ? 'overdue' : 'upcoming'
        actor = 'operator'
        reason = past ? 'Waiting on you — this review is past due' : 'Waiting on you'
      } else if (outcome.state === 'completed') {
        status = 'completed'; actor = 'completed'
        reason = `${replyMarker ? 'Reply' : 'Message'} went out ${dateIn(outcome.at, tz)} ${clockIn(outcome.at, tz)}`
      } else if (outcome.state === 'superseded') {
        status = 'superseded'; actor = 'completed'
        reason = `Seller wrote again ${dateIn(outcome.at, tz)} ${clockIn(outcome.at, tz)} — this ${replyMarker ? 'reply' : 'follow-up'} was superseded`
      } else if (past) {
        status = 'not_acted'; actor = 'system'
        reason = replyMarker ? 'Seller replied — no reply has gone out (automation has not acted)' : 'Automation has not acted on this follow-up yet'
      } else {
        status = 'upcoming'; actor = 'system'
        reason = 'Automation will follow up if the seller is still eligible'
      }
      const e = {
        id: `thread:${tk}:${field}:${at}`,
        type: 'seller_follow_up',
        source: `inbox_thread_state.${field}`,
        source_id: tk,
        app: 'inbox',
        title,
        subtitle: person.seller || null,
        place: person.address || null,
        start: iso(at),
        end: null,
        all_day: false,
        time_kind: operator ? 'due' : 'scheduled',
        tz: null,
        actor,
        status,
        priority: operator ? 'high' : 'normal',
        overdue: past && operator,
        attention: status === 'overdue' || status === 'not_acted',
        reason,
        count: 1,
        links: { thread_key: tk || null, property_id: row.property_id ? String(row.property_id) : null, opportunity_id: person.opportunity_id || null },
        detail: { next_action: action || null, stage: person.stage || row.stage || null, market: row.market || null, bucket: row.inbox_bucket || null, thread_status: row.status || null, reply_marker: replyMarker, outcome_at: outcome.at ? iso(outcome.at) : null, seller_zone: person.zone || null },
        owner: operator ? 'you' : 'system',
        history_only: status === 'completed' || status === 'superseded',
        updated_at: row.updated_at || null,
      }
      if (window && person.zone && !operator && (status === 'upcoming' || status === 'not_acted')) e.contact_window = contactWindowFor(at, person.zone, { ...window, now })
      out.push(e)
    }
  }
  return out
}

const DEAD_WORDS = { suppressed: 'suppressed', dead: 'dead', closed: 'closed', lost: 'lost', archived: 'archived', do_not_contact: 'marked do-not-contact' }

/**
 * A follow-up time recorded on a thread whose deal is suppressed / dead /
 * closed. History only (never upcoming, never attention): the record exists,
 * and the calendar says plainly that nothing is queued to act on it.
 */
export function unqueuedFollowUps(row = {}, { tk = normThreadKey(row.thread_key), person = {}, now = Date.now() } = {}) {
  const fu = Date.parse(row.follow_up_at || '')
  if (!Number.isFinite(fu)) return []
  const word = DEAD_WORDS[clean(person.opportunity_status)] || clean(person.opportunity_status).replace(/_/g, ' ')
  return [{
    id: `thread:${tk}:follow_up_at:${fu}`,
    type: 'seller_follow_up',
    source: 'inbox_thread_state.follow_up_at',
    source_id: tk,
    app: 'inbox',
    title: 'Seller follow-up',
    subtitle: person.seller || null,
    place: person.address || null,
    start: iso(fu),
    end: null,
    all_day: false,
    time_kind: 'scheduled',
    tz: null,
    actor: 'completed',
    status: 'cancelled',
    priority: 'info',
    overdue: false,
    attention: false,
    reason: `Not queued — the deal is ${word}, so nothing will send at this time`,
    count: 1,
    links: { thread_key: tk || null, property_id: row.property_id ? String(row.property_id) : null, opportunity_id: person.opportunity_id || null },
    detail: { next_action: clean(row.next_action) || null, stage: person.stage || row.stage || null, market: row.market || null, thread_status: row.status || null, opportunity_status: person.opportunity_status || null, unqueued: true, upcoming_when_recorded: fu > now, seller_zone: person.zone || null },
    owner: 'system',
    history_only: true,
    updated_at: row.updated_at || null,
  }]
}

/** Pipeline next actions on live opportunities. */
export function buildOpportunityEvents(rows = [], { now = Date.now() } = {}) {
  const out = []
  for (const o of rows) {
    if (DEAD_OPP.has(clean(o.opportunity_status))) continue
    const at = Date.parse(o.next_action_due || '')
    if (!Number.isFinite(at)) continue
    const action = clean(o.next_action)
    const past = at < now
    const system = /^(schedule_|send_|auto)/.test(action) || clean(o.automation_state) === 'running' && !OPERATOR_ACTIONS.has(action)
    out.push({
      id: `opportunity:${o.id}:next_action_due`,
      type: 'pipeline_action',
      source: 'acquisition_opportunities.next_action_due',
      source_id: String(o.id),
      app: 'pipeline',
      title: action ? humanize(action) : 'Next action due',
      subtitle: clean(o.seller_display_name) || null,
      place: clean(o.property_address_full) || null,
      start: iso(at),
      end: null,
      all_day: false,
      time_kind: 'due',
      tz: null,
      actor: system ? 'system' : 'operator',
      status: past ? 'overdue' : 'upcoming',
      priority: !system ? 'high' : 'normal',
      overdue: past && !system,
      attention: past,
      reason: past ? (system ? 'Automation has not acted yet' : 'Past due') : null,
      count: 1,
      links: { opportunity_id: String(o.id), thread_key: normThreadKey(o.primary_thread_key) || null, property_id: o.primary_property_id ? String(o.primary_property_id) : null },
      detail: { stage: o.acquisition_stage || null, market: o.market || null, next_action: action || null },
      owner: system ? 'system' : 'you',
      updated_at: o.updated_at || null,
    })
  }
  return out
}

/**
 * Campaign starts + send windows. Windows are defined in the CAMPAIGN's market
 * zone (never the device's) and only projected while the campaign still has
 * eligible sellers to reach, for as many days as its real pace needs.
 */
export function buildCampaignEvents(campaigns = [], { from, to, now = Date.now(), stats = new Map(), perSenderDefault = null, system = null } = {}) {
  const out = []
  for (const c of campaigns) {
    const status = clean(c.status)
    // One zone, or every recipient zone of a multi-zone cohort (campaign-market-identity).
    const zones = campaignZones(c)
    const tz = zones.length === 1 ? zones[0] : null
    const multi = zones.length > 1
    const s = stats.get(c.id) || {}
    const scheduledAt = Date.parse(c.scheduled_for || '')
    const missed = isCampaignStartMissed(c, now) // the activation worker's own rule
    if (status === 'scheduled' && Number.isFinite(scheduledAt)) {
      out.push({
        id: `campaign:${c.id}:start`,
        type: 'campaign_start',
        source: 'campaigns.scheduled_for',
        source_id: String(c.id),
        app: 'campaigns',
        title: missed ? 'Campaign start missed' : 'Campaign starts',
        subtitle: clean(c.name),
        place: null,
        start: iso(scheduledAt),
        end: null,
        all_day: false,
        time_kind: 'scheduled',
        tz,
        ...(multi ? { tzs: zones } : {}),
        actor: missed ? 'blocked' : 'system',
        status: missed ? 'missed' : scheduledAt < now ? 'starting' : 'scheduled',
        priority: missed ? 'high' : 'normal',
        overdue: missed,
        attention: missed,
        reason: missed ? 'The scheduled start passed without activating. Reschedule or activate it in Campaign Command.' : 'Activates automatically at this time',
        count: 1,
        links: { campaign_id: c.id },
        detail: campaignDetail(c, s),
        owner: 'system',
        updated_at: c.updated_at || null,
      })
    }
    if (!zones.length || missed) continue
    const live = LIVE_CAMPAIGN.has(status)
    if (!live && status !== 'scheduled') continue
    const remaining = Number(s.remaining || 0) + Number(s.scheduled || 0)
    if (remaining <= 0) continue
    const pace = dailyPace(c, s, perSenderDefault)
    const days = pace > 0 ? Math.ceil(remaining / pace) : 1
    const halted = system && (system.processor !== 'live' || system.emergency_stop)
    // A multi-zone cohort has one real window per recipient zone; each is its
    // own event (single-zone ids and titles are unchanged).
    for (const tz of zones) {
    const firstDay = status === 'scheduled' && Number.isFinite(scheduledAt) ? localDate(scheduledAt, tz) : localDate(now, tz)
    for (let i = 0; i < days; i += 1) {
      const day = addDays(firstDay, i)
      if (day < from || day > to) continue
      const start = zonedInstant(day, c.contact_window_start || '08:00', tz)
      const end = zonedInstant(day, c.contact_window_end || '21:00', tz)
      const last = i === days - 1
      const open = now >= start && now < end && live
      out.push({
        id: multi ? `campaign:${c.id}:window:${day}:${tz}` : `campaign:${c.id}:window:${day}`,
        type: 'campaign_window',
        source: 'campaigns.contact_window',
        source_id: multi ? `${c.id}:${day}:${tz}` : `${c.id}:${day}`,
        app: 'campaigns',
        title: multi ? `Send window · ${zoneAbbr(tz)}` : 'Send window',
        subtitle: clean(c.name),
        place: null,
        start: iso(i === 0 && Number.isFinite(scheduledAt) && status === 'scheduled' ? Math.max(start, scheduledAt) : start),
        end: iso(end),
        all_day: false,
        time_kind: i === 0 ? 'window' : 'expected',
        tz,
        actor: 'system',
        status: open ? 'open' : now >= end ? 'closed' : 'upcoming',
        priority: 'info',
        overdue: false,
        attention: false,
        reason: i === 0
          ? `Sends between ${c.contact_window_start || '08:00'}–${c.contact_window_end || '21:00'} ${zoneAbbr(tz)}`
          : `Expected — about ${pace}/day at the campaign's real pace${last ? '; last day at this pace' : ''}`,
        count: 1,
        links: { campaign_id: c.id },
        detail: { ...campaignDetail(c, s), ...(multi ? { tz, zone_count: zones.length } : {}), day_index: i + 1, projected_days: days, daily_pace: pace, halted: halted ? (system.emergency_stop ? 'emergency_stop' : `queue_processor_${system.processor}`) : null },
        owner: 'system',
        updated_at: c.updated_at || null,
      })
    }
    }
  }
  return out
}

/**
 * The zones a campaign's windows are read in: its cohort's recipient zones
 * (metadata.market_identity / recipient_timezones), else its declared zone.
 */
function campaignZones(c = {}) {
  return [...new Set(campaignWindowZones(c).filter(isValidZone))]
}

/** A single zone, or null when there is none OR several (see campaignZones). */
function campaignZone(c = {}) {
  const zones = campaignZones(c)
  return zones.length === 1 ? zones[0] : null
}

/**
 * CAMPAIGN ROSTER (desk) — every campaign the calendar read (scheduled and
 * live), with Campaign Command's counts and WHY it does or does not have a
 * send window today. A live campaign with nobody left to text projects no
 * window; the roster is how the calendar says so instead of dropping it.
 *
 *   situation: missed | scheduled | sending | window_ahead | window_closed |
 *              exhausted | no_timezone
 */
export function campaignRoster(campaigns = [], { stats = new Map(), now = Date.now(), events = [], system = null } = {}) {
  const ids = new Set(events.filter((e) => e.type === 'campaign_window').map((e) => e.id))
  return campaigns.map((c) => {
    const status = clean(c.status)
    const zones = campaignZones(c)
    const tz = zones.length === 1 ? zones[0] : null
    const multi = zones.length > 1
    const s = stats.get(c.id) || {}
    const scheduledAt = Date.parse(c.scheduled_for || '')
    const missed = isCampaignStartMissed(c, now) // the activation worker's own rule
    const left = Number(s.remaining || 0) + Number(s.scheduled || 0)
    // Today's window in EACH recipient zone, from the campaign's own contact
    // window — independent of the date range the operator happens to be viewing.
    const perZone = zones.map((zone) => {
      const today = localDate(now, zone)
      const opens = zonedInstant(today, c.contact_window_start || '08:00', zone)
      const closes = zonedInstant(today, c.contact_window_end || '21:00', zone)
      return { tz: zone, today, opens, closes, open: now >= opens && now < closes, ahead: now < opens }
    })
    const openZones = perZone.filter((z) => z.open)
    const aheadZones = perZone.filter((z) => z.ahead)
    // Sending while ANY recipient zone is open; otherwise the next opening.
    const lead = openZones[0] || aheadZones.sort((a, b) => a.opens - b.opens)[0] || perZone[0] || null
    const opens = !perZone.length ? null
      : openZones.length ? Math.min(...openZones.map((z) => z.opens))
        : aheadZones.length ? Math.min(...aheadZones.map((z) => z.opens)) : Math.min(...perZone.map((z) => z.opens))
    const closes = !perZone.length ? null
      : openZones.length ? Math.max(...openZones.map((z) => z.closes)) : Math.max(...perZone.map((z) => z.closes))
    const situation = missed ? 'missed'
      : !zones.length ? 'no_timezone'
        : status === 'scheduled' ? 'scheduled'
          : left <= 0 ? 'exhausted'
            : openZones.length ? 'sending' : aheadZones.length ? 'window_ahead' : 'window_closed'
    const windowId = lead ? (multi ? `campaign:${c.id}:window:${lead.today}:${lead.tz}` : `campaign:${c.id}:window:${lead.today}`) : null
    const halted = system && (system.processor !== 'live' || system.emergency_stop) ? (system.emergency_stop ? 'emergency_stop' : `queue_processor_${system.processor}`) : null
    const f = c.metadata?.feeder_last && typeof c.metadata.feeder_last === 'object' ? c.metadata.feeder_last : null
    return {
      id: c.id,
      name: clean(c.name) || 'Campaign',
      status: status || null,
      market: clean(c.market) || null,
      tz,
      ...(multi ? {
        tzs: zones,
        zones_today: perZone.map((z) => ({ tz: z.tz, opens_at: iso(z.opens), closes_at: iso(z.closes), open: z.open })),
      } : {}),
      window: c.contact_window_start && c.contact_window_end ? `${c.contact_window_start}–${c.contact_window_end}` : null,
      window_today: zones.length && !missed && status !== 'scheduled' && left > 0 ? { opens_at: iso(opens), closes_at: iso(closes) } : null,
      scheduled_for: Number.isFinite(scheduledAt) ? iso(scheduledAt) : null,
      situation,
      halted,
      window_event_id: windowId && ids.has(windowId) ? windowId : null,
      counts: { audience: s.audience ?? null, eligible: s.eligible ?? null, held: s.held ?? null, committed: s.committed ?? null, sent: s.sent ?? null, remaining: s.remaining ?? null, queued: s.scheduled ?? null },
      feeder: f ? { at: f.at || null, reason: f.reason || null, stalled: Boolean(f.stalled) } : null,
      deep_link: { app: 'campaigns', label: 'Open in Campaign Command', path: `/campaign-command?campaign=${encodeURIComponent(c.id)}` },
    }
  })
}

/** Real daily pace: bounded by daily_cap and per-sender limit × senders in use.
 * The per-sender limit is the campaign override, else the configured default. */
export function dailyPace(c = {}, s = {}, perSenderDefault = null) {
  const daily = Number(c.daily_cap) || 0
  const perSender = Number(c.per_sender_cap) || Number(perSenderDefault) || 0
  const senders = Math.max(1, Number(s.senders || 0))
  const bySender = perSender ? perSender * senders : 0
  const caps = [daily, bySender].filter((n) => n > 0)
  return caps.length ? Math.min(...caps) : 0
}

function campaignDetail(c = {}, s = {}) {
  const f = c.metadata?.feeder_last && typeof c.metadata.feeder_last === 'object' ? c.metadata.feeder_last : null
  return {
    status: c.status || null,
    // Campaign Command's own definitions (campaign-cockpit.js): audience = all
    // targets, held = blocked, remaining = ready, committed = the rest (already
    // planned into the queue), sent = sent + delivered rows.
    audience: s.audience ?? null,
    eligible: s.eligible ?? null,
    held: s.held ?? null,
    committed: s.committed ?? null,
    scheduled: s.scheduled ?? null,
    sent: s.sent ?? null,
    remaining: s.remaining ?? null,
    market: clean(c.market) || null,
    window: c.contact_window_start && c.contact_window_end ? `${c.contact_window_start}–${c.contact_window_end}` : null,
    tz: campaignZone(c),
    ...(campaignZones(c).length > 1 ? { tzs: campaignZones(c) } : {}),
    daily_cap: c.daily_cap ?? null,
    per_sender_cap: c.per_sender_cap ?? null,
    senders: s.senders ?? null,
    // The feeder's own last word (Worker CAMPAIGN_FEED, every 5 min) — never estimated here.
    feeder: f ? {
      at: f.at || null, bound: f.bound || null, reason: f.reason || null, stalled: Boolean(f.stalled),
      sent_today: f.sent_today ?? null, ready_remaining: f.ready_remaining ?? null, live_rows: f.active_live_rows ?? null,
      last_refill_at: f.last_refill_at || null, held_targets: f.held_targets ?? null,
    } : null,
  }
}

const CLOSING_DATES = [
  ['emd_due_date', 'EMD due', 'due', 'high'],
  ['inspection_deadline', 'Inspection deadline', 'due', 'high'],
  ['title_commitment_date', 'Title commitment due', 'due', 'high'],
  ['cure_deadline', 'Title cure deadline', 'due', 'high'],
  ['signing_date', 'Signing', 'scheduled', 'high'],
  ['scheduled_closing_date', 'Closing', 'scheduled', 'high'],
  ['funding_date', 'Funding', 'scheduled', 'normal'],
  ['recording_date', 'Recording', 'scheduled', 'normal'],
  ['title_opened_date', 'Title opened', 'occurred', 'info'],
  ['contract_signed_date', 'Contract executed', 'occurred', 'normal'],
  ['effective_date', 'Contract effective', 'occurred', 'info'],
]
const CLOSED_CASE = /^(closed|funded|completed|cancelled|canceled|voided|void|terminated|dead)$/

/** Raw closing_cases projection (kept for the phone contract's tests; the
 * loader reads closings through the Closing Desk model instead). */
export function buildClosingEvents(rows = [], { from, to, today } = {}) {
  const out = []
  for (const c of rows) {
    // A closed or cancelled/failed/withdrawn closing has no open deadlines.
    const done = CLOSED_CASE.test(clean(c.closing_status)) || Boolean(c.closed_at) || Boolean(c.terminal_outcome)
    for (const [field, title, kind, priority] of CLOSING_DATES) {
      const day = clean(c[field]).slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < from || day > to) continue
      const past = day < today && kind !== 'occurred'
      const overdue = past && !done && !milestoneMet(c, field)
      out.push({
        id: `closing:${c.id}:${field}`,
        type: field === 'scheduled_closing_date' ? 'closing' : 'closing_milestone',
        source: `closing_cases.${field}`,
        app: 'closing',
        title,
        subtitle: clean(c.signer_name) || null,
        place: clean(c.property_address) || null,
        start: `${day}T00:00:00.000Z`,
        date: day,
        end: null,
        all_day: true,
        time_kind: kind === 'occurred' ? 'occurred' : kind === 'due' ? 'due' : 'scheduled',
        tz: null,
        actor: kind === 'occurred' || done ? 'completed' : field.includes('title') || field === 'cure_deadline' ? 'external' : 'operator',
        status: overdue ? 'overdue' : kind === 'occurred' || done ? 'done' : 'upcoming',
        priority,
        overdue,
        attention: overdue,
        reason: overdue ? `${title} passed on ${day}` : null,
        count: 1,
        links: { closing_case_id: clean(c.closing_case_id) || null, opportunity_id: c.opportunity_id ? String(c.opportunity_id) : null, property_id: c.property_id ? String(c.property_id) : null, thread_key: clean(c.thread_key) || null },
        detail: { closing_status: c.closing_status || null, substage: c.closing_substage || null, title_status: c.title_status || null, escrow_status: c.escrow_status || null, title_company: c.title_company_name || null },
      })
    }
  }
  return out
}

/** Deadlines met by explicit closing-authority records (never by the date passing). */
function milestoneMet(c, field) {
  if (field === 'emd_due_date') return Boolean(c.__contract_emd_deposited) || /received|verified|complete/.test(clean(c.escrow_status))
  if (field === 'title_commitment_date') return Boolean(c.title_commitment_received_at || c.clear_to_close_at) || /clear|complete|committed/.test(clean(c.title_status))
  if (field === 'cure_deadline') return Boolean(c.clear_to_close_at) || /clear|complete/.test(clean(c.title_status))
  if (field === 'scheduled_closing_date' || field === 'signing_date') return Boolean(c.closed_at)
  return false
}

const DEADLINE_OWNER = { contract_emd: 'you', buyer_emd: 'buyer', inspection: 'you', title_commitment: 'title', cure: 'title', signing: 'you' }
const DEADLINE_KIND = { contract_emd: 'emd', buyer_emd: 'buyer_emd' }

/**
 * CLOSINGS FROM THE CLOSING DESK MODEL (closing-execution-model.js) — the
 * same derivation the Closing Desk renders, so a closing date, a met EMD or a
 * READY state here can never disagree with the desk. A date stored at 00:00Z
 * is date-only (all-day); a timed closing carries the PROPERTY's zone.
 */
export function buildClosingModelEvents(items = [], { from, to, today } = {}) {
  const out = []
  for (const x of items) {
    const history = Boolean(x.terminal || x.closed)
    const links = { closing_case_id: x.id || null, opportunity_id: x.opportunityId || null, property_id: x.propertyId || null, thread_key: normThreadKey(x.threadKey) || null }
    const who = x.opportunityId || x.propertyId || x.id
    const place = x.property?.address || null
    const seller = x.seller?.name || null
    const common = {
      app: 'closing', place, links, count: 1, updated_at: x.updatedAt || null,
      detail: {
        closing_state: x.state || null, ready: Boolean(x.ready), requirements: x.requirements || [], blockers: (x.blockers || []).slice(0, 6),
        next: x.next || null, buyer: x.buyer?.name || null, title_company: x.title?.company || null, terminal: Boolean(x.terminal), closed: Boolean(x.closed),
        property_tz: x.property?.tz || null, tz_confident: x.property?.tzConfident ?? null,
      },
    }
    const c = x.closing
    if (c && c.date >= from && c.date <= to) {
      const passed = c.past && !history
      out.push({
        ...common,
        id: `closing:${x.id}:closing_date`,
        type: 'closing',
        source: 'closing_cases.scheduled_closing_date',
        source_id: x.id,
        dedupe_key: `closing:${who}:closing:${c.date}`,
        title: x.closed ? 'Closed' : x.terminal ? `Closing ${String(x.state?.label || 'cancelled').toLowerCase()}` : c.confirmed ? 'Closing' : 'Target closing',
        subtitle: seller,
        start: c.time ? c.at : `${c.date}T00:00:00.000Z`,
        date: c.date,
        end: null,
        all_day: !c.time,
        time_kind: history ? 'occurred' : 'scheduled',
        tz: c.time ? c.tz : null,
        actor: history ? 'completed' : x.state?.tone === 'external' ? 'external' : x.state?.tone === 'active' ? 'system' : 'operator',
        status: x.terminal ? 'cancelled' : x.closed ? 'done' : passed ? 'overdue' : x.ready ? 'ready' : 'upcoming',
        priority: 'high',
        overdue: passed,
        attention: !history && (passed || x.state?.tone === 'blocked'),
        reason: passed ? `${c.confirmed ? 'Scheduled' : 'Target'} closing passed on ${c.date} — nothing records a close` : x.next?.what || null,
        owner: history ? 'system' : ownerFromBall(x.next?.owner),
        blocking: !history && x.state?.tone === 'blocked',
      })
    }
    for (const d of x.deadlines || []) {
      if (!d.date || d.date < from || d.date > to) continue
      const overdue = Boolean(d.overdue) && !history
      out.push({
        ...common,
        id: `closing:${x.id}:${d.key}`,
        type: 'closing_milestone',
        source: `closing_cases.${d.key}`,
        source_id: x.id,
        dedupe_key: DEADLINE_KIND[d.key] ? `closing:${who}:${DEADLINE_KIND[d.key]}:${d.date}` : undefined,
        title: d.label,
        subtitle: seller,
        start: d.time ? d.at : `${d.date}T00:00:00.000Z`,
        date: d.date,
        end: null,
        all_day: !d.time,
        time_kind: d.met ? 'occurred' : 'due',
        tz: d.time ? d.tz : null,
        actor: d.met || history ? 'completed' : DEADLINE_OWNER[d.key] === 'title' ? 'external' : 'operator',
        status: history ? (x.terminal ? 'cancelled' : 'done') : d.met ? 'done' : overdue ? 'overdue' : 'upcoming',
        priority: 'high',
        overdue,
        attention: overdue,
        reason: overdue ? `${d.label} passed on ${d.date} with no record it was met` : d.met ? 'Met — recorded by the closing authority' : null,
        owner: DEADLINE_OWNER[d.key] || 'you',
        blocking: overdue,
      })
    }
    // A live deal whose stage needs a date and has none: an attention fact with no day.
    if (!history && (x.blockers || []).some((b) => b.key === 'no_date')) {
      out.push({ ...common, id: `closing:${x.id}:no_date`, type: 'closing_missing_date', source: 'closing_cases.scheduled_closing_date', source_id: x.id, title: 'Closing date missing', subtitle: seller, start: null, date: null, end: null, all_day: true, undated: true, time_kind: 'due', tz: null, actor: 'operator', status: 'overdue', priority: 'high', overdue: false, attention: true, reason: 'Stage is Prepared to Close with no date on record.', owner: 'you', blocking: true })
    }
  }
  return out
}
const ownerFromBall = (o) => ({ you: 'you', seller: 'seller', buyer: 'buyer', title: 'title', lender: 'external', system: 'system' }[clean(o)] || 'you')

export function buildOfferEvents(rows = [], { from, to, today, now = Date.now() } = {}) {
  const out = []
  for (const o of rows) {
    const status = clean(o.status)
    const links = { opportunity_id: o.opportunity_id ? String(o.opportunity_id) : null, property_id: o.property_id ? String(o.property_id) : null, thread_key: normThreadKey(o.thread_key) || null }
    const price = Number(o.purchase_price || o.accepted_price || 0) || null
    for (const [field, title] of [['sent_at', 'Offer sent'], ['accepted_at', 'Offer accepted']]) {
      const at = Date.parse(o[field] || '')
      if (!Number.isFinite(at)) continue
      const day = new Date(at).toISOString().slice(0, 10)
      if (day < addDays(from, -1) || day > addDays(to, 1)) continue
      out.push({
        id: `offer:${o.id}:${field}`, type: 'offer', source: `seller_offers.${field}`, source_id: String(o.id), app: 'pipeline',
        title, subtitle: price ? `$${Math.round(price).toLocaleString()}` : null, place: null,
        start: iso(at), end: null, all_day: false, time_kind: 'occurred', tz: null,
        actor: 'completed', status: status || 'done', priority: 'normal', overdue: false, attention: false,
        reason: null, count: 1, links, detail: { offer_status: status, direction: o.direction || null }, owner: 'you',
      })
    }
    if (/withdrawn|superseded|rejected|expired|cancel/.test(status)) continue
    for (const [field, title] of [['emd_due_date', 'EMD due'], ['closing_date', 'Closing']]) {
      const day = clean(o[field]).slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < from || day > to) continue
      const overdue = day < today && field === 'emd_due_date'
      const who = o.opportunity_id || o.property_id
      out.push({
        id: `offer:${o.id}:${field}`, type: field === 'closing_date' ? 'closing' : 'closing_milestone', source: `seller_offers.${field}`, source_id: String(o.id), app: 'pipeline',
        dedupe_key: who ? `closing:${who}:${field === 'closing_date' ? 'closing' : 'emd'}:${day}` : undefined,
        title, subtitle: price ? `$${Math.round(price).toLocaleString()} offer` : null, place: null,
        start: `${day}T00:00:00.000Z`, date: day, end: null, all_day: true, time_kind: field === 'closing_date' ? 'scheduled' : 'due', tz: null,
        actor: 'operator', status: overdue ? 'overdue' : 'upcoming', priority: 'high', overdue, attention: overdue,
        reason: overdue ? `${title} passed on ${day}` : null, count: 1, links, detail: { offer_status: status }, owner: 'you',
      })
    }
  }
  void now
  return out
}

/* ── workflow orchestrator (wf_*) ─────────────────────────────────────── */

function graphNodes(graph) {
  const nodes = new Map((graph?.nodes || []).map((n) => [n.id, n]))
  const edges = graph?.edges || []
  return { nodes, next: (id) => edges.filter((e) => e.from === id).map((e) => ({ exit: e.exit || null, node: nodes.get(e.to) || { id: e.to, label: e.to } })) }
}

/**
 * wf_runs → timers, approvals, holds and finished runs. A waiting run's
 * wake_at IS the moment the system acts; the node it waits on and the nodes
 * after it come from the PINNED version graph (never the draft).
 */
export function buildWorkflowEvents(runs = [], { now = Date.now(), versions = new Map(), workflows = new Map(), waits = new Map(), from = null, history = true } = {}) {
  const out = []
  for (const r of runs) {
    const v = versions.get(`${r.workflow_key}:${r.version}`)
    const wf = workflows.get(r.workflow_key) || {}
    const g = graphNodes(v?.graph)
    const name = clean(wf.name || v?.graph?.name) || humanize(r.workflow_key)
    const node = g.nodes.get(clean(r.cursor)) || null
    const trig = r.context?.trigger || {}
    const links = { run_id: String(r.id), thread_key: normThreadKey(trig.thread_key) || null, property_id: trig.property_id ? String(trig.property_id) : null, opportunity_id: /^[0-9a-f-]{36}$/i.test(clean(trig.opportunity_id)) ? clean(trig.opportunity_id) : null, closing_case_id: clean(trig.closing_case_id) || null }
    const nextNodes = node ? g.next(node.id) : []
    const wait = waits.get(String(r.id)) || null
    const anchorAt = Date.parse(r.context?.event?.at || '') || Date.parse(r.started_at || '')
    const base = {
      source: 'wf_runs', source_id: String(r.id), app: 'workflow', subtitle: node?.label || null, place: null, end: null, all_day: false, tz: null, count: 1, links,
      updated_at: r.updated_at || null,
      detail: {
        run_id: r.id, workflow_key: r.workflow_key, workflow_name: name, version: r.version, run_state: r.state, outcome: r.outcome || null, reason: r.reason || null,
        node_id: node?.id || clean(r.cursor) || null, node_label: node?.label || null, node_kind: node?.kind || null,
        wait_mode: node?.config?.mode || wait?.kind || null, duration_hours: node?.config?.duration_hours ?? null, anchor: node?.config?.anchor || null,
        anchor_at: Number.isFinite(anchorAt) ? iso(anchorAt) : null, trigger_event: r.trigger_event_type || null,
        next_nodes: nextNodes.map((n) => ({ label: n.node.label || n.node.id, exit: n.exit, kind: n.node.kind || null })),
        wait: wait ? { kind: wait.kind, event_type: wait.event_type || null, title: wait.title || null, timeout_at: wait.timeout_at || null, created_at: wait.created_at || null } : null,
        subject: { kind: r.subject_kind, id: r.subject_id },
        steps: (r.__steps || []).slice(-8),
        started_at: r.started_at || null, finished_at: r.finished_at || null,
      },
    }
    const wake = Date.parse(r.wake_at || '')
    if (r.state === 'waiting' && Number.isFinite(wake)) {
      const late = now - wake > 15 * MIN
      out.push({
        ...base, id: `wf:${r.id}:wake`, type: 'workflow_timer', title: name, start: iso(wake), time_kind: 'scheduled',
        actor: 'system', status: late ? 'stalled' : 'waiting', priority: late ? 'high' : 'normal', overdue: late, attention: late,
        reason: late ? `Timer ran out ${Math.round((now - wake) / MIN)} min ago and the orchestrator has not resumed the run` : nextNodes.length ? `Resumes, then “${nextNodes[0].node.label}”` : 'Resumes the run',
        owner: 'system',
      })
    } else if (r.state === 'awaiting_approval') {
      const due = Date.parse(wait?.timeout_at || '')
      const at = Number.isFinite(due) ? due : Date.parse(wait?.created_at || r.updated_at || '')
      if (!Number.isFinite(at)) continue
      const passed = Number.isFinite(due) && due < now
      out.push({
        ...base, id: `wf:${r.id}:approval`, type: 'workflow_approval', title: wait?.title || `${name} · approval`, start: iso(at), time_kind: 'due',
        actor: 'operator', status: passed ? 'overdue' : 'needs_you', priority: 'high', overdue: passed, attention: true,
        reason: passed ? 'The approval window closed — the run takes its timeout path' : 'Waiting on your approval in Workflow Studio',
        owner: 'you',
      })
    } else if (r.state === 'held') {
      const at = Date.parse(r.updated_at || '')
      if (!Number.isFinite(at)) continue
      out.push({
        ...base, id: `wf:${r.id}:held`, type: 'workflow_held', title: `${name} · held`, start: iso(at), time_kind: 'occurred',
        actor: 'blocked', status: 'held', priority: 'high', overdue: true, attention: true,
        reason: `The run is held: ${humanize(r.reason || 'unknown')}`, owner: 'system',
      })
    } else if (history && r.finished_at) {
      const at = Date.parse(r.finished_at)
      if (!Number.isFinite(at) || (from && at < from)) continue
      out.push({
        ...base, id: `wf:${r.id}:done`, type: 'workflow_run', title: `${name} · ${humanize(r.outcome || r.state)}`, start: iso(at), time_kind: 'occurred',
        actor: 'completed', status: r.state === 'cancelled' ? 'cancelled' : 'done', priority: 'normal', overdue: false, attention: false,
        reason: r.outcome === 'escalated' ? 'Escalated to the operator' : r.outcome ? `Finished · ${humanize(r.outcome)}` : 'Finished', owner: 'system',
      })
    }
  }
  return out
}

/* ── email outbox (email_queue) ───────────────────────────────────────── */

/** Scheduled outbound email. Sending is hard-off in production: a scheduled
 * email is WAITING on the switch, never a failure. */
export function buildEmailEvents(rows = [], { now = Date.now(), sendingEnabled = false } = {}) {
  const out = []
  for (const r of rows) {
    const at = Date.parse(r.scheduled_for || r.sent_at || '')
    if (!Number.isFinite(at)) continue
    const st = clean(r.queue_status)
    const sent = st === 'sent' || st === 'delivered'
    const cancelled = st === 'cancelled' || st === 'superseded'
    const open = EMAIL_OPEN.includes(st)
    const past = at < now && open
    out.push({
      id: `email:${r.id}`, type: 'email_scheduled', source: 'email_queue', source_id: String(r.id), app: 'email',
      title: clean(r.subject) || 'Scheduled email', subtitle: clean(r.to_email) || null, place: null,
      start: iso(at), end: null, all_day: false, time_kind: sent ? 'occurred' : 'scheduled', tz: null,
      actor: sent || cancelled ? 'completed' : 'system',
      status: sent ? 'sent' : cancelled ? 'cancelled' : !sendingEnabled && open ? 'waiting' : past ? 'past_due' : 'scheduled',
      priority: 'normal', overdue: false, attention: false,
      reason: !sendingEnabled && open ? 'Email sending is off — queued in the outbox, it will not send until sending is enabled' : cancelled ? `Cancelled${r.cancel_reason ? ` · ${humanize(r.cancel_reason)}` : ''}` : null,
      count: 1,
      links: { closing_case_id: clean(r.closing_case_id) || null, opportunity_id: r.opportunity_id ? String(r.opportunity_id) : null, property_id: r.property_id ? String(r.property_id) : null, email_thread_id: r.thread_id ? String(r.thread_id) : null },
      detail: { queue_status: st, source: r.source || null, approval_status: r.approval_status || null },
      owner: 'system', updated_at: r.updated_at || null,
    })
  }
  return out
}

/**
 * One real event, one row: a closing/EMD date recorded on both the seller
 * offer and the closing case is the closing case's (it is the later, more
 * authoritative record). Keyed on dedupe_key when the builder states one,
 * else opportunity (or property) + kind + date. The queue row owns a
 * follow-up's dispatch: a thread follow-up at the same moment is its mirror.
 */
export function dedupeEvents(events = []) {
  // The pipeline's next_action_due mirrors the thread's follow-up for the same
  // seller: same thread, within five minutes → keep the thread's (it carries
  // the conversation handoff), drop the mirror.
  const threadTimes = events
    .filter((e) => e.type === 'seller_follow_up' && e.links.thread_key)
    .map((e) => [e.links.thread_key, Date.parse(e.start)])
  events = events.filter((e) => !(e.type === 'pipeline_action' && e.links.thread_key &&
    threadTimes.some(([k, t]) => k === e.links.thread_key && Math.abs(t - Date.parse(e.start)) < 5 * MIN)))
  // A thread's follow_up_at that mirrors a queued follow-up row (±10 min) is
  // the same follow-up; the queue row is the dispatch authority.
  const queued = events.filter((e) => e.type === 'seller_follow_up' && e.source === 'send_queue' && e.links.thread_key)
  events = events.filter((e) => !(e.type === 'seller_follow_up' && String(e.source).startsWith('inbox_thread_state') &&
    queued.some((q) => q.links.thread_key === e.links.thread_key && Math.abs(Date.parse(q.start) - Date.parse(e.start)) <= 10 * MIN)))
  // A "reply due" the system DID attempt — its send then failed or was blocked —
  // is one fact: the queue row names why it did not go out.
  const attempts = events.filter((e) => e.type === 'scheduled_message' && e.source === 'send_queue' && e.status === 'blocked' && e.links.thread_key)
  events = events.filter((e) => !(e.type === 'seller_follow_up' && e.status === 'not_acted' && e.detail?.reply_marker &&
    attempts.some((q) => q.links.thread_key === e.links.thread_key && Date.parse(q.start) >= Date.parse(e.start) - MIN && Date.parse(q.start) - Date.parse(e.start) <= 60 * MIN)))
  const byKey = new Map()
  const rank = (e) => (String(e.source).startsWith('closing_cases') ? 3 : e.app === 'workflow' ? 2 : 1)
  const out = []
  for (const e of events) {
    if (!e.all_day || !['closing', 'closing_milestone'].includes(e.type) || e.undated) {
      if (!e.dedupe_key) { out.push(e); continue }
    }
    const who = e.links.opportunity_id || e.links.property_id
    const key = e.dedupe_key || (who ? `${who}:${e.title}:${e.date}` : null)
    if (!key) { out.push(e); continue }
    const prev = byKey.get(key)
    if (!prev || rank(e) > rank(prev)) byKey.set(key, e)
  }
  return [...out, ...byKey.values()]
}

/** Deterministic summary counts for a set of events (no scores). */
export function summarizeEvents(events = []) {
  const s = { total: events.length, operator: 0, system: 0, external: 0, blocked: 0, completed: 0, attention: 0, overdue: 0, scheduled_messages: 0, closings: 0, campaigns: 0 }
  for (const e of events) {
    s[e.actor] = (s[e.actor] || 0) + 1
    if (e.attention) s.attention += 1
    if (e.overdue) s.overdue += 1
    if (e.type === 'campaign_sends') s.scheduled_messages += e.count
    if (e.type === 'scheduled_message') s.scheduled_messages += 1
    if (e.type === 'closing') s.closings += 1
    if (e.type === 'campaign_start' || e.type === 'campaign_window') s.campaigns += 1
  }
  return s
}

function humanize(code) {
  const t = clean(code).replace(/_/g, ' ')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function zoneFromGeography(state, zip) {
  if (!clean(state)) return null
  try { return deriveTimezoneFromGeography(state, zip).iana || null } catch { return null }
}

/* ─────────────────────────── desk contract ─────────────────────────── */

const TYPE_META = {
  campaign_window: { lane: 'campaign', kind: 'window' },
  campaign_start: { lane: 'campaign', kind: 'start' },
  campaign_sends: { lane: 'campaign', kind: 'group' },
  scheduled_message: { lane: 'automation', kind: 'message' },
  scheduled_message_group: { lane: 'automation', kind: 'group' },
  seller_follow_up: { lane: 'automation', kind: 'capsule' },
  pipeline_action: { lane: 'automation', kind: 'capsule' },
  offer: { lane: 'closing', kind: 'milestone' },
  closing: { lane: 'closing', kind: 'milestone' },
  closing_milestone: { lane: 'closing', kind: 'deadline' },
  closing_missing_date: { lane: 'closing', kind: 'deadline' },
  workflow_timer: { lane: 'workflow', kind: 'timer' },
  workflow_approval: { lane: 'workflow', kind: 'timer' },
  workflow_held: { lane: 'workflow', kind: 'timer' },
  workflow_run: { lane: 'workflow', kind: 'timer' },
  email_scheduled: { lane: 'automation', kind: 'message' },
}
const HISTORY_STATUS = new Set(['sent', 'done', 'completed', 'occurred', 'closed', 'failed'])

/** The one state an operator reads: UPCOMING / LIVE / WAITING / NEEDS YOU /
 * OVERDUE / COMPLETED / CANCELLED / SUPERSEDED. */
export function eventState(e) {
  const st = clean(e.status)
  if (st === 'cancelled') return 'cancelled'
  if (st === 'superseded') return 'superseded'
  if (HISTORY_STATUS.has(st) || e.actor === 'completed') return 'completed'
  if (st === 'open') return 'live'
  if (e.overdue || ['past_due', 'not_acted', 'missed', 'held', 'blocked', 'stalled', 'overdue'].includes(st) || e.actor === 'blocked') return 'overdue'
  if (st === 'ready' || st === 'starting') return 'upcoming'
  if (st === 'needs_you' || e.owner === 'you') return 'needs_you'
  if (st === 'waiting' || ['seller', 'buyer', 'title', 'external'].includes(e.owner)) return 'waiting'
  return 'upcoming'
}

/** Canonical attention categories — each definition is stated in ATTENTION_DEFINITIONS. */
export function attentionCategory(e) {
  if (!e.attention) return null
  if (e.type === 'closing_missing_date') return 'missing_date'
  if (e.app === 'closing' || e.type === 'closing' || e.type === 'closing_milestone') return 'blocking_closing'
  if (e.type === 'campaign_start' || e.type === 'campaign_sends') return 'missed_campaign_schedule'
  if (e.type === 'workflow_timer' || e.type === 'workflow_held') return 'waiting_too_long'
  if (e.owner === 'you' && (e.overdue || e.status === 'overdue')) return 'overdue'
  return 'stale_follow_up'
}
export const ATTENTION_DEFINITIONS = {
  overdue: 'Yours, and its due time has passed with nothing recording it done.',
  due_today: 'Yours, due later today (operator day).',
  tomorrow: 'Yours, due tomorrow (operator day).',
  missing_date: 'A live deal whose stage needs a date that is not on record.',
  blocking_closing: 'A closing deadline passed unmet, or the Closing Desk marks the closing blocked.',
  stale_follow_up: 'A follow-up or reply whose time passed with no message out and no newer seller message — or a send that did not go out.',
  missed_campaign_schedule: 'A campaign start that passed without activating, or campaign sends past their time that have not gone out.',
  waiting_too_long: 'A workflow timer that ran out more than 15 minutes ago without the run resuming, or a held run.',
}

const WHY = {
  campaign_window: (e) => `${e.subtitle || 'This campaign'} may text sellers only inside its contact window, set in the campaign's market zone. The calendar shows the window, not the individual texts.`,
  campaign_start: (e) => (e.status === 'missed' ? 'The campaign was scheduled to start here and did not activate.' : 'Campaign Command will activate this campaign at this time.'),
  campaign_sends: () => 'These are the campaign texts queued for this day, counted as one block — never shown one by one.',
  seller_follow_up: (e) => (e.owner === 'you' ? 'The seller conversation asked for a human: this review is yours.' : e.detail?.reply_marker ? 'The seller replied and the conversation brain decided a reply was due.' : 'The seller conversation planned a follow-up with this seller; the queue sends it inside the seller\'s contact window.'),
  scheduled_message: (e) => (e.manual ? 'You scheduled this message; the queue sends it at this time inside the seller\'s contact window.' : 'Automation queued this message for this time.'),
  scheduled_message_group: () => 'Several messages in the same state on the same day, gathered so each still names its reason.',
  pipeline_action: () => 'The deal\'s next action in Pipeline is due at this time.',
  closing: () => 'The Closing Desk holds this closing date — it is the authority for it.',
  closing_milestone: (e) => `${e.title} is a contract deadline recorded on the closing case.`,
  closing_missing_date: () => 'The deal reached a stage that needs a closing date, and none is on record.',
  workflow_timer: (e) => `${e.detail?.workflow_name || 'A workflow'} is waiting on a timer; when it runs out the system continues on its own.`,
  workflow_approval: () => 'A workflow paused for a human decision.',
  workflow_held: () => 'A workflow run stopped and cannot continue on its own.',
  workflow_run: () => 'A workflow run finished here — kept as history.',
  offer: () => 'An offer event recorded on the seller offer.',
  email_scheduled: () => 'An email queued in the outbox for this time.',
}

const EDIT = {
  campaign_window: { mode: 'reschedulable', owner_app: 'campaigns', how: 'Change the contact window or pause the campaign in Campaign Command.', effects: ['Every remaining send moves with the window', 'Sends already queued re-space inside the new window', 'The window stays in the campaign\'s market zone'] },
  campaign_start: { mode: 'reschedulable', owner_app: 'campaigns', how: 'Reschedule or activate the start in Campaign Command.', effects: ['Activation moves to the new time', 'A start more than 2 h stale is never auto-fired'] },
  scheduled_message: { mode: 'manual', owner_app: 'inbox', how: 'Reschedule or cancel it from the conversation in Inbox.', effects: ['The queue row keeps its identity (no duplicate send)', 'The seller\'s contact window still applies'] },
  seller_follow_up: { mode: 'read_only', owner_app: 'inbox', how: 'Automation owns this follow-up — stop or take over from the conversation.', effects: [] },
  pipeline_action: { mode: 'read_only', owner_app: 'pipeline', how: 'Change the deal\'s next action in Pipeline.', effects: [] },
  closing: { mode: 'reschedulable', owner_app: 'closing', how: 'Set or confirm the closing date in Closing Desk (closing authority).', effects: ['The prior date stays in the audit trail with your reason', 'A confirmed date plus clear-to-close moves the deal to Prepared to Close', 'Title follow-ups re-time from the new date'] },
  closing_milestone: { mode: 'read_only', owner_app: 'closing', how: 'Contract deadlines change only by amendment, recorded in Closing Desk.', effects: [] },
  workflow_timer: { mode: 'read_only', owner_app: 'workflow', how: 'The timer is pinned by the published version; pause or cancel the run in Workflow Studio.', effects: [] },
  workflow_approval: { mode: 'read_only', owner_app: 'workflow', how: 'Approve or reject in Workflow Studio.', effects: [] },
}

function provenanceFor(e, opTz) {
  const d = e.detail || {}
  switch (e.type) {
    case 'campaign_window': case 'campaign_start': case 'campaign_sends':
      return { scheduled_by: e.type === 'campaign_sends' ? 'Campaign feeder → send queue' : 'Campaign Command schedule', basis: e.type === 'campaign_window' ? `campaigns.contact_window ${d.window || ''}`.trim() : e.source, timezone: e.tz || d.tz || null, timezone_basis: d.zone_count > 1 ? `One of ${d.zone_count} recipient zones (from the campaign's targets)` : Array.isArray(d.tzs) && d.tzs.length > 1 ? `${d.tzs.length} recipient zones — each recipient's own window applies` : 'Campaign market zone (campaign metadata)' }
    case 'seller_follow_up': case 'scheduled_message': case 'scheduled_message_group': {
      const zone = d.seller_zone || null
      return { scheduled_by: d.scheduled_by || (String(e.source).startsWith('inbox_thread_state') ? 'Seller Conversation brain' : e.manual ? 'You (Inbox)' : 'Automation'), basis: d.followup_reason || e.source, policy: d.policy_version || null, timezone: zone, timezone_basis: zone ? 'Seller\'s property zone (state/ZIP) — contact window enforced at dispatch' : 'Stored as an instant (UTC); shown in your zone' }
    }
    case 'closing': case 'closing_milestone': case 'closing_missing_date':
      return { scheduled_by: 'Closing Desk · closing authority', basis: e.source, timezone: e.tz || d.property_tz || null, timezone_basis: e.all_day ? 'Date-only contract term — no clock time is invented' : 'Property\'s zone (state/ZIP)' }
    case 'workflow_timer': case 'workflow_approval': case 'workflow_held': case 'workflow_run':
      return { scheduled_by: `Workflow Studio · ${d.workflow_name || d.workflow_key} v${d.version ?? '?'} (pinned version)`, basis: d.anchor === 'trigger' ? `Timer counts from the triggering event${d.anchor_at ? ` (${d.trigger_event || 'event'})` : ''}` : 'wf_runs.wake_at', timezone: null, timezone_basis: 'Absolute instant — shown in your zone' }
    case 'pipeline_action':
      return { scheduled_by: 'Pipeline', basis: e.source, timezone: null, timezone_basis: `Stored as an instant — shown in your zone (${zoneAbbr(opTz)})` }
    case 'email_scheduled':
      return { scheduled_by: humanize(d.source || 'email outbox'), basis: 'email_queue.scheduled_for', timezone: null, timezone_basis: 'Absolute instant — shown in your zone' }
    default:
      return { scheduled_by: humanize(e.app), basis: e.source, timezone: e.tz || null, timezone_basis: e.tz ? 'Defined in this zone' : 'Shown in your zone' }
  }
}

function deepLink(e) {
  const l = e.links || {}
  const q = (o) => { const s = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v) s.set(k, String(v)); const t = s.toString(); return t ? `?${t}` : '' }
  if (e.app === 'workflow' && l.run_id) return { app: 'workflow', label: 'Open run in Workflow Studio', path: `/workflow-studio${q({ studio: e.detail?.workflow_key, run: l.run_id, node: e.detail?.node_id })}` }
  if (e.app === 'closing' && l.closing_case_id) return { app: 'closing', label: 'Open in Closing Desk', path: `/closing-desk${q({ case: l.closing_case_id })}` }
  if (e.app === 'campaigns' && l.campaign_id) return { app: 'campaigns', label: 'Open in Campaign Command', path: `/campaign-command${q({ campaign: l.campaign_id })}` }
  if (e.app === 'email' && l.email_thread_id) return { app: 'email', label: 'Open in Email Command', path: `/email-command${q({ thread: l.email_thread_id })}` }
  if (e.app === 'pipeline' && l.opportunity_id) return { app: 'pipeline', label: 'Open deal in Pipeline', path: `/pipeline${q({ opp: l.opportunity_id })}` }
  if (l.thread_key) return { app: 'inbox', label: 'Open conversation', path: `/inbox${q({ thread: l.thread_key })}` }
  if (l.opportunity_id) return { app: 'pipeline', label: 'Open deal in Pipeline', path: `/pipeline${q({ opp: l.opportunity_id })}` }
  if (e.type === 'scheduled_message_group') return { app: 'queue', label: 'Open Queue', path: '/queue' }
  return null
}

const NEXT = {
  campaign_window: (e) => (e.status === 'open' ? 'Texts go out as the queue runs, until the window closes' : e.status === 'closed' ? 'Window closed' : 'Opens automatically'),
  seller_follow_up: (e) => (e.status === 'not_acted' ? 'Open the conversation — reply, or let automation retry' : e.owner === 'you' ? 'Review the conversation' : e.status === 'upcoming' ? 'The queue sends it; a seller reply first cancels it' : null),
  workflow_timer: (e) => (e.detail?.next_nodes?.length ? `Then: ${e.detail.next_nodes.map((n) => n.label + (n.exit ? ` (${n.exit})` : '')).join(' → ')}` : 'The run continues'),
  closing: (e) => e.detail?.next?.what || null,
}

/** Adds the desk contract fields. Pure: the same event in, the same fields out. */
export function decorateEvent(e, { tz = 'America/Chicago', now = Date.now() } = {}) {
  const meta = TYPE_META[e.type] || { lane: 'automation', kind: 'capsule' }
  const owner = e.owner || (e.actor === 'operator' ? 'you' : e.actor === 'external' ? 'external' : 'system')
  const ev = { ...e, owner }
  ev.lane = (owner === 'you' || ev.manual) && meta.lane === 'automation' ? 'manual' : meta.lane
  ev.kind = meta.kind
  ev.state = eventState(ev)
  ev.history = ['completed', 'cancelled', 'superseded'].includes(ev.state)
  ev.attention_category = attentionCategory(ev)
  ev.attention_state = !ev.attention ? 'none' : ev.blocking || ev.attention_category === 'blocking_closing' || ev.status === 'held' ? 'blocking' : ev.state === 'overdue' ? 'overdue' : 'attention'
  ev.subject = ev.links?.closing_case_id ? { type: 'closing', id: ev.links.closing_case_id }
    : ev.links?.run_id ? { type: 'workflow_run', id: ev.links.run_id }
      : ev.links?.campaign_id ? { type: 'campaign', id: ev.links.campaign_id }
        : ev.links?.opportunity_id && ev.app === 'pipeline' ? { type: 'deal', id: ev.links.opportunity_id }
          : ev.links?.thread_key ? { type: 'seller', id: ev.links.thread_key } : null
  const edit = ev.type === 'seller_follow_up' && owner === 'you'
    ? { mode: 'read_only', owner_app: 'inbox', how: 'Resolve the review in the conversation — the time is the brain\'s request, not an appointment.', effects: [] }
    : EDIT[ev.type] || { mode: 'read_only', owner_app: ev.app, how: 'Read-only projection of the source record.', effects: [] }
  // Only a scheduled, not-yet-run item can move; history and system follow-ups never can.
  ev.editable = ev.history || (ev.type === 'scheduled_message' && !ev.manual) || (ev.type === 'campaign_start' && ev.status !== 'scheduled' && ev.status !== 'missed')
    ? { mode: 'read_only', owner_app: edit.owner_app, how: ev.history ? 'History — kept for audit.' : edit.how, effects: [] }
    : edit
  ev.actions = writeAuthority(ev, now)
  if (ev.actions) {
    ev.editable = {
      mode: 'reschedulable',
      owner_app: 'inbox',
      how: 'You scheduled this message. Reschedule or cancel it here — it goes through the same queue action the Queue and Inbox use.',
      effects: ['The queue row keeps its identity — no second message is created', 'The seller\'s contact window still applies when it sends'],
    }
  }
  ev.market = clean(ev.detail?.market) || null
  ev.provenance = provenanceFor(ev, tz)
  ev.why = (WHY[ev.type] || (() => null))(ev)
  ev.next = (NEXT[ev.type] || (() => null))(ev)
  ev.deep_link = deepLink(ev)
  return ev
}

/** How far ahead a scheduled send must still be for the calendar to move or cancel it. */
export const WRITE_MIN_LEAD_MINUTES = 10
const MOVABLE_QUEUE = new Set(['scheduled', 'queued'])

/**
 * WRITE AUTHORITY — which canonical write path, if any, this event accepts.
 *
 * Only a message YOU scheduled (send_queue row, manual_scheduled_reply /
 * manual reply) that is still waiting ('scheduled' / 'queued') and is more
 * than WRITE_MIN_LEAD_MINUTES away. The queue's reschedule action sets the
 * row back to 'scheduled' whatever its state, so the calendar must never
 * offer it on a row that is sending, sent, held, blocked or cancelled — and
 * never close to its send time, when the dispatcher may already hold it.
 * Everything else (automation follow-ups, campaign windows, closing dates,
 * workflow timers, email) changes only in the app that owns it.
 */
export function writeAuthority(ev, now = Date.now()) {
  if (ev.type !== 'scheduled_message' || ev.source !== 'send_queue' || !ev.manual || ev.history) return null
  const id = clean(ev.links?.queue_id || ev.source_id)
  const qs = clean(ev.detail?.queue_status)
  const at = Date.parse(ev.start || '')
  if (!id || !MOVABLE_QUEUE.has(qs) || !Number.isFinite(at) || at - now <= WRITE_MIN_LEAD_MINUTES * MIN) return null
  return {
    reschedule: { via: 'queue.reschedule', queue_id: id, min_lead_minutes: WRITE_MIN_LEAD_MINUTES },
    cancel: { via: 'queue.cancel', queue_id: id },
  }
}

/** Per operator day: quiet density by lane (month aggregates, the day rail). */
export function dayAggregates(events = [], { from, to, tz }) {
  const days = {}
  for (let d = from; d <= to; d = addDays(d, 1)) days[d] = { total: 0, campaign: 0, windows: 0, closing: 0, attention: 0, automation: 0, manual: 0, workflow: 0, external: 0, completed: 0, sends: 0, texts: 0, follow_ups: 0, operator: 0, closings: 0 }
  for (const e of events) {
    if (e.undated) continue
    const d = e.all_day && e.date ? e.date : localDate(Date.parse(e.start), tz)
    const a = days[d]
    if (!a) continue
    a.total += 1
    // Activity on the day whether it is still ahead or already happened (the
    // month heatmap's volumes); a cancelled or superseded item never counts.
    const real = e.state !== 'cancelled' && e.state !== 'superseded'
    if (e.type === 'campaign_sends') a.texts += Math.max(0, (e.count || 0) - Number(e.detail?.counts?.cancelled || 0))
    if (real && e.type === 'seller_follow_up') a.follow_ups += 1
    if (real && e.owner === 'you') a.operator += 1
    if (real && e.lane === 'closing') a.closings += 1
    if (e.history) { a.completed += 1; continue }
    if (e.attention) a.attention += 1
    if (e.lane === 'campaign') a.campaign += 1
    if (e.type === 'campaign_window') a.windows += 1
    if (e.type === 'campaign_sends') a.sends += e.count || 0
    if (e.lane === 'closing') a.closing += 1
    if (e.lane === 'workflow') a.workflow += 1
    if (e.owner === 'you') a.manual += 1
    else if (e.owner === 'system') a.automation += 1
    else a.external += 1
  }
  return days
}

/**
 * The attention board — the ATTENTION mode, the header count and the day
 * rail all read THIS; each list is a set of event ids under one canonical
 * definition (ATTENTION_DEFINITIONS).
 */
export function attentionBoard(attention = [], events = [], { today, tomorrow, tz }) {
  const board = { overdue: [], due_today: [], tomorrow: [], missing_date: [], blocking_closing: [], stale_follow_up: [], missed_campaign_schedule: [], waiting_too_long: [] }
  const seen = new Set()
  for (const e of attention) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    const c = e.attention_category
    if (c && board[c]) board[c].push(e.id)
  }
  for (const e of events) {
    if (seen.has(e.id) || e.history || e.owner !== 'you' || e.undated) continue
    const d = e.all_day && e.date ? e.date : localDate(Date.parse(e.start), tz)
    if (d === today) board.due_today.push(e.id)
    else if (d === tomorrow) board.tomorrow.push(e.id)
  }
  return board
}

/** Header counts, each with its stated basis (the reconciliation contract). */
export function telemetryFor(events = [], attention = [], { now, today, tz }) {
  const todays = events.filter((e) => !e.history && !e.undated && (e.all_day ? e.date === today
    : localDate(Date.parse(e.start), tz) === today || (e.end && Date.parse(e.start) < zonedInstant(addDays(today, 1), '00:00', tz) && Date.parse(e.end) > zonedInstant(today, '00:00', tz))))
  // When the next thing happens: a campaign day's next queued row, else the event's start.
  const whenNext = (e) => (e.type === 'campaign_sends' && e.detail?.next_send_at ? Date.parse(e.detail.next_send_at) : Date.parse(e.start))
  const upcoming = events.filter((e) => !e.history && !e.all_day && !e.undated && whenNext(e) > now).sort((a, b) => whenNext(a) - whenNext(b))
  const nextSystem = upcoming.find((e) => e.owner === 'system') || null
  const nextYou = upcoming.find((e) => e.owner === 'you') || null
  const live = events.filter((e) => e.state === 'live')
  const brief = (e) => (e ? { id: e.id, type: e.type, title: e.title, subtitle: e.subtitle, start: e.start, end: e.end, at: iso(whenNext(e)), tz: e.tz, owner: e.owner } : null)
  const attnIds = [...new Set(attention.map((e) => e.id))]
  return {
    today: { total: todays.length, system: todays.filter((e) => e.owner === 'system').length, you: todays.filter((e) => e.owner === 'you').length, external: todays.filter((e) => !['you', 'system'].includes(e.owner)).length, ids: todays.map((e) => e.id) },
    needs_you: { total: attention.filter((e) => e.owner === 'you').length + todays.filter((e) => e.owner === 'you' && !e.attention).length },
    attention: { total: attnIds.length, overdue: attention.filter((e) => e.state === 'overdue' && e.owner === 'you').length },
    live: live.map(brief),
    next: brief(upcoming[0] || null),
    next_system: brief(nextSystem),
    next_you: brief(nextYou),
    basis: {
      today: 'Open (not completed, cancelled or superseded) events on your calendar day; a window that spans today counts once.',
      system: 'Of today\'s open events, those the system owns (campaigns, automation, workflows).',
      needs_you: 'Attention items you own plus today\'s open items you own.',
      attention: 'Distinct attention events over the range and the 14-day lookback (the attention board).',
      next: 'The next open timed event after now.',
      next_you: 'The next open timed event after now that you own. Absent when nothing is waiting on you.',
    },
  }
}

/* ─────────────────────────── loader ─────────────────────────── */

async function source(name, status, fn) {
  try {
    const data = await fn()
    status[name] = 'ok'
    return data
  } catch (error) {
    // One source failing must never take the calendar down.
    status[name] = 'failed'
    console.error('calendar.timeline_source_failed', name, error?.message || error)
    return []
  }
}

const PHONE_TYPES = new Set(['campaign_sends', 'campaign_start', 'campaign_window', 'scheduled_message', 'scheduled_message_group', 'seller_follow_up', 'pipeline_action', 'offer', 'closing', 'closing_milestone'])

export async function getCalendarTimeline({ from, to, tz, propertyId = null, view = null } = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const now = deps.now ? new Date(deps.now).getTime() : Date.now()
  const desk = view === 'desk'
  const zone = isValidZone(tz) ? tz : 'America/Chicago'
  const today = localDate(now, zone)
  const start = /^\d{4}-\d{2}-\d{2}$/.test(clean(from)) ? from : today
  let end = /^\d{4}-\d{2}-\d{2}$/.test(clean(to)) ? to : addDays(start, 13)
  if (end < start) end = start
  if ((Date.parse(end) - Date.parse(start)) / DAY > MAX_RANGE_DAYS) end = addDays(start, MAX_RANGE_DAYS)
  const readFrom = addDays(start < today ? start : today, -LOOKBACK_DAYS)
  const fromAt = zonedInstant(readFrom, '00:00', zone)
  const toAt = zonedInstant(addDays(end, 1), '00:00', zone)
  const status = {}
  const prop = propertyId ? String(propertyId) : null

  const [queueRows, threadRows, opps, campaigns, portfolio, offers, controls, wfRuns, emails, staleReviews] = await Promise.all([
    source('send_queue', status, async () => {
      let q = supabase.from('send_queue')
        .select('id,campaign_id,thread_key,queue_status,scheduled_for,sent_at,message_type,source,property_id,property_address,property_address_state,property_address_zip,seller_display_name,blocked_reason,guard_reason,failed_reason,paused_reason,from_phone_number,execution_policy_version,updated_at,skip_reason:metadata->>skip_reason,cancelled_by:metadata->>cancelled_by,cancellation_reason:metadata->>cancellation_reason,followup_reason:metadata->>followup_reason')
        .or(`and(scheduled_for.gte.${iso(fromAt)},scheduled_for.lt.${iso(toAt)}),and(sent_at.gte.${iso(fromAt)},sent_at.lt.${iso(toAt)})`)
        .limit(5000)
      if (prop) q = q.eq('property_id', prop)
      const { data, error } = await q
      if (error) throw error
      return data || []
    }),
    source('inbox_thread_state', status, async () => {
      let q = supabase.from('inbox_thread_state')
        .select(THREAD_COLUMNS)
        .or(`and(follow_up_at.gte.${iso(fromAt)},follow_up_at.lt.${iso(toAt)}),and(next_action_at.gte.${iso(fromAt)},next_action_at.lt.${iso(toAt)})`)
        .limit(2000)
      if (prop) q = q.eq('property_id', prop)
      const { data, error } = await q
      if (error) throw error
      return data || []
    }),
    source('acquisition_opportunities', status, async () => {
      let q = supabase.from('acquisition_opportunities')
        .select('id,primary_thread_key,primary_property_id,seller_display_name,property_address_full,market,acquisition_stage,opportunity_status,next_action,next_action_due,automation_state,updated_at')
        .gte('next_action_due', iso(fromAt)).lt('next_action_due', iso(toAt))
        .limit(2000)
      if (prop) q = q.eq('primary_property_id', prop)
      const { data, error } = await q
      if (error) throw error
      return data || []
    }),
    prop ? Promise.resolve([]) : source('campaigns', status, async () => {
      const { data, error } = await supabase.from('campaigns')
        .select('id,name,status,market,scheduled_for,contact_window_start,contact_window_end,daily_cap,per_sender_cap,total_cap,metadata,updated_at')
        .in('status', ['scheduled', 'active', 'activating', 'live_limited'])
        .limit(100)
      if (error) throw error
      return data || []
    }),
    // Closings through the Closing Desk's own derivation (its batched loader).
    source('closing_cases', status, async () => {
      const r = await (deps.getClosingPortfolio || getClosingPortfolio)({ now }, { supabase })
      const items = r?.items || []
      if (r?.degraded?.length) status.closing_children = 'partial'
      return prop ? items.filter((x) => String(x.propertyId) === prop) : items
    }),
    source('seller_offers', status, async () => {
      let q = supabase.from('seller_offers')
        .select('id,opportunity_id,property_id,thread_key,status,direction,purchase_price,accepted_price,sent_at,accepted_at,closing_date,emd_due_date')
        .or(`sent_at.gte.${iso(fromAt)},accepted_at.gte.${iso(fromAt)},closing_date.gte.${readFrom},emd_due_date.gte.${readFrom}`)
        .limit(1000)
      if (prop) q = q.eq('property_id', prop)
      const { data, error } = await q
      if (error) throw error
      return data || []
    }),
    source('system_control', status, async () => {
      const { data, error } = await supabase.from('system_control').select('key,value')
        .in('key', ['queue_processor_mode', 'queue_execution_mode', 'queue_emergency_stop_at', 'queue_contact_window_start', 'queue_contact_window_end', 'email_enabled', 'workflow_orchestrator_enabled', 'workflow_orchestrator_heartbeat_at'])
      if (error) throw error
      return data || []
    }),
    !desk ? Promise.resolve([]) : source('wf_runs', status, async () => {
      let q = supabase.from('wf_runs')
        .select('id,workflow_key,version,subject_kind,subject_id,trigger_event_type,state,cursor,wake_at,context,outcome,reason,started_at,updated_at,finished_at')
        .or(`state.in.(${WF_LIVE.join(',')}),finished_at.gte.${iso(fromAt)}`)
        .limit(500)
      if (prop) q = q.eq('context->trigger->>property_id', prop)
      const { data, error } = await q
      if (error) throw error
      return data || []
    }),
    !desk ? Promise.resolve([]) : source('email_queue', status, async () => {
      let q = supabase.from('email_queue')
        .select('id,queue_status,scheduled_for,sent_at,subject,to_email,source,approval_status,cancel_reason,closing_case_id,opportunity_id,property_id,thread_id,updated_at')
        .gte('scheduled_for', iso(fromAt)).lt('scheduled_for', iso(toAt))
        .limit(1000)
      if (prop) q = q.eq('property_id', prop)
      const { data, error } = await q
      if (error) throw error
      return data || []
    }),
    // A review that is YOURS and overdue stays attention however old it is
    // (bounded: 90 days, 200 rows). The range read above stops at the
    // 14-day lookback, which hid a review overdue since Sep 10.
    !desk ? Promise.resolve([]) : source('inbox_thread_state_reviews', status, async () => {
      let q = supabase.from('inbox_thread_state')
        .select(THREAD_COLUMNS)
        .in('next_action', [...OPERATOR_ACTIONS])
        .lt('next_action_at', iso(fromAt)).gte('next_action_at', iso(now - STALE_REVIEW_DAYS * DAY))
        .limit(200)
      if (prop) q = q.eq('property_id', prop)
      const { data, error } = await q
      if (error) throw error
      return data || []
    }),
  ])
  // One row per thread: the range read and the overdue-review read can overlap.
  const threads = [...new Map([...threadRows, ...staleReviews].map((t) => [normThreadKey(t.thread_key) || t.thread_key, t])).values()]

  const ctl = Object.fromEntries((controls || []).map((r) => [r.key, clean(typeof r.value === 'string' ? r.value : JSON.stringify(r.value)).replace(/^"|"$/g, '')]))
  const processor = /^(live|automatic|on|enabled)$/i.test(ctl.queue_processor_mode || '') ? 'live' : /^(off|paused)$/i.test(ctl.queue_processor_mode || '') ? 'off' : ctl.queue_processor_mode ? 'safe' : 'unknown'
  const system = {
    processor,
    execution_mode: ctl.queue_execution_mode || null,
    emergency_stop: Boolean(ctl.queue_emergency_stop_at),
    email_sending: ctl.email_enabled === 'true',
    workflow_orchestrator: ctl.workflow_orchestrator_enabled === 'true',
    workflow_heartbeat_at: ctl.workflow_orchestrator_heartbeat_at || null,
    contact_window: { start: /^\d{2}:\d{2}$/.test(ctl.queue_contact_window_start || '') ? ctl.queue_contact_window_start : '08:00', end: /^\d{2}:\d{2}$/.test(ctl.queue_contact_window_end || '') ? ctl.queue_contact_window_end : '21:00' },
  }
  const window = desk ? system.contact_window : null

  // People/places for threads, in one read (E.164 and 10-digit key forms).
  const threadKeys = [...new Set([...threads.map((t) => normThreadKey(t.thread_key)), ...queueRows.filter((r) => !r.campaign_id).map((r) => normThreadKey(r.thread_key))].filter(Boolean))].slice(0, 300)
  const people = new Map()
  if (threadKeys.length) {
    const variants = [...new Set(threadKeys.flatMap((k) => [k, k.replace(/^\+1/, '')]))]
    const rows = await source('people', status, async () => {
      const { data, error } = await supabase.from('acquisition_opportunities')
        .select('id,primary_thread_key,seller_display_name,property_address_full,acquisition_stage,opportunity_status')
        .in('primary_thread_key', variants)
      if (error) throw error
      return data || []
    })
    for (const r of rows) people.set(normThreadKey(r.primary_thread_key), { opportunity_id: String(r.id), seller: clean(r.seller_display_name) || null, address: clean(r.property_address_full) || null, stage: r.acquisition_stage, opportunity_status: r.opportunity_status })
    const propIds = [...new Set(threads.filter((t) => t.property_id).map((t) => String(t.property_id)))].slice(0, 500)
    if (propIds.length) {
      const props = await source('properties', status, async () => {
        const { data, error } = await supabase.from('properties').select('property_id,property_address_full,property_address_state,property_address_zip').in('property_id', propIds)
        if (error) throw error
        return data || []
      })
      const byId = new Map(props.map((p) => [String(p.property_id), p]))
      for (const t of threads) {
        const k = normThreadKey(t.thread_key)
        const p = byId.get(String(t.property_id || ''))
        if (!p) continue
        const cur = people.get(k) || {}
        people.set(k, { ...cur, address: cur.address || clean(p.property_address_full) || null, zone: zoneFromGeography(p.property_address_state, p.property_address_zip) })
      }
    }
  }

  // Campaign accounting for the campaigns in view.
  const campaignIds = [...new Set([...campaigns.map((c) => c.id), ...queueRows.map((r) => r.campaign_id).filter(Boolean)])]
  const campaignMap = new Map(campaigns.map((c) => [c.id, { ...c, tz: campaignZone(c) }]))
  const missingCampaigns = campaignIds.filter((id) => !campaignMap.has(id))
  if (missingCampaigns.length) {
    const more = await source('campaigns_ref', status, async () => {
      const { data, error } = await supabase.from('campaigns').select('id,name,status,market,metadata').in('id', missingCampaigns.slice(0, 200))
      if (error) throw error
      return data || []
    })
    for (const c of more) campaignMap.set(c.id, { ...c, tz: campaignZone(c) })
  }
  const stats = new Map()
  const perSenderDefault = campaigns.length ? await loadConfiguredPerSenderCap({ supabase }) : null
  if (campaigns.length) {
    const ids = campaigns.map((c) => c.id)
    const [targets, queue] = await Promise.all([
      source('campaign_targets', status, async () => {
        const { data, error } = await supabase.from('campaign_targets').select('campaign_id,target_status').in('campaign_id', ids).limit(50000)
        if (error) throw error
        return data || []
      }),
      source('campaign_queue', status, async () => {
        const { data, error } = await supabase.from('send_queue').select('campaign_id,queue_status,from_phone_number').in('campaign_id', ids).limit(50000)
        if (error) throw error
        return data || []
      }),
    ])
    for (const id of ids) stats.set(id, { audience: 0, held: 0, remaining: 0, eligible: 0, scheduled: 0, sent: 0, senders: 0, _senders: new Set() })
    for (const t of targets) {
      const s = stats.get(t.campaign_id)
      if (!s) continue
      s.audience += 1
      if (t.target_status === 'blocked') s.held += 1
      if (t.target_status === 'ready') s.remaining += 1
    }
    for (const q of queue) {
      const s = stats.get(q.campaign_id)
      if (!s) continue
      if (ACTIVE_QUEUE.includes(q.queue_status)) s.scheduled += 1
      if (DONE_QUEUE.includes(q.queue_status)) s.sent += 1
      if (q.from_phone_number) s._senders.add(q.from_phone_number)
    }
    for (const s of stats.values()) { s.eligible = s.audience - s.held; s.committed = Math.max(0, s.audience - s.remaining - s.held); s.senders = s._senders.size; delete s._senders }
  }

  // Workflow runs: their pinned version graphs, open waits and last steps.
  let wfEvents = []
  if (desk && wfRuns.length) {
    const keys = [...new Set(wfRuns.map((r) => r.workflow_key))]
    const runIds = wfRuns.map((r) => r.id)
    const [vers, wfs, waitRows, steps] = await Promise.all([
      source('wf_versions', status, async () => { const { data, error } = await supabase.from('wf_versions').select('workflow_key,version,graph').in('workflow_key', keys); if (error) throw error; return data || [] }),
      source('wf_workflows', status, async () => { const { data, error } = await supabase.from('wf_workflows').select('workflow_key,name,status,live_version').in('workflow_key', keys); if (error) throw error; return data || [] }),
      source('wf_waits', status, async () => { const { data, error } = await supabase.from('wf_waits').select('run_id,node_id,kind,event_type,title,timeout_at,status,created_at').in('run_id', runIds).eq('status', 'open'); if (error) throw error; return data || [] }),
      source('wf_run_steps', status, async () => { const { data, error } = await supabase.from('wf_run_steps').select('run_id,node_id,kind,status,exit,reason,at').in('run_id', runIds.slice(0, 200)).order('id', { ascending: true }).limit(2000); if (error) throw error; return data || [] }),
    ])
    const stepMap = new Map()
    for (const s of steps) { if (!stepMap.has(s.run_id)) stepMap.set(s.run_id, []); stepMap.get(s.run_id).push({ node: s.node_id, kind: s.kind, status: s.status, exit: s.exit || null, reason: s.reason || null, at: s.at }) }
    for (const r of wfRuns) r.__steps = stepMap.get(r.id) || []
    wfEvents = buildWorkflowEvents(wfRuns, {
      now,
      from: fromAt,
      versions: new Map(vers.map((v) => [`${v.workflow_key}:${v.version}`, v])),
      workflows: new Map(wfs.map((w) => [w.workflow_key, w])),
      waits: new Map(waitRows.map((w) => [String(w.run_id), w])),
    })
  }

  // History is always BUILT (a completed thread follow-up must still absorb its
  // pipeline mirror in dedupe); the phone simply never receives it.
  const raw = [
    ...buildQueueEvents(queueRows, { tz: zone, now, campaigns: campaignMap, people, history: true, window, keepFollowUps: desk }),
    ...buildFollowUpEvents(threads, { now, people, history: true, tz: zone, window }),
    ...buildOpportunityEvents(opps, { now }),
    ...buildCampaignEvents(campaigns, { from: start, to: end, now, stats, perSenderDefault, system }),
    ...buildClosingModelEvents(portfolio, { from: readFrom, to: end, today }),
    ...buildOfferEvents(offers, { from: readFrom, to: end, today, now }),
    ...wfEvents,
    ...buildEmailEvents(emails, { now, sendingEnabled: system.email_sending }),
  ]
  let events = dedupeEvents(raw)
    .filter((e) => desk || (PHONE_TYPES.has(e.type) && !e.history_only))
    .sort((a, b) => (Date.parse(a.start || '') || 0) - (Date.parse(b.start || '') || 0) || (TYPE_ORDER[a.type] ?? 5) - (TYPE_ORDER[b.type] ?? 5))
  if (desk) events = events.map((e) => decorateEvent(e, { tz: zone, now }))

  // In range = shown on days; before range = attention context only.
  const startAt = zonedInstant(start, '00:00', zone)
  const dated = events.filter((e) => !e.undated)
  const inRange = dated.filter((e) => (e.all_day ? e.date >= start && e.date <= end : Date.parse(e.end || e.start) >= startAt))
  // Desk attention is anchored to TODAY (14 days back), never to the range the
  // operator is looking at — so the header count does not move as they navigate.
  const attnFloor = addDays(today, -LOOKBACK_DAYS)
  // An overdue item that is YOURS is never aged out of attention (it is still
  // waiting on you); everything else is bounded by the 14-day floor.
  const attention = events.filter((e) => e.attention && (!desk || e.undated || (e.owner === 'you' && e.state === 'overdue') || (e.all_day && e.date ? e.date : localDate(Date.parse(e.start), zone)) >= attnFloor))

  const todayEvents = inRange.filter((e) => (e.all_day ? e.date === today : localDate(Date.parse(e.start), zone) === today || (e.end && Date.parse(e.start) < zonedInstant(addDays(today, 1), '00:00', zone) && Date.parse(e.end) > zonedInstant(today, '00:00', zone))))
  const next = inRange.find((e) => !e.all_day && Date.parse(e.start) > now && e.actor !== 'completed') || null

  const out = {
    range: { from: start, to: end, tz: zone, today, now: iso(now), lookback_from: readFrom },
    events: inRange,
    attention,
    today: summarizeEvents(todayEvents.filter((e) => !e.history)),
    next_event: next ? { id: next.id, title: next.title, subtitle: next.subtitle, start: next.start, tz: next.tz } : null,
    source_status: status,
    property_scope: prop,
  }
  if (!desk) return out
  const tomorrow = addDays(today, 1)
  return {
    ...out,
    contract: DESK_CONTRACT,
    system,
    days: dayAggregates(inRange, { from: start, to: end, tz: zone }),
    board: attentionBoard(attention, inRange, { today, tomorrow, tz: zone }),
    definitions: ATTENTION_DEFINITIONS,
    telemetry: telemetryFor(inRange, attention, { now, today, tz: zone }),
    campaigns: campaignRoster(campaigns, { stats, now, events, system }),
    authority: {
      write_min_lead_minutes: WRITE_MIN_LEAD_MINUTES,
      basis: 'Only messages you scheduled, still waiting and more than the lead time away, can be rescheduled or cancelled here (the canonical queue actions). Everything else changes in the app that owns it.',
    },
  }
}

/** The desktop contract (CALENDAR 5.0). v5 adds: per-event `market` and `actions`
 * (write authority), the campaign roster, day volumes (texts / follow_ups /
 * operator / closings), telemetry.next_you, and history-only follow-ups on
 * suppressed deals. */
export const DESK_CONTRACT = 'calendar.desk/v5'
