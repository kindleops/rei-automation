import { describe, expect, it } from 'vitest'
import {
  MAP_OWNERSHIP_FORBIDDEN_SELECT_COLUMNS,
  MAP_OWNERSHIP_MASTER_OWNER_SELECT,
  MAP_OWNERSHIP_PHONE_SELECT,
} from '../../src/domain/map/resolve-map-ownership-check'

describe('map ownership production schema contract', () => {
  it('master owner select uses only production columns', () => {
    const columns = MAP_OWNERSHIP_MASTER_OWNER_SELECT.split(',').map((c) => c.trim())
    expect(columns).toEqual([
      'master_owner_id',
      'best_phone_1',
      'primary_phone_id',
      'display_name',
      'best_language',
      'agent_persona',
      'agent_family',
    ])
    for (const forbidden of MAP_OWNERSHIP_FORBIDDEN_SELECT_COLUMNS) {
      if (forbidden.startsWith('master_owners.')) {
        expect(MAP_OWNERSHIP_MASTER_OWNER_SELECT).not.toContain(forbidden.replace('master_owners.', ''))
      }
    }
  })

  it('phones select uses only production columns', () => {
    const columns = MAP_OWNERSHIP_PHONE_SELECT.split(',').map((c) => c.trim())
    expect(columns).toEqual([
      'phone_id',
      'master_owner_id',
      'canonical_e164',
      'canonical_prospect_id',
      'primary_prospect_id',
      'linked_prospect_ids_json',
    ])
    expect(MAP_OWNERSHIP_PHONE_SELECT).not.toContain('sms_eligible')
  })

  it('fails contract if forbidden columns are reintroduced', () => {
    const forbiddenTokens = ['sms_agent_id', 'selected_agent_id', 'sms_eligible']
    const combined = `${MAP_OWNERSHIP_MASTER_OWNER_SELECT},${MAP_OWNERSHIP_PHONE_SELECT}`
    for (const token of forbiddenTokens) {
      expect(combined).not.toContain(token)
    }
  })
})