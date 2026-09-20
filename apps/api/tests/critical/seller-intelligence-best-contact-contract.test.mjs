import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import contract, {
  CALLABLE_COUNT_RULE,
  SUPPRESSION_INTERACTION,
  REJECTED_SELECTION_RULES,
  SINGLE_CANDIDATE_CONTROL,
  TARGET_POPULATION,
  WRITE_VERDICT,
} from '../../src/lib/domain/seller-intelligence/best-contact-contract.js';

const MODULE_PATH = new URL(
  '../../src/lib/domain/seller-intelligence/best-contact-contract.js',
  import.meta.url,
);

test('the verdict is WRITE_BLOCKED and zero rows were written', () => {
  assert.equal(WRITE_VERDICT.status, 'WRITE_BLOCKED');
  assert.equal(WRITE_VERDICT.rows_written, 0);
});

test('NO SELECTOR IS EXPORTED — a 93% rule must not be callable', () => {
  // Shipping a selector behind a confident name is how a wrong phone number
  // reaches a real person. The capability is absent, not merely discouraged.
  for (const [, value] of Object.entries(contract)) {
    assert.notEqual(typeof value, 'function', 'the module exports no functions');
  }
  const code = readFileSync(MODULE_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  assert.ok(!/export\s+function/.test(code), 'no exported function exists');
});

test('every rejected rule is recorded with its disqualifying score', () => {
  assert.equal(REJECTED_SELECTION_RULES.accepted, null);
  for (const [rule, score] of Object.entries(REJECTED_SELECTION_RULES)) {
    if (rule === 'accepted') continue;
    assert.ok(typeof score === 'number' && score < 1, `${rule} is not deterministic`);
  }
  // The best candidate is recorded honestly rather than rounded up to "close".
  assert.equal(REJECTED_SELECTION_RULES.wireless_first_then_slot_asc_filtered_pool, 0.931);
});

test('THE DISQUALIFYING CONTROL: wrong even where nothing is chosen', () => {
  const c = SINGLE_CANDIDATE_CONTROL;
  assert.equal(c.silent_wrong, 134);
  assert.equal(c.matched + c.silent_wrong, c.single_candidate_properties);
  assert.ok(c.silent_wrong > 0,
    'a single-candidate residual means the POOL is wrong, not the ordering');
});

test('what WAS pinned is recorded separately from what was not', () => {
  assert.ok(CALLABLE_COUNT_RULE.parity > 0.99);
  assert.deepEqual(CALLABLE_COUNT_RULE.excludes, ['do_not_call', 'is_encrypted']);
  assert.match(CALLABLE_COUNT_RULE.pool, /co_owner_individual_key/);
});

test('suppression is NOT applied during selection (§7)', () => {
  // Selection picks a phone and records callability; Campaign applies
  // suppression later. Moving it upstream would double-apply it.
  assert.equal(SUPPRESSION_INTERACTION.selection_filters_suppressed, false);
  assert.match(SUPPRESSION_INTERACTION.callability_recorded_in, /callable/);
  assert.match(SUPPRESSION_INTERACTION.campaign_suppression_applied_in, /campaign_eligible_v1/);
});

test('availability is not certification (§12)', () => {
  const t = TARGET_POPULATION;
  assert.equal(t.rows, 2962);
  assert.equal(t.no_usable_contact, 0, 'contacts exist for every target row');
  // ...and yet nothing is writable. That gap is the whole point.
  assert.equal(t.certified_deterministic_write_count, 0);
  assert.equal(t.exactly_one_callable_phone + t.multiple_callable_phones_ambiguous
    + t.all_phones_suppressed, t.rows);
});

test('the prior 3,104 derivability figure is not preserved as a write count', () => {
  assert.notEqual(TARGET_POPULATION.certified_deterministic_write_count, 3104);
  assert.notEqual(TARGET_POPULATION.certified_deterministic_write_count, 509);
});
