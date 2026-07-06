import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SmsTemplate } from '../../src/lib/data/templateData'
import {
  buildOwnershipTemplatePool,
  canonicalizeOwnerLanguage,
  evaluateOwnershipTemplate,
  hasTextgridBlockedGreeting,
  fetchOwnershipCheckTemplates,
  resetOwnershipCheckTemplateCacheForTests,
  filterOwnershipTemplatesForLanguage,
  languagesMatchForTemplate,
  pickOwnershipCheckTemplateForMap,
  pickRandomOwnershipCheckTemplate,
  pickWeightedRandom,
  resolveMapOwnerLanguage,
} from '../../src/views/map/seller-card/ownership-check-template-picker'

vi.mock('../../src/lib/data/templateData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/data/templateData')>()
  return {
    ...actual,
    fetchTemplatesByUseCase: vi.fn(actual.fetchTemplatesByUseCase),
  }
})

const makeTemplate = (overrides: Partial<SmsTemplate> & { id: string; language: string; templateText: string }): SmsTemplate => ({
  templateId: overrides.id,
  active: true,
  useCase: 'Ownership Check',
  useCaseSlug: 'ownership_check',
  stageCode: null,
  stageLabel: null,
  agentStyle: null,
  propertyTypeScope: null,
  dealStrategy: null,
  isFirstTouch: true,
  isFollowUp: false,
  englishTranslation: null,
  variables: [],
  raw: {},
  ...overrides,
})

const context = {
  seller_first_name: 'Maria',
  seller_name: 'Maria Lopez',
  owner_name: 'Maria Lopez',
  property_address: '123 Main St, Miami, FL',
  agent_name: 'Chris',
  agent_first_name: 'Chris',
}

describe('ownership check template picker', () => {
  afterEach(() => {
    vi.clearAllMocks()
    resetOwnershipCheckTemplateCacheForTests()
  })

  it('resolves prospect language preference ahead of master-owner best_language', async () => {
    await expect(resolveMapOwnerLanguage({
      language_preference: 'Spanish',
      best_language: 'English',
    }, 'mo-1')).resolves.toBe('Spanish')
  })

  it('randomizes ownership_check templates for the resolved prospect language', async () => {
    const { fetchTemplatesByUseCase } = await import('../../src/lib/data/templateData')
    const templates = [
      makeTemplate({ id: 'en-1', language: 'English', templateText: 'Hi {{seller_first_name}}, question about {{property_address}}' }),
      makeTemplate({ id: 'es-1', language: 'Spanish', templateText: 'Hola {{seller_first_name}}, pregunta sobre {{property_address}}' }),
      makeTemplate({ id: 'es-2', language: 'Spanish', templateText: 'Hola {{seller_first_name}}, ¿sigue siendo su propiedad en {{property_address}}?' }),
    ]
    vi.mocked(fetchTemplatesByUseCase).mockResolvedValue(templates)

    const selection = await pickOwnershipCheckTemplateForMap(
      context,
      'Spanish',
      { random: () => 0.99 },
    )

    expect(selection?.language).toBe('Spanish')
    expect(['es-1', 'es-2']).toContain(selection?.templateId)
    expect(selection?.selectionReason).toMatch(/random/)
  })

  it('loads active ownership_check templates from Supabase via fetchTemplatesByUseCase', async () => {
    const { fetchTemplatesByUseCase } = await import('../../src/lib/data/templateData')
    const catalog = [
      makeTemplate({
        id: 'supabase-oc-1',
        language: 'English',
        templateText: 'Hi {{seller_first_name}}, this is {{agent_first_name}} about {{property_address}}.',
      }),
    ]
    vi.mocked(fetchTemplatesByUseCase).mockResolvedValueOnce(catalog)

    const templates = await fetchOwnershipCheckTemplates()
    expect(fetchTemplatesByUseCase).toHaveBeenCalledWith('ownership_check')
    expect(templates).toEqual(catalog)
    expect(templates.every((template) => template.useCaseSlug === 'ownership_check')).toBe(true)
  })

  it('detects TextGrid-blocked Hi-comma greetings from production failures', () => {
    expect(hasTextgridBlockedGreeting(
      'Hi, I had a quick question about 2919 Logan Ave N, Minneapolis, Mn 55411. Are you connected with the owner?',
    )).toBe(true)
    expect(hasTextgridBlockedGreeting('Hi Pathao, this is Jake about 2919 Logan Ave N.')).toBe(false)
    expect(hasTextgridBlockedGreeting('Ni hao Pathao, Jake zai zheli.')).toBe(false)
  })

  it('canonicalizes owner language aliases', () => {
    expect(canonicalizeOwnerLanguage('spanish')).toBe('Spanish')
    expect(canonicalizeOwnerLanguage('Asian Indian (Hindi or Other)')).toBe('Indian (Hindi or Other)')
  })

  it('matches owner language to template language with hindi fallback', () => {
    expect(languagesMatchForTemplate('Asian Indian (Hindi or Other)', 'Indian (Hindi or Other)')).toBe(true)
    expect(languagesMatchForTemplate('Spanish', 'Spanish')).toBe(true)
    expect(languagesMatchForTemplate('Spanish', 'English')).toBe(false)
  })

  it('filters ownership templates by owner language with english fallback', () => {
    const templates = [
      makeTemplate({ id: 'en-1', language: 'English', templateText: 'Hi {{seller_first_name}}, question about {{property_address}}' }),
      makeTemplate({ id: 'es-1', language: 'Spanish', templateText: 'Hola {{seller_first_name}}, pregunta sobre {{property_address}}' }),
    ]

    expect(filterOwnershipTemplatesForLanguage(templates, 'Spanish').map((t) => t.id)).toEqual(['es-1'])
    expect(filterOwnershipTemplatesForLanguage(templates, 'English').map((t) => t.id)).toEqual(['en-1'])
    expect(filterOwnershipTemplatesForLanguage(templates, 'Vietnamese')).toEqual([])
  })

  it('never downgrades a Mandarin prospect to English ownership_check templates', () => {
    const templates = [
      makeTemplate({ id: 'en-1', language: 'English', templateText: 'Hi {{seller_first_name}}, question about {{property_address}}' }),
      makeTemplate({ id: 'zh-1', language: 'Mandarin', templateText: '您好{{seller_first_name}}，关于{{property_address}}的问题。' }),
    ]

    expect(filterOwnershipTemplatesForLanguage(templates, 'Mandarin').map((t) => t.id)).toEqual(['zh-1'])
    expect(filterOwnershipTemplatesForLanguage([templates[0]], 'Mandarin')).toEqual([])
  })

  it('selects Mandarin ownership_check templates for Mandarin prospects', () => {
    const templates = [
      makeTemplate({ id: 'en-1', language: 'English', templateText: 'Hi {{seller_first_name}}, question about {{property_address}}' }),
      makeTemplate({ id: 'zh-1', language: 'Mandarin', templateText: '您好{{seller_first_name}}，我是{{agent_first_name}}，关于{{property_address}}。' }),
      makeTemplate({ id: 'zh-2', language: 'Chinese', templateText: '你好{{seller_first_name}}，{{property_address}}是您名下的房产吗？' }),
    ]
    const mandarinContext = {
      ...context,
      seller_first_name: '伟',
      seller_name: '伟',
      property_address: '1195 Arona St, Saint Paul, MN 55108',
    }

    const pool = buildOwnershipTemplatePool(templates, mandarinContext, 'Mandarin')
    expect(pool.map((entry) => entry.template.id)).toEqual(['zh-1', 'zh-2'])
    expect(pool.every((entry) => entry.rendered.includes('伟'))).toBe(true)
    expect(pool.some((entry) => entry.rendered.includes('Hi'))).toBe(false)
  })

  it('builds a multi-template pool and randomizes selection', () => {
    const templates = [
      makeTemplate({ id: 'en-1', language: 'English', templateText: 'Hi {{seller_first_name}}, quick question about {{property_address}}' }),
      makeTemplate({ id: 'en-2', language: 'English', templateText: 'Hello {{seller_first_name}}, checking ownership for {{property_address}}' }),
      makeTemplate({ id: 'en-3', language: 'English', templateText: 'Hey {{seller_first_name}}, is this still your property at {{property_address}}?' }),
    ]

    const pool = buildOwnershipTemplatePool(templates, context, 'English')
    expect(pool.length).toBe(3)

    const picks = new Set<string>()
    for (let i = 0; i < 30; i += 1) {
      const picked = pickRandomOwnershipCheckTemplate(templates, context, 'English')
      if (picked?.templateId) picks.add(picked.templateId)
    }
    expect(picks.size).toBeGreaterThan(1)
  })

  it('rejects blank or Hi there greetings instead of repairing them', () => {
    const blankGreeting = makeTemplate({ id: 'bad-1', language: 'English', templateText: 'Hi , question about {{property_address}}' })
    const hiThere = makeTemplate({ id: 'bad-2', language: 'English', templateText: 'Hi there, this is {{agent_first_name}} about {{property_address}}' })

    expect(evaluateOwnershipTemplate(blankGreeting, context)).toBeNull()
    expect(evaluateOwnershipTemplate(hiThere, context)).toBeNull()

    const pool = buildOwnershipTemplatePool(
      [hiThere],
      { ...context, seller_first_name: '', seller_name: '' },
      'English',
    )
    expect(pool.length).toBe(0)
  })

  it('supports weighted random selection', () => {
    const winner = pickWeightedRandom([
      { weight: 1, id: 'a' },
      { weight: 99, id: 'b' },
    ] as Array<{ weight: number; id: string }>)
    expect(winner?.id).toBeDefined()
  })

  describe('entity-name greeting guard (launch blocker: Master Owner as SMS recipient)', () => {
    const entityTemplate = makeTemplate({
      id: 'en-entity',
      language: 'English',
      templateText: 'Hey {{seller_first_name}}, is this still your property at {{property_address}}?',
    })

    it('rejects a rendered template whose greeting resolves to an LLC name', () => {
      const result = evaluateOwnershipTemplate(entityTemplate, {
        seller_first_name: 'West 7th Apartments LLC',
        property_address: '2246 7th St W, Bradenton, FL',
      })
      expect(result).toBeNull()
    })

    it('rejects a rendered template whose greeting resolves to a trust/estate name', () => {
      const result = evaluateOwnershipTemplate(entityTemplate, {
        seller_first_name: 'D & D Divide Trust',
        property_address: '100 Main St, Austin, TX',
      })
      expect(result).toBeNull()
    })

    it('accepts a rendered template whose greeting resolves to a real human name', () => {
      const result = evaluateOwnershipTemplate(entityTemplate, {
        seller_first_name: 'Maria',
        property_address: '2246 7th St W, Bradenton, FL',
      })
      expect(result).not.toBeNull()
      expect(result?.rendered).toContain('Hey Maria,')
    })

    it('never keeps an entity name as the sole ownership-check candidate for a first-touch pool', () => {
      const pool = buildOwnershipTemplatePool(
        [entityTemplate],
        { seller_first_name: '88 Cleveland - M LLC', property_address: '88 Cleveland Ave' },
        'English',
      )
      expect(pool).toHaveLength(0)
    })
  })

  describe('requires resolved seller + agent names (no generic TextGrid-blocked fallbacks)', () => {
    const personalizedFirstTouch = makeTemplate({
      id: 'en-personalized',
      language: 'English',
      isFirstTouch: true,
      templateText: 'Hey {{seller_first_name}}, this is {{agent_first_name}}. Do you still own {{property_address}}?',
    })
    const genericFirstTouch = makeTemplate({
      id: 'en-generic',
      language: 'English',
      isFirstTouch: true,
      templateText: 'Hi, I had a quick question about {{property_address}}. Are you connected with the owner?',
    })

    it('returns no pool when seller_first_name is unresolved — never selects TextGrid-blocked "Hi," templates', () => {
      const unresolvedContext = {
        seller_first_name: '',
        seller_name: '',
        owner_name: 'William & Cheryl Ludwig',
        property_address: '665 Portland Ave, Saint Paul, MN 55104',
        agent_name: 'Andre',
        agent_first_name: 'Andre',
      }

      const pool = buildOwnershipTemplatePool(
        [personalizedFirstTouch, genericFirstTouch],
        unresolvedContext,
        'English',
      )

      expect(pool).toHaveLength(0)
    })

    it('rejects production generic ownership_check wording that TextGrid blocks', () => {
      const result = evaluateOwnershipTemplate(genericFirstTouch, {
        seller_first_name: '',
        seller_name: '',
        property_address: '2919 Logan Ave N, Minneapolis, MN 55411',
        agent_name: 'Jake',
        agent_first_name: 'Jake',
      })
      expect(result).toBeNull()
    })

    it('accepts templates that greet with the human seller full name via {{seller_name}}', () => {
      const result = evaluateOwnershipTemplate(
        makeTemplate({
          id: 'en-full-name',
          language: 'English',
          templateText: 'Hi {{seller_name}}, this is {{agent_first_name}} about {{property_address}}.',
        }),
        {
          seller_first_name: 'Amanda',
          seller_name: 'Amanda L Tallen',
          owner_name: 'mo_804d2f26377bee1f43019235 Trust',
          property_address: '983 Edmund Ave, Saint Paul, MN 55104',
          agent_name: 'Andre',
          agent_first_name: 'Andre',
        },
      )
      expect(result?.rendered).toContain('Hi Amanda L Tallen')
      expect(result?.rendered).not.toContain('Trust')
    })

    it('rejects generic templates when seller and agent are both resolved', () => {
      const resolvedContext = {
        seller_first_name: 'Amanda',
        seller_name: 'Amanda L Tallen',
        owner_name: 'mo_804d2f26377bee1f43019235 Trust',
        property_address: '983 Edmund Ave, Saint Paul, MN 55104',
        agent_name: 'Andre',
        agent_first_name: 'Andre',
      }

      const pool = buildOwnershipTemplatePool(
        [genericFirstTouch],
        resolvedContext,
        'English',
      )

      expect(pool).toHaveLength(0)
    })

    it('rejects the generic "right person" ownership-check wording when seller and agent are resolved', () => {
      const rightPersonTemplate = makeTemplate({
        id: 'en-right-person',
        language: 'English',
        isFirstTouch: true,
        templateText: 'Hi, I\'m trying to reach the right person regarding {{property_address}}. Would you happen to know who handles it?',
      })

      const result = evaluateOwnershipTemplate(rightPersonTemplate, {
        seller_first_name: 'Maria',
        seller_name: 'Maria Lopez',
        owner_name: 'Some LLC',
        property_address: '1195 Arona St, Saint Paul, MN 55108',
        agent_name: 'Chris',
        agent_first_name: 'Chris',
      })

      expect(result).toBeNull()
    })

    it('still prefers the personalized first-touch template when a real prospect name is resolved', () => {
      const resolvedContext = {
        seller_first_name: 'Maria',
        seller_name: 'Maria Lopez',
        owner_name: 'William & Cheryl Ludwig',
        property_address: '665 Portland Ave, Saint Paul, MN 55104',
        agent_name: 'Andre',
        agent_first_name: 'Andre',
      }

      const pool = buildOwnershipTemplatePool(
        [personalizedFirstTouch, genericFirstTouch],
        resolvedContext,
        'English',
      )

      expect(pool.map((entry) => entry.template.id)).toContain('en-personalized')
    })

    it('reports no compatible template only when truly nothing renders (e.g. agent also unresolved)', () => {
      const pool = buildOwnershipTemplatePool(
        [personalizedFirstTouch, genericFirstTouch],
        { seller_first_name: '', seller_name: '', owner_name: '', property_address: '665 Portland Ave', agent_name: '', agent_first_name: '' },
        'English',
      )
      expect(pool).toHaveLength(0)
    })
  })
})