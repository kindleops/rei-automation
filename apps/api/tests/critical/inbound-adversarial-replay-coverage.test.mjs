// ─── inbound-adversarial-replay-coverage.test.mjs ────────────────────────────
// Launch coverage AND semantic-accuracy invariants over the adversarial
// corpus, replayed through the LIVE decision engine (no sends, no writes):
//   * 100% of cases reach a canonical terminal disposition;
//   * 0 engine exceptions;
//   * every case's classified primary_intent is in expected.intent_any_of;
//   * every case's terminal disposition is in expected.disposition_any_of;
//   * 0 would-reply decisions after a confirmed opt-out;
//   * 0 would-reply decisions to wrong numbers;
//   * the canonical re-engagement pair supersedes stale not-interested state;
//   * positive-after-binding-opt-out routes to a human, never auto-resumes.
//
// Terminal coverage is NOT semantic coverage: reaching *some* disposition
// proves nothing about correctness, so the run computes and prints six
// distinct metrics — terminal-disposition coverage, expected-intent accuracy,
// expected-disposition accuracy, re-engagement accuracy, suppression safety,
// and state-transition accuracy — and FAILS unless every one is 100%.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ADVERSARIAL_INBOUND_CASES,
  CORPUS_VERSION,
} from "../fixtures/inbound-adversarial-corpus.mjs";
import { replayInboundCase } from "@/lib/domain/inbound/inbound-replay-engine.js";
import { TERMINAL_DISPOSITION_SET } from "@/lib/domain/inbound/terminal-disposition.js";
import { classify } from "@/lib/domain/classification/classify.js";

function metric() {
  return { pass: 0, total: 0, failures: [] };
}

function record(m, ok, failure_message) {
  m.total += 1;
  if (ok) m.pass += 1;
  else m.failures.push(failure_message);
}

function pct(m) {
  if (m.total === 0) return "n/a";
  return `${m.pass}/${m.total} (${((100 * m.pass) / m.total).toFixed(1)}%)`;
}

test(`adversarial corpus (${CORPUS_VERSION}): terminal coverage + semantic accuracy metrics`, async () => {
  assert.ok(ADVERSARIAL_INBOUND_CASES.length >= 60, "corpus must stay >= 60 cases");

  const metrics = {
    terminal_disposition_coverage: metric(),
    expected_intent_accuracy: metric(),
    expected_disposition_accuracy: metric(),
    re_engagement_accuracy: metric(),
    suppression_safety: metric(),
    state_transition_accuracy: metric(),
  };
  let engine_exceptions = 0;
  const exception_failures = [];

  for (const test_case of ADVERSARIAL_INBOUND_CASES) {
    const expected = test_case.expected || {};
    const result = await replayInboundCase(test_case);

    if (result.ok === false) {
      engine_exceptions += 1;
      exception_failures.push(
        `${test_case.case_id}: engine exception ${result.detail?.engine_exception}`
      );
      continue;
    }

    // ── 1. Terminal-disposition coverage (canonical terminal state reached).
    record(
      metrics.terminal_disposition_coverage,
      TERMINAL_DISPOSITION_SET.has(result.disposition),
      `${test_case.case_id}: non-canonical disposition ${result.disposition}`
    );

    // ── 2. Expected-intent accuracy. Duplicate-webhook and empty-body cases
    // short-circuit the replay before classification, so the intent
    // expectation is asserted against the live classifier directly for EVERY
    // case (deterministic heuristics only — same path the replay engine uses).
    const classification =
      result.classification ??
      (await classify(test_case.message_body, null, { heuristicOnly: true }));
    record(
      metrics.expected_intent_accuracy,
      Array.isArray(expected.intent_any_of) &&
        expected.intent_any_of.includes(classification.primary_intent),
      `${test_case.case_id}: primary_intent ${classification.primary_intent} not in expected [${(expected.intent_any_of || []).join(", ")}]`
    );

    // ── 3. Expected-disposition accuracy.
    record(
      metrics.expected_disposition_accuracy,
      Array.isArray(expected.disposition_any_of) &&
        expected.disposition_any_of.includes(result.disposition),
      `${test_case.case_id}: disposition ${result.disposition} not in expected [${(expected.disposition_any_of || []).join(", ")}]`
    );

    // ── 4. Re-engagement accuracy (only cases that declare the expectation).
    if (expected.re_engagement_expected === true) {
      record(
        metrics.re_engagement_accuracy,
        result.precedence?.re_engagement_detected === true,
        `${test_case.case_id}: re-engagement not detected`
      );
    }

    // ── 5. Suppression safety (must_not_auto_reply never queues a reply).
    if (expected.must_not_auto_reply === true) {
      record(
        metrics.suppression_safety,
        result.detail?.should_queue_reply !== true,
        `${test_case.case_id}: auto-reply decision despite must_not_auto_reply`
      );
    }

    // ── 6. State-transition accuracy (supersedes_prior_state both ways).
    const superseded = result.precedence?.supersedes_prior_state === true;
    record(
      metrics.state_transition_accuracy,
      superseded === (expected.supersedes_prior_state === true),
      superseded
        ? `${test_case.case_id}: superseded state that must stand`
        : `${test_case.case_id}: stale state not superseded`
    );
  }

  const lines = Object.entries(metrics).map(([name, m]) => `  ${name}: ${pct(m)}`);
  console.log(`[adversarial-corpus metrics] ${CORPUS_VERSION} (${ADVERSARIAL_INBOUND_CASES.length} cases)\n${lines.join("\n")}`);

  const failures = [
    ...exception_failures,
    ...Object.values(metrics).flatMap((m) => m.failures),
  ];

  assert.equal(engine_exceptions, 0, `engine exceptions:\n${exception_failures.join("\n")}`);
  assert.deepEqual(failures, [], `coverage/accuracy violations:\n${failures.join("\n")}`);
  // Semantic coverage is only claimable when the semantic metrics are perfect.
  assert.equal(metrics.expected_intent_accuracy.pass, metrics.expected_intent_accuracy.total);
  assert.equal(metrics.expected_disposition_accuracy.pass, metrics.expected_disposition_accuracy.total);
});

test("opt-out cases never produce a would-reply decision", async () => {
  const optout_cases = ADVERSARIAL_INBOUND_CASES.filter((c) => c.category === "opt_out");
  assert.ok(optout_cases.length >= 4);
  for (const test_case of optout_cases) {
    const result = await replayInboundCase(test_case);
    assert.notEqual(
      result.detail?.should_queue_reply,
      true,
      `${test_case.case_id} must not auto-reply`
    );
  }
});

test("wrong-number cases never produce a would-reply decision", async () => {
  const wrong_number_cases = ADVERSARIAL_INBOUND_CASES.filter(
    (c) => c.category === "wrong_number"
  );
  assert.ok(wrong_number_cases.length >= 3);
  for (const test_case of wrong_number_cases) {
    const result = await replayInboundCase(test_case);
    assert.notEqual(
      result.detail?.should_queue_reply,
      true,
      `${test_case.case_id} must not auto-reply`
    );
  }
});
