import { describe, expect, it } from 'vitest'
import {
  deriveOwnerMatchFlags,
  ownerMatchFlagTone,
  withThreadProspectDisplayName,
} from '../../src/modules/inbox/utils/participantLabels'

describe('ownerMatchFlagTone', () => {
  it('marks owner evidence flags positive', () => {
    expect(ownerMatchFlagTone('likely_owner')).toBe('positive')
    expect(ownerMatchFlagTone('family')).toBe('positive')
  })

  it('marks renter and wrong-person flags negative', () => {
    expect(ownerMatchFlagTone('tenant')).toBe('negative')
    expect(ownerMatchFlagTone('wrong_person')).toBe('negative')
  })
})

describe('withThreadProspectDisplayName', () => {
  it('replaces master-owner display_name for the active thread phone', () => {
    const participant = {
      participant_id: 'p1',
      property_id: '249',
      canonical_e164: '+19012812981',
      display_name: 'Anthony Polk & Wesley Arije',
    }
    const result = withThreadProspectDisplayName(participant, 'Antho Arije', '+19012812981')
    expect(result?.display_name).toBe('Antho Arije')
  })
})

describe('deriveOwnerMatchFlags', () => {
  it('derives likely owner and family from matching text', () => {
    const flags = deriveOwnerMatchFlags({
      likely_owner: true,
      person_flags_text: 'Family, Resident',
      matching_flags: 'Likely Owner',
    }).map((row) => row.key)
    expect(flags).toContain('likely_owner')
    expect(flags).toContain('family')
  })
})