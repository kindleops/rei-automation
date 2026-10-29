// SMS shorthand ("txt", "this #", "agian") is read as the words it stands for: an opt-out written in shorthand is
// still an opt-out (blind evaluation v6, Z05: "pls dont txt this # agian" was read as unclear).
import test from 'node:test'
import assert from 'node:assert/strict'
import { classify, correctKeyMisspellings } from '../../src/lib/domain/classification/classify.js'

test('shorthand normalisation: txt / txts / txting, "this #", agian', () => {
  assert.equal(correctKeyMisspellings('pls dont txt this # agian'), 'pls dont text this number again')
  assert.equal(correctKeyMisspellings('no more txts'), 'no more texts')
  assert.equal(correctKeyMisspellings('stop txting me'), 'stop texting me')
  // a hash before digits is an address or unit, not "number"
  assert.equal(correctKeyMisspellings('the house is unit #4'), 'the house is unit #4')
})

test('an opt-out in shorthand is an opt-out', async () => {
  for (const t of ['pls dont txt this # agian', 'dont txt me', 'no more txts', 'do not txt again', 'stop txting me', 'dont txt this number agian']) {
    const c = await classify(t, null, { heuristicOnly: true })
    assert.ok(c.compliance_flag === 'stop_texting' || c.primary_intent === 'opt_out', `${t} → ${c.primary_intent}/${c.compliance_flag}`)
  }
})

test('shorthand that is not an opt-out stays what it was', async () => {
  for (const t of ['txt me the details', 'yes txt is fine', 'you can txt me later this week']) {
    const c = await classify(t, null, { heuristicOnly: true })
    assert.notEqual(c.compliance_flag, 'stop_texting', t)
    assert.notEqual(c.primary_intent, 'opt_out', t)
  }
})
