import { describe, expect, it } from 'vitest'
import { CONTACT_READINESS_META, contactReadinessOf } from './evidence-class'

const f = (id: string, pid: string, value: unknown, status = 'internal_record') => ({ finding_id: id, property_id: pid, finding_type: 'outreach_state', key: 'contact_readiness', value, evidence_status: status })

describe('contact readiness (entity-owned contacts)', () => {
  it('reads the five states + unknown with distinct labels', () => {
    const labels = Object.values(CONTACT_READINESS_META).map((m) => m.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels).toEqual(expect.arrayContaining(['No contact found', 'Contact found — relationship unresolved', 'Vendor-associated phone', 'Confirmed relationship', 'Held / suppressed']))
  })
  it('an unresolved entity relationship keeps its people/phones and never reads as no contact; eligibility stays separate', () => {
    const findings = { a: f('a', 'P1', { state: 'relationship_unresolved', people: 2, phones: 3, masked_phones: ['•••-1111'], requires_review: true, review_reasons: ['ENT_ROLE_UNCORROBORATED'], review_checked: true, campaign_eligible: false, campaign_reason: 'entity_contact_requires_review' }) }
    const cr = contactReadinessOf(findings as never, ['a'], 'P1')!
    expect(cr.state).toBe('relationship_unresolved')
    expect(cr.phones).toBe(3)
    expect(cr.label).not.toMatch(/no contact/i)
    expect(cr.campaign_eligible).toBe(false)
  })
  it('a failed contact read is unknown, not "no contact found"; other properties are not mixed in', () => {
    const findings = { a: f('a', 'P1', null, 'unavailable'), b: f('b', 'P2', { state: 'no_contact_found' }) }
    expect(contactReadinessOf(findings as never, ['a', 'b'], 'P1')!.state).toBe('unknown')
    expect(contactReadinessOf(findings as never, ['a', 'b'], 'P2')!.state).toBe('no_contact_found')
    expect(contactReadinessOf(findings as never, ['a', 'b'], 'P3')).toBeNull()
  })
})
