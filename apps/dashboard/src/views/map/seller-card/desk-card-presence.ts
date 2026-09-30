/**
 * Which shape the desktop seller card is in right now — so the Map can decide
 * what a click on that property's pin means (PREVIEW → HALF, never back down).
 *
 * The card's shape lives in the card (the operator can collapse or expand it
 * from the card itself), so the Command Map can't infer it from its own
 * selection state. The card publishes its shape here; a pin click reads it.
 * Desktop only; phones never publish.
 */
import type { DeskCardState } from '../desktop/map-desk-model'

export interface DeskCardPresence {
  propertyId: string | null
  state: DeskCardState
}

let presence: DeskCardPresence | null = null

/** Fired on every change of shape (detail: the new presence, or null when the card closes). */
export const DESK_CARD_PRESENCE_EVENT = 'nexus:smcd-presence'

export function publishDeskCardPresence(next: DeskCardPresence | null): void {
  if (presence?.propertyId === next?.propertyId && presence?.state === next?.state) { presence = next; return }
  presence = next
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DESK_CARD_PRESENCE_EVENT, { detail: next }))
}

export function readDeskCardPresence(): DeskCardPresence | null {
  return presence
}

/** Ask the open desktop card for `propertyId` to expand from PREVIEW to HALF. */
export const DESK_CARD_EXPAND_EVENT = 'nexus:smcd-expand'
export function requestDeskCardExpand(propertyId: string | null): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(DESK_CARD_EXPAND_EVENT, { detail: { propertyId } }))
}
