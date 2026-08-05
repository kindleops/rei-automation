/**
 * The burst leg must exclude its own fragments from the answered-question scan.
 *
 * buildConversationContext has always accepted `burst_event_ids` and
 * `current_inbound_event_id` (build-conversation-context.js:81-82) and uses
 * them to build its `excluded` set, precisely because "two messages sent
 * seconds apart are one thought, and the first must not mark the second's
 * question as already answered". Until this wiring, NO production caller passed
 * either parameter — the logic existed, a unit test proved it worked, and it
 * was never connected.
 *
 * The consequence was not cosmetic. A burst aggregate's inbound_received_at is
 * the LAST fragment's timestamp, so every earlier fragment of the same burst
 * falls inside the builder's `created_at > delivered_at AND < inbound_received_at`
 * window. question_status flips to "answered" -> unanswered_question false ->
 * validateConversationContext (conversation-context.js:142-149) discards the
 * context as stale -> classify caps a plain "Yeah" at 0.72 and routes it to
 * human review. That is the 2026-08-03 incident, reproduced on the exact path
 * burst/debounce mode exists to serve.
 *
 * These tests assert the WIRING — that the orchestrator hands the builder the
 * constituents it needs. The builder's own exclusion behaviour is covered by
 * inbound-short-reply-context-incident.test.mjs.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { buildConversationContext } from "@/lib/domain/classification/build-conversation-context.js";

const THREAD = "+15550100077";
const LAST_FRAGMENT_AT = "2026-08-03T22:40:31.039Z";
const QUESTION_DELIVERED_AT = "2026-08-03T22:38:33.178Z";

/** Captures what the orchestrator hands the context builder. */
function harness({ burstContext = null } = {}) {
  const context_calls = [];
  __setSellerInboundOrchestratorDeps({
    buildConversationContext: async (args) => {
      context_calls.push(args);
      return null; // shape is what is under test; null keeps the run short
    },
    classify: async () => ({
      primary_intent: "unclear",
      confidence: 0.4,
      version: "burst-wiring-test",
    }),
    getSupabaseClient: () => ({}),
  });
  return { context_calls, burstContext };
}

async function runOrchestrator({ burstContext }) {
  return processSellerInboundMessage({
    message: "Yeah\nits a 3br",
    threadKey: THREAD,
    inboundFrom: THREAD,
    inboundEventId: "evt-fragment-2",
    providerMessageId: "SM-fragment-2",
    inboundReceivedAt: LAST_FRAGMENT_AT,
    classification: null, // the burst leg's contract: null -> re-classify aggregate
    supabaseClient: {},
    burstContext,
    dryRun: true,
    skipUniversalStatePatch: true,
    skipNotifications: true,
    systemFollowupEnabled: false,
  }).catch((error) => ({ ok: false, threw: error?.message || "threw" }));
}

test("the burst leg forwards its constituent event IDs to the context builder", async (t) => {
  const { context_calls } = harness();
  t.after(() => __resetSellerInboundOrchestratorDeps());

  await runOrchestrator({
    burstContext: {
      burst_id: "sib:test:g1",
      generation: 1,
      constituent_event_ids: ["evt-fragment-1", "evt-fragment-2"],
      message_count: 2,
    },
  });

  assert.equal(context_calls.length >= 1, true, "the burst leg must build context");
  const args = context_calls[0];
  assert.deepEqual(
    args.burst_event_ids,
    ["evt-fragment-1", "evt-fragment-2"],
    "every fragment of THIS burst must be excluded from the answered-question scan"
  );
  assert.equal(
    args.current_inbound_event_id,
    "evt-fragment-2",
    "the current inbound must never count as its own prior answer"
  );
  assert.equal(args.thread_key, THREAD);
  assert.equal(args.inbound_received_at, LAST_FRAGMENT_AT);
});

test("a non-burst call still passes an empty exclusion set, never undefined", async (t) => {
  const { context_calls } = harness();
  t.after(() => __resetSellerInboundOrchestratorDeps());

  await runOrchestrator({ burstContext: null });

  const args = context_calls[0];
  assert.deepEqual(args.burst_event_ids, [], "no burst -> nothing to exclude");
  assert.equal(args.current_inbound_event_id, "evt-fragment-2");
});

// ── The defect itself, against the REAL builder ────────────────────────────
// Proves the wiring above is load-bearing rather than decorative: identical
// stored evidence, and the only difference is whether the constituents were
// declared.

function stubSupabase(interveningInboundRows) {
  const chain = (table) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      not: () => builder,
      lte: () => builder,
      gt: () => builder,
      lt: () => builder,
      order: () => builder,
      limit: () =>
        Promise.resolve({
          data:
            table === "send_queue"
              ? [
                  {
                    id: "sq-ownership-1",
                    message_type: "ownership_check",
                    provider_message_id: "SM-outbound-1",
                    sent_at: QUESTION_DELIVERED_AT,
                    delivered_at: QUESTION_DELIVERED_AT,
                    queue_status: "delivered",
                  },
                ]
              : interveningInboundRows,
          error: null,
        }),
    };
    return builder;
  };
  return { from: chain };
}

test("without the exclusion an earlier fragment marks the question answered", async () => {
  // Fragment 1 of the SAME burst, persisted before the aggregate's timestamp.
  const supabase = stubSupabase([
    { id: "evt-fragment-1", created_at: "2026-08-03T22:40:25.000Z", direction: "inbound" },
  ]);
  const base = {
    thread_key: THREAD,
    inbound_received_at: LAST_FRAGMENT_AT,
    supabase,
    canonical_stage: "ownership_confirmation",
  };

  const unwired = await buildConversationContext(base);
  assert.equal(unwired.question_status, "answered", "the defect, reproduced");
  assert.equal(unwired.unanswered_question, false);
  assert.equal(unwired.intervening_inbound_count, 1);

  const wired = await buildConversationContext({
    ...base,
    burst_event_ids: ["evt-fragment-1"],
    current_inbound_event_id: "evt-fragment-2",
  });
  assert.equal(wired.question_status, "unanswered", "one thought, not a question and an answer");
  assert.equal(wired.unanswered_question, true, "the seller's reply can still bind");
  assert.equal(wired.intervening_inbound_count, 0);
});

test("a genuine earlier answer is still honoured — the exclusion is not a blanket suppression", async () => {
  // An unrelated inbound that is NOT part of this burst must still count, or
  // a stale "Yeah" would bind to a question the seller already answered.
  const supabase = stubSupabase([
    { id: "evt-unrelated-earlier", created_at: "2026-08-03T22:39:10.000Z", direction: "inbound" },
  ]);

  const context = await buildConversationContext({
    thread_key: THREAD,
    inbound_received_at: LAST_FRAGMENT_AT,
    supabase,
    canonical_stage: "ownership_confirmation",
    burst_event_ids: ["evt-fragment-1"],
    current_inbound_event_id: "evt-fragment-2",
  });

  assert.equal(context.question_status, "answered", "a real prior answer still settles it");
  assert.equal(context.unanswered_question, false);
  assert.equal(context.intervening_inbound_count, 1);
});
