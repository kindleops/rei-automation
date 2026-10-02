// RC 7.1 deploy-window repair scripts: atomic status+audit and the Dequincy plan.
// Pure / injected only — no network, no database.

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyStatusTransitionAtomic,
  ATOMIC_STATUS_TRANSITION_SQL,
} from "../../scripts/repair-not-interested-nurture.mjs";
import { planDequincy, DEQUINCY } from "../../scripts/repairs/20261002_dequincy_option_a_nurture.mjs";

function fakePg(result) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push(String(sql).trim().split(/\s+/).slice(0, 3).join(" "));
      if (String(sql).includes("acquisition_opportunity_history")) {
        assert.equal(params.length, 9);
        return { rows: [result] };
      }
      return { rows: [] };
    },
  };
}

const T = {
  opportunity_id: "00000000-0000-0000-0000-000000000001",
  from_status: "suppressed",
  to_status: "nurture",
  source: "rc71_not_interested_nurture_repair",
  reason: "not_interested_is_30_day_follow_up",
  idempotency_key: "rc71_not_interested_nurture_repair:1",
};

test("status change and audit row are one statement with a guarded update and an idempotent insert", () => {
  assert.match(ATOMIC_STATUS_TRANSITION_SQL, /with upd as \(\s*update public\.acquisition_opportunities/);
  assert.match(ATOMIC_STATUS_TRANSITION_SQL, /o\.opportunity_status = \$2/);
  assert.match(ATOMIC_STATUS_TRANSITION_SQL, /from upd\s+on conflict \(idempotency_key\) do nothing/);
});

test("commits when the change and its audit row both landed", async () => {
  const pg = fakePg({ updated: 1, audited: 1 });
  const r = await applyStatusTransitionAtomic(pg, T);
  assert.deepEqual(r, { updated: 1, audited: 1 });
  assert.equal(pg.calls[0], "begin");
  assert.equal(pg.calls.at(-1), "commit");
});

test("a re-run (guard matches nothing) commits a no-op", async () => {
  const pg = fakePg({ updated: 0, audited: 0 });
  const r = await applyStatusTransitionAtomic(pg, T);
  assert.deepEqual(r, { updated: 0, audited: 0 });
  assert.equal(pg.calls.at(-1), "commit");
});

test("a change without its own audit row is rolled back, never committed", async () => {
  const pg = fakePg({ updated: 1, audited: 0 });
  await assert.rejects(() => applyStatusTransitionAtomic(pg, T), /atomic_status_transition_mismatch/);
  assert.equal(pg.calls.at(-1), "rollback");
  assert.ok(!pg.calls.includes("commit"));
});

const cleanSeller = { phone: DEQUINCY.thread_key, thread: { is_suppressed: false, contactability_status: "contactable" }, active_suppressions: 0, opt_out_events: 0, live_nurture_rows: 0 };
const dequincyRow = { id: DEQUINCY.opportunity_id, acquisition_stage: "closed", opportunity_status: "active", latest_intent: null };

test("Dequincy: closed+active with no opt-out evidence -> apply nurture and one follow-up", () => {
  assert.deepEqual(planDequincy({ opportunity: dequincyRow, seller: cleanSeller }), {
    action: "APPLY", reason: "owner_option_a_nurture_not_lost", needFollowUp: true,
  });
});

test("Dequincy: any opt-out / suppression evidence blocks it", () => {
  const plan = planDequincy({ opportunity: dequincyRow, seller: { ...cleanSeller, active_suppressions: 1 } });
  assert.equal(plan.action, "BLOCKED_OPT_OUT");
  assert.equal(planDequincy({ opportunity: dequincyRow, seller: { ...cleanSeller, opt_out_events: 1 } }).action, "BLOCKED_OPT_OUT");
});

test("Dequincy: re-run after apply is ALREADY_APPLIED; a live nurture row means no second follow-up", () => {
  const applied = { ...dequincyRow, acquisition_stage: "offer_interest", opportunity_status: "nurture" };
  assert.deepEqual(planDequincy({ opportunity: applied, seller: { ...cleanSeller, live_nurture_rows: 1 } }), {
    action: "ALREADY_APPLIED", reason: "status_already_nurture", needFollowUp: false,
  });
  assert.equal(planDequincy({ opportunity: applied, seller: cleanSeller }).needFollowUp, true);
});

test("Dequincy: a row changed since the audit is skipped, never clobbered", () => {
  const plan = planDequincy({ opportunity: { ...dequincyRow, opportunity_status: "lost" }, seller: cleanSeller });
  assert.equal(plan.action, "SKIP");
  assert.match(plan.reason, /state_changed_since_audit/);
});
