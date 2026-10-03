import type { IconName } from '../../shared/icons'
import type { LCTone } from '../../shared/lc/states-model'
import { campaignObject, dealObject, propertyObject, sellerObject, type ObjectRef } from '../desktop/objects'
import type { PlatformEvent } from '../desktop/feed/feed-model'
import type { SignalCenterModel, SignalRow } from '../notifications/signals/signals-model'
import { SEVERITY_LABEL } from '../notifications/signals/signals-model'
import { storyObject, type Story } from '../notifications/plane/story-model'
import type { HomeCampaigns, HomeClosings, HomeInbox } from '../../views/home/home-signals'
import { analyticsPathFor, attentionRank, catalogueEntry, formatValue, goalState, goalTitle, PERIOD_WORD, type CatalogueEntry, type Goal, type GoalProgress } from '../../views/analytics/goals/goals-model'

/**
 * THE INTELLIGENCE BRIEF — model (pure, deterministic, tested).
 *
 * A ranked list of short statements, each one a fact a canonical source
 * already holds, worded by a fixed template and CITING that source: an object
 * from the universal object registry (seller, deal, campaign, property …)
 * opened through its canonical deep link, or the owning app's own path.
 *
 * Inputs: Signal Center firings, Notification Center "Needs you" stories,
 * pipeline movement (the platform event envelope, last 24 h), campaign health
 * (Campaign Command's own issue text), the inbox backlog, the Closing Desk and
 * Goals progress (the Analytics engine).
 *
 * No language model, no inferred insight, no adjectives the data does not
 * carry. A source that did not load says so in `unavailable` and contributes
 * no line — never a zero. Nothing here decides anything.
 */

export type Load<T> = { status: 'loading' } | { status: 'ready'; data: T; at?: number } | { status: 'unavailable'; reason: string }

export type BriefSection = 'signals' | 'needs_you' | 'closings' | 'inbox' | 'campaigns' | 'goals' | 'pipeline'

export const SECTION_LABEL: Record<BriefSection, string> = {
  signals: 'Signal Center', needs_you: 'Needs you', closings: 'Closing Desk', inbox: 'Inbox', campaigns: 'Campaigns', goals: 'Goals', pipeline: 'Pipeline',
}
const SECTION_ICON: Record<BriefSection, IconName> = {
  signals: 'radar', needs_you: 'target', closings: 'key', inbox: 'inbox', campaigns: 'bolt', goals: 'flag', pipeline: 'trending-up',
}

export interface BriefCitation {
  /** what the line is evidence of, in operator words ("Signal · Opt-out rate rising") */
  label: string
  /** the canonical object, when the fact is about one */
  ref: ObjectRef | null
  /** the owning app's path when there is no object (or as its fallback) */
  path: string | null
  /** the ledger / read model the fact came from */
  source: string
}

export interface BriefLine {
  id: string
  section: BriefSection
  icon: IconName
  tone: LCTone
  rank: number
  text: string
  detail: string | null
  at: string | null
  cite: BriefCitation
}

export interface BriefFacts {
  now: number
  signals: Load<SignalCenterModel>
  stories: Load<Story[]>
  movement: Load<PlatformEvent[]>
  campaigns: Load<HomeCampaigns>
  inbox: Load<HomeInbox>
  closings: Load<HomeClosings>
  goals: Load<{ goals: Goal[]; progress: Record<string, GoalProgress>; catalogue: ReadonlyArray<CatalogueEntry> }>
}

export interface Brief {
  lines: BriefLine[]
  unavailable: Array<{ section: BriefSection; reason: string }>
  loading: BriefSection[]
  /** sections that loaded and had nothing to report (stated, so silence is not mistaken for a gap) */
  quiet: BriefSection[]
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

export function relTime(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const m = Math.round((now - t) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/* ── per source ───────────────────────────────────────────────────────── */

const SEV_RANK: Record<string, number> = { critical: 100, warning: 80, attention: 72, info: 20 }

function signalRef(s: SignalRow): ObjectRef | null {
  if (!s.subject_id) return null
  if (s.subject_type === 'seller') return sellerObject({ threadKey: s.subject_id, source: 'signals' })
  if (s.subject_type === 'property') return propertyObject({ propertyId: s.subject_id, source: 'signals' })
  if (s.subject_type === 'campaign') return campaignObject({ campaignId: s.subject_id, source: 'signals' })
  return null
}

function signalLines(m: SignalCenterModel, now: number): BriefLine[] {
  const open = m.signals.filter((s) => s.status !== 'resolved').sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0) || (a.fired_at < b.fired_at ? 1 : -1))
  if (!open.length) {
    return [{
      id: 'signals:clear', section: 'signals', icon: 'radar', tone: 'ok', rank: 8,
      text: 'No open signals.',
      detail: `${plural(m.counts.armed_rules, 'rule')} armed · ${plural(m.counts.fired_24h, 'firing')} in 24h`,
      at: null, cite: { label: 'Signal Center', ref: null, path: '/notifications', source: 'Signal Center ledger' },
    }]
  }
  const shown = open.slice(0, 3).map((s): BriefLine => ({
    id: `signal:${s.id}`, section: 'signals', icon: 'radar',
    tone: s.severity === 'critical' ? 'crit' : s.severity === 'info' ? 'neutral' : 'attn',
    rank: SEV_RANK[s.severity] ?? 20,
    text: s.title,
    detail: [`${SEVERITY_LABEL[s.severity]} signal`, s.status === 'acknowledged' ? 'acknowledged' : null, `fired ${relTime(s.fired_at, now)}`].filter(Boolean).join(' · '),
    at: s.fired_at,
    cite: { label: `Signal · ${s.rule_key.replace(/[_.]+/g, ' ')}`, ref: signalRef(s), path: s.deep_link || '/notifications', source: 'signals (Signal Center ledger)' },
  }))
  if (open.length > shown.length) {
    shown.push({
      id: 'signals:more', section: 'signals', icon: 'radar', tone: 'neutral', rank: 19,
      text: `${plural(open.length - shown.length, 'more open signal')}.`, detail: null, at: null,
      cite: { label: 'Signal Center', ref: null, path: '/notifications', source: 'Signal Center ledger' },
    })
  }
  return shown
}

function storyLines(stories: Story[], coveredSignals: Set<string>, now: number): BriefLine[] {
  const need = stories.filter((s) => s.lens === 'needs_you' && !s.resolved && !(s.signal?.signal_ids ?? []).some((id) => coveredSignals.has(id)))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
  if (!need.length) return []
  const out: BriefLine[] = [{
    id: 'stories:count', section: 'needs_you', icon: 'target', tone: 'attn', rank: 86,
    text: `${plural(need.length, 'story', 'stories')} need${need.length === 1 ? 's' : ''} you.`,
    detail: null, at: null,
    cite: { label: 'Notification Center · Needs you', ref: null, path: '/notifications', source: 'Notification Center stories' },
  }]
  for (const s of need.slice(0, 3)) {
    out.push({
      id: `story:${s.id}`, section: 'needs_you', icon: 'target', tone: s.priority === 'critical' ? 'crit' : 'attn', rank: s.priority === 'critical' ? 95 : 84,
      text: s.title,
      detail: [s.subject.label && !s.title.includes(s.subject.label) ? s.subject.label : null, s.reason ?? s.summary ?? s.state.label, relTime(s.updated_at, now)].filter(Boolean).join(' · '),
      at: s.updated_at,
      cite: { label: 'Story', ref: storyObject(s), path: s.deep_link || '/notifications', source: 'Notification Center stories' },
    })
  }
  return out
}

function closingLines(c: HomeClosings): BriefLine[] {
  const out: BriefLine[] = []
  const cite = (label: string): BriefCitation => ({ label, ref: null, path: '/closing-desk', source: 'Closing Desk (live cases)' })
  if (c.actionRequired) out.push({ id: 'closings:action', section: 'closings', icon: 'key', tone: 'attn', rank: 90, text: `${plural(c.actionRequired, 'closing')} need${c.actionRequired === 1 ? 's' : ''} action.`, detail: c.underContract !== null ? `${c.underContract} under contract` : null, at: null, cite: cite('Closing Desk · action required') })
  if (c.titleBlocked) out.push({ id: 'closings:title', section: 'closings', icon: 'key', tone: 'attn', rank: 88, text: `${plural(c.titleBlocked, 'closing')} blocked at title.`, detail: null, at: null, cite: cite('Closing Desk · title blocked') })
  if (c.next) {
    const d = new Date(c.next.date)
    out.push({ id: 'closings:next', section: 'closings', icon: 'calendar', tone: 'exec', rank: 50, text: `Next closing: ${c.next.name}.`, detail: [c.next.address, Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : null].filter(Boolean).join(' · '), at: null, cite: cite('Closing Desk · scheduled closing') })
  }
  return out
}

function inboxLines(i: HomeInbox, now: number): BriefLine[] {
  if (!i.newReplies) return []
  const waiting = i.threads.filter((t) => t.at).sort((a, b) => (a.at! < b.at! ? -1 : 1))
  const oldest = waiting[0] ?? null
  const out: BriefLine[] = [{
    id: 'inbox:backlog', section: 'inbox', icon: 'inbox', tone: 'attn', rank: 70,
    text: `${plural(i.newReplies, 'seller reply', 'seller replies')} waiting in New Replies.`,
    detail: i.priority ? `${i.priority} marked priority` : null, at: null,
    cite: { label: 'Inbox · New Replies', ref: null, path: '/inbox', source: 'Inbox (new_replies bucket)' },
  }]
  if (oldest?.threadKey) {
    out.push({
      id: `inbox:oldest:${oldest.threadKey}`, section: 'inbox', icon: 'message', tone: 'neutral', rank: 66,
      text: `Longest waiting: ${oldest.seller}.`,
      detail: [oldest.address, `replied ${relTime(oldest.at, now)}`].filter(Boolean).join(' · '),
      at: oldest.at,
      cite: { label: 'Seller', ref: sellerObject({ threadKey: oldest.threadKey, propertyId: oldest.propertyId, prospectId: oldest.prospectId, masterOwnerId: oldest.masterOwnerId, label: oldest.seller, propertyLabel: oldest.address, source: 'brief' }), path: null, source: 'Inbox thread' },
    })
  }
  return out
}

function campaignLines(c: HomeCampaigns): BriefLine[] {
  const out: BriefLine[] = c.attention.slice(0, 3).map((x) => ({
    id: `campaign:${x.id}`, section: 'campaigns' as const, icon: 'bolt' as IconName, tone: 'attn' as LCTone, rank: 60,
    text: `${x.name}: ${x.issue ?? 'needs attention'}.`,
    detail: [x.market, x.status.replace(/_/g, ' ')].filter(Boolean).join(' · '),
    at: null,
    cite: { label: 'Campaign', ref: campaignObject({ campaignId: x.id, label: x.name, source: 'brief' }), path: null, source: 'Campaign Command (campaign health)' },
  }))
  if (c.attention.length > 3) out.push({ id: 'campaigns:more', section: 'campaigns', icon: 'bolt', tone: 'neutral', rank: 18, text: `${plural(c.attention.length - 3, 'more campaign')} need attention.`, detail: null, at: null, cite: { label: 'Campaign Command', ref: null, path: '/campaign-command', source: 'Campaign Command' } })
  out.push({
    id: 'campaigns:state', section: 'campaigns', icon: 'bolt', tone: 'neutral', rank: 12,
    text: `${plural(c.live, 'campaign')} live, ${c.paused} paused.`,
    detail: c.degraded ? 'Campaign list partially read' : null, at: null,
    cite: { label: 'Campaign Command', ref: null, path: '/campaign-command', source: 'Campaign Command' },
  })
  return out
}

function goalLines(g: { goals: Goal[]; progress: Record<string, GoalProgress>; catalogue: ReadonlyArray<CatalogueEntry> }): BriefLine[] {
  const active = g.goals.filter((x) => x.status === 'active')
  if (!active.length) return []
  const out: BriefLine[] = []
  let onTrack = 0
  for (const goal of active) {
    const p = g.progress[goal.goal_id]
    if (!p) continue
    const unit = catalogueEntry(g.catalogue, goal.metric_id)?.unit
    const st = goalState(p)
    const rank = attentionRank(p)
    const cite: BriefCitation = { label: `Goal · ${goalTitle(goal, g.catalogue)}`, ref: null, path: analyticsPathFor(goal, p), source: 'Analytics engine (goal period-to-date)' }
    if (rank === 0) {
      out.push({
        id: `goal:${goal.goal_id}`, section: 'goals', icon: 'flag', tone: 'attn', rank: 55,
        text: `${goalTitle(goal, g.catalogue)}: ${formatValue(p.current, unit)} of ${formatValue(p.target, unit)} ${PERIOD_WORD[goal.period_kind]} — ${st.label.toLowerCase()}.`,
        detail: [goal.market_label || (goal.market ? goal.market : 'All markets'), p.pace !== null ? `pace by now ${formatValue(p.pace, unit)}` : null, p.projection !== null ? `run-rate ${formatValue(p.projection, unit)} (modeled)` : null, `${p.period.days_left}d left`].filter(Boolean).join(' · '),
        at: null, cite,
      })
    } else if (p.status === 'ok') onTrack += 1
  }
  if (onTrack) out.push({ id: 'goals:ok', section: 'goals', icon: 'flag', tone: 'ok', rank: 28, text: `${plural(onTrack, 'goal')} on pace or met.`, detail: null, at: null, cite: { label: 'Analytics · Goals', ref: null, path: '/analytics?lens=goals', source: 'Analytics engine' } })
  return out
}

const MOVE_TYPES = new Set(['stage.advanced', 'stage.regressed', 'deal.opened'])

function movementRef(e: PlatformEvent): ObjectRef | null {
  const label = e.entity_refs.find((r) => r.type === 'property')?.label ?? e.entity_refs.find((r) => r.label)?.label ?? null
  if (e.opportunity_id) return dealObject({ opportunityId: e.opportunity_id, propertyId: e.property_id ?? null, threadKey: e.thread_key ?? null, label, source: 'brief' })
  if (e.property_id) return propertyObject({ propertyId: e.property_id, threadKey: e.thread_key ?? null, label, source: 'brief' })
  if (e.thread_key) return sellerObject({ threadKey: e.thread_key, propertyId: e.property_id ?? null, label, source: 'brief' })
  return null
}

function movementLines(events: PlatformEvent[], now: number): BriefLine[] {
  const moves = events.filter((e) => MOVE_TYPES.has(e.event_type) && now - Date.parse(e.occurred_at) <= 86_400_000)
  if (!moves.length) return []
  const n = (t: string) => moves.filter((e) => e.event_type === t).length
  const adv = n('stage.advanced'), reg = n('stage.regressed'), opened = n('deal.opened')
  const parts = [adv ? plural(adv, 'stage advance') : null, reg ? plural(reg, 'regression') : null, opened ? plural(opened, 'new deal') : null].filter(Boolean)
  const out: BriefLine[] = [{
    id: 'pipeline:24h', section: 'pipeline', icon: 'trending-up', tone: reg > adv ? 'attn' : 'exec', rank: 40,
    text: `Pipeline in the last 24 hours: ${parts.join(', ')}.`, detail: null, at: null,
    cite: { label: 'Pipeline', ref: null, path: '/pipeline', source: 'Platform events (acquisition_opportunity_history)' },
  }]
  const notable = moves.filter((e) => e.event_type !== 'stage.advanced' || adv <= 6).sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1)).slice(0, 3)
  for (const e of notable) {
    out.push({
      id: `move:${e.event_id}`, section: 'pipeline', icon: e.event_type === 'stage.regressed' ? 'arrow-down-left' : 'trending-up', tone: e.event_type === 'stage.regressed' ? 'attn' : 'neutral', rank: e.event_type === 'stage.regressed' ? 46 : 36,
      text: e.summary, detail: relTime(e.occurred_at, now), at: e.occurred_at,
      cite: { label: 'Pipeline event', ref: movementRef(e), path: e.deep_link || '/pipeline', source: `${e.provenance.table} · ${e.provenance.row_id}` },
    })
  }
  return out
}

/* ── the brief ────────────────────────────────────────────────────────── */

export function buildBrief(f: BriefFacts): Brief {
  const lines: BriefLine[] = []
  const unavailable: Brief['unavailable'] = []
  const loading: BriefSection[] = []
  const quiet: BriefSection[] = []
  const take = <T,>(section: BriefSection, l: Load<T>, fn: (d: T) => BriefLine[]) => {
    if (l.status === 'loading') { loading.push(section); return }
    if (l.status === 'unavailable') { unavailable.push({ section, reason: l.reason }); return }
    const got = fn(l.data)
    if (got.length) lines.push(...got)
    else quiet.push(section)
  }
  const covered = new Set<string>()
  take('signals', f.signals, (m) => { const out = signalLines(m, f.now); m.signals.filter((s) => s.status !== 'resolved').slice(0, 3).forEach((s) => covered.add(s.id)); return out })
  take('needs_you', f.stories, (s) => storyLines(s, covered, f.now))
  take('closings', f.closings, closingLines)
  take('inbox', f.inbox, (i) => inboxLines(i, f.now))
  take('campaigns', f.campaigns, campaignLines)
  take('goals', f.goals, goalLines)
  take('pipeline', f.movement, (e) => movementLines(e, f.now))
  // deterministic order: rank, then newest evidence, then id
  lines.sort((a, b) => b.rank - a.rank || (b.at ?? '').localeCompare(a.at ?? '') || a.id.localeCompare(b.id))
  return { lines, unavailable, loading, quiet }
}

export const sectionIcon = (s: BriefSection) => SECTION_ICON[s]

/** Lines that arrived after the operator last opened the brief (by their own evidence time). */
export function isNewSince(line: BriefLine, lastSeen: number | null): boolean {
  if (!lastSeen || !line.at) return false
  const t = Date.parse(line.at)
  return Number.isFinite(t) && t > lastSeen
}

/** The one sentence at the head of the brief — counts of what is in it, nothing more. */
export function headline(b: Brief): string {
  const attn = b.lines.filter((l) => l.tone === 'attn' || l.tone === 'crit').length
  if (!b.lines.length) return b.loading.length ? 'Reading the machine…' : b.unavailable.length ? 'Nothing could be read for the brief right now.' : 'Nothing to report.'
  return attn ? `${plural(attn, 'item')} for your attention.` : 'Nothing needs your attention.'
}
