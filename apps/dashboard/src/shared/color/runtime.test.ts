import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * withAppearanceTransition under a fake document: discrete changes keep
 * their order even when a second one arrives before the first transition has
 * run its update, and a stalled transition can never hold the system.
 */

type Cb = () => void
let pending: Cb | null = null
let resolveFinished: (() => void) | null = null
let skipped = 0
const attrs = new Map<string, string>()

function install(supported = true) {
  pending = null
  resolveFinished = null
  skipped = 0
  attrs.clear()
  const root = {
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    style: { setProperty: () => undefined, removeProperty: () => undefined },
  }
  vi.stubGlobal('window', { setTimeout, clearTimeout, matchMedia: () => ({ matches: false }), requestAnimationFrame: (fn: Cb) => setTimeout(fn, 0) })
  vi.stubGlobal('document', {
    documentElement: root,
    visibilityState: 'visible',
    ...(supported
      ? {
          startViewTransition: (cb: Cb) => {
            pending = cb
            return {
              finished: new Promise<void>((r) => { resolveFinished = r }),
              skipTransition: () => { skipped += 1 },
            }
          },
        }
      : {}),
  })
}

describe('withAppearanceTransition', () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('applies changes in click order even when the second arrives before the first update ran', async () => {
    install()
    const { withAppearanceTransition } = await import('./runtime')
    const order: string[] = []
    withAppearanceTransition('theme', () => order.push('light'))
    withAppearanceTransition('theme', () => order.push('true_black'))
    expect(order).toEqual([])
    expect(attrs.get('data-lc-vt')).toBe('theme')
    pending?.()
    expect(order).toEqual(['light', 'true_black'])
    resolveFinished?.()
    await vi.runAllTimersAsync()
    expect(attrs.has('data-lc-vt')).toBe(false)
  })

  it('applies a change immediately while a transition is already animating', async () => {
    install()
    const { withAppearanceTransition } = await import('./runtime')
    const order: string[] = []
    withAppearanceTransition('theme', () => order.push('a'))
    pending?.()
    withAppearanceTransition('accent', () => order.push('b'))
    expect(order).toEqual(['a', 'b'])
  })

  it('never lets a stalled transition hold the change', async () => {
    install()
    const { withAppearanceTransition } = await import('./runtime')
    const order: string[] = []
    withAppearanceTransition('material', () => order.push('frosted'))
    await vi.advanceTimersByTimeAsync(1300)
    expect(order).toEqual(['frosted'])
    expect(skipped).toBe(1)
    expect(attrs.has('data-lc-vt')).toBe(false)
    // the browser calling the update late is harmless (nothing runs twice)
    pending?.()
    expect(order).toEqual(['frosted'])
  })

  it('without view transitions, changes are simply immediate', async () => {
    install(false)
    const { withAppearanceTransition } = await import('./runtime')
    const order: string[] = []
    withAppearanceTransition('theme', () => order.push('x'))
    expect(order).toEqual(['x'])
  })
})
