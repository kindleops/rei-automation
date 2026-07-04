import { describe, expect, it } from 'vitest'
import type { SmsTemplate } from '../../src/lib/data/templateData'
import {
  buildOwnershipTemplatePool,
  canonicalizeOwnerLanguage,
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
})