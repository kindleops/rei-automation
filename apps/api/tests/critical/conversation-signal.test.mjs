/**
 * CONVERSATION SIGNAL — pure, deterministic seller-motivation read.
 * Every vector is synthetic; the calibration against production threads is
 * recorded in the module header, not asserted here (no network in tests).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeConversation, extractPrices, resolveTimezone } from '../../src/lib/domain/deal-intelligence/conversation-signal.js'
import { getConversationSignal, isTestMessageRow } from '../../src/lib/domain/deal-intelligence/conversation-signal-service.js'

const T0 = Date.parse('2026-09-01T15:00:00Z') // Tue 10:00 CDT
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const out = (ms, body, extra = {}) => ({ direction: 'outbound', message_body: body, created_at: new Date(ms).toISOString(), delivery_status: 'delivered', ...extra })
const inn = (ms, body, extra = {}) => ({ direction: 'inbound', message_body: body, created_at: new Date(ms).toISOString(), ...extra })
const factor = (s, key) => s.factors.find((f) => f.key === key)

test('no reply: band no_reply, score null, nothing invented', () => {
  const s = analyzeConversation([out(T0, 'Hi, do you still own 1 Main St?'), out(T0 + 2 * DAY, 'Following up')], { now: T0 + 5 * DAY })
  assert.equal(s.band, 'no_reply')
  assert.equal(s.score, null)
  assert.equal(s.counts.inbound, 0)
  assert.equal(s.counts.outbound, 2)
  assert.equal(s.responsiveness.replyRate, 0)
  assert.deepEqual(s.factors.map((f) => f.key), ['no_reply'])
  assert.equal(analyzeConversation([], { now: T0 }).band, 'no_reply')
})

test('fast, engaged seller with distress language reads hot with quoted evidence', () => {
  const msgs = [
    out(T0, 'Hi Dana, do you still own 12 Oak Ln?'),
    inn(T0 + 4 * MIN, 'Yes I own it. Honestly we are behind on payments and I need to sell asap.'),
    out(T0 + 10 * MIN, 'Sorry to hear that. What condition is it in?'),
    inn(T0 + 13 * MIN, 'It is 3 bed 2 bath, the roof leaks and the tenant stopped paying rent so we are trying to evict'),
    out(T0 + 20 * MIN, 'Understood. Do you have a number in mind?'),
    inn(T0 + 22 * MIN, 'I owe about $180k, I would take $210,000 if you can close in 2 weeks. What would you pay?'),
    out(T0 + 30 * MIN, 'I can be around $195k.'),
    inn(T0 + 33 * MIN, 'Ok send me the contract, my email is dana@example.com'),
  ]
  const s = analyzeConversation(msgs, { now: T0 + HOUR, timezone: 'Central' })
  assert.equal(s.band, 'hot')
  assert.ok(s.score >= 75)
  assert.equal(s.confidence, 'medium')
  assert.equal(s.responsiveness.medianReplyMinutes, 3)
  assert.equal(s.responsiveness.replyRate, 1)
  assert.equal(s.responsiveness.awaitingUs, true)
  const fin = factor(s, 'distress_financial')
  assert.ok(fin && fin.points > 0)
  assert.match(fin.evidence.quote, /behind on payments/)
  assert.ok(factor(s, 'distress_property_burden'))
  assert.ok(factor(s, 'urgency'))
  assert.ok(factor(s, 'asks_offer'))
  assert.ok(factor(s, 'commitment'))
  // ONE money path (RC 7.2 B): "I owe about $180k" is a mortgage payoff, not a
  // price; only the $210,000 the seller would take is a named price.
  assert.deepEqual(s.language.priceMentions, [210000])
  assert.equal(s.language.distress.financial, 1)
  // Every point is attributable: non-cap factor points sum to the raw score.
  assert.equal(s.factors.filter((f) => f.cap === undefined).reduce((a, f) => a + f.points, 0), s.rawScore)
})

test('hostile opt-out caps to opted_out regardless of earlier engagement', () => {
  const msgs = [
    out(T0, 'Do you still own 5 Elm?'),
    inn(T0 + 2 * MIN, 'Yes, what are you offering?'),
    out(T0 + 5 * MIN, 'Around $90k'),
    inn(T0 + 6 * MIN, 'Stop texting me you scammer'),
  ]
  const s = analyzeConversation(msgs, { now: T0 + HOUR })
  assert.equal(s.band, 'opted_out')
  assert.ok(s.score <= 5)
  const cap = factor(s, 'opt_out')
  assert.equal(cap.cap, 5)
  assert.match(cap.evidence.quote, /Stop texting/)
  assert.equal(s.language.hostility, 1)
  // A transport STOP flag with no text also opts out; START afterwards supersedes.
  const t = analyzeConversation([out(T0, 'hi'), inn(T0 + MIN, 'STOP', { is_opt_out: true }), inn(T0 + 2 * DAY, 'START'), inn(T0 + 2 * DAY + MIN, 'Yes I would consider an offer')], { now: T0 + 3 * DAY })
  assert.notEqual(t.band, 'opted_out')
  // Classifier-only opt_out still caps (conservative) and says so.
  const c = analyzeConversation([out(T0, 'hi'), inn(T0 + MIN, 'Tengo una para vender', { detected_intent: 'opt_out' })], { now: T0 + DAY })
  assert.equal(c.band, 'opted_out')
  assert.match(factor(c, 'opt_out').value, /classifier/)
})

test('profanity WITH hostility is negative; profanity WITHOUT hostility is an intensity signal', () => {
  const hostile = analyzeConversation([out(T0, 'Do you own 9 Pine?'), inn(T0 + MIN, 'Fuck off')], { now: T0 + HOUR })
  assert.equal(hostile.band, 'hostile')
  assert.ok(factor(hostile, 'profanity_hostile').points < 0)
  assert.ok(factor(hostile, 'hostility').points < 0)
  assert.equal(factor(hostile, 'profanity_intensity'), undefined)

  const intense = analyzeConversation([out(T0, 'Do you own 9 Pine?'), inn(T0 + MIN, 'Yes and this damn house is falling apart, I need to sell it')], { now: T0 + HOUR })
  assert.notEqual(intense.band, 'hostile')
  assert.equal(intense.language.profanity, 1)
  assert.equal(intense.language.hostility, 0)
  assert.equal(factor(intense, 'profanity_intensity').points, 2)
  assert.equal(factor(intense, 'profanity_hostile'), undefined)
  assert.ok(factor(intense, 'urgency'))
})

test('cooling: replies slow down and the seller goes silent while we wait', () => {
  const msgs = []
  let t = T0
  const lat = [2, 3, 2, 4, 600, 900, 1200, 1500] // minutes
  for (const [i, m] of lat.entries()) {
    msgs.push(out(t, `question ${i}`))
    msgs.push(inn(t + m * MIN, `answer number ${i} about the house`))
    t += m * MIN + 2 * DAY
  }
  msgs.push(out(t, 'checking in'))
  const s = analyzeConversation(msgs, { now: t + 20 * DAY })
  assert.equal(s.responsiveness.trend, 'cooling')
  assert.equal(s.responsiveness.awaitingUs, false)
  assert.ok(factor(s, 'trend').points < 0)
  assert.equal(factor(s, 'silence').points, -10)
})

test('Spanish: urgency and burden read positive; "no me interesa" reads as a refusal', () => {
  const es = analyzeConversation([out(T0, '¿Es usted el dueño?'), inn(T0 + 5 * MIN, 'Sí, necesito vender urgente, la casa está desocupada. ¿Cuánto me ofrece?')], { now: T0 + HOUR })
  assert.equal(es.language.urgency, 1)
  assert.equal(es.language.distress.property_burden, 1)
  assert.ok(factor(es, 'asks_offer'))
  assert.ok(es.score >= 40)
  const no = analyzeConversation([out(T0, '¿Es usted el dueño?'), inn(T0 + 5 * MIN, 'Sí soy el dueño pero no me interesa vender')], { now: T0 + HOUR })
  assert.equal(factor(no, 'refusal').points, -20)
  assert.equal(no.band, 'cold')
  assert.equal(factor(no, 'last_word_refusal').cap, 19)
  assert.equal(no.language.positive, 0)
  const vete = analyzeConversation([out(T0, 'Hola'), inn(T0 + MIN, '¡Vete a la mierda, cabrón!')], { now: T0 + HOUR })
  assert.equal(vete.band, 'hostile')
})

test('timing buckets are in the seller timezone; UTC fallback is labelled', () => {
  // 03:30Z = 22:30 CDT (previous day, late night) · 15:00Z = 10:00 CDT Tue (workday)
  const msgs = [out(T0 - HOUR, 'hi'), inn(Date.parse('2026-09-02T03:30:00Z'), 'yes I own it still'), inn(T0, 'what is your offer'), inn(Date.parse('2026-09-05T13:00:00Z'), 'hello again, any update')]
  const s = analyzeConversation(msgs, { now: T0 + 7 * DAY, timezone: 'Central' })
  assert.equal(s.timing.timezone, 'America/Chicago')
  assert.equal(s.timing.timezoneSource, 'seller')
  assert.equal(s.timing.hourBuckets[22], 1)
  assert.equal(s.timing.hourBuckets[10], 1)
  assert.equal(s.timing.hourBuckets[8], 1) // Sat 08:00 CDT
  assert.equal(s.timing.hourBuckets.reduce((a, b) => a + b, 0), 3)
  assert.equal(s.timing.share.lateNight, 0.33)
  assert.equal(s.timing.share.workday, 0.33)
  assert.equal(s.timing.share.morning, 0.33)
  assert.equal(s.timing.weekendShare, 0.33)
  const u = analyzeConversation(msgs, { now: T0 + 7 * DAY })
  assert.equal(u.timing.timezone, 'UTC')
  assert.equal(u.timing.timezoneSource, 'utc_fallback')
  assert.equal(u.timing.hourBuckets[3], 1)
  assert.equal(resolveTimezone('Pacific'), 'America/Los_Angeles')
  assert.equal(resolveTimezone('Not/AZone'), null)
})

test('exclusions: test rows, failed sends, tapbacks, auto-responders, repeated texts', () => {
  const msgs = [
    out(T0, 'Do you own 1 Main?'),
    out(T0 + 30 * 1000, 'Do you own 1 Main?'), // double-logged
    out(T0 + MIN, 'failed one', { delivery_status: 'failed' }),
    inn(T0 + 2 * MIN, 'Yes I still own it [internal live proof abc]'),
    inn(T0 + 3 * MIN, 'probe', { isTest: true }),
    inn(T0 + 4 * MIN, '​👍​ to “ Hello, are you still the owner of 1 Main St? I need to sell asap ”'),
    inn(T0 + 5 * MIN, 'Sorry we missed your call! If this is urgent text us back'),
    inn(T0 + 6 * MIN, 'Yes I own it'),
    inn(T0 + 7 * MIN, 'Yes I own it'),
    inn(T0 + 8 * MIN, 'Yes I own it'),
  ]
  const s = analyzeConversation(msgs, { now: T0 + HOUR })
  assert.equal(s.counts.outbound, 1)
  assert.equal(s.counts.inbound, 5)
  assert.equal(s.counts.reactions, 1)
  assert.equal(s.counts.autoReplies, 1)
  assert.equal(s.counts.distinctInbound, 1)
  assert.equal(s.counts.repeatedInbound, 2)
  assert.equal(s.language.urgency, 0) // the tapback quotes OUR text; the auto-responder says "urgent"
  assert.equal(factor(s, 'volume'), undefined) // 1 distinct message → 0 points
  assert.equal(factor(s, 'affirmative').points, 3) // counted once
})

test('refusal recency: an earlier "not selling" followed by real engagement is only lightly penalised', () => {
  const s = analyzeConversation([
    out(T0, 'Do you own 3 Birch?'),
    inn(T0 + MIN, 'Not selling though'),
    inn(T0 + 4 * DAY, 'Hello. Are you still interested in buying?'),
    out(T0 + 4 * DAY + HOUR, 'Yes! What would you want for it?'),
    inn(T0 + 4 * DAY + 2 * HOUR, 'For the duplex alone 130,000. It is newly renovated, 2 units rented.'),
  ], { now: T0 + 5 * DAY })
  assert.equal(factor(s, 'refusal').points, -6)
  assert.ok(factor(s, 'reengaged'))
  assert.deepEqual(s.language.priceMentions, [130000])
  assert.ok(['warm', 'hot', 'engaged'].includes(s.band))
})

test('wrong number and not-the-owner cap to cold', () => {
  const w = analyzeConversation([out(T0, 'Hi Debra'), inn(T0 + MIN, 'Wrong number, this is not Debra')], { now: T0 + HOUR })
  assert.equal(w.band, 'cold')
  assert.ok(w.score <= 10)
  const sold = analyzeConversation([out(T0, 'Do you own 4 Ash?'), inn(T0 + MIN, 'It was...sold a few weeks ago')], { now: T0 + HOUR })
  assert.equal(sold.band, 'cold')
  assert.ok(factor(sold, 'not_owner'))
})

test('extractPrices: $, k, grouped thousands, Spanish dot grouping; ignores addresses and rents', () => {
  assert.deepEqual(extractPrices('I do. 430k cash offer'), [430000])
  assert.deepEqual(extractPrices('Like $380K to $390K'), [380000, 390000])
  assert.deepEqual(extractPrices('Si,la vendo por $235.000 cash'), [235000])
  assert.deepEqual(extractPrices('Si me das 120 k la vendo'), [120000])
  assert.deepEqual(extractPrices('6245 Mozart is paid for'), [])
  assert.deepEqual(extractPrices('$2000 1000 each side'), [])
  assert.deepEqual(extractPrices('I need a million cash'), [1000000])
})

test('service: flags test rows and returns null for unknown threads (fake client, no network)', async () => {
  assert.equal(isTestMessageRow({ meta_proof: 'true' }), true)
  assert.equal(isTestMessageRow({ meta_source: 'stage1_internal_canary' }), true)
  assert.equal(isTestMessageRow({ from_phone_number: '+15550000001' }), true)
  assert.equal(isTestMessageRow({ meta_source: 'textgrid_inbound_webhook', from_phone_number: '+12039942149' }), false)

  const calls = []
  const chain = (table, rows) => {
    const q = { select: () => q, or: (f) => { calls.push([table, 'or', f]); return q }, eq: () => q, not: () => q, order: () => q, limit: () => Promise.resolve({ data: rows, error: null }) }
    return q
  }
  const rows = [
    inn(T0 + 2 * MIN, 'Yes, what would you pay?', { meta_source: 'textgrid_inbound_webhook' }),
    out(T0, 'Do you own it?', { meta_source: 'supabase_send_queue' }),
    inn(T0 + 3 * MIN, 'Yes I still own it [internal live proof x]', { meta_proof: 'true' }),
  ]
  const fake = { from: (t) => chain(t, t === 'phones' ? [{ timezone: 'Eastern' }] : rows) }
  const s = await getConversationSignal({ threadKey: '+12035551234', now: T0 + HOUR }, { supabase: fake })
  assert.equal(s.threadKey, '+12035551234')
  assert.equal(s.excludedTestRows, 1)
  assert.equal(s.counts.inbound, 1)
  assert.equal(s.timing.timezone, 'America/New_York')
  assert.match(calls[0][2], /thread_key\.eq\.\+12035551234,from_phone_number\.eq\./)

  const empty = { from: (t) => chain(t, []) }
  assert.equal(await getConversationSignal({ threadKey: '+12030000000' }, { supabase: empty }), null)
  assert.equal(await getConversationSignal({ threadKey: '' }, { supabase: empty }), null)
})
