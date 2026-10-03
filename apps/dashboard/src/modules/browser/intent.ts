/**
 * BROWSER INTENTS — how the rest of the OS asks the Browser to do something
 * without importing it (the same pattern Home and the Composer use).
 *
 *   /browser?do=research&kind=property&id=<property_id>&label=…&n=…
 *   /browser?do=dest&type=ASSESSOR&kind=property&id=…&n=…
 *   /browser?do=search&q=…&n=…           explicit web search (operator typed it)
 *   /browser?do=find&type=ZILLOW&q=…&n=…  "zillow 3635 emerson" from the Deck
 *   /browser?do=research&kind=company&id=<org_id>&label=<name>&n=…
 *
 * The Browser runs an intent once (the nonce `n`), then rewrites its own path
 * to `/browser?s=<session>` so a reload never repeats it. Identity is the
 * canonical id only; labels are display. Nothing private rides in the URL:
 * no phone, notes, scores — the Browser reads the property's public address
 * fields itself when it needs them.
 *
 * Pure and dependency-light: object menus and the Command Deck import this.
 */
import type { DestinationType } from './destinations/types'

export type IntentKind = 'property' | 'company'
export type ResearchRole = 'subject' | 'comp'

export type BrowserIntent =
  | { do: 'research'; kind: IntentKind; id: string; label: string | null; role: ResearchRole; nonce: string }
  | { do: 'dest'; type: DestinationType; kind: IntentKind; id: string; label: string | null; role: ResearchRole; nonce: string }
  | { do: 'search'; q: string; nonce: string }
  | { do: 'find'; type: DestinationType; q: string; nonce: string }
  | { do: 'start'; nonce: string }

const TYPES: readonly DestinationType[] = ['WEB_SEARCH', 'ASSESSOR', 'TAX', 'RECORDER', 'GIS', 'PERMITS', 'CODE', 'ZILLOW', 'REDFIN', 'REALTOR', 'GOOGLE_MAPS', 'STREET_VIEW', 'COUNTY_PROPERTY_SEARCH', 'STATE_CORPORATE']
export const isDestinationType = (v: unknown): v is DestinationType => typeof v === 'string' && (TYPES as readonly string[]).includes(v)

const s = (v: string | null | undefined, max = 200): string | null => {
  const t = (v ?? '').trim()
  return t ? t.slice(0, max) : null
}

let seq = 0
export const newNonce = () => `${Date.now().toString(36)}${(++seq).toString(36)}`

export function parseIntent(search: string): BrowserIntent | null {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const what = q.get('do')
  const nonce = s(q.get('n'), 40)
  if (!what || !nonce) return null
  const kind = q.get('kind') === 'company' ? 'company' : q.get('kind') === 'property' ? 'property' : null
  const id = s(q.get('id'), 128)
  const label = s(q.get('label'), 160)
  const role: ResearchRole = q.get('role') === 'comp' ? 'comp' : 'subject'
  const type = q.get('type')
  switch (what) {
    case 'research':
      return kind && id ? { do: 'research', kind, id, label, role, nonce } : null
    case 'dest':
      return kind && id && isDestinationType(type) ? { do: 'dest', type, kind, id, label, role, nonce } : null
    case 'search': {
      const text = s(q.get('q'), 300)
      return text ? { do: 'search', q: text, nonce } : null
    }
    case 'find': {
      const text = s(q.get('q'), 300)
      return text && isDestinationType(type) ? { do: 'find', type, q: text, nonce } : null
    }
    case 'start':
      return { do: 'start', nonce }
    default:
      return null
  }
}

export function intentPath(intent: BrowserIntent): string {
  const p = new URLSearchParams()
  p.set('do', intent.do)
  if (intent.do === 'research' || intent.do === 'dest') {
    if (intent.do === 'dest') p.set('type', intent.type)
    p.set('kind', intent.kind)
    p.set('id', intent.id)
    if (intent.label) p.set('label', intent.label)
    if (intent.role === 'comp') p.set('role', 'comp')
  } else if (intent.do === 'search') {
    p.set('q', intent.q)
  } else if (intent.do === 'find') {
    p.set('type', intent.type)
    p.set('q', intent.q)
  }
  p.set('n', intent.nonce)
  return `/browser?${p.toString()}`
}

/** The session id a Browser path carries (`?s=`), if any. */
export function sessionIdOf(search: string): string | null {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const v = q.get('s')
  return v && /^[a-z0-9]{4,40}$/i.test(v) ? v : null
}
