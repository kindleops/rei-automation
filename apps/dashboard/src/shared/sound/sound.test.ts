import { beforeEach, describe, expect, it, vi } from 'vitest'

const played: Array<{ cue: string; opts: unknown }> = []
vi.mock('cuelume', () => ({
  play: (cue: string, opts: unknown) => { played.push({ cue, opts }) },
  setEnabled: () => {},
  setTheme: () => {},
  setVolume: () => {},
}))

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, clear: () => m.clear() }
}

async function fresh() {
  vi.resetModules()
  played.length = 0
  Object.assign(globalThis, {
    localStorage: memoryStorage(),
    window: { setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number, clearTimeout: (id: number) => clearTimeout(id), addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined as unknown },
    document: { visibilityState: 'visible' },
  })
  const mod = await import('./index')
  mod.setSoundSurface('desktop')
  return mod
}

describe('the sound arbiter', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('one canonical event makes one sound, however many surfaces offer it', async () => {
    const { sound } = await fresh()
    const e = { id: 'evt-1', category: 'sellerReplies' as const, priority: 2, cue: 'ready' as const, at: Date.now() + 10 }
    sound.machine.event(e)
    sound.machine.event(e)
    sound.machine.event({ ...e })
    vi.advanceTimersByTime(800)
    expect(played.filter((p) => p.cue === 'ready')).toHaveLength(1)
  })

  it('a burst plays only its most important cue', async () => {
    const { sound } = await fresh()
    const now = Date.now() + 10
    for (let i = 0; i < 10; i++) sound.machine.event({ id: `r${i}`, category: 'sellerReplies', priority: 2, cue: 'ready', at: now })
    sound.machine.event({ id: 'hold', category: 'needsAttention', priority: 1, cue: 'attention', at: now })
    vi.advanceTimersByTime(800)
    expect(played.map((p) => p.cue)).toEqual(['attention'])
  })

  it('history never sounds (cold load, reconnect)', async () => {
    const { sound } = await fresh()
    sound.machine.event({ id: 'old', category: 'needsAttention', priority: 1, cue: 'attention', at: Date.now() - 60_000 })
    vi.advanceTimersByTime(800)
    expect(played).toHaveLength(0)
  })

  it('the same alert category cools down', async () => {
    const { sound } = await fresh()
    const t = Date.now() + 10
    sound.machine.event({ id: 'a', category: 'sellerReplies', priority: 2, cue: 'ready', at: t })
    vi.advanceTimersByTime(800)
    sound.machine.event({ id: 'b', category: 'sellerReplies', priority: 2, cue: 'ready', at: t + 1000 })
    vi.advanceTimersByTime(800)
    expect(played).toHaveLength(1)
  })

  it('interface sounds respect the mode: subtle skips taps, off is silent', async () => {
    const { sound } = await fresh()
    sound.ui.tap()
    sound.panel.open()
    expect(played.map((p) => p.cue)).toEqual(['open'])
    const { writeSoundPrefs } = await import('./prefs')
    writeSoundPrefs({ interface: 'off' })
    sound.panel.open()
    expect(played).toHaveLength(1)
  })

  it('"Pause all alerts" holds operational sound — and unpausing never replays it', async () => {
    const { sound } = await fresh()
    const { updateSetting } = await import('../settings')
    const t = Date.now() + 10
    updateSetting('notificationMasterMuted', true)
    sound.machine.event({ id: 'held', category: 'needsAttention', priority: 1, cue: 'attention', at: t })
    vi.advanceTimersByTime(800)
    expect(played).toHaveLength(0)
    updateSetting('notificationMasterMuted', false)
    sound.machine.event({ id: 'held', category: 'needsAttention', priority: 1, cue: 'attention', at: t })
    vi.advanceTimersByTime(800)
    expect(played).toHaveLength(0)
    sound.machine.event({ id: 'fresh', category: 'needsAttention', priority: 1, cue: 'attention', at: t + 5 })
    vi.advanceTimersByTime(800)
    expect(played.map((p) => p.cue)).toEqual(['attention'])
  })

  it('quiet hours hold operational sound', async () => {
    const { sound } = await fresh()
    const { updateSetting } = await import('../settings')
    updateSetting('notificationQuietHoursEnabled', true)
    updateSetting('notificationQuietHoursStart', '00:00')
    updateSetting('notificationQuietHoursEnd', '00:00') // start === end: quiet all day
    sound.machine.event({ id: 'q', category: 'needsAttention', priority: 1, cue: 'attention', at: Date.now() + 10 })
    vi.advanceTimersByTime(800)
    expect(played).toHaveLength(0)
  })

  it('stays silent off the desktop surface', async () => {
    const { sound, setSoundSurface } = await fresh()
    setSoundSurface('other')
    sound.panel.open()
    sound.workspace.drop('split')
    expect(played).toHaveLength(0)
  })
})
