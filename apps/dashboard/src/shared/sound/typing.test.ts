import { describe, expect, it } from 'vitest'
import { DEFAULT_SOUND_PREFS, type ExperienceSoundPrefs } from './prefs'
import { classifyKeystroke, createThrottle, createTypingController, resolveTypingMaterial, typingBlockedBy, type FieldLike, type TypingEngine } from './typing'
import { renderKeystroke, TYPING_KEYS, TYPING_MATERIALS } from './typing-synth'

const input = (over: Partial<FieldLike> = {}): FieldLike => ({ tagName: 'INPUT', type: 'text', value: 'abc', ...over })
const textarea = (over: Partial<FieldLike> = {}): FieldLike => ({ tagName: 'TEXTAREA', value: 'abc', ...over })
const editable = (): FieldLike => ({ tagName: 'DIV', isContentEditable: true })

function rig(over: Partial<ExperienceSoundPrefs> = {}, opts: { desktop?: boolean } = {}) {
  const plays: Array<{ material: string; key: string; level: number }> = []
  const warmed: string[] = []
  const engine: TypingEngine = { play: (material, key, level) => { plays.push({ material, key, level }) }, prewarm: (m) => { warmed.push(m) } }
  let prefs: ExperienceSoundPrefs = { ...DEFAULT_SOUND_PREFS, typing: true, ...over }
  let t = 0
  const ctl = createTypingController({ getPrefs: () => prefs, isDesktop: () => opts.desktop ?? true, engine, now: () => t })
  return {
    ctl, plays, warmed,
    setPrefs: (p: Partial<ExperienceSoundPrefs>) => { prefs = { ...prefs, ...p } },
    advance: (ms: number) => { t += ms },
  }
}

describe('typing sounds: setting gating', () => {
  it('is silent until the operator opts in (default off), then plays', () => {
    const r = rig({ typing: false })
    expect(r.ctl.keyDown({ key: 'a' }, input())).toEqual({ skip: 'typing off' })
    r.setPrefs({ typing: true })
    r.advance(100)
    expect(r.ctl.keyDown({ key: 'a' }, input())).toEqual({ play: 'printable' })
    expect(r.plays).toHaveLength(1)
  })

  it('interface sounds Off silences typing; Subtle and Full both allow it', () => {
    expect(typingBlockedBy({ ...DEFAULT_SOUND_PREFS, typing: true, interface: 'off' }, true)).toBe('interface off')
    expect(typingBlockedBy({ ...DEFAULT_SOUND_PREFS, typing: true, interface: 'subtle' }, true)).toBeNull()
    expect(typingBlockedBy({ ...DEFAULT_SOUND_PREFS, typing: true, interface: 'full' }, true)).toBeNull()
  })

  it('stays silent off the desktop surface and at zero volume', () => {
    expect(rig({}, { desktop: false }).ctl.keyDown({ key: 'a' }, input())).toEqual({ skip: 'not desktop' })
    expect(typingBlockedBy({ ...DEFAULT_SOUND_PREFS, typing: true, typingVolume: 0 }, true)).toBe('volume 0')
  })

  it('plays at the typing level under the global volume', () => {
    const r = rig({ volume: 0.4, typingVolume: 0.5 })
    r.ctl.keyDown({ key: 'a' }, input())
    expect(r.plays[0].level).toBeCloseTo(0.2)
  })

  it('pre-renders the pool when a text field takes focus', () => {
    const r = rig({ material: 'press' })
    r.ctl.focusIn({ tagName: 'BUTTON' })
    r.ctl.focusIn(input())
    expect(r.warmed).toEqual(['press'])
  })
})

describe('typing sounds: what counts as typing', () => {
  it('maps keys to distinct keystroke, space, delete and enter sounds', () => {
    expect(classifyKeystroke({ key: 'x' }, textarea())).toEqual({ play: 'printable' })
    expect(classifyKeystroke({ key: 'é' }, textarea())).toEqual({ play: 'printable' })
    expect(classifyKeystroke({ key: ' ' }, textarea())).toEqual({ play: 'space' })
    expect(classifyKeystroke({ key: 'Backspace' }, textarea())).toEqual({ play: 'delete' })
    expect(classifyKeystroke({ key: 'Backspace', metaKey: true }, textarea())).toEqual({ play: 'delete' })
    expect(classifyKeystroke({ key: 'Enter' }, textarea())).toEqual({ play: 'enter' })
    expect(classifyKeystroke({ key: 'Enter' }, editable())).toEqual({ play: 'enter' })
  })

  it('never plays in password fields', () => {
    expect(classifyKeystroke({ key: 'a' }, input({ type: 'password' }))).toEqual({ skip: 'password' })
    expect(classifyKeystroke({ key: 'Backspace' }, input({ type: 'PASSWORD' }))).toEqual({ skip: 'password' })
  })

  it('never plays during IME composition', () => {
    expect(classifyKeystroke({ key: 'a', isComposing: true }, input())).toEqual({ skip: 'ime' })
    expect(classifyKeystroke({ key: 'a', keyCode: 229 }, input())).toEqual({ skip: 'ime' })
    expect(classifyKeystroke({ key: 'Process' }, input())).toEqual({ skip: 'ime' })
    const r = rig()
    r.ctl.compositionStart()
    expect(r.ctl.keyDown({ key: 'k' }, input())).toEqual({ skip: 'ime' })
    r.ctl.compositionEnd()
    r.advance(100)
    expect(r.ctl.keyDown({ key: 'k' }, input())).toEqual({ play: 'printable' })
  })

  it('never plays key-repeat floods, shortcuts, navigation keys or non-text fields', () => {
    expect(classifyKeystroke({ key: 'a', repeat: true }, input())).toEqual({ skip: 'repeat' })
    expect(classifyKeystroke({ key: 'Backspace', repeat: true }, input())).toEqual({ skip: 'repeat' })
    expect(classifyKeystroke({ key: 'c', metaKey: true }, input())).toEqual({ skip: 'shortcut' })
    expect(classifyKeystroke({ key: 'ArrowLeft' }, input())).toEqual({ skip: 'non-editing key' })
    expect(classifyKeystroke({ key: 'Shift' }, input())).toEqual({ skip: 'non-editing key' })
    expect(classifyKeystroke({ key: 'a' }, input({ type: 'checkbox' }))).toEqual({ skip: 'not a text field' })
    expect(classifyKeystroke({ key: 'a' }, { tagName: 'BUTTON' })).toEqual({ skip: 'not a text field' })
    expect(classifyKeystroke({ key: 'a' }, input({ readOnly: true }))).toEqual({ skip: 'read-only' })
    expect(classifyKeystroke({ key: 'a' }, input({ closest: (s) => (s.includes('data-lc-typing') ? {} : null) }))).toEqual({ skip: 'opted out' })
  })

  it('Enter in a single-line field (search, address bar) is the action, not typing', () => {
    expect(classifyKeystroke({ key: 'Enter' }, input({ type: 'search' }))).toEqual({ skip: 'enter submits' })
  })

  it('Backspace in an empty field has nothing to delete', () => {
    expect(classifyKeystroke({ key: 'Backspace' }, input({ value: '' }))).toEqual({ skip: 'nothing to delete' })
  })
})

describe('typing sounds: throttling', () => {
  it('plays at most one sound per 32 ms', () => {
    const allow = createThrottle(32)
    expect(allow(0)).toBe(true)
    expect(allow(10)).toBe(false)
    expect(allow(31)).toBe(false)
    expect(allow(32)).toBe(true)
  })

  it('a burst of fast keys plays a steady patter, not every key', () => {
    const r = rig()
    for (let i = 0; i < 20; i++) { r.ctl.keyDown({ key: 'a' }, input()); r.advance(10) }
    // 200 ms of keys every 10 ms → one every ≥32 ms
    expect(r.plays.length).toBeGreaterThanOrEqual(4)
    expect(r.plays.length).toBeLessThanOrEqual(7)
  })
})

describe('typing sounds: material selection', () => {
  it('follows the global material unless overridden', () => {
    expect(resolveTypingMaterial({ material: 'press', typingMaterial: 'follow' })).toBe('press')
    expect(resolveTypingMaterial({ material: 'press', typingMaterial: 'bubble' })).toBe('bubble')
    const r = rig({ material: 'default', typingMaterial: 'follow' })
    r.ctl.keyDown({ key: 'a' }, input())
    r.setPrefs({ typingMaterial: 'mech' })
    r.advance(100)
    r.ctl.keyDown({ key: 'a' }, input())
    expect(r.plays.map((p) => p.material)).toEqual(['default', 'mech'])
  })

  it('every material renders a distinct, level-matched, non-silent sound per key', () => {
    const sr = 48000
    const sig = new Set<string>()
    for (const m of TYPING_MATERIALS) {
      for (const k of TYPING_KEYS) {
        const a = renderKeystroke(m, k, 0, sr)
        const b = renderKeystroke(m, k, 1, sr)
        let peak = 0
        let diff = 0
        for (let i = 0; i < a.length; i++) { peak = Math.max(peak, Math.abs(a[i])); if (i < b.length) diff += Math.abs(a[i] - b[i]) }
        expect(peak).toBeGreaterThan(0.3)
        expect(peak).toBeLessThanOrEqual(0.7)
        expect(diff).toBeGreaterThan(0) // variants differ
        expect(Math.abs(a[a.length - 1])).toBeLessThan(0.01) // no end click
        sig.add(`${a.length}:${a.slice(0, 400).reduce((s, x) => s + Math.abs(x), 0).toFixed(3)}`)
      }
    }
    expect(sig.size).toBe(TYPING_MATERIALS.length * TYPING_KEYS.length)
  })

})
