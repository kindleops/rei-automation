/**
 * CAMPAIGN COCKPIT MODEL — desktop.
 *
 * Every decision the operating room makes about a campaign, as pure functions
 * over the list row (CampaignSummary) and, when it has loaded, the campaign's
 * cockpit read. Nothing is estimated: a value neither carries is left out or
 * said to be unavailable — never approximated, never zero.
 */
import { describeNotSchedulable } from '../campaign-launch-plan'
import type { CampaignSummary } from '../campaigns.types'
import { describeBlocker } from '../campaign-operator-language'
import { displayName } from '../mobile/campaign-index-model'
import type { CockpitRead, CockpitWindow } from './cockpit-api'

const lower = (v: unknown) => String(v ?? '').trim().toLowerCase()
export const nf = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString())
const plural = (n: number, one: string, many = `${one}s`) => `${nf(n)} ${n === 1 ? one : many}`

export const LIVE_STATUSES = ['active', 'activating', 'live_limited']
const SCHEDULED_STATUSES = ['scheduled', 'queued']
const PRELAUNCH_STATUSES = ['draft', 'built', 'previewed', 'ready']

export const isLive = (c: Pick<CampaignSummary, 'status'>) => LIVE_STATUSES.includes(lower(c.status))

/** Heartbeats older than these mean the job is not running, not merely idle. */
export const FEEDER_STALE_MS = 15 * 60 * 1000
export const PROCESSOR_STALE_MS = 5 * 60 * 1000

// ── time ────────────────────────────────────────────────────────────────────

export function ago(iso: string | null | undefined, now = Date.now()): string | null {
  const t = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(t)) return null
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''} ago`
  return `${Math.round(h / 24)} days ago`
}

export function until(iso: string | null | undefined, now = Date.now()): string | null {
  const t = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(t)) return null
  const m = Math.round((t - now) / 60000)
  if (m <= 0) return 'now'
  if (m < 60) return `in ${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `in ${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  return `in ${Math.round(h / 24)} days`
}

/** "8:00 AM CDT" in the campaign's zone; falls back to the viewer's zone, labelled. */
export function clockIn(iso: string | null | undefined, timeZone?: string | null): string | null {
  const t = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(t)) return null
  try {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timeZone || undefined, timeZoneName: 'short' }).format(new Date(t))
  } catch {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(t))
  }
}

/** "Sep 29, 8:00 AM CDT" — or just the time when it is today in that zone. */
export function whenIn(iso: string | null | undefined, timeZone?: string | null, now = Date.now()): string | null {
  const t = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(t)) return null
  const tz = timeZone || undefined
  const day = (d: number) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d))
  const clock = clockIn(iso, timeZone)
  if (day(t) === day(now)) return clock
  const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz }).format(new Date(t))
  return `${date}, ${clock}`
}

// ── words for canonical codes ───────────────────────────────────────────────

const HOLD_WORDS: Record<string, string> = {
  entity_contact_requires_review: 'Company owner — contact needs review',
  missing_identity_linkage: 'Owner identity not linked',
  identity_unknown_policy: 'Owner identity unknown',
  ambiguous_phone_ownership: 'Phone ownership unclear',
  prior_contacted_suppression: 'Contacted before',
  renter_not_owner: 'Renter, not the owner',
  likely_renter: 'Likely a renter',
  owner_identity_not_verified: 'Owner not verified',
  missing_to_phone_number: 'No phone number',
  // Template holds (rc-7.1 D2/D8): released automatically when templates change.
  'template_hold:NO_TEMPLATE': 'No approved message for their language — waiting for one',
  'template_hold:TEMPLATE_RENDER_LINT_FAILURE': 'Message failed the template check — waiting for a template change',
  'template_hold:TEMPLATE_GOVERNANCE_PAUSED': 'Every fitting message is paused — waiting for an approved one',
}

const RELEASE_WORDS: Record<string, string> = {
  logical_communication_store_error: 'the send record couldn’t be written',
  campaign_paused: 'the campaign is paused',
  campaign_state_unreadable: 'the campaign’s state couldn’t be read',
  deferred_contact_window: 'outside the contact window',
  outbound_number_ineligible: 'the sending number isn’t allowed to send',
  missing_seller_first_name: 'no seller first name',
}

const FEEDER_SKIP_WORDS: Record<string, string> = {
  ROUTING_BLOCKED: 'no sender for their market',
  routing_blocked: 'no sender for their market',
  sender_blocked_by_operator: 'the sender is blocked by an operator',
  local_senders_unavailable: 'their market’s numbers are paused or cooling',
  no_local_sender_number: 'no sender number in their market',
  TEMPLATE_RENDER_LINT_FAILURE: 'the message failed the template check',
  NO_TEMPLATE: 'no approved message for their language',
  TEMPLATE_GOVERNANCE_PAUSED: 'every fitting message is paused by template governance',
  per_sender_cap_reached: 'sender daily limit reached',
  per_market_cap_reached: 'market cap reached',
  schedule_window_full: 'today’s window is full',
  missing_to_phone_number: 'no phone number',
  prior_contacted_suppression: 'contacted before',
  graph_suppression_or_queue_block: 'suppressed',
}

function humanize(code: string): string {
  const text = String(code ?? '').replace(/[_:.-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase() : 'Other'
}

export function holdWords(code: string): string {
  if (HOLD_WORDS[code]) return HOLD_WORDS[code]
  const pool = code.match(/^insufficient_template_rotation_pool:([^:]+):/)
  if (pool) return pool[1] === 'auto' ? 'Too few approved messages to rotate' : `Too few approved ${pool[1]} messages`
  if (code.startsWith('unsupported_language:')) return `No messages in ${code.split(':')[1]}`
  return humanize(code)
}
export const releaseWords = (code: string) => RELEASE_WORDS[code] ?? humanize(code).toLowerCase()
export const feederSkipWords = (code: string) => FEEDER_SKIP_WORDS[code] ?? humanize(code).toLowerCase()

// ── lineage ─────────────────────────────────────────────────────────────────

export type SourceInfo = { kind: string; label: string; detail: string | null }

export function sourceOf(c: CampaignSummary, k?: CockpitRead | null): SourceInfo {
  const lineage = k?.lineage ?? c.lineage ?? null
  if (!lineage) return { kind: 'unknown', label: 'Source unavailable', detail: null }
  const n = lineage.explicit_property_count
  switch (lineage.kind) {
    case 'map_area':
      return { kind: 'map_area', label: 'Map area', detail: n ? `${nf(n)} properties` : null }
    case 'entity_graph':
      return { kind: 'entity_graph', label: 'Entity Graph', detail: n ? `${nf(n)} selected` : null }
    case 'selection':
      return { kind: 'selection', label: 'Selected properties', detail: n ? nf(n) : null }
    case 'filters':
      return { kind: 'filters', label: 'Filters', detail: plural(lineage.filters.length, 'condition') }
    default:
      // An audience can predate the stored definition format: it is real (its
      // targets exist), only how it was chosen is not on the row.
      return c.total_targets > 0 || (k?.targets?.total ?? 0) > 0
        ? { kind: 'none', label: 'Built audience', detail: 'definition not stored' }
        : { kind: 'none', label: 'No audience defined', detail: null }
  }
}

// ── execution state ─────────────────────────────────────────────────────────

export type ExecKey = 'running' | 'waiting' | 'degraded' | 'needs_you' | 'paused' | 'scheduled' | 'ready' | 'draft' | 'completed' | 'archived'
export type ExecTone = 'exec' | 'wait' | 'bad' | 'warn' | 'muted' | 'ok' | 'plan'
export type ExecState = { key: ExecKey; label: string; tone: ExecTone }

const STATE: Record<ExecKey, ExecState> = {
  running: { key: 'running', label: 'Running', tone: 'exec' },
  waiting: { key: 'waiting', label: 'Waiting for window', tone: 'wait' },
  degraded: { key: 'degraded', label: 'Degraded', tone: 'bad' },
  needs_you: { key: 'needs_you', label: 'Needs you', tone: 'warn' },
  paused: { key: 'paused', label: 'Paused', tone: 'muted' },
  scheduled: { key: 'scheduled', label: 'Scheduled', tone: 'plan' },
  ready: { key: 'ready', label: 'Ready', tone: 'plan' },
  draft: { key: 'draft', label: 'Draft', tone: 'muted' },
  completed: { key: 'completed', label: 'Completed', tone: 'ok' },
  archived: { key: 'archived', label: 'Archived', tone: 'muted' },
}

export type AttentionAction = { id: string; label: string }
export type Attention = {
  key: string
  severity: 'degraded' | 'needs_you'
  title: string
  detail: string
  stopped: string | null
  todo: string
  actions: AttentionAction[]
}

function liveQueueOf(c: CampaignSummary, k?: CockpitRead | null) {
  return k?.queue ?? c.live_queue ?? null
}

function sortedEntries(bag: Record<string, number> | null | undefined): Array<[string, number]> {
  return Object.entries(bag ?? {}).filter(([, n]) => Number(n) > 0).sort((a, b) => b[1] - a[1])
}

/**
 * What needs a person, for one campaign — each item says what happened, how
 * many, whether it is stopped, and what to do, with an existing action.
 * Ordered: degraded execution first.
 */
export function attentionFor(c: CampaignSummary, k?: CockpitRead | null, now = Date.now()): Attention[] {
  const status = lower(c.status)
  const out: Attention[] = []
  const tz = k?.window.timezone ?? c.lineage?.timezone ?? null

  if (SCHEDULED_STATUSES.includes(status) && c.schedule_missed_for) {
    out.push({
      key: 'missed_start',
      severity: 'needs_you',
      title: 'Missed its scheduled start',
      detail: `It was due ${whenIn(c.schedule_missed_for, tz, now) ?? 'earlier'} and did not launch.`,
      stopped: 'Nothing has been sent.',
      todo: 'Reschedule it, or launch it yourself.',
      actions: [{ id: 'reschedule', label: 'Reschedule' }],
    })
  }
  if (status === 'failed') {
    out.push({
      key: 'launch_failed',
      severity: 'needs_you',
      title: 'The last launch didn’t complete',
      detail: 'The campaign is in a failed state.',
      stopped: 'Nothing new is being sent.',
      todo: 'Open setup to review it, or restore it to a draft.',
      actions: [{ id: 'edit', label: 'Open setup' }],
    })
  }
  if (!LIVE_STATUSES.includes(status)) return out

  // System-wide stops outrank everything: nothing this campaign does matters.
  if (k) {
    const p = k.processor
    if (p.emergency_stop_at) {
      out.push({
        key: 'emergency_stop', severity: 'degraded',
        title: 'Sending is emergency-stopped system-wide',
        detail: `Stop set ${whenIn(p.emergency_stop_at, tz, now) ?? ''}.`.trim(),
        stopped: 'Yes — no message leaves until it is lifted.',
        todo: 'Queue controls lift the stop.',
        actions: [{ id: 'route:/queue', label: 'Open Queue' }],
      })
    } else if ((p.mode && p.mode !== 'live') || p.outbound_sms === false || (p.execution_mode && lower(p.execution_mode) !== 'normal')) {
      const exec = lower(p.execution_mode)
      out.push({
        key: 'processor_off', severity: 'degraded',
        title: 'Sending is switched off system-wide',
        detail: p.outbound_sms === false ? 'Outbound SMS is disabled.'
          : p.mode && p.mode !== 'live' ? `The queue processor is in “${p.mode}” mode.`
            : exec === 'scoped_canary_only' ? 'Only individually authorised canary sends may go out.'
              : `Queue execution is “${exec}”.`,
        stopped: 'Yes — queued messages wait until it is switched back on.',
        todo: 'Queue controls switch it back on.',
        actions: [{ id: 'route:/queue', label: 'Open Queue' }],
      })
    }
    // Heartbeat age AS OF THE READ, not the clock: a read that is a few
    // minutes old (background tab, slow poll) must not invent a silent job.
    const readAt = Number.isFinite(Date.parse(k.at)) ? Math.min(now, Date.parse(k.at)) : now
    const feederAge = readAt - Date.parse(String(k.feeder.heartbeat_at ?? ''))
    if (!k.feeder.heartbeat_at || !(feederAge < FEEDER_STALE_MS)) {
      out.push({
        key: 'feeder_stale', severity: 'degraded',
        title: k.feeder.heartbeat_at ? 'The campaign feeder has stopped checking in' : 'The campaign feeder has never checked in',
        detail: k.feeder.heartbeat_at ? `Last heartbeat ${ago(k.feeder.heartbeat_at, now)}.` : 'No heartbeat on record.',
        stopped: 'New messages are not being queued; what is already queued can still send.',
        todo: 'This is the scheduler, not a campaign setting — escalate it.',
        actions: [],
      })
    }
    const procAge = readAt - Date.parse(String(k.processor.heartbeat_at ?? ''))
    if (!k.processor.heartbeat_at || !(procAge < PROCESSOR_STALE_MS)) {
      out.push({
        key: 'processor_stale', severity: 'degraded',
        title: 'The queue processor has stopped checking in',
        detail: k.processor.heartbeat_at ? `Last heartbeat ${ago(k.processor.heartbeat_at, now)}.` : 'No heartbeat on record.',
        stopped: 'Queued messages are not being sent.',
        todo: 'This is the scheduler, not a campaign setting — escalate it.',
        actions: [],
      })
    }
  }

  const q = liveQueueOf(c, k)
  if (q && q.overdue > 0) {
    const lastSent = k?.sends.last_sent_at ?? null
    const reasons = sortedEntries(q.release_reasons)
    const refused = reasons.reduce((n, [, v]) => n + v, 0)
    const retries = k?.queue?.spam_retries ?? 0
    const ledger = q.release_reasons?.logical_communication_store_error ?? 0
    const bits = [`Due since ${whenIn(q.oldest_due_at, tz, now) ?? 'earlier'}.`]
    bits.push(lastSent ? `The last message went out ${whenIn(lastSent, tz, now)}.` : (k ? 'Nothing has gone out yet.' : ''))
    if (retries && retries === q.live) bits.push(`All ${nf(retries)} are retries of first texts the carrier filtered.`)
    if (q.last_claimed_at) bits.push(`The processor last picked them up ${whenIn(q.last_claimed_at, tz, now)} and sent none.`)
    if (refused) bits.push(`${nf(refused)} ${refused === 1 ? 'was' : 'were'} released before reaching the carrier: ${reasons.map(([code, n]) => `${releaseWords(code)} (${nf(n)})`).join(', ')}.`)
    out.push({
      key: 'overdue',
      severity: 'degraded',
      title: `${plural(q.overdue, 'message')} overdue in the queue`,
      detail: bits.filter(Boolean).join(' '),
      stopped: 'Not paused — the campaign is active, but these messages are not going out.',
      todo: ledger
        ? 'The dispatch record for these messages can’t be written, so they need an engineering fix before they can send. Pausing holds them and stops new messages.'
        : 'Check the senders and the processor below; pausing holds them and stops new messages.',
      actions: [{ id: 'pause', label: 'Pause campaign' }, { id: 'view_targets', label: 'Show affected sellers' }],
    })
  }

  if (c.quarantined) {
    const qd = k?.flags.quarantine
    const total = k?.targets?.total ?? c.total_targets
    const detail = qd && qd.target_rows && qd.selected_properties
      ? `Flagged ${whenIn(qd.quarantined_at, tz, now) ?? ''}: ${nf(qd.rows_outside_selection)} of ${nf(qd.target_rows)} targets were outside the ${nf(qd.selected_properties)} selected properties. The audience has ${nf(total)} targets now.`
      : describeBlocker(c.quarantine_reason, c.quarantine_reason)
    out.push({
      key: 'hold',
      severity: 'needs_you',
      title: 'On hold: the audience reached beyond the selection',
      detail,
      stopped: null,
      todo: 'Review the targeting in setup.',
      actions: [{ id: 'edit', label: 'Review targeting' }],
    })
  }

  const total = k?.targets?.total ?? c.total_targets
  if (total === 0) {
    out.push({
      key: 'no_audience',
      severity: 'needs_you',
      title: 'Active, but its audience is empty',
      detail: `0 targets${c.sent_count > 0 ? ` — ${nf(c.sent_count)} sent before the audience emptied` : ''}. The feeder finds nothing to send on every pass.`,
      stopped: 'Nothing can send.',
      todo: 'Rebuild the audience in setup, or pause the campaign.',
      actions: [{ id: 'edit', label: 'Open setup' }, { id: 'pause', label: 'Pause' }],
    })
  }

  const fl = k?.feeder.campaign_last ?? (c.feeder_last as (typeof c.feeder_last & { skipped_counts_by_reason?: Record<string, number> }) | null) ?? null
  const ready = k?.targets?.ready ?? c.ready_targets
  const skipped = sortedEntries((fl as { skipped_counts_by_reason?: Record<string, number> } | null)?.skipped_counts_by_reason)
  if (fl && Number(fl.inserted ?? 0) === 0 && ready > 0 && skipped.length && fl.bound !== 'buffer_full') {
    // Name the numbers behind a sender reason: "Miami, FL (84) — +1305… blocked by an operator; +1786… cooling".
    const senderDetail = describeNotSchedulable(
      Object.fromEntries(skipped),
      (fl as { routing_blocks_by_market?: Parameters<typeof describeNotSchedulable>[1] }).routing_blocks_by_market ?? null,
    ).flatMap((line) => line.details).slice(0, 2)
    out.push({
      key: 'not_placed',
      severity: 'needs_you',
      title: `${plural(ready, 'ready seller')} couldn’t be queued`,
      detail: `The last feeder pass${fl.at ? ` (${ago(fl.at, now)})` : ''} placed none: ${skipped.map(([code, n]) => `${feederSkipWords(code)} (${nf(n)})`).join(', ')}.`
        + (senderDetail.length ? ` ${senderDetail.join(' · ')}.` : ''),
      stopped: 'These sellers wait; everything else continues.',
      todo: 'Check the numbers for these sellers’ markets.',
      actions: [{ id: 'inspector:channels', label: 'Review senders' }],
    })
  } else if (fl?.stalled) {
    out.push({
      key: 'stalled',
      severity: 'needs_you',
      title: 'The feeder is stalled on this campaign',
      detail: `Ready sellers remain but none could be placed${fl.reason ? ` (${feederSkipWords(fl.reason)})` : ''}.`,
      stopped: 'No new messages are being queued.',
      todo: 'Review the audience and senders.',
      actions: [{ id: 'inspector:audience', label: 'Review audience' }],
    })
  }

  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'degraded' ? -1 : 1))
}

export function execState(c: CampaignSummary, k?: CockpitRead | null, now = Date.now()): ExecState {
  const status = lower(c.status)
  if (status === 'archived') return STATE.archived
  if (status === 'completed') return STATE.completed
  if (status === 'paused') return STATE.paused
  const issues = attentionFor(c, k, now)
  if (issues.some((i) => i.severity === 'degraded')) return STATE.degraded
  if (issues.length) return STATE.needs_you
  if (SCHEDULED_STATUSES.includes(status)) return STATE.scheduled
  if (PRELAUNCH_STATUSES.includes(status) || !status) return c.total_targets > 0 ? STATE.ready : STATE.draft
  if (!LIVE_STATUSES.includes(status)) return STATE.draft
  if (k?.window.open === false) return STATE.waiting
  return STATE.running
}

// ── navigation ──────────────────────────────────────────────────────────────

export type NavGroup = 'needs_you' | 'active' | 'scheduled' | 'paused' | 'drafts' | 'completed' | 'archived'

export const NAV_GROUPS: Array<{ key: NavGroup; label: string }> = [
  { key: 'needs_you', label: 'Needs you' },
  { key: 'active', label: 'Active' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'paused', label: 'Paused' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'completed', label: 'Recently completed' },
  { key: 'archived', label: 'Archived' },
]

export function navGroupOf(c: CampaignSummary, k?: CockpitRead | null, now = Date.now()): NavGroup {
  const state = execState(c, k, now)
  switch (state.key) {
    case 'degraded':
    case 'needs_you': return 'needs_you'
    case 'running':
    case 'waiting': return 'active'
    case 'scheduled': return 'scheduled'
    case 'paused': return 'paused'
    case 'completed': return 'completed'
    case 'archived': return 'archived'
    default: return 'drafts'
  }
}

export type NavFilters = { status: 'all' | NavGroup; channel: 'all' | 'sms'; market: string; source: string; query: string }
export const DEFAULT_FILTERS: NavFilters = { status: 'all', channel: 'all', market: 'all', source: 'all', query: '' }

export function matchesNav(
  c: CampaignSummary,
  f: NavFilters,
  ctx: { group: NavGroup; markets: string[] },
): boolean {
  if (f.status === 'all' ? ctx.group === 'archived' : ctx.group !== f.status) return false
  if (f.channel !== 'all' && (c.lineage?.channel ?? 'sms') !== f.channel) return false
  if (f.source !== 'all' && (c.lineage?.kind ?? 'unknown') !== f.source) return false
  if (f.market !== 'all' && !ctx.markets.includes(f.market)) return false
  const q = lower(f.query)
  if (!q) return true
  const hay = [
    c.campaign_name, c.id, ...ctx.markets, sourceOf(c).label,
    c.lineage?.stage_code, c.lineage?.template_use_case, c.lineage?.template_use_case?.replace(/_/g, ' '),
  ].map(lower).join(' ')
  return q.split(/\s+/).every((word) => hay.includes(word))
}

export type NavRow = {
  id: string
  title: string
  subtitle: string | null
  state: ExecState
  source: SourceInfo
  channel: string
  progress: { sent: number; of: number; pct: number } | null
  result: string | null
  exception: string | null
  inactive: boolean
}

export function navRow(c: CampaignSummary, k?: CockpitRead | null, now = Date.now()): NavRow {
  const name = displayName(c)
  const state = execState(c, k, now)
  const source = sourceOf(c, k)
  const total = k?.targets?.total ?? c.total_targets
  const held = k?.targets?.held ?? c.held_targets ?? 0
  const eligible = Math.max(0, total - held)
  const sent = k?.send_states?.sent ?? c.sent_count
  const delivered = k?.send_states?.delivered ?? c.delivered_count
  const status = lower(c.status)
  const prelaunch = PRELAUNCH_STATUSES.includes(status) || !status
  const progress = eligible > 0 && sent > 0 ? { sent, of: eligible, pct: Math.max(0, Math.min(100, Math.round((sent / eligible) * 100))) } : null

  let result: string | null = null
  if (k?.responses && k.responses.sellers_replied > 0) result = `${plural(k.responses.sellers_replied, 'reply', 'replies')}`
  else if (sent >= 20) result = `${Math.round((delivered / Math.max(1, sent)) * 100)}% delivered`
  else if (sent > 0) result = `${nf(sent)} sent`
  else if (prelaunch) result = total > 0 ? `${nf(eligible)} eligible` : (c.has_target_definition ? 'Audience not built' : 'No audience yet')

  const issues = attentionFor(c, k, now)
  let exception: string | null = null
  const top = issues[0]
  if (top) {
    const q = k?.queue ?? c.live_queue
    exception = top.key === 'overdue' && q ? `${nf(q.overdue)} overdue`
      : top.key === 'no_audience' ? 'No audience'
        : top.key === 'hold' ? 'On hold'
          : top.key === 'not_placed' ? `${nf(k?.targets?.ready ?? c.ready_targets)} not queued`
            : top.key === 'missed_start' ? 'Missed start'
              : top.key === 'feeder_stale' || top.key === 'processor_stale' ? 'Scheduler silent'
                : top.key === 'processor_off' || top.key === 'emergency_stop' ? 'Sending off'
                  : top.title
  } else if ((c.remaining_targets ?? c.ready_targets) > 0 && (isLive(c) || status === 'paused')) {
    exception = `${nf(c.remaining_targets ?? c.ready_targets)} remaining`
  }

  return {
    id: c.id,
    title: name.title,
    subtitle: name.subtitle,
    state,
    source,
    channel: 'SMS',
    progress,
    result,
    exception,
    inactive: prelaunch || status === 'archived',
  }
}

/** Header line: "3 active · 1 needs attention · 1,503 remaining". */
export function bookSummary(all: CampaignSummary[], groups: Map<string, NavGroup>): { active: number; attention: number; remaining: number } {
  let active = 0
  let attention = 0
  let remaining = 0
  for (const c of all) {
    const status = lower(c.status)
    if (status === 'archived') continue
    if (LIVE_STATUSES.includes(status)) active += 1
    if (groups.get(c.id) === 'needs_you') attention += 1
    if (status !== 'completed') remaining += Number(c.remaining_targets ?? c.ready_targets ?? 0)
  }
  return { active, attention, remaining }
}

// ── the execution spine ─────────────────────────────────────────────────────

export type SpineNode = {
  key: 'audience' | 'eligible' | 'queued' | 'sent' | 'delivered' | 'replied'
  label: string
  value: number | null
  unit: string
  of: number | null
  pct: number | null
  note: string | null
  noteTone: 'muted' | 'bad' | 'warn' | null
  state: 'done' | 'current' | 'stuck' | 'idle'
  pending: boolean
}

const pctOf = (n: number | null, d: number | null) => (n === null || d === null || d <= 0 ? null : Math.max(0, Math.min(100, Math.round((n / d) * 100))))

export function spineOf(c: CampaignSummary, k: CockpitRead | null | undefined, loading: boolean, now = Date.now()): SpineNode[] {
  const total = k?.targets?.total ?? c.total_targets
  const held = k?.targets?.held ?? c.held_targets ?? 0
  const eligible = Math.max(0, total - held)
  const ready = k?.targets?.ready ?? c.ready_targets
  const committed = k?.targets?.committed ?? Math.max(0, total - ready - held)
  const sent = k?.send_states?.sent ?? c.sent_count
  const delivered = k?.send_states?.delivered ?? c.delivered_count
  const failed = k?.send_states?.failed ?? c.failed_count
  const r = k?.responses ?? null
  const state = execState(c, k, now)

  const current: SpineNode['key'] | null = state.key === 'running' ? 'sent'
    : state.key === 'waiting' ? 'queued'
      : state.key === 'degraded' && (k?.queue ?? c.live_queue)?.overdue ? 'queued'
        : state.key === 'draft' || state.key === 'ready' ? 'audience'
          : null
  const order: SpineNode['key'][] = ['audience', 'eligible', 'queued', 'sent', 'delivered', 'replied']
  const at = current ? order.indexOf(current) : -1
  const stateAt = (key: SpineNode['key'], value: number | null): SpineNode['state'] => {
    const i = order.indexOf(key)
    if (key === current) return state.key === 'degraded' ? 'stuck' : 'current'
    if (at >= 0 && i < at) return 'done'
    return value && value > 0 ? 'done' : 'idle'
  }

  return [
    { key: 'audience', label: 'Audience', value: total, unit: 'sellers', of: null, pct: null, note: null, noteTone: null, state: stateAt('audience', total), pending: false },
    { key: 'eligible', label: 'Eligible', value: eligible, unit: 'sellers', of: total, pct: pctOf(eligible, total), note: held ? `${nf(held)} held` : null, noteTone: held ? 'muted' : null, state: stateAt('eligible', eligible), pending: false },
    { key: 'queued', label: 'Queued', value: committed, unit: 'sellers', of: eligible, pct: pctOf(committed, eligible), note: ready ? `${nf(ready)} remaining` : null, noteTone: ready ? 'muted' : null, state: stateAt('queued', committed), pending: false },
    { key: 'sent', label: 'Sent', value: sent, unit: 'messages', of: null, pct: null, note: failed ? `${nf(failed)} failed` : null, noteTone: failed ? 'bad' : null, state: stateAt('sent', sent), pending: false },
    { key: 'delivered', label: 'Delivered', value: delivered, unit: 'messages', of: sent, pct: pctOf(delivered, sent), note: null, noteTone: null, state: stateAt('delivered', delivered), pending: false },
    {
      key: 'replied', label: 'Replied', value: r ? r.sellers_replied : null, unit: 'sellers', of: r ? r.sellers_messaged : null,
      pct: r ? pctOf(r.sellers_replied, r.sellers_messaged) : null,
      note: r && r.sellers_asked_to_stop ? `${nf(r.sellers_asked_to_stop)} asked to stop` : null, noteTone: r && r.sellers_asked_to_stop ? 'warn' : null,
      state: stateAt('replied', r ? r.sellers_replied : null), pending: !r && loading,
    },
  ]
}

// ── NOW / NEXT ──────────────────────────────────────────────────────────────

export type NowFact = { key: string; label: string; value: string; sub: string | null; tone: 'exec' | 'wait' | 'bad' | 'warn' | 'muted' | 'ok' | null }

export function windowFact(w: CockpitWindow | undefined, now = Date.now()): NowFact | null {
  if (!w) return null
  if (w.open === null) return { key: 'window', label: 'Contact window', value: 'Unavailable', sub: w.reason === 'campaign_timezone_unset' ? 'The campaign has no time zone' : null, tone: 'muted' }
  if (w.open) return { key: 'window', label: 'Contact window', value: 'Open', sub: w.closes_at ? `closes ${clockIn(w.closes_at, w.timezone)} · ${until(w.closes_at, now)}` : null, tone: 'ok' }
  return { key: 'window', label: 'Contact window', value: 'Closed', sub: w.next_open_at ? `opens ${clockIn(w.next_open_at, w.timezone)} · ${until(w.next_open_at, now)}` : null, tone: 'wait' }
}

export function refillWords(k: CockpitRead): string | null {
  const f = k.feed
  if (!f) return null
  switch (f.bound) {
    case 'buffer': return f.limit > 0 ? `Up to ${nf(f.limit)} on the next feeder pass` : 'None due'
    case 'buffer_full': return `None — ${nf(k.queue?.live ?? 0)} already queued (keeps ${nf(f.buffer_target)} ahead)`
    case 'cohort_exhausted': return 'Nothing left to queue'
    case 'daily_cap_reached': return 'Daily cap reached — resumes tomorrow'
    case 'total_cap_reached': return 'Total cap reached'
    default: return f.bound
  }
}

/** The runtime panel for a live campaign. Only facts the cockpit read carries. */
export function nowFacts(k: CockpitRead, now = Date.now()): NowFact[] {
  const q = k.queue
  const out: NowFact[] = []
  out.push({
    key: 'queue', label: 'In the queue now',
    value: q ? nf(q.live) : 'Unavailable',
    sub: q ? (q.overdue ? `${nf(q.overdue)} overdue` : q.due ? `${nf(q.due)} due now` : q.next_scheduled_at ? `next ${until(q.next_scheduled_at, now)}` : null) : null,
    tone: q ? (q.overdue ? 'bad' : q.live ? 'exec' : 'muted') : 'muted',
  })
  const carrying = k.senders.filter((s) => s.campaign_queued > 0 || s.campaign_sent_today > 0)
  out.push({
    key: 'senders', label: 'Senders',
    value: k.unavailable.includes('senders') ? 'Unavailable' : nf(carrying.length),
    sub: carrying.length ? carrying.map((s) => s.label ?? s.phone).slice(0, 2).join(' · ') : 'none carrying it',
    tone: carrying.length ? 'exec' : 'muted',
  })
  const w = windowFact(k.window, now)
  if (w) out.push(w)
  out.push({
    key: 'last_sent', label: 'Last sent',
    value: k.sends.last_sent_at ? (ago(k.sends.last_sent_at, now) ?? '—') : 'Never',
    sub: k.sends.last_sent_at ? whenIn(k.sends.last_sent_at, k.window.timezone, now) : null,
    tone: null,
  })
  out.push({
    key: 'today', label: 'Room left today',
    value: k.feed?.daily_remaining === null || k.feed?.daily_remaining === undefined ? (k.caps.daily_cap ? 'Unavailable' : 'No daily cap') : nf(k.feed.daily_remaining),
    sub: k.sends.sent_today === null ? null : `${nf(k.sends.sent_today)} sent today${k.caps.daily_cap ? ` of ${nf(k.caps.daily_cap)}` : ''}`,
    tone: null,
  })
  out.push({ key: 'refill', label: 'Next refill', value: refillWords(k) ?? 'Unavailable', sub: k.feeder.campaign_last?.at ? `feeder checked ${ago(k.feeder.campaign_last.at, now)}` : null, tone: null })
  return out
}

/** One line: what happens next. */
export function nextLine(c: CampaignSummary, k: CockpitRead | null | undefined, now = Date.now()): string | null {
  const status = lower(c.status)
  const tz = k?.window.timezone ?? c.lineage?.timezone ?? null
  const state = execState(c, k, now)
  const q = k?.queue ?? c.live_queue ?? null
  switch (state.key) {
    case 'completed': return 'Finished.'
    case 'archived': return 'Archived — restore it to use it again.'
    case 'paused': {
      const ready = k?.targets?.ready ?? c.ready_targets
      const since = k?.lifecycle.paused_at ? ` since ${whenIn(k.lifecycle.paused_at, tz, now)}` : ''
      return ready > 0 ? `Paused${since}. Resuming continues with ${plural(ready, 'ready seller')}.` : `Paused${since}. No ready sellers remain.`
    }
    case 'scheduled': return c.next_send_at && Date.parse(c.next_send_at) > now ? `Starts ${whenIn(c.next_send_at, tz, now)} (${until(c.next_send_at, now)}).` : 'Scheduled.'
    case 'ready': return `Audience built — ${plural(Math.max(0, c.total_targets - (c.held_targets ?? 0)), 'eligible seller')}. Schedule or launch it.`
    case 'draft': return c.has_target_definition ? 'Targeting is set — build the audience next.' : 'Define the audience to continue.'
    default: break
  }
  if (!LIVE_STATUSES.includes(status) || !k) return null
  const w = k.window
  if (state.key === 'degraded' && q?.overdue) {
    return w.open === false && w.next_open_at
      ? `Window opens ${clockIn(w.next_open_at, w.timezone)} (${until(w.next_open_at, now)}); the ${plural(q.overdue, 'overdue message')} will be tried again then.`
      : `The ${plural(q.overdue, 'overdue message')} keep being retried until the cause is fixed.`
  }
  if (w.open === false && w.next_open_at) {
    return q && q.live > 0
      ? `Window opens ${clockIn(w.next_open_at, w.timezone)} (${until(w.next_open_at, now)}) — ${plural(q.live, 'queued message')} go then.`
      : `Window opens ${clockIn(w.next_open_at, w.timezone)} (${until(w.next_open_at, now)}).`
  }
  if (q && q.next_scheduled_at) return `Next message due ${until(q.next_scheduled_at, now)}.`
  if (q && q.due > 0) return `${plural(q.due, 'message')} due now.`
  const refill = refillWords(k)
  return refill ? `Next refill: ${refill.charAt(0).toLowerCase()}${refill.slice(1)}.` : null
}

// ── the degraded banner ─────────────────────────────────────────────────────

export type BannerFact = { key: string; label: string; value: string; tone: 'ok' | 'bad' | 'warn' | 'muted' }

/** Six facts, each from the cockpit read; no score. */
export function degradedFacts(k: CockpitRead, now = Date.now()): BannerFact[] {
  const readAt = Number.isFinite(Date.parse(k.at)) ? Math.min(now, Date.parse(k.at)) : now
  const feederAge = readAt - Date.parse(String(k.feeder.heartbeat_at ?? ''))
  const q = k.queue
  const tz = k.window.timezone
  const assigned = k.senders.filter((s) => s.campaign_queued > 0)
  const blocked = assigned.filter((s) => s.operator_blocked || s.status === 'paused')
  const w = k.window
  const lastSent = k.sends.last_sent_at
  // Queued work older than the last send has not moved since.
  const stale = Boolean(q?.oldest_due_at && (!lastSent || Date.parse(lastSent) < Date.parse(q.oldest_due_at)))
  const facts: BannerFact[] = [
    { key: 'feeder', label: 'Feeder', value: k.feeder.heartbeat_at ? `ran ${ago(k.feeder.heartbeat_at, now)}` : 'no heartbeat', tone: feederAge < FEEDER_STALE_MS ? 'ok' : 'bad' },
    // "Queued", never "ready": these rows are waiting, not sending.
    { key: 'queue', label: 'Queue', value: q ? `${nf(q.live)} queued` : 'unavailable', tone: q ? (q.overdue ? 'bad' : 'ok') : 'muted' },
    { key: 'overdue', label: 'Overdue', value: q ? (q.overdue ? `${nf(q.overdue)} · since ${whenIn(q.oldest_due_at, tz, now)}` : '0') : '—', tone: q && q.overdue ? 'bad' : 'ok' },
    { key: 'last_sent', label: 'Last sent', value: lastSent ? `${whenIn(lastSent, tz, now)} · ${ago(lastSent, now)}` : 'never', tone: stale ? 'bad' : 'ok' },
  ]
  if (q?.last_claimed_at) {
    facts.push({
      key: 'last_claim', label: 'Last claim',
      value: `${whenIn(q.last_claimed_at, tz, now)}${q.last_release_reason ? ` · released: ${releaseWords(q.last_release_reason)}` : ''}`,
      tone: q.last_release_reason ? 'bad' : 'muted',
    })
  }
  facts.push(
    { key: 'sender', label: 'Senders', value: k.unavailable.includes('senders') ? 'unavailable' : `${nf(assigned.length)} assigned${blocked.length ? ` · ${nf(blocked.length)} blocked` : ''}`, tone: blocked.length ? 'warn' : 'muted' },
    { key: 'window', label: 'Contact window', value: w.open === null ? 'unknown' : w.open ? 'open' : `closed · opens ${clockIn(w.next_open_at, w.timezone) ?? '—'}`, tone: w.open ? 'ok' : 'muted' },
    { key: 'failed', label: 'Failed last hour', value: k.sends.failed_last_hour === null ? 'unavailable' : nf(k.sends.failed_last_hour), tone: k.sends.failed_last_hour ? 'bad' : 'ok' },
  )
  return facts
}
