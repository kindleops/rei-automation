import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeCampaignStageCode } from '../../src/lib/domain/campaigns/campaign-stage-code.js'
import { resolvePropertyTypeScope, expandTemplatePropertyScopes } from '../../src/lib/sms/property_scope.js'
import { resolveLanguage } from '../../src/lib/sms/language_aliases.js'

test('stage aliases normalize to canonical S1', () => {
  assert.equal(normalizeCampaignStageCode('first_touch'), 'S1')
  assert.equal(normalizeCampaignStageCode('ownership_check'), 'S1')
  assert.equal(normalizeCampaignStageCode('s1_ownership'), 'S1')
  assert.equal(normalizeCampaignStageCode('S1'), 'S1')
})

test('multifamily property labels resolve to template scopes', () => {
  assert.equal(resolvePropertyTypeScope({ property_type: 'Multifamily 2–4', unit_count: 3 }), 'Triplex')
  assert.equal(resolvePropertyTypeScope({ property_type: 'Multifamily 5+' }), '5+ Units')
  const scopes = expandTemplatePropertyScopes({ property_type: 'Multifamily 2-4' })
  assert.ok(scopes.includes('Duplex'))
  assert.ok(scopes.includes('Any Residential'))
})

test('language normalization preserves full canonical names', () => {
  assert.equal(resolveLanguage('Mandarin').canonical, 'Mandarin')
  assert.equal(resolveLanguage('Asian Indian (Hindi or Other)').canonical, 'Asian Indian (Hindi or Other)')
  assert.equal(resolveLanguage('Chinese').canonical, 'Mandarin')
  assert.equal(resolveLanguage('Thai').unsupported, true)
})