// Agent S3 — entity-owned contact readiness (owner 10-09). Pure classifier +
// the outreach projection. Test data only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyContactReadiness, contactReadinessDisplay } from '../../src/lib/agent/quick-scan/contact-readiness.js'
import { projectOutreach } from '../../src/lib/agent/quick-scan/tools.js'
import { findingsFromTool } from '../../src/lib/agent/quick-scan/evidence.js'

const base = { sms: { eligible: false, reason: 'entity_contact_requires_review', rows: 1, ready: 0 }, graphRead: true, candidates: null, candidatesLookedUp: false, candidatesRead: true, review: { requires_review: true, exclusion_reasons: ['ENT_ROLE_UNCORROBORATED'] }, reviewRead: true, suppressedThread: false }

test('graph phone on an entity needing review = contact found, relationship unresolved (never "no contact")', () => {
  const r = classifyContactReadiness(base)
  assert.equal(r.state, 'relationship_unresolved')
  assert.equal(r.phones, 1)
  assert.equal(r.campaign_eligible, false) // eligibility untouched: the graph says no
  assert.match(contactReadinessDisplay(r), /Contact found — relationship unresolved/)
  assert.match(contactReadinessDisplay(r), /role at the entity is not corroborated/)
})

test('vendor-linked candidates only, no review flag = vendor-associated phone; with review flag = unresolved', () => {
  const cands = { people: 1, phones: 2, unresolved: 1, candidates: [{ resolution: 'linked_unresolved', phones: [{ masked: '•••-1234' }, { masked: '•••-9876' }] }] }
  const v = classifyContactReadiness({ ...base, sms: { eligible: false, reason: 'missing_phone', rows: 1, ready: 0 }, candidates: cands, candidatesLookedUp: true, review: null })
  assert.equal(v.state, 'vendor_associated_phone')
  assert.deepEqual(v.masked_phones, ['•••-1234', '•••-9876'])
  const u = classifyContactReadiness({ ...base, candidates: cands, candidatesLookedUp: true })
  assert.equal(u.state, 'relationship_unresolved')
})

test('resolved owner candidate or graph phone without review = confirmed relationship; eligibility stays the graph verdict', () => {
  const c = classifyContactReadiness({ ...base, sms: { eligible: true, reason: null, rows: 1, ready: 1 }, review: { requires_review: false, exclusion_reasons: [] } })
  assert.equal(c.state, 'confirmed_relationship')
  assert.equal(c.campaign_eligible, true)
  const d = classifyContactReadiness({ ...base, sms: { eligible: false, reason: 'missing_timezone', rows: 1, ready: 0 }, review: null })
  assert.equal(d.state, 'confirmed_relationship')
  assert.equal(d.campaign_eligible, false) // a confirmed contact is never promoted into eligibility
})

test('suppression wins; entity review reasons are never treated as suppression', () => {
  assert.equal(classifyContactReadiness({ ...base, suppressedThread: true }).state, 'held_suppressed')
  assert.equal(classifyContactReadiness({ ...base, sms: { eligible: false, reason: 'opted_out', rows: 1, ready: 0 } }).state, 'held_suppressed')
  for (const r of ['ENT_NO_REGISTRY_LINK', 'ENT_NO_COMPLIANT_CHANNEL', 'ENT_NO_HUMAN_CANDIDATE', 'ENT_DISSOLVED']) {
    assert.notEqual(classifyContactReadiness({ ...base, review: { requires_review: true, exclusion_reasons: [r] } }).state, 'held_suppressed')
  }
})

test('no contact only when every read succeeded; a failed read is unknown', () => {
  const none = { ...base, sms: { eligible: false, reason: 'not_in_campaign_audience', rows: 0, ready: 0 }, candidates: { people: 0, phones: 0, unresolved: 0, candidates: [] }, candidatesLookedUp: true, review: null }
  assert.equal(classifyContactReadiness(none).state, 'no_contact_found')
  assert.equal(classifyContactReadiness({ ...none, candidatesRead: false }).state, 'unknown')
  assert.equal(classifyContactReadiness({ ...none, graphRead: false }).state, 'unknown')
})

test('projection carries masked phones only (no names) and emits a contact_readiness finding', () => {
  const result = { generatedAt: '2026-10-09T06:00:00Z', unavailable: [], states: { P1: { sms: { eligible: false, reason: 'missing_phone', rows: 1, ready: 0, source: 'campaign_target_graph', reviewChecked: true }, contactCandidates: { people: 1, phones: 1, unresolved: 1, candidates: [{ prospectId: 'x', name: 'Test Person', resolution: 'linked_unresolved', evidence: [], phones: [{ masked: '•••-4321', type: 'wireless' }] }] }, lastContact: null, stage: null, status: null, dealId: null, conversation: null, campaigns: null } } }
  const out = projectOutreach(result, 'P1', { available: true, row: { requires_review: true, exclusion_reasons: ['ENT_ROLE_UNCORROBORATED'] } })
  assert.equal(out.contact_readiness.state, 'relationship_unresolved')
  assert.equal(JSON.stringify(out).includes('Test Person'), false)
  const fs = findingsFromTool('eg.outreach_state', out, { run_id: 'r', property_id: 'P1', retrieved_at: '2026-10-09T06:00:00Z', now: new Date('2026-10-09T06:00:00Z') })
  const f = fs.find((x) => x.key === 'contact_readiness')
  assert.ok(f)
  assert.equal(f.source_class, 'internal_record')
  assert.equal(f.value.state, 'relationship_unresolved')
  assert.ok(f.limitations.some((l) => /not missing contact data/.test(l)))
})
