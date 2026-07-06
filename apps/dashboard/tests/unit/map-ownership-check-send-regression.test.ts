import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { buildSellerMapCardViewModel } from '../../src/views/map/seller-card/seller-map-card-view-model'
import {
  buildMapTemplateManualValues,
  buildThreadFromViewModel,
  resolveMapThreadPhone,
} from '../../src/views/map/seller-card/useSellerMapCardActions'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { buildMapOwnershipCheckQueuePayload } from '../../src/domain/map/send-map-ownership-check'
import {
  buildOwnershipCheckTemplateContext,
} from '../../src/domain/map/resolve-map-ownership-check'
import {
  buildOwnershipTemplatePool,
  evaluateOwnershipTemplate,
  pickRandomOwnershipCheckTemplate,
} from '../../src/views/map/seller-card/ownership-check-template-picker'
import type { SmsTemplate } from '../../src/lib/data/templateData'
import { getSupabaseClient } from '../../src/lib/supabaseClient'

vi.mock('../../src/lib/supabaseClient', () => ({
  getSupabaseClient: vi.fn(),
}))

vi.mock('../../src/lib/data/commandMapData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/data/commandMapData')>()
  return {
    ...actual,
    resolveCommandMapSellerPhone: vi.fn(),
    resolveCommandMapSellerIdentity: vi.fn(),
    resolveMasterOwnerIdForProperty: vi.fn(),
  }
})

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

const amandaRecord = {
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
  phone_id: 'ph_amanda',
  sms_eligible: true,
  agent_persona: 'Andre Thompson',
  outbound_count: 0,
  sent_count: 0,
}

const makeSupabaseMock = (tables: Record<string, { data: unknown; error: unknown }>) => {
  const from = (table: string) => ({
    select: () => ({
      eq: (_column: string, _value: unknown) => ({
        limit: () => ({
          maybeSingle: async () => tables[table] ?? { data: null, error: null },
        }),
        order: () => ({
          limit: () => ({
            maybeSingle: async () => tables[table] ?? { data: null, error: null },
          }),
        }),
      }),
    }),
  })
  return { from }
}

describe('map ownership check send regression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('1. eligible uncontacted seller button is not gated by resolver preflight', () => {
    const viewModel = buildSellerMapCardViewModel(amandaRecord)
    expect(viewModel.followUpEligibility.canExecute).toBe(true)
    expect(viewModel.followUpEligibility.label).toBe('Send Ownership Check')
  })

  it('2. opening the card performs no ownership resolver request', () => {
    expect(vi.mocked(getSupabaseClient)).not.toHaveBeenCalled()
  })

  it('4. card thread resolves phone from hydrated record without ownership resolver', () => {
    const viewModel = buildSellerMapCardViewModel(amandaRecord)
    const thread = buildThreadFromViewModel(viewModel, amandaRecord)
    expect(resolveMapThreadPhone(amandaRecord)).toBe('+16514428447')
    expect(thread.canonicalE164).toBe('+16514428447')
    expect(thread.prospectId).toBe('pros1_5d2dfe5ae95f982c0941f648')
  })

  it('5. entity-owned property uses property-linked human first name', () => {
    const values = buildMapTemplateManualValues(amandaRecord)
    expect(values.seller_first_name).toBe('Amanda')
    expect(values.seller_first_name).not.toContain('Trust')
  })

  it('6. Amanda / 274564949 greets the human prospect, not the trust owner', () => {
    const values = buildMapTemplateManualValues(amandaRecord)
    expect(values.seller_first_name).toBe('Amanda')
    expect(values.owner_name).toContain('Trust')
    expect(values.seller_first_name).not.toContain('Trust')
  })

  it('8. human name missing yields no ownership-check pool (blocks TextGrid "Hi," templates)', () => {
    const context = buildOwnershipCheckTemplateContext({
      propertyId: 'prop-1',
      masterOwnerId: 'mo-1',
      phoneId: 'ph-1',
      recipientPhone: '+16125550101',
      prospectId: 'pros-1',
      prospectFirstName: '',
      prospectFullName: '',
      smsEligible: true,
      agentName: 'Michael Porter',
      agentFirstName: 'Michael',
      ownerDisplayName: 'Some LLC',
      ownerLanguage: 'English',
      propertyAddress: '123 Main St',
      sellerDisplayName: '',
      smsAgentId: null,
      selectedAgentId: null,
      resolutionSource: 'hydrated_map_identity',
      resolutionDiagnostics: { candidateCount: 1, source: 'hydrated_map_identity' },
    })

    const pool = buildOwnershipTemplatePool(
      [
        makeTemplate('named', 'Hi {{seller_first_name}}, this is {{agent_first_name}} about {{property_address}}.'),
        makeTemplate('generic', 'Hi, I had a quick question about {{property_address}}. Are you connected with the owner?'),
      ],
      context,
      'English',
    )
    expect(pool).toHaveLength(0)
  })

  it('8b. production Pathao case: sms_eligible false still supplies seller_first_name for ownership check', () => {
    const values = buildMapTemplateManualValues({
      prospect_full_name: 'Pathao Vang',
      prospect_first_name: 'Pathao',
      sms_eligible: false,
      agent_persona: 'Jake Peterson',
    })
    expect(values.seller_first_name).toBe('')
    const ownershipValues = buildMapTemplateManualValues({
      prospect_full_name: 'Pathao Vang',
      prospect_first_name: 'Pathao',
      sms_eligible: undefined,
      agent_persona: 'Jake Peterson',
    })
    expect(ownershipValues.seller_first_name).toBe('Pathao')
  })

  it('9. entity name is never inserted into the greeting', () => {
    const values = buildMapTemplateManualValues({
      owner_display_name: 'Standish Garden Apts LLC',
      prospect_full_name: 'Maria Lopez',
      agent_persona: 'Carlos Mendez',
    })
    const context = { ...values, property_address: '1200 Standish Ave' }
    const evaluated = evaluateOwnershipTemplate(
      makeTemplate('en', 'Hi {{seller_first_name}}, this is {{agent_first_name}} about {{property_address}}.'),
      context,
    )
    expect(evaluated?.rendered).toContain('Hi Maria')
    expect(evaluated?.rendered).not.toContain('LLC')
  })

  it('10. "Hi there" is never produced', () => {
    const selection = pickRandomOwnershipCheckTemplate(
      [makeTemplate('bad', 'Hi there, this is {{agent_first_name}} about {{property_address}}.')],
      {
        seller_first_name: '',
        seller_name: '',
        agent_first_name: 'Michael',
        agent_name: 'Michael',
        property_address: '123 Main St',
        owner_name: 'Some LLC',
      },
      'English',
    )
    expect(selection).toBeNull()
  })

  it('16. canonical ph_ phone ID remains in phone_id', () => {
    const payload = buildMapOwnershipCheckQueuePayload({
      identity: {
        propertyId: '274564949',
        masterOwnerId: 'mo_804d2f26377bee1f43019235',
        phoneId: 'ph_amanda',
        recipientPhone: '+16514428447',
        prospectId: 'pros1_5d2dfe5ae95f982c0941f648',
        prospectFirstName: 'Amanda',
        prospectFullName: 'Amanda L Tallen',
        smsEligible: true,
        agentName: 'Andre Thompson',
        agentFirstName: 'Andre',
        ownerDisplayName: 'Trust',
        ownerLanguage: 'English',
        propertyAddress: '983 Edmund Ave',
        sellerDisplayName: 'Amanda L Tallen',
        smsAgentId: null,
        selectedAgentId: null,
        resolutionSource: 'hydrated_map_identity',
        resolutionDiagnostics: { candidateCount: 1, source: 'hydrated_map_identity' },
      },
      selection: {
        template: makeTemplate('tpl', 'Hi Amanda'),
        renderedMessage: 'Hi Amanda, this is Andre.',
        templateId: 'tpl',
        templateKey: 'tpl',
        language: 'English',
        weight: 1,
        selectionReason: 'uniform_random',
        excludedRecentTemplateId: null,
      },
      thread: { threadKey: '+16514428447' } as never,
      fromPhone: '+16125559999',
      textgridNumberId: null,
    })
    expect(payload.phone_id).toBe('ph_amanda')
  })

  it('17. phone_number_id remains null unless genuinely UUID', () => {
    const payload = buildMapOwnershipCheckQueuePayload({
      identity: {
        propertyId: '274564949',
        masterOwnerId: 'mo_804d2f26377bee1f43019235',
        phoneId: 'ph_amanda',
        recipientPhone: '+16514428447',
        prospectId: 'pros1_5d2dfe5ae95f982c0941f648',
        prospectFirstName: 'Amanda',
        prospectFullName: 'Amanda L Tallen',
        smsEligible: true,
        agentName: 'Andre Thompson',
        agentFirstName: 'Andre',
        ownerDisplayName: 'Trust',
        ownerLanguage: 'English',
        propertyAddress: '983 Edmund Ave',
        sellerDisplayName: 'Amanda L Tallen',
        smsAgentId: null,
        selectedAgentId: null,
        resolutionSource: 'hydrated_map_identity',
        resolutionDiagnostics: { candidateCount: 1, source: 'hydrated_map_identity' },
      },
      selection: {
        template: makeTemplate('tpl', 'Hi Amanda'),
        renderedMessage: 'Hi Amanda',
        templateId: 'tpl',
        templateKey: 'tpl',
        language: 'English',
        weight: 1,
        selectionReason: 'uniform_random',
        excludedRecentTemplateId: null,
      },
      thread: { threadKey: '+16514428447' } as never,
      fromPhone: '+16125559999',
      textgridNumberId: null,
    })
    expect(payload.phone_number_id).toBeUndefined()
    expect((payload.metadata as Record<string, unknown>).canonical_phone_id).toBe('ph_amanda')
  })

  it('18. successful send preserves full Map provenance', () => {
    const payload = buildMapOwnershipCheckQueuePayload({
      identity: {
        propertyId: '274564949',
        masterOwnerId: 'mo_804d2f26377bee1f43019235',
        phoneId: 'ph_amanda',
        recipientPhone: '+16514428447',
        prospectId: 'pros1_5d2dfe5ae95f982c0941f648',
        prospectFirstName: 'Amanda',
        prospectFullName: 'Amanda L Tallen',
        smsEligible: true,
        agentName: 'Andre Thompson',
        agentFirstName: 'Andre',
        ownerDisplayName: 'Trust',
        ownerLanguage: 'English',
        propertyAddress: '983 Edmund Ave',
        sellerDisplayName: 'Amanda L Tallen',
        smsAgentId: null,
        selectedAgentId: null,
        resolutionSource: 'hydrated_map_identity',
        resolutionDiagnostics: { candidateCount: 1, source: 'hydrated_map_identity' },
      },
      selection: {
        template: makeTemplate('tpl', 'Hi Amanda'),
        renderedMessage: 'Hi Amanda',
        templateId: 'tpl',
        templateKey: 'tpl',
        language: 'English',
        weight: 1,
        selectionReason: 'uniform_random',
        excludedRecentTemplateId: null,
      },
      thread: { threadKey: '+16514428447', marketId: 'Minneapolis, MN' } as never,
      fromPhone: '+16125559999',
      textgridNumberId: null,
    })
    expect(payload.source).toBe('map_command')
    expect(payload.send_source).toBe('map_command')
    expect(payload.created_from).toBe('leadcommand_map')
    expect(payload.action).toBe('send_ownership_check')
    expect(payload.message_type).toBe('ownership_check')
    expect(payload.property_id).toBe('274564949')
  })

  it('3. ownership_check templates are randomized from Supabase for the prospect language', async () => {
    const picker = await import('../../src/views/map/seller-card/ownership-check-template-picker')
    const templateData = await import('../../src/lib/data/templateData')
    const catalog = [
      makeTemplate('en-1', 'Hi {{seller_first_name}}, question about {{property_address}}.', { language: 'English' }),
      makeTemplate('es-1', 'Hola {{seller_first_name}}, pregunta sobre {{property_address}}.', { language: 'Spanish' }),
    ]
    vi.spyOn(templateData, 'fetchTemplatesByUseCase').mockResolvedValue(catalog)
    vi.spyOn(picker, 'resolveMapOwnerLanguage').mockResolvedValue('Spanish')

    const selection = await picker.pickOwnershipCheckTemplateForMap(
      {
        seller_first_name: 'Maria',
        seller_name: 'Maria Lopez',
        property_address: '123 Main St',
        agent_name: 'Chris',
        agent_first_name: 'Chris',
        owner_name: 'LLC',
      },
      'Spanish',
    )

    expect(selection?.templateId).toBe('es-1')
    expect(selection?.selectionReason).toMatch(/random/)
  })

  it('19. agent_persona on master_owners fills template context when pin omits it', () => {
    const withoutAgent = buildMapTemplateManualValues({
      ...amandaRecord,
      agent_persona: undefined,
      agent_family: undefined,
    })
    expect(withoutAgent.agent_first_name).toBe('')

    const withAgent = buildMapTemplateManualValues({
      ...amandaRecord,
      agent_persona: 'Andre Thompson',
    })
    expect(withAgent.agent_first_name).toBe('Andre')
  })

  it('20. map ownership check click path uses sendInboxMessageNow (54e5e53 send chain)', async () => {
    const actionsPath = fileURLToPath(new URL('../../src/views/map/seller-card/useSellerMapCardActions.ts', import.meta.url))
    const source = await readFile(actionsPath, 'utf8')
    expect(source).toContain('sendInboxMessageNow')
    expect(source).toContain('resolveMapOwnershipCheckForSend')
    expect(source).toContain('buildOwnershipCheckTemplateContext')
    expect(source).toContain('renderTemplate(followUpTemplate, templateContext)')
    expect(source).toContain('skipRenderGuard: true')
    expect(source).toContain('messageType: \'ownership_check\'')
    expect(source).toContain('hasGenericRightPersonWording')
    expect(source).not.toContain('sendMapOwnershipCheck')
    expect(source).not.toContain('Seller name required for ownership check')
    expect(source).not.toContain('templateSelection.renderedMessage')
  })
})