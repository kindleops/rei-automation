// rc-8.5.21 v3 fix pass (environment note): the legacy classifier calls api.openai.com when a key is
// present. A deterministic opt-out must take precedence REGARDLESS of the model's output: the model is
// stubbed to answer not_interested (no stop flag) and an explicit opt-out still classifies opt_out with
// the suppression decision — the model is never even consulted. With a key present and the REAL provider
// module, an explicit opt-out makes no network call at all.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENAI_KEY = process.env.OPENAI_KEY || 'sk-test-v3fix-not-a-real-key'
const { classify, __setClassifierAiForTests } = await import('../../src/lib/domain/classification/classify.js')

const NOT_INTERESTED = JSON.stringify({ language: 'English', primary_intent: 'not_interested', objection: 'not_interested', emotion: 'calm', stage_hint: 'Follow-Up', compliance_flag: 'null', positive_signals: [], confidence: 0.97, notes: 'model says not interested' })
const EXPLICIT_OPT_OUTS = ['STOP', 'Stop texting me', 'remove me from your list', 'unsubscribe', 'please do not contact me again', 'take me off your list', 'spam', 'go away', 'leave me alone', 'Quíteme de su lista', 'no me vuelvan a contactar']

test('a stubbed model answering not_interested can never override a deterministic opt-out (the model is not consulted)', async () => {
  let calls = 0
  __setClassifierAiForTests(async () => { calls += 1; return NOT_INTERESTED })
  try {
    for (const m of EXPLICIT_OPT_OUTS) {
      const r = await classify(m)
      assert.equal(r.primary_intent, 'opt_out', `${m}: ${r.primary_intent}`)
      assert.equal(r.automation_decision?.suppression_action, 'opt_out', `${m}: the suppression decision stands`)
      assert.equal(r.source, 'heuristic', `${m}: decided deterministically`)
    }
    assert.equal(calls, 0, 'the model was never called for an explicit opt-out')
  } finally { __setClassifierAiForTests(null) }
})

test('on the AI-merge path the model may ADD a stop but never clear one, and a non-opt-out stays a non-opt-out', async () => {
  let calls = 0
  __setClassifierAiForTests(async () => { calls += 1; return NOT_INTERESTED })
  try {
    const low = await classify('ok')
    assert.equal(calls, 1, 'a low-confidence reply reaches the model')
    assert.equal(low.source, 'ai')
    assert.notEqual(low.primary_intent, 'opt_out')
  } finally { __setClassifierAiForTests(null) }
  __setClassifierAiForTests(async () => JSON.stringify({ ...JSON.parse(NOT_INTERESTED), compliance_flag: 'stop_texting' }))
  try {
    const added = await classify('ok')
    assert.equal(added.compliance_flag, 'stop_texting', 'the model may only ever make it MORE conservative')
  } finally { __setClassifierAiForTests(null) }
})

test('with an OpenAI key present and the REAL provider module, an explicit opt-out makes no network call', async () => {
  const real = globalThis.fetch
  const hits = []
  globalThis.fetch = async (u) => { hits.push(String(u)); throw new Error('network trapped') }
  try {
    for (const m of EXPLICIT_OPT_OUTS) {
      const r = await classify(m)
      assert.equal(r.primary_intent, 'opt_out', m)
    }
    assert.deepEqual(hits.filter((h) => /openai/.test(h)), [])
  } finally { globalThis.fetch = real }
})
