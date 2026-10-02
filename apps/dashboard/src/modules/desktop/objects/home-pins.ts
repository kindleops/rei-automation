import { lcToast } from '../../../shared/lc/toast-bus'
import type { ObjectRef } from './object-registry'

/**
 * PIN TO HOME — the registry's one pin action (Home 2.0).
 *
 * Any surface that shows an object menu gets "Pin to Home" for objects that
 * have a Home instrument; there is no per-app pin logic. A pin is queued here
 * (durable across a reload — a pin is never silently lost) and the Home board
 * places it as a widget PINNED to that subject the moment it is open, or the
 * next time it opens. Nothing here writes business data.
 *
 * What pins as what (canonical ids only):
 *   campaign → the Campaigns widget pinned to that campaign
 * Objects without a Home instrument yet (property, seller, deal, buyer,
 * company, workflow run, closing) offer no pin rather than a dead row.
 */

export interface HomePin {
  /** Home widget type */
  widget: string
  ownerApp: string
  subject: { kind: 'campaign'; id: string; label: string }
  at: number
}

export const HOME_PIN_KEY = 'lc.home.pending-pins.v1'
export const HOME_PIN_EVENT = 'lc:home-pin'

export function homePinFor(ref: ObjectRef): Omit<HomePin, 'at'> | null {
  if (ref.type === 'campaign' && ref.id) return { widget: 'campaign.engine', ownerApp: 'campaign-command', subject: { kind: 'campaign', id: String(ref.id), label: ref.label || 'Campaign' } }
  return null
}

function read(): HomePin[] {
  try { const v = JSON.parse(window.localStorage.getItem(HOME_PIN_KEY) || '[]'); return Array.isArray(v) ? v.filter((p) => p && typeof p.widget === 'string' && p.subject?.id) : [] } catch { return [] }
}

function write(list: HomePin[]) {
  try { window.localStorage.setItem(HOME_PIN_KEY, JSON.stringify(list.slice(-20))) } catch { /* storage blocked: the event still reaches an open Home */ }
}

/** Queue a pin for Home; an open Home board hears the event and places it now. */
export function queueHomePin(pin: Omit<HomePin, 'at'>): void {
  write([...read().filter((p) => !(p.widget === pin.widget && p.subject.id === pin.subject.id)), { ...pin, at: Date.now() }])
  try { window.dispatchEvent(new CustomEvent(HOME_PIN_EVENT)) } catch { /* non-DOM */ }
}

/** The Home board takes the queued pins (once). */
export function takeHomePins(): HomePin[] {
  const list = read()
  if (list.length) write([])
  return list
}

export function pinToHome(ref: ObjectRef): { ok: boolean; reason?: string } {
  const pin = homePinFor(ref)
  if (!pin) return { ok: false, reason: 'This object has no Home widget yet' }
  queueHomePin(pin)
  lcToast({ title: 'Pinned to Home', detail: pin.subject.label, severity: 'success', source: 'home' })
  return { ok: true }
}
