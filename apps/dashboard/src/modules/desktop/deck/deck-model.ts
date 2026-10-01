import type { CommandResult } from '../../../domain/command-center/command.types'
import { NEXUS_APPS } from '../../../domain/app-registry/app-registry'
import type { ShownTransient } from '../rail/rail-model'
import { appName } from '../rail/rail-store'
import * as L from '../workspace/layout'
import { WORKSPACE_TEMPLATES, type SavedWorkspace } from '../workspace/workspace-store'

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
