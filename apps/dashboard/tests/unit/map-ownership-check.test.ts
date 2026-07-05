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

const makeSupabase = (tables: Record<string, TableRow | TableRow[] | null>) => {
  const from = (table: string) => {
    let filters: Array<{ column: string; value: unknown }> = []
    const api = {
      select: () => api,
      eq: (column: string, value: unknown) => {
        filters.push({ column, value })
        return api
      },
      order: () => api,
      limit: () => api,
      maybeSingle: async () => {
        const rows = tables[table]
        if (!rows) return { data: null, error: null }
        const list = Array.isArray(rows) ? rows : [rows]
        const match = list.find((row) =>
          filters.every((filter) => row[filter.column] === filter.value),
        )
        return { data: match ?? null, error: null }
      },
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

describe('map ownership check canonical resolver', () => {
  it('resolves master owner best_phone_1 to the matching phones row', async () => {
    const result = await resolveMapOwnershipCheckIdentity('prop-david', {
      supabase: makeSupabase(davidFixture),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.recipientPhone).toBe('+16125550101')
    expect(result.identity.phoneId).toBe('ph-david')
  })

  it('resolves the phones row to the correct prospect', async () => {
    const result = await resolveMapOwnershipCheckIdentity('prop-anthony', {
      supabase: makeSupabase(anthonyFixture),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.prospectId).toBe('pros-anthony')
    expect(result.identity.prospectFirstName).toBe('Anthony')
  })

  it('renders David as Hi David', () => {
    const context = buildOwnershipCheckTemplateContext({
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
      smsAgentId: 'agent-michael',
      selectedAgentId: 'agent-michael',
    })
    const evaluated = evaluateOwnershipTemplate(
      makeTemplate('en-david', 'Hi {{seller_first_name}}, this is {{agent_first_name}}. I had a quick question about {{property_address}}.'),
      context,
    )
    expect(evaluated?.rendered).toContain('Hi David')
    expect(evaluated?.rendered).toContain('Michael')
  })

  it('renders Anthony as Hi Anthony', () => {
    const context = buildOwnershipCheckTemplateContext({
      propertyId: 'prop-anthony',
      masterOwnerId: 'mo-anthony',
      phoneId: 'ph-anthony',
      recipientPhone: '+16125550202',
      prospectId: 'pros-anthony',
      prospectFirstName: 'Anthony',
      prospectFullName: 'Anthony Polk',
      smsEligible: true,
      agentName: 'Helen Marie Carter',
      agentFirstName: 'Helen',
      ownerDisplayName: 'Anthony Polk & Wesley Arije',
      ownerLanguage: 'English',
      propertyAddress: '3752 16th Ave S, Minneapolis, MN 55407',
      sellerDisplayName: 'Anthony Polk',
      smsAgentId: 'agent-helen',
      selectedAgentId: 'agent-helen',
    })
    const evaluated = evaluateOwnershipTemplate(
      makeTemplate('en-anthony', 'Hey {{seller_first_name}}, this is {{agent_first_name}}. Are you the owner of {{property_address}}?'),
      context,
    )
    expect(evaluated?.rendered).toContain('Hey Anthony')
    expect(evaluated?.rendered).toContain('Helen')
  })

  it('never puts an LLC in the greeting', async () => {
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
    expect(evaluated?.rendered.split(',')[0]?.toLowerCase()).not.toContain('standish garden')
  })

  it('never puts full prospect name in the greeting', () => {
    const context = buildOwnershipCheckTemplateContext({
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
    })
    const evaluated = evaluateOwnershipTemplate(
      makeTemplate('en-full-name-guard', 'Hi {{seller_first_name}}, this is {{agent_first_name}}.'),
      context,
    )
    expect(evaluated?.rendered).toBe('Hi David, this is Michael.')
    expect(evaluated?.rendered).not.toContain('Gilkey')
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

  it('does not hardcode a global agent', async () => {
    const llc = await resolveMapOwnershipCheckIdentity('prop-llc', { supabase: makeSupabase(llcFixture) })
    expect(llc.ok).toBe(true)
    if (!llc.ok) return
    expect(llc.identity.agentName).toBe('Carlos Mendez')
    expect(llc.identity.agentName).not.toBe('Chris')
  })

  it('varies ownership templates across repeated selections', () => {
    const templates = [
      makeTemplate('tpl-1', 'Hi {{seller_first_name}}, question about {{property_address}}.'),
      makeTemplate('tpl-2', 'Hello {{seller_first_name}}, checking {{property_address}}.'),
      makeTemplate('tpl-3', 'Hey {{seller_first_name}}, owner of {{property_address}}?'),
    ]
    const context = {
      seller_first_name: 'David',
      seller_name: 'David Gilkey',
      owner_name: 'Owner LLC',
      property_address: '3945 25th Ave S',
      agent_name: 'Michael Porter',
      agent_first_name: 'Michael',
    }
    const picks = new Set<string>()
    for (let i = 0; i < 40; i += 1) {
      const picked = pickRandomOwnershipCheckTemplate(templates, context, 'English')
      if (picked?.templateId) picks.add(picked.templateId)
    }
    expect(picks.size).toBeGreaterThan(1)
  })

  it('excludes the most recently used template when alternatives exist', () => {
    const templates = [
      makeTemplate('tpl-a', 'Hi {{seller_first_name}}, A {{property_address}}.'),
      makeTemplate('tpl-b', 'Hi {{seller_first_name}}, B {{property_address}}.'),
      makeTemplate('tpl-c', 'Hi {{seller_first_name}}, C {{property_address}}.'),
    ]
    const context = {
      seller_first_name: 'David',
      seller_name: 'David',
      owner_name: 'Owner',
      property_address: '123 Main',
      agent_name: 'Michael',
      agent_first_name: 'Michael',
    }
    const pool = buildOwnershipTemplatePool(templates, context, 'English', { excludeTemplateId: 'tpl-b' })
    expect(pool.map((entry) => entry.template.id)).not.toContain('tpl-b')
    expect(pool.length).toBe(2)
  })

  it('blocks before queue insertion when prospect is missing', async () => {
    const broken = {
      ...davidFixture,
      phones: {
        ...davidFixture.phones,
        canonical_prospect_id: null,
        primary_prospect_id: null,
        linked_prospect_ids_json: [],
      },
    }
    const result = await resolveMapOwnershipCheckIdentity('prop-david', { supabase: makeSupabase(broken) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('No human prospect linked to this phone')
  })

  it('blocks before queue insertion when prospect first name is missing', async () => {
    const broken = {
      ...davidFixture,
      prospects: {
        ...davidFixture.prospects,
        first_name: '',
      },
    }
    const result = await resolveMapOwnershipCheckIdentity('prop-david', { supabase: makeSupabase(broken) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('prospect first_name is required')
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
    expect(result.error).toBe('No SMS agent assigned to this property')
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

  it('rejects Hi there ownership check rendering', () => {
    const context = {
      seller_first_name: '',
      seller_name: '',
      owner_name: 'LLC',
      property_address: '123 Main',
      agent_name: 'Michael',
      agent_first_name: 'Michael',
    }
    const evaluated = evaluateOwnershipTemplate(
      makeTemplate('hi-there', 'Hi there, this is {{agent_first_name}}.'),
      context,
    )
    expect(evaluated).toBeNull()
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
    expect(payload.use_case_template).toBe('ownership_check')
    expect(payload.seller_first_name).toBe('David')
    expect(payload.agent_name).toBe('Michael Porter')
    expect(payload.template_id).toBe('tpl-david')
    expect(payload.selected_template_id).toBe('tpl-david')
    expect(payload.rendered_message).toContain('Hi David')
    expect(payload.queue_key).toMatch(/^map:ownership_check:/)
  })

  it('uses map_command source attribution, not manual_inbox', async () => {
    const payload = buildMapOwnershipCheckQueuePayload({
      identity: (await resolveMapOwnershipCheckIdentity('prop-david', { supabase: makeSupabase(davidFixture) }) as Extract<Awaited<ReturnType<typeof resolveMapOwnershipCheckIdentity>>, { ok: true }>).identity,
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
    expect(payload.message_type).not.toBe('manual_reply')
    expect((payload.metadata as Record<string, unknown>).message_events_source_app).toBe('LeadCommand Map')
  })

  it('does not send real SMS during dry-run tests', async () => {
    const identityResult = await resolveMapOwnershipCheckIdentity('prop-david', { supabase: makeSupabase(davidFixture) })
    expect(identityResult.ok).toBe(true)
    if (!identityResult.ok) return

    const result = await sendMapOwnershipCheck({
      identity: identityResult.identity,
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
      thread: { id: '+16125550101', marketId: 'minneapolis, mn', property_address_state: 'MN' } as never,
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    expect(result.insertPayload).toBeTruthy()
    expect(result.queueId).toBeNull()
    expect(result.messageEventId).toBeNull()
  })
})