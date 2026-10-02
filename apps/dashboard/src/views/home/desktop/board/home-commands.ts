import type { CommandResult } from '../../../../domain/command-center/command.types'
import type { HomePin } from '../../../../modules/desktop/objects'
import { PRESETS, PRESET_IDS, type PresetId } from './home-layout-model'
import { listHomeWidgets } from './widget-registry'

/**
 * HOME COMMANDS — how the rest of the OS drives Home without importing it.
 *
 *   ROUTES   /home?home=customize | add&widget=<type> | layout&id=<id> |
 *            preset&preset=<id> | reset | library — the Command Deck routes
 *            here (the same pattern the Composer uses); the board runs the
 *            command once and clears it from the URL.
 *   PIN      Pin to Home is a registry action on every object menu
 *            (modules/desktop/objects/home-pins); the deck's "pin … to home"
 *            routes here and joins the same queue.
 */

export type HomeCommand =
  | { kind: 'customize' }
  | { kind: 'library' }
  | { kind: 'add'; type: string }
  | { kind: 'layout'; id: string }
  | { kind: 'preset'; preset: PresetId }
  | { kind: 'reset' }

export function parseHomeCommand(search: string): HomeCommand | null {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const k = q.get('home')
  if (!k) return null
  if (k === 'customize') return { kind: 'customize' }
  if (k === 'library') return { kind: 'library' }
  if (k === 'reset') return { kind: 'reset' }
  if (k === 'add' && q.get('widget')) return { kind: 'add', type: q.get('widget')! }
  if (k === 'layout' && q.get('id')) return { kind: 'layout', id: q.get('id')! }
  if (k === 'preset' && PRESET_IDS.includes(q.get('preset') as PresetId)) return { kind: 'preset', preset: q.get('preset') as PresetId }
  return null
}

/* ── pins ─────────────────────────────────────────────────────────────── */

/*
 * Pin to Home lives in the object registry (modules/desktop/objects/home-pins):
 * every object menu offers it for objects with a Home instrument. The board
 * takes the queue (takeHomePins) and listens for HOME_PIN_EVENT.
 */

/* ── Command Deck ─────────────────────────────────────────────────────── */

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const result = (id: string, title: string, subtitle: string, route: string, icon: CommandResult['icon'] = 'home', score = 1050): CommandResult => ({
  id: `home:${id}`, type: 'system_action', title, subtitle, icon, score, route, meta: { provider: 'home', groupLabel: 'Home', hint: 'Run' },
})

/**
 * Deck entries (pure; each routes to /home with a command):
 *   "customize home" · "add inbox widget" · "home layout <name>" ·
 *   "home preset closings" · "reset home" · "pin <campaign> to home"
 */
export function homeDeckCommands(query: string, ctx: { layouts: Array<{ id: string; name: string }>; campaign: { id: string; label: string } | null }): CommandResult[] {
  const q = norm(query)
  if (q.length < 3) return []
  const out: CommandResult[] = []
  if (/^(customi[sz]e|edit|arrange)( (the )?home)?/.test(q) && (q.includes('home') || q.startsWith('custom'))) out.push(result('customize', 'Customize Home', 'Arrange, resize, add and remove widgets', '/home?home=customize', 'grid'))
  const add = /^add (?:an? )?(.*?)(?: widget)?(?: to home)?$/.exec(q)
  if (add) {
    const name = add[1].trim()
    for (const d of listHomeWidgets()) {
      if (!name || norm(d.name).startsWith(name) || d.id.startsWith(name.replace(/ /g, '.'))) out.push(result(`add-${d.id}`, `Add ${d.name} widget to Home`, d.description, `/home?home=add&widget=${encodeURIComponent(d.id)}`, d.icon))
    }
    if (!name || 'widget'.startsWith(name)) out.push(result('library', 'Add a widget to Home…', 'Open the widget library', '/home?home=library', 'grid'))
  }
  const layout = /^(?:switch )?(?:home )?(?:layout|board)s? ?(.*)$/.exec(q) ?? /^switch home(?: to)? ?(.*)$/.exec(q)
  if (layout && (q.includes('layout') || q.includes('board') || q.startsWith('switch home'))) {
    const name = layout[1].replace(/^to /, '').trim()
    for (const l of ctx.layouts) if (!name || norm(l.name).startsWith(name)) out.push(result(`layout-${l.id}`, `Switch Home to ${l.name}`, 'Saved layout', `/home?home=layout&id=${encodeURIComponent(l.id)}`, 'grid'))
  }
  const preset = /^(?:home )?preset ?(.*)$/.exec(q)
  if (preset) {
    const name = preset[1].trim()
    for (const id of PRESET_IDS) if (!name || id.startsWith(name)) out.push(result(`preset-${id}`, `New Home layout: ${PRESETS[id].name}`, PRESETS[id].description, `/home?home=preset&preset=${id}`, 'grid'))
  }
  if (/^reset (the )?home/.test(q)) out.push(result('reset', 'Reset Home layout…', 'Back to its preset — you confirm first', '/home?home=reset', 'refresh-cw'))
  if (/^pin\b/.test(q) && ctx.campaign) out.push(result('pin-campaign', `Pin ${ctx.campaign.label} to Home`, 'A Campaigns widget that keeps this campaign', `/home?home=pin&kind=campaign&id=${encodeURIComponent(ctx.campaign.id)}&label=${encodeURIComponent(ctx.campaign.label)}`, 'pin'))
  return out
}

/** A deck pin arrives as a route; turn it into a pending pin. */
export function pinFromQuery(search: string): Omit<HomePin, 'at'> | null {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  if (q.get('home') !== 'pin' || q.get('kind') !== 'campaign' || !q.get('id')) return null
  return { widget: 'campaign.engine', ownerApp: 'campaign-command', subject: { kind: 'campaign', id: q.get('id')!, label: q.get('label') || 'Campaign' } }
}
