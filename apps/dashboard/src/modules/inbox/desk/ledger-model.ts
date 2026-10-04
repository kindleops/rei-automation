import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import type { InboxViewSelectValue } from '../../../domain/inbox/inbox-view-types'
import { resolveInboxStageBadge, type InboxStageBadge } from '../inbox-card-signals'
import { resolveThreadAddressLine, resolveThreadMarketBadge, resolveThreadPrimaryName } from '../inbox-ui-helpers'
import type { LCTone } from '../../../shared/lc'

/**
 * INBOX DESKTOP 4.0 — the triage ledger's reading of the canonical Inbox.
 *
 * Pure. Every label here is a projection of a canonical field; nothing is
 * scored, guessed or decided:
 *   · lens membership and counts are the server's bucket predicate
 *     (v_inbox_thread_state_buckets via /inbox/live and /inbox/counts);
 *   · a row's state chip comes from the same predicate's flags
 *     (/inbox/ledger-facts) — or, before those arrive, from the lens the row
 *     was listed under, which is the predicate too;
 *   · stage is the canonical S1–S10 (resolveInboxStageBadge — no badge when
 *     the thread has no canonical stage, never a fabricated S1);
 *   · value and equity are stored estimates and are labelled as such.
 */

/* ── lenses ─────────────────────────────────────────────────────────────── */

export type DeskPrimaryLens = 'priority' | 'new_replies' | 'needs_review' | 'waiting' | 'follow_up'
export type DeskMoreLens = 'scheduled' | 'snoozed' | 'suppressed' | 'cold' | 'dead' | 'archived' | 'all_conversations'
export type DeskLens = DeskPrimaryLens | DeskMoreLens
/** `filtered` is its own lens: advanced filters never borrow a bucket's name or count. */
export type DeskLensKey = DeskLens | 'filtered'

export interface DeskLensDef {
  id: DeskLens
  label: string
  /** key in the canonical counts payload */
  countKey: string
  view: InboxViewSelectValue
  /** what the lens IS, in the predicate's own terms */
  definition: string
  empty: { title: string; body: string }
}

export const PRIMARY_LENSES: readonly DeskLensDef[] = [
  {
    id: 'priority', label: 'Priority', countKey: 'priority', view: 'priority',
    definition: 'Seller replies the classifier marked high-intent, not yet auto-replied, read or actioned',
    empty: { title: 'Nothing is priority right now', body: 'No high-intent seller reply is waiting on you.' },
  },
  {
    id: 'new_replies', label: 'New Replies', countKey: 'new_replies', view: 'new_replies',
    definition: 'The seller wrote last and nobody has answered yet',
    empty: { title: 'No new replies', body: 'No seller is waiting on an answer.' },
  },
  {
    id: 'needs_review', label: 'Needs Review', countKey: 'needs_review', view: 'needs_review',
    definition: 'Held for a person: manual override, or the classifier was under 50% sure',
    empty: { title: 'Nothing needs review', body: 'No manual decisions are waiting.' },
  },
  {
    id: 'waiting', label: 'Waiting on seller', countKey: 'waiting', view: 'waiting',
    definition: 'We sent last within 24 hours, it was not rejected, and the seller has not answered',
    empty: { title: 'Not waiting on any seller', body: 'No message sent in the last 24 hours is still unanswered.' },
  },
  {
    id: 'follow_up', label: 'Follow-ups', countKey: 'follow_up', view: 'follow_up',
    definition: 'Parked for a later touch — including not-interested sellers on their 30-day nurture',
    empty: { title: 'No follow-ups', body: 'No conversation is parked for a later touch.' },
  },
]

export const MORE_LENSES: readonly DeskLensDef[] = [
  {
    id: 'scheduled', label: 'Scheduled', countKey: 'scheduled', view: 'scheduled',
    definition: 'Messages queued to send later (counts sends, not conversations)',
    empty: { title: 'Nothing scheduled', body: 'No message is queued to send later.' },
  },
  {
    id: 'snoozed', label: 'Snoozed', countKey: 'snoozed', view: 'snoozed',
    definition: 'Parked until a time you chose; they return on their own',
    empty: { title: 'Nothing snoozed', body: 'No conversation is parked until later.' },
  },
  {
    id: 'suppressed', label: 'Suppressed', countKey: 'suppressed', view: 'suppressed',
    definition: 'Opted out or do-not-contact — never messaged again',
    empty: { title: 'No suppressed sellers', body: 'Nobody in the Inbox has opted out.' },
  },
  {
    id: 'cold', label: 'Cold', countKey: 'cold', view: 'cold',
    definition: 'We sent last and the 24-hour response window has passed',
    empty: { title: 'Nothing cold', body: 'Every outreach is still inside its response window or answered.' },
  },
  {
    id: 'dead', label: 'Dead', countKey: 'dead', view: 'dead',
    definition: 'Wrong number or wrong person',
    empty: { title: 'No dead conversations', body: 'No wrong numbers or wrong people.' },
  },
  {
    id: 'archived', label: 'Archived', countKey: 'archived', view: 'archived',
    definition: 'Archived by an operator — restorable',
    empty: { title: 'Nothing archived', body: 'Archived conversations appear here and can be restored.' },
  },
  {
    id: 'all_conversations', label: 'All conversations', countKey: 'all', view: 'all_conversations',
    definition: 'Every conversation that is not archived',
    empty: { title: 'No conversations', body: 'The Inbox has no conversations yet.' },
  },
]

const ALL_LENSES: readonly DeskLensDef[] = [...PRIMARY_LENSES, ...MORE_LENSES]

export const lensDef = (id: DeskLens): DeskLensDef => ALL_LENSES.find((lens) => lens.id === id) ?? PRIMARY_LENSES[0]

const VIEW_TO_LENS: Record<string, DeskLens> = {
  priority: 'priority', hot_leads: 'priority', positive_hot: 'priority', my_priority: 'priority',
  new_replies: 'new_replies', new_inbound: 'new_replies', needs_reply: 'new_replies', new_inbounds: 'new_replies', needs_response: 'new_replies',
  needs_review: 'needs_review', manual_review: 'needs_review', review_required: 'needs_review',
  waiting: 'waiting', waiting_on_seller: 'waiting',
  follow_up: 'follow_up', follow_up_due: 'follow_up', outbound_active: 'follow_up',
  scheduled: 'scheduled',
  snoozed: 'snoozed',
  suppressed: 'suppressed', dnc_opt_out: 'suppressed', opt_out: 'suppressed',
  cold: 'cold', cold_no_response: 'cold',
  dead: 'dead', wrong_number: 'dead',
  archived: 'archived',
  all: 'all_conversations', all_conversations: 'all_conversations', all_messages: 'all_conversations',
}

/** The lens a view filter belongs to (aliases folded). Unknown views read as All. */
export function resolveDeskLens(view: string | null | undefined, filtered = false): DeskLensKey {
  if (filtered) return 'filtered'
  return VIEW_TO_LENS[String(view ?? '').trim().toLowerCase()] ?? 'all_conversations'
}

export const isPrimaryLens = (lens: DeskLensKey): lens is DeskPrimaryLens =>
  PRIMARY_LENSES.some((entry) => entry.id === lens)

/** A canonical count, or null when the server has not answered (never a guessed 0). */
export function lensCount(counts: Record<string, unknown> | null | undefined, def: DeskLensDef): number | null {
  const value = counts?.[def.countKey]
  const num = typeof value === 'number' ? value : value === null || value === undefined || value === '' ? NaN : Number(value)
  return Number.isFinite(num) && num >= 0 ? num : null
}

export const formatCount = (value: number | null | undefined): string =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—'

/* ── time ───────────────────────────────────────────────────────────────── */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const toMs = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const ms = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

/** "now" · "4m" · "3h" · "2d" · "Sep 12" — a row's resting time. */
export function formatRelativeTime(value: unknown, now = Date.now()): string {
  const ms = toMs(value)
  if (ms === null) return ''
  const diff = now - ms
  if (diff < 0) return formatShortDate(ms, now)
  if (diff < MINUTE) return 'now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`
  return formatShortDate(ms, now)
}

function formatShortDate(ms: number, now: number): string {
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "Wed, Oct 1, 2026, 7:19 AM" — the exact moment, for hover. */
export function formatExactTime(value: unknown): string {
  const ms = toMs(value)
  if (ms === null) return ''
  return new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** "4h" / "2d" duration between two moments (no suffix). */
export function formatSpan(fromMs: number, toMsValue: number): string {
  const diff = Math.max(0, toMsValue - fromMs)
  if (diff < HOUR) return `${Math.max(1, Math.floor(diff / MINUTE))}m`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  return `${Math.floor(diff / DAY)}d`
}

const formatClock = (ms: number, now: number): string => {
  const date = new Date(ms)
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const sameDay = new Date(now).toDateString() === date.toDateString()
  return sameDay ? time : `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${time}`
}

/* ── intent, property, valuation ────────────────────────────────────────── */

const INTENT_LABELS: Record<string, string> = {
  seller_interested: 'Interested',
  asking_price_provided: 'Asking price given',
  asks_offer: 'Asked for an offer',
  callback_requested: 'Asked for a call',
  voicemail_call_request: 'Asked for a call',
  requests_email: 'Asked for email',
  latent_interest: 'Open to selling',
  ownership_confirmed: 'Ownership confirmed',
  send_offer_first: 'Wants the offer first',
  need_more_money: 'Wants more money',
  needs_call: 'Wants a call',
  wants_written_offer: 'Wants a written offer',
  wants_proof_of_funds: 'Wants proof of funds',
  not_interested: 'Not interested',
  wrong_number: 'Wrong number',
  wrong_person: 'Wrong person',
  opt_out: 'Opted out',
  who_is_this: 'Asked who this is',
  need_time: 'Needs time',
  contract_requested: 'Asked for a contract',
  hostile_or_legal: 'Hostile / legal',
  non_owner_referral: 'Not the owner',
  property_specific_non_owner: 'Not the owner',
}

/** The classifier's intent, worded for an operator. "unclear" is not an answer, so it reads as nothing. */
export function humanizeIntent(intent: unknown): string | null {
  const key = String(intent ?? '').trim().toLowerCase()
  if (!key || key === 'unclear' || key === 'unknown' || key === 'none') return null
  if (INTENT_LABELS[key]) return INTENT_LABELS[key]
  const words = key.replace(/[_-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null
}

export function propertyTypeShort(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  const t = raw.toLowerCase()
  if (!t || t === 'unknown' || t === 'unknown type') return null
  if (t.includes('single') || t === 'sfr') return 'SFR'
  if (t.includes('multi') || t.includes('duplex') || t.includes('triplex') || t.includes('fourplex')) return 'Multifamily'
  if (t.includes('condo')) return 'Condo'
  if (t.includes('town')) return 'Townhome'
  if (t.includes('mobile') || t.includes('manufactured')) return 'Mobile home'
  if (t.includes('land') || t.includes('lot')) return 'Land'
  if (t.includes('commercial')) return 'Commercial'
  return raw.length > 18 ? `${raw.slice(0, 17)}…` : raw
}

const positive = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : Number(String(value).replace(/[,$%\s]/g, ''))
  return Number.isFinite(num) && num > 0 ? num : null
}

/** "$212K est." — an estimate always says so. */
export function formatValueEstimate(value: unknown): string | null {
  const n = positive(value)
  if (n === null) return null
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M est.`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K est.`
  return `$${Math.round(n)} est.`
}

/** "76% eq." */
export function formatEquityEstimate(percent: unknown): string | null {
  const n = positive(percent)
  if (n === null || n > 100) return null
  return `${Math.round(n)}% eq.`
}

/** "3831 Sheridan Ave N, Minneapolis, Mn 55412" → street + the rest. */
export function splitAddress(full: string | null | undefined): { street: string | null; rest: string | null } {
  const text = String(full ?? '').trim()
  if (!text || /^property unknown$/i.test(text)) return { street: null, rest: null }
  const comma = text.indexOf(',')
  if (comma < 0) return { street: text, rest: null }
  return { street: text.slice(0, comma).trim(), rest: text.slice(comma + 1).trim() || null }
}

const formatPhone = (value: string): string => {
  const digits = value.replace(/\D/g, '')
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : value
}

/* ── facts (mirror of /api/cockpit/inbox/ledger-facts) ──────────────────── */

export type LedgerFlag =
  | 'priority' | 'new_replies' | 'needs_review' | 'waiting' | 'follow_up'
  | 'scheduled' | 'snoozed' | 'suppressed' | 'dead' | 'cold' | 'archived'

export interface LedgerFacts {
  thread_key: string | null
  property_id?: string | null
  flags: LedgerFlag[]
  is_read: boolean | null
  needs_review_reason: 'manual_override' | 'low_confidence' | 'needs_review_bucket' | null
  confidence: number | null
  last_intent: string | null
  disposition: string | null
  stage: string | null
  /** raw inbox_thread_state.seller_stage (the live stage diff compares this column only) */
  seller_stage?: string | null
  latest_direction: string | null
  latest_delivery_status: string | null
  pending_send: boolean
  last_inbound_at: string | null
  last_outbound_at: string | null
  latest_message_at: string | null
  snoozed_until: string | null
  follow_up_at: string | null
  next_scheduled_for: string | null
  estimated_value: number | null
  equity_percent: number | null
  equity_amount: number | null
}

/* ── the row ────────────────────────────────────────────────────────────── */

export interface LedgerLane {
  key: string
  label: string
  tone: LCTone
  quiet: boolean
  /** the canonical definition, for the hover */
  title: string
}

export interface LedgerRowModel {
  id: string
  key: string
  threadKey: string | null
  propertyId: string | null
  name: string
  street: string | null
  locality: string | null
  message: string
  direction: 'inbound' | 'outbound' | 'unknown'
  intent: string | null
  stage: InboxStageBadge | null
  propertyType: string | null
  value: string | null
  equity: string | null
  lane: LedgerLane | null
  /** secondary line of the state column: "sent 4h ago", "due in 2h", "until Oct 3" */
  laneDetail: string | null
  unread: boolean
  needsYou: boolean
  suppressed: boolean
  failed: boolean
  timeIso: string | null
  timeLabel: string
  timeExact: string
  /** a "Why?" sentence for the needs-you marker, in the predicate's terms */
  needsYouWhy: string | null
}

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim())
const lower = (value: unknown): string => str(value).toLowerCase()

const read = (row: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys) {
    const value = str(row[key])
    if (value) return value
  }
  return ''
}

function resolveDirection(row: Record<string, unknown>, facts: LedgerFacts | null): 'inbound' | 'outbound' | 'unknown' {
  const raw = lower(read(row, 'latest_message_direction', 'latestMessageDirection', 'latestDirection', 'latest_direction', 'direction'))
    || lower(facts?.latest_direction)
  if (raw.startsWith('in')) return 'inbound'
  if (raw.startsWith('out')) return 'outbound'
  return 'unknown'
}

/** Suppression is a property of the CONTACT, read from canonical fields only. */
export function isCanonicallySuppressed(row: Record<string, unknown>, facts: LedgerFacts | null): boolean {
  if (facts?.flags.includes('suppressed')) return true
  if (row.is_suppressed === true || row.isSuppressed === true || row.opt_out === true || row.isOptOut === true) return true
  const status = lower(row.suppression_status)
  return status === 'suppressed' || status === 'opted_out' || status === 'dnc'
}

const FAILED_DELIVERY = ['fail', 'undeliv', 'rejected', 'error']

const LANE_DEFS: Record<string, Omit<LedgerLane, 'title'> & { title: string }> = {
  suppressed: { key: 'suppressed', label: 'Suppressed', tone: 'crit', quiet: true, title: 'Opted out or do-not-contact — never messaged again' },
  dead: { key: 'dead', label: 'Wrong number', tone: 'neutral', quiet: true, title: 'Wrong number or wrong person' },
  needs_review: { key: 'needs_review', label: 'Needs you', tone: 'attn', quiet: false, title: 'Held for a person before anything is sent' },
  failed: { key: 'failed', label: 'Send failed', tone: 'crit', quiet: false, title: 'The last message to this seller was not delivered' },
  scheduled: { key: 'scheduled', label: 'Reply scheduled', tone: 'exec', quiet: true, title: 'A message is queued to send — LeadCommand owns the next touch' },
  snoozed: { key: 'snoozed', label: 'Snoozed', tone: 'neutral', quiet: true, title: 'Parked until a time you chose' },
  priority: { key: 'priority', label: 'Priority reply', tone: 'exec', quiet: false, title: 'High-intent seller reply waiting on you' },
  new_replies: { key: 'new_replies', label: 'New reply', tone: 'exec', quiet: false, title: 'The seller wrote last and nobody has answered' },
  waiting: { key: 'waiting', label: 'Waiting on seller', tone: 'neutral', quiet: true, title: 'We sent last within 24 hours; the seller has not answered' },
  follow_up: { key: 'follow_up', label: 'Follow-up', tone: 'neutral', quiet: true, title: 'Parked for a later touch' },
  nurture: { key: 'nurture', label: 'Nurture · 30 days', tone: 'neutral', quiet: true, title: 'Said not interested — a 30-day follow-up, never dead' },
  cold: { key: 'cold', label: 'Cold', tone: 'neutral', quiet: true, title: 'We sent last and the response window passed' },
  archived: { key: 'archived', label: 'Archived', tone: 'neutral', quiet: true, title: 'Archived — restorable' },
}

const LENS_FLAG: Partial<Record<DeskLens, LedgerFlag>> = {
  priority: 'priority', new_replies: 'new_replies', needs_review: 'needs_review', waiting: 'waiting',
  follow_up: 'follow_up', scheduled: 'scheduled', snoozed: 'snoozed', suppressed: 'suppressed',
  cold: 'cold', dead: 'dead', archived: 'archived',
}

/**
 * The row's one state, strongest first. Flags come from the canonical
 * predicate; without them the row is known to belong to the lens it was
 * listed under, and to nothing else.
 */
export function resolveLane(input: {
  lens: DeskLensKey
  facts: LedgerFacts | null
  suppressed: boolean
  failed: boolean
  disposition: string | null
}): LedgerLane | null {
  const flags = new Set<LedgerFlag>(input.facts?.flags ?? [])
  if (!input.facts && input.lens !== 'filtered') {
    const listed = LENS_FLAG[input.lens as DeskLens]
    if (listed) flags.add(listed)
  }
  if (input.suppressed || flags.has('suppressed')) return LANE_DEFS.suppressed
  if (flags.has('dead')) return LANE_DEFS.dead
  if (flags.has('needs_review')) return LANE_DEFS.needs_review
  if (input.failed) return LANE_DEFS.failed
  if (flags.has('scheduled')) return LANE_DEFS.scheduled
  if (flags.has('snoozed')) return LANE_DEFS.snoozed
  if (flags.has('priority')) return LANE_DEFS.priority
  if (flags.has('new_replies')) return LANE_DEFS.new_replies
  if (flags.has('waiting')) return LANE_DEFS.waiting
  if (flags.has('follow_up')) return lower(input.disposition) === 'not_interested' || lower(input.disposition) === 'need_time' ? LANE_DEFS.nurture : LANE_DEFS.follow_up
  if (flags.has('cold')) return LANE_DEFS.cold
  if (flags.has('archived')) return LANE_DEFS.archived
  return null
}

function laneDetail(lane: LedgerLane | null, facts: LedgerFacts | null, now: number): string | null {
  if (!lane || !facts) return null
  if (lane.key === 'waiting') {
    const sent = toMs(facts.last_outbound_at)
    return sent ? `sent ${formatSpan(sent, now)} ago` : null
  }
  if (lane.key === 'snoozed') {
    const until = toMs(facts.snoozed_until)
    return until ? `until ${formatClock(until, now)}` : null
  }
  if (lane.key === 'scheduled') {
    const at = toMs(facts.next_scheduled_for)
    return at && at > now ? `sends ${formatClock(at, now)}` : null
  }
  if (lane.key === 'follow_up' || lane.key === 'nurture') {
    const due = toMs(facts.follow_up_at)
    if (!due) return null
    return due >= now ? `due in ${formatSpan(now, due)}` : `due ${formatSpan(due, now)} ago`
  }
  if (lane.key === 'new_replies' || lane.key === 'priority') {
    const replied = toMs(facts.last_inbound_at)
    return replied ? `waiting ${formatSpan(replied, now)}` : null
  }
  return null
}

function needsYouWhy(facts: LedgerFacts | null): string | null {
  if (!facts?.flags.includes('needs_review')) return null
  if (facts.needs_review_reason === 'manual_override') return 'An operator set this conversation to manual.'
  if (facts.needs_review_reason === 'low_confidence') {
    const pct = facts.confidence !== null ? ` (${Math.round(facts.confidence * 100)}%)` : ''
    return `The classifier was not sure what the seller meant${pct}.`
  }
  return 'The conversation is in the Needs Review bucket.'
}

/** One ledger row from a list row plus (when loaded) its facts. */
export function buildLedgerRow(
  thread: InboxWorkflowThread,
  ctx: { lens: DeskLensKey; facts: LedgerFacts | null; now?: number; arrivedAt?: number | null },
): LedgerRowModel {
  const now = ctx.now ?? Date.now()
  const facts = ctx.facts
  const row = thread as unknown as Record<string, unknown>
  const threadKey = read(row, 'thread_key', 'threadKey', 'canonical_thread_key') || null
  const phone = read(row, 'canonical_e164', 'canonicalE164', 'seller_phone', 'sellerPhone', 'best_phone')
  const name = resolveThreadPrimaryName(thread) || (phone ? formatPhone(phone) : '') || 'Unknown seller'
  const address = splitAddress(resolveThreadAddressLine(thread) || read(row, 'property_address_full', 'propertyAddressFull'))
  const market = resolveThreadMarketBadge(thread)
  const locality = market && market !== 'Unknown' ? market : address.rest
  const direction = resolveDirection(row, facts)
  const message = read(row, 'latestMessageBody', 'latest_message_body', 'lastMessageBody', 'preview').replace(/\s+/g, ' ').trim()
  const suppressed = isCanonicallySuppressed(row, facts)
  const delivery = lower(read(row, 'latest_delivery_status', 'latestDeliveryStatus')) || lower(facts?.latest_delivery_status)
  const failed = direction === 'outbound' && FAILED_DELIVERY.some((token) => delivery.includes(token))
  const disposition = facts?.disposition ?? (read(row, 'disposition') || null)
  const lane = resolveLane({ lens: ctx.lens, facts, suppressed, failed, disposition })
  const stage = resolveInboxStageBadge({ ...row, seller_stage: facts?.stage ?? row.seller_stage })
  // Read state is canonical (inbox_thread_state.is_read). A seller message that
  // arrived live after the row loaded is unread until it is opened.
  const isRead = typeof facts?.is_read === 'boolean' ? facts.is_read : typeof row.is_read === 'boolean' ? (row.is_read as boolean) : null
  const latestMs = toMs(read(row, 'latestMessageAt', 'latest_message_at', 'lastMessageAt', 'latest_activity_at'))
  const arrivedLive = Boolean(ctx.arrivedAt && latestMs !== null && ctx.arrivedAt >= latestMs - 5_000)
  const unread = direction === 'inbound' && (arrivedLive || isRead === false)
  const timeIso = latestMs !== null ? new Date(latestMs).toISOString() : null
  return {
    id: thread.id,
    key: threadKey || thread.id,
    threadKey,
    propertyId: read(row, 'propertyId', 'property_id') || null,
    name,
    street: address.street,
    locality: locality || null,
    message,
    direction,
    intent: humanizeIntent(facts?.last_intent),
    stage,
    propertyType: propertyTypeShort(read(row, 'propertyType', 'property_type')),
    value: formatValueEstimate(facts?.estimated_value ?? null),
    equity: formatEquityEstimate(facts?.equity_percent ?? row.equity_percent ?? row.equityPercent),
    lane,
    laneDetail: laneDetail(lane, facts, now),
    unread,
    needsYou: lane?.key === 'needs_review',
    suppressed,
    failed,
    timeIso,
    timeLabel: formatRelativeTime(timeIso, now),
    timeExact: formatExactTime(timeIso),
    needsYouWhy: needsYouWhy(facts),
  }
}

/* ── keyboard cursor ────────────────────────────────────────────────────── */

/** The next cursor id after moving by `delta`, clamped; null cursor starts at the edge. */
export function moveCursor(ids: readonly string[], current: string | null, delta: number): string | null {
  if (!ids.length) return null
  const index = current ? ids.indexOf(current) : -1
  if (index < 0) return delta < 0 ? ids[ids.length - 1] : ids[0]
  return ids[Math.max(0, Math.min(ids.length - 1, index + delta))]
}

/* ── the filtered lens ──────────────────────────────────────────────────── */

/** "37 conversations" / "37+ conversations" — the filter's own count, never a bucket's. */
export function filteredCountLabel(total: number | null | undefined, loaded: number, hasMore: boolean): string {
  if (typeof total === 'number' && Number.isFinite(total)) return `${total.toLocaleString('en-US')} ${total === 1 ? 'conversation' : 'conversations'}`
  return `${loaded.toLocaleString('en-US')}${hasMore ? '+' : ''} ${loaded === 1 && !hasMore ? 'conversation' : 'conversations'}`
}

/* ── Load more must terminate (RC 8.3.2 hotfix, 2026-10-04) ─────────────────
 * The footer showed Load more whenever the chip count exceeded the loaded rows.
 * The count (v_inbox_bucket_counts) can exceed what the list returns — Priority
 * counted 20 against 9 rows — and the cursor-less "grow the page" path returns
 * the same rows, so the button never went away and every click re-read the
 * same page. A load that settles without adding a row exhausts the lens until
 * the question (lens + filters) changes or more rows arrive by other means.
 */
export interface LoadMoreProbe {
  /** the lens + filter signature the probe was taken under */
  key: string
  /** rows on screen when Load more was pressed */
  before: number
  /** the load has resolved */
  settled: boolean
}

export function isLoadMoreExhausted(probe: LoadMoreProbe | null, key: string, rowCount: number): boolean {
  return Boolean(probe && probe.settled && probe.key === key && rowCount <= probe.before)
}

export function shouldShowLoadMore({
  rowCount, canLoadMore, lensTotal, exhausted,
}: { rowCount: number; canLoadMore: boolean; lensTotal: number | null | undefined; exhausted: boolean }): boolean {
  if (rowCount === 0 || exhausted) return false
  return canLoadMore || (typeof lensTotal === 'number' && lensTotal > rowCount)
}
