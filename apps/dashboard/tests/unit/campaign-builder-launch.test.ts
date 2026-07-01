import { describe, expect, it } from 'vitest'
import {
  buildActivateNowPayload,
  extractMarketFromFilterDraft,
  isInsideContactWindow,
  resolveCampaignTimezone,
} from '../../src/views/campaign-command/campaign-builder-launch'
import { createEmptyFilterGroups } from '../../src/views/campaign-command/campaignWizardAdapter'

describe('campaign-builder-launch', () => {
  it('extracts Los Angeles market from property filters', () => {
    const draft = {
      name: 'LA Test',
      description: '',
      template_use_case: 'ownership_check',
      stage_code: 'first_touch',
      target_filters: {
        ...createEmptyFilterGroups(),
        properties: [{
          id: 'f1',
          fieldKey: 'properties.market',
          field_key: 'properties.market',
          operator: 'is_any_of',
          value: ['Los Angeles, CA'],
          category: 'Location & Market',
          domain: 'properties',
        }],
      },
    }
    const { market, state } = extractMarketFromFilterDraft(draft)
    expect(market).toBe('Los Angeles, CA')
    expect(state).toBe('CA')
    expect(resolveCampaignTimezone(market)).toBe('America/Los_Angeles')
  })

  it('allows activate now inside Pacific contact window', () => {
    const noonPt = new Date('2026-07-01T19:00:00.000Z')
    expect(isInsideContactWindow('America/Los_Angeles', '08:00', '21:00', noonPt)).toBe(true)
  })

  it('builds immediate activation payload with processor kickoff', () => {
    const payload = buildActivateNowPayload({
      daily_cap: '750',
      per_sender_cap: '150',
      per_market_cap: '400',
      max_targets: '50',
      spread_interval_seconds: '45',
      contact_window_start: '08:00',
      contact_window_end: '21:00',
    }, 'campaign-123', 'America/Los_Angeles')
    expect(payload.confirm_live).toBe(true)
    expect(payload.no_send).toBe(false)
    expect(payload.trigger_immediate_processor).toBe(true)
    expect(payload.force_live).toBe(true)
  })
})