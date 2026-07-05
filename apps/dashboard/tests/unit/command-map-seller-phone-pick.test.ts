import { describe, expect, it } from 'vitest'
import { normalizeSellerDialablePhone, pickSellerContactPhone } from '../../src/lib/data/commandMapData'

describe('pickSellerContactPhone', () => {
  it('uses authoritative owner best_phone_1 when prospect phone is missing', () => {
    expect(pickSellerContactPhone({
      display_phone: 'No Phone',
      prospect_best_phone: null,
      best_phone_1: '+13235287969',
    })).toBe('+13235287969')
  })

  it('ignores phone_id tokens and empty placeholders', () => {
    expect(pickSellerContactPhone({
      canonical_e164: 'ph_a6525d44b4eff770789ea7ec',
      best_phone_1: '+13235287969',
    })).toBe('+13235287969')
  })

  it('normalizes loose US numbers to +1 E.164', () => {
    expect(normalizeSellerDialablePhone('(612) 555-1234')).toBe('+16125551234')
    expect(normalizeSellerDialablePhone('No Phone')).toBeNull()
    expect(normalizeSellerDialablePhone('ph_amanda')).toBeNull()
  })
})