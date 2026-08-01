// ─── inbound-adversarial-replay-coverage.test.mjs ────────────────────────────
// Launch coverage invariants over the adversarial corpus, replayed through the
// LIVE decision engine (no sends, no writes):
//   * 100% of cases reach a canonical terminal disposition;
//   * 0 engine exceptions;
//   * 0 would-reply decisions after a confirmed opt-out;
//   * 0 would-reply decisions to wrong numbers;
//   * the canonical re-engagement pair supersedes stale not-interested state;
//   * positive-after-binding-opt-out routes to a human, never auto-resumes.
// Coverage is NOT accuracy: intent-level agreement is reported by the
// scripts/ops/inbound-replay-harness.mjs confusion matrix, reviewed manually.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ADVERSARIAL_INBOUND_CASES,
  CORPUS_VERSION,
} from "../fixtures/inbound-adversarial-corpus.mjs";
import { replayInboundCase } from "@/lib/domain/inbound/inbound-replay-engine.js";
import { TERMINAL_DISPOSITION_SET } from "@/lib/domain/inbound/terminal-disposition.js";

test(`adversarial corpus (${CORPUS_VERSION}): every case reaches a terminal disposition, zero silent drops`, async () => {
  assert.ok(ADVERSARIAL_INBOUND_CASES.length >= 60, "corpus must stay >= 60 cases");

  const failures = [];
  let engine_exceptions = 0;

  for (const test_case of ADVERSARIAL_INBOUND_CASES) {
    const result = await replayInboundCase(test_case);

    if (result.ok === false) {
      engine_exceptions += 1;
      failures.push(`${test_case.case_id}: engine exception ${result.detail?.engine_exception}`);
      continue;
    }
    if (!TERMINAL_DISPOSITION_SET.has(result.disposition)) {
      failures.push(`${test_case.case_id}: non-canonical disposition ${result.disposition}`);
      continue;
    }

    const expected = test_case.expected || {};

    if (expected.must_not_auto_reply === true && result.detail?.should_queue_reply === true) {
      failures.push(`${test_case.case_id}: auto-reply decision despite must_not_auto_reply`);
    }

    if (
      expected.re_engagement_expected === true &&
      result.precedence?.re_engagement_detected !== true
    ) {
      failures.push(`${test_case.case_id}: re-engagement not detected`);
    }

    if (
      expected.supersedes_prior_state === true &&
      result.precedence?.supersedes_prior_state !== true
    ) {
      failures.push(`${test_case.case_id}: stale state not superseded`);
    }
    if (
      expected.supersedes_prior_state === false &&
      result.precedence?.supersedes_prior_state === true
    ) {
      failures.push(`${test_case.case_id}: superseded state that must stand`);
    }
  }

  assert.equal(engine_exceptions, 0, `engine exceptions:\n${failures.join("\n")}`);
  assert.deepEqual(failures, [], `coverage violations:\n${failures.join("\n")}`);
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
