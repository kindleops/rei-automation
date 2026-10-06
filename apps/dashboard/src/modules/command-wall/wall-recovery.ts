/**
 * Command Wall recovery ladder (§28, §31): retry → reconnect → refresh data →
 * soft app reload → full reload only if needed. NO RELOAD LOOPS.
 *
 * Rules:
 *   - Backoff 2 s → 4 s → 8 s → 16 s → 30 s cap (the a2e67d0b realtime rejoin
 *     shape); it only resets after the channel has been healthy for STABLE_MS,
 *     so a flapping connection cannot hammer the server.
 *   - While the browser says it is OFFLINE the ladder never escalates past
 *     retry: reloading offline replaces the last good view with the browser's
 *     own error page — the one outcome a wall must never show.
 *   - A soft reload (remount the wall, keep the page) at most once per 10 min.
 *   - A full page reload at most once per 30 min and 3 per 24 h, recorded in
 *     persistent storage so it survives the reload it causes. Beyond the
 *     budget the ladder holds at max backoff and keeps the last view.
 */

export type RecoveryAction =
  | { type: 'retry'; delayMs: number }
  | { type: 'reconnect'; delayMs: number }
  | { type: 'refresh_data'; delayMs: number }
  | { type: 'soft_reload'; delayMs: number }
  | { type: 'full_reload'; delayMs: number }
  | { type: 'hold'; delayMs: number }

export interface RecoveryStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

export const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const
export const STABLE_MS = 60_000
export const RECONNECT_AFTER = 4
export const REFRESH_AFTER = 7
export const SOFT_RELOAD_AFTER = 10
export const FULL_RELOAD_AFTER = 16
export const SOFT_RELOAD_GAP_MS = 10 * 60_000
export const FULL_RELOAD_GAP_MS = 30 * 60_000
export const FULL_RELOADS_PER_DAY = 3
const RELOAD_KEY = 'lc.wall.reloads.v1'

export function backoffFor(attempt: number): number {
  return BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, Math.max(0, attempt - 1))]
}

function readReloads(storage: RecoveryStorage | null): number[] {
  if (!storage) return []
  try {
    const v = JSON.parse(storage.getItem(RELOAD_KEY) || '[]')
    return Array.isArray(v) ? v.filter((x) => Number.isFinite(x)) : []
  } catch {
    return []
  }
}

export interface RecoveryLadder {
  /** a request/channel failed; returns what to do next */
  failure(opts?: { online?: boolean; fatal?: boolean }): RecoveryAction
  /** a request succeeded */
  success(): void
  /** record that a full reload is about to happen (call right before reloading) */
  noteFullReload(): void
  /** may a version-update reload happen now? (shares the full-reload budget) */
  canFullReload(): boolean
  state(): { failures: number; healthySince: number | null; lastSoftAt: number | null; reloadsToday: number }
}

export function createRecoveryLadder({ now = () => Date.now(), storage = null as RecoveryStorage | null } = {}): RecoveryLadder {
  let failures = 0
  let healthySince: number | null = null
  let lastSoftAt: number | null = null

  const reloadsWithin = (ms: number) => readReloads(storage).filter((t) => now() - t < ms)
  const fullAllowed = () => {
    const day = reloadsWithin(24 * 3600_000)
    if (day.length >= FULL_RELOADS_PER_DAY) return false
    const last = day.length ? Math.max(...day) : null
    return last === null || now() - last >= FULL_RELOAD_GAP_MS
  }

  return {
    failure({ online = true, fatal = false } = {}) {
      // a failure inside a short healthy spell continues the old streak
      if (healthySince !== null && now() - healthySince >= STABLE_MS) failures = 0
      healthySince = null
      failures += 1
      const delayMs = backoffFor(failures)
      if (!online) return { type: 'retry', delayMs }
      if (fatal || failures >= FULL_RELOAD_AFTER) {
        if (fullAllowed()) return { type: 'full_reload', delayMs: 1_500 }
        if (lastSoftAt === null || now() - lastSoftAt >= SOFT_RELOAD_GAP_MS) { lastSoftAt = now(); return { type: 'soft_reload', delayMs } }
        return { type: 'hold', delayMs: BACKOFF_MS[BACKOFF_MS.length - 1] }
      }
      if (failures >= SOFT_RELOAD_AFTER && (lastSoftAt === null || now() - lastSoftAt >= SOFT_RELOAD_GAP_MS)) {
        lastSoftAt = now()
        return { type: 'soft_reload', delayMs }
      }
      if (failures === REFRESH_AFTER) return { type: 'refresh_data', delayMs }
      if (failures >= RECONNECT_AFTER) return { type: 'reconnect', delayMs }
      return { type: 'retry', delayMs }
    },
    success() {
      if (healthySince === null) healthySince = now()
      if (now() - healthySince >= STABLE_MS) failures = 0
    },
    noteFullReload() {
      if (!storage) return
      try {
        const list = [...reloadsWithin(24 * 3600_000), now()]
        storage.setItem(RELOAD_KEY, JSON.stringify(list))
      } catch {
        // storage full / blocked: the in-memory gap still prevents a loop within this page life
      }
    },
    canFullReload: () => fullAllowed(),
    state: () => ({ failures, healthySince, lastSoftAt, reloadsToday: reloadsWithin(24 * 3600_000).length }),
  }
}
