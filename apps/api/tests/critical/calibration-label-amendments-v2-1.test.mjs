// Versioned calibration label amendments (owner decision LOCKED 2026-10-17): the frozen v2 corpus is never
// overwritten; v2.1 is an explicit overlay with evidence. Each amendment must point at a real example by
// id AND text hash, record the frozen previous value exactly, and carry an evidence note.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classify } from '../../src/lib/domain/classification/classify.js'

const ROOT = new URL('../fixtures/acquisition-brain/independent-calibration-v2/', import.meta.url).pathname
const jsonl = (f) => readFileSync(join(ROOT, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('v2.1 amendments are an explicit, evidenced overlay on the untouched frozen v2 labels', () => {
  const gold = new Map(jsonl('gold-labels.jsonl').map((g) => [g.calibration_example_id, g]))
  const amendments = jsonl('gold-label-amendments-v2.1.jsonl')
  const note = readFileSync(join(ROOT, 'label-amendments-v2.1.md'), 'utf8')
  assert.ok(amendments.length >= 1)
  for (const a of amendments) {
    const g = gold.get(a.calibration_example_id)
    assert.ok(g, a.calibration_example_id)
    assert.equal(a.text_sha256, g.text_sha256, 'applies to exactly this text')
    assert.equal(g[a.field], a.previous_value, 'the frozen v2 value is recorded exactly (not overwritten)')
    assert.notEqual(a.amended_value, a.previous_value)
    assert.equal(a.label_version, 'independent_calibration_v2.1')
    assert.ok(note.includes(`## ${a.calibration_example_id}`), 'evidence note present')
    assert.equal(a.affects_calibration_gates, false)
  }
})

test('ic2-adv-own-02 (former owner of the named property, no wrong number / person): v2.1 = property_specific_non_owner', async () => {
  const g = jsonl('gold-labels.jsonl').find((x) => x.calibration_example_id === 'ic2-adv-own-02')
  const a = jsonl('gold-label-amendments-v2.1.jsonl').find((x) => x.calibration_example_id === 'ic2-adv-own-02')
  assert.equal(g.preceding_outbound_use_case, 'ownership_check')
  assert.doesNotMatch(g.deidentified_raw_text, /wrong\s+(number|person)/i, 'the seller never said wrong number / wrong person')
  assert.equal(a.amended_value, 'property_specific_non_owner')
  const c = await classify(g.deidentified_raw_text, null, { heuristicOnly: true })
  assert.equal(c.primary_intent, a.amended_value)
})
