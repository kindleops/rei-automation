import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveCanonicalThreadStateKey,
  resolveDialablePhoneFromThread,
} from '../../src/domain/inbox/resolveCanonicalThreadStateKey'
import { buildSellerMapCardViewModel } from '../../src/views/map/seller-card/seller-map-card-view-model'
import {
  buildMapTemplateManualValues,
  buildThreadFromViewModel,
  resolveMapAgentFirstName,
  resolveMapThreadPhone,
} from '../../src/views/map/seller-card/useSellerMapCardActions'

// Generic chainable Supabase query-builder mock for the fallback-behavior suite
// below. Each call to `.from(table)` looks up a canned response by table name.
type TableResponse = { data: unknown; error: unknown }

const makeSupabaseMock = (responses: Record<string, TableResponse>) => {
  const missingResponse: TableResponse = { data: null, error: { message: 'no mock configured', code: 'MOCK' } }
  const buildQuery = (table: string) => {
    const response = responses[table] ?? missingResponse
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      abortSignal: () => chain,
      maybeSingle: async () => response,
      single: async () => response,
    }
    return chain
  }
  return { from: (table: string) => buildQuery(table) }
}

vi.mock('../../src/lib/supabaseClient', () => ({
  getSupabaseClient: vi.fn(),
  hasSupabaseEnv: true,
}))

const baseRecord = {
  property_id: 'prop-123',
  master_owner_id: 'owner-456',
  prospect_id: 'prospect-789',
  thread_key: 'property:prop-123',
  property_address_full: '123 Main St, Memphis, TN 38103',
  property_address_state: 'TN',
  market: 'memphis, tn',
  owner_display_name: 'Jane Seller',
  outbound_count: 0,
  sent_count: 0,
}

describe('seller map card thread builder', () => {
  it('resolves phone from prospect and display aliases', () => {
    expect(resolveMapThreadPhone({
      prospect_best_phone: '+19015551234',
    })).toBe('+19015551234')

    expect(resolveMapThreadPhone({
      display_phone: '+19015559876',
    })).toBe('+19015559876')

    expect(resolveMapThreadPhone({
      display_phone: 'No Phone',
    })).toBe('')
  })

  it('maps owner, prospect, state, and synthetic thread key into inbox thread', () => {
    const viewModel = buildSellerMapCardViewModel({
      ...baseRecord,
      prospect_best_phone: '+19015551234',
    })

    const thread = buildThreadFromViewModel(viewModel, {
      ...baseRecord,
      prospect_best_phone: '+19015551234',
    })

    expect(thread.threadKey).toBe('property:prop-123')
    expect(thread.ownerId).toBe('owner-456')
    expect(thread.prospectId).toBe('prospect-789')
    expect(thread.canonicalE164).toBe('+19015551234')
    expect(thread.property_address_state).toBe('TN')
    expect(thread.market).toBe('memphis, tn')
  })

  it('synthesizes property thread key when missing from record', () => {
    const viewModel = buildSellerMapCardViewModel({
      ...baseRecord,
      thread_key: '',
      prospect_best_phone: '+19015551234',
    })

    const thread = buildThreadFromViewModel(viewModel, {
      ...baseRecord,
      thread_key: '',
      prospect_best_phone: '+19015551234',
    })

    expect(thread.threadKey).toBe('property:prop-123')
  })

  it('applies phone and prospect overrides from hydration', () => {
    const viewModel = buildSellerMapCardViewModel(baseRecord)
    const thread = buildThreadFromViewModel(viewModel, baseRecord, {
      phone: '+19015550001',
      prospectId: 'prospect-hydrated',
    })

    expect(thread.canonicalE164).toBe('+19015550001')
    expect(thread.prospectId).toBe('prospect-hydrated')
  })

  it('resolves canonical E.164 send key from synthetic property thread', () => {
    const viewModel = buildSellerMapCardViewModel({
      ...baseRecord,
      prospect_best_phone: '+19015551234',
    })
    const thread = buildThreadFromViewModel(viewModel, {
      ...baseRecord,
      prospect_best_phone: '+19015551234',
    })

    expect(thread.threadKey).toBe('property:prop-123')
    expect(resolveCanonicalThreadStateKey(thread as unknown as Record<string, unknown>)).toBe('+19015551234')
  })

  it('does not treat numeric property ids as dialable phones', () => {
    const syntheticThread = {
      threadKey: 'property:2100277008',
      id: 'property:2100277008',
      phoneNumber: '',
      canonicalE164: '',
    }

    expect(resolveDialablePhoneFromThread(syntheticThread)).toBeNull()
    expect(resolveCanonicalThreadStateKey(syntheticThread)).toBeNull()
  })

  describe('map SMS personalization never uses the Master Owner name as the greeting (launch blocker)', () => {
    it('never populates seller_first_name/seller_name from an LLC master owner name', () => {
      const values = buildMapTemplateManualValues({
        owner_display_name: 'West 7th Apartments LLC',
        master_owner_id: 'owner-456',
      })
      expect(values.seller_first_name).toBe('')
      expect(values.seller_name).toBe('')
      // owner_name is preserved as ownership *context*, never as the greeting name.
      expect(values.owner_name).toBe('West 7th Apartments LLC')
    })

    it('never populates seller_first_name/seller_name from a trust/estate master owner name', () => {
      const values = buildMapTemplateManualValues({ owner_display_name: 'D & D Divide LLC' })
      expect(values.seller_first_name).toBe('')
      expect(values.seller_name).toBe('')
    })

    it('uses the resolved prospect name when one is present, ignoring the owner entity name', () => {
      const values = buildMapTemplateManualValues({
        owner_display_name: '88 Cleveland - M LLC',
        prospect_full_name: 'Maria Lopez',
      })
      expect(values.seller_first_name).toBe('Maria')
      expect(values.seller_name).toBe('Maria')
    })

    it('leaves seller_first_name empty (never entity-derived) when only an individual-named owner exists and no prospect is linked', () => {
      const values = buildMapTemplateManualValues({ owner_display_name: 'Jose A Valdizon' })
      expect(values.seller_first_name).toBe('')
      expect(values.seller_name).toBe('')
    })
  })

  describe('map SMS sender identity never hardcodes "Chris" (launch blocker)', () => {
    it('never returns a hardcoded sender name when no agent signal is present', () => {
      const values = buildMapTemplateManualValues({
        owner_display_name: 'West 7th Apartments LLC',
        prospect_full_name: 'Amanda L Tallen',
      })
      expect(values.agent_first_name).toBe('')
      expect(values.agent_name).toBe('')
      expect(values.agent_first_name).not.toBe('Chris')
    })

    it('resolves the agent first name from agent_persona', () => {
      expect(resolveMapAgentFirstName({ agent_persona: 'Andre Thompson' })).toBe('Andre')
      expect(resolveMapAgentFirstName({ agent_persona: 'Carlos' })).toBe('Carlos')
    })

    it('falls back to agent_family when agent_persona is absent', () => {
      expect(resolveMapAgentFirstName({ agent_family: 'Amina' })).toBe('Amina')
    })

    it('does not reject a legitimately assigned agent named Chris', () => {
      expect(resolveMapAgentFirstName({ agent_persona: 'Chris Porter' })).toBe('Chris')
    })

    it('never resolves an entity-shaped string as the agent name', () => {
      expect(resolveMapAgentFirstName({ agent_persona: 'West 7th Apartments LLC' })).toBe('')
    })

    it('buildMapTemplateManualValues surfaces the resolved agent as both agent_name and agent_first_name', () => {
      const values = buildMapTemplateManualValues({ agent_persona: 'Andre Thompson' })
      expect(values.agent_name).toBe('Andre')
      expect(values.agent_first_name).toBe('Andre')
    })
  })

  describe('production regression fixture: property 274564949 / Amanda L Tallen (map ownership check availability)', () => {
    // Exact live record from the launch-blocker regression report: a property with
    // properties.best_phone = null but a valid, SMS-eligible, property-linked primary
    // prospect (Amanda) — the map card must resolve Amanda, not report the action
    // unavailable, and must never substitute the Master Owner name for her.
    const property274564949 = {
      property_id: '274564949',
      master_owner_id: 'mo_804d2f26377bee1f43019235',
      prospect_id: 'pros1_5d2dfe5ae95f982c0941f648',
      thread_key: 'property:274564949',
      property_address_full: '983 Edmund Ave, Saint Paul, MN 55104',
      property_address_state: 'MN',
      market: 'Minneapolis, MN',
      owner_display_name: 'mo_804d2f26377bee1f43019235 Trust',
      prospect_full_name: 'Amanda L Tallen',
      prospect_first_name: 'Amanda',
      prospect_best_phone: '+16514428447',
      sms_eligible: true,
      agent_persona: 'Andre Thompson',
      outbound_count: 0,
      sent_count: 0,
    }

    it('resolves Amanda (not the Master Owner) as the personalized recipient', () => {
      const values = buildMapTemplateManualValues(property274564949)
      expect(values.seller_first_name).toBe('Amanda')
      expect(values.seller_name).toBe('Amanda')
      expect(values.seller_first_name).not.toContain('Trust')
    })

    it('resolves the assigned agent instead of hardcoding Chris', () => {
      const values = buildMapTemplateManualValues(property274564949)
      expect(values.agent_first_name).toBe('Andre')
      expect(values.agent_first_name).not.toBe('Chris')
    })

    it('resolves Amanda\'s prospect phone via resolveMapThreadPhone even though properties.best_phone is null', () => {
      expect(resolveMapThreadPhone(property274564949)).toBe('+16514428447')
    })

    it('does not personalize by name when sms_eligible is explicitly false, even if a name is present', () => {
      const values = buildMapTemplateManualValues({ ...property274564949, sms_eligible: false })
      expect(values.seller_first_name).toBe('')
      expect(values.seller_name).toBe('')
    })

    it('maps the full record into an inbox thread carrying the resolved prospect and phone', () => {
      const viewModel = buildSellerMapCardViewModel(property274564949)
      const thread = buildThreadFromViewModel(viewModel, property274564949)
      expect(thread.prospectId).toBe('pros1_5d2dfe5ae95f982c0941f648')
      expect(thread.canonicalE164).toBe('+16514428447')
    })
  })

  describe('map card resilience when identity view columns are not yet migrated', () => {
    afterEach(() => {
      vi.resetModules()
      vi.clearAllMocks()
    })

    it('loadCommandMapSellerPinDetail still returns the full card when the identity-fields query errors (missing columns)', async () => {
      const { getSupabaseClient } = await import('../../src/lib/supabaseClient')
      const supabaseMock = makeSupabaseMock({
        // readFeed() — the primary card query — succeeds normally, with none of
        // the new identity columns in its select list (matches current
        // production schema pre-migration).
        v_command_map_seller_pin_feed: {
          data: {
            property_id: '274564949',
            master_owner_id: 'mo_804d2f26377bee1f43019235',
            prospect_id: 'pros1_5d2dfe5ae95f982c0941f648',
            thread_key: 'property:274564949',
            owner_display_name: 'mo_804d2f26377bee1f43019235 Trust',
            property_address_full: '983 Edmund Ave, Saint Paul, MN 55104',
            prospect_best_phone: '+16514428447',
          },
          error: null,
        },
        inbox_thread_state: { data: null, error: null },
        properties: { data: null, error: null },
        master_owners: { data: null, error: null },
        prospects: { data: null, error: null },
      })
      vi.mocked(getSupabaseClient).mockReturnValue(supabaseMock as never)

      const { loadCommandMapSellerPinDetail } = await import('../../src/lib/data/commandMapData')
      const result = await loadCommandMapSellerPinDetail('274564949')

      expect(result).not.toBeNull()
      expect(result?.property_id).toBe('274564949')
      expect(result?.property_address_full).toBe('983 Edmund Ave, Saint Paul, MN 55104')
      expect(result?.prospect_id).toBe('pros1_5d2dfe5ae95f982c0941f648')
    })

    it('resolveCommandMapSellerIdentity resolves prospect + agent identity directly from prospects/master_owners (no dependency on the new view columns)', async () => {
      const { getSupabaseClient } = await import('../../src/lib/supabaseClient')
      const supabaseMock = makeSupabaseMock({
        prospects: {
          data: { first_name: 'Amanda', full_name: 'Amanda L Tallen', sms_eligible: true },
          error: null,
        },
        master_owners: {
          data: { agent_persona: 'Andre Thompson', agent_family: null },
          error: null,
        },
      })
      vi.mocked(getSupabaseClient).mockReturnValue(supabaseMock as never)

      const { resolveCommandMapSellerIdentity } = await import('../../src/lib/data/commandMapData')
      const identity = await resolveCommandMapSellerIdentity({
        prospectId: 'pros1_5d2dfe5ae95f982c0941f648',
        masterOwnerId: 'mo_804d2f26377bee1f43019235',
      })

      expect(identity.prospectFirstName).toBe('Amanda')
      expect(identity.prospectFullName).toBe('Amanda L Tallen')
      expect(identity.smsEligible).toBe(true)
      expect(identity.agentPersona).toBe('Andre Thompson')
    })

    it('resolveCommandMapSellerIdentity degrades to nulls (not a thrown error) when the base-table queries also fail', async () => {
      const { getSupabaseClient } = await import('../../src/lib/supabaseClient')
      const supabaseMock = makeSupabaseMock({
        prospects: { data: null, error: { message: 'boom' } },
        master_owners: { data: null, error: { message: 'boom' } },
      })
      vi.mocked(getSupabaseClient).mockReturnValue(supabaseMock as never)

      const { resolveCommandMapSellerIdentity } = await import('../../src/lib/data/commandMapData')
      const identity = await resolveCommandMapSellerIdentity({
        prospectId: 'pros1_5d2dfe5ae95f982c0941f648',
        masterOwnerId: 'mo_804d2f26377bee1f43019235',
      })

      expect(identity.prospectFirstName).toBeNull()
      expect(identity.agentPersona).toBeNull()
      expect(identity.smsEligible).toBe(false)
    })
  })
})