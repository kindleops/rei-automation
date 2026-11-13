// A renter is not the owner; a landlord is (blind evaluation v7, Z09: "I rent it out and it cash flows just fine. No
// plans to sell" was read as a non-owner, so a compliant soft-no reply was stopped). Renters stay non-owners.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCanonicalLedger } from '../../src/lib/domain/conversation-ai/fact-ledger.js'

const own = (body) => buildCanonicalLedger({
  messages: [{ id: 'o1', direction: 'outbound', body: 'Hi, this is Nova. Do you still own the house on Crestline Ave?' }, { id: 'i1', direction: 'inbound', body }],
  now: '2026-10-30T00:00:00Z',
}).facts?.ownership?.value ?? null

test('a landlord is not read as a non-owner', () => {
  for (const b of ['I rent it out and it cash flows just fine. No plans to sell, but thanks', 'I rent it out', 'we rent it to a family', "I'm renting it out right now", 'We rent the house out to students']) {
    assert.notEqual(own(b), 'denied', b)
  }
})

test('a renter is still a non-owner', () => {
  for (const b of ['I just rent here', "I'm renting, not the owner", "I'm a tenant", 'we rent this place', 'I rent the house from a guy in Ohio']) {
    assert.equal(own(b), 'denied', b)
  }
})

// "You mentioned maybe later in the year" quotes a timeline the seller stated (blind evaluation v7, Z47); an attribution
// to a timeline the seller never gave is still refused.
import { unsupportedAttribution } from '../../src/lib/domain/conversation-ai/outbound-validator.js'
test('an attribution to a stated timeline is supported; to an unstated one it is not', () => {
  const ledgerOf = (body) => buildCanonicalLedger({ messages: [{ id: 'o1', direction: 'outbound', body: 'Do you still own the house?' }, { id: 'i1', direction: 'inbound', body }], now: '2026-10-30T00:00:00Z' })
  const text = 'Hi Winifred, Nova with Reivesti Home Buyers again. You mentioned maybe later in the year. Would you ever think about selling 2525 Elmhurst Blvd?'
  assert.equal(unsupportedAttribution(text, ledgerOf('maybe later in the year, not now')), null)
  assert.match(String(unsupportedAttribution(text, ledgerOf('yes I own it'))), /^unsupported_attribution/)
})
