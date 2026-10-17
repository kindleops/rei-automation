import "../helpers/critical-test-environment.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";

// P0 CONTAINMENT (owner directive 2026-10-16): Hartford and Maxwell can never be advanced automatically —
// after a fresh inbound (incl. "yes send the contract"), a worker retry / recovery replay, a conflicting
// classification, an AI decision, a follow-up dispatch, a campaign pre-send, or a hold LOOKUP FAILURE
// (fail closed). A non-held control deal still advances. The rule-based acceptance guard routes the five
// exposed operator offers to human review even with no hold row.
//
// These tests run the PRODUCTION resolver (the critical-test default "no holds" seam is cleared) against an
// in-memory double whose automation_hold_for RPC uses the same predicate as the SQL function.

import {
  __setAutomationHoldResolverForTests,
  HOLD_CAPABILITIES,
  evaluateAcceptanceRules,
  isOperatorOriginatedOffer,
  matchAutomationHolds,
  resolveAutomationHold,
  loadActiveAutomationHolds,
} from "@/lib/domain/holds/automation-hold.js";
import { finalizeSellerAcceptance } from "@/lib/domain/seller-flow/finalize-seller-acceptance.js";
import { acceptActiveOffer, persistActiveOffer, recordSellerCounter } from "@/lib/domain/seller-flow/seller-offer-authority.js";
import { createClosingCaseFromAcceptance } from "@/lib/domain/closings/create-closing-case-from-acceptance.js";
import { persistSellerTransitionArtifacts } from "@/lib/domain/seller-flow/persist-seller-transition.js";
import { recoverSellerExecutionGaps } from "@/lib/domain/seller-flow/recover-seller-execution-gaps.js";
import { shouldSuppressSellerAutoReply } from "@/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js";
import { insertSupabaseSendQueueRow } from "@/lib/supabase/sms-engine.js";
import { processSendQueueItem } from "@/lib/domain/queue/process-send-queue.js";
import { executeManualInboxSendNow } from "@/lib/domain/inbox/send-now-service.js";
import { transitionOpportunityStage } from "@/lib/domain/opportunity/opportunity-service.js";
import { IDS, makeHoldFakeDb, seedContainment } from "../helpers/automation-hold-fake-db.mjs";

const DEFAULT_SEAM = () => ({ held: false, fail_closed: false, holds: [], hold_ids: [], reason: null, source: "test_default_no_holds" });
before(() => __setAutomationHoldResolverForTests(null)); // production resolver: RPC + fail closed
after(() => __setAutomationHoldResolverForTests(DEFAULT_SEAM));

const LIVE_CONTROL = async (key) => ({ queue_processor_mode: "live", queue_emergency_stop_at: "", queue_execution_mode: "normal" })[key] ?? null;
const snapshot = (db, name, id) => JSON.stringify(db.rows(name).find((r) => r.id === id));
const later = () => new Date(Date.now() + 1000).toISOString();

async function seedControlOffer(db, over = {}) {
  // Contract-complete autopilot offer (ADE-bound, frozen ceiling) through the canonical writer.
  db.rows("seller_offers").splice(db.rows("seller_offers").findIndex((o) => o.opportunity_id === IDS.C_OPP), 1);
  const r = await persistActiveOffer({
    opportunity_id: IDS.C_OPP, thread_key: IDS.C_TK, property_id: IDS.C_PROP, master_owner_id: "mo_c",
    purchase_price: 100000, offer_type: "initial_offer", ade_snapshot_id: "ade:c:1", recommended_offer: 100000,
    authorized_ceiling: 120000, valuation_mid: 180000, closing_date: "2026-11-20",
    closing_term: "14_calendar_days_from_acceptance", emd_term: "3_business_days_from_acceptance",
    supabase: db, ...over,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const opp = db.rows("acquisition_opportunities").find((o) => o.id === IDS.C_OPP);
  Object.assign(opp, { property_address_full: "1 Control St, Austin TX 78701", seller_display_name: "Control Seller" });
  return r;
}

// ── 1. the resolver itself ─────────────────────────────────────────────────

test("hold resolver: Hartford and Maxwell are held from every scope key and for every capability; control is not", async () => {
  const db = makeHoldFakeDb(seedContainment());
  for (const cap of Object.values(HOLD_CAPABILITIES)) {
    for (const scope of [{ thread_key: IDS.H_TK }, { inbox_thread_id: IDS.H_THREAD }, { property_id: IDS.H_PROP }, { opportunity_id: IDS.H_OPP },
      { thread_key: IDS.M_TK }, { property_id: IDS.M_PROP }, { opportunity_id: IDS.M_OPP }]) {
      const r = await resolveAutomationHold(scope, { capability: cap, supabase: db });
      assert.equal(r.held, true, `${cap} ${JSON.stringify(scope)}`);
      assert.equal(r.fail_closed, false);
    }
    const c = await resolveAutomationHold({ thread_key: IDS.C_TK, property_id: IDS.C_PROP, opportunity_id: IDS.C_OPP }, { capability: cap, supabase: db });
    assert.equal(c.held, false, cap);
  }
});

test("hold resolver FAILS CLOSED: rpc error, rpc throw, no rpc at all, unreadable hold table", async () => {
  const errDb = makeHoldFakeDb(seedContainment()); errDb.options.rpcError = "permission denied";
  const throwDb = makeHoldFakeDb(seedContainment()); throwDb.options.rpcThrows = true;
  const noRpc = { from: () => ({}) };
  for (const supabase of [errDb, throwDb, noRpc]) {
    const r = await resolveAutomationHold({ thread_key: IDS.C_TK }, { capability: HOLD_CAPABILITIES.OUTBOUND_SEND, supabase });
    assert.equal(r.held, true); assert.equal(r.fail_closed, true); assert.equal(r.reason, "automation_hold_lookup_failed");
  }
  const tableDown = makeHoldFakeDb(seedContainment()); tableDown.options.holdsSelectError = "relation does not exist";
  const all = await loadActiveAutomationHolds({ supabase: tableDown });
  assert.equal(all.ok, false);
});

test("in-memory matcher = RPC predicate: released holds and unlisted capabilities do not match", () => {
  const holds = [
    { id: "a", thread_key: "t1", released_at: "2026-10-16T00:00:00Z" },
    { id: "b", property_id: "p1", blocked_capabilities: ["outbound_send"], released_at: null },
  ];
  assert.equal(matchAutomationHolds(holds, { thread_key: "t1" }, "outbound_send").length, 0, "released hold must not match");
  assert.equal(matchAutomationHolds(holds, { property_id: "p1" }, "outbound_send").length, 1);
  assert.equal(matchAutomationHolds(holds, { property_id: "p1" }, "offer_acceptance").length, 0, "capability not blocked");
  assert.equal(matchAutomationHolds(holds, {}, "outbound_send").length, 0, "no scope keys match nothing");
});

// ── 2. (i) fresh inbound: "yes send the contract" ──────────────────────────

for (const [label, tk, prop, owner, opp] of [["Hartford", IDS.H_TK, IDS.H_PROP, "mo_h", IDS.H_OPP], ["Maxwell", IDS.M_TK, IDS.M_PROP, "mo_m", IDS.M_OPP]]) {
  test(`(i) ${label}: a fresh "yes, send the contract" inbound advances NOTHING; evidence is recorded`, async () => {
    const db = makeHoldFakeDb(seedContainment());
    const before = JSON.stringify({ o: db.rows("acquisition_opportunities"), s: db.rows("seller_offers") });
    const r = await persistSellerTransitionArtifacts({
      transition: { stage_after: "formal_contract", stage_after_number: 6, reasoning_code: "seller_accepted_offer", next_action: "generate_contract", facts_patch: {} },
      threadKey: tk, propertyId: prop, ownerId: owner, intent: "seller_accepted_offer", inboundEventId: `evt-yes-${label}`, supabaseClient: db,
    });
    assert.equal(r.skipped, true); assert.equal(r.reason, "automation_hold");
    assert.equal(r.acceptance.edge, false); assert.equal(r.stage_advanced, false);
    assert.equal(JSON.stringify({ o: db.rows("acquisition_opportunities"), s: db.rows("seller_offers") }), before, "no opportunity / offer write");
    assert.equal(db.rows("closing_cases").length, 0);
    const ev = db.rows("automation_hold_events");
    assert.equal(ev.length, 1); assert.equal(ev[0].event_type, "advancement_blocked"); assert.equal(ev[0].opportunity_id, opp);
    assert.equal(ev[0].evidence.inbound_event_id, `evt-yes-${label}`);
  });
}

test("(i) Hartford: finalizeSellerAcceptance itself refuses — the $315K offer stays byte-identical, no closing case", async () => {
  const db = makeHoldFakeDb(seedContainment());
  const offerBefore = snapshot(db, "seller_offers", IDS.H_OFFER);
  const oppBefore = snapshot(db, "acquisition_opportunities", IDS.H_OPP);
  const r = await finalizeSellerAcceptance({ opportunity_id: IDS.H_OPP, thread_key: IDS.H_TK, property_id: IDS.H_PROP, acceptance_event_id: "evt-perfect-send-it", acceptance_at: later(), supabase: db });
  assert.equal(r.routed_to_human_review, true); assert.equal(r.offer_accepted, false); assert.equal(r.closing_case_created, false);
  for (const reason of ["automation_hold", "operator_originated_offer", "price_above_mao", "price_above_authorized_ceiling", "opportunity_inactive:archived", "opportunity_automation_cancelled"]) {
    assert.ok(r.review_reasons.includes(reason), `${reason} in ${r.review_reasons}`);
  }
  assert.equal(snapshot(db, "seller_offers", IDS.H_OFFER), offerBefore, "offer byte-identical");
  assert.equal(snapshot(db, "acquisition_opportunities", IDS.H_OPP), oppBefore, "held opportunity row untouched (evidence goes to the audit table)");
  assert.equal(db.rows("closing_cases").length, 0);
  assert.equal(db.rows("automation_hold_events")[0].event_type, "acceptance_routed_to_human_review");
});

test("(i) defense in depth: acceptActiveOffer, persistActiveOffer and createClosingCaseFromAcceptance each refuse a held deal directly", async () => {
  const db = makeHoldFakeDb(seedContainment());
  const a = await acceptActiveOffer({ opportunity_id: IDS.H_OPP, acceptance_event_id: "evt-direct", acceptance_at: later(), supabase: db });
  assert.equal(a.accepted, false); assert.equal(a.reason, "automation_hold");
  const p = await persistActiveOffer({ opportunity_id: IDS.H_OPP, thread_key: IDS.H_TK, property_id: IDS.H_PROP, purchase_price: 330000, supabase: db });
  assert.equal(p.ok, false); assert.equal(p.reason, "automation_hold");
  const c = await createClosingCaseFromAcceptance({ opportunity_id: IDS.M_OPP, thread_key: IDS.M_TK, supabase: db });
  assert.equal(c.ok, false); assert.equal(c.reason, "automation_hold");
  assert.equal(db.rows("seller_offers").find((o) => o.id === IDS.H_OFFER).status, "active");
  assert.equal(db.rows("seller_offers").length, 2); assert.equal(db.rows("closing_cases").length, 0);
});

// ── 3. (ii) worker retry / recovery replay ─────────────────────────────────

test("(ii) replaying the same acceptance (worker retry) is refused every time", async () => {
  const db = makeHoldFakeDb(seedContainment());
  for (let i = 0; i < 3; i++) {
    const r = await finalizeSellerAcceptance({ opportunity_id: IDS.H_OPP, thread_key: IDS.H_TK, acceptance_event_id: "evt-retry", acceptance_at: later(), supabase: db });
    assert.equal(r.routed_to_human_review, true); assert.equal(r.offer_accepted, false);
  }
  assert.equal(db.rows("seller_offers").find((o) => o.id === IDS.H_OFFER).status, "active");
  assert.equal(db.rows("closing_cases").length, 0);
});

test("(ii) recover-seller-execution-gaps: held opportunities are skipped by every advancing sweep (terms_accepted=true replay)", async () => {
  const seed = seedContainment();
  seed.acquisition_opportunities[0].metadata = { negotiation_state: { terms_accepted: true, accepted_price: 315000 } };
  seed.acquisition_opportunities[0].next_action = "generate_offer";
  seed.acquisition_opportunities[0].updated_at = "2026-10-13T00:00:00Z";
  const db = makeHoldFakeDb(seed);
  const r = await recoverSellerExecutionGaps({ supabaseClient: db, dryRun: false, sweeps: ["accepted_terms_without_contract", "offer_authorized_never_queued"] });
  assert.equal(r.ok, true);
  const held = r.sweeps.flatMap((s) => s.results).filter((x) => x.skipped === "automation_hold");
  assert.ok(held.some((x) => x.opportunity_id === IDS.H_OPP), JSON.stringify(r.sweeps));
  assert.equal(db.rows("closing_cases").length, 0);
  assert.equal(db.rows("acquisition_opportunities").find((o) => o.id === IDS.H_OPP).acquisition_stage, "offer");
  assert.equal(db.rows("seller_offers").find((o) => o.id === IDS.H_OFFER).status, "active");
});

test("(ii)+(vii) recovery FAILS CLOSED: an unreadable hold table runs no sweep at all", async () => {
  const db = makeHoldFakeDb(seedContainment()); db.options.holdsSelectError = "relation automation_holds does not exist";
  const r = await recoverSellerExecutionGaps({ supabaseClient: db, dryRun: false });
  assert.equal(r.ok, false); assert.equal(r.reason, "automation_hold_lookup_failed"); assert.deepEqual(r.sweeps_executed, []);
  assert.equal(db.calls.updates.length, 0);
});

test("(ii) queue worker retry: a held row is DEFERRED at dispatch (no provider call, no retry consumed)", async () => {
  const db = makeHoldFakeDb(seedContainment());
  let provider = 0;
  for (const tk of [IDS.H_TK, IDS.M_TK]) {
    const r = await processSendQueueItem(
      { id: `q-${tk}`, queue_status: "queued", thread_key: tk, to_phone_number: tk, message_body: "Following up", retry_count: 2, metadata: { source: "auto_reply" } },
      { supabase: db, getSystemValue: LIVE_CONTROL, sendTextgridSMS: async () => { provider += 1; return { ok: true }; } }
    );
    assert.equal(r.sent, false); assert.equal(r.skipped, true); assert.equal(r.reason, "automation_hold"); assert.equal(r.status, 423);
  }
  assert.equal(provider, 0);
  assert.equal(db.calls.updates.length, 0, "row untouched: a hold defers, it does not fail the row");
});

// ── 4. (iii) conflicting classification ────────────────────────────────────

for (const intent of ["seller_accepted_offer", "not_interested", "counter_offer", "asking_price_provided", "contract_requested"]) {
  test(`(iii) Hartford conflicting classification "${intent}": nothing advances, status never flips (no suppress / nurture / reopen)`, async () => {
    const db = makeHoldFakeDb(seedContainment());
    const before = snapshot(db, "acquisition_opportunities", IDS.H_OPP);
    const r = await persistSellerTransitionArtifacts({
      transition: { stage_after: intent === "not_interested" ? "offer_interest" : "offer", stage_after_number: intent === "not_interested" ? 2 : 5, reasoning_code: intent, facts_patch: intent.includes("price") || intent === "counter_offer" ? { asking_price: { value: 330000 } } : {} },
      threadKey: IDS.H_TK, propertyId: IDS.H_PROP, intent, inboundEventId: `evt-${intent}`, supabaseClient: db,
    });
    assert.equal(r.reason, "automation_hold");
    assert.equal(snapshot(db, "acquisition_opportunities", IDS.H_OPP), before);
    assert.equal(db.rows("seller_offers").length, 2, "no counter version");
  });
}

test("(iii) we_accepted_seller_ask on Hartford writes NO counter version (the guard runs before any write)", async () => {
  const db = makeHoldFakeDb(seedContainment());
  const r = await finalizeSellerAcceptance({ opportunity_id: IDS.H_OPP, thread_key: IDS.H_TK, acceptance_event_id: "evt-ask", acceptance_at: later(), accepted_price: 330000, acceptance_basis: "we_accepted_seller_ask", supabase: db });
  assert.equal(r.routed_to_human_review, true);
  assert.equal(db.rows("seller_offers").length, 2);
  const c = await recordSellerCounter({ opportunity_id: IDS.H_OPP, thread_key: IDS.H_TK, property_id: IDS.H_PROP, counter_price: 330000, supabase: db });
  assert.equal(c.ok, false); assert.equal(c.reason, "automation_hold");
});

test("(iii) stage advancement through transitionOpportunityStage is refused for a held deal", async () => {
  const db = makeHoldFakeDb(seedContainment());
  const r = await transitionOpportunityStage(IDS.M_OPP, { to_stage: "offer", source: "workflow", actor: "workflow:x@1" }, { supabase: db });
  assert.equal(r.ok, false); assert.equal(r.error, "automation_hold");
  assert.equal(db.rows("acquisition_opportunities").find((o) => o.id === IDS.M_OPP).acquisition_stage, "asking_price");
});

// ── 5. (iv) AI / auto-reply decision ───────────────────────────────────────

test("(iv) auto-reply decision: a hold suppresses the plan even with force_queue_reply and full confidence", () => {
  const r = shouldSuppressSellerAutoReply({ automation_hold: { held: true }, auto_reply_enabled: true, force_queue_reply: true, classification: { confidence: 0.99, primary_intent: "asking_price" } });
  assert.deepEqual(r, { suppress: true, reason: "automation_hold" });
});

test("(iv) AI capability: the AI action capability is held for both threads (shadow decisions may record, never act)", async () => {
  const db = makeHoldFakeDb(seedContainment());
  for (const tk of [IDS.H_TK, IDS.M_TK]) {
    const r = await resolveAutomationHold({ thread_key: tk }, { capability: HOLD_CAPABILITIES.AI_ACTION, supabase: db });
    assert.equal(r.held, true);
  }
});

// ── 6. (v) follow-up enqueue + dispatch, (vi) campaign pre-send ────────────

for (const [label, source, status] of [["follow-up (24h S2)", "seller_followup", "scheduled"], ["30-day nurture", "nurture_not_interested", "scheduled"], ["campaign first touch", "campaign_launch_execution", "queued"], ["workflow step", "workflow", "queued"]]) {
  test(`(v/vi) ${label}: no sendable row is ever created for Hartford or Maxwell`, async () => {
    const db = makeHoldFakeDb(seedContainment());
    for (const tk of [IDS.H_TK, IDS.M_TK]) {
      const r = await insertSupabaseSendQueueRow({ queue_key: `${source}:${tk}`, queue_status: status, thread_key: tk, to_phone_number: tk, from_phone_number: "+15550000002", message_body: "Checking back in about the property", metadata: { source } }, { supabase: db });
      assert.equal(r.ok, false); assert.equal(r.blocked, true); assert.equal(r.reason, "automation_hold");
    }
    assert.equal(db.rows("send_queue").length, 0);
  });
}

test("(vi) a property-only campaign row (no thread yet) on a held property is refused", async () => {
  const db = makeHoldFakeDb(seedContainment());
  const r = await insertSupabaseSendQueueRow({ queue_key: "camp:prop", queue_status: "queued", property_id: IDS.H_PROP, to_phone_number: "+15550000003", from_phone_number: "+15550000002", message_body: "Do you still own the property?", metadata: { source: "campaign_launch_execution" } }, { supabase: db });
  assert.equal(r.reason, "automation_hold");
});

test("(v) a NON-sendable audit row is still allowed (ingestion and history are never blocked)", async () => {
  const db = makeHoldFakeDb(seedContainment());
  const r = await insertSupabaseSendQueueRow({ queue_key: "audit:h", queue_status: "paused_operator_review", thread_key: IDS.H_TK, to_phone_number: IDS.H_TK, from_phone_number: "+15550000002", message_body: "held for review" }, { supabase: db });
  assert.equal(r.ok, true); assert.equal(db.rows("send_queue").length, 1);
});

// ── 7. manual sends: explicit audited override only ────────────────────────

test("manual send-now on a held thread is refused without an override, before any queue row or provider call", async () => {
  const db = makeHoldFakeDb(seedContainment());
  let created = 0, provider = 0;
  const deps = { supabase: db, getSystemValue: LIVE_CONTROL, createQueueRowImpl: async () => { created += 1; return { ok: false }; }, sendTextgridImpl: async () => { provider += 1; } };
  for (const override of [undefined, { approval_ref: "APR-1", reason: "call back" }]) {
    const r = await executeManualInboxSendNow({ thread_key: IDS.H_TK, property_id: IDS.H_PROP, message_body: "I can do $315K", to_phone_number: IDS.H_TK, automation_hold_override: override }, deps);
    assert.equal(r.ok, false); assert.equal(r.status, 423); assert.equal(r.reason, "automation_hold_requires_override");
  }
  assert.equal(created, 0); assert.equal(provider, 0);
});

test("manual send-now WITH a complete override proceeds, carries the override on the row and is audited", async () => {
  const db = makeHoldFakeDb(seedContainment());
  let seen = null;
  const deps = { supabase: db, getSystemValue: LIVE_CONTROL, createQueueRowImpl: async (input) => { seen = input; return { ok: false, reason: "stop_here_for_test" }; } };
  const override = { approval_ref: "APR-9", reason: "owner approved call-back", operator_id: "op_owner" };
  await executeManualInboxSendNow({ thread_key: IDS.H_TK, property_id: IDS.H_PROP, message_body: "Calling you back now", to_phone_number: IDS.H_TK, automation_hold_override: override }, deps);
  assert.equal(seen?.metadata?.automation_hold_override?.approval_ref, "APR-9");
  const ev = db.rows("automation_hold_events").find((e) => e.event_type === "override_used");
  assert.equal(ev.approval_ref, "APR-9"); assert.equal(ev.actor, "op_owner"); assert.equal(ev.capability, "manual_send");
  // the enqueue chokepoint accepts the manual row only with that override
  const ok = await insertSupabaseSendQueueRow({ queue_key: "m:1", queue_status: "queued", thread_key: IDS.H_TK, to_phone_number: IDS.H_TK, from_phone_number: "+15550000002", message_body: "Calling you back now", message_type: "manual_reply", metadata: { source: "manual_inbox", manual_operator_send: true, automation_hold_override: override } }, { supabase: db });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const no = await insertSupabaseSendQueueRow({ queue_key: "m:2", queue_status: "queued", thread_key: IDS.H_TK, to_phone_number: IDS.H_TK, from_phone_number: "+15550000002", message_body: "Calling you back now", message_type: "manual_reply", metadata: { source: "manual_inbox", manual_operator_send: true } }, { supabase: db });
  assert.equal(no.reason, "automation_hold_requires_override");
});

// ── 8. (vii) lookup failure fails closed on every path ─────────────────────

test("(vii) hold lookup failure: acceptance, transition, enqueue and dispatch all refuse — even for the CONTROL deal", async () => {
  const db = makeHoldFakeDb(seedContainment({ holds: false }));
  await seedControlOffer(db);
  db.options.rpcError = "statement timeout";
  const f = await finalizeSellerAcceptance({ opportunity_id: IDS.C_OPP, thread_key: IDS.C_TK, acceptance_event_id: "evt-c-fail", acceptance_at: later(), supabase: db });
  assert.equal(f.ok, false); assert.equal(f.offer_accepted, false); assert.ok(f.review_reasons.includes("automation_hold_lookup_failed"));
  const t = await persistSellerTransitionArtifacts({ transition: { stage_after: "offer", stage_after_number: 5, reasoning_code: "x", facts_patch: {} }, threadKey: IDS.C_TK, propertyId: IDS.C_PROP, intent: "seller_interested", supabaseClient: db });
  assert.equal(t.reason, "automation_hold_lookup_failed");
  const q = await insertSupabaseSendQueueRow({ queue_key: "c:1", queue_status: "queued", thread_key: IDS.C_TK, to_phone_number: IDS.C_TK, from_phone_number: "+15550000002", message_body: "Hello there, following up" }, { supabase: db });
  assert.equal(q.reason, "automation_hold_lookup_failed");
  const d = await processSendQueueItem({ id: "q-c", queue_status: "queued", thread_key: IDS.C_TK, to_phone_number: IDS.C_TK, message_body: "x", metadata: {} }, { supabase: db, getSystemValue: LIVE_CONTROL, sendTextgridSMS: async () => assert.fail("provider must not be called") });
  assert.equal(d.reason, "automation_hold_lookup_failed");
  assert.equal(db.rows("seller_offers").find((o) => o.opportunity_id === IDS.C_OPP).status, "active");
});

// ── 9. rule-based acceptance guard (exposure audit 2026-10-16) ─────────────

test("CONTROL: a non-held autopilot offer within MAO and ceiling, valuation present, live opportunity -> auto-accepts + one closing case", async () => {
  const db = makeHoldFakeDb(seedContainment());
  const seeded = await seedControlOffer(db);
  const r = await finalizeSellerAcceptance({ opportunity_id: IDS.C_OPP, thread_key: IDS.C_TK, acceptance_event_id: "evt-c-yes", acceptance_at: later(), supabase: db });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.offer_accepted, true); assert.equal(r.offer_id, seeded.offer_id);
  assert.equal(r.closing_case_created, true, JSON.stringify(r));
  assert.equal(db.rows("closing_cases").length, 1);
  const t = await persistSellerTransitionArtifacts({ transition: { stage_after: "offer", stage_after_number: 5, reasoning_code: "x", facts_patch: {} }, threadKey: IDS.C_TK, propertyId: IDS.C_PROP, intent: "seller_interested", supabaseClient: db });
  assert.notEqual(t.reason, "automation_hold");
});

const RULE_CASES = [
  ["operator-originated offer", (s) => { s.offer.metadata = { offer_event: { source: "operator", operator_id: "operator_unattributed" } }; }, "operator_originated_offer"],
  ["offer of unverified origin (no ADE snapshot)", (s) => { s.offer.ade_snapshot_id = null; }, "offer_origin_unverified"],
  ["price above MAO", (s) => { s.score.minimum_acceptable_offer = 90000; }, "price_above_mao"],
  ["price above authorized ceiling", (s) => { s.offer.authorized_ceiling = 95000; }, "price_above_authorized_ceiling"],
  ["valuation missing", (s) => { s.score = null; }, "valuation_missing"],
  ["opportunity archived", (s) => { s.opportunity.opportunity_status = "archived"; }, "opportunity_inactive:archived"],
  ["opportunity dead", (s) => { s.opportunity.opportunity_status = "dead"; }, "opportunity_inactive:dead"],
  ["opportunity suppressed", (s) => { s.opportunity.opportunity_status = "suppressed"; }, "opportunity_inactive:suppressed"],
  ["opportunity automation cancelled", (s) => { s.opportunity.automation_state = "cancelled"; }, "opportunity_automation_cancelled"],
  ["automation hold applies", (s) => { s.hold = { held: true, fail_closed: false }; }, "automation_hold"],
];
const baseRuleState = () => ({
  offer: { offer_id: "o1", direction: "outbound", offer_type: "initial_offer", purchase_price: 100000, authorized_ceiling: 120000, ade_snapshot_id: "ade:1", metadata: {} },
  opportunity: { opportunity_status: "active", automation_state: "running", metadata: {} },
  score: { minimum_acceptable_offer: 110000, valuation_mid: 180000, evidence: { offer_calculation: { effective_authorized_ceiling: 125000 } } },
  hold: { held: false },
});
test("acceptance rules: the control state is allowed", () => {
  const v = evaluateAcceptanceRules(baseRuleState());
  assert.equal(v.allowed, true, JSON.stringify(v));
});
for (const [label, mutate, reason] of RULE_CASES) {
  test(`acceptance rules route to HUMAN REVIEW: ${label}`, () => {
    const s = baseRuleState(); mutate(s);
    const v = evaluateAcceptanceRules(s);
    assert.equal(v.allowed, false); assert.ok(v.reasons.includes(reason), `${reason} in ${v.reasons}`);
  });
}
test("acceptance rules end-to-end: each rule refuses through finalizeSellerAcceptance on the otherwise-control deal, records evidence, flags human review", async () => {
  for (const [label, patch] of [
    ["operator offer", (db) => { db.rows("seller_offers").find((o) => o.opportunity_id === IDS.C_OPP && o.status === "active").metadata = { offer_event: { source: "operator" } }; }],
    ["above MAO", (db) => { db.rows("property_acquisition_scores").find((s) => s.property_id === IDS.C_PROP).minimum_acceptable_offer = 50000; }],
    ["no valuation", (db) => { db.rows("property_acquisition_scores").splice(1, 1); }],
    ["archived", (db) => { db.rows("acquisition_opportunities").find((o) => o.id === IDS.C_OPP).opportunity_status = "archived"; }],
  ]) {
    const db = makeHoldFakeDb(seedContainment());
    await seedControlOffer(db);
    patch(db);
    const r = await finalizeSellerAcceptance({ opportunity_id: IDS.C_OPP, thread_key: IDS.C_TK, acceptance_event_id: `evt-${label}`, acceptance_at: later(), supabase: db });
    assert.equal(r.routed_to_human_review, true, label); assert.equal(r.offer_accepted, false, label);
    assert.equal(db.rows("closing_cases").length, 0, label);
    assert.equal(db.rows("seller_offers").find((o) => o.opportunity_id === IDS.C_OPP).status, "active", label);
    const opp = db.rows("acquisition_opportunities").find((o) => o.id === IDS.C_OPP);
    assert.equal(opp.next_action, "human_review", label);
    assert.equal(opp.metadata.acceptance_review.outcome, "routed_to_human_review", label);
    assert.equal(db.rows("automation_hold_events").filter((e) => e.event_type === "acceptance_routed_to_human_review").length, 1, label);
  }
});

test("the five exposed production offers (exposure audit) are ALL routed to review with no hold row", () => {
  const op = { offer_event: { source: "operator", operator_id: "operator_unattributed" } };
  const cases = [
    ["93790b80 Hartford", 315000, 97500, 126100, "archived", "cancelled"],
    ["9c3ef940 (0c651e16)", 825000, 168400, 601700, "nurture", "inactive"],
    ["cf31dd5c (3d5c9437)", 222000, 207100, null, "archived", "inactive"],
    ["f3d6f3f7 (950304c3)", 55000, 27800, null, "active", "inactive"],
    ["8f11e8d0 (e1db7c94)", 132000, 137200, null, "active", "inactive"],
  ];
  for (const [label, price, mao, ceiling, status, auto] of cases) {
    const v = evaluateAcceptanceRules({
      offer: { offer_type: "cash", direction: "outbound", purchase_price: price, authorized_ceiling: null, ade_snapshot_id: null, metadata: op },
      opportunity: { opportunity_status: status, automation_state: auto, metadata: {} },
      score: { minimum_acceptable_offer: mao, valuation_mid: price, evidence: { offer_calculation: { effective_authorized_ceiling: ceiling } } },
      hold: { held: false },
    });
    assert.equal(v.allowed, false, label);
    assert.ok(v.reasons.includes("operator_originated_offer"), label);
    if (price > mao) assert.ok(v.reasons.includes("price_above_mao"), label);
  }
  assert.equal(isOperatorOriginatedOffer({ metadata: op }), true);
  assert.equal(isOperatorOriginatedOffer({ ade_snapshot_id: "x", metadata: {} }), false);
});

// ── 10. static permanent exclusion (Maxwell) — independent of the database ───

test("Maxwell's permanent exclusion holds with NO registry row and even while the hold RPC is down", async () => {
  const { STATIC_PERMANENT_EXCLUSIONS, isOwnerHandledThread, staticExclusionFor } = await import("@/lib/domain/holds/automation-hold.js");
  assert.equal(STATIC_PERMANENT_EXCLUSIONS.length, 1);
  const db = makeHoldFakeDb(seedContainment({ holds: false }));
  db.options.rpcError = "down";
  for (const cap of Object.values(HOLD_CAPABILITIES)) {
    const r = await resolveAutomationHold({ property_id: IDS.M_PROP }, { capability: cap, supabase: db });
    assert.equal(r.held, true, cap); assert.equal(r.fail_closed, false, cap); assert.equal(r.static_exclusion, "owner_handled_20261014:maxwell");
  }
  assert.equal(isOwnerHandledThread({ property_address: "3746 Baltimore Ave, Indianapolis, IN" }), true);
  assert.equal(isOwnerHandledThread({ property_address: "1 Control St" }), false);
  assert.equal(matchAutomationHolds([], { property_id: IDS.M_PROP }, HOLD_CAPABILITIES.CAMPAIGN).length, 1, "batch paths see it too");
  assert.equal(staticExclusionFor({ property_id: IDS.H_PROP }), null, "Hartford is a reversible registry hold, not static");
  const t = await persistSellerTransitionArtifacts({ transition: { stage_after: "offer", stage_after_number: 5, reasoning_code: "x", facts_patch: {} }, threadKey: IDS.M_TK, propertyId: IDS.M_PROP, intent: "seller_interested", supabaseClient: db });
  assert.equal(t.reason, "automation_hold");
});
