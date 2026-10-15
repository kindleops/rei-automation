import { describe, expect, it } from 'vitest'
import { globalKeyAction } from '../../agent/ask/ask-model'
import { composerKey, EMPTY_HISTORY, globalIcKey, historyNext, historyPrev, nextMode, PLAN_COMMAND, pushHistory } from './composer-model'

const base = { mentionOpen: false, running: false, empty: false, chips: 0, caretAtStart: true, caretAtEnd: true, overlay: true }

describe('composer key map', () => {
  it('⌘↵ and ↵ send, ⇧↵ is a newline', () => {
    expect(composerKey({ key: 'Enter', metaKey: true }, base)).toBe('send')
    expect(composerKey({ key: 'Enter' }, base)).toBe('send')
    expect(composerKey({ key: 'Enter', shiftKey: true }, base)).toBe('newline')
    expect(composerKey({ key: 'Enter', isComposing: true }, base)).toBeNull()
  })
  it('↑ / ↓ walk history only from the first / last line', () => {
    expect(composerKey({ key: 'ArrowUp' }, base)).toBe('history-prev')
    expect(composerKey({ key: 'ArrowUp' }, { ...base, caretAtStart: false })).toBeNull()
    expect(composerKey({ key: 'ArrowDown' }, base)).toBe('history-next')
  })
  it('Esc cancels a running run first, else closes the overlay; ⇧⇥ cycles the mode', () => {
    expect(composerKey({ key: 'Escape' }, { ...base, running: true })).toBe('stop')
    expect(composerKey({ key: 'Escape' }, base)).toBe('close')
    expect(composerKey({ key: 'Escape' }, { ...base, overlay: false })).toBeNull()
    expect(composerKey({ key: 'Tab', shiftKey: true }, base)).toBe('cycle-mode')
    expect(nextMode('ask')).toBe('plan')
    expect(nextMode('plan')).toBe('act')
    expect(nextMode('act')).toBe('ask')
  })
  it('the mention popover takes the arrows and Enter while open', () => {
    const s = { ...base, mentionOpen: true }
    expect(composerKey({ key: 'ArrowDown' }, s)).toBe('mention-next')
    expect(composerKey({ key: 'Enter' }, s)).toBe('mention-pick')
    expect(composerKey({ key: 'Escape' }, s)).toBe('mention-close')
  })
  it('⌫ on an empty composer removes the last chip', () => {
    expect(composerKey({ key: 'Backspace' }, { ...base, empty: true, chips: 2 })).toBe('remove-chip')
    expect(composerKey({ key: 'Backspace' }, { ...base, empty: false, chips: 2 })).toBeNull()
  })
})

describe('global chords never collide with the shell', () => {
  it("⌘⇧E opens Intelligence Command and ⌘' toggles the composer", () => {
    expect(globalIcKey({ key: 'E', metaKey: true, shiftKey: true })).toBe('open-ic')
    expect(globalIcKey({ key: 'e', ctrlKey: true, shiftKey: true })).toBe('open-ic')
    expect(globalIcKey({ key: "'", metaKey: true })).toBe('toggle-composer')
  })
  it('⌘K, ⌘L, ⌘⇧L, ⌘J, ⌘E and bare keys are not claimed', () => {
    for (const k of [{ key: 'k', metaKey: true }, { key: 'l', metaKey: true }, { key: 'L', metaKey: true, shiftKey: true }, { key: 'j', metaKey: true }, { key: 'e', metaKey: true }, { key: "'" }, { key: 'E', shiftKey: true }, { key: 'E', metaKey: true, shiftKey: true, altKey: true }]) {
      expect(globalIcKey(k)).toBeNull()
    }
  })
  it('the agent dock keeps ⌘L / ⌘⇧L and does not react to the new chords', () => {
    expect(globalKeyAction({ key: 'E', metaKey: true, shiftKey: true }, { insideAgent: false })).toBeNull()
    expect(globalKeyAction({ key: "'", metaKey: true }, { insideAgent: false })).toBeNull()
    expect(globalKeyAction({ key: 'l', metaKey: true }, { insideAgent: false })).toBe('focus-dock')
  })
})

describe('prompt history', () => {
  it('↑ steps back through sent prompts, ↓ returns to the unsent draft', () => {
    let h = pushHistory(EMPTY_HISTORY, 'first')
    h = pushHistory(h, 'second')
    h = pushHistory(h, 'first') // de-duplicated, most recent first
    expect(h.items).toEqual(['first', 'second'])
    const a = historyPrev(h, 'my draft')
    expect(a.text).toBe('first')
    const b = historyPrev(a.h, a.text)
    expect(b.text).toBe('second')
    const c = historyPrev(b.h, b.text)
    expect(c.text).toBe('second') // stops at the oldest
    const d = historyNext(c.h, c.text)
    expect(d.text).toBe('first')
    const e = historyNext(d.h, d.text)
    expect(e.text).toBe('my draft')
    expect(e.h.cursor).toBeNull()
  })
})

describe('Plan mode', () => {
  it('frames a plan with the read-only research agent and asks for approval points', () => {
    expect(PLAN_COMMAND.framing).toMatch(/^PLAN A MISSION/)
    expect(PLAN_COMMAND.framing).toMatch(/approval/)
  })
})
