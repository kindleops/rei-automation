import type { WatchEntityType } from '../../../lib/data/watchlistData'

/** The inspector ref fields the watch action needs (structural — no shell import). */
export interface WatchableRef {
  type: string
  id: string
  hint?: Readonly<Record<string, string | null | undefined>>
}

const text = (v: unknown) => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s || null
}

/**
 * Inspector subject → the watchlist's canonical subject, or null when the type is
 * not watchable. A seller is watched by thread key (the envelope's seller id).
 */
export function watchTargetOf(ref: WatchableRef | null | undefined, replayId?: string | null): { type: WatchEntityType; id: string } | null {
  if (!ref) return null
  if (ref.type === 'seller') {
    const id = text(ref.hint?.thread_key) ?? text(replayId) ?? text(ref.id)
    return id ? { type: 'seller', id: id.replace(/^phone:/i, '') } : null
  }
  if (ref.type === 'property') {
    const id = text(ref.hint?.property_id) ?? text(ref.id)
    return id ? { type: 'property', id } : null
  }
  if (ref.type === 'campaign') {
    const id = text(ref.id)
    return id ? { type: 'campaign', id } : null
  }
  return null
}
