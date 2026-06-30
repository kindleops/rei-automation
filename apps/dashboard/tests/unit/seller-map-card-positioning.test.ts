import { describe, expect, it, vi } from 'vitest'
import {
  getSellerCardDimensions,
  getSellerMapCardLayoutMode,
} from '../../src/views/map/seller-card/seller-map-card-positioning'

describe('seller map card positioning', () => {
  it('maps conversation layout to focus footprint', () => {
    expect(getSellerMapCardLayoutMode('conversation')).toBe('focus')
    expect(getSellerMapCardLayoutMode('peek')).toBe('peek')
    expect(getSellerMapCardLayoutMode('focus')).toBe('focus')
  })

  it('uses identical desktop dimensions for focus and conversation', () => {
    vi.stubGlobal('window', { innerHeight: 900 })
    const focus = getSellerCardDimensions('focus', false)
    const conversation = getSellerCardDimensions('conversation', false)
    expect(conversation.width).toBe(focus.width)
    expect(conversation.maxHeight).toBe(focus.maxHeight)
    expect(conversation.imageHeight).toBe(focus.imageHeight)
  })
})