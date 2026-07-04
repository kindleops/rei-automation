import { describe, expect, it } from 'vitest'
import { pickSellerContactPhone } from '../../src/lib/data/commandMapData'

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
})