import test from 'node:test'
import assert from 'node:assert/strict'
import { polishDraftDeterministic as p } from '@/lib/domain/inbox/draft-polish.js'

test('dictation reads like a professional text', () => {
  assert.equal(p('hi john um this is ryan i was wondering if youd be open to an offer on the property'),
    "Hi John this is Ryan I was wondering if you'd be open to an offer on the property.")
  assert.equal(p('would you be open to selling it question mark'), 'Would you be open to selling it?')
  assert.equal(p('thanks comma i will call you tomorrow'), 'Thanks, I will call you tomorrow.')
  assert.equal(p('im around monday   if you want to talk'), "I'm around Monday if you want to talk.")
  assert.equal(p('the the price is 145,000 dont worry'), "The price is 145,000 don't worry.")
})

test('never changes numbers, keeps finished punctuation, idempotent', () => {
  const once = p('We can close in 21 days at $182,500.')
  assert.equal(once, 'We can close in 21 days at $182,500.')
  assert.equal(p(once), once)
  assert.equal(p('grace period on the loan'), 'Grace period on the loan.')
  assert.equal(p(''), '')
})

test('greeting names capitalised, fillers after greeting left alone', () => {
  assert.equal(p('hey there just checking in'), 'Hey there just checking in.')
  assert.equal(p('good morning maria it is ryan'), 'Good morning Maria it is ryan.')
})

test('each line ends properly', () => {
  assert.equal(p('sounds good\nwhen works for you'), 'Sounds good.\nWhen works for you?')
})
