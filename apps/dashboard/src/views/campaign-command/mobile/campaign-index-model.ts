/**
 * CAMPAIGN INDEX MODEL — mobile.
 *
 * Everything the index decides about a campaign, as pure functions: which card
 * anatomy it gets, which tab it belongs to, what the header says, how the list
 * is ordered. Kept out of the components so each rule can be pinned by a test
 * against the shapes production actually holds.
 *
 * Nothing here is estimated. A value the campaign row does not carry is left
 * out, never approximated — no completion times, no capacity, no health score.
 */
import type { CampaignSummary } from '../campaigns.types'
import { computeCampaignHealth, matchesListFilter, type CampaignListFilter } from '../campaign-health'
import { describeCampaignStatus } from '../campaign-operator-language'

const lower = (v: unknown) => String(v ?? '').trim().toLowerCase()
const nf = (n: number | null | undefined) => Number(n ?? 0).toLocaleString()

const LIVE_STATUSES = ['active', 'activating', 'live_limited']
const SCHEDULED_STATUSES = ['scheduled', 'queued']
const PRELAUNCH_STATUSES = ['draft', 'built', 'previewed', 'ready', 'failed']

// ── Card anatomy ────────────────────────────────────────────────────────────

/**
 * Which card a campaign gets. Each kind has its own composition; they share a
 * shell but never the same body, because a draft, a live send and a finished
 * run answer different questions.
 */
export type CardKind =
  | 'live'
  | 'test'
  | 'paused'
  | 'scheduled'
  | 'ready'
  | 'draft'
  | 'attention'
  | 'hold'
  | 'completed'
  | 'archived'

/**
 * Order matters: quarantine is the only UNSAFE state and outranks everything;
 * terminal states can never read as running; test mode outranks a live status
 * because "sellers won't receive this" is the fact that governs it.
 */
export function cardKindOf(c: CampaignSummary): CardKind {
  const status = lower(c.status)
  if (status === 'archived') return 'archived'
  if (status === 'completed') return 'completed'
  if (c.quarantined) return 'hold'
  if (status === 'paused') return 'paused'
  if (SCHEDULED_STATUSES.includes(status)) return 'scheduled'
  if (LIVE_STATUSES.includes(status)) {
    if (c.operator_state === 'test_mode') return 'test'
    return describeCampaignStatus(c).state === 'attention' ? 'attention' : 'live'
  }
  if (status === 'failed') return 'attention'
  if (status === 'built' || status === 'previewed' || status === 'ready') return 'ready'
  return 'draft'
}

/** True when a person has to act now — the one definition the header, the
 *  summary, the ordering and the attention filter all share. */
export function needsAttention(c: CampaignSummary): boolean {
  const kind = cardKindOf(c)
  return kind === 'attention' || kind === 'hold'
}

/** The problem, in one sentence, for an attention or hold card. */
export function attentionIssue(c: CampaignSummary): string {
  return describeCampaignStatus(c).detail || 'Setup needs attention before this can continue.'
}

/**
 * For an on-hold explicit campaign the numbers ARE the explanation: 984 target
 * rows for 186 selected properties is what "targeting problem" means.
 */
export function holdEvidence(c: CampaignSummary): string | null {
  if (!c.quarantined) return null
  const selected = c.explicit_target_count
  if (selected != null && c.total_targets > 0) {
    return `${nf(c.total_targets)} targets for ${nf(selected)} selected ${selected === 1 ? 'property' : 'properties'}`
  }
  return null
}

// ── Draft completion ────────────────────────────────────────────────────────

export type SetupStep = { key: 'build' | 'reach' | 'launch'; label: string; done: boolean }

/**
 * The builder's three steps, read from the row: Build is done once an audience
 * is defined, Reach once it has been built into targets, Launch never for
 * something still on this card.
 */
export function setupSteps(c: CampaignSummary): SetupStep[] {
  const defined = Boolean(c.has_target_definition) || c.total_targets > 0
  const built = c.total_targets > 0
  return [
    { key: 'build', label: 'Build', done: defined },
    { key: 'reach', label: 'Reach', done: built },
    { key: 'launch', label: 'Launch', done: false },
  ]
}

// ── Naming ──────────────────────────────────────────────────────────────────

/**
 * Generated names read as sentences, not headlines. "Entity Graph · 186
 * properties" is the builder's auto-name for a pinned selection: the source is
 * the identity, the count is metadata. The stored name is never rewritten.
 */
export function displayName(c: CampaignSummary): { title: string; subtitle: string | null } {
  const raw = String(c.campaign_name ?? '').trim()
  if (!raw) return { title: 'Untitled campaign', subtitle: null }
  const generated = raw.match(/^(.+?)\s+·\s+(\d[\d,]*)\s+propert(?:y|ies)$/i)
  if (generated) {
    const n = Number(generated[2].replace(/,/g, ''))
    return { title: generated[1], subtitle: `${nf(n)} ${n === 1 ? 'property' : 'properties'} selected` }
  }
  return { title: raw, subtitle: null }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${nf(n)} ${n === 1 ? one : many}`
}

// ── Tabs and filters ────────────────────────────────────────────────────────

/**
 * The primary state selector. Keys are the canonical `CampaignListFilter`
 * values; the index applies its own partition (below) so each campaign lives
 * in exactly one tab. "All" moved to the search sheet.
 */
export const PRIMARY_FILTERS: Array<{ key: CampaignListFilter; label: string }> = [
  { key: 'live', label: 'Active' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'draft', label: 'Drafts' },
  { key: 'completed', label: 'Completed' },
]

/** Narrower and wider cuts, offered inside search. */
export const SECONDARY_FILTERS: Array<{ key: CampaignListFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'needs_attention', label: 'Needs attention' },
  { key: 'paused', label: 'Paused' },
  { key: 'ready', label: 'Ready' },
  { key: 'archived', label: 'Archived' },
]

/**
 * The index partition. The desktop filter's `live` also admits scheduled
 * campaigns (they have their own tab here) and would therefore count one
 * campaign twice across tabs; pre-launch holds and failures go to Drafts,
 * where their setup is.
 */
export function matchesIndexFilter(c: CampaignSummary, filter: CampaignListFilter): boolean {
  const status = lower(c.status)
  switch (filter) {
    case 'all': return true
    case 'live': return [...LIVE_STATUSES, 'paused'].includes(status)
    case 'scheduled': return SCHEDULED_STATUSES.includes(status)
    case 'draft': return PRELAUNCH_STATUSES.includes(status) || (!status && !c.quarantined)
    case 'completed': return status === 'completed'
    case 'archived': return status === 'archived'
    case 'paused': return status === 'paused'
    case 'ready': return ['built', 'previewed', 'ready'].includes(status)
    case 'needs_attention': return needsAttention(c)
    default: return matchesListFilter(c, filter)
  }
}

export function tabCounts(all: CampaignSummary[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const { key } of [...PRIMARY_FILTERS, ...SECONDARY_FILTERS]) {
    out[key] = all.filter((c) => matchesIndexFilter(c, key)).length
  }
  return out
}

/** Empty states that say what the tab is for, not "No campaigns match." */
export const EMPTY_STATE: Record<string, { title: string; body: string; action?: 'new' }> = {
  live: { title: 'No active campaigns', body: 'Nothing is sending right now.', action: 'new' },
  scheduled: { title: 'No scheduled campaigns', body: 'Campaigns you schedule will appear here with their start time.' },
  draft: { title: 'No drafts', body: 'Campaigns you start and haven’t launched wait here.', action: 'new' },
  completed: { title: 'No completed campaigns', body: 'Finished campaigns appear here with their results.' },
  needs_attention: { title: 'Nothing needs attention', body: 'Every campaign is running or waiting as expected.' },
  paused: { title: 'Nothing is paused', body: 'Paused campaigns appear here until you resume them.' },
  ready: { title: 'Nothing is ready to schedule', body: 'Campaigns with a built audience appear here.' },
  archived: { title: 'Nothing is archived', body: 'Archived campaigns appear here.' },
  all: { title: 'No campaigns yet', body: 'Create a campaign to start reaching sellers.', action: 'new' },
}

// ── Ordering ────────────────────────────────────────────────────────────────

const KIND_RANK: Record<CardKind, number> = {
  hold: 0, attention: 1, live: 2, test: 3, paused: 4, scheduled: 5, ready: 6, draft: 7, completed: 8, archived: 9,
}

/**
 * Attention rises; otherwise the API's order (newest first) is kept, so a
 * refresh that changes nothing moves nothing. Scheduled campaigns run in start
 * order, ready ones by how many sellers they'd reach.
 */
export function orderForIndex(list: CampaignSummary[]): CampaignSummary[] {
  return list
    .map((c, i) => ({ c, i, kind: cardKindOf(c) }))
    .sort((a, b) => {
      const r = KIND_RANK[a.kind] - KIND_RANK[b.kind]
      if (r !== 0) return r
      if (a.kind === 'scheduled') {
        const at = Date.parse(a.c.next_send_at ?? '') || Infinity
        const bt = Date.parse(b.c.next_send_at ?? '') || Infinity
        if (at !== bt) return at - bt
      }
      if (a.kind === 'ready' && b.c.ready_targets !== a.c.ready_targets) return b.c.ready_targets - a.c.ready_targets
      return a.i - b.i
    })
    .map((x) => x.c)
}

// ── Book-wide rollup ────────────────────────────────────────────────────────

/**
 * READY counts the canonical `ready_targets` of every non-terminal campaign;
 * RUNNING counts canonical status, with the test split reported separately
 * (a test-mode active campaign is still active). Attention is the card
 * definition above, so the header can never disagree with the cards.
 */
export function rollupCampaigns(all: CampaignSummary[]) {
  let running = 0, runningTest = 0, scheduled = 0, attention = 0, replies = 0
  let readyLive = 0, readyTerminal = 0
  for (const c of all) {
    const status = lower(c.status)
    const isTerminal = status === 'archived' || status === 'completed'
    if (LIVE_STATUSES.includes(status)) {
      running += 1
      if (c.operator_state === 'test_mode') runningTest += 1
    }
    if (SCHEDULED_STATUSES.includes(status)) scheduled += 1
    if (needsAttention(c)) attention += 1
    replies += c.reply_count ?? 0
    if (isTerminal) readyTerminal += c.ready_targets
    else readyLive += c.ready_targets
  }
  return { running, runningTest, scheduled, attention, replies, readyLive, readyTerminal }
}

/**
 * The one line under the title: what is true, then what needs a person. Says
 * nothing when neither is interesting. Sending posture only when abnormal.
 */
export function summaryLine(
  roll: { running: number; attention: number; scheduled: number },
  sendMode?: string | null,
): string {
  const bits: string[] = []
  if (roll.running > 0) bits.push(`${roll.running} active`)
  if (roll.scheduled > 0) bits.push(`${roll.scheduled} scheduled`)
  if (roll.attention > 0) bits.push(`${roll.attention} ${roll.attention === 1 ? 'needs' : 'need'} attention`)
  const mode = lower(sendMode)
  if (mode && mode !== 'live' && mode !== 'normal') bits.push('sending paused')
  return bits.join(' · ')
}

/** The next scheduled start in the book, if any lies ahead. */
export function nextStart(all: CampaignSummary[], now = Date.now()): { campaign: CampaignSummary; at: number } | null {
  let best: { campaign: CampaignSummary; at: number } | null = null
  for (const c of all) {
    if (!SCHEDULED_STATUSES.includes(lower(c.status))) continue
    const at = Date.parse(c.next_send_at ?? '')
    if (!Number.isFinite(at) || at < now) continue
    if (!best || at < best.at) best = { campaign: c, at }
  }
  return best
}

// ── Legacy badge vocabulary (kept for the desktop-shared tests) ─────────────

export type Tone = 'blocked' | 'running' | 'scheduled' | 'paused' | 'test' | 'built' | 'previewed' | 'failed' | 'draft' | 'done'

export const TONE_LABEL: Record<Tone, string> = {
  blocked: 'BLOCKED', running: 'RUNNING', scheduled: 'SCHEDULED', paused: 'PAUSED', test: 'TEST',
  built: 'BUILT', previewed: 'PREVIEWED', failed: 'FAILED', draft: 'DRAFT', done: 'COMPLETE',
}

export function toneOf(c: CampaignSummary): Tone {
  const s = lower(c.status)
  if (c.quarantined) return 'blocked'
  if (c.operator_state === 'test_mode') return 'test'
  if (LIVE_STATUSES.includes(s)) return 'running'
  if (SCHEDULED_STATUSES.includes(s)) return 'scheduled'
  if (s === 'paused') return 'paused'
  if (s === 'completed' || s === 'archived') return 'done'
  if (s === 'failed') return 'failed'
  if (s === 'built') return 'built'
  if (s === 'previewed' || s === 'ready') return 'previewed'
  return 'draft'
}

export function targetModePhrase(c: CampaignSummary): string | null {
  switch (c.target_mode) {
    case 'explicit':
      return c.explicit_target_count != null ? `Explicit · ${nf(c.explicit_target_count)} selected` : 'Explicit targets'
    case 'explicit_filtered':
      return c.explicit_target_count != null ? `Explicit ${nf(c.explicit_target_count)} + filters` : 'Explicit targets + filters'
    case 'dynamic':
      return 'Dynamic cohort'
    default:
      return null
  }
}

export function targetingPhrase(c: CampaignSummary): string {
  if (c.total_targets > 0) return `${nf(c.total_targets)} target${c.total_targets === 1 ? '' : 's'}`
  if (c.has_target_definition) return 'targeting set · not built'
  return 'no targeting configured'
}

// ── Health for live cards ───────────────────────────────────────────────────

/** "Healthy" is only said when the health model has a sample to say it from. */
export function liveHealthLabel(c: CampaignSummary): string | null {
  const h = computeCampaignHealth(c)
  if (h.level === 'healthy') return 'Healthy'
  if (h.level === 'caution') return 'Watch'
  return null
}
