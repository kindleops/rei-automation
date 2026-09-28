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
 * dates — were never read. The nexus stays for desktop; this is what the phone
 * reads.
 *
 * Contract per event:
 *   id, type, source (canonical table), app (owning surface), title, subtitle,
 *   start, end, all_day, time_kind (scheduled | due | expected | window |
 *   occurred), tz (the zone the time is DEFINED in), actor (system | operator |
 *   external | blocked | completed), status, priority (high | normal | info),
 *   overdue, attention, reason, count (groups), links {thread_key,
 *   opportunity_id, campaign_id, property_id, closing_case_id}, detail.
 *
 * Rules that are easy to get wrong, each pinned by a test:
 *   - Campaign sends are ONE group per campaign per operator day, never a row
 *     per message. Send windows are windows, in the CAMPAIGN's market zone.
 *   - A system follow-up whose time passed without running is "automation has
 *     not acted", not an operator overdue.
 *   - Suppressed / archived / dead work is not an event.
 *   - Date-only deadlines (closing, EMD, inspection) are all-day DUE dates; they
 *     are never given an invented clock time.
 *   - A closing date recorded on both the offer and the closing case is one
 *     event (the closing case wins).
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

const DAY = 86_400_000
const MAX_RANGE_DAYS = 62
const LOOKBACK_DAYS = 14 // overdue/attention context before the requested range

const ACTIVE_QUEUE = ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending', 'held', 'retry']
const DONE_QUEUE = ['sent', 'delivered']
const BLOCKED_QUEUE_PREFIX = /^(blocked|failed|paused)/
const LIVE_CAMPAIGN = new Set(['active', 'activating', 'live_limited'])
const DEAD_OPP = new Set(['suppressed', 'dead', 'closed', 'lost', 'archived', 'do_not_contact'])
const OPERATOR_ACTIONS = new Set(['human_review', 'call_seller', 'manual_review', 'operator_review', 'review', 'call'])

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
 * Campaign rows → one group per campaign per operator-local day. Non-campaign
 * rows (Inbox scheduled replies, automation) stay individual.
 */
export function buildQueueEvents(rows = [], { tz, now = Date.now(), campaigns = new Map(), people = new Map() } = {}) {
  const groups = new Map()
  const singles = []
  for (const row of rows) {
    const at = Date.parse(row.scheduled_for || row.sent_at || '')
    if (!Number.isFinite(at)) continue
    const state = queueState(row.queue_status)
    if (row.campaign_id) {
      const key = `${row.campaign_id}:${localDate(at, tz)}`
      const g = groups.get(key) || { campaign_id: row.campaign_id, day: localDate(at, tz), start: at, end: at, counts: { scheduled: 0, sending: 0, sent: 0, blocked: 0, cancelled: 0 }, pastDue: 0, reasons: {} }
      g.start = Math.min(g.start, at)
      g.end = Math.max(g.end, at)
      g.counts[state] += 1
      if (state === 'scheduled' && at < now - 15 * 60_000) g.pastDue += 1
      if (state === 'blocked') {
        const r = clean(row.blocked_reason || row.guard_reason || row.failed_reason || row.paused_reason || row.queue_status)
        g.reasons[r] = (g.reasons[r] || 0) + 1
      }
      groups.set(key, g)
      continue
    }
    // A cancelled send is not a calendar fact anyone acts on.
    if (state === 'cancelled') continue
    const person = people.get(clean(row.thread_key)) || {}
    const pastDue = state === 'scheduled' && at < now - 15 * 60_000
    const reason = state === 'blocked' ? clean(row.blocked_reason || row.guard_reason || row.failed_reason || row.paused_reason || row.queue_status) : null
    singles.push({
      id: `queue:${row.id}`,
      type: 'scheduled_message',
      source: 'send_queue',
      app: 'inbox',
      title: clean(row.message_type) === 'manual_scheduled_reply' ? 'Scheduled reply' : 'Scheduled message',
      subtitle: clean(row.seller_display_name || person.seller) || null,
      place: clean(row.property_address || person.address) || null,
      start: iso(at),
      end: null,
      all_day: false,
      time_kind: state === 'sent' ? 'occurred' : 'scheduled',
      tz: null,
      actor: state === 'blocked' ? 'blocked' : state === 'sent' ? 'completed' : 'system',
      status: pastDue ? 'past_due' : state,
      priority: state === 'blocked' || pastDue ? 'high' : 'normal',
      overdue: pastDue,
      attention: state === 'blocked' || pastDue,
      reason: reason || (pastDue ? 'Send time passed and the message has not gone out' : null),
      count: 1,
      links: { thread_key: clean(row.thread_key) || null, property_id: row.property_id ? String(row.property_id) : null, opportunity_id: person.opportunity_id || null },
      detail: { queue_status: row.queue_status, message_type: row.message_type || null },
    })
  }
  const grouped = []
  for (const g of groups.values()) {
    const c = campaigns.get(g.campaign_id) || {}
    const live = LIVE_CAMPAIGN.has(clean(c.status))
    const total = Object.values(g.counts).reduce((a, b) => a + b, 0)
    const waiting = g.counts.scheduled + g.counts.sending
    // Rows of a campaign that is not live cannot leave (queue/run refuses them).
    const heldByCampaign = g.pastDue > 0 && !live
    const allDone = waiting === 0 && g.counts.blocked === 0
    grouped.push({
      id: `campaign-sends:${g.campaign_id}:${g.day}`,
      type: 'campaign_sends',
      source: 'send_queue',
      app: 'campaigns',
      title: `${total} campaign message${total === 1 ? '' : 's'}`,
      subtitle: clean(c.name) || 'Campaign',
      place: null,
      start: iso(g.start),
      end: g.end > g.start ? iso(g.end) : null,
      all_day: false,
      time_kind: allDone ? 'occurred' : 'scheduled',
      tz: c.tz || null,
      actor: g.counts.blocked > 0 && waiting === 0 ? 'blocked' : allDone ? 'completed' : 'system',
      status: heldByCampaign ? 'held' : allDone ? 'sent' : g.pastDue > 0 ? 'past_due' : 'scheduled',
      priority: heldByCampaign || g.counts.blocked > 0 ? 'high' : 'normal',
      overdue: g.pastDue > 0,
      attention: heldByCampaign || g.pastDue > 0,
      reason: heldByCampaign
        ? `${g.pastDue} message${g.pastDue === 1 ? '' : 's'} past send time — the campaign is ${clean(c.status) || 'not live'}, so they cannot go out`
        : g.pastDue > 0 ? `${g.pastDue} past their send time and not yet sent` : null,
      count: total,
      links: { campaign_id: g.campaign_id },
      detail: { counts: g.counts, blocked_reasons: g.reasons, campaign_status: c.status || null },
    })
  }
  return [...grouped, ...collapseSingles(singles, tz)]
}

/**
 * Many individual sends in the same state on the same day read as one group
 * ("14 scheduled replies failed"), with the members kept for drill-in. Four or
 * more collapse; fewer stay individual.
 */
export function collapseSingles(singles = [], tz = 'UTC', threshold = 4) {
  const buckets = new Map()
  for (const e of singles) {
    const key = `${localDate(Date.parse(e.start), tz)}:${e.status}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(e)
  }
  const out = []
  for (const [key, list] of buckets) {
    if (list.length < threshold) { out.push(...list); continue }
    const first = list[0]
    const starts = list.map((e) => Date.parse(e.start))
    const reasons = {}
    for (const e of list) if (e.reason) reasons[e.reason] = (reasons[e.reason] || 0) + 1
    const label = { blocked: 'failed or blocked', past_due: 'past send time', sent: 'sent', scheduled: 'scheduled', sending: 'sending' }[first.status] || first.status
    out.push({
      ...first,
      id: `messages:${key}`,
      type: 'scheduled_message_group',
      title: `${list.length} messages ${label}`,
      subtitle: Object.keys(reasons).length ? Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r, n]) => `${n} ${humanize(r).toLowerCase()}`).join(' · ') : null,
      place: null,
      start: iso(Math.min(...starts)),
      end: iso(Math.max(...starts)),
      count: list.length,
      links: {},
      reason: first.status === 'blocked' ? 'These sends did not go out. Each one names its reason.' : first.reason,
      detail: { reasons, members: list.slice(0, 60).map((e) => ({ id: e.id, start: e.start, subtitle: e.subtitle, place: e.place, reason: e.reason, thread_key: e.links.thread_key, status: e.status })) },
    })
  }
  return out
}

/**
 * inbox_thread_state follow-ups. follow_up_at and next_action_at usually carry
 * the same instant for the same thread; one event per thread per instant.
 */
export function buildFollowUpEvents(rows = [], { now = Date.now(), people = new Map() } = {}) {
  const out = []
  for (const row of rows) {
    if (row.is_suppressed || row.is_archived) continue
    const person = people.get(clean(row.thread_key)) || {}
    if (person.opportunity_status && DEAD_OPP.has(clean(person.opportunity_status))) continue
    const instants = []
    const fu = Date.parse(row.follow_up_at || '')
    const na = Date.parse(row.next_action_at || '')
    if (Number.isFinite(fu)) instants.push({ at: fu, field: 'follow_up_at' })
    if (Number.isFinite(na) && !(Number.isFinite(fu) && Math.abs(na - fu) < 5 * 60_000)) instants.push({ at: na, field: 'next_action_at' })
    const action = clean(row.next_action)
    const operator = OPERATOR_ACTIONS.has(action)
    for (const { at, field } of instants) {
      const past = at < now
      out.push({
        id: `thread:${row.thread_key}:${field}:${at}`,
        type: 'seller_follow_up',
        source: `inbox_thread_state.${field}`,
        app: 'inbox',
        title: operator ? 'Review seller' : 'Seller follow-up',
        subtitle: person.seller || null,
        place: person.address || null,
        start: iso(at),
        end: null,
        all_day: false,
        time_kind: operator ? 'due' : 'scheduled',
        tz: null,
        actor: operator ? 'operator' : 'system',
        status: past ? (operator ? 'overdue' : 'not_acted') : 'upcoming',
        priority: operator ? 'high' : 'normal',
        overdue: past && operator,
        attention: past,
        reason: past
          ? operator ? 'Waiting on you — this review is past due' : 'Automation has not acted on this follow-up yet'
          : operator ? 'Waiting on you' : 'Automation will follow up if the seller is still eligible',
        count: 1,
        links: { thread_key: clean(row.thread_key) || null, property_id: row.property_id ? String(row.property_id) : null, opportunity_id: person.opportunity_id || null },
        detail: { next_action: action || null, stage: person.stage || row.stage || null, market: row.market || null },
      })
    }
  }
  return out
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
      links: { opportunity_id: String(o.id), thread_key: clean(o.primary_thread_key) || null, property_id: o.primary_property_id ? String(o.primary_property_id) : null },
      detail: { stage: o.acquisition_stage || null, market: o.market || null },
    })
  }
  return out
}

/**
 * Campaign starts + send windows. Windows are defined in the CAMPAIGN's market
 * zone (never the device's) and only projected while the campaign still has
 * eligible sellers to reach, for as many days as its real pace needs.
 */
export function buildCampaignEvents(campaigns = [], { from, to, now = Date.now(), stats = new Map() } = {}) {
  const out = []
  for (const c of campaigns) {
    const status = clean(c.status)
    const tz = campaignZone(c)
    const s = stats.get(c.id) || {}
    const scheduledAt = Date.parse(c.scheduled_for || '')
    const missed = status === 'scheduled' && Number.isFinite(scheduledAt) && now - scheduledAt > 2 * 60 * 60_000
    if (status === 'scheduled' && Number.isFinite(scheduledAt)) {
      out.push({
        id: `campaign:${c.id}:start`,
        type: 'campaign_start',
        source: 'campaigns.scheduled_for',
        app: 'campaigns',
        title: missed ? 'Campaign start missed' : 'Campaign starts',
        subtitle: clean(c.name),
        place: null,
        start: iso(scheduledAt),
        end: null,
        all_day: false,
        time_kind: 'scheduled',
        tz,
        actor: missed ? 'blocked' : 'system',
        status: missed ? 'missed' : scheduledAt < now ? 'starting' : 'scheduled',
        priority: missed ? 'high' : 'normal',
        overdue: missed,
        attention: missed,
        reason: missed ? 'The scheduled start passed without activating. Reschedule or activate it in Campaign Command.' : 'Activates automatically at this time',
        count: 1,
        links: { campaign_id: c.id },
        detail: campaignDetail(c, s),
      })
    }
    if (!tz || missed) continue
    const live = LIVE_CAMPAIGN.has(status)
    if (!live && status !== 'scheduled') continue
    const remaining = Number(s.remaining || 0) + Number(s.scheduled || 0)
    if (remaining <= 0) continue
    const pace = dailyPace(c, s)
    const days = pace > 0 ? Math.ceil(remaining / pace) : 1
    const firstDay = status === 'scheduled' && Number.isFinite(scheduledAt) ? localDate(scheduledAt, tz) : localDate(now, tz)
    for (let i = 0; i < days; i += 1) {
      const day = addDays(firstDay, i)
      if (day < from || day > to) continue
      const start = zonedInstant(day, c.contact_window_start || '08:00', tz)
      const end = zonedInstant(day, c.contact_window_end || '21:00', tz)
      const last = i === days - 1
      out.push({
        id: `campaign:${c.id}:window:${day}`,
        type: 'campaign_window',
        source: 'campaigns.contact_window',
        app: 'campaigns',
        title: 'Send window',
        subtitle: clean(c.name),
        place: null,
        start: iso(i === 0 && Number.isFinite(scheduledAt) && status === 'scheduled' ? Math.max(start, scheduledAt) : start),
        end: iso(end),
        all_day: false,
        time_kind: i === 0 ? 'window' : 'expected',
        tz,
        actor: 'system',
        status: now >= start && now < end && live ? 'open' : now >= end ? 'closed' : 'upcoming',
        priority: 'info',
        overdue: false,
        attention: false,
        reason: i === 0
          ? `Sends between ${c.contact_window_start || '08:00'}–${c.contact_window_end || '21:00'} ${zoneAbbr(tz)}`
          : `Expected — about ${pace}/day at the campaign's real pace${last ? '; last day at this pace' : ''}`,
        count: 1,
        links: { campaign_id: c.id },
        detail: { ...campaignDetail(c, s), day_index: i + 1, projected_days: days, daily_pace: pace },
      })
    }
  }
  return out
}

function campaignZone(c = {}) {
  const tz = clean(c.metadata?.timezone || c.metadata?.launch_timezone)
  return isValidZone(tz) ? tz : null
}

/** Real daily pace: bounded by daily_cap and per_sender_cap × senders in use. */
export function dailyPace(c = {}, s = {}) {
  const daily = Number(c.daily_cap) || 0
  const perSender = Number(c.per_sender_cap) || 0
  const senders = Math.max(1, Number(s.senders || 0))
  const bySender = perSender ? perSender * senders : 0
  const caps = [daily, bySender].filter((n) => n > 0)
  return caps.length ? Math.min(...caps) : 0
}

function campaignDetail(c = {}, s = {}) {
  return {
    status: c.status || null,
    audience: s.audience ?? null,
    eligible: s.eligible ?? null,
    held: s.held ?? null,
    scheduled: s.scheduled ?? null,
    sent: s.sent ?? null,
    remaining: s.remaining ?? null,
    window: c.contact_window_start && c.contact_window_end ? `${c.contact_window_start}–${c.contact_window_end}` : null,
    tz: campaignZone(c),
    daily_cap: c.daily_cap ?? null,
    per_sender_cap: c.per_sender_cap ?? null,
    senders: s.senders ?? null,
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

export function buildClosingEvents(rows = [], { from, to, today } = {}) {
  const out = []
  for (const c of rows) {
    const done = CLOSED_CASE.test(clean(c.closing_status))
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
        links: { closing_case_id: String(c.id), opportunity_id: c.opportunity_id ? String(c.opportunity_id) : null, property_id: c.property_id ? String(c.property_id) : null, thread_key: clean(c.thread_key) || null },
        detail: { closing_status: c.closing_status || null, substage: c.closing_substage || null, title_status: c.title_status || null, escrow_status: c.escrow_status || null, title_company: c.title_company_name || null },
      })
    }
  }
  return out
}

function milestoneMet(c, field) {
  if (field === 'emd_due_date') return /received|verified|complete/.test(clean(c.escrow_status))
  if (field === 'title_commitment_date' || field === 'cure_deadline') return /clear|complete|committed/.test(clean(c.title_status))
  return false
}

export function buildOfferEvents(rows = [], { from, to, today, now = Date.now() } = {}) {
  const out = []
  for (const o of rows) {
    const status = clean(o.status)
    const links = { opportunity_id: o.opportunity_id ? String(o.opportunity_id) : null, property_id: o.property_id ? String(o.property_id) : null, thread_key: clean(o.thread_key) || null }
    const price = Number(o.purchase_price || o.accepted_price || 0) || null
    for (const [field, title] of [['sent_at', 'Offer sent'], ['accepted_at', 'Offer accepted']]) {
      const at = Date.parse(o[field] || '')
      if (!Number.isFinite(at)) continue
      const day = new Date(at).toISOString().slice(0, 10)
      if (day < addDays(from, -1) || day > addDays(to, 1)) continue
      out.push({
        id: `offer:${o.id}:${field}`, type: 'offer', source: `seller_offers.${field}`, app: 'pipeline',
        title, subtitle: price ? `$${Math.round(price).toLocaleString()}` : null, place: null,
        start: iso(at), end: null, all_day: false, time_kind: 'occurred', tz: null,
        actor: 'completed', status: status || 'done', priority: 'normal', overdue: false, attention: false,
        reason: null, count: 1, links, detail: { offer_status: status, direction: o.direction || null },
      })
    }
    if (/withdrawn|superseded|rejected|expired|cancel/.test(status)) continue
    for (const [field, title] of [['emd_due_date', 'EMD due'], ['closing_date', 'Closing']]) {
      const day = clean(o[field]).slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < from || day > to) continue
      const overdue = day < today && field === 'emd_due_date'
      out.push({
        id: `offer:${o.id}:${field}`, type: field === 'closing_date' ? 'closing' : 'closing_milestone', source: `seller_offers.${field}`, app: 'pipeline',
        title, subtitle: price ? `$${Math.round(price).toLocaleString()} offer` : null, place: null,
        start: `${day}T00:00:00.000Z`, date: day, end: null, all_day: true, time_kind: field === 'closing_date' ? 'scheduled' : 'due', tz: null,
        actor: 'operator', status: overdue ? 'overdue' : 'upcoming', priority: 'high', overdue, attention: overdue,
        reason: overdue ? `${title} passed on ${day}` : null, count: 1, links, detail: { offer_status: status },
      })
    }
  }
  void now
  return out
}

/**
 * One real event, one row: a closing/EMD date recorded on both the seller
 * offer and the closing case is the closing case's (it is the later, more
 * authoritative record). Keyed on opportunity (or property) + kind + date.
 */
export function dedupeEvents(events = []) {
  // The pipeline's next_action_due mirrors the thread's follow-up for the same
  // seller: same thread, within five minutes → keep the thread's (it carries
  // the conversation handoff), drop the mirror.
  const threadTimes = events
    .filter((e) => e.type === 'seller_follow_up' && e.links.thread_key)
    .map((e) => [e.links.thread_key, Date.parse(e.start)])
  events = events.filter((e) => !(e.type === 'pipeline_action' && e.links.thread_key &&
    threadTimes.some(([k, t]) => k === e.links.thread_key && Math.abs(t - Date.parse(e.start)) < 5 * 60_000)))
  const byKey = new Map()
  const rank = (e) => (e.source.startsWith('closing_cases') ? 2 : 1)
  const out = []
  for (const e of events) {
    if (!e.all_day || !['closing', 'closing_milestone'].includes(e.type)) { out.push(e); continue }
    const who = e.links.opportunity_id || e.links.property_id
    if (!who) { out.push(e); continue }
    const key = `${who}:${e.title}:${e.date}`
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

export async function getCalendarTimeline({ from, to, tz, propertyId = null } = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const now = deps.now ? new Date(deps.now).getTime() : Date.now()
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

  const [queueRows, threads, opps, campaigns, closings, offers] = await Promise.all([
    source('send_queue', status, async () => {
      let q = supabase.from('send_queue')
        .select('id,campaign_id,thread_key,queue_status,scheduled_for,sent_at,message_type,property_id,property_address,seller_display_name,blocked_reason,guard_reason,failed_reason,paused_reason,from_phone_number')
        .or(`and(scheduled_for.gte.${iso(fromAt)},scheduled_for.lt.${iso(toAt)}),and(sent_at.gte.${iso(fromAt)},sent_at.lt.${iso(toAt)})`)
        .limit(5000)
      if (prop) q = q.eq('property_id', prop)
      const { data, error } = await q
      if (error) throw error
      return data || []
    }),
    source('inbox_thread_state', status, async () => {
      let q = supabase.from('inbox_thread_state')
        .select('thread_key,property_id,market,stage,next_action,follow_up_at,next_action_at,is_suppressed,is_archived')
        .or(`and(follow_up_at.gte.${iso(fromAt)},follow_up_at.lt.${iso(toAt)}),and(next_action_at.gte.${iso(fromAt)},next_action_at.lt.${iso(toAt)})`)
        .limit(2000)
      if (prop) q = q.eq('property_id', prop)
      const { data, error } = await q
      if (error) throw error
      return data || []
    }),
    source('acquisition_opportunities', status, async () => {
      let q = supabase.from('acquisition_opportunities')
        .select('id,primary_thread_key,primary_property_id,seller_display_name,property_address_full,market,acquisition_stage,opportunity_status,next_action,next_action_due,automation_state')
        .gte('next_action_due', iso(fromAt)).lt('next_action_due', iso(toAt))
        .limit(2000)
      if (prop) q = q.eq('primary_property_id', prop)
      const { data, error } = await q
      if (error) throw error
      return data || []
    }),
    prop ? Promise.resolve([]) : source('campaigns', status, async () => {
      const { data, error } = await supabase.from('campaigns')
        .select('id,name,status,scheduled_for,contact_window_start,contact_window_end,daily_cap,per_sender_cap,total_cap,metadata')
        .in('status', ['scheduled', 'active', 'activating', 'live_limited'])
        .limit(100)
      if (error) throw error
      return data || []
    }),
    source('closing_cases', status, async () => {
      let q = supabase.from('closing_cases')
        .select('id,opportunity_id,property_id,property_address,thread_key,signer_name,closing_status,closing_substage,title_status,escrow_status,title_company_name,emd_due_date,inspection_deadline,title_commitment_date,cure_deadline,signing_date,scheduled_closing_date,funding_date,recording_date,title_opened_date,contract_signed_date,effective_date')
        .limit(500)
      if (prop) q = q.eq('property_id', prop)
      const { data, error } = await q
      if (error) throw error
      return data || []
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
  ])

  // People/places for threads, in one read.
  const threadKeys = [...new Set([...threads.map((t) => clean(t.thread_key)), ...queueRows.filter((r) => !r.campaign_id).map((r) => clean(r.thread_key))].filter(Boolean))]
  const people = new Map()
  if (threadKeys.length) {
    const rows = await source('people', status, async () => {
      const { data, error } = await supabase.from('acquisition_opportunities')
        .select('id,primary_thread_key,seller_display_name,property_address_full,acquisition_stage,opportunity_status')
        .in('primary_thread_key', threadKeys.slice(0, 500))
      if (error) throw error
      return data || []
    })
    for (const r of rows) people.set(clean(r.primary_thread_key), { opportunity_id: String(r.id), seller: clean(r.seller_display_name) || null, address: clean(r.property_address_full) || null, stage: r.acquisition_stage, opportunity_status: r.opportunity_status })
    const missingProps = [...new Set(threads.filter((t) => !people.get(clean(t.thread_key))?.address && t.property_id).map((t) => String(t.property_id)))]
    if (missingProps.length) {
      const props = await source('properties', status, async () => {
        const { data, error } = await supabase.from('properties').select('property_id,property_address_full').in('property_id', missingProps.slice(0, 500))
        if (error) throw error
        return data || []
      })
      const addr = new Map(props.map((p) => [String(p.property_id), clean(p.property_address_full)]))
      for (const t of threads) {
        const k = clean(t.thread_key)
        const p = people.get(k) || {}
        if (!p.address && t.property_id && addr.get(String(t.property_id))) people.set(k, { ...p, address: addr.get(String(t.property_id)) })
      }
    }
  }

  // Campaign accounting for the campaigns in view.
  const campaignIds = [...new Set([...campaigns.map((c) => c.id), ...queueRows.map((r) => r.campaign_id).filter(Boolean)])]
  const campaignMap = new Map(campaigns.map((c) => [c.id, { ...c, tz: campaignZone(c) }]))
  const missingCampaigns = campaignIds.filter((id) => !campaignMap.has(id))
  if (missingCampaigns.length) {
    const more = await source('campaigns_ref', status, async () => {
      const { data, error } = await supabase.from('campaigns').select('id,name,status,metadata').in('id', missingCampaigns.slice(0, 200))
      if (error) throw error
      return data || []
    })
    for (const c of more) campaignMap.set(c.id, { ...c, tz: campaignZone(c) })
  }
  const stats = new Map()
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
    for (const s of stats.values()) { s.eligible = s.audience - s.held; s.senders = s._senders.size; delete s._senders }
  }

  const events = dedupeEvents([
    ...buildQueueEvents(queueRows, { tz: zone, now, campaigns: campaignMap, people }),
    ...buildFollowUpEvents(threads, { now, people }),
    ...buildOpportunityEvents(opps, { now }),
    ...buildCampaignEvents(campaigns, { from: start, to: end, now, stats }),
    ...buildClosingEvents(closings, { from: readFrom, to: end, today }),
    ...buildOfferEvents(offers, { from: readFrom, to: end, today, now }),
  ]).sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || (TYPE_ORDER[a.type] ?? 5) - (TYPE_ORDER[b.type] ?? 5))

  // In range = shown on days; before range = attention context only.
  const startAt = zonedInstant(start, '00:00', zone)
  const inRange = events.filter((e) => (e.all_day ? e.date >= start && e.date <= end : Date.parse(e.end || e.start) >= startAt))
  const attention = events.filter((e) => e.attention)

  const todayEvents = inRange.filter((e) => (e.all_day ? e.date === today : localDate(Date.parse(e.start), zone) === today || (e.end && Date.parse(e.start) < zonedInstant(addDays(today, 1), '00:00', zone) && Date.parse(e.end) > zonedInstant(today, '00:00', zone))))
  const next = inRange.find((e) => !e.all_day && Date.parse(e.start) > now && e.actor !== 'completed') || null

  return {
    range: { from: start, to: end, tz: zone, today, now: iso(now), lookback_from: readFrom },
    events: inRange,
    attention,
    today: summarizeEvents(todayEvents),
    next_event: next ? { id: next.id, title: next.title, subtitle: next.subtitle, start: next.start, tz: next.tz } : null,
    source_status: status,
    property_scope: prop,
  }
}
