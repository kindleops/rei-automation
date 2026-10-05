/**
 * Build freshness — stale-deploy recovery.
 *
 * Incident (RC 8.4, 2026-10-04): a tab opened before a redeploy kept running the
 * old `main-*.js`. Every app it had not opened yet was a lazy chunk whose hashed
 * filename no longer existed, so Entity Graph, Buyer Match, Comps, DI, Calendar,
 * Closing Desk, Workflow Studio, Analytics, Settings... all failed to load while
 * the apps already in memory kept working.
 *
 * Build identity is the hashed main entry the index serves
 * (`var ENTRY = '/assets/main-<hash>.js'`). It is exact for the dashboard bundle,
 * needs no extra endpoint, and `/` is served `no-store` (static/_headers). The
 * API's `/api/version` describes the API container, not this bundle, so it is
 * not used here.
 *
 * Everything below is dependency-injected so it is testable without a browser.
 */

export type FreshnessNotice =
  | { kind: 'reloading'; target: string }
  /** a newer build exists but the operator has unsaved input — never force it */
  | { kind: 'update-deferred'; target: string | null }
  /** the proactive poll saw a newer build — a quiet pill, no forced reload */
  | { kind: 'update-available'; target: string }

export type ChunkRecoveryOutcome = 'reloading' | 'deferred' | 'retry'

export interface FreshnessDeps {
  /** entry of the bundle running in this tab; null in dev (no hashed entry) */
  runningEntry(): string | null
  /** entry the server's current index references; null when it can't be read */
  fetchLatestEntry(): Promise<string | null>
  hasUnsavedInput(): boolean
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  reload(): void
  /** delay before reloading so the toast is readable */
  reloadDelayMs?: number
  schedule?(fn: () => void, ms: number): void
}

export const RELOAD_GUARD_PREFIX = 'lc:build-recovery:reloaded:'
const MAIN_ENTRY_RE = /\/assets\/main-[A-Za-z0-9_-]+\.js/

export function parseMainEntry(html: string | null | undefined): string | null {
  if (!html) return null
  const match = MAIN_ENTRY_RE.exec(html)
  return match ? match[0] : null
}

// ── notice store (one per page) ──────────────────────────────────────────────
let notice: FreshnessNotice | null = null
let dismissedTarget: string | null = null
const listeners = new Set<() => void>()

export function getFreshnessNotice(): FreshnessNotice | null {
  return notice
}

export function subscribeFreshnessNotice(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function setNotice(next: FreshnessNotice | null) {
  // a reload in progress outranks everything; a deferred update outranks the pill
  if (notice?.kind === 'reloading' && next?.kind !== 'reloading') return
  if (notice?.kind === 'update-deferred' && next?.kind === 'update-available') return
  notice = next
  for (const listener of listeners) listener()
}

export function dismissFreshnessNotice() {
  if (notice?.kind === 'reloading') return
  dismissedTarget = notice?.target ?? null
  notice = null
  for (const listener of listeners) listener()
}

/** test-only */
export function resetBuildFreshnessForTests() {
  notice = null
  dismissedTarget = null
  inflight = null
  reloadScheduled = false
  listeners.clear()
}

// ── detection ────────────────────────────────────────────────────────────────
export async function checkForNewBuild(
  deps: Pick<FreshnessDeps, 'runningEntry' | 'fetchLatestEntry'>,
): Promise<{ newer: boolean; target: string | null }> {
  const running = deps.runningEntry()
  if (!running) return { newer: false, target: null }
  let latest: string | null = null
  try {
    latest = await deps.fetchLatestEntry()
  } catch {
    latest = null
  }
  if (!latest) return { newer: false, target: null }
  return { newer: latest !== running, target: latest }
}

// ── chunk-failure recovery ───────────────────────────────────────────────────
let inflight: Promise<ChunkRecoveryOutcome> | null = null
let reloadScheduled = false

/**
 * A dynamic import failed. If the server now serves a different build, reload
 * ONCE toward it (sessionStorage guard keyed by the target build, so it can never
 * loop) — unless the operator has unsaved input, in which case only offer it.
 * If no newer build exists this was a real network failure: the caller shows
 * Retry and nothing reloads.
 */
export function recoverFromChunkFailure(deps: FreshnessDeps): Promise<ChunkRecoveryOutcome> {
  if (reloadScheduled) return Promise.resolve('reloading')
  if (inflight) return inflight
  inflight = (async (): Promise<ChunkRecoveryOutcome> => {
    const { newer, target } = await checkForNewBuild(deps)
    if (!newer || !target) return 'retry'

    if (deps.hasUnsavedInput()) {
      setNotice({ kind: 'update-deferred', target })
      return 'deferred'
    }

    const guardKey = RELOAD_GUARD_PREFIX + target
    let alreadyTried = false
    try {
      alreadyTried = Boolean(deps.storage?.getItem(guardKey))
    } catch {
      alreadyTried = true // no storage = no loop protection = never auto-reload
    }
    if (alreadyTried || !deps.storage) {
      // We already reloaded toward this build and are still not on it (a cache or
      // service worker held the old index). Never loop: hand control to the operator.
      setNotice({ kind: 'update-deferred', target })
      return 'deferred'
    }
    try {
      deps.storage.setItem(guardKey, new Date().toISOString())
    } catch {
      setNotice({ kind: 'update-deferred', target })
      return 'deferred'
    }

    reloadScheduled = true
    setNotice({ kind: 'reloading', target })
    const schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms))
    schedule(() => deps.reload(), deps.reloadDelayMs ?? 900)
    return 'reloading'
  })().finally(() => {
    inflight = null
  })
  return inflight
}

// ── proactive poll ───────────────────────────────────────────────────────────
export const VERSION_POLL_INTERVAL_MS = 5 * 60 * 1000
const FOCUS_MIN_GAP_MS = 30 * 1000

export async function pollForNewBuild(
  deps: Pick<FreshnessDeps, 'runningEntry' | 'fetchLatestEntry'>,
): Promise<boolean> {
  const { newer, target } = await checkForNewBuild(deps)
  if (!newer || !target) return false
  if (target === dismissedTarget) return true
  setNotice({ kind: 'update-available', target })
  return true
}

export interface PollHost {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  addFocusListener(fn: () => void): () => void
  now(): number
}

/** every 5 min + on window focus (throttled). Never reloads. Returns stop(). */
export function startVersionPoll(
  deps: Pick<FreshnessDeps, 'runningEntry' | 'fetchLatestEntry'>,
  host: PollHost,
  intervalMs = VERSION_POLL_INTERVAL_MS,
): () => void {
  let last = host.now()
  const run = () => {
    last = host.now()
    void pollForNewBuild(deps).catch(() => undefined)
  }
  const handle = host.setInterval(run, intervalMs)
  const removeFocus = host.addFocusListener(() => {
    if (host.now() - last >= FOCUS_MIN_GAP_MS) run()
  })
  return () => {
    host.clearInterval(handle)
    removeFocus()
  }
}

// ── unsaved-input signal ─────────────────────────────────────────────────────
type UnsavedProbe = () => boolean
const probes = new Set<UnsavedProbe>()

/** Surfaces holding unsent text (e.g. Inbox composer drafts) register here. */
export function registerUnsavedInputProbe(probe: UnsavedProbe): () => void {
  probes.add(probe)
  return () => {
    probes.delete(probe)
  }
}

interface FieldLike {
  value?: string
  readOnly?: boolean
  disabled?: boolean
  textContent?: string | null
  type?: string
}

interface DocLike {
  querySelectorAll(selector: string): ArrayLike<FieldLike>
}

const filled = (el: FieldLike, useText = false) =>
  !el.readOnly && !el.disabled && ((useText ? el.textContent : el.value) ?? '').trim().length > 0

const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'number', 'search', 'date', 'datetime-local'])

/**
 * Conservative: a false positive only defers a reload, a false negative loses work.
 * Any non-empty editable textarea / contenteditable (composers), any non-empty
 * text field inside an open modal, or any registered probe reporting unsent text.
 */
export function hasUnsavedInput(doc: DocLike | null): boolean {
  for (const probe of probes) {
    try {
      if (probe()) return true
    } catch {
      return true
    }
  }
  if (!doc) return false
  for (const el of Array.from(doc.querySelectorAll('textarea'))) if (filled(el)) return true
  for (const el of Array.from(doc.querySelectorAll('[contenteditable="true"], [contenteditable=""]'))) {
    if (filled(el, true)) return true
  }
  const modalInputs = doc.querySelectorAll(
    '[role="dialog"] input, [aria-modal="true"] input, dialog[open] input',
  )
  for (const el of Array.from(modalInputs)) {
    if (TEXT_INPUT_TYPES.has((el.type ?? '').toLowerCase()) && filled(el)) return true
  }
  return false
}
