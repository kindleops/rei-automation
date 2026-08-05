/**
 * The 2026-08-03 incident, driven through the REAL composition.
 *
 * A delivered ownership question, then the seller answers "Yeah". Nothing built
 * conversation_context_v1, so classify() capped confidence at 0.72 via
 * `short_reply_without_validated_context`, missed the 0.82 automation gate, and
 * an unambiguous answer went to human review. The context was in the database
 * the whole time.
 *
 * WHY THIS FILE EXISTS ALONGSIDE textgrid-inbound-conversation-context.test.mjs:
 * that suite injects stubs for BOTH `buildConversationContext` AND `classify`,
 * so it proves the webhook WIRES them together but cannot fail if either one
 * really regresses — a mocked classify returns 0.88 no matter what the real
 * classifier would have said. Here both are REAL. Only the database is a double.
 *
 * ROUTE COVERED: the burst-deferral path (Route B), which is the path the
 * incident actually took. handle-textgrid-inbound builds `orchestration_context`
 * with no `classification` key (handle-textgrid-inbound.js:2227-2248), the
 * coordinator forwards `classification: ctx.classification ?? null`
 * (seller-inbound-burst-coordinator.js:471), so the `if (!classification)`
 * fallback in processSellerInboundMessage:572 fires and classifies the
 * AGGREGATED burst body. That fallback imports buildConversationContext
 * directly (not through runtimeDeps), so the builder under test is production's.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { aggregateBurstMessage } from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";

const THREAD = "+15550100042";
const DELIVERED_AT = "2026-08-03T22:38:33.178Z";
const FIRST_INBOUND_AT = "2026-08-03T22:40:31.039Z";
const SECOND_INBOUND_AT = "2026-08-03T22:40:38.000Z";

/** The automation gate the incident failed to clear. */
const AUTOMATION_CONFIDENCE_GATE = 0.82;

/**
 * A database holding exactly what production held on 2026-08-03: one delivered
 * ownership question on the thread, and whatever inbound events have been
 * recorded since.
 */
function conversationDatabase({ intervening_inbound = [] } = {}) {
  const terminal = (rows) => {
    const node = {
      select: () => node,
      eq: () => node,
      in: () => node,
      not: () => node,
      is: () => node,
      or: () => node,
      lt: () => node,
      lte: () => node,
      gt: () => node,
      gte: () => node,
      order: () => node,
      limit: () => node,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve) => resolve({ data: rows, error: null }),
    };
    return node;
  };

  return {
    from(table) {
      if (table === "send_queue") {
        // The ownership question — sent, delivered, before the inbound.
        return terminal([
          {
            id: "queue-1",
            message_type: "ownership",
            provider_message_id: "SM-outbound-1",
            sent_at: DELIVERED_AT,
            delivered_at: DELIVERED_AT,
            queue_status: "delivered",
          },
        ]);
      }
      if (table === "message_events") return terminal(intervening_inbound);
      return terminal([]);
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

/**
 * Silence everything downstream of classification. `classify` is deliberately
 * NOT overridden — the real classifier is the subject of this test, and
 * buildConversationContext is a direct import that cannot be stubbed at all.
 */
function stubDownstream(supabase) {
  __setSellerInboundOrchestratorDeps({
    runInboundIntelligencePhase: async () => ({ ok: true }),
    executeInboundAutomationDecision: async () => ({ ok: true, queued: false }),
    persistInboundIntelligenceSnapshot: async () => ({ ok: true }),
    persistSellerContactReferral: async () => ({ ok: true }),
    executeReferralAutomation: async () => ({ ok: true }),
    resolveSellerAutoReplyPlan: async () => ({ should_queue_reply: false, plan: {} }),
    scheduleFollowUp: async () => ({ ok: true }),
    cancelPendingFollowUpsForThread: async () => ({ ok: true, cancelled: 0 }),
    patchUniversalLeadState: async () => ({ ok: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    getSupabaseClient: () => supabase,
    info: () => {},
    warn: () => {},
  });
}

/** Runs the burst-deferral handoff exactly as the coordinator does. */
async function classifyThroughBurstFallback({ fragments, intervening_inbound = [] }) {
  const supabase = conversationDatabase({ intervening_inbound });
  stubDownstream(supabase);

  const aggregated = aggregateBurstMessage(fragments);
  const result = await processSellerInboundMessage({
    message: aggregated.message,
    threadKey: THREAD,
    inboundFrom: THREAD,
    // The coordinator hands the LAST fragment's id as the inbound event and
    // the whole generation as burstContext — seller-inbound-burst-coordinator.js:477,499-513.
    inboundEventId: fragments[fragments.length - 1].event_id,
    inboundReceivedAt: aggregated.last_authorized_received_at,
    // The coordinator forwards null here — this is what makes the fallback run.
    classification: null,
    stageBefore: "Ownership Confirmation",
    supabaseClient: supabase,
    burstContext: {
      burst_id: `sib:${THREAD}:g1:${fragments[0].event_id}`,
      generation: 1,
      constituent_event_ids: aggregated.ordered_event_ids,
      constituent_messages: fragments.map((f) => ({
        event_id: f.event_id,
        provider_message_id: f.provider_message_id,
        body: f.body,
        received_at: f.received_at,
      })),
      message_count: aggregated.message_count,
      attempt_count: 1,
    },
    dryRun: true,
    autoReplyMode: "disabled",
  });
  return { aggregated, result, classification: result?.classification };
}

const fragment = (event_id, body, at) => ({
  event_id,
  provider_message_id: `SM-${event_id}`,
  body,
  received_at: at,
  authorized_received_at: at,
});

test.afterEach?.(() => __resetSellerInboundOrchestratorDeps());

// ── the single-fragment case: this is the part that works ───────────────────

test("a lone 'Yeah' binds to the delivered ownership question and clears the gate", async (t) => {
  t.after(() => __resetSellerInboundOrchestratorDeps());

  const { classification } = await classifyThroughBurstFallback({
    fragments: [fragment("e1", "Yeah", FIRST_INBOUND_AT)],
  });

  assert.equal(classification.context_status, "valid", "the context was in the database");
  assert.equal(classification.precedence_result, "contextual_short_reply_override");
  assert.equal(classification.primary_intent, "ownership_confirmed");
  assert.equal(classification.confidence, 0.88);
  assert.ok(
    classification.confidence >= AUTOMATION_CONFIDENCE_GATE,
    `must clear the ${AUTOMATION_CONFIDENCE_GATE} automation gate, got ${classification.confidence}`
  );
  assert.equal(classification.automation_decision.auto_reply_allowed, true);
  assert.equal(classification.automation_decision.human_review_required, false);
  // The exact incident signature must be gone.
  assert.equal(
    (classification.ambiguity_flags || []).includes("short_reply_without_validated_context"),
    false,
    "the 0.72 cap flag must not be raised when the context is available"
  );
});

test("without a delivered question the classifier degrades honestly, it does not fabricate", async (t) => {
  t.after(() => __resetSellerInboundOrchestratorDeps());

  const supabase = {
    from: () => {
      const node = {
        select: () => node, eq: () => node, in: () => node, not: () => node, is: () => node,
        or: () => node, lt: () => node, lte: () => node, gt: () => node, gte: () => node,
        order: () => node, limit: () => node,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return node;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  stubDownstream(supabase);

  const result = await processSellerInboundMessage({
    message: "Yeah",
    threadKey: THREAD,
    inboundFrom: THREAD,
    inboundEventId: "e1",
    inboundReceivedAt: FIRST_INBOUND_AT,
    classification: null,
    stageBefore: "Ownership Confirmation",
    supabaseClient: supabase,
    dryRun: true,
    autoReplyMode: "disabled",
  });

  const c = result?.classification;
  assert.equal(c.context_status, "unavailable", "no outbound history means no context");
  assert.equal(c.confidence, 0.72, "the documented cap, applied honestly");
  assert.equal(c.automation_decision.human_review_required, true, "and it goes to a human");
});

// ── the two-fragment case: THE ACTUAL INCIDENT SHAPE ─────────────────────────

test("KNOWN LIMITATION: a multi-fragment burst answering the question routes to human review (cause two deferred, PR #66 — needs a disengagement model, not a phrase list)", async (t) => {
  t.after(() => __resetSellerInboundOrchestratorDeps());

  // Characterizes CURRENT behaviour. A contextual rescue for multi-fragment
  // bursts was built and then DELIBERATELY REVERTED; this test exists so the
  // day someone re-attempts it, they inherit the evidence instead of repeating
  // it, and this assertion fails loudly to tell them the shape changed.
  //
  // WHY IT WAS REVERTED — structurally unsafe, not merely under-hardened:
  //   * Two rounds of vocabulary hardening each leaked ~70% of unseen phrasings
  //     (30 of 45, then 26 of 36).
  //   * Explicit stop requests were among the leaks. "Yeah\nthis number is on
  //     dnc", "Yeah\nno me contacten mas" and "Yeah\nim blocking this number"
  //     were all promoted to ownership_confirmed 0.88 with auto-reply allowed —
  //     a literal DNC assertion answered by an automated text.
  //   * The rescue only fires when the extra fragment is UNCLASSIFIABLE: 0 of 11
  //     firings had a confidently-classified fragment, 7 of 7 had an unclear one.
  //     Its entire domain is the set the classifier does not understand, and
  //     inside that set "its a 3br" and "please quit bothering me" are both
  //     `unclear 0.6` — indistinguishable. A blocklist would have to enumerate an
  //     open set; an allowlist only fires where the classifier already succeeded,
  //     which is exactly where the rescue is never invoked.
  // Separating them needs a model of disengagement, not more vocabulary.
  //
  // SEVERITY: missed automation, not a correctness or compliance defect. The
  // seller is routed to a human, which is the conservative direction. Contrast
  // the 2026-08-03 incident, where a lone "Yeah" ALSO went to review — that half
  // is fixed and asserted live above.
  const { aggregated, classification } = await classifyThroughBurstFallback({
    fragments: [
      fragment("e1", "Yeah", FIRST_INBOUND_AT),
      fragment("e2", "its a 3br", SECOND_INBOUND_AT),
    ],
    intervening_inbound: [
      { id: "e1", created_at: FIRST_INBOUND_AT, direction: "inbound" },
    ],
  });

  assert.equal(aggregated.message_count, 2, "both fragments are in the burst");

  // Cause one IS fixed and stays fixed: the burst's own fragments no longer
  // invalidate their own context. The context is available and valid — the
  // limitation is only that the short-reply override cannot apply to a joined
  // aggregate.
  assert.equal(classification.context_status, "valid", "cause one remains fixed");

  // CURRENT BEHAVIOUR — the deferred half.
  assert.equal(classification.primary_intent, "unclear", "CURRENT BEHAVIOUR");
  assert.equal(classification.confidence, 0.64, "CURRENT BEHAVIOUR");
  assert.equal(classification.precedence_result, "intent_priority", "CURRENT BEHAVIOUR: no contextual override");
  assert.ok(
    classification.confidence < AUTOMATION_CONFIDENCE_GATE,
    "CURRENT BEHAVIOUR: below the automation gate"
  );
  assert.equal(classification.automation_decision.auto_reply_allowed, false, "CURRENT BEHAVIOUR");
  assert.equal(classification.automation_decision.human_review_required, true, "CURRENT BEHAVIOUR: conservative, not harmful");
});

test("the burst's own fragments are not counted as answers to the burst's question", async (t) => {
  t.after(() => __resetSellerInboundOrchestratorDeps());

  // Isolates one of the two compounding causes: buildConversationContext
  // accepts `burst_event_ids` / `current_inbound_event_id` exactly so an
  // in-flight burst's earlier fragment cannot mark the outbound question
  // already-answered. The burst leg must supply them.
  const { classification } = await classifyThroughBurstFallback({
    fragments: [
      fragment("e1", "Yeah", FIRST_INBOUND_AT),
      fragment("e2", "its a 3br", SECOND_INBOUND_AT),
    ],
    intervening_inbound: [
      { id: "e1", created_at: FIRST_INBOUND_AT, direction: "inbound" },
    ],
  });

  assert.notEqual(
    classification.context_status,
    "stale",
    "a fragment of THIS burst must not age out the question it is answering"
  );
  assert.notEqual(classification.context_status, "unavailable");
});

test("a genuine earlier answer DOES settle the question — the exclusion is not blanket", async (t) => {
  t.after(() => __resetSellerInboundOrchestratorDeps());

  // Guards the guard above: an inbound that is NOT part of this burst must
  // still mark the question answered, or the fix would fabricate certainty.
  const { classification } = await classifyThroughBurstFallback({
    fragments: [fragment("e9", "Yeah", SECOND_INBOUND_AT)],
    intervening_inbound: [
      { id: "unrelated-earlier-reply", created_at: FIRST_INBOUND_AT, direction: "inbound" },
    ],
  });

  assert.notEqual(
    classification.precedence_result,
    "contextual_short_reply_override",
    "a question already answered by a different message must not bind this reply"
  );
});
