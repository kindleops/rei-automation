import type { CommandResult } from '../../domain/command-center/command.types'

/**
 * RECENT SEARCHES — the operator's own history, not a suggestion engine.
 *
 * §4 asks the one global search to offer recents "where existing architecture
 * supports it". What existed was `getRecentCommandLocations`, which only remembers
 * geocoded map locations — so opening a seller, a property or a campaign from search
 * left no trace and the empty state of the mobile layer was blank.
 *
 * This records what the operator ACTUALLY opened. It stores the already-rendered
 * result shape rather than re-querying, so an empty search field costs no network and
 * nothing here can invent an entity: a row can only exist because that exact result
 * was returned by a provider and then chosen.
 */

const STORAGE_KEY = 'nx.recent-command-results.v1'
const LIMIT = 8

export type RecentCommandResult = Pick<
  CommandResult,
  'id' | 'type' | 'title' | 'subtitle' | 'icon' | 'route' | 'badge'
>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object'

export function readRecentCommandResults(): RecentCommandResult[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is RecentCommandResult =>
        isRecord(entry) && typeof entry.id === 'string' && typeof entry.title === 'string')
      .slice(0, LIMIT)
  } catch {
    return []
  }
}

export function recordRecentCommandResult(result: CommandResult): void {
  if (typeof window === 'undefined') return
  /**
   * Actions are deliberately not remembered. "Clear Filters" or "Switch Map Theme"
   * in a Recent list is noise — the operator is looking for the entity they were
   * just in, and an action is never that.
   */
  if (result.type === 'filter' || result.type === 'system_action' || result.type === 'map_action') return
  try {
    const next: RecentCommandResult = {
      id: result.id,
      type: result.type,
      title: result.title,
      subtitle: result.subtitle,
      icon: result.icon,
      route: result.route,
      badge: result.badge,
    }
    const existing = readRecentCommandResults().filter((entry) => entry.id !== next.id)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([next, ...existing].slice(0, LIMIT)))
  } catch {
    /* A full or disabled localStorage must never break navigation. */
  }
}

export function clearRecentCommandResults(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* best effort */
  }
}
