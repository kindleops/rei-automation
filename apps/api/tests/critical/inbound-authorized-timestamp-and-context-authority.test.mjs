// ─── inbound-authorized-timestamp-and-context-authority.test.mjs ─────────────
//
// Locks out four defects that together prevented a validated seller reply from
// ever reaching send-queue insertion, and made the audit misreport why.
//
//  1. appendConstituent dropped authorized_received_at, so every SCHEDULED
//     flush called executeInboundAutomationDecision with inboundReceivedAt=null
//     and evaluateAutoReplyScope denied at auto_reply_inbound_timestamp_missing.
//     This was the first exact branch preventing queue insertion.
//
//  2. Outbound-pair selection required owner+property ids to treat a row as the
//     conversation, so a fresh, genuinely-sent, provider-linked opening with
//     null ids lost to older thread history that happened to carry them.
//
//  3. resolve-inbound-relationship hard-coded automatic_send_allowed = false,
//     forcing execution_gated / shadow_only / audit_only for every relationship.
//
//  4. SUPPRESSION_APPLIED was emitted from the presence of a block/suppression
//     REASON rather than from an applied suppression mutation.
//
// The end-to-end section drives the genuine processSellerInboundMessage,
// runInboundIntelligencePhase, resolveInboundRelationship, burst persistence,
// the scheduled flush, executeInboundAutomationDecision and the real send_queue
// insertion boundary. All identifiers are synthetic.

import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  appendConstituent,
  aggregateBurstMessage,
  durableAuthorizedReceivedAt,
} from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";
import {
  evaluateAutoReplyScope,
  autoReplyModeAllowsQueue,
} from "@/lib/domain/seller-flow/auto-reply-mode.js";
import { createSellerInboundBurstCoordinator } from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";
import { createMemorySellerInboundBurstStore } from "@/lib/domain/seller-flow/seller-inbound-burst-store.js";
import { findRecentOutboundContextPair } from "@/lib/domain/context/find-recent-outbound-pair.js";
import {
  resolveInboundRelationship,
  resolveRelationshipExecutionEligibility,
} from "@/lib/domain/seller-flow/resolve-inbound-relationship.js";
import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { makeInboundRealPathSupabase } from "../helpers/inbound-real-path-supabase.mjs";

afterEach(() => {
  __resetSellerInboundOrchestratorDeps();
});

// ── Synthetic fixture ───────────────────────────────────────────────────────
const THREAD = "+15550001111";
const TEXTGRID = "+15550002222";
const CUTOFF = "2030-06-01T00:00:00.000Z";
const S1_SENT_AT = "2030-06-10T01:19:32.741Z";
const INBOUND_AT = "2030-06-10T01:20:08.000Z"; // 36s after the opening
const OLD_S2_SENT_AT = "2030-06-06T23:08:06.172Z"; // four days stale
const INBOUND_EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const INBOUND_PROVIDER_ID = "FIXTURE-INBOUND-PROVIDER-1";
const S1_PROVIDER_ID = "FIXTURE-S1-OPENING-PROVIDER-1";
const OLD_S2_PROVIDER_ID = "FIXTURE-OLD-S2-PROVIDER-1";
const S1_QUEUE_ID = "fixture-queue-s1-opening";
const OLD_S2_QUEUE_ID = "fixture-queue-old-s2";
const OWNER_ID = "fixture_owner_1";
const PROSPECT_ID = "fixture_prospect_1";
const PROPERTY_ID = "fixture_property_1";
const UNRESTRICTED = Object.freeze({ authorized: true, global: true });

const CONSIDER_SELLING_TEMPLATE = {
  id: "400065",
  template_id: "400065",
  use_case: "consider_selling",
  stage_code: "consider_selling",
  language: "English",
  is_active: true,
  safe_for_auto_reply: true,
  reply_mode: "auto_reply",
  template_body:
    "Thanks for confirming. If I ran some numbers and sent you a proposal, would you take a look? Reply STOP to opt out.",
  property_type_scope: "any",
};

/** The stale S2 auto-reply that already asked the proposal question. */
function oldS2QueueRow() {
  return {
    id: OLD_S2_QUEUE_ID,
    queue_status: "delivered",
    source: "auto_reply",
    provider_message_id: OLD_S2_PROVIDER_ID,
    message_type: "Follow-Up",
    template_id: "400065",
    master_owner_id: OWNER_ID,
    prospect_id: PROSPECT_ID,
    property_id: PROPERTY_ID,
    seller_first_name: "Sam",
    property_address: "1 Fixture Way",
    message_body:
      "Thanks for confirming. If I ran some numbers and sent you a proposal, would you take a look?",
    to_phone_number: THREAD,
    from_phone_number: TEXTGRID,
    sent_at: OLD_S2_SENT_AT,
    created_at: OLD_S2_SENT_AT,
  };
}

/**
 * The fresh S1 ownership opening. Genuinely sent, real provider id, and — like
 * the live row that exposed this — NO owner/property ids of its own.
 */
function freshS1QueueRow(overrides = {}) {
  return {
    id: S1_QUEUE_ID,
    queue_status: "sent",
    source: "internal_canary",
    provider_message_id: S1_PROVIDER_ID,
    message_type: "ownership_check",
    template_id: null,
    master_owner_id: null,
    prospect_id: null,
    property_id: null,
    message_body: "Hi Sam, do you still own 1 Fixture Way?",
    to_phone_number: THREAD,
    from_phone_number: TEXTGRID,
    sent_at: S1_SENT_AT,
    created_at: S1_SENT_AT,
    ...overrides,
  };
}

function ownershipConfirmedClassification() {
  return {
    primary_intent: "ownership_confirmed",
    detected_intent: "ownership_confirmed",
    canonical_intent: "ownership_confirmed",
    confidence: 0.88,
    language: "English",
    stage_hint: "ownership_check",
    matched_rule: "ctx_yes_after_ownership_check",
    context_source_id: S1_PROVIDER_ID,
    automation_decision: { auto_reply_allowed: true, risk_level: "low" },
  };
}

function orchestrationContext() {
  return {
    propertyId: PROPERTY_ID,
    prospectId: PROSPECT_ID,
    ownerId: OWNER_ID,
    phoneId: "fixture_phone_1",
    stageBefore: "ownership_check",
    autoReplyMode: "live_limited",
    executionAllowed: true,
    inboundTo: TEXTGRID,
    context: {
      found: true,
      ids: {
        master_owner_id: OWNER_ID,
        prospect_id: PROSPECT_ID,
        property_id: PROPERTY_ID,
      },
      summary: {
        conversation_stage: "ownership_check",
        seller_first_name: "Sam",
        property_address: "1 Fixture Way",
        language_preference: "English",
      },
    },
    route: { stage: "ownership_check", use_case: "ownership_check" },
  };
}

/** JSONB round-trip: exactly what a DB write/read does to a constituent. */
function throughJsonb(value) {
  return JSON.parse(JSON.stringify(value));
}

function scopeFor(inboundReceivedAt) {
  return evaluateAutoReplyScope({
    inboundFrom: THREAD,
    threadKey: THREAD,
    inboundReceivedAt,
    cutoffAt: CUTOFF,
    threadAllowlist: THREAD,
  });
}

function queuePermissionFor(inboundReceivedAt, mode = "live_limited") {
  return autoReplyModeAllowsQueue({
    mode,
    inboundFrom: THREAD,
    threadKey: THREAD,
    inboundReceivedAt,
    cutoffAt: CUTOFF,
    threadAllowlist: THREAD,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 1. AUTHORIZED TIMESTAMP PERSISTENCE
// ════════════════════════════════════════════════════════════════════════════

test("PRODUCTION-SHA PROOF: a constituent without authorized_received_at denies at auto_reply_inbound_timestamp_missing", () => {
  // The exact durable shape production wrote: the four fields appendConstituent
  // used to build, and nothing else. This is the counterfactual that identified
  // the blocker, kept as a permanent regression.
  const production_constituent = {
    event_id: INBOUND_EVENT_ID,
    provider_message_id: INBOUND_PROVIDER_ID,
    body: "Yeah",
    received_at: INBOUND_AT,
  };
  const aggregated = aggregateBurstMessage([throughJsonb(production_constituent)]);

  assert.equal(
    aggregated.last_authorized_received_at,
    null,
    "aggregate reads only authorized_received_at and must not substitute received_at"
  );

  const scope = scopeFor(aggregated.last_authorized_received_at);
  assert.equal(scope.allowed, false);
  assert.equal(scope.reason, "auto_reply_inbound_timestamp_missing");

  const permission = queuePermissionFor(aggregated.last_authorized_received_at);
  assert.equal(permission.allowed, false);
  assert.equal(permission.reason, "auto_reply_inbound_timestamp_missing");
});

test("PATCHED: the authorized timestamp survives the jsonb round-trip byte-for-byte and scope allows", () => {
  const { constituents, appended } = appendConstituent([], {
    event_id: INBOUND_EVENT_ID,
    provider_message_id: INBOUND_PROVIDER_ID,
    body: "Yeah",
    received_at: INBOUND_AT,
    authorized_received_at: INBOUND_AT,
  });
  assert.equal(appended, true);

  const persisted = throughJsonb(constituents);
  assert.equal(
    persisted[0].authorized_received_at,
    INBOUND_AT,
    "stored byte-for-byte, so the flush authorizes against the identical value"
  );

  const aggregated = aggregateBurstMessage(persisted);
  assert.equal(aggregated.last_authorized_received_at, INBOUND_AT);

  const permission = queuePermissionFor(aggregated.last_authorized_received_at);
  assert.equal(permission.allowed, true);
  assert.equal(permission.reason, "live_limited");
  assert.equal(permission.scope.reason, "auto_reply_scope_allowlisted");
});

test("a Date and an epoch-ms number normalize to the SAME INSTANT, never to now()", () => {
  for (const supplied of [new Date(INBOUND_AT), Date.parse(INBOUND_AT)]) {
    const { constituents } = appendConstituent([], {
      event_id: INBOUND_EVENT_ID,
      body: "Yeah",
      received_at: INBOUND_AT,
      authorized_received_at: supplied,
    });
    const persisted = throughJsonb(constituents)[0];
    assert.equal(
      Date.parse(persisted.authorized_received_at),
      Date.parse(INBOUND_AT),
      "must resolve to the supplied instant"
    );
    // The fixture instant is nowhere near wall clock, so "did we synthesize
    // from now()" is decidable without depending on which side of it we sit.
    assert.ok(
      Math.abs(Date.parse(persisted.authorized_received_at) - Date.now()) > 60_000,
      "must never be synthesized from current time"
    );
  }
});

test("invalid authorized timestamps are REJECTED and fail closed, never coerced", () => {
  const invalid = [
    ["unparseable string", "not-a-timestamp"],
    ["whitespace only", "   "],
    ["empty string", ""],
    ["object", { at: INBOUND_AT }],
    ["array", [INBOUND_AT]],
    ["boolean", true],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["invalid Date", new Date("nope")],
  ];
  for (const [label, value] of invalid) {
    assert.equal(durableAuthorizedReceivedAt(value), null, `${label} must be rejected`);
    const { constituents } = appendConstituent([], {
      event_id: INBOUND_EVENT_ID,
      body: "Yeah",
      received_at: INBOUND_AT,
      authorized_received_at: value,
    });
    const persisted = throughJsonb(constituents)[0];
    assert.equal(
      persisted.authorized_received_at,
      undefined,
      `${label} must leave the key absent, not explicitly null`
    );
    assert.equal(
      scopeFor(aggregateBurstMessage([persisted]).last_authorized_received_at).reason,
      "auto_reply_inbound_timestamp_missing",
      `${label} must fail closed at the scope gate`
    );
  }
});

test("authorization never falls back to received_at, even when received_at is valid", () => {
  const { constituents } = appendConstituent([], {
    event_id: INBOUND_EVENT_ID,
    body: "Yeah",
    received_at: INBOUND_AT,
    authorized_received_at: null,
  });
  const persisted = throughJsonb(constituents)[0];
  assert.equal(persisted.received_at, INBOUND_AT, "timing value is still kept");
  assert.equal(persisted.authorized_received_at, undefined);
  assert.equal(aggregateBurstMessage([persisted]).last_authorized_received_at, null);
});

test("an inbound BEFORE the cutoff is denied even with a valid authorized timestamp", () => {
  const stale = "2030-05-01T00:00:00.000Z";
  const { constituents } = appendConstituent([], {
    event_id: INBOUND_EVENT_ID,
    body: "Yeah",
    received_at: stale,
    authorized_received_at: stale,
  });
  const aggregated = aggregateBurstMessage(throughJsonb(constituents));
  assert.equal(aggregated.last_authorized_received_at, stale);
  const permission = queuePermissionFor(aggregated.last_authorized_received_at);
  assert.equal(permission.allowed, false);
  assert.equal(permission.reason, "auto_reply_inbound_before_cutoff");
});

test("a thread that is not allowlisted is denied even with a valid authorized timestamp", () => {
  const permission = autoReplyModeAllowsQueue({
    mode: "live_limited",
    inboundFrom: "+15559998888",
    threadKey: "+15559998888",
    inboundReceivedAt: INBOUND_AT,
    cutoffAt: CUTOFF,
    threadAllowlist: THREAD,
  });
  assert.equal(permission.allowed, false);
  assert.notEqual(permission.reason, "auto_reply_inbound_timestamp_missing");
});

test("the latest constituent carrying a real timestamp wins the aggregate", () => {
  let list = appendConstituent([], {
    event_id: "e1",
    body: "Yeah",
    received_at: INBOUND_AT,
    authorized_received_at: INBOUND_AT,
  }).constituents;
  const later = "2030-06-10T01:20:11.000Z";
  list = appendConstituent(list, {
    event_id: "e2",
    body: "I do",
    received_at: later,
    authorized_received_at: later,
  }).constituents;
  assert.equal(aggregateBurstMessage(throughJsonb(list)).last_authorized_received_at, later);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. CONVERSATION CONTEXT AUTHORITY
// ════════════════════════════════════════════════════════════════════════════

function pairSupabase(rows) {
  return makeInboundRealPathSupabase({ send_queue: rows });
}

test("a fresh SENT opening with null owner/property ids outranks older thread history that has them", async () => {
  const db = pairSupabase([oldS2QueueRow(), freshS1QueueRow()]);
  const result = await findRecentOutboundContextPair(THREAD, TEXTGRID, {
    supabase: db,
    inbound_received_at: INBOUND_AT,
  });

  assert.equal(result.found, true);
  assert.equal(result.context.queue_row_id, S1_QUEUE_ID, "the fresh opening is the conversation");
  assert.equal(result.context.match.matched_provider_message_id, S1_PROVIDER_ID);
  assert.match(result.context.recent.last_outbound_message, /do you still own/i);
});

test("exact classifier context_source_id linkage pins the outbound", async () => {
  const db = pairSupabase([oldS2QueueRow(), freshS1QueueRow()]);
  const result = await findRecentOutboundContextPair(THREAD, TEXTGRID, {
    supabase: db,
    inbound_received_at: INBOUND_AT,
    context_source_id: S1_PROVIDER_ID,
  });
  assert.equal(result.context.queue_row_id, S1_QUEUE_ID);
  assert.equal(result.context.match.match_strategy, "classifier_context_linked_outbound");
  assert.equal(result.context.match.context_linked, true);
});

test("deal identity is BACKFILLED from history, so the fresh opening keeps owner and property", async () => {
  const db = pairSupabase([oldS2QueueRow(), freshS1QueueRow()]);
  const result = await findRecentOutboundContextPair(THREAD, TEXTGRID, {
    supabase: db,
    inbound_received_at: INBOUND_AT,
  });
  assert.equal(result.context.ids.master_owner_id, OWNER_ID);
  assert.equal(result.context.ids.property_id, PROPERTY_ID);
  assert.equal(result.context.ids.prospect_id, PROSPECT_ID);
  assert.equal(result.context.match.identity_backfilled_from, OLD_S2_QUEUE_ID);
  assert.equal(result.context.match.context_verified, true);
});

test("the already-sent S2 template is NOT inherited onto the fresh turn", async () => {
  const db = pairSupabase([oldS2QueueRow(), freshS1QueueRow()]);
  const result = await findRecentOutboundContextPair(THREAD, TEXTGRID, {
    supabase: db,
    inbound_received_at: INBOUND_AT,
  });
  assert.equal(
    result.context.ids.template_id,
    null,
    "inheriting 400065 makes the S2 question read as already asked and answered"
  );
});

test("abandoned, duplicate-blocked, cancelled and never-sent rows cannot outrank the fresh opening", async () => {
  const orphans = [
    { id: "orphan-cancelled", queue_status: "cancelled", sent_at: null, created_at: "2030-06-10T01:19:50Z" },
    { id: "orphan-duplicate", queue_status: "paused_duplicate", sent_at: null, created_at: "2030-06-10T01:19:51Z" },
    { id: "orphan-blocked", queue_status: "blocked", sent_at: null, created_at: "2030-06-10T01:19:52Z" },
    { id: "orphan-failed", queue_status: "failed", sent_at: null, created_at: "2030-06-10T01:19:53Z" },
  ].map((row) => ({
    source: "leadcommand_inbox",
    provider_message_id: null,
    master_owner_id: null,
    property_id: null,
    message_body: "never reached the seller",
    to_phone_number: THREAD,
    from_phone_number: TEXTGRID,
    ...row,
  }));

  const db = pairSupabase([oldS2QueueRow(), freshS1QueueRow(), ...orphans]);
  const result = await findRecentOutboundContextPair(THREAD, TEXTGRID, {
    supabase: db,
    inbound_received_at: INBOUND_AT,
  });

  assert.equal(result.context.queue_row_id, S1_QUEUE_ID);
  assert.equal(
    result.context.match.skipped_newer_orphan_count,
    orphans.length,
    "every undelivered row newer than the opening is reported as skipped"
  );
});

test("an outbound sent AFTER the inbound cannot become the question it answered", async () => {
  const later = freshS1QueueRow({
    id: "fixture-queue-after-inbound",
    provider_message_id: "FIXTURE-AFTER-INBOUND",
    message_body: "A question asked after the seller already replied",
    sent_at: "2030-06-10T01:25:00.000Z",
    created_at: "2030-06-10T01:25:00.000Z",
  });
  const db = pairSupabase([oldS2QueueRow(), freshS1QueueRow(), later]);
  const result = await findRecentOutboundContextPair(THREAD, TEXTGRID, {
    supabase: db,
    inbound_received_at: INBOUND_AT,
  });
  assert.equal(result.context.queue_row_id, S1_QUEUE_ID);
});

// ── message_events fallback obeys the SAME temporal authority ───────────────
// send_queue selection is bounded by inbound_received_at. The message_events
// fallback was not: it ordered by sent_at desc and took limit(1) with no
// temporal bound and no successful-send filter, so an outbound sent AFTER the
// reply could become the context for that reply — the same defect, one table
// over.

/** Every send_queue candidate is post-inbound, forcing the message_events path. */
function postInboundOnlySendQueue() {
  return [
    freshS1QueueRow({
      id: "sq-after-1",
      provider_message_id: "FIXTURE-SQ-AFTER-1",
      sent_at: "2030-06-10T01:30:00.000Z",
      created_at: "2030-06-10T01:30:00.000Z",
    }),
  ];
}

function messageEvent(overrides = {}) {
  return {
    id: "me-fixture-1",
    direction: "outbound",
    delivery_status: "delivered",
    failed_at: null,
    is_final_failure: false,
    master_owner_id: OWNER_ID,
    prospect_id: PROSPECT_ID,
    property_id: PROPERTY_ID,
    template_id: "400065",
    message_body: "An older outbound that really was sent",
    to_phone_number: THREAD,
    from_phone_number: TEXTGRID,
    sent_at: "2030-06-09T12:00:00.000Z",
    created_at: "2030-06-09T12:00:00.000Z",
    ...overrides,
  };
}

test("message_events fallback must NOT bind to an outbound sent after the inbound", async () => {
  const db = makeInboundRealPathSupabase({
    send_queue: postInboundOnlySendQueue(),
    message_events: [
      messageEvent({
        id: "me-after-inbound",
        message_body: "Asked after the seller had already replied",
        sent_at: "2030-06-10T01:40:00.000Z",
        created_at: "2030-06-10T01:40:00.000Z",
      }),
    ],
  });

  const result = await findRecentOutboundContextPair(THREAD, TEXTGRID, {
    supabase: db,
    inbound_received_at: INBOUND_AT,
  });

  assert.equal(result.found, false, "a post-inbound message_event is not context");
  assert.equal(result.reason, "no_recent_outbound_pair");
  assert.deepEqual(db.unsupportedCalls, []);
});

test("message_events fallback binds to a valid pre-inbound successful outbound", async () => {
  const db = makeInboundRealPathSupabase({
    send_queue: postInboundOnlySendQueue(),
    message_events: [messageEvent()],
  });

  const result = await findRecentOutboundContextPair(THREAD, TEXTGRID, {
    supabase: db,
    inbound_received_at: INBOUND_AT,
  });

  assert.equal(result.found, true, "legitimate older fallback must still work");
  assert.equal(result.source, "recent_outbound_message_event");
  assert.equal(result.context.event_id, "me-fixture-1");
  assert.equal(result.context.ids.master_owner_id, OWNER_ID);
  assert.deepEqual(db.unsupportedCalls, []);
});

test("message_events fallback skips never-sent and failed outbounds", async () => {
  const ineligible = [
    ["never sent", { id: "me-never-sent", sent_at: null, created_at: "2030-06-09T20:00:00.000Z" }],
    ["failed", { id: "me-failed", delivery_status: "failed", sent_at: "2030-06-09T20:00:00.000Z" }],
    [
      "undelivered",
      { id: "me-undelivered", delivery_status: "undelivered", sent_at: "2030-06-09T20:00:00.000Z" },
    ],
    [
      "final failure",
      { id: "me-final-failure", is_final_failure: true, sent_at: "2030-06-09T20:00:00.000Z" },
    ],
    [
      "failed_at stamped",
      { id: "me-failed-at", failed_at: "2030-06-09T20:00:01.000Z", sent_at: "2030-06-09T20:00:00.000Z" },
    ],
  ];

  for (const [label, overrides] of ineligible) {
    // The ineligible row is NEWER than the good one, so if it were eligible it
    // would win. The good row is the correct answer in every case.
    const db = makeInboundRealPathSupabase({
      send_queue: postInboundOnlySendQueue(),
      message_events: [messageEvent(overrides), messageEvent()],
    });
    const result = await findRecentOutboundContextPair(THREAD, TEXTGRID, {
      supabase: db,
      inbound_received_at: INBOUND_AT,
    });
    assert.equal(result.found, true, label);
    assert.equal(result.context.event_id, "me-fixture-1", `${label} must not win`);
    assert.deepEqual(db.unsupportedCalls, [], label);
  }
});

test("message_events fallback without an inbound bound keeps legacy behaviour", async () => {
  const db = makeInboundRealPathSupabase({
    send_queue: [],
    message_events: [messageEvent()],
  });
  const result = await findRecentOutboundContextPair(THREAD, TEXTGRID, { supabase: db });
  assert.equal(result.found, true);
  assert.equal(result.context.event_id, "me-fixture-1");
});

// ════════════════════════════════════════════════════════════════════════════
// 3. RELATIONSHIP EXECUTION AUTHORITY
// ════════════════════════════════════════════════════════════════════════════

const FULL_AUTHORITY = Object.freeze({
  transport_execution_allowed: true,
  auto_reply_mode_allowed: true,
  template_approved: true,
});

const SCOPE_PASSED = Object.freeze({
  enforced: true,
  allowed: true,
  reason: "auto_reply_scope_allowlisted",
});

function relationshipFor(
  message,
  { classification = null, execution_authority = null, auto_reply_scope = null } = {}
) {
  return resolveInboundRelationship({
    message,
    classification,
    source_event_id: INBOUND_EVENT_ID,
    source_thread_key: THREAD,
    source_contact_phone: THREAD,
    property_id: PROPERTY_ID,
    master_owner_id: OWNER_ID,
    prospect_id: PROSPECT_ID,
    execution_authority,
    auto_reply_scope,
  });
}

test("a confirmed owner with every authority asserted IS execution eligible", () => {
  const relationship = relationshipFor("Yeah", {
    classification: ownershipConfirmedClassification(),
    execution_authority: FULL_AUTHORITY,
  });
  assert.equal(relationship.ownership_confirmed, true);
  assert.equal(relationship.relationship_execution_eligible, true);
  assert.equal(relationship.automatic_send_allowed, true);
  assert.deepEqual(relationship.execution_authority_blocked_reasons, []);
});

test("confirmed ownership alone is NOT sufficient — each missing authority blocks by name", () => {
  const relationship = relationshipFor("Yeah", {
    classification: ownershipConfirmedClassification(),
  });
  assert.equal(relationship.relationship_execution_eligible, true);
  assert.equal(relationship.automatic_send_allowed, false, "unknown authority is not permission");
  assert.deepEqual(relationship.execution_authority_blocked_reasons, [
    "missing_transport_execution_allowed",
    "missing_auto_reply_mode_allowed",
    "missing_template_approved",
  ]);

  for (const missing of Object.keys(FULL_AUTHORITY)) {
    const partial = { ...FULL_AUTHORITY, [missing]: false };
    const blocked = relationshipFor("Yeah", {
      classification: ownershipConfirmedClassification(),
      execution_authority: partial,
    });
    assert.equal(blocked.automatic_send_allowed, false, `${missing}=false must block`);
    assert.deepEqual(blocked.execution_authority_blocked_reasons, [`missing_${missing}`]);
  }
});

test("a non-boolean authority is not permission", () => {
  for (const truthy of ["true", 1, {}]) {
    const relationship = relationshipFor("Yeah", {
      classification: ownershipConfirmedClassification(),
      execution_authority: { ...FULL_AUTHORITY, template_approved: truthy },
    });
    assert.equal(relationship.automatic_send_allowed, false);
  }
});

test("blocked and review relationships stay blocked with FULL authority asserted", () => {
  const cases = [
    ["opt_out", "Stop texting me", { primary_intent: "opt_out" }],
    ["hostile_or_legal", "I will sue you", { primary_intent: "hostile_or_legal" }],
    ["actual wrong number", "You have the wrong number", { primary_intent: "wrong_number" }],
    ["non-owner referral", "No, talk to my brother about that property", null],
    ["spouse/co-owner authority", "I'm his wife, we own it together", null],
    ["executor authority", "I'm the executor of the estate", null],
    ["LLC authority", "I represent the LLC that owns it", null],
    ["tenant / non-owner", "I just rent here", null],
  ];
  for (const [label, message, classification] of cases) {
    const relationship = relationshipFor(message, {
      classification,
      execution_authority: FULL_AUTHORITY,
    });
    assert.equal(
      relationship.automatic_send_allowed,
      false,
      `${label} must never be execution eligible`
    );
    assert.equal(relationship.relationship_execution_eligible, false, label);
    assert.ok(
      relationship.execution_authority_blocked_reasons.includes(
        "relationship_not_execution_eligible"
      ),
      label
    );
  }
});

test("resolveRelationshipExecutionEligibility reports every block, not just the first", () => {
  const verdict = resolveRelationshipExecutionEligibility({
    relationship_execution_eligible: false,
    execution_authority: null,
  });
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.blocked_reasons, [
    "relationship_not_execution_eligible",
    "missing_transport_execution_allowed",
    "missing_auto_reply_mode_allowed",
    "missing_template_approved",
  ]);
});

// ── Mode authority is not scope authority ───────────────────────────────────
// autoReplyModeAllowsQueue returns a MODE verdict. internal_only, dry_run and
// disabled never evaluate a live_limited scope and return no `scope` key at
// all, so deriving scope authority from `allowed` invented a passing scope for
// internal_only and reported dry_run/disabled as a cutoff failure.

test("live_limited with a valid scope reports scope allowed and sends", () => {
  const permission = queuePermissionFor(INBOUND_AT, "live_limited");
  assert.equal(permission.scope_enforced, true);
  assert.equal(permission.scope.allowed, true);

  const relationship = relationshipFor("Yeah", {
    classification: ownershipConfirmedClassification(),
    execution_authority: FULL_AUTHORITY,
    auto_reply_scope: {
      enforced: true,
      allowed: permission.scope.allowed,
      reason: permission.scope.reason,
    },
  });
  assert.equal(relationship.automatic_send_allowed, true);
  assert.deepEqual(relationship.execution_authority_blocked_reasons, []);
});

test("live_limited with an invalid scope blocks with the EXACT scope reason", () => {
  const cases = [
    [null, "auto_reply_inbound_timestamp_missing"],
    ["2030-05-01T00:00:00.000Z", "auto_reply_inbound_before_cutoff"],
  ];
  for (const [received_at, expected_reason] of cases) {
    const permission = queuePermissionFor(received_at, "live_limited");
    assert.equal(permission.scope_enforced, true);
    assert.equal(permission.scope.allowed, false);
    assert.equal(permission.scope.reason, expected_reason);

    const relationship = relationshipFor("Yeah", {
      classification: ownershipConfirmedClassification(),
      execution_authority: FULL_AUTHORITY,
      auto_reply_scope: {
        enforced: true,
        allowed: false,
        reason: permission.scope.reason,
      },
    });
    assert.equal(relationship.automatic_send_allowed, false);
    assert.deepEqual(relationship.execution_authority_blocked_reasons, [
      `auto_reply_scope_denied:${expected_reason}`,
    ]);
  }
});

test("internal_only / dry_run / disabled never fabricate a scope verdict", () => {
  for (const mode of ["internal_only", "dry_run", "disabled"]) {
    const permission = queuePermissionFor(INBOUND_AT, mode);
    assert.notEqual(
      permission.scope_enforced,
      true,
      `${mode} must not claim scope was enforced`
    );
    assert.equal(permission.scope, undefined, `${mode} must not produce a scope verdict`);

    // A mode denial must be reported as a MODE block, never as a scope denial.
    const relationship = relationshipFor("Yeah", {
      classification: ownershipConfirmedClassification(),
      execution_authority: { ...FULL_AUTHORITY, auto_reply_mode_allowed: permission.allowed },
      auto_reply_scope: null,
    });
    const reasons = relationship.execution_authority_blocked_reasons;
    assert.ok(
      !reasons.some((reason) => reason.startsWith("auto_reply_scope_denied")),
      `${mode} must not report a scope denial (got ${JSON.stringify(reasons)})`
    );
    if (!permission.allowed) {
      assert.deepEqual(reasons, ["missing_auto_reply_mode_allowed"], mode);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 4. REAL-PATH END TO END
//    burst persistence -> jsonb round-trip -> SCHEDULED flush ->
//    real processSellerInboundMessage -> real send_queue insertion
// ════════════════════════════════════════════════════════════════════════════

function buildRealPathHarness({
  autoReplyMode = "live_limited",
  executionAllowed = true,
  authorizedReceivedAt = INBOUND_AT,
  cutoffAt = CUTOFF,
  threadAllowlist = THREAD,
  templates = [CONSIDER_SELLING_TEMPLATE],
  extraQueueRows = [],
} = {}) {
  let clock = Date.parse(INBOUND_AT);
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const supabase = makeInboundRealPathSupabase({
    send_queue: [oldS2QueueRow(), freshS1QueueRow(), ...extraQueueRows],
    sms_templates: templates,
  });
  const workflow_events = [];
  const turns = [];

  __setSellerInboundOrchestratorDeps({
    getSupabaseClient: () => supabase,
    patchUniversalLeadState: async ({ patch }) => ({ ok: true, patch }),
    emitAutomationEvent: async (event) => {
      workflow_events.push(event);
      return { ok: true };
    },
    persistInboundIntelligenceSnapshot: async () => ({ ok: true }),
    persistSellerContactReferral: async () => ({ ok: true, skipped: true }),
    executeReferralAutomation: async () => ({ ok: true, skipped: true }),
    scheduleFollowUp: async () => ({ ok: true, followup_created: false, skipped: true }),
    cancelPendingFollowUpsForThread: async () => ({ ok: true, cancelled: 0 }),
  });

  const getSystemValue = async (key) => {
    if (key === "auto_reply_mode") return autoReplyMode;
    if (key === "auto_reply_eligibility_cutoff_at") return cutoffAt;
    if (key === "auto_reply_thread_allowlist") return threadAllowlist;
    return null;
  };

  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    activation_scope: UNRESTRICTED,
    processSellerInboundMessage: async (args) => {
      turns.push(args);
      // THE GENUINE ORCHESTRATOR. Not a stand-in.
      return processSellerInboundMessage({
        ...args,
        autoReplyMode,
        executionAllowed,
        supabaseClient: supabase,
        getSystemValue,
        applySuppression: true,
        skipNotifications: true,
        dryRun: false,
      });
    },
  });

  return {
    coordinator,
    supabase,
    workflow_events,
    turns,
    now,
    advance: (ms) => {
      clock += ms;
    },
    queueRows: () => supabase.inserted.send_queue,
    async ingestYeah(overrides = {}) {
      return coordinator.onPersistedInbound({
        thread_key: THREAD,
        event_id: INBOUND_EVENT_ID,
        provider_message_id: INBOUND_PROVIDER_ID,
        body: "Yeah",
        received_at: authorizedReceivedAt,
        classification: ownershipConfirmedClassification(),
        orchestration_context: orchestrationContext(),
        ...overrides,
      });
    },
  };
}

test("REAL PATH: fresh S1 + \"Yeah\" creates EXACTLY ONE S2 queue row through the scheduled flush", async () => {
  const h = buildRealPathHarness();

  const ingest = await h.ingestYeah();
  assert.equal(ingest.deferred, true, "the webhook defers execution to the burst");
  assert.equal(h.turns.length, 0, "no orchestration at ingest time");

  // The constituent must carry the authorized timestamp across the DB boundary.
  const open = h.coordinator.store.getOpen(THREAD);
  assert.ok(open, "the ingest must have opened a burst");
  const persisted = throughJsonb(open.constituents);
  assert.equal(persisted[0].authorized_received_at, INBOUND_AT);

  // Debounce elapses; the SCHEDULED flush runs with NO live request context.
  h.advance(25_000);
  const flush = await h.coordinator.flushEligible({
    thread_key: THREAD,
    burst_id: open.burst_id,
    limit: 1,
  });

  assert.equal(flush.results.length, 1);
  assert.equal(flush.results[0].ok, true);
  assert.equal(h.turns.length, 1, "exactly one orchestration turn");

  // The flush handed the orchestrator the real authorized instant.
  assert.equal(h.turns[0].inboundReceivedAt, INBOUND_AT);

  const result = flush.results[0].orchestration;
  assert.equal(result.queue_permission.allowed, true, JSON.stringify(result.queue_permission));
  assert.equal(result.queue_permission.reason, "live_limited");
  assert.equal(result.queue_permission.scope.reason, "auto_reply_scope_allowlisted");

  const rows = h.queueRows();
  assert.equal(rows.length, 1, "exactly one S2 row");
  assert.equal(rows[0].template_id, "400065");
  assert.equal(rows[0].use_case_template, "consider_selling");
  assert.equal(rows[0].type, "auto_reply");
  assert.equal(
    rows[0].source_event_id,
    INBOUND_EVENT_ID,
    "the queue row links to the exact inbound that caused it"
  );
  assert.equal(rows[0].to_phone_number, THREAD);
});

test("REAL PATH: the turn advances S1 -> S2 and does not jump toward offer", async () => {
  const h = buildRealPathHarness();
  await h.ingestYeah();
  h.advance(25_000);
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD, limit: 1 });
  const result = flush.results[0].orchestration;

  assert.equal(result.intelligence_snapshot.canonical_intent, "ownership_confirmed");
  assert.equal(result.decision.stage_after, "offer_interest");
  const rows = h.queueRows();
  assert.equal(rows[0].use_case_template, "consider_selling");
  assert.notEqual(rows[0].use_case_template, "offer_presented");
  assert.match(rows[0].message_body, /would you take a look/i);
});

test("REAL PATH: no false SUPPRESSION_APPLIED when nothing was suppressed", async () => {
  const h = buildRealPathHarness();
  await h.ingestYeah();
  h.advance(25_000);
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD, limit: 1 });
  const result = flush.results[0].orchestration;

  assert.equal(result.intelligence_snapshot.suppression_scope, "none");
  assert.equal(
    result.intelligence_snapshot.canonical_decision?.should_suppress_contact ?? false,
    false
  );
  assert.equal(result.execution.suppression_applied, false);

  const suppression_events = h.workflow_events.filter(
    (e) => e.event_type === "SUPPRESSION_APPLIED"
  );
  assert.equal(
    suppression_events.length,
    0,
    "SUPPRESSION_APPLIED must require an applied suppression mutation"
  );
  assert.ok(h.workflow_events.length > 0, "other workflow events still emit");
});

test("REAL PATH: the intelligence audit reports real authority, not a blanket execution gate", async () => {
  const h = buildRealPathHarness();
  await h.ingestYeah();
  h.advance(25_000);
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD, limit: 1 });
  const snapshot = flush.results[0].orchestration.intelligence_snapshot;

  assert.equal(snapshot.relationship_execution_eligible, true);
  assert.equal(snapshot.automatic_send_allowed, true);
  assert.deepEqual(snapshot.execution_authority_blocked_reasons, []);

  const execution_layer = snapshot.decision_layers.execution;
  assert.equal(execution_layer.shadow_only, false);
  assert.equal(execution_layer.audit_only, false);
  assert.equal(execution_layer.execution_blocked_reason, null);
  assert.equal(execution_layer.suppression_mutation_applied, false);
});

test("REAL PATH: the helper exercised only operators it truly implements", async () => {
  const h = buildRealPathHarness();
  await h.ingestYeah();
  h.advance(25_000);
  await h.coordinator.flushEligible({ thread_key: THREAD, limit: 1 });

  // A silently-ignored operator would mean the "real path" suite passed while
  // production query semantics were never actually exercised. Unsupported
  // operators record AND throw, so this stays provable even if a throw is
  // swallowed by a try/catch inside the code under test.
  assert.deepEqual(
    h.supabase.unsupportedCalls,
    [],
    `unsupported operators reached the helper: ${JSON.stringify(h.supabase.unsupportedCalls)}`
  );

  const audit = h.supabase.operatorAudit();
  assert.ok(audit.length > 0, "the run must actually query something");
  // The duplicate/retry guard filters by source_event_id and by thread+type+
  // window. It uses eq/in/gte/limit — NOT .or() — which is why .or() can stay
  // a loud rejection rather than needing PostgREST OR semantics here.
  assert.ok(audit.includes("send_queue.eq"), JSON.stringify(audit));
  assert.ok(audit.includes("send_queue.in"), JSON.stringify(audit));
  assert.ok(audit.includes("send_queue.insert"), JSON.stringify(audit));
  assert.ok(
    !audit.some((entry) => entry.endsWith(".or")),
    `no exercised query may use .or(): ${JSON.stringify(audit)}`
  );
});

// ── Every audit surface must agree on the SAME authority verdict ────────────
// authorized_relationship is built after all authorities settle. Previously the
// canonical decision, semantic layer and shadow engine kept the pre-
// authorization verdict, so the snapshot could report a send as allowed while
// the canonical decision it embedded said the opposite.

const AGREEMENT_CASES = [
  { label: "fully authorized confirmed owner", harness: {}, expect_allowed: true },
  {
    label: "confirmed owner, missing transport authority",
    harness: { executionAllowed: false },
    expect_allowed: false,
  },
  {
    label: "confirmed owner, failed live_limited scope",
    harness: { cutoffAt: "2030-12-01T00:00:00.000Z" },
    expect_allowed: false,
  },
  {
    label: "confirmed owner, missing template",
    harness: { templates: [] },
    expect_allowed: false,
  },
  {
    label: "confirmed owner, unsafe template",
    harness: { templates: [{ ...CONSIDER_SELLING_TEMPLATE, safe_for_auto_reply: false }] },
    expect_allowed: false,
  },
  {
    label: "opt_out",
    harness: {},
    ingest: { body: "STOP", classification: { primary_intent: "opt_out" } },
    expect_allowed: false,
  },
  {
    label: "hostile_or_legal",
    harness: {},
    ingest: { body: "I will sue you", classification: { primary_intent: "hostile_or_legal" } },
    expect_allowed: false,
  },
  {
    label: "actual wrong number",
    harness: {},
    ingest: { body: "Wrong number", classification: { primary_intent: "wrong_number" } },
    expect_allowed: false,
  },
];

for (const agreement of AGREEMENT_CASES) {
  test(`REAL PATH AGREEMENT: ${agreement.label} — every surface reports the same verdict`, async () => {
    const h = buildRealPathHarness(agreement.harness);
    await h.ingestYeah(agreement.ingest || {});
    h.advance(25_000);
    const flush = await h.coordinator.flushEligible({ thread_key: THREAD, limit: 1 });
    const expected = agreement.expect_allowed;

    // A safety-latched burst (opt_out, hostile, wrong number) is finalized as
    // suppressed at ingest and never reaches orchestration at all. That is
    // itself a consistent "not allowed" outcome, and the only surface to check
    // is that nothing was queued.
    const orchestration = flush.results[0]?.orchestration ?? null;
    if (!orchestration) {
      assert.equal(expected, false, `${agreement.label} must not be an allowed case`);
      assert.equal(h.queueRows().length, 0, agreement.label);
      assert.deepEqual(h.supabase.unsupportedCalls, [], agreement.label);
      return;
    }

    const snapshot = orchestration.intelligence_snapshot;

    // ── The AUTHORITY verdict, which must be identical on every surface ─────
    assert.equal(snapshot.automatic_send_allowed, expected, `snapshot: ${agreement.label}`);
    assert.equal(
      snapshot.canonical_decision.automatic_send_allowed,
      expected,
      `canonical_decision must not contradict the snapshot: ${agreement.label}`
    );
    assert.deepEqual(
      snapshot.canonical_decision.execution_authority_blocked_reasons,
      snapshot.execution_authority_blocked_reasons,
      `blocked reasons must match: ${agreement.label}`
    );

    // The shadow engine received the SAME authorized relationship, not the
    // pre-authorization one.
    const shadow_relationship =
      snapshot.shadow_stage_engine?.relationship ??
      snapshot.shadow_stage_engine?.inputs?.relationship ??
      null;
    if (shadow_relationship && "automatic_send_allowed" in shadow_relationship) {
      assert.equal(
        shadow_relationship.automatic_send_allowed,
        expected,
        `shadow engine relationship: ${agreement.label}`
      );
    }

    // Semantic layer describes the same relationship.
    assert.equal(
      snapshot.decision_layers.semantic.suppression_scope,
      snapshot.suppression_scope,
      `semantic vs snapshot suppression scope: ${agreement.label}`
    );

    // ── The OUTCOME, which is a different question from authority ───────────
    // decision_layers.execution is deliberately re-derived after execution by
    // alignIntelligenceSnapshotExecutionView, so it reports what actually
    // happened rather than what was permitted. Assert it agrees with the
    // verdict in the only way that matters: an unauthorized turn queues
    // nothing, and an authorized one queues exactly one row.
    assert.equal(
      Boolean(snapshot.reply_recommendation.should_queue_reply),
      expected,
      `reply_recommendation: ${agreement.label}`
    );
    assert.equal(
      Boolean(snapshot.decision_layers.execution.queue_row_created),
      expected,
      `queue_row_created: ${agreement.label}`
    );

    if (expected) {
      assert.deepEqual(snapshot.execution_authority_blocked_reasons, [], agreement.label);
      assert.equal(h.queueRows().length, 1, agreement.label);
    } else {
      assert.ok(
        snapshot.execution_authority_blocked_reasons.length > 0,
        `a blocked turn must name at least one reason: ${agreement.label}`
      );
      assert.equal(h.queueRows().length, 0, agreement.label);
    }
    assert.deepEqual(h.supabase.unsupportedCalls, [], agreement.label);
  });
}

test("REAL PATH: a retried flush creates no duplicate queue row", async () => {
  const h = buildRealPathHarness();
  await h.ingestYeah();
  h.advance(25_000);
  await h.coordinator.flushEligible({ thread_key: THREAD, limit: 1 });
  assert.equal(h.queueRows().length, 1);

  // Re-running the orchestrator on the same inbound must be idempotent: the
  // duplicate guard keys on source_event_id, which the first insert wrote.
  const repeat = await processSellerInboundMessage({
    message: "Yeah",
    threadKey: THREAD,
    propertyId: PROPERTY_ID,
    prospectId: PROSPECT_ID,
    ownerId: OWNER_ID,
    classification: ownershipConfirmedClassification(),
    context: orchestrationContext().context,
    route: orchestrationContext().route,
    inboundFrom: THREAD,
    inboundTo: TEXTGRID,
    inboundEventId: INBOUND_EVENT_ID,
    inboundReceivedAt: INBOUND_AT,
    autoReplyMode: "live_limited",
    executionAllowed: true,
    supabaseClient: h.supabase,
    getSystemValue: async (key) =>
      key === "auto_reply_mode"
        ? "live_limited"
        : key === "auto_reply_eligibility_cutoff_at"
          ? CUTOFF
          : key === "auto_reply_thread_allowlist"
            ? THREAD
            : null,
    skipNotifications: true,
    dryRun: false,
  });

  assert.equal(repeat.idempotent?.duplicate_suppressed, true);
  assert.equal(h.queueRows().length, 1, "retry must not create a second row");
});

// ── Real-path negatives ─────────────────────────────────────────────────────

const NEGATIVE_CASES = [
  {
    label: "authorized_received_at missing",
    harness: { authorizedReceivedAt: null },
    expect_reason: "auto_reply_inbound_timestamp_missing",
  },
  {
    label: "inbound before cutoff",
    harness: { cutoffAt: "2030-12-01T00:00:00.000Z" },
    expect_reason: "auto_reply_inbound_before_cutoff",
  },
  {
    label: "thread not allowlisted",
    harness: { threadAllowlist: "+15557776666" },
    expect_reason: null,
  },
];

for (const negative of NEGATIVE_CASES) {
  test(`REAL PATH NEGATIVE: ${negative.label} creates no queue row`, async () => {
    const h = buildRealPathHarness(negative.harness);
    await h.ingestYeah();
    h.advance(25_000);
    const flush = await h.coordinator.flushEligible({ thread_key: THREAD, limit: 1 });
    const result = flush.results[0].orchestration;

    assert.equal(result.queue_permission.allowed, false, negative.label);
    if (negative.expect_reason) {
      assert.equal(result.queue_permission.reason, negative.expect_reason);
    }
    assert.equal(h.queueRows().length, 0, `${negative.label} must not insert a queue row`);
  });
}

test("REAL PATH NEGATIVE: an invalid provider timestamp is refused and creates no queue row", async () => {
  // The coordinator derives BOTH the timing value and the authorization value
  // from the provider's received_at. An unparseable one is refused outright at
  // burst creation rather than being repaired into a usable instant, so the
  // turn cannot reach the queue by any route.
  const h = buildRealPathHarness({ authorizedReceivedAt: "not-a-timestamp" });
  await assert.rejects(() => h.ingestYeah(), /invalid_burst_first_received_at/);
  h.advance(25_000);
  await h.coordinator.flushEligible({ thread_key: THREAD, limit: 1 });
  assert.equal(h.queueRows().length, 0);
});

test("REAL PATH NEGATIVE: executionAllowed false creates no queue row", async () => {
  const h = buildRealPathHarness({ executionAllowed: false });
  await h.ingestYeah();
  h.advance(25_000);
  await h.coordinator.flushEligible({ thread_key: THREAD, limit: 1 });
  assert.equal(h.queueRows().length, 0);
});

test("REAL PATH NEGATIVE: no approved template creates no queue row", async () => {
  const h = buildRealPathHarness({ templates: [] });
  await h.ingestYeah();
  h.advance(25_000);
  await h.coordinator.flushEligible({ thread_key: THREAD, limit: 1 });
  assert.equal(h.queueRows().length, 0);
});

test("REAL PATH NEGATIVE: an unsafe template is not auto-sent", async () => {
  const h = buildRealPathHarness({
    templates: [{ ...CONSIDER_SELLING_TEMPLATE, safe_for_auto_reply: false }],
  });
  await h.ingestYeah();
  h.advance(25_000);
  await h.coordinator.flushEligible({ thread_key: THREAD, limit: 1 });
  assert.equal(h.queueRows().length, 0);
});

const SAFETY_NEGATIVES = [
  ["opt_out", "STOP", { primary_intent: "opt_out" }],
  ["hostile_or_legal", "I will sue you", { primary_intent: "hostile_or_legal" }],
  ["actual wrong number", "Wrong number", { primary_intent: "wrong_number" }],
  ["non-owner referral", "No, call my brother about that one", null],
];

for (const [label, body, classification] of SAFETY_NEGATIVES) {
  test(`REAL PATH NEGATIVE: ${label} creates no queue row`, async () => {
    const h = buildRealPathHarness();
    await h.ingestYeah({ body, classification });
    h.advance(25_000);
    await h.coordinator.flushEligible({ thread_key: THREAD, limit: 1 });
    assert.equal(h.queueRows().length, 0, `${label} must never auto-send`);
  });
}
