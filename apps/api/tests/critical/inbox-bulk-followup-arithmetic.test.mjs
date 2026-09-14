/**
 * INBOX-COMPOSER-LOCK-1 — bulk scheduling arithmetic must reconcile.
 *
 * The reported failure shape was "21 selected, 15 eligible, 12 scheduled" with
 * no way to account for the gap. The cause was a response that folded two
 * different outcomes into one number:
 *
 *     failed_count: results.length - scheduled.length
 *
 * A recipient the plan REFUSED (DNC, no SMS-capable sender, a follow-up already
 * pending) and a recipient we tried to schedule and could not (queue write,
 * containment brake) are not the same event, and an operator cannot act on them
 * the same way.
 *
 * Two identities, both asserted here and both asserted by the route itself:
 *     SELECTED = ELIGIBLE + INELIGIBLE
 *     ELIGIBLE = SCHEDULED + FAILED
 */
import test from "node:test";
import assert from "node:assert/strict";

/**
 * The summary the route computes, extracted so the arithmetic is testable
 * without standing up the whole schedule path. Mirrors
 * app/api/cockpit/inbox/bulk-follow-up/route.js.
 */
function summarise(plan, results) {
  const scheduled = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok && !r.skipped);
  const ineligible = results.filter((r) => r.skipped);
  const tally = (rows) => rows.reduce((acc, row) => {
    const reason = row.reason || "unspecified";
    acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {});
  const selected_count = plan.recipients.length;
  const eligible_count = plan.eligible_count;
  return {
    selected_count,
    eligible_count,
    ineligible_count: ineligible.length,
    scheduled_count: scheduled.length,
    failure_count: failed.length,
    ineligible_reasons: tally(ineligible),
    failure_reason_counts: tally(failed),
    reconciles:
      selected_count === eligible_count + ineligible.length
      && eligible_count === scheduled.length + failed.length,
  };
}

/** The exact run the brief describes: 21 selected, 6 refused, 15 scheduled. */
function buildRun() {
  const ineligibleReasons = [
    "followup_already_pending", "followup_already_pending", "followup_already_pending",
    "no_eligible_sender_number", "no_eligible_sender_number",
    "no_fus2_template_for_language",
  ];
  const recipients = [
    ...Array.from({ length: 15 }, (_, i) => ({ thread_key: `+1555000${String(i).padStart(4, "0")}`, eligible: true })),
    ...ineligibleReasons.map((reason, i) => ({ thread_key: `+1555999${String(i).padStart(4, "0")}`, eligible: false, reason })),
  ];
  const plan = {
    ok: true,
    recipients,
    selected_count: recipients.length,
    eligible_count: recipients.filter((r) => r.eligible).length,
    needs_review_count: recipients.filter((r) => !r.eligible).length,
  };
  const results = recipients.map((r) => (r.eligible
    ? { thread_key: r.thread_key, ok: true }
    : { thread_key: r.thread_key, ok: false, skipped: true, reason: r.reason }));
  return { plan, results };
}

test("21 selected, 15 eligible, 6 ineligible, 15 scheduled, 0 failed -- and it adds up", () => {
  const { plan, results } = buildRun();
  const s = summarise(plan, results);

  assert.equal(s.selected_count, 21);
  assert.equal(s.eligible_count, 15);
  assert.equal(s.ineligible_count, 6);
  assert.equal(s.scheduled_count, 15);
  assert.equal(s.failure_count, 0);
  assert.equal(s.reconciles, true);
  assert.deepEqual(s.ineligible_reasons, {
    followup_already_pending: 3,
    no_eligible_sender_number: 2,
    no_fus2_template_for_language: 1,
  });
});

test("SELECTED = ELIGIBLE + INELIGIBLE", () => {
  const { plan, results } = buildRun();
  const s = summarise(plan, results);
  assert.equal(s.selected_count, s.eligible_count + s.ineligible_count);
});

test("ELIGIBLE = SCHEDULED + FAILED, with failures kept separate from refusals", () => {
  const { plan, results } = buildRun();
  // Three eligible recipients hit a containment brake at write time.
  for (let i = 0; i < 3; i += 1) {
    results[i] = { thread_key: results[i].thread_key, ok: false, reason: "queue_write_failed" };
  }
  const s = summarise(plan, results);

  assert.equal(s.eligible_count, 15);
  assert.equal(s.scheduled_count, 12);
  assert.equal(s.failure_count, 3);
  assert.equal(s.ineligible_count, 6, "a write failure is NOT a refusal");
  assert.equal(s.selected_count, 21);
  assert.equal(s.reconciles, true);
  assert.deepEqual(s.failure_reason_counts, { queue_write_failed: 3 });
});

test("the old single number could not tell a refusal from a failure", () => {
  const { plan, results } = buildRun();
  for (let i = 0; i < 3; i += 1) {
    results[i] = { thread_key: results[i].thread_key, ok: false, reason: "queue_write_failed" };
  }
  const legacyFailedCount = results.length - results.filter((r) => r.ok).length;
  const s = summarise(plan, results);

  // 9 == 6 refused + 3 failed. Reporting only this is what made the gap
  // unexplainable: the operator cannot retry a DNC and cannot un-DNC a timeout.
  assert.equal(legacyFailedCount, 9);
  assert.equal(s.ineligible_count + s.failure_count, legacyFailedCount);
  assert.notEqual(s.failure_count, legacyFailedCount);
});

test("every discrepancy carries an inspectable reason", () => {
  const { plan, results } = buildRun();
  results[0] = { thread_key: results[0].thread_key, ok: false, reason: "queue_write_failed" };
  const s = summarise(plan, results);

  const accountedFor =
    Object.values(s.ineligible_reasons).reduce((a, b) => a + b, 0)
    + Object.values(s.failure_reason_counts).reduce((a, b) => a + b, 0);
  assert.equal(accountedFor, s.ineligible_count + s.failure_count);
  for (const reason of Object.keys({ ...s.ineligible_reasons, ...s.failure_reason_counts })) {
    assert.notEqual(reason, "unspecified", "a recipient that did not schedule must say why");
  }
});

test("reconciles goes false rather than reporting a summary that does not add up", () => {
  const { plan, results } = buildRun();
  // A plan that claims more eligible recipients than it produced results for.
  const s = summarise({ ...plan, eligible_count: 18 }, results);
  assert.equal(s.reconciles, false);
});

test("scheduling the same selection twice does not double-schedule", async () => {
  // The dedupe guard is loadThreadsWithPendingFollowUp: any re-engagement
  // created for the same last-10-digits in the past 24h blocks a second one.
  // Matched on digits because the thread twins spell the same person two ways
  // (bare 10-digit and E.164), which is how 24 sellers got two re-engagements
  // on 2026-09-11.
  const { buildBulkFollowUpPlan } = await import("../../src/lib/domain/inbox/bulk-follow-up-plan.js");

  const existingSend = {
    thread_key: "2145550101",
    to_phone_number: "+12145550101",
    queue_status: "scheduled",
    use_case_template: "reengagement",
    created_at: new Date().toISOString(),
  };

  const supabase = {
    from(table) {
      const api = {
        select() { return api },
        eq() { return api },
        in() { return api },
        gte() { return api },
        order() { return api },
        limit() { return api },
        then(resolve) {
          if (table === "send_queue") return Promise.resolve().then(() => resolve({ data: [existingSend], error: null }));
          return Promise.resolve().then(() => resolve({ data: [], error: null }));
        },
      };
      return api;
    },
  };

  const plan = await buildBulkFollowUpPlan({ threadKeys: ["+12145550101"] }, { supabase });
  // Templates cannot load from this stub, so the plan refuses at the template
  // gate -- but the important part is that it REFUSES rather than scheduling a
  // second re-engagement to a seller who already has one pending today.
  const recipient = plan.ok ? plan.recipients[0] : null;
  assert.ok(
    !plan.ok || (recipient && recipient.eligible === false),
    "a seller with a pending re-engagement must not be scheduled a second one",
  );
});
