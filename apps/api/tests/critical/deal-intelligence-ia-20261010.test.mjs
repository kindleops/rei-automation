/**
 * DEAL INTELLIGENCE IA (2026-10-10) — the read-model fixes behind the owner's
 * findings: age was missing (prospects.mob never selected), "Contact score
 * 105" had no scale (vendor 0–120), and an engine run the engine REPORTED as
 * failed closed its stream as `decision_ready … done`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ageFromMob, CONTACT_SCORE_VENDOR_MAX, contactScore100, contactScoreLabel, prospectCards } from '../../src/lib/domain/deal-intelligence/deal-record-sections.js'
import { terminalEvent } from '../../src/lib/domain/deal-intelligence/engine-run-events.js'

const NOW = new Date('2026-10-10T12:00:00Z')

test('age from the vendor birth month (YYYYMM); display only, sane bounds', () => {
  assert.equal(ageFromMob('195407', NOW), 72)
  assert.equal(ageFromMob('195411', NOW), 71) // birthday month not reached yet
  assert.equal(ageFromMob('1980', NOW), 46)
  assert.equal(ageFromMob('', NOW), null)
  assert.equal(ageFromMob('abc', NOW), null)
  assert.equal(ageFromMob('203001', NOW), null) // future
  assert.equal(ageFromMob('201501', NOW), null) // a minor is not a seller record
})

test('contact score: vendor 0–120 rescaled into 0–100, −1 is "not scored"', () => {
  assert.equal(CONTACT_SCORE_VENDOR_MAX, 120)
  assert.equal(contactScore100(105), 88)
  assert.equal(contactScore100(120), 100)
  assert.equal(contactScore100(999), 100)
  assert.equal(contactScore100(0), 0)
  assert.equal(contactScore100(-1), null)
  assert.equal(contactScore100(null), null)
  for (const raw of [0, 1, 50, 99, 100, 101, 111, 119, 120, 150]) {
    const s = contactScore100(raw)
    assert.ok(s >= 0 && s <= 100, `score ${raw} → ${s} stays in 0–100`)
  }
  assert.equal(contactScoreLabel(105), '88 / 100 (vendor 105 of 120)')
})

test('prospect cards carry age + language + bounded score, and the field list shows the scale', () => {
  const [card] = prospectCards([{ prospect_id: 'p1', full_name: 'Person Redacted', is_primary_prospect: true, mob: '195407', language_preference: 'Spanish', contact_score_final: 105, gender: 'Female' }], NOW)
  assert.equal(card.age, 72)
  assert.equal(card.language, 'Spanish')
  assert.equal(card.contactScore, 88)
  const f = Object.fromEntries(card.fields.map((x) => [x.label, x.value]))
  assert.equal(f.Age, '72 (from birth month on record)')
  assert.equal(f['Contact score'], '88 / 100 (vendor 105 of 120)')
  assert.equal(card.fields[0].label, 'Age')
  const [none] = prospectCards([{ prospect_id: 'p2', full_name: 'X', contact_score_final: -1 }], NOW)
  assert.equal(none.age, null)
  assert.equal(none.contactScore, null)
  assert.ok(!none.fields.some((x) => x.label === 'Contact score' || x.label === 'Age'))
})

test('engine run terminal event: a REPORTED failure is a failure, never "done"', () => {
  assert.deepEqual(terminalEvent({ ok: true, decision_status: 'recomputed' }), { ok: true, stage: 'decision_ready', status: 'done', decision_status: 'recomputed' })
  assert.deepEqual(terminalEvent({ ok: false, error: 'property_not_found', decision_status: 'engine_failed' }), { ok: false, error: 'property_not_found', decision_status: 'engine_failed' })
  assert.deepEqual(terminalEvent({ ok: false }), { ok: false, error: 'engine_failed', decision_status: null })
  assert.equal(terminalEvent(null).ok, false)
})
