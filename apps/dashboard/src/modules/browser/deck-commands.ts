import type { CommandResult } from '../../domain/command-center/command.types'
import type { DestinationType } from './destinations/types'
import { intentPath, newNonce, type BrowserIntent } from './intent'

/**
 * BROWSER COMMANDS for the Command Deck — pure: query + context → results.
 *
 *   open browser                    → Browser in the acting pane
 *   open browser beside             → Browser beside (also answered by the workspace grammar)
 *   research current property       → launch plane for the selection, beside
 *   open assessor beside            → the county assessor for the selection
 *   open county records             → county property search / assessor / recorder
 *   search web for current property → street, city, state only
 *   assessor current property       → same as "open assessor"
 *   zillow 3635 emerson             → Zillow for that text (or a web search when
 *                                     the site has no address link for it)
 *
 * Commands that need the current property only appear when there IS one.
 */

export interface DeckSelection { propertyId: string | null; address: string | null }

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

const besideResult = (id: string, title: string, subtitle: string, path: string, icon: CommandResult['icon'] = 'compass', score = 1060): CommandResult => ({
  id: `browser:${id}`, type: 'system_action', title, subtitle, icon, score,
  payload: { __workspace: { kind: 'beside', path, label: 'Browser' } },
  meta: { provider: 'browser', groupLabel: 'Browser', hint: 'Research' },
})
const here = (id: string, title: string, subtitle: string, route: string, icon: CommandResult['icon'] = 'compass', score = 1055): CommandResult => ({
  id: `browser:${id}`, type: 'system_action', title, subtitle, icon, score, route,
  meta: { provider: 'browser', groupLabel: 'Browser', hint: 'Open' },
})

/** Words the operator uses for a destination kind. */
const DEST_WORDS: Array<[RegExp, DestinationType, string]> = [
  [/^(?:county )?assessor$/, 'ASSESSOR', 'assessor'],
  [/^(?:county records|county|records|property records)$/, 'COUNTY_PROPERTY_SEARCH', 'county records'],
  [/^(?:recorder|deeds?|recorded documents?)$/, 'RECORDER', 'recorder'],
  [/^(?:gis|parcel map|parcels?)$/, 'GIS', 'GIS'],
  [/^(?:tax|taxes|tax records?)$/, 'TAX', 'tax records'],
  [/^(?:permits?)$/, 'PERMITS', 'permits'],
  [/^zillow$/, 'ZILLOW', 'Zillow'],
  [/^redfin$/, 'REDFIN', 'Redfin'],
  [/^(?:realtor|realtor\.com)$/, 'REALTOR', 'Realtor.com'],
  [/^(?:street ?view)$/, 'STREET_VIEW', 'Street View'],
  [/^(?:google maps|maps)$/, 'GOOGLE_MAPS', 'Google Maps'],
  [/^(?:web|search|google|search web|web search)$/, 'WEB_SEARCH', 'the web'],
]

function destOf(word: string): [DestinationType, string] | null {
  for (const [re, type, noun] of DEST_WORDS) if (re.test(word)) return [type, noun]
  return null
}

const CURRENT = /^(?:for )?(?:the |this )?(?:current|selected)? ?property$/

export function browserDeckCommands(query: string, ctx: { selection: DeckSelection | null; browserOpen?: boolean }): CommandResult[] {
  const q = norm(query)
  if (q.length < 3) return []
  const out: CommandResult[] = []
  // research lands BESIDE; an open Browser is focused and handed the intent instead (never moved or duplicated)
  const beside = (id: string, title: string, subtitle: string, path: string, icon: CommandResult['icon'] = 'compass', score = 1060): CommandResult =>
    (ctx.browserOpen && path !== '/browser' ? here(id, title, subtitle, path, icon, score) : besideResult(id, title, subtitle, path, icon, score))
  const sel = ctx.selection?.propertyId ? ctx.selection : null
  const label = sel?.address ?? null
  const forSel = (type?: DestinationType): BrowserIntent => (type
    ? { do: 'dest', type, kind: 'property', id: sel!.propertyId!, label, role: 'subject', nonce: newNonce() }
    : { do: 'research', kind: 'property', id: sel!.propertyId!, label, role: 'subject', nonce: newNonce() })

  if (/^(?:open )?(?:the )?browser$/.test(q) || (q.length >= 4 && 'open browser'.startsWith(q))) {
    out.push(here('open', 'Open Browser', 'Research the web without leaving LeadCommand', '/browser'))
    out.push(beside('open-beside', 'Open Browser beside', 'Splits the focused pane', '/browser'))
  }
  // "browser beside" is answered by the workspace grammar (one result, not two)

  if (sel && /^research(?: (?:the |this )?(?:current |selected )?property)?$/.test(q)) {
    out.push(beside('research', `Research ${label ?? 'current property'}`, 'Official records, market sources and web search', intentPath(forSel())))
  }

  // "open assessor beside" · "open county records" · "assessor current property" · "search web for current property"
  const m = /^(?:open |search |show )?(.+?)(?: beside| here)?(?: for| of)?(?: (?:the |this )?(?:current|selected) property)?$/.exec(q)
  const head = m?.[1]?.replace(/ (?:beside|here)$/, '').trim() ?? ''
  const asksCurrent = /(?:current|selected|this) property/.test(q) || / beside$/.test(q) || /^open /.test(q)
  const dest = head ? destOf(head) : null
  if (sel && dest && asksCurrent) {
    const [type, noun] = dest
    const title = type === 'WEB_SEARCH' ? `Search web for ${label ?? 'current property'}` : `Open ${noun} — ${label ?? 'current property'}`
    out.push(beside(`dest-${type}`, title, type === 'WEB_SEARCH' ? 'Street, city and state only' : 'In the Browser, beside', intentPath(forSel(type))))
  }

  // free text: "<site> <words>" — e.g. "zillow 3635 emerson"
  const ft = /^([a-z.]+(?: ?view| maps| records)?) (.{3,})$/.exec(q)
  if (ft && !CURRENT.test(ft[2]) && !/^(?:beside|here)$/.test(ft[2])) {
    const d = destOf(ft[1])
    if (d) {
      const [type, noun] = d
      const text = query.trim().slice(ft[1].length).trim()
      out.push(beside(`find-${type}`, type === 'WEB_SEARCH' ? `Search the web for “${text}”` : `${noun.charAt(0).toUpperCase()}${noun.slice(1)}: “${text}”`, 'Opens in the Browser', intentPath(type === 'WEB_SEARCH' ? { do: 'search', q: text, nonce: newNonce() } : { do: 'find', type, q: text, nonce: newNonce() }), 'search', 1040))
    }
  }
  return out
}

/** Is this result one of the Browser's (for the Deck's grouping/tests). */
export const isBrowserCommand = (r: CommandResult) => r.meta?.provider === 'browser'
export { CURRENT as CURRENT_PROPERTY_WORDS }
