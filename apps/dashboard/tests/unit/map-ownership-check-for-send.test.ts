import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveMapOwnershipCheckForSend } from '../../src/domain/map/resolve-map-ownership-check-for-send'
import { getSupabaseClient } from '../../src/lib/supabaseClient'

vi.mock('../../src/lib/supabaseClient', () => ({
  getSupabaseClient: vi.fn(),
}))

vi.mock('../../src/lib/data/commandMapData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/data/commandMapData')>()
  return {
    ...actual,
    resolveCommandMapSellerPhone: vi.fn(),
    resolveMasterOwnerIdForProperty: vi.fn(),
  }
})

const makeSupabase = (tables: Record<string, { data: unknown; error: unknown }>) => {
  const from = (table: string) => ({
    select: () => ({
      eq: () => ({
        limit: () => ({
          maybeSingle: async () => tables[table] ?? { data: null, error: null },
        }),
      }),
    }),
  })
  return { from }
}

const viewModel = {
  propertyId: '273415177',
  masterOwner: { id: 'mo_af316f4b4538de047a59dadd', displayName: 'Owner LLC' },
  property: { address: '2919 Logan Ave N, Minneapolis, MN 55411' },
} as never

describe('resolveMapOwnershipCheckForSend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves best_phone_1 from master_owners and prospect name from work items', async () => {
    vi.mocked(getSupabaseClient).mockReturnValue(makeSupabase({
      v_seller_work_items: {
        data: {
          master_owner_id: 'mo_af316f4b4538de047a59dadd',
          prospect_id: 'pros0_98d57a9fc2d64c7b68872409',
          prospect_full_name: 'Pathao Vang',
          prospect_best_phone: null,
          display_phone: 'No Phone',
        },
        error: null,
      },
      master_owners: {
        data: {
          best_phone_1: '+16122051794',
          primary_phone_id: 'ph_1b196162bad274d060872ead',
          agent_persona: 'Jake Peterson',
          agent_family: null,
          display_name: 'Owner LLC',
          best_language: 'English',
        },
        error: null,
      },
    }) as never)

    const result = await resolveMapOwnershipCheckForSend('273415177', viewModel, {
      property_id: '273415177',
      master_owner_id: 'mo_af316f4b4538de047a59dadd',
      prospect_id: 'pros0_98d57a9fc2d64c7b68872409',
      property_address: '2919 Logan Ave N',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.recipientPhone).toBe('+16122051794')
    expect(result.identity.prospectFirstName).toBe('Pathao')
    expect(result.identity.agentFirstName).toBe('Jake')
    expect(result.identity.ownerLanguage).toBe('English')
    expect(result.identity.propertyAddress).toBe('2919 Logan Ave N')
  })

  it('falls back to work-item prospect_best_phone when master owner best_phone_1 is missing', async () => {
    vi.mocked(getSupabaseClient).mockReturnValue(makeSupabase({
      v_seller_work_items: {
        data: {
          master_owner_id: 'mo_test',
          prospect_id: 'pros_test',
          prospect_full_name: 'Maria Lopez',
          prospect_best_phone: '+13234221650',
          display_phone: '+13234221650',
        },
        error: null,
      },
      master_owners: {
        data: {
          best_phone_1: null,
          primary_phone_id: 'ph_test',
          agent_persona: 'Andre Thompson',
          agent_family: null,
          display_name: 'Test Owner',
          best_language: 'Spanish',
        },
        error: null,
      },
    }) as never)

    const result = await resolveMapOwnershipCheckForSend('238398407', {
      ...viewModel,
      propertyId: '238398407',
    } as never, {
      property_id: '238398407',
      master_owner_id: 'mo_test',
      prospect_id: 'pros_test',
      property_address: '120 Main St',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.recipientPhone).toBe('+13234221650')
    expect(result.identity.prospectFirstName).toBe('Maria')
    expect(result.identity.agentFirstName).toBe('Andre')
  })
})