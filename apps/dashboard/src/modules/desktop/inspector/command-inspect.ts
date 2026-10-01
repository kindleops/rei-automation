import type { CommandResult } from '../../../domain/command-center/command.types'
import type { EntityRef } from './inspector-store'

/**
 * A Command Deck result that already names an object the inspector can read
 * (⇧↵ inspects instead of navigating). Only identities the provider put on
 * the result are used — nothing is looked up or guessed.
 *   conversation → seller (payload.threadId, from the Inbox deck search)
 *   property     → property (payload.propertyId)
 */
export function inspectRefOfCommand(r: CommandResult | null | undefined): EntityRef | null {
  if (!r) return null
  const p = (r.payload ?? {}) as Record<string, unknown>
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  if (r.type === 'conversation' && p.kind === 'focus_thread' && s(p.threadId)) {
    return { type: 'seller', id: s(p.threadId)!, label: r.title || null, hint: { thread_key: s(p.threadId), property_id: s(p.propertyId) } }
  }
  if (r.type === 'property' && s(p.propertyId)) {
    return { type: 'property', id: s(p.propertyId)!, label: r.title || null, hint: { property_id: s(p.propertyId), thread_key: s(p.threadKey) } }
  }
  return null
}
