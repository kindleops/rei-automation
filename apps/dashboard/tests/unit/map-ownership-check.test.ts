import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildOwnershipCheckTemplateContext,
  resolveMapOwnershipCheckIdentity,
} from '../../src/domain/map/resolve-map-ownership-check'
import {
  buildMapOwnershipCheckQueuePayload,
  sendMapOwnershipCheck,
} from '../../src/domain/map/send-map-ownership-check'
import type { SmsTemplate } from '../../src/lib/data/templateData'
import {
  buildOwnershipTemplatePool,
  evaluateOwnershipTemplate,
  pickRandomOwnershipCheckTemplate,
} from '../../src/views/map/seller-card/ownership-check-template-picker'

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
  },
  master_owners: {
    master_owner_id: 'mo-david',
    best_phone_1: '+16125550101',
    primary_phone_id: 'ph-david',
    display_name: 'David Gilkey & Holly Williams',
    best_language: 'English',
    agent_persona: 'Michael Porter',
    agent_family: null,
    sms_agent_id: 'agent-michael',
    selected_agent_id: 'agent-michael',
  },
  phones: {
    phone_id: 'ph-david',
    master_owner_id: 'mo-david',
    canonical_e164: '+16125550101',
    canonical_prospect_id: 'pros-david',
    primary_prospect_id: null,
    linked_prospect_ids_json: ['pros-david'],
    sms_eligible: true,
  },
  prospects: {
    prospect_id: 'pros-david',
    first_name: 'David',
    full_name: 'David Gilkey',
    sms_eligible: true,
    master_owner_id: 'mo-david',
  },
}

const anthonyFixture = {
  properties: {
    property_id: 'prop-anthony',
    master_owner_id: 'mo-anthony',
    property_address_full: '3752 16th Ave S, Minneapolis, MN 55407',
  },
  master_owners: {
    master_owner_id: 'mo-anthony',
    best_phone_1: '+16125550202',
    primary_phone_id: 'ph-anthony',
    display_name: 'Anthony Polk & Wesley Arije',
    best_language: 'English',
    agent_persona: 'Helen Marie Carter',
    agent_family: null,
    sms_agent_id: 'agent-helen',
    selected_agent_id: 'agent-helen',
  },
  phones: {
    phone_id: 'ph-anthony',
    master_owner_id: 'mo-anthony',
    canonical_e164: '+16125550202',
    canonical_prospect_id: null,
    primary_prospect_id: 'pros-anthony',
    linked_prospect_ids_json: ['pros-anthony'],
    sms_eligible: true,
  },
  prospects: {
    prospect_id: 'pros-anthony',
    first_name: 'Anthony',
    full_name: 'Anthony Polk',
    sms_eligible: true,
    master_owner_id: 'mo-anthony',
  },
}

const llcFixture = {
  properties: {
    property_id: 'prop-llc',
    master_owner_id: 'mo-llc',
    property_address_full: '1200 Standish Ave, Memphis, TN 38108',
  },
  master_owners: {
    master_owner_id: 'mo-llc',
    best_phone_1: '+19015550303',
    primary_phone_id: 'ph-llc',
    display_name: 'Standish Garden Apts LLC',
    best_language: 'English',
    agent_persona: 'Carlos Mendez',
    agent_family: null,
    sms_agent_id: 'agent-carlos',
    selected_agent_id: 'agent-carlos',
  },
  phones: {
    phone_id: 'ph-llc',
    master_owner_id: 'mo-llc',
    canonical_e164: '+19015550303',
    canonical_prospect_id: 'pros-llc',
    primary_prospect_id: null,
    linked_prospect_ids_json: ['pros-llc'],
    sms_eligible: true,
  },
  prospects: {
    prospect_id: 'pros-llc',
    first_name: 'Maria',
    full_name: 'Maria Lopez',
    sms_eligible: true,
    master_owner_id: 'mo-llc',
  },
}

const makeTemplate = (
  id: string,
  text: string,
  overrides: Partial<SmsTemplate> = {},
): SmsTemplate => ({
  id,
  templateId: id,
  active: true,
  useCase: 'Ownership Check',
  useCaseSlug: 'ownership_check',
  stageCode: null,
  stageLabel: null,
  language: 'English',
  agentStyle: null,
  propertyTypeScope: null,
  dealStrategy: null,
  isFirstTouch: true,
  isFollowUp: false,
  templateText: text,
  englishTranslation: null,
  variables: [],
  raw: { template_key: id },
  ...overrides,
})

const identityFixture = {
  propertyId: 'prop-david',
  masterOwnerId: 'mo-david',
  phoneId: 'ph-david',
  recipientPhone: '+16125550101',
  prospectId: 'pros-david',
  prospectFirstName: 'David',
  prospectFullName: 'David Gilkey',
  smsEligible: true,
  agentName: 'Michael Porter',
  agentFirstName: 'Michael',
  ownerDisplayName: 'David Gilkey & Holly Williams',
  ownerLanguage: 'English',
  propertyAddress: '3945 25th Ave S, Minneapolis, MN 55406',
  sellerDisplayName: 'David Gilkey',
  smsAgentId: null,
  selectedAgentId: null,
  resolutionSource: 'properties_master_owner_id' as const,
  resolutionDiagnostics: { candidateCount: 1, source: 'properties_master_owner_id' as const },
}

describe('map ownership check canonical resolver', () => {
  it('1. resolves when properties.master_owner_id is present', async () => {
    const result = await resolveMapOwnershipCheckIdentity('prop-david', {
      supabase: makeSupabase(davidFixture),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.resolutionSource).toBe('properties_master_owner_id')
    expect(result.identity.recipientPhone).toBe('+16125550101')
    expect(result.identity.phoneId).toBe('ph-david')
  })

  it('2. resolves null direct owner via validated hydrated masterOwnerId', async () => {
    const fixture = {
      ...davidFixture,
      properties: {
        property_id: 'prop-hydrated',
        master_owner_id: null,
        property_address_full: '100 Hydrated Ave',
      },
      map_filter_property_prospect_links: {
        property_id: 'prop-hydrated',
        master_owner_id: 'mo-david',
        prospect_id: 'pros-david',
      },
    }
    const result = await resolveMapOwnershipCheckIdentity('prop-hydrated', {
      supabase: makeSupabase(fixture),
      hints: { masterOwnerId: 'mo-david', prospectId: 'pros-david' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.resolutionSource).toBe('hydrated_map_identity')
    expect(result.identity.masterOwnerId).toBe('mo-david')
  })

  it('3. resolves null direct owner via property_participant_graph', async () => {
    const fixture = {
      ...davidFixture,
      properties: {
        property_id: 'prop-graph',
        master_owner_id: null,
        property_address_full: '200 Graph Ave',
      },
      property_participant_graph: [
        {
          property_id: 'prop-graph',
          master_owner_id: 'mo-david',
          prospect_id: 'pros-david',
          phone_id: 'ph-david',
          canonical_e164: '+16125550101',
          ownership_confidence: 0.95,
          is_primary_owner_record: true,
          is_current_participant: true,
          safe_to_contact: true,
          suppression_status: 'active',
        },
      ],
    }
    const result = await resolveMapOwnershipCheckIdentity('prop-graph', {
      supabase: makeSupabase(fixture),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.resolutionSource).toBe('property_participant_graph')
  })

  it('4. resolves null direct owner via map_filter_property_prospect_links', async () => {
    const fixture = {
      ...davidFixture,
      properties: {
        property_id: 'prop-link',
        master_owner_id: null,
        property_address_full: '300 Link Ave',
      },
      map_filter_property_prospect_links: {
        property_id: 'prop-link',
        master_owner_id: 'mo-david',
        prospect_id: 'pros-david',
      },
    }
    const result = await resolveMapOwnershipCheckIdentity('prop-link', {
      supabase: makeSupabase(fixture),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.resolutionSource).toBe('map_filter_property_prospect_links')
  })

  it('5. resolves exact phone to human prospect linkage', async () => {
    const result = await resolveMapOwnershipCheckIdentity('prop-anthony', {
      supabase: makeSupabase(anthonyFixture),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.prospectId).toBe('pros-anthony')
    expect(result.identity.prospectFirstName).toBe('Anthony')
    expect(result.identity.phoneId).toBe('ph-anthony')
  })

  it('6. prefers primary/current/safe graph row among multiples', async () => {
    const fixture = {
      ...davidFixture,
      properties: {
        property_id: 'prop-multi-graph',
        master_owner_id: null,
        property_address_full: '400 Multi Graph Ave',
      },
      property_participant_graph: [
        {
          property_id: 'prop-multi-graph',
          master_owner_id: 'mo-other',
          prospect_id: 'pros-other',
          phone_id: 'ph-other',
          canonical_e164: '+16125550999',
          ownership_confidence: 0.4,
          is_primary_owner_record: false,
          is_current_participant: false,
          safe_to_contact: true,
          suppression_status: 'active',
        },
        {
          property_id: 'prop-multi-graph',
          master_owner_id: 'mo-david',
          prospect_id: 'pros-david',
          phone_id: 'ph-david',
          canonical_e164: '+16125550101',
          ownership_confidence: 0.95,
          is_primary_owner_record: true,
          is_current_participant: true,
          safe_to_contact: true,
          suppression_status: 'active',
        },
      ],
      master_owners: [davidFixture.master_owners, {
        master_owner_id: 'mo-other',
        best_phone_1: '+16125550999',
        primary_phone_id: 'ph-other',
        display_name: 'Other Owner',
        best_language: 'English',
        agent_persona: 'Michael Porter',
        agent_family: null,
      }],
      phones: [davidFixture.phones, {
        phone_id: 'ph-other',
        master_owner_id: 'mo-other',
        canonical_e164: '+16125550999',
        canonical_prospect_id: 'pros-other',
        primary_prospect_id: null,
        linked_prospect_ids_json: ['pros-other'],
      }],
      prospects: [davidFixture.prospects, {
        prospect_id: 'pros-other',
        first_name: 'Other',
        full_name: 'Other Person',
        sms_eligible: true,
        master_owner_id: 'mo-other',
      }],
    }
    const result = await resolveMapOwnershipCheckIdentity('prop-multi-graph', {
      supabase: makeSupabase(fixture),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.masterOwnerId).toBe('mo-david')
    expect(result.identity.prospectFirstName).toBe('David')
  })

  it('7. fails closed when equally authoritative owners remain', async () => {
    const fixture = {
      ...davidFixture,
      properties: {
        property_id: 'prop-ambiguous',
        master_owner_id: null,
        property_address_full: '500 Ambiguous Ave',
      },
      map_filter_property_prospect_links: [
        {
          property_id: 'prop-ambiguous',
          master_owner_id: 'mo-david',
          prospect_id: 'pros-david',
        },
        {
          property_id: 'prop-ambiguous',
          master_owner_id: 'mo-anthony',
          prospect_id: 'pros-anthony',
        },
      ],
      master_owners: [davidFixture.master_owners, anthonyFixture.master_owners],
      phones: [davidFixture.phones, anthonyFixture.phones],
      prospects: [davidFixture.prospects, anthonyFixture.prospects],
    }
    const result = await resolveMapOwnershipCheckIdentity('prop-ambiguous', {
      supabase: makeSupabase(fixture),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('property_owner_link_ambiguous')
  })

  it('8. rejects owner candidate linked to another property', async () => {
    const fixture = {
      ...davidFixture,
      properties: {
        property_id: 'prop-reject',
        master_owner_id: null,
        property_address_full: '600 Reject Ave',
      },
      map_filter_property_prospect_links: {
        property_id: 'prop-other-property',
        master_owner_id: 'mo-david',
        prospect_id: 'pros-david',
      },
    }
    const result = await resolveMapOwnershipCheckIdentity('prop-reject', {
      supabase: makeSupabase(fixture),
      hints: { masterOwnerId: 'mo-david' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('property_owner_link_missing')
  })

  it('9. rejects suppressed or unsafe participant graph rows', async () => {
    const fixture = {
      ...davidFixture,
      properties: {
        property_id: 'prop-suppressed',
        master_owner_id: null,
        property_address_full: '700 Suppressed Ave',
      },
      property_participant_graph: [
        {
          property_id: 'prop-suppressed',
          master_owner_id: 'mo-david',
          prospect_id: 'pros-david',
          phone_id: 'ph-david',
          canonical_e164: '+16125550101',
          ownership_confidence: 0.95,
          is_primary_owner_record: true,
          is_current_participant: true,
          safe_to_contact: false,
          suppression_status: 'suppressed',
        },
      ],
    }
    const result = await resolveMapOwnershipCheckIdentity('prop-suppressed', {
      supabase: makeSupabase(fixture),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('property_owner_link_missing')
  })

  it('10. returns property_owner_link_missing when no linkage exists', async () => {
    const fixture = {
      properties: {
        property_id: 'prop-missing',
        master_owner_id: null,
        property_address_full: '800 Missing Ave',
      },
    }
    const result = await resolveMapOwnershipCheckIdentity('prop-missing', {
      supabase: makeSupabase(fixture),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('property_owner_link_missing')
    expect(result.error).not.toBe('property has no master_owner_id')
  })

  it('11. greets linked human prospect for entity owner', async () => {
    const result = await resolveMapOwnershipCheckIdentity('prop-llc', {
      supabase: makeSupabase(llcFixture),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const context = buildOwnershipCheckTemplateContext(result.identity)
    const evaluated = evaluateOwnershipTemplate(
      makeTemplate('en-llc', 'Hi {{seller_first_name}}, this is {{agent_first_name}} about {{property_address}}.'),
      context,
    )
    expect(evaluated?.rendered).toContain('Hi Maria')
    expect(evaluated?.rendered.split(',')[0]?.toLowerCase()).not.toContain('llc')
  })

  it('12. preserves ph_ phone ID in send_queue.phone_id', async () => {
    const payload = buildMapOwnershipCheckQueuePayload({
      identity: identityFixture,
      selection: {
        template: makeTemplate('tpl-david', 'Hi David'),
        renderedMessage: 'Hi David, this is Michael.',
        templateId: 'tpl-david',
        templateKey: 'tpl-david',
        language: 'English',
        weight: 1,
        selectionReason: 'uniform_random',
        excludedRecentTemplateId: null,
      },
      thread: { threadKey: '+16125550101' } as never,
      fromPhone: '+16125559999',
      textgridNumberId: null,
    })
    expect(payload.phone_id).toBe('ph-david')
  })

  it('13. keeps phone_number_id null for ph_ IDs', async () => {
    const payload = buildMapOwnershipCheckQueuePayload({
      identity: identityFixture,
      selection: {
        template: makeTemplate('tpl-david', 'Hi David'),
        renderedMessage: 'Hi David',
        templateId: 'tpl-david',
        templateKey: 'tpl-david',
        language: 'English',
        weight: 1,
        selectionReason: 'uniform_random',
        excludedRecentTemplateId: null,
      },
      thread: { threadKey: '+16125550101' } as never,
      fromPhone: '+16125559999',
      textgridNumberId: null,
    })
    expect(payload.phone_number_id).toBeUndefined()
    expect((payload.metadata as Record<string, unknown>).canonical_phone_id).toBe('ph-david')
  })

  it('10b. resolves Amanda when best_phone_1 phone row points at entity prospect', async () => {
    const fixture = {
      properties: {
        property_id: '274564949',
        master_owner_id: 'mo_804d2f26377bee1f43019235',
        property_address_full: '983 Edmund Ave, Saint Paul, MN 55104',
      },
      master_owners: {
        master_owner_id: 'mo_804d2f26377bee1f43019235',
        best_phone_1: '+16514428447',
        primary_phone_id: 'ph_amanda',
        display_name: 'mo_804d2f26377bee1f43019235 Trust',
        best_language: 'English',
        agent_persona: 'Andre Thompson',
        agent_family: null,
      },
      map_filter_property_prospect_links: {
        property_id: '274564949',
        master_owner_id: 'mo_804d2f26377bee1f43019235',
        prospect_id: 'pros1_5d2dfe5ae95f982c0941f648',
      },
      phones: {
        phone_id: 'ph_amanda',
        master_owner_id: 'mo_804d2f26377bee1f43019235',
        canonical_e164: '+16514428447',
        canonical_prospect_id: 'pros_trust_entity',
        primary_prospect_id: null,
        linked_prospect_ids_json: ['pros_trust_entity'],
      },
      prospects: [
        {
          prospect_id: 'pros1_5d2dfe5ae95f982c0941f648',
          first_name: 'Amanda',
          full_name: 'Amanda L Tallen',
          sms_eligible: true,
          master_owner_id: 'mo_804d2f26377bee1f43019235',
        },
        {
          prospect_id: 'pros_trust_entity',
          first_name: 'Trust',
          full_name: 'mo_804d2f26377bee1f43019235 Trust',
          sms_eligible: false,
          master_owner_id: 'mo_804d2f26377bee1f43019235',
        },
      ],
    }

    const result = await resolveMapOwnershipCheckIdentity('274564949', {
      supabase: makeSupabase(fixture),
      hints: {
        masterOwnerId: 'mo_804d2f26377bee1f43019235',
        prospectId: 'pros1_5d2dfe5ae95f982c0941f648',
        prospectFirstName: 'Amanda',
        prospectFullName: 'Amanda L Tallen',
        recipientPhone: '+16514428447',
        agentPersona: 'Andre Thompson',
        smsEligible: true,
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.prospectFirstName).toBe('Amanda')
    expect(result.identity.recipientPhone).toBe('+16514428447')
    expect(result.identity.phoneId).toBe('ph_amanda')
    expect(result.identity.resolutionSource).toBe('hydrated_map_identity')
  })

  it('14. does not block send when phone canonical prospect is entity but owner best phone is valid', async () => {
    const broken = {
      ...davidFixture,
      phones: {
        ...davidFixture.phones,
        canonical_prospect_id: 'pros_entity',
        primary_prospect_id: null,
        linked_prospect_ids_json: ['pros_entity'],
      },
      prospects: [
        davidFixture.prospects,
        {
          prospect_id: 'pros_entity',
          first_name: 'LLC',
          full_name: 'David Gilkey LLC',
          sms_eligible: false,
          master_owner_id: 'mo-david',
        },
      ],
    }
    const result = await resolveMapOwnershipCheckIdentity('prop-david', {
      supabase: makeSupabase(broken),
      hints: {
        masterOwnerId: 'mo-david',
        prospectId: 'pros-david',
        prospectFirstName: 'David',
        recipientPhone: '+16125550101',
        agentPersona: 'Michael Porter',
        smsEligible: true,
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.prospectFirstName).toBe('David')
    expect(result.identity.phoneId).toBe('ph-david')

    const sendResult = await sendMapOwnershipCheck({
      identity: identityFixture,
      selection: {
        template: makeTemplate('tpl-david', 'Hi David'),
        renderedMessage: 'Hi David',
        templateId: 'tpl-david',
        templateKey: 'tpl-david',
        language: 'English',
        weight: 1,
        selectionReason: 'uniform_random',
        excludedRecentTemplateId: null,
      },
      thread: { id: '+16125550101', marketId: 'minneapolis, mn' } as never,
      dryRun: true,
    })
    expect(sendResult.ok).toBe(true)
    expect(sendResult.queueId).toBeNull()
  })

  it('15. resolves phone from graph candidate when master owner best_phone_1 is missing', async () => {
    const fixture = {
      properties: {
        property_id: 'prop-graph-phone',
        master_owner_id: null,
        property_address_full: '100 Graph St, Minneapolis, MN',
      },
      property_participant_graph: {
        property_id: 'prop-graph-phone',
        master_owner_id: 'mo-graph',
        prospect_id: 'pros-graph',
        phone_id: 'ph-graph',
        canonical_e164: '+16125550999',
        ownership_confidence: 0.95,
        contact_rank: 1,
        is_primary_owner_record: true,
        is_current_participant: true,
        safe_to_contact: true,
        suppression_status: null,
      },
      master_owners: {
        master_owner_id: 'mo-graph',
        best_phone_1: null,
        primary_phone_id: 'ph-graph',
        display_name: 'Graph Owner LLC',
        best_language: 'English',
        agent_persona: 'Jake Peterson',
        agent_family: null,
      },
      phones: {
        phone_id: 'ph-graph',
        master_owner_id: 'mo-graph',
        canonical_e164: '+16125550999',
        canonical_prospect_id: 'pros-graph',
        primary_prospect_id: null,
        linked_prospect_ids_json: ['pros-graph'],
      },
      prospects: {
        prospect_id: 'pros-graph',
        first_name: 'Nina',
        full_name: 'Nina Patel',
        sms_eligible: true,
        master_owner_id: 'mo-graph',
      },
    }

    const result = await resolveMapOwnershipCheckIdentity('prop-graph-phone', {
      supabase: makeSupabase(fixture),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.recipientPhone).toBe('+16125550999')
    expect(result.identity.prospectFirstName).toBe('Nina')
    expect(result.identity.phoneId).toBe('ph-graph')
  })

  it('renders David as Hi David', () => {
    const context = buildOwnershipCheckTemplateContext(identityFixture)
    const evaluated = evaluateOwnershipTemplate(
      makeTemplate('en-david', 'Hi {{seller_first_name}}, this is {{agent_first_name}} about {{property_address}}.'),
      context,
    )
    expect(evaluated?.rendered).toContain('Hi David')
    expect(evaluated?.rendered).toContain('Michael')
  })

  it('uses assigned agent names per master owner', async () => {
    const david = await resolveMapOwnershipCheckIdentity('prop-david', { supabase: makeSupabase(davidFixture) })
    const anthony = await resolveMapOwnershipCheckIdentity('prop-anthony', { supabase: makeSupabase(anthonyFixture) })
    expect(david.ok && anthony.ok).toBe(true)
    if (!david.ok || !anthony.ok) return
    expect(david.identity.agentName).toBe('Michael Porter')
    expect(anthony.identity.agentName).toBe('Helen Marie Carter')
    expect(david.identity.agentName).not.toBe(anthony.identity.agentName)
  })

  it('blocks before queue insertion when agent is missing', async () => {
    const broken = {
      ...davidFixture,
      master_owners: {
        ...davidFixture.master_owners,
        agent_persona: '',
        agent_family: '',
      },
    }
    const result = await resolveMapOwnershipCheckIdentity('prop-david', { supabase: makeSupabase(broken) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('assigned_agent_missing')
  })

  it('blocks before queue insertion when template provenance is missing', async () => {
    const identity = (await resolveMapOwnershipCheckIdentity('prop-david', { supabase: makeSupabase(davidFixture) }))
    expect(identity.ok).toBe(true)
    if (!identity.ok) return

    const result = await sendMapOwnershipCheck({
      identity: identity.identity,
      selection: {
        template: makeTemplate('', 'Hi David'),
        renderedMessage: 'Hi David',
        templateId: '',
        templateKey: '',
        language: 'English',
        weight: 1,
        selectionReason: 'uniform_random',
        excludedRecentTemplateId: null,
      },
      thread: { id: '+16125550101', leadId: 'mo-david', marketId: 'minneapolis, mn' } as never,
      dryRun: true,
    })
    expect(result.ok).toBe(false)
    expect(result.errorMessage).toBe('Missing template provenance')
  })

  it('persists seller, agent, and template provenance in queue payload', async () => {
    const identityResult = await resolveMapOwnershipCheckIdentity('prop-david', { supabase: makeSupabase(davidFixture) })
    expect(identityResult.ok).toBe(true)
    if (!identityResult.ok) return

    const payload = buildMapOwnershipCheckQueuePayload({
      identity: identityResult.identity,
      selection: {
        template: makeTemplate('tpl-david', 'Hi David'),
        renderedMessage: 'Hi David, this is Michael. I had a quick question about 3945 25th Ave S, Minneapolis, MN 55406.',
        templateId: 'tpl-david',
        templateKey: 'tpl-david',
        language: 'English',
        weight: 1,
        selectionReason: 'uniform_random',
        excludedRecentTemplateId: null,
      },
      thread: { threadKey: '+16125550101', marketId: 'minneapolis, mn' } as never,
      fromPhone: '+16125559999',
      textgridNumberId: null,
    })

    expect(payload.source).toBe('map_command')
    expect(payload.message_type).toBe('ownership_check')
    expect(payload.phone_id).toBe('ph-david')
    expect(payload.seller_first_name).toBe('David')
    expect(payload.agent_name).toBe('Michael Porter')
  })

  it('uses map_command source attribution, not manual_inbox', async () => {
    const identityResult = await resolveMapOwnershipCheckIdentity('prop-david', { supabase: makeSupabase(davidFixture) })
    expect(identityResult.ok).toBe(true)
    if (!identityResult.ok) return

    const payload = buildMapOwnershipCheckQueuePayload({
      identity: identityResult.identity,
      selection: {
        template: makeTemplate('tpl-1', 'Hi David'),
        renderedMessage: 'Hi David',
        templateId: 'tpl-1',
        templateKey: 'tpl-1',
        language: 'English',
        weight: 1,
        selectionReason: 'uniform_random',
        excludedRecentTemplateId: null,
      },
      thread: { threadKey: '+16125550101' } as never,
      fromPhone: '+16125559999',
      textgridNumberId: null,
    })
    expect(payload.source).toBe('map_command')
    expect(payload.message_type).toBe('ownership_check')
    expect(payload.source).not.toBe('manual_inbox')
  })
})