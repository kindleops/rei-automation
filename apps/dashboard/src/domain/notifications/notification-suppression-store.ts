/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTIFICATION SUPPRESSION STORE — one module-level source of truth.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A "tombstone" records that the operator has finished with a notification id:
 * they dismissed it, or snoozed it until a given time. Nothing tombstoned
 * renders again, whatever the server returns.
 *
 * ── Why this is a module singleton and not hook state ──────────────────────
 * The suppression set has to be identical everywhere it is consulted. Six
 * surfaces read it today (the shell rail, the top bar, the notification
 * center, the Operations Center and its summary, the mobile dock). If each
 * held its own copy, whichever one persisted last would overwrite the others'
 * writes with a stale whole-map snapshot. One module-level map, one writer,
 * every consumer subscribed, removes that failure mode by construction —
 * including for consumers that do not exist yet.
 *
 * ── Why localStorage, not sessionStorage ───────────────────────────────────
 * The requirement is that a dismissal survives a HARD RELOAD. sessionStorage
 * does survive `location.reload()` in the same tab, but it dies with the tab
 * and is not shared between tabs — so the operator who dismisses in one tab
 * still sees the card in another, and sees every dismissal return after
 * closing the browser. localStorage is the only web store that is durable
 * across all three. Growth is bounded by the 24h TTL and by pruning entries
 * once the server has confirmed them.
 *
 * ── Why writes merge instead of overwriting ────────────────────────────────
 * Every write re-reads the persisted map first and merges into it, so a
 * second tab (or a stale in-memory copy after a `storage` event) can never
 * erase a tombstone it had not seen. The map is never written from memory
 * alone.
 *
 * ── Why a failed server write no longer erases the tombstone ───────────────
 * It used to. `patch()` called `removeTombstones()` on the failure branch,
 * which is exactly what empties the store: the operator dismisses, the write
 * fails, the local record of their decision is deleted, and the card is back
 * after a reload. Measured, headed, with writes forced to 500:
 *
 *     TOMBSTONE +0.3s       : {}
 *     TOMBSTONE AFTER RELOAD: {}
 *     AFTER RELOAD present  : true
 *
 * The tombstone is now retained and marked `confirmed: false`. The operator is
 * told plainly that the change is held locally, and the store re-attempts the
 * write on later poll cycles (`unconfirmedEntries`, capped attempts) so the
 * two ends converge instead of the decision being silently thrown away.
 */

export type TombstoneKind = 'dismissed' | 'snoozed'

export interface Tombstone {
  kind: TombstoneKind
  /** For snoozes: when the item is allowed back. `null` for dismissals. */
  until: number | null
  createdAt: number
  /** False when the server write has not yet succeeded. */
  confirmed: boolean
  /** Re-sync attempts already spent on this entry. */
  attempts: number
}

const STORAGE_KEY = 'lc.notifications.tombstones.v1'
/** The pre-singleton store lived here. Migrated once, then removed. */
const LEGACY_SESSION_KEY = 'lc.notifications.tombstones.v1'
const TTL_MS = 24 * 60 * 60 * 1000
/** Give up re-syncing an entry after this many failed attempts. */
export const MAX_SYNC_ATTEMPTS = 3

type Persisted = Record<string, Partial<Tombstone> | null | undefined>

const hasWindow = () => typeof window !== 'undefined'

function normalise(id: string, raw: Partial<Tombstone> | null | undefined, now: number): Tombstone | null {
  if (!raw || typeof raw !== 'object') return null
  const kind: TombstoneKind = raw.kind === 'snoozed' ? 'snoozed' : 'dismissed'
  const createdAt = Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : now
  if (now - createdAt > TTL_MS) return null
  const until = Number.isFinite(raw.until as number) ? Number(raw.until) : null
  if (kind === 'snoozed' && until != null && until <= now) return null
  void id
  return {
    kind,
    until,
    createdAt,
    // Entries written before this field existed were only ever persisted after
    // an optimistic write, so treating them as confirmed keeps behaviour
    // identical for anything already on disk.
    confirmed: raw.confirmed !== false,
    attempts: Number.isFinite(raw.attempts as number) ? Number(raw.attempts) : 0,
  }
}

/** Read the durable map, dropping expired entries. Never throws. */
function readPersisted(): Map<string, Tombstone> {
  const map = new Map<string, Tombstone>()
  if (!hasWindow()) return map
  const now = Date.now()

  const ingest = (raw: string | null) => {
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as Persisted
      for (const [id, value] of Object.entries(parsed)) {
        const entry = normalise(id, value, now)
        if (entry) map.set(id, entry)
      }
    } catch {
      // A corrupt store must never take the feed down.
    }
  }

  try {
    ingest(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    /* storage blocked */
  }
  return map
}

/** One-time migration of anything the previous session-scoped store held. */
function migrateLegacySession(into: Map<string, Tombstone>): boolean {
  if (!hasWindow()) return false
  let raw: string | null = null
  try {
    raw = window.sessionStorage.getItem(LEGACY_SESSION_KEY)
  } catch {
    return false
  }
  if (!raw) return false
  const now = Date.now()
  let changed = false
  try {
    const parsed = JSON.parse(raw) as Persisted
    for (const [id, value] of Object.entries(parsed)) {
      if (into.has(id)) continue
      const entry = normalise(id, value, now)
      if (entry) {
        into.set(id, entry)
        changed = true
      }
    }
  } catch {
    /* ignore */
  }
  try {
    window.sessionStorage.removeItem(LEGACY_SESSION_KEY)
  } catch {
    /* ignore */
  }
  return changed
}

// ── Singleton state ────────────────────────────────────────────────────────

let tombstones: Map<string, Tombstone> | null = null
let version = 0
const listeners = new Set<() => void>()

function ensureLoaded(): Map<string, Tombstone> {
  if (tombstones) return tombstones
  const loaded = readPersisted()
  const migrated = migrateLegacySession(loaded)
  tombstones = loaded
  if (migrated) writeThrough(loaded)
  if (hasWindow()) {
    window.addEventListener('storage', (event) => {
      if (event.key !== null && event.key !== STORAGE_KEY) return
      // Another tab wrote. Re-read rather than trusting our copy.
      tombstones = readPersisted()
      bump()
    })
  }
  return tombstones
}

function writeThrough(map: Map<string, Tombstone>) {
  if (!hasWindow()) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map)))
  } catch {
    // Storage full or blocked — the in-memory map still holds for this tab.
  }
}

function bump() {
  version += 1
  for (const listener of listeners) listener()
}

/**
 * The single writer. Re-reads what is on disk, merges the in-memory map into
 * it, applies `mutate`, then persists. A concurrent tab's write is merged, not
 * clobbered.
 */
function commit(mutate: (map: Map<string, Tombstone>) => boolean): boolean {
  const current = ensureLoaded()
  const merged = readPersisted()
  for (const [id, entry] of current) {
    const rival = merged.get(id)
    // Keep whichever side knows more: a confirmed entry beats an unconfirmed
    // one, and otherwise the newer decision wins.
    if (!rival || (entry.confirmed && !rival.confirmed) || entry.createdAt > rival.createdAt) {
      merged.set(id, entry)
    }
  }
  const changed = mutate(merged)
  tombstones = merged
  if (changed) {
    writeThrough(merged)
    bump()
  } else if (merged.size !== current.size) {
    // The merge itself brought in another tab's entries.
    bump()
  }
  return changed
}

// ── Public API ─────────────────────────────────────────────────────────────

export function getTombstones(): ReadonlyMap<string, Tombstone> {
  return ensureLoaded()
}

export function getVersion(): number {
  ensureLoaded()
  return version
}

export function subscribe(listener: () => void): () => void {
  ensureLoaded()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function addTombstones(ids: string[], kind: TombstoneKind, until?: string | null) {
  if (!ids.length) return
  const now = Date.now()
  const untilMs = until ? new Date(until).getTime() : NaN
  commit((map) => {
    for (const id of ids) {
      map.set(id, {
        kind,
        until: Number.isFinite(untilMs) ? untilMs : null,
        createdAt: now,
        confirmed: false,
        attempts: 0,
      })
    }
    return true
  })
}

/** The server accepted the write; the local record is now authoritative-backed. */
export function confirmTombstones(ids: string[]) {
  if (!ids.length) return
  commit((map) => {
    let changed = false
    for (const id of ids) {
      const entry = map.get(id)
      if (!entry || entry.confirmed) continue
      map.set(id, { ...entry, confirmed: true, attempts: 0 })
      changed = true
    }
    return changed
  })
}

/** The server refused the write. The operator's decision is kept, and flagged. */
export function markUnconfirmed(ids: string[]) {
  if (!ids.length) return
  commit((map) => {
    let changed = false
    for (const id of ids) {
      const entry = map.get(id)
      if (!entry) continue
      map.set(id, { ...entry, confirmed: false, attempts: entry.attempts + 1 })
      changed = true
    }
    return changed
  })
}

/** Entries the server has not accepted yet and that are still worth retrying. */
export function unconfirmedEntries(): Array<{ id: string; entry: Tombstone }> {
  const out: Array<{ id: string; entry: Tombstone }> = []
  for (const [id, entry] of ensureLoaded()) {
    if (!entry.confirmed && entry.attempts < MAX_SYNC_ATTEMPTS) out.push({ id, entry })
  }
  return out
}

export function removeTombstones(ids: string[]) {
  if (!ids.length) return
  commit((map) => {
    let changed = false
    for (const id of ids) changed = map.delete(id) || changed
    return changed
  })
}

/** Drop snoozes whose time has come, plus anything past the TTL. */
export function pruneExpired(): boolean {
  const now = Date.now()
  return commit((map) => {
    let changed = false
    for (const [id, entry] of map) {
      const expired = now - entry.createdAt > TTL_MS
      const snoozeElapsed = entry.kind === 'snoozed' && entry.until != null && entry.until <= now
      if (expired || snoozeElapsed) {
        map.delete(id)
        changed = true
      }
    }
    return changed
  })
}

/** True when this id should not render. */
export function isSuppressed(id: string, now = Date.now()): boolean {
  const entry = ensureLoaded().get(id)
  if (!entry) return false
  if (entry.kind === 'dismissed') return true
  if (entry.until == null || entry.until > now) return true
  return false
}

/** Test/diagnostic hook. Not used by product code. */
export function __resetSuppressionStoreForTests() {
  tombstones = null
  version = 0
  listeners.clear()
  if (hasWindow()) {
    try {
      window.localStorage.removeItem(STORAGE_KEY)
      window.sessionStorage.removeItem(LEGACY_SESSION_KEY)
    } catch {
      /* ignore */
    }
  }
}

export const NOTIFICATION_SUPPRESSION_STORAGE_KEY = STORAGE_KEY
