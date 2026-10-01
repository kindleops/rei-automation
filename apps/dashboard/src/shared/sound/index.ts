import { play as cuePlay, setEnabled, setTheme, setVolume, type PlayOptions, type SoundName } from 'cuelume'
import { readSoundPrefs, subscribeSoundPrefs, type ExperienceSoundPrefs } from './prefs'

/**
 * THE LEADCOMMAND SOUND SYSTEM.
 *
 * The rest of the product speaks in semantic events — `sound.workspace.drop()`,
 * `sound.outcome.success()`, `sound.machine.event(e)` — and never names a cue.
 * This module maps them onto Cuelume's fourteen cues, applies LeadCommand's
 * gain normalisation and the operator's preferences, and arbitrates: one
 * canonical event makes ONE sound, however many surfaces render it.
 *
 * Quiet at rest, meaningful in motion, precise at outcome:
 *  · Off — silence. Subtle — open/close/select/outcomes/attention only.
 *    Full — adds taps, toggles, navigation, drag and drop.
 *  · High-volume machine activity is visual. Only exceptions, explicit
 *    operator actions and meaningful arrivals are audible.
 *  · Cold load, reconnect and returning to the tab are silent: only events
 *    that happen after this window started listening can sound.
 *  · A failure to play never breaks anything — every call is a no-op on error.
 */

type Emphasis = 'subtle' | 'normal' | 'strong'
type Tier = 'subtle' | 'full'

/* ── product gain: what a cue weighs relative to the library default ──── */

const GAIN: Record<SoundName, number> = {
  tap: 0.35, type: 0.18, select: 0.35, toggle: 0.35, open: 0.3, close: 0.3, navigate: 0.3,
  loading: 0.35, ready: 0.42, success: 0.45, warning: 0.45, error: 0.5, attention: 0.5, count: 0.3,
}

let prefs: ExperienceSoundPrefs = readSoundPrefs()
let surface: 'desktop' | 'other' = 'other'
const startedAt = Date.now()

function apply() {
  try {
    setTheme(prefs.material)
    setVolume(prefs.volume)
    setEnabled(surface === 'desktop' && (prefs.interface !== 'off' || prefs.alerts))
  } catch { /* audio unavailable — stay silent */ }
}
apply()
subscribeSoundPrefs(() => { prefs = readSoundPrefs(); apply() })

/** The desktop shell turns sound on for its surface; phones stay silent in this pass. */
export function setSoundSurface(next: 'desktop' | 'other') { surface = next; apply() }

const debug: Array<{ at: number; event: string; cue: SoundName | null; why: string }> = []
function note(event: string, cue: SoundName | null, why: string) {
  if (!import.meta.env.DEV) return
  debug.unshift({ at: Date.now(), event, cue, why })
  debug.length = Math.min(debug.length, 40)
}

function raw(cue: SoundName, opts: PlayOptions = {}) {
  try { cuePlay(cue, { ...opts, volume: Math.min(1, (opts.volume ?? 1) * GAIN[cue]) }) } catch { /* never break the action */ }
}

/** Interface sound: gated by mode tier. */
function ui(event: string, cue: SoundName, tier: Tier, emphasis: Emphasis = 'normal', extra: PlayOptions = {}) {
  if (surface !== 'desktop') return note(event, cue, 'not desktop')
  if (prefs.interface === 'off') return note(event, cue, 'interface off')
  if (tier === 'full' && prefs.interface !== 'full') return note(event, cue, 'subtle mode')
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return note(event, cue, 'hidden')
  // subtle mode strips ornament from everything it does play
  const e: Emphasis = prefs.interface === 'subtle' && emphasis === 'normal' ? 'subtle' : emphasis
  note(event, cue, 'played')
  raw(cue, { emphasis: e, ...extra })
}

/* ── the operational arbiter ──────────────────────────────────────────── */

export type AlertCategory = keyof ExperienceSoundPrefs['alertTypes']
export interface OperationalCue {
  /** canonical event id — the same event never sounds twice, anywhere */
  id: string
  category: AlertCategory
  /** 1 = needs the operator / failure … 5 = ambient */
  priority: number
  cue: Extract<SoundName, 'ready' | 'success' | 'warning' | 'error' | 'attention'>
  emphasis?: Emphasis
  /** ms epoch the event happened — anything before this window started is history */
  at: number
}

const SEEN_MAX = 600
const seen = new Set<string>()
const seenOrder: string[] = []
const lastByCategory = new Map<string, number>()
const COOLDOWN_MS: Record<AlertCategory, number> = {
  sellerReplies: 6000, needsAttention: 8000, sendFailures: 8000, campaignCompletion: 10000,
  closingMilestones: 5000, workflowHolds: 8000, systemDegradation: 30000,
}
const WINDOW_MS = 700
let pending: OperationalCue[] = []
let flushTimer = 0

const channel: BroadcastChannel | null = (() => {
  try { return typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('lc-sound') : null } catch { return null }
})()
channel?.addEventListener('message', (m) => { const id = (m.data as { played?: string })?.played; if (id) remember(id) })

function remember(id: string) {
  if (seen.has(id)) return
  seen.add(id)
  seenOrder.push(id)
  while (seenOrder.length > SEEN_MAX) seen.delete(seenOrder.shift()!)
}

function flush() {
  flushTimer = 0
  const batch = pending
  pending = []
  if (!batch.length) return
  // highest priority wins the window; the rest stay visual
  const best = [...batch].sort((a, b) => a.priority - b.priority)[0]
  for (const e of batch) remember(e.id)
  const now = Date.now()
  const last = lastByCategory.get(best.category) ?? 0
  if (now - last < COOLDOWN_MS[best.category]) return note(best.id, best.cue, 'cooldown')
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  if (hidden && (prefs.background === 'off' || best.priority > 1)) return note(best.id, best.cue, 'background')
  lastByCategory.set(best.category, now)
  channel?.postMessage({ played: best.id })
  note(best.id, best.cue, `played (${batch.length} in window)`)
  raw(best.cue, { emphasis: best.emphasis ?? (best.priority === 1 ? 'normal' : 'subtle') })
}

/** Offer an operational event. Most will stay silent — by design. */
function operational(e: OperationalCue) {
  if (surface !== 'desktop' || !prefs.alerts || !prefs.alertTypes[e.category]) return note(e.id, e.cue, 'alerts off')
  if (seen.has(e.id)) return note(e.id, e.cue, 'duplicate')
  if (e.at < startedAt) { remember(e.id); return note(e.id, e.cue, 'history') }
  pending.push(e)
  if (!flushTimer) flushTimer = window.setTimeout(flush, WINDOW_MS)
}

/* ── the semantic API ─────────────────────────────────────────────────── */

export const sound = {
  ui: {
    tap: (emphasis: Emphasis = 'normal') => ui('ui.tap', 'tap', 'full', emphasis),
    select: (direction?: 'forward' | 'back') => ui('ui.select', 'select', 'subtle', 'subtle', direction ? { direction } : {}),
    toggle: (on: boolean) => ui('ui.toggle', 'toggle', 'full', 'normal', { direction: on ? 'forward' : 'back' }),
  },
  panel: {
    open: () => ui('panel.open', 'open', 'subtle', 'subtle'),
    close: () => ui('panel.close', 'close', 'subtle', 'subtle'),
  },
  navigation: {
    change: (direction: 'forward' | 'back' = 'forward') => ui('navigate', 'navigate', 'full', 'subtle', { direction }),
  },
  command: {
    open: () => ui('command.open', 'open', 'full', 'subtle'),
    execute: () => ui('command.execute', 'select', 'subtle', 'subtle'),
  },
  workspace: {
    pickup: () => ui('workspace.pickup', 'select', 'subtle', 'subtle'),
    drop: (kind: 'split' | 'stack') => ui('workspace.drop', 'tap', 'subtle', kind === 'split' ? 'strong' : 'normal'),
    cancel: () => ui('workspace.cancel', 'close', 'subtle', 'subtle'),
    close: () => ui('workspace.close', 'close', 'subtle', 'subtle'),
    maximize: () => ui('workspace.maximize', 'open', 'subtle', 'subtle'),
    restore: () => ui('workspace.restore', 'close', 'subtle', 'subtle'),
    tab: () => ui('workspace.tab', 'select', 'subtle', 'subtle'),
    switch: (direction: 'forward' | 'back' = 'forward') => ui('workspace.switch', 'navigate', 'subtle', 'subtle', { direction }),
  },
  outcome: {
    /** an explicit operator action definitively completed */
    success: (emphasis: Emphasis = 'normal') => ui('outcome.success', 'success', 'subtle', emphasis),
    error: () => ui('outcome.error', 'error', 'subtle', 'normal'),
    warning: () => ui('outcome.warning', 'warning', 'subtle', 'normal'),
    ready: (emphasis: Emphasis = 'subtle') => ui('outcome.ready', 'ready', 'subtle', emphasis),
    loading: () => ui('outcome.loading', 'loading', 'subtle', 'subtle'),
  },
  /** live machine events from the shell telemetry; the arbiter decides */
  machine: { event: operational },
  /** Settings auditions: plays regardless of mode (the operator asked to hear it). */
  preview: (cue: SoundName, opts: { emphasis?: Emphasis; material?: ExperienceSoundPrefs['material'] } = {}) => {
    try {
      setEnabled(true)
      cuePlay(cue, { emphasis: opts.emphasis ?? 'normal', theme: opts.material ?? prefs.material, volume: GAIN[cue] })
    } catch { /* silent */ } finally { apply() }
  },
}

/** DEV inspector: the last decisions the arbiter made and why. */
export const __soundDebug = () => debug.slice()

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __lcSound?: unknown }).__lcSound = { debug: __soundDebug, prefs: () => prefs }
}
