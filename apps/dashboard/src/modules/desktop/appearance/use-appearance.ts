import { useSyncExternalStore } from 'react'
import { applyThemeToDOM, loadSettings, saveSettings, subscribeSettings, type AccentPalette, type NexusSettings, type NexusTheme } from '../../../shared/settings'
import {
  BUILT_IN_ENVIRONMENTS, DEFAULT_MATERIAL, defaultAppearance, deleteEnvironment, duplicateEnvironment, fieldsFromSnapshot, normalizeMaterial,
  pushRecentColor, renameEnvironment, saveEnvironment, snapshotOf, toggleSavedColor,
  type AppearanceLibrary, type AppearanceSnapshot, type AppearanceState, type EnvironmentState, type MaterialState, type SavedEnvironment,
} from '../../../shared/color/appearance'
import { RED_OPS_SIGNAL, type AccentId } from '../../../shared/color/accents'
import { resolveFoundation, type FoundationId } from '../../../shared/color/derive'
import { getAppearanceDraft, setAppearanceDraft, subscribeAppearanceDraft, withAppearanceTransition, type AppearanceDraft, type AppearanceTransitionKind } from '../../../shared/color/runtime'
import { computeAppearance, type AppearanceComputed } from '../../../shared/color/tokens'

/**
 * The Studio's state: the stored appearance with the live-preview draft on
 * top, one save per settled gesture, and a single step of undo.
 *
 *   preview(patch)  repaint now (CSS variables only), persist ~260 ms after
 *                   the gesture settles — never 120 writes a second
 *   flush()         persist immediately (pointer up, Done, blur)
 *   cancel()        drop an uncommitted preview (Esc in the colour editor)
 *   commit(patch)   a discrete change (theme, preset, material…): saved at
 *                   once, inside one coherent transition when it asks for one
 */

export interface AppearanceFieldsView {
  nexusTheme: NexusTheme
  accentPalette: AccentPalette
  appearance: AppearanceState
  liquidGlass: MaterialState
}

export interface AppearanceView extends AppearanceFieldsView {
  foundation: FoundationId
  library: AppearanceLibrary
  animationsEnabled: boolean
  computed: AppearanceComputed
  previewing: boolean
}

type StoredPatch = Partial<Pick<NexusSettings, 'nexusTheme' | 'accentPalette' | 'appearance' | 'liquidGlass' | 'appearanceLibrary' | 'animationsEnabled'>>

const fieldsOf = (s: NexusSettings, draft: AppearanceDraft | null): AppearanceFieldsView => ({
  nexusTheme: s.nexusTheme,
  accentPalette: draft?.accentPalette ?? s.accentPalette,
  appearance: draft?.appearance ?? s.appearance,
  liquidGlass: normalizeMaterial(draft?.liquidGlass ?? s.liquidGlass ?? DEFAULT_MATERIAL),
})

function makeView(s: NexusSettings, draft: AppearanceDraft | null): AppearanceView {
  const f = fieldsOf(s, draft)
  return {
    ...f,
    foundation: resolveFoundation(f.nexusTheme),
    library: s.appearanceLibrary,
    animationsEnabled: s.animationsEnabled !== false,
    computed: computeAppearance({ nexusTheme: f.nexusTheme, accentPalette: f.accentPalette, appearance: f.appearance, liquidGlass: f.liquidGlass }),
    previewing: Boolean(draft),
  }
}

/* The stored view re-renders only when a change is persisted. The live view
   (draft included) re-renders every preview frame — only surfaces that must
   show the in-flight value read it; the product itself repaints through CSS
   variables either way. */
let storedKey: NexusSettings | null = null
let storedValue: AppearanceView | null = null
function readStored(): AppearanceView {
  const s = loadSettings()
  if (storedValue && storedKey === s) return storedValue
  storedKey = s
  storedValue = makeView(s, null)
  return storedValue
}

let liveKey: [NexusSettings, AppearanceDraft | null] | null = null
let liveValue: AppearanceView | null = null
function readLive(): AppearanceView {
  const s = loadSettings()
  const draft = getAppearanceDraft()
  if (liveValue && liveKey && liveKey[0] === s && liveKey[1] === draft) return liveValue
  liveKey = [s, draft]
  liveValue = makeView(s, draft)
  return liveValue
}

const subscribeBoth = (fn: () => void) => {
  const a = subscribeSettings(fn)
  const b = subscribeAppearanceDraft(fn)
  return () => { a(); b() }
}

/**
 * The appearance the Studio shows. `live` includes the in-flight preview
 * (re-renders per frame while dragging); the default reads what is stored.
 */
export function useAppearanceView(live = false): AppearanceView {
  return useSyncExternalStore(live ? subscribeBoth : subscribeSettings, live ? readLive : readStored, live ? readLive : readStored)
}

/* ── one step of undo ──────────────────────────────────────────────────── */

let undoFields: AppearanceFieldsView | null = null
const undoListeners = new Set<() => void>()
const setUndo = (next: AppearanceFieldsView | null) => { undoFields = next; undoListeners.forEach((fn) => fn()) }
const storedFields = (): AppearanceFieldsView => fieldsOf(loadSettings(), null)

export function useUndoAvailable(): boolean {
  return useSyncExternalStore(
    (fn) => { undoListeners.add(fn); return () => { undoListeners.delete(fn) } },
    () => undoFields !== null,
    () => false,
  )
}

export function undoAppearance(): void {
  const prev = undoFields
  if (!prev) return
  cancelPreview()
  withAppearanceTransition('theme', () => {
    // read "where you are" when the undo actually lands (after anything queued)
    const now = storedFields()
    saveSettings({ ...loadSettings(), ...prev })
    applyThemeToDOM()
    // Undo is one step and toggles: undoing again returns to where you were.
    setUndo(now)
  })
}

/* ── discrete commits ──────────────────────────────────────────────────── */

export function commitAppearance(patch: StoredPatch, opts: { transition?: AppearanceTransitionKind; undoable?: boolean } = {}): void {
  flushPreview()
  const undoable = opts.undoable !== false && ('nexusTheme' in patch || 'accentPalette' in patch || 'appearance' in patch || 'liquidGlass' in patch)
  // applyThemeToDOM is idempotent (memoised); calling it here keeps the
  // transition's new frame exact even if no shell subscriber is mounted.
  // "before" is read when the change lands, so queued changes undo one at a time.
  const apply = () => {
    const before = storedFields()
    saveSettings({ ...loadSettings(), ...patch })
    applyThemeToDOM()
    if (undoable) setUndo(before)
  }
  if (opts.transition) withAppearanceTransition(opts.transition, apply)
  else apply()
}

/* ── live preview: repaint now, persist when the gesture settles ───────── */

const SETTLE_MS = 260
let settleTimer = 0
/** The stored look before the current gesture began (one gesture = one undo step). */
let gestureBefore: AppearanceFieldsView | null = null

/*
 * Persistence never runs while a pointer is held: a drag repaints every frame
 * but is written once, when the pointer lifts. (Timing alone is not enough —
 * on a busy machine the gap between two pointer moves can exceed any idle
 * window.) Keyboard nudges persist after a short idle.
 */
let pointerHeld = false
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => { pointerHeld = true }, true)
  const lift = () => {
    pointerHeld = false
    if (getAppearanceDraft()) {
      window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(() => flushPreview({ endGesture: true }), 0)
    }
  }
  window.addEventListener('pointerup', lift, true)
  window.addEventListener('pointercancel', lift, true)
  window.addEventListener('blur', lift)
}

export function previewAppearance(patch: AppearanceDraft): void {
  if (!gestureBefore) gestureBefore = storedFields()
  setAppearanceDraft({ ...(getAppearanceDraft() ?? {}), ...patch })
  if (typeof window === 'undefined') return
  window.clearTimeout(settleTimer)
  if (pointerHeld) return
  // an idle pause persists (so a reload never loses it) but does not end
  // the gesture — undo still returns to before it began
  settleTimer = window.setTimeout(() => flushPreview({ endGesture: false }), SETTLE_MS)
}

/**
 * Persist the live preview now. `endGesture` (pointer up, Done, blur) also
 * closes the gesture and makes it the one undoable step.
 */
export function flushPreview(opts: { endGesture?: boolean; undoable?: boolean } = {}): void {
  const { endGesture = true, undoable = true } = opts
  if (typeof window !== 'undefined') window.clearTimeout(settleTimer)
  const draft = getAppearanceDraft()
  if (draft) {
    setAppearanceDraft(null)
    saveSettings({ ...loadSettings(), ...draft })
    applyThemeToDOM()
  }
  if (endGesture && gestureBefore) {
    if (undoable && JSON.stringify(gestureBefore) !== JSON.stringify(storedFields())) setUndo(gestureBefore)
    gestureBefore = null
  }
}

export function cancelPreview(): void {
  if (typeof window !== 'undefined') window.clearTimeout(settleTimer)
  if (getAppearanceDraft()) setAppearanceDraft(null)
  gestureBefore = null
}

/* ── library ───────────────────────────────────────────────────────────── */

const library = () => loadSettings().appearanceLibrary

export function rememberColor(hex: string): void {
  saveSettings({ ...loadSettings(), appearanceLibrary: pushRecentColor(library(), hex) })
}

export function toggleFavoriteColor(hex: string): void {
  saveSettings({ ...loadSettings(), appearanceLibrary: toggleSavedColor(library(), hex) })
}

export function currentSnapshot(): AppearanceSnapshot {
  const f = storedFields()
  return snapshotOf({ nexusTheme: f.nexusTheme, accentPalette: f.accentPalette, appearance: f.appearance, liquidGlass: f.liquidGlass })
}

export function saveCurrentEnvironment(name: string): SavedEnvironment {
  flushPreview()
  const { lib, entry } = saveEnvironment(library(), name, currentSnapshot(), Date.now())
  saveSettings({ ...loadSettings(), appearanceLibrary: lib })
  return entry
}

export function applyEnvironment(entry: SavedEnvironment): void {
  const s = loadSettings()
  const fields = fieldsFromSnapshot(entry.snapshot, s.appearance)
  commitAppearance({ ...fields, nexusTheme: fields.nexusTheme as NexusTheme, accentPalette: fields.accentPalette as AccentPalette }, { transition: 'theme' })
}

export function duplicateSavedEnvironment(entry: SavedEnvironment): SavedEnvironment {
  const { lib, entry: copy } = duplicateEnvironment(library(), entry, Date.now())
  saveSettings({ ...loadSettings(), appearanceLibrary: lib })
  return copy
}

export function renameSavedEnvironment(id: string, name: string): void {
  saveSettings({ ...loadSettings(), appearanceLibrary: renameEnvironment(library(), id, name) })
}

export function deleteSavedEnvironment(id: string): void {
  saveSettings({ ...loadSettings(), appearanceLibrary: deleteEnvironment(library(), id) })
}

/** Put an environment back exactly as it was (Cancel in the colour editor) — not an undo step. */
export function restoreEnvironment(env: EnvironmentState): void {
  const s = loadSettings()
  commitAppearance({ appearance: { ...s.appearance, environment: env } }, { undoable: false })
}

/* ── resets ────────────────────────────────────────────────────────────── */

/** Each theme's own accent: Red Ops keeps its signal red; every other theme, Cyan. */
export function themeDefaultAccent(theme: FoundationId): { palette: AccentId; custom?: string } {
  return theme === 'red_ops' ? { palette: 'custom', custom: RED_OPS_SIGNAL } : { palette: 'cyan' }
}

export function resetAccent(view: AppearanceView): void {
  const d = themeDefaultAccent(view.foundation)
  commitAppearance({
    accentPalette: d.palette,
    appearance: { ...view.appearance, accent: { custom: d.custom ?? view.appearance.accent.custom, intensity: 50 } },
  }, { transition: 'accent' })
}

export function resetEnvironment(view: AppearanceView): void {
  commitAppearance({ appearance: { ...view.appearance, environment: defaultAppearance().environment, motion: view.appearance.motion } }, { transition: 'environment' })
}

export function resetMaterial(): void {
  commitAppearance({ liquidGlass: { ...DEFAULT_MATERIAL } }, { transition: 'material' })
}

export function resetEverything(): void {
  applyEnvironment(BUILT_IN_ENVIRONMENTS[0])
}

export const BUILT_INS = BUILT_IN_ENVIRONMENTS
