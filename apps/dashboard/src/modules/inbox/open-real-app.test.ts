import { describe, expect, it, vi } from 'vitest'
import { dealIntelligencePath, openRealDealIntelligence } from './open-real-app'

describe('the real Deal Intelligence from desktop Inbox hosts', () => {
  const deps = (r: 'opened' | 'focused' | 'refused', running = true) => ({
    running: () => running, openBeside: vi.fn(() => r), navigate: vi.fn(), publish: vi.fn(), announce: vi.fn(),
  })
  it('property first, thread second, nothing → unavailable', () => {
    expect(dealIntelligencePath({ propertyId: 'p 1', threadKey: '+1' })).toBe('/deal-intelligence?property_id=p%201')
    expect(dealIntelligencePath({ propertyId: null, threadKey: '+16125550101' })).toBe('/deal-intelligence?thread_key=%2B16125550101')
    expect(openRealDealIntelligence({ propertyId: null, threadKey: null }, deps('opened'))).toBe('unavailable')
  })
  it('opens beside and publishes the linked subject; never swaps the host view', () => {
    const d = deps('opened')
    expect(openRealDealIntelligence({ propertyId: 'p1', threadKey: null }, d)).toBe('beside')
    expect(d.publish).toHaveBeenCalledOnce()
    expect(d.navigate).not.toHaveBeenCalled()
  })
  it('no room → a real navigation (history entry, Back works) and says so', () => {
    const d = deps('refused')
    expect(openRealDealIntelligence({ propertyId: 'p1', threadKey: null }, d)).toBe('navigated')
    expect(d.navigate).toHaveBeenCalledWith('/deal-intelligence?property_id=p1')
    expect(d.announce).toHaveBeenCalled()
    const off = deps('opened', false)
    expect(openRealDealIntelligence({ propertyId: 'p1', threadKey: null }, off)).toBe('navigated')
  })
})
