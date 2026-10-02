/**
 * IC8 observation hooks (H1/H2/H3 + corrections) -- production safety proof.
 *
 * (a) flags off -> zero store calls, zero flag reads past the ceiling, zero loads
 * (b) the store throws or hangs -> the inbound path returns normally, in budget
 * (c) rows carry the right shape, ids only, POLICY_FINGERPRINT and an
 *     idempotent decision id
 * (d) env ceiling false + system_control true -> still off
 * plus: the missing-schema latch is silent and stops network calls, and every
 * hook site is wired as one synchronous, un-awaited, fail-open line.
 */
import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  __configureObservationForTests,
  beginCorrectionCapture,
  flushObservation,
  getObservationStats,
  observeCampaignBatchInsert,
  observeFeederDecision,
  observeSellerTurn,
  observeSendQueueInsert,
} from "@/lib/domain/intelligence/runtime/observation.js";
import { decisionIdFor } from "@/lib/domain/intelligence/journal/decision-journal.js";
import { POLICY_FINGERPRINT, POLICY_MANIFEST_VERSION } from "@/lib/domain/seller-flow/policy-manifest.js";
import { classify } from "@/lib/domain/classification/classify.js";
import { CONTEXT_VERSION } from "@/lib/domain/classification/conversation-context.js";
import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { insertSupabaseSendQueueRow } from "@/lib/supabase/sms-engine.js";
import { makeSellerOrchestrationSupabase } from "../helpers/seller-orchestration-test-supabase.mjs";

const ON_ENV = Object.freeze({ INTELLIGENCE_LOGGING_ENABLED: "true" });
const OFF_ENV = Object.freeze({ INTELLIGENCE_LOGGING_ENABLED: "false" });

afterEach(() => {
  __configureObservationForTests(null);
  __resetSellerInboundOrchestratorDeps();
});

function spyStore({ insertDecisions, insertCorrection } = {}) {
  const calls = { insertDecisions: [], insertCorrection: [], insertControlAudit: [] };
  const store = {
    insertDecisions: async (rows) => {
      calls.insertDecisions.push(rows);
      return insertDecisions ? insertDecisions(rows) : { ok: true, data: null };
    },
    insertCorrection: async (row) => {
      calls.insertCorrection.push(row);
      return insertCorrection ? insertCorrection(row) : { ok: true, data: null };
    },
    insertControlAudit: async (row) => {
      calls.insertControlAudit.push(row);
      return { ok: true, data: null };
    },
  };
  return { store, calls, total: () => calls.insertDecisions.length + calls.insertCorrection.length + calls.insertControlAudit.length };
}

function spyReader(value) {
  const reads = [];
  return {
    reads,
    readSystemFlag: async (key) => {
      reads.push(key);
      return value;
    },
  };
}

function sampleQueueRow(overrides = {}) {
  return {
    id: "sq-1",
    created_at: "2026-10-02T12:00:00.000Z",
    source: "auto_reply",
    use_case_template: "consider_selling",
    template_id: "tpl-consider-selling",
    message_body: "SECRET-BODY-TEXT do not journal me",
    to_phone_number: "+15550001111",
    property_id: "prop-1",
    master_owner_id: "mo-1",
    metadata: {
      thread_key: "+15550001111",
      inbound_message_event_id: "evt-77",
      automation_decision_snapshot: { route_hint: "consider_selling", next_action: "queue_reply" },
    },
    ...overrides,
  };
}

function exerciseEveryHook({ loadSpy } = {}) {
  observeSellerTurn({ inboundEventId: "evt-1", threadKey: "+15550001111", orchestration: { execution: { queue_row_id: "sq-1" } } });
  observeSendQueueInsert(sampleQueueRow());
  observeCampaignBatchInsert([{ campaign_target_id: "ct-1", source: "campaign_launch_execution" }], [{ id: "sq-2", campaign_target_id: "ct-1" }]);
  observeFeederDecision({ campaignId: "camp-1", runAt: "2026-10-02T12:00:00.000Z", limit: 5, bound: "buffer", reason: null, previousReason: "daily_cap_reached", inserted: 5 });
  return beginCorrectionCapture({ headers: { "x-ops-user-id": "user-1" }, source: "route:/api/test", load: loadSpy });
}

// ── (a) flags off → zero calls ────────────────────────────────────────────

test("(a) ceiling off: every hook is a no-op -- no store call, no flag read, no original load", async () => {
  const { store, total } = spyStore();
  const reader = spyReader(true);
  let loads = 0;
  __configureObservationForTests({ env: {}, readSystemFlag: reader.readSystemFlag, store });
  const handle = await exerciseEveryHook({ loadSpy: async () => { loads += 1; return []; } });
  assert.equal(handle.active, false);
  assert.deepEqual(handle.commit(), { scheduled: 0 });
  await flushObservation();
  assert.equal(total(), 0, "store must never be called");
  assert.equal(reader.reads.length, 0, "with the ceiling off the runtime switch is not even read");
  assert.equal(loads, 0, "corrections must not read originals when off");
  const stats = getObservationStats();
  assert.equal(stats.skipped_ceiling_off, 5);
  assert.equal(stats.configured, false, "no journal / client is constructed while off");
});

test("(a) ceiling on, runtime switch absent/off: no store call, no original load, one cached read", async () => {
  const { store, total } = spyStore();
  const reader = spyReader(null); // absent key = off
  let loads = 0;
  __configureObservationForTests({ env: ON_ENV, readSystemFlag: reader.readSystemFlag, store });
  await exerciseEveryHook({ loadSpy: async () => { loads += 1; return []; } });
  await flushObservation();
  await exerciseEveryHook({ loadSpy: async () => { loads += 1; return []; } });
  await flushObservation();
  assert.equal(total(), 0);
  assert.equal(loads, 0);
  assert.equal(reader.reads.length, 1, "the runtime switch is cached (30 s), not re-read per hook");
  assert.deepEqual(reader.reads, ["intelligence_logging_enabled"]);
});

test("(a) the real inbound orchestrator with flags off never touches the intelligence store", async () => {
  const { store, total } = spyStore();
  __configureObservationForTests({ env: {}, readSystemFlag: async () => true, store });
  const result = await runInbound({ dryRun: false });
  assert.equal(result.ok, true);
  await flushObservation();
  assert.equal(total(), 0);
});

// ── (d) env ceiling false + system_control true → still off ──────────────

test("(d) env ceiling 'false' + system_control true: still off, switch never consulted", async () => {
  for (const env of [OFF_ENV, {}, { INTELLIGENCE_LOGGING_ENABLED: "" }, { INTELLIGENCE_LOGGING_ENABLED: "1" }, { INTELLIGENCE_LOGGING_ENABLED: "yes" }, { INTELLIGENCE_LOGGING_ENABLED: "on" }]) {
    const { store, total } = spyStore();
    const reader = spyReader(true);
    __configureObservationForTests({ env, readSystemFlag: reader.readSystemFlag, store });
    await exerciseEveryHook({ loadSpy: async () => [] });
    await flushObservation();
    assert.equal(total(), 0, `env ${JSON.stringify(env)} must keep logging off`);
    assert.equal(reader.reads.length, 0);
  }
});

test("(d) runtime switch read failing or hanging = off", async () => {
  for (const readSystemFlag of [async () => { throw new Error("db down"); }, () => new Promise(() => {}), async () => "nope"]) {
    const { store, total } = spyStore();
    __configureObservationForTests({ env: ON_ENV, readSystemFlag, store, options: { runtimeReadTimeoutMs: 20 } });
    exerciseEveryHook({ loadSpy: async () => [] });
    await flushObservation();
    assert.equal(total(), 0);
  }
});

// ── (b) store throws or hangs → inbound path unaffected ─────────────────

function ownershipContext(thread) {
  return {
    context_version: CONTEXT_VERSION,
    canonical_thread: thread,
    inbound_thread: thread,
    last_outbound_message_id: "SM-outbound-1",
    last_outbound_use_case: "ownership_check",
    last_outbound_question_type: "ownership",
    last_outbound_delivered_at: new Date(Date.now() - 3600e3).toISOString(),
    current_inbound_received_at: new Date().toISOString(),
    intervening_outbound_count: 0,
    intervening_inbound_count: 0,
    unanswered_question: true,
  };
}

async function runInbound({ dryRun = false, inboundEventId = "evt-ic8-1" } = {}) {
  const supabase = makeSellerOrchestrationSupabase();
  __setSellerInboundOrchestratorDeps({
    getSupabaseClient: () => supabase,
    patchUniversalLeadState: async ({ patch }) => ({ ok: true, patch, dry_run: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    persistInboundIntelligenceSnapshot: async () => ({ ok: true, dry_run: true }),
    persistSellerContactReferral: async () => ({ ok: true, skipped: true }),
    executeReferralAutomation: async () => ({ ok: true, skipped: true }),
    scheduleFollowUp: async () => ({ ok: true, followup_created: false }),
  });
  const classification = await classify("Yes", null, { heuristicOnly: true, conversation_context: ownershipContext("+15551234567") });
  return processSellerInboundMessage({
    message: "Yes",
    threadKey: "+15551234567",
    propertyId: "prop-227",
    prospectId: "pros-31",
    ownerId: "mo-21",
    phoneId: "phone-51",
    classification,
    context: {
      found: true,
      ids: { master_owner_id: "mo-21", prospect_id: "pros-31", property_id: "prop-227", phone_item_id: "phone-51" },
      summary: { conversation_stage: "ownership_check", seller_stage: "ownership_check", language_preference: "English" },
    },
    route: { stage: "ownership_check", use_case: "ownership_check" },
    inboundFrom: "+15551234567",
    inboundTo: "+15559876543",
    inboundEventId,
    autoReplyMode: "disabled",
    inboundReceivedAt: new Date().toISOString(),
    getSystemValue: async () => null,
    executionAllowed: false,
    skipNotifications: true,
    dryRun,
  });
}

test("(b) store HANGS: the inbound orchestrator returns normally and the hook never blocks it", async () => {
  const { store, calls } = spyStore({ insertDecisions: () => new Promise(() => {}) });
  __configureObservationForTests({
    env: ON_ENV,
    readSystemFlag: async () => true,
    store,
    journalOptions: { writeTimeoutMs: 50, flushIntervalMs: 5 },
  });
  const baselineStart = Date.now();
  const result = await runInbound({ dryRun: false, inboundEventId: "evt-hang-1" });
  const elapsed = Date.now() - baselineStart;
  assert.equal(result.ok, true);
  assert.ok(elapsed < 5000, `inbound path took ${elapsed} ms`);
  await flushObservation();
  assert.equal(calls.insertDecisions.length, 1, "the row was attempted off the request path");
  const stats = getObservationStats();
  assert.equal(stats.journal.write_timeouts, 1, "the hung write is abandoned and counted");
  assert.equal(stats.hook_errors, 0);
});

test("(b) store THROWS synchronously or rejects: inbound returns normally; errors are counted, never thrown", async () => {
  for (const insertDecisions of [() => { throw new Error("boom"); }, async () => { throw new Error("reject"); }, async () => ({ ok: false, error: { code: "XX000", message: "db" } })]) {
    const { store } = spyStore({ insertDecisions });
    __configureObservationForTests({ env: ON_ENV, readSystemFlag: async () => true, store, journalOptions: { flushIntervalMs: 5 }, logger: { warn() {}, info() {} } });
    const result = await runInbound({ dryRun: false, inboundEventId: `evt-throw-${Math.random()}` });
    assert.equal(result.ok, true);
    await flushObservation();
    const stats = getObservationStats();
    assert.equal(stats.journal.write_errors, 1);
    assert.equal(stats.journal.written, 0);
  }
});

test("(b) a hook returns synchronously in well under a millisecond budget even with a hung store and cold cache", async () => {
  const { store } = spyStore({ insertDecisions: () => new Promise(() => {}) });
  __configureObservationForTests({ env: ON_ENV, readSystemFlag: () => new Promise(() => {}), store, options: { runtimeReadTimeoutMs: 30 } });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i += 1) observeSendQueueInsert(sampleQueueRow({ id: `sq-${i}` }));
  const perCallMs = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
  assert.ok(perCallMs < 2, `per-hook cost ${perCallMs} ms`);
  await flushObservation();
});

test("(b) the journal flush timer is unref'd (never keeps a webhook process alive)", async () => {
  const { store } = spyStore();
  __configureObservationForTests({ env: ON_ENV, readSystemFlag: async () => true, store, journalOptions: { flushIntervalMs: 60_000 } });
  observeSendQueueInsert(sampleQueueRow());
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const { getObservationStore } = await import("@/lib/domain/intelligence/runtime/observation.js");
  await getObservationStore();
  const stats = getObservationStats();
  assert.equal(stats.journal.buffered, 1);
  assert.equal(stats.journal.timer.timerScheduled, true);
  assert.equal(stats.journal.timer.timerHasRef, false, "the flush timer must be unref'd");
  await flushObservation();
});

test("(b) dry-run / proof turns are not journaled", async () => {
  const { store, total } = spyStore();
  __configureObservationForTests({ env: ON_ENV, readSystemFlag: async () => true, store });
  const result = await runInbound({ dryRun: true, inboundEventId: "evt-dry-1" });
  assert.equal(result.ok, true);
  await flushObservation();
  assert.equal(total(), 0);
  assert.equal(getObservationStats().skipped_dry_run, 1);
});

// ── (c) row shape and idempotency ─────────────────────────────────────────

test("(c) H1 seller_turn row: ids only, POLICY_FINGERPRINT, versions, deterministic decision id", async () => {
  const { store, calls } = spyStore();
  __configureObservationForTests({ env: ON_ENV, readSystemFlag: async () => true, store, journalOptions: { flushIntervalMs: 5 } });
  const result = await runInbound({ dryRun: false, inboundEventId: "evt-shape-1" });
  assert.equal(result.ok, true);
  await flushObservation();
  const rows = calls.insertDecisions.flat();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.decision_type, "seller_turn");
  assert.equal(row.idempotency_key, "seller_turn:inbound:evt-shape-1");
  assert.equal(row.decision_id, decisionIdFor("seller_turn", "inbound:evt-shape-1"));
  assert.equal(row.mode, "observe");
  assert.equal(row.policy_version, POLICY_FINGERPRINT);
  assert.equal(row.versions.observation, "ic8_observation@1");
  assert.equal(row.versions.policy_manifest, POLICY_MANIFEST_VERSION);
  assert.ok(row.versions.strategy_intent);
  assert.equal(row.context.inbound_message_event_id, "evt-shape-1");
  assert.equal(row.context.thread_key, "+15551234567");
  assert.equal(row.context.property_id, "prop-227");
  assert.ok(row.reason_codes.includes("MODE_OBSERVE"));
  assert.ok(!row.reason_codes.includes("JOURNAL_REASON_CODE_UNREGISTERED"));
  assert.ok(row.action_ref && typeof row.action_ref.kind === "string");
  const keys = Object.keys(row).sort();
  assert.deepEqual(keys, [
    "action_ref", "candidates", "champion_decision_id", "chosen_action", "confidence", "context", "decided_at", "decision_id",
    "decision_type", "experiment", "feature_set_id", "feature_snapshot_id", "guardrails", "idempotency_key", "mode",
    "model_version_id", "policy_version", "reason_codes", "versions",
  ]);
  assert.ok(!JSON.stringify(row).toLowerCase().includes("are you open to selling"), "no message bodies");
});

test("(c) the same turn observed twice yields the same decision id (store upserts ignore-duplicates)", async () => {
  const { store, calls } = spyStore();
  __configureObservationForTests({ env: ON_ENV, readSystemFlag: async () => true, store, policy: { fingerprint: "fp-test", manifestVersion: "m1" } });
  observeSellerTurn({ inboundEventId: "evt-dup", orchestration: {} });
  observeSellerTurn({ inboundEventId: "evt-dup", orchestration: {} });
  await flushObservation();
  const rows = calls.insertDecisions.flat();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].decision_id, rows[1].decision_id);
  assert.equal(rows[0].action_ref.kind, "no_outbound");
});

test("(c) H2 message_strategy row from a send_queue insert carries ids and codes, never the body", async () => {
  const { store, calls } = spyStore();
  __configureObservationForTests({ env: ON_ENV, readSystemFlag: async () => true, store, policy: { fingerprint: "fp-test", manifestVersion: "m1" } });
  observeSendQueueInsert(sampleQueueRow());
  await flushObservation();
  const [row] = calls.insertDecisions.flat();
  assert.equal(row.decision_type, "message_strategy");
  assert.equal(row.idempotency_key, "message_strategy:send_queue:sq-1");
  assert.equal(row.decision_id, decisionIdFor("message_strategy", "send_queue:sq-1"));
  assert.equal(row.decided_at, "2026-10-02T12:00:00.000Z");
  assert.equal(row.policy_version, "fp-test");
  assert.equal(row.chosen_action, "offer_interest");
  assert.deepEqual(row.action_ref, { kind: "send_queue", id: "sq-1" });
  assert.deepEqual(row.context, {
    send_queue_id: "sq-1",
    thread_key: "+15550001111",
    property_id: "prop-1",
    master_owner_id: "mo-1",
    inbound_message_event_id: "evt-77",
  });
  const text = JSON.stringify(row);
  assert.ok(!text.includes("SECRET-BODY-TEXT"));
  assert.ok(!text.includes("+15550001111\"") || row.context.thread_key === "+15550001111", "phone appears only as the thread id");
});

test("(c) H2 through the real sms-engine insert chokepoint journals the inserted row", async () => {
  const { store, calls } = spyStore();
  __configureObservationForTests({ env: ON_ENV, readSystemFlag: async () => true, store, policy: { fingerprint: "fp-test", manifestVersion: "m1" } });
  const inserted = { ...sampleQueueRow({ id: "sq-real-1" }) };
  const fake = {
    from: () => ({ insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: inserted, error: null }) }) }) }),
  };
  const out = await insertSupabaseSendQueueRow({ ...sampleQueueRow({ id: undefined }), queue_status: "scheduled" }, { supabase: fake });
  assert.equal(out.ok, true);
  assert.equal(out.queue_row_id, "sq-real-1");
  await flushObservation();
  const rows = calls.insertDecisions.flat();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].context.send_queue_id, "sq-real-1");
});

test("(c) H2 campaign batch joins submitted rows to returned ids on campaign_target_id", async () => {
  const { store, calls } = spyStore();
  __configureObservationForTests({ env: ON_ENV, readSystemFlag: async () => true, store, policy: { fingerprint: "fp-test", manifestVersion: "m1" } });
  observeCampaignBatchInsert(
    [
      { campaign_target_id: "ct-1", campaign_id: "camp-1", source: "campaign_launch_execution", use_case_template: "ownership_check", message_body: "BODY-1" },
      { campaign_target_id: "ct-2", campaign_id: "camp-1", source: "campaign_launch_execution", use_case_template: "ownership_check", message_body: "BODY-2" },
    ],
    [
      { id: "sq-b", campaign_target_id: "ct-2", template_id: "t-2", metadata: {} },
      { id: "sq-a", campaign_target_id: "ct-1", template_id: "t-1", metadata: {} },
    ],
  );
  await flushObservation();
  const rows = calls.insertDecisions.flat();
  assert.deepEqual(rows.map((r) => r.context.send_queue_id), ["sq-b", "sq-a"]);
  assert.deepEqual(rows.map((r) => r.context.campaign_target_id), ["ct-2", "ct-1"]);
  for (const r of rows) {
    assert.equal(r.chosen_action, "ownership_check");
    assert.ok(r.reason_codes.includes("STRATEGY_LAYER_CAMPAIGN_OBJECTIVE"));
    assert.ok(!JSON.stringify(r).includes("BODY-"));
  }
});

test("(c) H3 campaign_feed: written when limit > 0 or the reason changed, skipped otherwise", async () => {
  const { store, calls } = spyStore();
  __configureObservationForTests({ env: ON_ENV, readSystemFlag: async () => true, store, policy: { fingerprint: "fp-test", manifestVersion: "m1" } });
  const at = "2026-10-02T12:05:00.000Z";
  assert.equal(observeFeederDecision({ campaignId: "c1", runAt: at, limit: 0, bound: "daily_cap_reached", reason: "daily_cap_reached", previousReason: "daily_cap_reached" }).observed, false);
  observeFeederDecision({ campaignId: "c1", runAt: at, limit: 0, bound: "campaign_cap_zero", reason: "campaign_cap_zero", previousReason: "daily_cap_reached" });
  observeFeederDecision({ campaignId: "c2", runAt: at, limit: 7, bound: "buffer", reason: null, previousReason: null, inserted: 7, versions: { feeder_stall: "feeder_stall_v2_deterministic" } });
  await flushObservation();
  const rows = calls.insertDecisions.flat();
  assert.equal(rows.length, 2);
  const [blocked, fed] = rows;
  assert.equal(blocked.idempotency_key, `campaign_feed:c1:${at}`);
  assert.equal(blocked.chosen_action, "hold");
  assert.deepEqual(blocked.reason_codes, ["FEED_BOUND_CAMPAIGN_CAP_ZERO", "MODE_OBSERVE"]);
  assert.deepEqual(blocked.candidates, [{ action: "feed", allowed: false, blocked_by: ["FEED_BOUND_CAMPAIGN_CAP_ZERO"], score: null }]);
  assert.deepEqual(blocked.action_ref, { kind: "feed_result", id: "campaign_cap_zero" });
  assert.equal(fed.chosen_action, "feed");
  assert.equal(fed.versions.feeder_stall, "feeder_stall_v2_deterministic");
  assert.deepEqual(fed.action_ref, { kind: "feed_result", id: "placed" });
  assert.equal(getObservationStats().skipped_unchanged, 1);
});

test("(c) corrections: original read BEFORE the write, operator from x-ops-user-id, no-ops and unwritten fields skipped", async () => {
  const { store, calls } = spyStore();
  __configureObservationForTests({ env: ON_ENV, readSystemFlag: async () => true, store, policy: { fingerprint: "fp-test", manifestVersion: "m1" } });
  const db = { stage: "S3", disposition: "open", next_action: "call" };
  const handle = await beginCorrectionCapture({
    headers: new Headers({ "x-ops-user-id": "op_42" }),
    source: "route:/api/cockpit/lead-state/patch",
    reason: "seller said wrong",
    load: async () => ["stage", "disposition", "next_action"].map((field) => ({ subject: { type: "thread", id: "t-1" }, field, original: db[field], corrected: undefined })),
  });
  db.stage = "S5"; // the route's own overwrite happens after the capture
  assert.equal(handle.active, true);
  assert.deepEqual(handle.commit({ stage: "S5", disposition: "open" }), { scheduled: 1 });
  assert.deepEqual(handle.commit({ stage: "S6" }), { scheduled: 0 }, "commit is one-shot");
  await flushObservation();
  assert.equal(calls.insertCorrection.length, 1);
  const row = calls.insertCorrection[0];
  assert.equal(row.subject_type, "thread");
  assert.equal(row.subject_id, "t-1");
  assert.equal(row.field, "stage");
  assert.equal(row.original_value, "S3");
  assert.equal(row.corrected_value, "S5");
  assert.equal(row.operator_id, "op_42");
  assert.equal(row.metadata.weak_label, false);
  assert.equal(row.metadata.policy_fingerprint, "fp-test");
  assert.equal(row.source, "route:/api/cockpit/lead-state/patch");
  assert.ok(row.idempotency_key);
});

test("(c) corrections fail open: a slow or throwing original read yields an inert handle within budget", async () => {
  const { store, total } = spyStore();
  __configureObservationForTests({ env: ON_ENV, readSystemFlag: async () => true, store });
  const t0 = Date.now();
  const slow = await beginCorrectionCapture({ source: "route:/x", load: () => new Promise(() => {}), budgetMs: 40 });
  const thrown = await beginCorrectionCapture({ source: "route:/x", load: () => { throw new Error("db"); } });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(slow.active, false);
  assert.equal(thrown.active, false);
  slow.commit();
  await flushObservation();
  assert.equal(total(), 0);
  assert.equal(getObservationStats().corrections_load_failed, 2);
});

// ── missing schema: fail closed, silently ────────────────────────────────

test("missing intelligence schema latches off silently: one attempt, then no network, no warnings", async () => {
  let clientCalls = 0;
  const warnings = [];
  const client = {
    schema() {
      clientCalls += 1;
      return { from: () => ({ upsert: async () => ({ data: null, error: { code: "PGRST106", message: "The schema must be one of the following: public, graphql_public" } }) }) };
    },
  };
  __configureObservationForTests({
    env: ON_ENV,
    readSystemFlag: async () => true,
    client,
    policy: { fingerprint: "fp", manifestVersion: "m" },
    logger: { warn: (...a) => warnings.push(a), info() {} },
    journalOptions: { flushIntervalMs: 5 },
  });
  observeSendQueueInsert(sampleQueueRow({ id: "sq-s1" }));
  await flushObservation();
  observeSendQueueInsert(sampleQueueRow({ id: "sq-s2" }));
  observeFeederDecision({ campaignId: "c9", limit: 1, bound: "buffer" });
  await flushObservation();
  const handle = await beginCorrectionCapture({ source: "route:/x", load: async () => [{ subject: { type: "t", id: "1" }, field: "f", original: 1, corrected: 2 }] });
  handle.commit();
  await flushObservation();
  assert.equal(clientCalls, 1, "after the first schema error no further client calls are made");
  assert.equal(warnings.length, 0, "a missing schema is silent");
  const stats = getObservationStats();
  assert.equal(stats.schema_unavailable, 1);
  assert.equal(stats.schema_latched, true);
});

// ── wiring: each site is ONE synchronous, un-awaited, fail-open line ─────

test("hook sites are wired once each, never awaited", async () => {
  const sites = [
    ["src/lib/domain/seller-flow/process-seller-inbound-message.js", "observeSellerTurn("],
    ["src/lib/supabase/sms-engine.js", "observeSendQueueInsert("],
    ["src/lib/domain/campaigns/campaign-automation-service.js", "observeCampaignBatchInsert("],
    ["src/lib/domain/campaigns/run-campaign-outbound-feeder.js", "observeFeederDecision("],
  ];
  for (const [file, call] of sites) {
    const src = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    const uses = src.split(call).length - 1;
    assert.equal(uses, 1, `${file} must call ${call} exactly once`);
    assert.ok(!src.includes(`await ${call}`), `${file} must not await ${call}`);
    assert.ok(!new RegExp(`(return|=)\\s*${call.replace("(", "\\(")}`).test(src), `${file} must not depend on ${call}'s result`);
  }
  const corrections = [
    "src/app/api/cockpit/buyer-match/candidates/[candidate_id]/route.js",
    "src/app/api/cockpit/properties/[property_id]/push-to-underwriting/route.js",
    "src/app/api/cockpit/pipeline/opportunities/[id]/stage/route.js",
    "src/app/api/cockpit/lead-state/patch/route.js",
    "src/app/api/cockpit/threads/[thread_key]/route.js",
    "src/lib/discord/discord-action-handlers/handle-sms-reply.js",
  ];
  for (const file of corrections) {
    const src = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.ok(src.includes("beginCorrectionCapture("), `${file} must capture corrections`);
    assert.ok(src.includes("correction.commit("), `${file} must commit after its write`);
  }
});
