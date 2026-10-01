import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDossierCompliance } from '../../src/lib/cockpit/deal-intelligence-dossier.js'

test('list suppression alone suppresses', () => {
  const c = buildDossierCompliance({ suppressions: [{ reason: 'opt_out' }] })
  assert.equal(c.is_suppressed, true)
  assert.equal(c.list_suppressed, true)
  assert.equal(c.thread_suppressed, false)
})

test('thread-level suppression without a list row still suppresses (opted out / invalid / do-not-text)', () => {
  const c = buildDossierCompliance({
    suppressions: [],
    threadState: { is_suppressed: true, contactability_status: 'opted_out' },
  })
  assert.equal(c.is_suppressed, true)
  assert.equal(c.thread_suppressed, true)
  assert.equal(c.contactability_status, 'opted_out')
})

test('hydrated thread flag counts when thread state is unavailable', () => {
  const c = buildDossierCompliance({ suppressions: [], hydrated: { is_suppressed: true }, threadState: null })
  assert.equal(c.is_suppressed, true)
})

test('do_not_contact with is_suppressed=false is carried as contactability, not hidden', () => {
  const c = buildDossierCompliance({ threadState: { is_suppressed: false, contactability_status: 'do_not_contact' } })
  assert.equal(c.is_suppressed, false)
  assert.equal(c.contactability_status, 'do_not_contact')
})

test('wrong number comes from the phone row', () => {
  assert.equal(buildDossierCompliance({ phoneRow: { wrong_number_at: '2026-09-01T00:00:00Z' } }).wrong_number, true)
  assert.equal(buildDossierCompliance({}).wrong_number, false)
  assert.equal(buildDossierCompliance().is_suppressed, false)
})
