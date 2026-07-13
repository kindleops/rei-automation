import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveMapOwnershipCheckForSend } from '../../src/domain/map/resolve-map-ownership-check-for-send'
import { getSupabaseClient } from '../../src/lib/supabaseClient'

vi.mock('../../src/lib/supabaseClient', () => ({
  getSupabaseClient: vi.fn(),
}))

type TableRow = Record<string, unknown>

type QueryResult = { data: TableRow | TableRow[] | null; error: null }

const makeSupabase = (tables: Record<string, TableRow | TableRow[] | null>) => {
  const from = (table: string) => {
    let filters: Array<{ column: string; value: unknown; op: 'eq' | 'not_null' }> = []
    let orderSpecs: Array<{ column: string; ascending: boolean }> = []
    let limitCount: number | null = null

    const execute = (): QueryResult => {
      const rows = tables[table]
      if (!rows) return { data: [], error: null }
      const list = Array.isArray(rows) ? rows : [rows]
      let matches = list.filter((row) =>
        filters.every((filter) => {
          if (filter.op === 'not_null') {
            return row[filter.column] != null && row[filter.column] !== ''
          }
          return row[filter.column] === filter.value
        }),
      )

      for (const spec of orderSpecs) {
        matches = [...matches].sort((left, right) => {
          const leftValue = left[spec.column]
          const rightValue = right[spec.column]
          if (leftValue === rightValue) return 0
          if (leftValue == null) return 1
          if (rightValue == null) return -1
          if (leftValue < rightValue) return spec.ascending ? -1 : 1
          return spec.ascending ? 1 : -1
        })
      }

      if (limitCount !== null) {
        matches = matches.slice(0, limitCount)
      }

      return { data: matches, error: null }
    }

    const api = {
      select: () => api,
      eq: (column: string, value: unknown) => {
        filters.push({ column, value, op: 'eq' })
        return api
      },
      not: (column: string, operator: string, value: unknown) => {
        if (operator === 'is' && value === null) {
          filters.push({ column, value: null, op: 'not_null' })
        }
        return api
      },
      order: (column: string, opts?: { ascending?: boolean }) => {
        orderSpecs.push({ column, ascending: opts?.ascending !== false })
        return api
      },
      limit: (count: number) => {
        limitCount = count
        return api
      },
      maybeSingle: async () => {
        const { data, error } = execute()
        const row = Array.isArray(data) ? data[0] ?? null : data
        return { data: row, error }
      },
      then: (
        resolve: (value: QueryResult) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(execute()).then(resolve, reject),
    }

    return api
  }

  return { from } as unknown as SupabaseClient
}

const davidFixture = {
  properties: {
    property_id: 'prop-david',
    master_owner_id: 'mo-david',
    property_address_full: '3945 25th Ave S, Minneapolis, MN 55406',
    property_address: '3945 25th Ave S',
  },
  master_owners: {
    master_owner_id: 'mo-david',
    best_phone_1: '+16125550101',
    primary_phone_id: 'ph-david',
    display_name: 'David Gilkey & Holly Williams',
    best_language: 'English',
    agent_persona: 'Michael Porter',
    agent_family: null,
  },
  phones: {
    phone_id: 'ph-david',
    master_owner_id: 'mo-david',
    canonical_e164: '+16125550101',
    canonical_prospect_id: 'pros-david',
    primary_prospect_id: null,
    linked_prospect_ids_json: ['pros-david'],
  },
  prospects: {
    prospect_id: 'pros-david',
    first_name: 'David',
    full_name: 'David Gilkey',
    sms_eligible: true,
    master_owner_id: 'mo-david',
  },
}

const llcFixture = {
  properties: {
    property_id: 'prop-llc',
    master_owner_id: 'mo-llc',
    property_address_full: '1200 Standish Ave, Memphis, TN 38108',
    property_address: '1200 Standish Ave',
  },
  master_owners: {
    master_owner_id: 'mo-llc',
    best_phone_1: '+19015550303',
    primary_phone_id: 'ph-llc',
    display_name: 'Standish Garden Apts LLC',
    best_language: 'English',
    agent_persona: 'Carlos Mendez',
    agent_family: null,
  },
  phones: {
    phone_id: 'ph-llc',
    master_owner_id: 'mo-llc',
    canonical_e164: '+19015550303',
    canonical_prospect_id: 'pros-llc',
    primary_prospect_id: null,
    linked_prospect_ids_json: ['pros-llc'],
  },
  prospects: {
    prospect_id: 'pros-llc',
    first_name: 'Maria',
    full_name: 'Maria Lopez',
    sms_eligible: true,
    master_owner_id: 'mo-llc',
  },
}

const viewModelFor = (propertyId: string, masterOwnerId: string, displayName: string, address: string) => ({
  propertyId,
  masterOwner: { id: masterOwnerId, displayName },
  property: { address },
} as never)

describe('resolveMapOwnershipCheckForSend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves owner, phone, and human prospect via canonical graph when card record is stripped', async () => {
    vi.mocked(getSupabaseClient).mockReturnValue(makeSupabase({
      ...davidFixture,
      v_seller_work_items: null,
    }))

    const result = await resolveMapOwnershipCheckForSend(
      'prop-david',
      viewModelFor('prop-david', 'mo-david', 'David Gilkey & Holly Williams', '3945 25th Ave S, Minneapolis, MN 55406'),
      {
        property_id: 'prop-david',
        master_owner_id: 'mo-david',
        property_address: '3945 25th Ave S',
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.recipientPhone).toBe('+16125550101')
    expect(result.identity.prospectFirstName).toBe('David')
    expect(result.identity.agentFirstName).toBe('Michael')
    expect(result.identity.propertyAddress).toBe('3945 25th Ave S')
    expect(result.identity.resolutionSource).toBe('hydrated_map_identity')
  })

  it('greets linked human prospect for entity LLC owner', async () => {
    vi.mocked(getSupabaseClient).mockReturnValue(makeSupabase({
      ...llcFixture,
      v_seller_work_items: null,
    }))

    const result = await resolveMapOwnershipCheckForSend(
      'prop-llc',
      viewModelFor('prop-llc', 'mo-llc', 'Standish Garden Apts LLC', '1200 Standish Ave, Memphis, TN 38108'),
      {
        property_id: 'prop-llc',
        master_owner_id: 'mo-llc',
        owner_display_name: 'Standish Garden Apts LLC',
        property_address: '1200 Standish Ave',
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.prospectFirstName).toBe('Maria')
    expect(result.identity.ownerDisplayName).toBe('Standish Garden Apts LLC')
    expect(result.identity.agentFirstName).toBe('Carlos')
  })

  it('enriches stripped records from v_seller_work_items when graph hints are missing', async () => {
    vi.mocked(getSupabaseClient).mockReturnValue(makeSupabase({
      ...davidFixture,
      properties: {
        ...davidFixture.properties,
        master_owner_id: null,
      },
      map_filter_property_prospect_links: {
        property_id: 'prop-david',
        master_owner_id: 'mo-david',
        prospect_id: 'pros-david',
      },
      v_seller_work_items: {
        property_id: 'prop-david',
        master_owner_id: 'mo-david',
        prospect_id: 'pros-david',
        prospect_full_name: 'David Gilkey',
        prospect_best_phone: '+16125550101',
        display_phone: '+16125550101',
      },
    }))

    const result = await resolveMapOwnershipCheckForSend(
      'prop-david',
      viewModelFor('prop-david', null as never, 'David Gilkey', '3945 25th Ave S, Minneapolis, MN 55406'),
      { property_id: 'prop-david', property_address: '3945 25th Ave S' },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.masterOwnerId).toBe('mo-david')
    expect(result.identity.prospectFirstName).toBe('David')
    expect(result.identity.recipientPhone).toBe('+16125550101')
  })
})