import type { CommandResult } from '../../../domain/command-center/command.types'
import { NEXUS_APPS } from '../../../domain/app-registry/app-registry'
import type { ShownTransient } from '../rail/rail-model'
import { appName } from '../rail/rail-store'
import * as L from '../workspace/layout'
import { WORKSPACE_TEMPLATES, type SavedWorkspace } from '../workspace/workspace-store'
import { missionsFor, type MissionKind, type MissionSubject } from '../workspace/missions'
import type { FeedSubject } from '../feed/feed-model'

/**
 * The Command Deck's reading of the shell — pure, so it can be tested.
 *
 * The deck never animates the same thing the rail animates. The rail names
 * WHICH app is moving (glyph in its row); the deck says WHAT is happening in
 * words, once, for the single highest-priority event — then rests.
 */

export type DeckGlyph = 'typing' | 'orbit' | 'check' | 'cross' | 'retry' | 'attn' | 'stage' | 'dot'
export interface DeckLine { glyph: DeckGlyph; text: string; tone: ShownTransient['tone']; app: string; key: string }

const RANK: Record<string, number> = { failure: 0, attention: 1, typing: 2, stage: 3, success: 4, processing: 5, retry: 5, milestone: 3, complete: 4, refill: 6, start: 6, add: 6 }

export function deckLine(transients: Record<string, ShownTransient>): DeckLine | null {
  const all = Object.values(transients).filter((t) => t.transient !== 'trace')
  if (!all.length) return null
  const t = [...all].sort((a, b) => (RANK[a.transient] ?? 9) - (RANK[b.transient] ?? 9))[0]
  const name = appName(t.app)
  const short = t.text && t.text.length <= 30 ? t.text : null
  const base = { tone: t.tone, app: t.app, key: t.key }
  switch (t.transient) {
    case 'typing': return { ...base, glyph: 'typing', text: t.app === '/email-command' ? 'Checking email' : 'Replying' }
    case 'processing': return { ...base, glyph: 'orbit', text: t.count > 1 ? `Sending ${t.count}` : 'Sending' }
    case 'success': return { ...base, glyph: 'check', text: t.display ?? short ?? (t.app === '/inbox' ? 'Reply queued' : 'Done') }
    case 'failure': return { ...base, glyph: 'cross', text: `Failed · ${name}` }
    case 'retry': return { ...base, glyph: 'retry', text: 'Retrying' }
    case 'attention': return { ...base, glyph: 'attn', text: `Needs you · ${name}` }
    case 'stage': return { ...base, glyph: 'stage', text: (t.display ?? 'Stage moved').replace('→', ' → ') }
    case 'refill': return { ...base, glyph: 'orbit', text: `${t.display ?? ''} scheduled`.trim() }
    case 'start': return { ...base, glyph: 'dot', text: 'Campaign started' }
    case 'complete': return { ...base, glyph: 'check', text: t.app === '/campaign-command' ? 'Campaign complete' : 'Complete' }
    case 'milestone': return { ...base, glyph: 'check', text: t.display ?? short ?? 'Milestone' }
    case 'add': return { ...base, glyph: 'dot', text: `${t.display ?? '+1'} opened` }
    default: return null
  }
}

/** Search speaks the focused app's language first. */
const PLACEHOLDER: Record<string, string> = {
  inbox: 'Search sellers, replies, properties…',
  conversation: 'Search sellers, replies, properties…',
  map: 'Search address, city, market…',
  'workflow-studio': 'Search workflows, runs, sellers…',
  'campaign-command': 'Search campaigns, markets, sellers…',
  queue: 'Search messages, sellers, campaigns…',
  pipeline: 'Search deals, sellers, properties…',
  'deal-intelligence': 'Search properties, sellers, addresses…',
  'comp-intelligence': 'Search properties and addresses…',
  'buyer-match': 'Search buyers, properties…',
  'entity-graph': 'Search owners, entities, properties…',
  'closing-desk': 'Search closings, properties, parties…',
  'email-command': 'Search email, parties, properties…',
  calendar: 'Search events, sellers, properties…',
  analytics: 'Search metrics, markets, campaigns…',
}
export const placeholderFor = (app: string | null | undefined) => (app && PLACEHOLDER[app]) || 'Search sellers, properties, buyers, campaigns…'

/* ── workspace commands: deterministic, local, real handlers only ─────── */

export type WorkspaceCommand =
  | { kind: 'beside'; path: string; label: string }
  | { kind: 'stack'; path: string; label: string }
  | { kind: 'switch'; id: string; name: string }
  | { kind: 'template'; id: string; name: string }
  | { kind: 'save' }
  | { kind: 'close' }
  | { kind: 'maximize' }
  | { kind: 'reset' }
  | { kind: 'link'; linked: boolean }
  | { kind: 'mission'; mission: MissionKind; subject: MissionSubject }
  | { kind: 'exit-mission' }
  | { kind: 'machine-feed' }
  | { kind: 'replay'; subject: FeedSubject }
  | { kind: 'brief' }

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const DESKTOP_APPS = NEXUS_APPS.filter((a) => a.desktop && !a.route.startsWith('__') && a.action !== 'notifications' && a.action !== 'settings')

function matchApp(q: string) {
  const s = norm(q)
  if (!s) return null
  return DESKTOP_APPS.find((a) => norm(a.label) === s || norm(a.shortLabel) === s || a.id === s.replace(/ /g, '-'))
    ?? DESKTOP_APPS.find((a) => norm(a.label).startsWith(s) || norm(a.shortLabel).startsWith(s))
    ?? null
}

function result(id: string, title: string, subtitle: string, cmd: WorkspaceCommand, icon: CommandResult['icon'] = 'layout-split'): CommandResult {
  return { id: `ws:${id}`, type: 'system_action', title, subtitle, icon, score: 1000, payload: { __workspace: cmd }, meta: { provider: 'workspace', groupLabel: 'Workspace', hint: 'Run' } }
}

/**
 * Commands the workspace can run, matched from what was typed. Nothing fuzzy
 * or "agentic": each phrase maps to one deterministic handler.
 */
/**
 * The subject a mission could start from, in what the operator is looking at
 * right now: the linked selection (seller/property) merged with the focused
 * app's own subject (a campaign or closing it has open). Nothing is guessed:
 * an identifier only joins when its app actually reads it.
 */
export function missionSubject(opts: {
  locator: { propertyId: string | null; threadKey: string | null; prospectId: string | null; masterOwnerId: string | null; opportunityId: string | null; address: string | null } | null
  focusedPath: string | null
  focusedTitle: string | null
  /** the campaign Campaign Command last published (id + name), so a mission names it */
  campaignSubject?: { campaignId: string; name: string | null } | null
}): MissionSubject | null {
  const q = new URLSearchParams((opts.focusedPath ?? '').split('?')[1] ?? '')
  const path = (opts.focusedPath ?? '').split('?')[0]
  const campaignId = path === '/campaign-command' ? q.get('campaign') : null
  const closingId = path === '/closing-desk' ? (q.get('case') || q.get('closing') || q.get('closing_id')) : null
  const loc = opts.locator
  const s: MissionSubject = {
    label: (campaignId && opts.campaignSubject?.campaignId === campaignId ? opts.campaignSubject.name : null)
      ?? (campaignId || closingId ? opts.focusedTitle : null) ?? loc?.address ?? opts.focusedTitle ?? 'This subject',
    propertyId: loc?.propertyId ?? null,
    threadKey: loc?.threadKey ?? null,
    prospectId: loc?.prospectId ?? null,
    masterOwnerId: loc?.masterOwnerId ?? null,
    opportunityId: (path === '/pipeline' ? q.get('opp') : null) ?? loc?.opportunityId ?? null,
    campaignId,
    closingId,
    address: loc?.address ?? null,
  }
  return missionsFor(s).length ? s : null
}

const MISSION_WORDS: Record<MissionKind, RegExp> = {
  work_seller: /^(?:work(?: this)?(?: seller)?|seller mission)/,
  move_deal: /^(?:move(?: this)?(?: deal)?|deal mission)/,
  run_campaign: /^(?:run(?: this)?(?: campaign)?|campaign mission)/,
  close_deal: /^(?:close(?: this)? deal|closing mission)/,
}

/** Mission commands for the Command Deck: start one around the subject, or end the one in progress. */
export function missionCommands(query: string, ctx: { subject: MissionSubject | null; active: { title: string } | null }): CommandResult[] {
  const q = norm(query)
  if (q.length < 3) return []
  const out: CommandResult[] = []
  if (ctx.active && /^(?:exit|end|leave|stop|finish)(?: the| this)? mission/.test(q)) {
    out.push(result('exit-mission', `End ${ctx.active.title}`, 'Restores the workspace you had before', { kind: 'exit-mission' }, 'arrow-down-left'))
  }
  if (ctx.subject) {
    const listAll = /^(?:start )?missions?$|^start mission/.test(q)
    for (const def of missionsFor(ctx.subject)) {
      if (!listAll && !MISSION_WORDS[def.kind].test(q)) continue
      out.push(result(`mission-${def.kind}`, `${def.verb} — ${ctx.subject.label}`, def.description, { kind: 'mission', mission: def.kind, subject: ctx.subject }, 'target'))
    }
  }
  return out
}

export function workspaceCommands(query: string, ctx: { saved: SavedWorkspace[]; multi: boolean; hasFocus: boolean }): CommandResult[] {
  const q = norm(query)
  if (q.length < 3) return []
  const out: CommandResult[] = []
  const beside = /^(?:open |add )?(.+?) (?:beside|next to|split|on the right)$/.exec(q)
  if (beside) {
    const app = matchApp(beside[1])
    if (app) out.push(result(`beside-${app.id}`, `Open ${app.label} beside`, 'Splits the focused pane', { kind: 'beside', path: app.action === 'deal_intelligence' ? '/deal-intelligence' : app.route, label: app.label }))
  }
  const stack = /^(?:add |stack )(.+?)(?: to (?:the )?(?:stack|pane))?$/.exec(q)
  if (stack && !beside) {
    const app = matchApp(stack[1])
    if (app) out.push(result(`stack-${app.id}`, `Add ${app.label} to this pane`, 'As a tab in the focused pane’s stack', { kind: 'stack', path: app.action === 'deal_intelligence' ? '/deal-intelligence' : app.route, label: app.label }, 'layers'))
  }
  const ws = /^(.+?) workspace$/.exec(q) ?? /^workspace (.+)$/.exec(q)
  if (ws) {
    const name = ws[1]
    for (const w of ctx.saved) if (norm(w.name).startsWith(name)) out.push(result(`switch-${w.id}`, `${w.name} workspace`, `${Object.keys(w.layout.instances).length} apps · saved`, { kind: 'switch', id: w.id, name: w.name }, 'grid'))
    for (const t of WORKSPACE_TEMPLATES) if (norm(t.name).startsWith(name) && !ctx.saved.some((w) => norm(w.name) === norm(t.name))) out.push(result(`tpl-${t.id}`, `${t.name} workspace`, t.paths.map((p) => p.slice(1).replace(/-/g, ' ')).join(' · '), { kind: 'template', id: t.id, name: t.name }, 'grid'))
  }
  if (/^save (?:the )?(?:workspace|layout)/.test(q)) out.push(result('save', 'Save workspace', 'Keeps this arrangement to come back to', { kind: 'save' }, 'bookmark'))
  if (ctx.multi && /^(?:close (?:this )?pane|close pane)/.test(q)) out.push(result('close', 'Close the focused pane', 'Its app returns to the rail', { kind: 'close' }, 'x'))
  if (ctx.multi && /^(?:maximi[sz]e|restore|focus pane)/.test(q)) out.push(result('max', 'Maximize / restore the focused pane', 'The rest stay laid out underneath', { kind: 'maximize' }, 'maximize'))
  if (ctx.multi && /^reset (?:the )?workspace/.test(q)) out.push(result('reset', 'Reset to one app', 'Keeps the focused application', { kind: 'reset' }, 'refresh-cw'))
  if (ctx.multi && /^(?:link|unlink|independent|follow selection)/.test(q)) {
    out.push(result('link-on', 'Panes follow the selection', 'Linked context', { kind: 'link', linked: true }, 'link'))
    out.push(result('link-off', 'Make panes independent', 'Each pane keeps its own subject', { kind: 'link', linked: false }, 'link'))
  }
  return out
}

/** How many apps a saved layout holds and its abstract shape. */
export function workspaceShape(w: { layout: L.Layout }) {
  return { apps: Object.keys(w.layout.instances).length, rects: L.miniature(w.layout.root) }
}

/* ── machine activity + replay (Platform 7 · Machine Feed / Time Machine) ── */

/** What can be replayed from the focused subject — seller first, then campaign, closing, property. */
export function replaySubjects(s: MissionSubject | null): FeedSubject[] {
  if (!s) return []
  const out: FeedSubject[] = []
  if (s.threadKey) out.push({ type: 'seller', id: s.threadKey, label: s.address ?? s.label })
  if (s.campaignId) out.push({ type: 'campaign', id: s.campaignId, label: s.label })
  if (s.closingId) out.push({ type: 'closing', id: s.closingId, label: s.label })
  if (s.propertyId && !s.threadKey) out.push({ type: 'property', id: s.propertyId, label: s.address ?? s.label })
  return out
}

const REPLAY_NOUN: Record<FeedSubject['type'], string> = { seller: 'seller', property: 'property', campaign: 'campaign', closing: 'closing', workflow: 'workflow run' }

/** "machine activity" / "show machine activity" opens the feed; "replay …" replays the focused subject. */
export function machineCommands(query: string, ctx: { subject: MissionSubject | null }): CommandResult[] {
  const q = norm(query)
  if (q.length < 3) return []
  const out: CommandResult[] = []
  if (/^(?:show |open )?(?:the )?machine(?: activity| feed)?$|^(?:show |open )?(?:machine )?activity$|^what(?:'s| is) the machine doing/.test(q)) {
    out.push(result('machine-feed', 'Show machine activity', 'What LeadCommand is doing and did — live', { kind: 'machine-feed' }, 'activity'))
  }
  const m = /^(?:replay|time machine|rewind)(?: (.*))?$/.exec(q)
  if (m) {
    const want = (m[1] ?? '').replace(/^(?:this|the) /, '')
    for (const subject of replaySubjects(ctx.subject)) {
      if (want && !REPLAY_NOUN[subject.type].startsWith(want) && !String(subject.label ?? '').toLowerCase().includes(want)) continue
      out.push(result(`replay-${subject.type}`, `Replay ${REPLAY_NOUN[subject.type]} — ${subject.label ?? subject.id}`, 'Time Machine · read-only history', { kind: 'replay', subject }, 'clock'))
    }
  }
  return out
}
