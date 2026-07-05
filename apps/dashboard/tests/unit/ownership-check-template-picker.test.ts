import { describe, expect, it } from 'vitest'
import type { SmsTemplate } from '../../src/lib/data/templateData'
import {
  buildOwnershipTemplatePool,
  canonicalizeOwnerLanguage,
  evaluateOwnershipTemplate,
  filterOwnershipTemplatesForLanguage,
  languagesMatchForTemplate,
  pickRandomOwnershipCheckTemplate,
  pickWeightedRandom,
} from '../../src/views/map/seller-card/ownership-check-template-picker'

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
    expect(filterOwnershipTemplatesForLanguage(templates, 'Vietnamese').map((t) => t.id)).toEqual(['en-1'])
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
      if (picked?.id) picks.add(picked.id)
    }
    expect(picks.size).toBeGreaterThan(1)
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
      expect(result?.repaired).toContain('Hey Maria,')
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

  describe('falls back to a generic template when no prospect name is resolved (regression: William & Cheryl Ludwig / 665 Portland Ave)', () => {
    const personalizedFirstTouch = makeTemplate({
      id: 'en-personalized',
      language: 'English',
      isFirstTouch: true,
      templateText: 'Hey {{seller_first_name}}, this is {{agent_first_name}}. Do you still own {{property_address}}?',
    })
    const genericFirstTouch = makeTemplate({
      id: 'en-generic',
      language: 'English',
      // Deliberately NOT flagged is_first_touch in the catalog — mirrors a real
      // template-catalog shape where only personalized variants are tagged
      // first-touch, even though a generic ownership-check is semantically a
      // first touch too.
      isFirstTouch: false,
      templateText: 'Hi, this is {{agent_first_name}}. I\'m reaching out about {{property_address}}. Are you the owner?',
    })

    it('selects the generic template when seller_first_name is unresolved and only personalized first-touch templates exist otherwise', () => {
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

      expect(pool).toHaveLength(1)
      expect(pool[0].template.id).toBe('en-generic')
      expect(pool[0].repaired).not.toContain('William')
      expect(pool[0].repaired).not.toContain('Ludwig')
      expect(pool[0].repaired).toContain('Andre')
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