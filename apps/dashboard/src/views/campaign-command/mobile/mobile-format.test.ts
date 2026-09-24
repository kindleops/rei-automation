import { describe, expect, it } from 'vitest'
import { formatPhone, sellerLabel } from './mobile-format'

describe('formatPhone', () => {
  it('formats US E.164 and ten-digit numbers', () => {
    expect(formatPhone('+13057429240')).toBe('(305) 742-9240')
    expect(formatPhone('3057429240')).toBe('(305) 742-9240')
  })
  it('leaves other numbers alone and handles empties', () => {
    expect(formatPhone('+447911123456')).toBe('+447911123456')
    expect(formatPhone('')).toBeNull()
    expect(formatPhone(null)).toBeNull()
  })
})

describe('sellerLabel', () => {
  it('prefers the name, then the number', () => {
    expect(sellerLabel('Juvette Trouillot', '+13057429240')).toBe('Juvette Trouillot')
    expect(sellerLabel('  ', '+13057429240')).toBe('(305) 742-9240')
    expect(sellerLabel(null, null)).toBe('Seller')
  })
})
