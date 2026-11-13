// Blind v16 held-out round (PI-LC-3): ledger:unsupported_attribution still refused ACCURATE citations of the seller in three
// sub-classes, fixed by class with the unsafe counterpart refused. Synthetic conversations only.
//  (a) day-of-month dates: "till the 18th" grounds "after the 18th" (1st, 22nd, eighteenth, twenty-first: one time word
//      each); a different day never grounds. The attributed clause stops where our own narration starts.
//  (b) the seller's shorthand: "next yr" grounds "next year" (yrs, wk, wks, mo, mos, mnth, tmrw, tmr, nxt, thru, b4); the
//      :timeline variant goes through the same normalization.
//  (c) the seller's own hedge quoted verbatim: "maybe" to OUR interest question grounds "You said maybe on selling." and
//      "You mentioned maybe." (ledger:unsupported_attribution:seller_interest); never an upgrade of it.
import '../helpers/critical-test-environment.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

import { validateAgentText, attributionGroundedInSellerWords } from '../../src/lib/domain/conversation-ai/agent-text-validator.js'
import { normalizeCompanyIdentity } from '../../src/lib/domain/conversation-ai/company-identity.js'
import { DEFAULT_AGENT_TEXT_POLICY } from '../../src/lib/domain/outreach/agent-text.js'

const NOW = '2026-10-30T18:00:00.000Z'
const ago = (min) => new Date(Date.parse(NOW) - min * 60e3).toISOString()
const CI = normalizeCompanyIdentity({ name: 'Reivesti Home Buyers', human_review: false, persona_descriptor: null })
const v = (text, messages, purpose = null) => validateAgentText(text, { purpose, companyIdentity: CI, now: NOW, policy: { ...DEFAULT_AGENT_TEXT_POLICY }, authorEmployee: 'nova', messages })
const thread = (...pairs) => pairs.map(([d, b], i) => ({ id: `m${i}`, direction: d === 'o' ? 'outbound' : 'inbound', body: b, at: ago(10000 - i * 100) }))
const OWNED = [['o', 'Hi, this is Nova, an AI assistant with Reivesti Home Buyers. Are you still the owner of the house on Teal Ct?'], ['i', 'yes']]
const attribution = (r) => r.reasons.filter((x) => /attribution|unsupported_claim/.test(x))

test('(a) a day-of-month date the seller gave grounds the same day; a different day never does', () => {
  const t = thread(...OWNED, ['o', 'Would you consider selling it at some point?'], ['i', "we're away till the 18th, text me after that"])
  const ok = "You mentioned you'd be back after the 18th, so I'm checking in as you asked. Are you still open to talking about the house?"
  assert.equal(attributionGroundedInSellerWords(ok, t), true)
  assert.deepEqual(attribution(v(ok, t)), [], String(v(ok, t).reasons))
  for (const [seller, text] of [
    ['back on the 1st', 'You mentioned you would be back on the 1st.'],
    ['out of town until the twenty-first', 'You mentioned you are out of town until the 21st.'],
    ['gone till the eighteenth', 'You mentioned you are gone till the 18th.'],
  ]) assert.equal(attributionGroundedInSellerWords(text, thread(['i', seller])), true, text)
  for (const text of [
    "You mentioned you'd be back after the 20th, so I'm checking in as you asked. Are you still open to talking about the house?",
    "You mentioned you'd be back after the 8th, so I'm checking in. Are you still open to talking about the house?",
  ]) {
    assert.equal(attributionGroundedInSellerWords(text, t), false, text)
    assert.ok(attribution(v(text, t)).length, text)
  }
  // our narration after the attribution is not attributed, but it cannot carry an invented claim into it either
  assert.equal(attributionGroundedInSellerWords("You mentioned you'd be back after the 18th and want to sell fast, so I'm checking in.", t), false)
})

test('(b) the seller\'s shorthand grounds its full words; a different period does not', () => {
  const t = thread(...OWNED, ['o', 'Any thoughts on timing?'], ['i', 'maybe next yr'])
  for (const text of ['You mentioned maybe next year.', 'You mentioned next year.']) {
    assert.equal(attributionGroundedInSellerWords(text, t), true, text)
    assert.deepEqual(attribution(v(`${text} Is that still the plan for the house?`, t)), [], `${text} ${v(`${text} Is that still the plan for the house?`, t).reasons}`)
  }
  for (const [seller, text] of [
    ['prob in a few wks', 'You mentioned probably in a few weeks.'],
    ['leaving tmrw for 2 mos', 'You mentioned you are leaving tomorrow for 2 months.'],
    ['not b4 the new yr', 'You mentioned not before the new year.'],
    ['nxt mnth we will know', 'You mentioned you will know next month.'],
    ['in it thru the winter', 'You mentioned you are in it through the winter.'],
  ]) assert.equal(attributionGroundedInSellerWords(text, thread(['i', seller])), true, text)
  for (const text of ['You mentioned next month.', 'You mentioned maybe next week.', 'You mentioned next year for sure.']) {
    assert.equal(attributionGroundedInSellerWords(text, t), false, text)
    assert.ok(attribution(v(`${text} Is that still the plan for the house?`, t)).length, text)
  }
})

test('(c) the seller\'s own hedge to our interest question, quoted verbatim, is accepted', () => {
  const t = thread(...OWNED, ['o', 'Any thoughts on selling down the road?'], ['i', 'maybe'])
  for (const text of ['You said maybe on selling. What would make it worth it for you?', 'You mentioned maybe. What would make selling worth it for you?']) {
    assert.deepEqual(attribution(v(text, t)), [], `${text} ${v(text, t).reasons}`)
  }
})

test('(c) limits: an upgrade of the hedge, a word the seller never used, or interest never expressed stays refused', () => {
  const t = thread(...OWNED, ['o', 'Any thoughts on selling down the road?'], ['i', 'maybe'])
  for (const text of [
    'You said you want to sell. What would make it worth it for you?',
    "You mentioned you're ready. What would make it worth it for you?",
    'You said yes on selling. What would make it worth it for you?',
    'You said probably on selling. What would make it worth it for you?',
  ]) assert.ok(attribution(v(text, t)).length, `${text} ${v(text, t).reasons}`)
  // a "maybe not" is not a "maybe"
  const not = thread(...OWNED, ['o', 'Any thoughts on selling down the road?'], ['i', 'maybe not'])
  assert.ok(attribution(v('You said maybe on selling. What would make it worth it for you?', not)).length)
  // interest never expressed: we never asked, or the seller never answered with it
  const never = thread(...OWNED, ['o', 'How is the house holding up?'], ['i', 'its fine'])
  assert.ok(attribution(v('You said maybe on selling. What would make it worth it for you?', never)).length)
  const otherAnswer = thread(...OWNED, ['o', 'Any thoughts on selling down the road?'], ['i', 'not really'], ['o', 'How is the house holding up?'], ['i', 'maybe needs a roof'])
  assert.ok(attribution(v('You said maybe on selling. What would make it worth it for you?', otherAnswer)).length)
})
