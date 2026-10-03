import { describe, expect, it } from 'vitest'
import { browserKeyAction, type KeyLike } from './keys'

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })
const mac = { active: true, editing: false, mac: true }
const win = { active: true, editing: false, mac: false }

describe('Browser key scope', () => {
  it('maps the Browser chords on macOS', () => {
    expect(browserKeyAction(k('l', { metaKey: true }), mac)).toBe('focus-address')
    expect(browserKeyAction(k('r', { metaKey: true }), mac)).toBe('reload')
    expect(browserKeyAction(k('t', { metaKey: true }), mac)).toBe('new-tab')
    expect(browserKeyAction(k('w', { metaKey: true }), mac)).toBe('close-tab')
    expect(browserKeyAction(k('ArrowLeft', { altKey: true }), mac)).toBe('back')
    expect(browserKeyAction(k('ArrowRight', { altKey: true }), mac)).toBe('forward')
  })

  it('uses Ctrl elsewhere and ignores ⌘ there', () => {
    expect(browserKeyAction(k('l', { ctrlKey: true }), win)).toBe('focus-address')
    expect(browserKeyAction(k('l', { metaKey: true }), win)).toBeNull()
  })

  it('does nothing unless the Browser is the focused pane', () => {
    expect(browserKeyAction(k('r', { metaKey: true }), { ...mac, active: false })).toBeNull()
    expect(browserKeyAction(k('ArrowLeft', { altKey: true }), { ...mac, active: false })).toBeNull()
  })

  it('never takes ⌘K (the Command Deck)', () => {
    expect(browserKeyAction(k('k', { metaKey: true }), mac)).toBeNull()
    expect(browserKeyAction(k('k', { ctrlKey: true }), win)).toBeNull()
  })

  it('never takes workspace chords (⌥⇧ arrows / ⌥⇧W) or shifted variants', () => {
    expect(browserKeyAction(k('ArrowLeft', { altKey: true, shiftKey: true }), mac)).toBeNull()
    expect(browserKeyAction(k('W', { altKey: true, shiftKey: true }), mac)).toBeNull()
    expect(browserKeyAction(k('r', { metaKey: true, shiftKey: true }), mac)).toBeNull()
  })

  it('leaves ⌥←/→ to text fields (word jump)', () => {
    expect(browserKeyAction(k('ArrowLeft', { altKey: true }), { ...mac, editing: true })).toBeNull()
    // ⌘L still focuses the address from a field
    expect(browserKeyAction(k('l', { metaKey: true }), { ...mac, editing: true })).toBe('focus-address')
  })

  it('ignores plain letters (global single-key jumps keep working)', () => {
    expect(browserKeyAction(k('r'), mac)).toBeNull()
    expect(browserKeyAction(k('t'), mac)).toBeNull()
  })
})
