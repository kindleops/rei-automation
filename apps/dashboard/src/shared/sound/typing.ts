import { renderKeystroke, TYPING_KEYS, TYPING_VARIANTS, type TypingKey, type TypingMaterial } from './typing-synth'
import type { ExperienceSoundPrefs } from './prefs'

/**
 * TYPING SOUNDS — very quiet keystrokes in text fields.
 *
 * One capture-phase keydown listener on the window (passive: it never
 * prevents, stops or claims a key) decides whether a keystroke edits text in
 * a text field, then plays a pre-rendered buffer from the pool for the active
 * material. Nothing is synthesised on the keystroke path; the pool is built on
 * first focus of a text field so the first key is already instant.
 *
 * Never plays: password fields, IME composition, held-key repeat floods,
 * shortcuts (⌘/Ctrl+key), navigation keys, read-only or disabled fields,
 * Enter in a single-line field (the action it submits has its own cue), or
 * anything under [data-lc-typing="off"].
 */

export type { TypingKey, TypingMaterial } from './typing-synth'

/* ── the decision (pure) ──────────────────────────────────────────────── */

export interface KeyLike {
  key: string
  repeat?: boolean
  isComposing?: boolean
  keyCode?: number
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

export interface FieldLike {
  tagName?: string
  type?: string
  readOnly?: boolean
  disabled?: boolean
  isContentEditable?: boolean
  value?: string
  closest?: (selector: string) => unknown
}

export type TypingDecision = { play: TypingKey } | { skip: string }

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number'])

/** 'single' = one-line input, 'multi' = textarea / contenteditable, null = not a text field */
export function editableKind(t: FieldLike | null | undefined): 'single' | 'multi' | 'password' | null {
  if (!t) return null
  const tag = (t.tagName ?? '').toUpperCase()
  if (tag === 'INPUT') {
    const type = (t.type ?? '').toLowerCase()
    if (type === 'password') return 'password'
    return TEXT_INPUT_TYPES.has(type) ? 'single' : null
  }
  if (tag === 'TEXTAREA') return 'multi'
  if (t.isContentEditable) return 'multi'
  return null
}

export function classifyKeystroke(e: KeyLike, target: FieldLike | null | undefined, composing = false): TypingDecision {
  if (composing || e.isComposing || e.keyCode === 229 || e.key === 'Process' || e.key === 'Dead') return { skip: 'ime' }
  if (e.repeat) return { skip: 'repeat' }
  const kind = editableKind(target)
  if (kind === 'password') return { skip: 'password' }
  if (!kind || !target) return { skip: 'not a text field' }
  if (target.readOnly || target.disabled) return { skip: 'read-only' }
  try { if (target.closest?.('[data-lc-typing="off"]')) return { skip: 'opted out' } } catch { /* detached */ }

  const k = e.key
  if (k === 'Backspace' || k === 'Delete') {
    // inputs and textareas expose value; contenteditable hosts do not
    if (typeof target.value === 'string' && target.value.length === 0) return { skip: 'nothing to delete' }
    return { play: 'delete' }
  }
  if (e.metaKey || e.ctrlKey) return { skip: 'shortcut' }
  if (k === 'Enter') return kind === 'single' ? { skip: 'enter submits' } : { play: 'enter' }
  if (k === ' ' || k === 'Spacebar') return { play: 'space' }
  if (k && [...k].length === 1) return { play: 'printable' }
  return { skip: 'non-editing key' }
}

/** Why typing is silent right now, or null when it may sound. */
export function typingBlockedBy(prefs: ExperienceSoundPrefs, desktopSurface: boolean): string | null {
  if (!desktopSurface) return 'not desktop'
  if (prefs.interface === 'off') return 'interface off'
  if (!prefs.typing) return 'typing off'
  if (prefs.volume <= 0 || prefs.typingVolume <= 0) return 'volume 0'
  return null
}

export function resolveTypingMaterial(prefs: Pick<ExperienceSoundPrefs, 'material' | 'typingMaterial'>): TypingMaterial {
  return prefs.typingMaterial === 'follow' ? prefs.material : prefs.typingMaterial
}

/** Typing level: its own control, under the global volume. */
export const typingLevel = (prefs: Pick<ExperienceSoundPrefs, 'volume' | 'typingVolume'>) => prefs.volume * prefs.typingVolume

/** at most one keystroke sound per `gapMs`; a fast typist hears a steady patter, never a smear */
export const MIN_GAP_MS = 32

export function createThrottle(gapMs = MIN_GAP_MS) {
  let last = -Infinity
  return (now: number) => {
    if (now - last < gapMs) return false
    last = now
    return true
  }
}

/* ── the engine (Web Audio, buffer pool) ─────────────────────────────── */

export interface TypingEngine {
  prewarm(material: TypingMaterial): void
  play(material: TypingMaterial, key: TypingKey, level: number, fast?: boolean): void
}

type Ctx = AudioContext

const MAX_VOICES = 6

export function createTypingEngine(deps: { createContext?: () => Ctx | null; random?: () => number } = {}): TypingEngine {
  const random = deps.random ?? Math.random
  const createContext = deps.createContext ?? (() => {
    if (typeof window === 'undefined') return null
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    return C ? new C({ latencyHint: 'interactive' }) : null
  })
  let ctx: Ctx | null = null
  let out: GainNode | null = null
  const pool = new Map<TypingMaterial, Map<TypingKey, AudioBuffer[]>>()
  const lastVariant = new Map<string, number>()
  const voices: AudioBufferSourceNode[] = []

  function context(): Ctx | null {
    if (ctx) return ctx
    try {
      ctx = createContext()
      if (!ctx) return null
      out = ctx.createGain()
      out.gain.value = 1
      out.connect(ctx.destination)
    } catch { ctx = null }
    return ctx
  }

  function buffers(material: TypingMaterial): Map<TypingKey, AudioBuffer[]> | null {
    const c = context()
    if (!c) return null
    let set = pool.get(material)
    if (set) return set
    set = new Map()
    for (const key of TYPING_KEYS) {
      const list: AudioBuffer[] = []
      for (let v = 0; v < TYPING_VARIANTS; v++) {
        const data = renderKeystroke(material, key, v, c.sampleRate)
        const buf = c.createBuffer(1, data.length, c.sampleRate)
        buf.getChannelData(0).set(data)
        list.push(buf)
      }
      set.set(key, list)
    }
    pool.set(material, set)
    return set
  }

  return {
    prewarm(material) { try { buffers(material) } catch { /* silent */ } },
    play(material, key, level, fast = false) {
      try {
        const set = buffers(material)
        const c = ctx
        if (!set || !c || !out) return
        if (c.state === 'suspended') void c.resume().catch(() => {})
        const list = set.get(key)!
        // never the same render twice in a row
        const id = `${material}:${key}`
        let v = Math.floor(random() * list.length)
        if (v === lastVariant.get(id)) v = (v + 1) % list.length
        lastVariant.set(id, v)
        const src = c.createBufferSource()
        src.buffer = list[v]
        // subtle pitch and velocity: a sentence never sounds like one key repeated
        src.playbackRate.value = 1 + (random() * 2 - 1) * 0.035
        const g = c.createGain()
        const velocity = 0.82 + random() * 0.3
        g.gain.value = Math.max(0, Math.min(1, level * velocity * (fast ? 0.8 : 1)))
        src.connect(g).connect(out)
        while (voices.length >= MAX_VOICES) { try { voices.shift()!.stop() } catch { /* already ended */ } }
        voices.push(src)
        src.onended = () => { const i = voices.indexOf(src); if (i >= 0) voices.splice(i, 1); g.disconnect() }
        src.start(c.currentTime)
      } catch { /* never break typing */ }
    },
  }
}

/* ── the controller: listener logic, testable without a DOM ───────────── */

export interface TypingControllerDeps {
  getPrefs: () => ExperienceSoundPrefs
  isDesktop: () => boolean
  engine: TypingEngine
  now?: () => number
  isHidden?: () => boolean
  note?: (key: string, why: string) => void
}

export function createTypingController(deps: TypingControllerDeps) {
  const now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
  const throttle = createThrottle()
  let composing = false
  let lastPlayed = -Infinity
  const note = deps.note ?? (() => {})

  return {
    compositionStart() { composing = true },
    compositionEnd() { composing = false },
    focusIn(target: FieldLike | null | undefined) {
      const prefs = deps.getPrefs()
      if (typingBlockedBy(prefs, deps.isDesktop())) return
      const kind = editableKind(target)
      if (kind === 'single' || kind === 'multi') deps.engine.prewarm(resolveTypingMaterial(prefs))
    },
    /** returns what it decided (for tests and the DEV inspector) */
    keyDown(e: KeyLike, target: FieldLike | null | undefined): TypingDecision {
      const prefs = deps.getPrefs()
      const blocked = typingBlockedBy(prefs, deps.isDesktop())
      if (blocked) return { skip: blocked }
      if (deps.isHidden?.()) return { skip: 'hidden' }
      const d = classifyKeystroke(e, target, composing)
      if ('skip' in d) { note(e.key, d.skip); return d }
      const t = now()
      if (!throttle(t)) { note(e.key, 'throttled'); return { skip: 'throttled' } }
      const fast = t - lastPlayed < 90
      lastPlayed = t
      deps.engine.play(resolveTypingMaterial(prefs), d.play, typingLevel(prefs), fast)
      note(e.key, `played ${d.play}`)
      return d
    },
  }
}

/** Wire the controller to the window. Returns an uninstaller. */
export function installTypingSounds(deps: Omit<TypingControllerDeps, 'engine'> & { engine?: TypingEngine }): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
  const ctl = createTypingController({
    ...deps,
    engine: deps.engine ?? createTypingEngine(),
    isHidden: deps.isHidden ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden'),
  })
  const targetOf = (e: Event) => ((e.composedPath?.()[0] ?? e.target) as FieldLike | null)
  const onKey = (e: Event) => { ctl.keyDown(e as KeyboardEvent, targetOf(e)) }
  const onFocus = (e: Event) => ctl.focusIn(targetOf(e))
  const onStart = () => ctl.compositionStart()
  const onEnd = () => ctl.compositionEnd()
  const opts = { capture: true, passive: true } as const
  window.addEventListener('keydown', onKey, opts)
  window.addEventListener('focusin', onFocus, opts)
  window.addEventListener('compositionstart', onStart, opts)
  window.addEventListener('compositionend', onEnd, opts)
  return () => {
    window.removeEventListener('keydown', onKey, opts)
    window.removeEventListener('focusin', onFocus, opts)
    window.removeEventListener('compositionstart', onStart, opts)
    window.removeEventListener('compositionend', onEnd, opts)
  }
}

/** Settings audition: a short phrase in the chosen material — "type, space, type, delete, return". */
export const PREVIEW_PHRASE: ReadonlyArray<[TypingKey, number]> = [
  ['printable', 0], ['printable', 110], ['printable', 205], ['printable', 290], ['space', 400],
  ['printable', 500], ['printable', 590], ['printable', 700], ['delete', 860], ['enter', 1080],
]
