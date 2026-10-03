import { describe, expect, it, vi, beforeEach } from 'vitest'

/*
 * The direct enrichment reads must filter on columns that exist in prod.
 * Prod catalog (2026-10-03): master_owners is keyed by master_owner_id and prospects by
 * prospect_id. Neither has an `id` column. phones and emails have no property_id; they
 * link to the owner through master_owner_id. PostgREST answers an unknown column with
 * 42703, and these call sites swallowed that error, so the enrichment came back
 * silently empty.
 */

type Call = { table: string; select?: string; filters: Array<[string, unknown]> }
const calls: Call[] = []
const rowsByTable: Record<string, unknown[]> = {}

const makeBuilder = (table: string) => {
  const call: Call = { table, filters: [] }
  calls.push(call)
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  Object.assign(builder, {
    select: (cols: string) => { call.select = cols; return builder },
    in: (col: string, ids: unknown) => { call.filters.push([col, ids]); return builder },
    eq: (col: string, v: unknown) => { call.filters.push([col, v]); return builder },
    order: chain,
    limit: chain,
    then: (resolve: (v: unknown) => unknown) => resolve({ data: rowsByTable[table] ?? [], error: null }),
  })
  return builder
}

vi.mock('../supabaseClient', () => ({
  getSupabaseClient: () => ({ from: (table: string) => makeBuilder(table) }),
  hasSupabaseEnv: true,
}))

vi.mock('./shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, shouldUseSupabase: () => true }
})

import { hydrateEnrichments, type BaseThread } from './inboxBase'
import { fetchRelatedRowsForProperties } from './propertyData'

beforeEach(() => {
  calls.length = 0
  for (const k of Object.keys(rowsByTable)) delete rowsByTable[k]
})

describe('inbox enrichment uses the real keys', () => {
  it('reads master_owners by master_owner_id and prospects by prospect_id, and maps the rows back', async () => {
    rowsByTable.master_owners = [{ master_owner_id: 'mo_1', display_name: 'Jane Owner' }]
    rowsByTable.prospects = [{ prospect_id: 'pr_1', full_name: 'Jane Q Seller', first_name: 'Jane' }]
    rowsByTable.properties = [{ property_id: 'p_1', property_address: '1 Main St', property_address_full: '1 Main St, Dallas, TX', market: 'Dallas, TX', property_type: 'SFR' }]

    const thread = { thread_key: 't1', master_owner_id: 'mo_1', property_id: 'p_1', prospect_id: 'pr_1', queue_id: null } as unknown as BaseThread
    const out = await hydrateEnrichments([thread])

    const owners = calls.find((c) => c.table === 'master_owners')!
    expect(owners.select).not.toMatch(/(^|[ ,])id([ ,]|$)/)
    expect(owners.select).not.toContain('final_acquisition_score')
    expect(owners.filters).toEqual([['master_owner_id', ['mo_1']]])

    const prospects = calls.find((c) => c.table === 'prospects')!
    expect(prospects.select).toContain('prospect_id')
    expect(prospects.filters).toEqual([['prospect_id', ['pr_1']]])

    const e = out.get('t1')!
    expect(e.ownerName).toBe('Jane Owner')
    expect(e.sellerName).toBe('Jane Q Seller')
    expect(e.propertyAddress).toBe('1 Main St')
    expect(e.acquisitionScore).toBeUndefined()
  })
})

describe('property dossier contact rows use the owner link', () => {
  it('fetches phones and emails by master_owner_id, never by property_id', async () => {
    rowsByTable.phones = [{ phone_id: 'ph_1', master_owner_id: 'mo_9', canonical_e164: '+12145550100' }]
    rowsByTable.emails = [{ email_id: 'em_1', master_owner_id: 'mo_9' }]

    const related = await fetchRelatedRowsForProperties([
      { id: 'p_9', propertyId: 'p_9', masterOwnerId: 'mo_9', ownerId: null } as never,
    ])

    for (const table of ['phones', 'emails']) {
      const c = calls.find((x) => x.table === table)!
      expect(c.filters).toEqual([['master_owner_id', ['mo_9']]])
      expect(c.filters.some(([col]) => col === 'property_id')).toBe(false)
    }
    expect(related.phones).toHaveLength(1)
    expect(related.emails).toHaveLength(1)
  })
})
