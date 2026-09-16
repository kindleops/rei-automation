import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FACT_KEYS,
  extractConversationFacts,
} from '../../src/lib/domain/workflow-v2/conversation-intelligence.js';
import { S1_URGENCY_DELAYS_DAYS } from '../../src/lib/domain/acquisition/s1-cadence.js';
import { adjustFollowUpTiming } from '../../src/lib/domain/workflow-v2/follow-up-service.js';

/**
 * WORKFLOW-STUDIO-MOBILE-LOCK-1B §13/§14 — the workflow engine consumes
 * canonical outcomes and does not become a second authority.
 *
 * THE DEFECT §14 NAMES. `conversation-intelligence.js` was a parallel
 * seller-language interpretation engine: eleven regex families, twelve
 * hand-picked confidence constants, deriving ownership / interest / price /
 * motivation / condition / timeline / contact preference / language / objection
 * straight from message text. It also called the canonical classifier, but only
 * to ADD an intent fact — the regex findings were returned regardless.
 *
 * Four published workflows carry `action.run_conversation_extraction`,
 * including Asking Price Extraction, so it sat on the money axis.
 */

const enrollmentWith = (context) => ({ id: 'e1', subject_type: 'opportunity', subject_id: 't1', context });

// ───────────────────────────────── no interpretation of seller language

/**
 * The exact strings that used to produce findings. Each is now silent, because
 * reading them is the classifier's job.
 */
test('seller message text produces no facts at all', () => {
  const messages = [
    'I am not the owner, wrong person',
    'I own this, it is my property',
    'not interested, stop texting',
    'maybe, depends on the price',
    'I want to sell',
    'I will never sell',
    'behind on payments, foreclosure next month',
    'needs work, the roof is shot',
    'asap, within 30 days',
    'call me on my phone',
    'hablo espanol / spanish please',
    'that is too low, not enough',
    'I want $250,000 for it',
  ];
  for (const body of messages) {
    const result = extractConversationFacts({
      message: { id: 'm1', body },
      enrollment: enrollmentWith({}),
    });
    assert.deepEqual(result.facts, [], `message text must not produce a fact: ${body}`);
    assert.equal(result.message_text_interpreted, false);
  }
});

/** An empty result must be diagnosable, not look like an uninteresting seller. */
test('producing nothing states why', () => {
  const result = extractConversationFacts({ message: { body: 'anything' }, enrollment: enrollmentWith({}) });
  assert.equal(result.reason, 'no_canonical_classification_on_context');
  assert.equal(result.source, 'canonical');
});

/**
 * "stop texting" is an OPT-OUT. It used to grade as seller_interest_level
 * not_interested at 0.9 — treating a compliance signal as mere disinterest,
 * which under-reacts. Suppression is decided at the send boundary; it is not an
 * interest level, so opt_out implies no interest fact at all.
 */
test('opt_out does not become an interest level', () => {
  const result = extractConversationFacts({
    message: { id: 'm1', body: 'stop texting' },
    enrollment: enrollmentWith({ classification: { primary_intent: 'opt_out', confidence: 0.99 } }),
  });
  const keys = result.facts.map((f) => f.fact_key);
  assert.ok(keys.includes('classification_intent'));
  assert.ok(!keys.includes('seller_interest_level'), 'opt_out is not a level of interest');
});

// ───────────────────────────────── canonical outcomes are consumed

test('a canonical intent is restated with the classifier own confidence', () => {
  const result = extractConversationFacts({
    message: { id: 'm1', body: 'irrelevant' },
    enrollment: enrollmentWith({ classification: { primary_intent: 'seller_interested', confidence: 0.91 } }),
  });
  const intent = result.facts.find((f) => f.fact_key === 'classification_intent');
  assert.equal(intent.fact_value.value, 'seller_interested');
  assert.equal(intent.confidence, 0.91, 'the canonical confidence, not a constant of ours');
  assert.equal(intent.provenance, 'canonical_classification');

  const interest = result.facts.find((f) => f.fact_key === 'seller_interest_level');
  assert.equal(interest.fact_value.value, 'interested');
  assert.equal(interest.confidence, 0.91);
  assert.equal(interest.provenance, 'canonical_intent_mapping');
});

test('a non-canonical intent string is normalised rather than trusted verbatim', () => {
  const result = extractConversationFacts({
    message: {},
    enrollment: enrollmentWith({ classification: { primary_intent: 'Wrong Person!', confidence: 0.8 } }),
  });
  const intent = result.facts.find((f) => f.fact_key === 'classification_intent');
  assert.equal(intent.fact_value.value, 'wrong_number', 'folded through the canonical alias map');
  const ownership = result.facts.find((f) => f.fact_key === 'ownership_status');
  assert.equal(ownership.fact_value.value, 'not_owner');
});

test('an unclear intent is nothing stated, not a finding', () => {
  for (const primary_intent of ['unclear', '', null, undefined]) {
    const result = extractConversationFacts({
      message: {}, enrollment: enrollmentWith({ classification: { primary_intent } }),
    });
    assert.deepEqual(result.facts.map((f) => f.fact_key), [], String(primary_intent));
  }
});

test('intents that imply nothing about interest say nothing about interest', () => {
  for (const primary_intent of ['who_is_this', 'acknowledgement', 'reaction_only', 'info_request']) {
    const result = extractConversationFacts({
      message: {}, enrollment: enrollmentWith({ classification: { primary_intent, confidence: 0.7 } }),
    });
    const keys = result.facts.map((f) => f.fact_key);
    assert.ok(!keys.includes('seller_interest_level'), primary_intent);
  }
});

test('canonical context facts are copied, with their own confidence', () => {
  const result = extractConversationFacts({
    message: { id: 'm1' },
    enrollment: enrollmentWith({
      extracted_facts: {
        asking_price: { value: 250000, confidence: 0.88 },
        property_condition: 'needs_repairs',
      },
      underwriting_facts: { timeline_to_sell: 'short' },
    }),
  });
  const price = result.facts.find((f) => f.fact_key === 'asking_price');
  assert.equal(price.fact_value.value, 250000);
  assert.equal(price.confidence, 0.88, 'the confidence the canonical extractor stated');
  assert.equal(price.provenance, 'enrollment_context');
  assert.ok(result.facts.some((f) => f.fact_key === 'property_condition'));
  assert.ok(result.facts.some((f) => f.fact_key === 'timeline_to_sell'));
});

/**
 * Language used to be inferred from a greeting AND emitted as 'es', which is not
 * the canonical language vocabulary ('Spanish') — it would have poisoned
 * template language selection, the exact axis repaired in
 * CAMPAIGN-TEMPLATE-LANGUAGE-BRIDGE-1.
 */
test('language is read from canonical state, never inferred from a greeting', () => {
  const inferred = extractConversationFacts({
    message: { body: 'hablo espanol' }, enrollment: enrollmentWith({}),
  });
  assert.ok(!inferred.facts.some((f) => f.fact_key === 'language'), 'no language from text');

  const canonical = extractConversationFacts({
    message: {}, enrollment: enrollmentWith({ resolved_language: 'Spanish' }),
  });
  const language = canonical.facts.find((f) => f.fact_key === 'language');
  assert.equal(language.fact_value.value, 'Spanish', 'the canonical vocabulary, not an ISO guess');
  assert.equal(language.provenance, 'canonical_language');
});

test('every emitted fact key is a declared fact key', () => {
  const result = extractConversationFacts({
    message: { id: 'm1' },
    enrollment: enrollmentWith({
      classification: { primary_intent: 'ownership_confirmed', confidence: 0.9 },
      extracted_facts: { asking_price: 200000, seller_motivation: 'relocation' },
      resolved_language: 'English',
    }),
  });
  assert.ok(result.facts.length >= 4);
  for (const fact of result.facts) {
    assert.ok(FACT_KEYS.includes(fact.fact_key), `undeclared fact key: ${fact.fact_key}`);
  }
});

// ───────────────────────────────── §13 cadence authority

/**
 * §13. The workflow's ownership cadence [7, 14, 21] mirrors the canonical S1
 * urgency table, and the ownership branch delegates to shouldScheduleS1FollowUp
 * rather than using its local numbers — so S1 has one authority. Nothing
 * structural keeps the two tables in step, which is what this pins.
 */
test('the canonical S1 urgency ladder is unchanged', () => {
  assert.deepEqual(
    [S1_URGENCY_DELAYS_DAYS.high, S1_URGENCY_DELAYS_DAYS.medium, S1_URGENCY_DELAYS_DAYS.low],
    [7, 14, 21],
    'reconcile workflow-v2/follow-up-service.js BASELINE_CADENCES_DAYS.ownership',
  );
  assert.equal(S1_URGENCY_DELAYS_DAYS.unknown, 21, 'unknown urgency must not take the aggressive branch');
});

/**
 * S1 is exempt from the compression multiplier by an explicit branch
 * (`category === 'ownership' ? baseDays : adjustFollowUpTiming(...)`). The
 * multiplier still applies to the other five categories, compounding to ~0.51
 * with a one-day floor. Reported, not changed — the floor is what stops it
 * reaching zero, so the floor is what gets pinned.
 */
test('follow-up compression has a one-day floor and never lengthens', () => {
  const fastest = { motivation_score: 100, seller_cooperation_score: 100, avg_response_time_hours: 1 };
  for (const baseDays of [1, 2, 3, 5, 7, 14, 30, 60, 90]) {
    const adjusted = adjustFollowUpTiming(baseDays, fastest);
    assert.ok(adjusted >= 1, `${baseDays} -> ${adjusted}`);
    assert.ok(adjusted <= baseDays, `${baseDays} -> ${adjusted} must not lengthen`);
  }
  // Documented so a change to the multipliers shows up here, not in an inbox.
  assert.equal(adjustFollowUpTiming(30, fastest), 15);
  assert.equal(adjustFollowUpTiming(1, fastest), 1);
});

test('an unmotivated seller is followed up less often, not more', () => {
  const slowest = { motivation_score: 10, seller_cooperation_score: 10, avg_response_time_hours: 96 };
  assert.ok(adjustFollowUpTiming(7, slowest) >= 7);
});

test('absent behavioural signals leave the cadence exactly as planned', () => {
  for (const baseDays of [1, 7, 30]) {
    assert.equal(adjustFollowUpTiming(baseDays, {}), baseDays);
  }
});
