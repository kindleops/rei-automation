// ─── inbound-temporal-authority-call-sites.test.mjs ──────────────────────────
//
// The webhook path (handle-textgrid-inbound.js) bounds outbound-pair selection
// by the inbound receipt instant, so an outbound that left AFTER the seller
// replied can never become "the question they answered". Two other paths reach
// the SAME context loader and did NOT pass the bound:
//
//  1. the SCHEDULED burst flush — the coordinator already hands the aggregate's
//     last_authorized_received_at down, but the flush's context resolution
//     dropped it before calling loadContextWithFallback;
//  2. the recovery sweep — which replays historical inbounds, where every
//     outbound sent since is post-inbound, so the bound matters MORE than live.
//
// This is the PR#73 stale-binding class. Each test below drives the REAL
// selector (findRecentOutboundContextPair) through the REAL loader from the
// REAL call site, and each is paired with a counterfactual proving the fixture
// would bind to the wrong outbound if the bound were dropped again.

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveBurstFlushContext } from "@/lib/domain/seller-flow/flush-inbound-bursts-request.js";
import { recoverUnprocessedInboundMessages } from "@/lib/domain/seller-flow/recover-unprocessed-inbound-messages.js";
import { loadContextWithFallback } from "@/lib/domain/context/load-context-with-fallback.js";
import { findRecentOutboundContextPair } from "@/lib/domain/context/find-recent-outbound-pair.js";
import { makeInboundRealPathSupabase } from "../helpers/inbound-real-path-supabase.mjs";

const THREAD = "+15550003333";
const TEXTGRID = "+15550004444";
const INBOUND_AT = "2030-06-10T01:20:08.000Z";
const BEFORE_ID = "queue-before-inbound";
const AFTER_ID = "queue-after-inbound";
const OWNER_ID = "fixture_owner_tb";
const PROSPECT_ID = "fixture_prospect_tb";
const PROPERTY_ID = "fixture_property_tb";

function queueRow(overrides = {}) {
  return {
    queue_status: "sent",
    source: "internal_canary",
    message_type: "ownership_check",
    template_id: null,
    master_owner_id: OWNER_ID,
    prospect_id: PROSPECT_ID,
    property_id: PROPERTY_ID,
    to_phone_number: THREAD,
    from_phone_number: TEXTGRID,
    ...overrides,
  };
}

/**
 * The genuine question: sent 36 seconds before the seller replied.
 * And the trap: a later send that went out five minutes AFTER the reply.
 */
function twoOutbounds() {
  return [
    queueRow({
      id: BEFORE_ID,
      provider_message_id: "PROVIDER-BEFORE-INBOUND",
      message_body: "Do you still own 1 Fixture Way?",
      sent_at: "2030-06-10T01:19:32.741Z",
      created_at: "2030-06-10T01:19:32.741Z",
    }),
    queueRow({
      id: AFTER_ID,
      provider_message_id: "PROVIDER-AFTER-INBOUND",
      message_body: "Would you take a look at a written proposal?",
      sent_at: "2030-06-10T01:25:00.000Z",
      created_at: "2030-06-10T01:25:00.000Z",
    }),
  ];
}

/** The real loader, with only the DB handle and Podio availability stubbed. */
function boundLoader(db) {
  return (loader_args) =>
    loadContextWithFallback({
      ...loader_args,
      findRecentOutboundContextPairImpl: (from, to, opts) =>
        findRecentOutboundContextPair(from, to, { ...opts, supabase: db }),
      getPodioAvailabilityImpl: () => ({ ok: false, reason: "test_no_podio" }),
    });
}

// ════════════════════════════════════════════════════════════════════════════
// 1. SCHEDULED BURST FLUSH
// ════════════════════════════════════════════════════════════════════════════

test("flush path: an outbound sent AFTER the burst's authorized inbound is not the conversation", async () => {
  const db = makeInboundRealPathSupabase({ send_queue: twoOutbounds() });

  const context = await resolveBurstFlushContext(
    { threadKey: THREAD, inboundTo: TEXTGRID, inboundReceivedAt: INBOUND_AT },
    { loadContextWithFallbackImpl: boundLoader(db), loadContextImpl: async () => ({ found: false }) }
  );

  assert.equal(context?.found, true, "the pre-inbound outbound resolves a context");
  assert.equal(context.fallback_match_id, BEFORE_ID, "bound to the question actually asked");
  assert.match(context.recent.last_outbound_message, /do you still own/i);
});

test("flush path COUNTERFACTUAL: without the bound the post-inbound send wins", async () => {
  const db = makeInboundRealPathSupabase({ send_queue: twoOutbounds() });

  // Exactly the pre-fix call: inboundReceivedAt never reaches the loader.
  const context = await resolveBurstFlushContext(
    { threadKey: THREAD, inboundTo: TEXTGRID },
    { loadContextWithFallbackImpl: boundLoader(db), loadContextImpl: async () => ({ found: false }) }
  );

  assert.equal(
    context.fallback_match_id,
    AFTER_ID,
    "fixture is not vacuous: unbounded selection really does pick the later send"
  );
});

test("flush path forwards the coordinator's authorized instant verbatim", async () => {
  const seen = [];
  await resolveBurstFlushContext(
    { threadKey: THREAD, inboundTo: TEXTGRID, inboundReceivedAt: INBOUND_AT },
    {
      loadContextWithFallbackImpl: async (a) => {
        seen.push(a);
        return { found: false };
      },
      loadContextImpl: async () => ({ found: false }),
    }
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].inbound_received_at, INBOUND_AT);
  assert.equal(seen[0].create_brain_if_missing, false, "the flush never creates a brain");
});

test("flush path: a caller-supplied context short-circuits the lookup (unchanged)", async () => {
  let called = false;
  const supplied = { found: true, marker: "live_webhook_context" };
  const context = await resolveBurstFlushContext(
    { threadKey: THREAD, context: supplied, inboundReceivedAt: INBOUND_AT },
    {
      loadContextWithFallbackImpl: async () => {
        called = true;
        return { found: false };
      },
      loadContextImpl: async () => ({ found: false }),
    }
  );
  assert.equal(context, supplied);
  assert.equal(called, false);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. RECOVERY SWEEP
// ════════════════════════════════════════════════════════════════════════════

const RECOVERY_EVENT_ID = "00000000-0000-4000-8000-0000000000f1";

function recoveryEventRow() {
  return {
    id: RECOVERY_EVENT_ID,
    provider_message_sid: "PROVIDER-INBOUND-RECOVERY",
    from_phone_number: THREAD,
    to_phone_number: TEXTGRID,
    message_body: "Yeah",
    received_at: INBOUND_AT,
    detected_intent: null,
    metadata: {},
    master_owner_id: null,
    prospect_id: null,
    property_id: null,
    phone_number_id: null,
    stage_before: null,
  };
}

/** Minimal message_events handle for the targeted (messageEventId) branch. */
function recoverySupabase(row) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { from: () => chain };
}

async function runRecovery({ loadContextImpl }) {
  const orchestrations = [];
  const result = await recoverUnprocessedInboundMessages({
    supabaseClient: recoverySupabase(recoveryEventRow()),
    messageEventId: RECOVERY_EVENT_ID,
    dryRun: true,
    loadContextImpl,
    processInboundImpl: async (args) => {
      orchestrations.push(args);
      return { ok: true, effective_action: "none" };
    },
  });
  return { result, orchestrations };
}

test("recovery sweep passes the replayed row's received_at as the temporal bound", async () => {
  const seen = [];
  await runRecovery({
    loadContextImpl: async (a) => {
      seen.push(a);
      return { found: true, ids: {}, summary: {}, recent: {} };
    },
  });

  assert.equal(seen.length, 1, "context resolved exactly once for the replayed row");
  assert.equal(
    seen[0].inbound_received_at,
    INBOUND_AT,
    "the historical receipt instant bounds the replay, not now()"
  );
  assert.equal(seen[0].inbound_from, THREAD);
  assert.equal(seen[0].inbound_to, TEXTGRID);
  assert.equal(seen[0].create_brain_if_missing, false);
});

test("recovery sweep: an outbound sent AFTER the replayed inbound is not the conversation", async () => {
  const db = makeInboundRealPathSupabase({ send_queue: twoOutbounds() });
  const contexts = [];

  await runRecovery({
    loadContextImpl: async (a) => {
      const context = await boundLoader(db)(a);
      contexts.push(context);
      return context;
    },
  });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].found, true);
  assert.equal(contexts[0].fallback_match_id, BEFORE_ID);
});

test("recovery sweep COUNTERFACTUAL: dropping the bound rebinds to the later send", async () => {
  const db = makeInboundRealPathSupabase({ send_queue: twoOutbounds() });
  const contexts = [];

  await runRecovery({
    loadContextImpl: async (a) => {
      // The pre-fix shape: the call site never supplied inbound_received_at.
      const context = await boundLoader(db)({ ...a, inbound_received_at: null });
      contexts.push(context);
      return context;
    },
  });

  assert.equal(
    contexts[0].fallback_match_id,
    AFTER_ID,
    "fixture is not vacuous: unbounded replay really does bind to a post-inbound send"
  );
});

// ── Campaign propagation to the auto-created S2 (CodeRabbit #3 verification) ───
// The reply pipeline (apply-inbound-automation-decision:2490) sets the S2 row's
// campaign_id from context.summary.campaign_id, which find-recent-outbound-pair
// derives from the conversation-authority (S1) row's campaign_id COLUMN. This
// proves an S1 carrying the pinned campaign propagates it into the reply context
// — so the auto-created S2 satisfies the atomic-claim row.campaign_id check.
const PINNED_CAMPAIGN = "b7c9a000-7ad3-468b-9b9b-4647dbefc35f";
test("S1 campaign_id propagates into the reply context summary (feeds S2 campaign_id)", async () => {
  const supabase = makeInboundRealPathSupabase({
    send_queue: [queueRow({
      id: "s1-proof-row",
      provider_message_id: "PROVIDER-S1",
      message_body: "Are you still the owner? Reply YES or NO.",
      campaign_id: PINNED_CAMPAIGN, // set on the S1 COLUMN by the proof hotfix
      sent_at: "2030-06-10T01:19:32.741Z",
      created_at: "2030-06-10T01:19:32.741Z",
    })],
  });
  const pair = await findRecentOutboundContextPair(THREAD, TEXTGRID, {
    supabase,
    inbound_received_at: INBOUND_AT,
  });
  assert.ok(pair?.found && pair.context, "context pair resolved from the S1 send_queue row");
  assert.equal(pair.context.summary.campaign_id, PINNED_CAMPAIGN,
    "reply context carries the S1 campaign → the auto-created S2 row inherits it (apply-inbound-automation-decision:2490)");
});
