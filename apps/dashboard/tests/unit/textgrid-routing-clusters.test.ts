import { describe, expect, it } from 'vitest'
import { resolveOutboundTextgridNumber } from '../../src/lib/data/textgridRouting'

const hasSupabase = Boolean(process.env.VITE_SUPABASE_URL && process.env.VITE_SUPABASE_ANON_KEY)

describe.skipIf(!hasSupabase)('textgrid routing clusters', () => {
  it('routes Tennessee sellers through the southeast cluster', async () => {
    const result = await resolveOutboundTextgridNumber({
      market: 'memphis, tn',
      property_address_state: 'TN',
      allow_cluster_routing: true,
    } as never)

    expect(result.ok).toBe(true)
    expect(result.from_phone_number).toMatch(/^\+1\d{10}$/)
    expect(result.routing_tier).toBe(3)
    expect(result.routing_cluster).toBe('SOUTHEAST_EAST')
  })
})