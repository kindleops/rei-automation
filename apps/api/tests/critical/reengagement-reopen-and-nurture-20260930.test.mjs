/**
 * reengagement-reopen-and-nurture-20260930.test.mjs
 *
 * Two owner rules, 2026-09-30.
 *
 * 1. A dead deal whose seller answers a NEW campaign text reopens at the stage
 *    the conversation is at. Thread +16122720901: backfilled dead at `closed`
 *    on 2026-05-26; she answered "Yes." to a 2026-09-30 campaign text, the
 *    autopilot moved the conversation to S2, and the deal stayed closed, so the
 *    thread read "S10 · Closed".
 *
 * 2. "A not interested is a 30 day follow up." The seller flow scheduled that
 *    follow-up and the stage.not_interested_cold rule cancelled it ~9 s later,
 *    every time: from July to 2026-09-30 no nurture_not_interested follow-up
 *    reached a seller. The same reply also turned the deal `suppressed`.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  decideReengagementReopen,
  opportunityStatusForReply,
  NURTURE_INTENTS,
  REENGAGEMENT_ACTIVE_INTENTS,
} from "@/lib/domain/seller-flow/persist-seller-transition.js";
import {
  normalizeOpportunityRow,
  reopenClosedLostOpportunity,
} from "@/lib/domain/opportunity/opportunity-service.js";
import { mapThreadStageToOpportunityStage } from "@/lib/domain/opportunity/universal-pipeline-registry.js";
import { executeAutomationAction, isNurtureFollowUpRow } from "@/lib/domain/automation/automation-actions.js";
import { stageTemperatureRules } from "@/lib/domain/automation/rules/stage-temperature-rules.js";

const DIANE = "+16122720901";
const CLOSED_AT = "2026-05-26T22:39:02.939Z";

const deadDeal = (overrides = {}) => ({
  id: "358fc746",
  primary_thread_key: DIANE,
  acquisition_stage: "closed",
  opportunity_status: "dead",
  stage_entered_at: CLOSED_AT,
  version: 3,
  ...overrides,
});
const yesTransition = { stage_after: "offer_interest", stage_after_number: 2, advanced: true, facts_patch: { ownership_status: "confirmed" } };
const contactable = { is_suppressed: false, contactability_status: "contactable" };
const campaignTouch = {
  id: "26abfd0b",
  campaign_id: "7f2ba659",
  touch_number: 1,
  queue_status: "delivered",
  sent_at: "2026-09-30T14:47:07.321Z",
};
const decide = (overrides = {}) =>
  decideReengagementReopen({
    opportunity: deadDeal(),
    transition: yesTransition,
    intent: "ownership_confirmed",
    thread: contactable,
    campaignTouch,
    closedAt: CLOSED_AT,
    ...overrides,
  });

// ── 1. the decision ────────────────────────────────────────────────────────

test("the production case: 'Yes.' to a new campaign text reopens the dead deal at S2", () => {
  const decision = decide();
  assert.equal(decision.reopen, true, JSON.stringify(decision));
  assert.equal(decision.to_stage, "offer_interest");
  assert.equal(decision.to_status, "active");
  assert.equal(decision.evidence.queue_id, "26abfd0b");
  assert.equal(decision.evidence.campaign_id, "7f2ba659");
});

test("'not interested' / 'not now' to a new campaign text reopen as a follow-up, never as dead", () => {
  for (const intent of NURTURE_INTENTS) {
    const decision = decide({ intent, transition: { stage_after: "ownership_confirmation", facts_patch: {} } });
    assert.equal(decision.reopen, true, intent);
    assert.equal(decision.to_status, "nurture", intent);
  }
});

test("replies that are not engagement leave the deal closed", () => {
  for (const intent of ["unclear", "opt_out", "wrong_number", "hostile_or_legal", "tenant_respondent", "", null]) {
    assert.equal(decide({ intent }).reopen, false, String(intent));
  }
  assert.ok(REENGAGEMENT_ACTIVE_INTENTS.includes("asks_offer"));
});

test("only closed-LOST deals reopen: suppressed (opt-outs) and won never do", () => {
  for (const status of ["suppressed", "won", "archived", "active", "nurture"]) {
    const decision = decide({ opportunity: deadDeal({ opportunity_status: status }) });
    assert.equal(decision.reopen, false, status);
    assert.equal(decision.reason, "not_closed_lost");
  }
  assert.equal(decide({ opportunity: deadDeal({ opportunity_status: "lost" }) }).reopen, true);
});

test("anything that blocks contact keeps it closed", () => {
  assert.equal(decide({ thread: { is_suppressed: true, contactability_status: "contactable" } }).reason, "contact_blocked");
  assert.equal(decide({ thread: { is_suppressed: false, contactability_status: "opted_out" } }).reason, "contact_blocked");
  assert.equal(decide({ thread: null }).reason, "thread_state_unknown");
  assert.equal(decide({ transition: { ...yesTransition, contactability_patch: { contactability_status: "opted_out" } } }).reason, "contact_blocked");
  assert.equal(decide({ transition: { ...yesTransition, next_action: "no_action_contact_blocked" } }).reason, "contact_blocked");
  assert.equal(decide({ transition: { ...yesTransition, facts_patch: { ownership_status: "not_owner" } } }).reason, "ownership_denied");
});

test("the reply must answer outreach sent AFTER the deal closed", () => {
  assert.equal(decide({ campaignTouch: null }).reason, "no_campaign_touch_after_close");
  assert.equal(decide({ campaignTouch: { ...campaignTouch, sent_at: "2026-05-20T00:00:00Z" } }).reason, "no_campaign_touch_after_close");
  assert.equal(decide({ closedAt: null }).reason, "closed_at_unknown");
});

test("a dead deal at a real stage keeps that stage; only `closed` takes the conversation's", () => {
  const decision = decide({ opportunity: deadDeal({ acquisition_stage: "asking_price" }) });
  assert.equal(decision.to_stage, "asking_price");
});

// ── 2. open deals: not interested is a follow-up ───────────────────────────

test("'not interested' makes a live deal a nurture; engaging again makes it live", () => {
  assert.equal(opportunityStatusForReply("active", "not_interested"), "nurture");
  assert.equal(opportunityStatusForReply("waiting", "need_time"), "nurture");
  assert.equal(opportunityStatusForReply("nurture", "asks_offer"), "active");
  assert.equal(opportunityStatusForReply("nurture", "not_interested"), null);
  assert.equal(opportunityStatusForReply("paused", "not_interested"), null, "an operator pause is not ours to move");
  assert.equal(opportunityStatusForReply("dead", "asks_offer"), null, "closed deals reopen only through the reopen path");
  assert.equal(opportunityStatusForReply("active", "unclear"), null);
});

test("'not interested' no longer turns a deal suppressed (the opt-out status)", () => {
  const row = normalizeOpportunityRow({ id: "o1", opportunity_status: "active", latest_intent: "not_interested", acquisition_stage: "offer_interest" });
  assert.equal(row.opportunity_status, "active");
  assert.equal(mapThreadStageToOpportunityStage({ not_interested: true }).status, "nurture");
  assert.equal(mapThreadStageToOpportunityStage({ wrong_number: true }).status, "dead");
  assert.equal(mapThreadStageToOpportunityStage({ not_interested: true, opt_out: true }).status, "suppressed");
});

// ── fake database ──────────────────────────────────────────────────────────

function fakeDb(seed = {}) {
  const state = { ...seed };
  const calls = [];
  const rowsOf = (table) => (state[table] ||= []);
  function query(table) {
    const q = {
      op: "select",
      payload: null,
      filters: [],
      select() { return q; },
      insert(row) { q.op = "insert"; q.payload = row; return q; },
      update(patch) { q.op = "update"; q.payload = patch; return q; },
      upsert(row) { q.op = "upsert"; q.payload = row; return q; },
      eq(col, val) { q.filters.push((r) => String(r[col]) === String(val)); return q; },
      in(col, vals) { q.filters.push((r) => vals.map(String).includes(String(r[col]))); return q; },
      is(col, val) { q.filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return q; },
      not(col, _op, val) { q.filters.push((r) => (val === null ? r[col] != null : r[col] !== val)); return q; },
      gt(col, val) { q.filters.push((r) => String(r[col] ?? "") > String(val)); return q; },
      gte() { return q; },
      lt() { return q; },
      lte() { return q; },
      or() { return q; },
      order() { return q; },
      limit() { return q; },
      range() { return q; },
      maybeSingle() { return q.run().then(({ data, error }) => ({ data: data?.[0] || null, error })); },
      single() { return q.run().then(({ data, error }) => ({ data: data?.[0] || null, error })); },
      then(onF, onR) { return q.run().then(onF, onR); },
      async run() {
        const rows = rowsOf(table);
        calls.push({ table, op: q.op, payload: q.payload });
        if (q.op === "insert" || q.op === "upsert") {
          const list = Array.isArray(q.payload) ? q.payload : [q.payload];
          const out = [];
          for (const payload of list) {
            const key = table === "inbox_thread_state" ? "thread_key" : "id";
            const existing = q.op === "upsert" && rows.find((r) => payload[key] != null && String(r[key]) === String(payload[key]));
            if (existing) { Object.assign(existing, payload); out.push(existing); continue; }
            const row = { id: `${table}-${rows.length + 1}`, ...payload };
            rows.push(row);
            out.push(row);
          }
          return { data: out, error: null };
        }
        const matches = rows.filter((r) => q.filters.every((f) => f(r)));
        if (q.op === "update") for (const row of matches) Object.assign(row, q.payload);
        return { data: matches, error: null };
      },
    };
    return q;
  }
  return { state, calls, from: (table) => query(table), rpc: async () => ({ data: null, error: null }) };
}

// ── 3. the reopen write ────────────────────────────────────────────────────

test("reopen writes status + stage, both history rows, and moves the thread off `closed`", async () => {
  const db = fakeDb({
    acquisition_opportunities: [deadDeal()],
    inbox_thread_state: [{ thread_key: DIANE, lifecycle_stage: "closed", seller_stage: "closed", manual_stage_lock: false }],
  });
  const result = await reopenClosedLostOpportunity("358fc746", {
    to_stage: "offer_interest",
    reason: "reengaged_new_campaign_touch",
    source: "seller_autopilot",
    actor: "seller_inbound_orchestrator",
    evidence: { queue_id: "26abfd0b", campaign_id: "7f2ba659", inbound_event_id: "evt-yes" },
  }, { supabase: db });

  assert.equal(result.ok, true, JSON.stringify(result));
  const deal = db.state.acquisition_opportunities[0];
  assert.equal(deal.opportunity_status, "active");
  assert.equal(deal.acquisition_stage, "offer_interest");
  assert.equal(deal.version, 4);

  const history = db.state.acquisition_opportunity_history || [];
  assert.deepEqual(
    history.map((h) => [h.field_name, h.previous_value, h.new_value]).sort(),
    [["acquisition_stage", "closed", "offer_interest"], ["opportunity_status", "dead", "active"]],
  );
  assert.ok(history.every((h) => h.metadata?.reopen === true && h.metadata?.queue_id === "26abfd0b"));
  assert.equal(db.state.inbox_thread_state[0].lifecycle_stage, "offer_interest", "the monotonic guard must not pin the thread at closed");
});

test("reopen as a follow-up writes nurture", async () => {
  const db = fakeDb({ acquisition_opportunities: [deadDeal()], inbox_thread_state: [{ thread_key: DIANE, lifecycle_stage: "closed" }] });
  const result = await reopenClosedLostOpportunity("358fc746", {
    to_stage: "ownership_confirmation", to_status: "nurture", reason: "reengaged_new_campaign_touch_follow_up",
    evidence: { queue_id: "q1" },
  }, { supabase: db });
  assert.equal(result.ok, true);
  assert.equal(db.state.acquisition_opportunities[0].opportunity_status, "nurture");
});

test("reopen refuses what it must: suppressed, a closed target, no reason, no evidence, a lost race", async () => {
  const run = (deal, input) => reopenClosedLostOpportunity(deal.id, input, { supabase: fakeDb({ acquisition_opportunities: [deal] }) });
  const base = { to_stage: "offer_interest", reason: "r", evidence: { queue_id: "q" } };
  assert.equal((await run(deadDeal({ opportunity_status: "suppressed" }), base)).error, "not_reopenable");
  assert.equal((await run(deadDeal({ opportunity_status: "won" }), base)).error, "not_reopenable");
  assert.equal((await run(deadDeal(), { ...base, to_stage: "closed" })).error, "invalid_reopen_stage");
  assert.equal((await run(deadDeal(), { ...base, to_stage: "" })).error, "invalid_reopen_stage");
  assert.equal((await run(deadDeal(), { ...base, reason: "" })).error, "reopen_reason_required");
  assert.equal((await run(deadDeal(), { ...base, evidence: {} })).error, "reopen_evidence_required");
  assert.equal((await run(deadDeal(), { ...base, to_status: "won" })).error, "invalid_reopen_status");

  // Another writer bumped the version between our read and our write.
  const db = fakeDb({ acquisition_opportunities: [deadDeal()] });
  const realFrom = db.from;
  let reads = 0;
  db.from = (table) => {
    const q = realFrom(table);
    if (table === "acquisition_opportunities" && q) {
      const realSingle = q.single;
      q.single = () => realSingle().then((res) => {
        reads += 1;
        const snapshot = { ...res.data };
        db.state.acquisition_opportunities[0].version = 9;
        return { ...res, data: snapshot };
      });
    }
    return q;
  };
  const raced = await reopenClosedLostOpportunity("358fc746", base, { supabase: db });
  assert.equal(raced.error, "reopen_conflict");
  assert.equal(reads, 1);
  assert.equal(db.state.acquisition_opportunities[0].opportunity_status, "dead");
  assert.equal((db.state.acquisition_opportunity_history || []).length, 0, "no history for a write that did not happen");
});

// ── 4. the rule no longer kills the 30-day follow-up ───────────────────────

test("the not-interested rule keeps nurture follow-ups", () => {
  const rule = stageTemperatureRules.find((r) => r.rule_key === "stage.not_interested_cold");
  const cancel = rule.actions.find((a) => a.action_type === "cancel_pending_queue");
  assert.equal(cancel.params.keep_nurture_follow_ups, true);
  assert.equal(isNurtureFollowUpRow({ type: "followup", use_case_template: "nurture_not_interested" }), true);
  assert.equal(isNurtureFollowUpRow({ type: "followup", use_case_template: "ownership_check" }), false, "a no-reply follow-up is not a nurture");
  assert.equal(isNurtureFollowUpRow({ type: "campaign", use_case_template: "nurture_x" }), false);
});

test("cancel_pending_queue cancels the campaign touch and keeps the follow-up this reply scheduled", async () => {
  const db = fakeDb({
    send_queue: [
      { id: "touch-2", to_phone_number: DIANE, queue_status: "scheduled", type: "campaign", use_case_template: "ownership_check" },
      { id: "nurture", to_phone_number: DIANE, queue_status: "scheduled", type: "followup", use_case_template: "nurture_not_interested" },
      { id: "no-reply", to_phone_number: DIANE, queue_status: "scheduled", type: "followup", use_case_template: "ownership_check" },
    ],
  });
  const rule = stageTemperatureRules.find((r) => r.rule_key === "stage.not_interested_cold");
  const action = rule.actions.find((a) => a.action_type === "cancel_pending_queue");
  const result = await executeAutomationAction({
    event: { id: "evt-1", event_type: "inbound_message_received", conversation_thread_id: DIANE, payload: { from_phone_number: DIANE, thread_key: DIANE } },
    run: { id: "run-1" },
    rule,
    action,
    supabaseClient: db,
    dry_run: false,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const byId = Object.fromEntries(db.state.send_queue.map((row) => [row.id, row.queue_status]));
  assert.deepEqual(byId, { "touch-2": "cancelled", nurture: "scheduled", "no-reply": "cancelled" });
});
