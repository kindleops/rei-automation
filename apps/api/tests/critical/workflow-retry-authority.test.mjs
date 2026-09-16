import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RETRIES,
  classifyDeliveryFailure,
  handleDeliveryFailure,
} from '../../src/lib/domain/workflow-v2/delivery-recovery.js';

/**
 * WORKFLOW-STUDIO-MOBILE-LOCK-1B §19 — retry, and the failures that must never
 * offer it.
 *
 * The mechanism was already built; nothing pinned it. The load-bearing property
 * is the asymmetry: a TRANSIENT failure earns a bounded, backed-off retry, and a
 * PERMANENT one — opt-out, DNC, wrong number, 21610 blacklist, suppression —
 * earns none at all. §19's requirement that "non-retryable safety blocks such
 * as DNC must NOT expose Retry" is a property of this classification, so it is
 * asserted here rather than in the UI that reads it.
 */

/** Records scheduled tasks so retry scheduling can be asserted exactly. */
function fakeScheduler() {
  const scheduled = [];
  return {
    scheduled,
    from(table) {
      const builder = {
        insert(row) {
          scheduled.push({ table, row });
          return {
            select: () => ({ single: () => Promise.resolve({ data: { id: 'task-1', ...row }, error: null }) }),
          };
        },
        select() { return builder; },
        eq() { return builder; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      };
      return builder;
    },
  };
}

// ───────────────────────────────────────── classification

/**
 * Every one of these is a compliance or identity outcome, not a hiccup.
 * Retrying any of them would re-attempt contact with someone who must not be
 * contacted. 21610 is the carrier blacklist rule.
 */
test('permanent failures are never retryable', () => {
  for (const failure of [
    'opt-out', 'opt_out', 'opted_out', 'dnc', 'wrong_number',
    'invalid', '21610', 'blacklist', 'suppression', 'seller_replied',
  ]) {
    const result = classifyDeliveryFailure({ failure_reason: failure });
    assert.equal(result.classification, 'permanent', `${failure} must be permanent`);
  }
});

test('the 21610 blacklist rule is permanent by code as well as by text', () => {
  assert.equal(classifyDeliveryFailure({ error_code: '21610' }).reason, 'blacklist_rule_21610');
  assert.equal(classifyDeliveryFailure({ error_code: '21610' }).classification, 'permanent');
});

/** A misconfiguration is our fault, not the seller's. Retrying it just repeats. */
test('configuration failures are distinguished from transient ones', () => {
  for (const failure of [
    'missing_to_phone', 'missing_from_phone', 'missing_message_body',
    'missing_thread_key', 'template_unavailable', 'sender_unavailable',
  ]) {
    assert.equal(classifyDeliveryFailure({ failure_reason: failure }).classification, 'configuration', failure);
  }
});

test('an unrecognised failure is transient, so it is retried rather than abandoned', () => {
  const result = classifyDeliveryFailure({ failure_reason: 'carrier timeout, try again' });
  assert.equal(result.classification, 'transient');
  assert.equal(result.reason, 'transient_delivery_failure');
});

// ───────────────────────────────────────── retry scheduling

const enrollment = { id: 'enr-1', workflow_definition_id: 'def-1' };

test('a transient failure schedules exactly one retry', async () => {
  const deps = fakeScheduler();
  const result = await handleDeliveryFailure({
    queueRow: { id: 'q-1', retry_count: 0 },
    enrollment,
    context: { failure_reason: 'carrier timeout' },
    deps: { supabase: deps },
  });
  assert.equal(result.ok, true);
  assert.equal(result.retry_scheduled, true);
  assert.equal(result.retry_count, 1);
  assert.equal(deps.scheduled.length, 1, 'exactly one task');
  assert.equal(deps.scheduled[0].row.task_type, 'delivery_retry');
});

/**
 * The dedupe key carries the retry COUNT, so replaying the same failure cannot
 * stack a second attempt at the same position — which is what idempotency means
 * for a retry.
 */
test('the retry is keyed by attempt, so the same failure cannot stack retries', async () => {
  const deps = fakeScheduler();
  await handleDeliveryFailure({
    queueRow: { id: 'q-1', retry_count: 0 },
    enrollment, context: { failure_reason: 'carrier timeout' }, deps: { supabase: deps },
  });
  const first = deps.scheduled[0].row.dedupe_key;

  const depsAgain = fakeScheduler();
  await handleDeliveryFailure({
    queueRow: { id: 'q-1', retry_count: 0 },
    enrollment, context: { failure_reason: 'carrier timeout' }, deps: { supabase: depsAgain },
  });
  assert.equal(depsAgain.scheduled[0].row.dedupe_key, first, 'same attempt, same key');

  const depsNext = fakeScheduler();
  await handleDeliveryFailure({
    queueRow: { id: 'q-1', retry_count: 1 },
    enrollment, context: { failure_reason: 'carrier timeout' }, deps: { supabase: depsNext },
  });
  assert.notEqual(depsNext.scheduled[0].row.dedupe_key, first, 'a later attempt is a different key');
});

test('retry backoff lengthens rather than hammering', async () => {
  const delays = [];
  for (const retryCount of [0, 1, 2]) {
    const deps = fakeScheduler();
    await handleDeliveryFailure({
      queueRow: { id: 'q-1', retry_count: retryCount },
      enrollment, context: { failure_reason: 'carrier timeout' }, deps: { supabase: deps },
    });
    delays.push(new Date(deps.scheduled[0].row.scheduled_for).getTime() - Date.now());
  }
  assert.ok(delays[0] < delays[1], `expected backoff, got ${delays.map((d) => Math.round(d / 60000))}`);
  assert.ok(delays[1] < delays[2], `expected backoff, got ${delays.map((d) => Math.round(d / 60000))}`);
  // 15 / 60 / 240 minutes.
  assert.ok(Math.round(delays[0] / 60000) >= 14 && Math.round(delays[0] / 60000) <= 15);
  assert.ok(Math.round(delays[2] / 60000) >= 239 && Math.round(delays[2] / 60000) <= 240);
});

test('retries are bounded and the exhaustion is stated', async () => {
  const deps = fakeScheduler();
  const result = await handleDeliveryFailure({
    queueRow: { id: 'q-1', retry_count: MAX_RETRIES },
    enrollment, context: { failure_reason: 'carrier timeout' }, deps: { supabase: deps },
  });
  assert.equal(result.retry_scheduled, false);
  assert.equal(result.exhausted, true);
  assert.equal(deps.scheduled.length, 0, 'nothing may be scheduled past the cap');
});

// ───────────────────────────────────────── the safety asymmetry

/**
 * §19's core requirement. A DNC-class failure must schedule NOTHING — not a
 * delayed retry, not a task, nothing an operator could later mistake for a
 * retryable state.
 */
test('a DNC-class failure schedules nothing at all', async () => {
  for (const failure of ['opt_out', 'dnc', 'wrong_number', 'suppression', '21610']) {
    const deps = fakeScheduler();
    const result = await handleDeliveryFailure({
      queueRow: { id: 'q-1', retry_count: 0 },
      enrollment, context: { failure_reason: failure }, deps: { supabase: deps },
    });
    assert.equal(result.retry_scheduled, false, failure);
    assert.equal(result.permanent, true, failure);
    assert.deepEqual(deps.scheduled, [], `${failure} must schedule nothing`);
  }
});

test('a configuration failure schedules nothing and does not consume a retry', async () => {
  const deps = fakeScheduler();
  const result = await handleDeliveryFailure({
    queueRow: { id: 'q-1', retry_count: 0 },
    enrollment, context: { failure_reason: 'template_unavailable' }, deps: { supabase: deps },
  });
  assert.equal(result.retry_scheduled, false);
  assert.equal(result.configuration_failure, true);
  assert.equal(result.retries_consumed, false, 'our misconfiguration must not burn the seller’s retries');
  assert.deepEqual(deps.scheduled, []);
});

test('every failure path reports that no send happened', async () => {
  for (const failure of ['carrier timeout', 'opt_out', 'template_unavailable']) {
    const deps = fakeScheduler();
    const result = await handleDeliveryFailure({
      queueRow: { id: 'q-1', retry_count: 0 },
      enrollment, context: { failure_reason: failure }, deps: { supabase: deps },
    });
    assert.equal(result.live_send_blocked, true, failure);
  }
});
