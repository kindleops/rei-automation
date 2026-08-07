import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveThreadAutomationSnapshot,
  formatThreadAutomationSummary,
  AUTOMATION_STATES,
  THREAD_AUTOMATION_SNAPSHOT_VERSION,
} from "@/lib/domain/deal-context/thread-automation-snapshot.js";
import { makeChainableSupabase, makeTerminalQuery } from "../helpers/chainable-supabase.mjs";

const THREAD = "+13055550123";

function makeDeps({
  threadState = null,
  opportunity = null,
  queueRow = null,
  autoReplyMode = "live_limited",
  queueMode = "normal",
  failThreadState = false,
} = {}) {
  const supabase = makeChainableSupabase({
    inbox_thread_state: () => ({
      select: () => {
        if (failThreadState) {
          return makeTerminalQuery({ data: null, error: { message: "boom" } });
        }
        return makeTerminalQuery({ data: threadState, error: null });
      },
    }),
    acquisition_opportunities: () => ({
      select: () => makeTerminalQuery({ data: opportunity ? [opportunity] : [], error: null }),
    }),
    send_queue: () => ({
      select: () => makeTerminalQuery({ data: queueRow ? [queueRow] : [], error: null }),
    }),
  });
  const getSystemValue = async (key) => {
    if (key === "auto_reply_mode") return autoReplyMode;
    if (key === "queue_execution_mode") return queueMode;
    return null;
  };
  return { supabase, getSystemValue };
}

const NEGOTIATING_OPPORTUNITY = {
  id: "opp-1",
  primary_thread_key: THREAD,
  property_id: "prop-1",
  acquisition_stage: "offer",
  asking_price: 1_500_000,
  current_offer: 1_125_000,
  next_action: "negotiate",
  next_action_at: "2026-08-07T00:00:00.000Z",
  metadata: {
    negotiation_state: {
      current_asking_price: 1_500_000,
      asking_price_per_unit: 100_000,
      latest_offer: 1_125_000,
      recommended_offer: 1_165_000,
      authorized_offer_ceiling: 1_240_000,
      terms_accepted: false,
    },
    ade_snapshot: { investor_ceiling_high: 1_260_000, valuation_confidence: 80 },
  },
};

const ACTIVE_THREAD_STATE = {
  thread_key: THREAD,
  inbox_bucket: "active",
  automation_lane: "auto",
  is_suppressed: false,
  stage: "offer",
  last_intent: "asking_price_provided",
  next_action: "negotiate",
  next_action_at: "2026-08-07T00:00:00.000Z",
  pending_queue_count: 0,
  metadata: {},
};

test("active negotiating thread surfaces the full Deal Desk block", async () => {
  const snapshot = await resolveThreadAutomationSnapshot(THREAD, makeDeps({
    threadState: ACTIVE_THREAD_STATE,
    opportunity: NEGOTIATING_OPPORTUNITY,
  }));

  assert.equal(snapshot.version, THREAD_AUTOMATION_SNAPSHOT_VERSION);
  assert.equal(snapshot.automation.state, AUTOMATION_STATES.ACTIVE);
  assert.equal(snapshot.stage.number, 5);
  assert.equal(snapshot.seller_ask, 1_500_000);
  assert.equal(snapshot.seller_ask_per_unit, 100_000);
  assert.equal(snapshot.our_last_offer, 1_125_000);
  assert.equal(snapshot.maximum_authorized, 1_240_000);
  assert.equal(snapshot.next_action.action, "negotiate");
  assert.ok(!snapshot.reason_codes.includes("valuation_authority_absent"));

  const summary = formatThreadAutomationSummary(snapshot);
  assert.match(summary, /Automation: ACTIVE/);
  assert.match(summary, /Stage: S5 Offer/);
  assert.match(summary, /Seller ask: \$1,500,000 \(\$100,000\/unit\)/);
  assert.match(summary, /Our last offer: \$1,125,000/);
  assert.match(summary, /Maximum authorized: \$1,240,000/);
  assert.match(summary, /Next action: negotiate — due: now/);
});

test("suppressed thread is BLOCKED regardless of live modes", async () => {
  const snapshot = await resolveThreadAutomationSnapshot(THREAD, makeDeps({
    threadState: { ...ACTIVE_THREAD_STATE, is_suppressed: true },
    opportunity: NEGOTIATING_OPPORTUNITY,
  }));
  assert.equal(snapshot.automation.state, AUTOMATION_STATES.BLOCKED);
  assert.ok(snapshot.automation.reasons.includes("thread_suppressed"));
});

test("needs_review bucket routes to REVIEW", async () => {
  const snapshot = await resolveThreadAutomationSnapshot(THREAD, makeDeps({
    threadState: { ...ACTIVE_THREAD_STATE, inbox_bucket: "needs_review" },
  }));
  assert.equal(snapshot.automation.state, AUTOMATION_STATES.REVIEW);
});

test("auto_reply_mode disabled reads INACTIVE with reason", async () => {
  const snapshot = await resolveThreadAutomationSnapshot(THREAD, makeDeps({
    threadState: ACTIVE_THREAD_STATE,
    autoReplyMode: "disabled",
  }));
  assert.equal(snapshot.automation.state, AUTOMATION_STATES.INACTIVE);
  assert.ok(snapshot.automation.reasons.some((r) => r.startsWith("auto_reply_")));
});

test("internal_only on a non-internal seller thread reads INACTIVE truthfully", async () => {
  const snapshot = await resolveThreadAutomationSnapshot(THREAD, makeDeps({
    threadState: ACTIVE_THREAD_STATE,
    autoReplyMode: "internal_only",
  }));
  assert.equal(snapshot.automation.state, AUTOMATION_STATES.INACTIVE);
  assert.ok(snapshot.automation.reasons.includes("auto_reply_internal_only_non_internal"));
});

test("dispatch stopped reads PAUSED even when replies are allowed", async () => {
  const snapshot = await resolveThreadAutomationSnapshot(THREAD, makeDeps({
    threadState: ACTIVE_THREAD_STATE,
    queueMode: "stopped",
  }));
  assert.equal(snapshot.automation.state, AUTOMATION_STATES.PAUSED);
  assert.ok(snapshot.automation.reasons.includes("queue_execution_mode_stopped"));
});

test("missing valuation authority yields nulls plus reason codes, never numbers", async () => {
  const snapshot = await resolveThreadAutomationSnapshot(THREAD, makeDeps({
    threadState: ACTIVE_THREAD_STATE,
    opportunity: null,
  }));
  assert.equal(snapshot.maximum_authorized, null);
  assert.equal(snapshot.seller_ask, null);
  assert.ok(snapshot.reason_codes.includes("opportunity_not_found"));
  assert.ok(snapshot.reason_codes.includes("valuation_authority_absent"));
});

test("thread-state read failure degrades soft with a reason code", async () => {
  const snapshot = await resolveThreadAutomationSnapshot(THREAD, makeDeps({
    failThreadState: true,
    opportunity: NEGOTIATING_OPPORTUNITY,
  }));
  assert.equal(snapshot.version, THREAD_AUTOMATION_SNAPSHOT_VERSION);
  assert.ok(snapshot.reason_codes.some((r) => r.startsWith("thread_state_read_failed")));
});

test("scheduled queue row supplies the due time when thread state has none", async () => {
  const snapshot = await resolveThreadAutomationSnapshot(THREAD, makeDeps({
    threadState: { ...ACTIVE_THREAD_STATE, next_action: null, next_action_at: null },
    opportunity: {
      ...NEGOTIATING_OPPORTUNITY,
      next_action: "schedule_follow_up",
      next_action_at: null,
    },
    queueRow: {
      id: "q-1",
      queue_status: "scheduled",
      scheduled_for: "2026-08-09T15:00:00.000Z",
      use_case_template: "nurture_unclear",
    },
  }));
  assert.equal(snapshot.next_action.source, "scheduled_queue_row");
  assert.equal(snapshot.next_action.due_at, "2026-08-09T15:00:00.000Z");
  assert.equal(snapshot.next_action.scheduled_use_case, "nurture_unclear");
});
