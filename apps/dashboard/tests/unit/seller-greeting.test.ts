import { describe, expect, it } from 'vitest'
import {
  buildMapTemplateManualValues,
  buildSellerGreetingFromThread,
  buildSellerGreetingValues,
} from '../../src/domain/inbox/seller-greeting'
import { buildTemplateContextFromThread, renderTemplate } from '../../src/lib/data/templateData'
import { buildSellerMapCardViewModel } from '../../src/views/map/seller-card/seller-map-card-view-model'
import { buildThreadFromViewModel } from '../../src/views/map/seller-card/useSellerMapCardActions'

describe('seller greeting resolution', () => {
  it('prefers prospect name over corporate master owner for templates', () => {
    const record = {
      owner_display_name: 'Tooless Properties LLC',
      owner_name: 'Tooless Properties LLC',
      prospect_full_name: 'Daniel Martinez',
      prospect_first_name: 'Daniel',
    }

    const greeting = buildSellerGreetingValues(record)

    expect(greeting.seller_name).toBe('Daniel Martinez')
    expect(greeting.seller_first_name).toBe('Daniel')
    expect(greeting.owner_name).toBe('Tooless Properties LLC')
  })

  it('builds map template manual values with prospect-first seller fields', () => {
    const manual = buildMapTemplateManualValues({
      owner_display_name: 'Tooless Properties LLC',
      prospect_full_name: 'Daniel Martinez',
    })

    expect(manual.seller_name).toBe('Daniel Martinez')
    expect(manual.seller_first_name).toBe('Daniel')
    expect(manual.owner_name).toBe('Tooless Properties LLC')
  })

  it('renders ownership check greeting with prospect first name', () => {
    const record = {
      property_id: 'prop-entity',
      master_owner_id: 'owner-entity',
      owner_display_name: 'Tooless Properties LLC',
      prospect_full_name: 'Daniel Martinez',
      prospect_first_name: 'Daniel',
      property_address_full: '123 Main St, Memphis, TN 38103',
      market: 'memphis, tn',
    }

    const viewModel = buildSellerMapCardViewModel(record)
    const thread = buildThreadFromViewModel(viewModel, record)
    const context = buildTemplateContextFromThread(thread, null, buildMapTemplateManualValues(record))
    const { renderedText } = renderTemplate({
      id: 'test',
      templateId: 'test',
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
      templateText: 'Hi {{seller_first_name}}, this is Chris. Are you still the owner of {{property_address}}?',
      englishTranslation: null,
      variables: ['seller_first_name', 'property_address'],
      raw: {},
    }, context)

    expect(renderedText).toContain('Hi Daniel')
    expect(renderedText).not.toContain('Tooless')
  })

  it('resolves greeting from inbox thread with entity owner and prospect child', () => {
    const greeting = buildSellerGreetingFromThread({
      id: '+19015551234',
      leadId: 'owner-1',
      marketId: 'memphis, tn',
      ownerName: 'Tooless Properties LLC',
      ownerDisplayName: 'Tooless Properties LLC',
      sellerName: 'Daniel Martinez',
      subject: '123 Main St',
      preview: '',
      status: 'read',
      priority: 'normal',
      sentiment: 'neutral',
      messageCount: 0,
      lastMessageLabel: '',
      lastMessageIso: new Date().toISOString(),
      unreadCount: 0,
      aiDraft: null,
      labels: [],
      prospect_full_name: 'Daniel Martinez',
      prospect_first_name: 'Daniel',
    } as never)

    expect(greeting.seller_name).toBe('Daniel Martinez')
    expect(greeting.seller_first_name).toBe('Daniel')
    expect(greeting.owner_name).toBe('Tooless Properties LLC')
  })
})