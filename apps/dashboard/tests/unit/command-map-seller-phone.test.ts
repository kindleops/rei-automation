import { describe, expect, it } from 'vitest'
import { resolveCommandMapSellerPhone } from '../../src/lib/data/commandMapData'

const hasSupabase = Boolean(process.env.VITE_SUPABASE_URL && process.env.VITE_SUPABASE_ANON_KEY)

describe.skipIf(!hasSupabase)('resolveCommandMapSellerPhone', () => {
  it('resolves prospect_best_phone for a known uncontacted property', async () => {
    const result = await resolveCommandMapSellerPhone('2100277008', {
      masterOwnerId: 'mo_e4f708b6e6729776484b265f',
      prospectId: 'pros0_43018c9a1e0372e67c70b44c',
    })

    expect(result.phone).toBe('+12522921121')
    expect(result.prospectId).toBe('pros0_43018c9a1e0372e67c70b44c')
  })

  it('falls back to master_owners.best_phone_1 when work item shows No Phone', async () => {
    const result = await resolveCommandMapSellerPhone('213394469', {
      masterOwnerId: 'mo_c39918deab8b4155d76ef6ad',
    })

    expect(result.phone).toBe('+13235287969')
  })
})