import { describe, expect, it } from 'vitest'
import { dismissDistance, dragOpacity, exitOffset, lockAxis, releaseVelocity, settleSwipeDismiss, SWIPE_DISMISS } from './swipe-dismiss'
import { upsertToast } from './toast-stack'
import type { LCToastMessage } from './toast-bus'

const W = 360 // a toast's width

describe('swipe to dismiss — thresholds', () => {
  it('a slow drag dismisses past 40% of the width (never less than 80px), else springs back', () => {
    expect(dismissDistance(W)).toBe(144)
    expect(dismissDistance(120)).toBe(SWIPE_DISMISS.MIN_DISTANCE_PX)
    expect(settleSwipeDismiss({ offset: 143, velocity: 50, width: W })).toBeNull()
    expect(settleSwipeDismiss({ offset: 144, velocity: 50, width: W })).toBe('right')
    expect(settleSwipeDismiss({ offset: -150, velocity: 0, width: W })).toBe('left')
    expect(settleSwipeDismiss({ offset: 79, velocity: 0, width: 120 })).toBeNull()
    expect(settleSwipeDismiss({ offset: 80, velocity: 0, width: 120 })).toBe('right')
  })

  it('a flick dismisses early: fast enough, the same way, and past the jitter floor', () => {
    expect(settleSwipeDismiss({ offset: -30, velocity: -SWIPE_DISMISS.FLICK_VELOCITY, width: W })).toBe('left')
    expect(settleSwipeDismiss({ offset: 30, velocity: 900, width: W })).toBe('right')
    // too slow
    expect(settleSwipeDismiss({ offset: 60, velocity: 599, width: W })).toBeNull()
    // a tap with jitter is not a flick
    expect(settleSwipeDismiss({ offset: 10, velocity: 2000, width: W })).toBeNull()
  })

  it('thrown back toward home springs back however far it travelled', () => {
    expect(settleSwipeDismiss({ offset: 300, velocity: -800, width: W })).toBeNull()
    expect(settleSwipeDismiss({ offset: -300, velocity: 700, width: W })).toBeNull()
    // a slow drift back past the line still dismisses (it is past the line)
    expect(settleSwipeDismiss({ offset: 200, velocity: -100, width: W })).toBe('right')
  })

  it('never dismisses at home or on garbage input', () => {
    expect(settleSwipeDismiss({ offset: 0, velocity: 3000, width: W })).toBeNull()
    expect(settleSwipeDismiss({ offset: Number.NaN, velocity: Number.NaN, width: W })).toBeNull()
  })

  it('exits fully off its own width, in the thrown direction', () => {
    expect(exitOffset('left', W)).toBe(-(W + SWIPE_DISMISS.EXIT_OVERSHOOT_PX))
    expect(exitOffset('right', W)).toBe(W + SWIPE_DISMISS.EXIT_OVERSHOOT_PX)
  })

  it('locks to an axis only after 8px; vertical stays a scroll', () => {
    expect(lockAxis(5, 3)).toBeNull()
    expect(lockAxis(12, 4)).toBe('x')
    expect(lockAxis(4, 12)).toBe('y')
    expect(lockAxis(-20, 19)).toBe('x')
  })

  it('release velocity reads the last 100ms (a pause before letting go is a slow release)', () => {
    expect(releaseVelocity([{ x: 0, t: 0 }, { x: 50, t: 50 }, { x: 100, t: 100 }])).toBeCloseTo(1000)
    // moved fast early, then held still for 200ms: near zero
    expect(releaseVelocity([{ x: 0, t: 0 }, { x: 200, t: 50 }, { x: 200, t: 250 }])).toBe(0)
    expect(releaseVelocity([{ x: 0, t: 0 }])).toBe(0)
  })

  it('fades while dragged, never below 0.35 while held', () => {
    expect(dragOpacity(0, W)).toBe(1)
    expect(dragOpacity(144, W)).toBeCloseTo(0.55)
    expect(dragOpacity(10_000, W)).toBe(0.35)
  })
})

describe('toast stack — one per key, updated in place', () => {
  const t = (id: string, key?: string, title = id): LCToastMessage => ({ id, key, title, severity: 'info', timestamp: new Date(0) })
  it('a keyed toast replaces its slot and keeps the id (timer + exit stay coherent); unkeyed stack on top', () => {
    let stack: LCToastMessage[] = []
    stack = upsertToast(stack, t('a', 'thread:1'), 6).toasts
    stack = upsertToast(stack, t('b'), 6).toasts
    const r = upsertToast(stack, t('c', 'thread:1', 'newer'), 6)
    expect(r.replacedId).toBe('a')
    expect(r.toasts.map((x) => x.id)).toEqual(['b', 'a'])
    expect(r.toasts[1].title).toBe('newer')
    expect(upsertToast(r.toasts, t('d', 'thread:2'), 6).toasts.map((x) => x.id)).toEqual(['d', 'b', 'a'])
  })
  it('caps the stack', () => {
    let stack: LCToastMessage[] = []
    for (let i = 0; i < 9; i++) stack = upsertToast(stack, t(`t${i}`), 6).toasts
    expect(stack).toHaveLength(6)
    expect(stack[0].id).toBe('t8')
  })
})
