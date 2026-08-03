/**
 * Contextual short-reply resolution — production incident 2026-08-03.
 *
 * Outbound (delivered): "Hi Ryan, this is Scott. Do you still own 4157 Pillsbury
 * Ave S Unit B? I'm reaching out about a proposal for the property."
 * Inbound: "Yeah"
 *
 * Production classified ownership_confirmed but capped confidence at 0.72 via
 * `short_reply_without_validated_context`, which failed the 0.82 automation gate
 * and routed an unambiguous answer to human review — no reply was ever queued.
 *
 * The resolver (conversation-context.js) was already complete. The defect was
 * that nothing built its input, so context_status was permanently 'unavailable'
 * even though the delivered outbound question was sitting in the database.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConversationContext,
  mapMessageTypeToUseCase,
} from "@/lib/domain/classification/build-conversation-context.js";
import {
  validateConversationContext,
  applyContextualShortReply,
} from "@/lib/domain/classification/conversation-context.js";

const THREAD = "+16128072000";
const OUTBOUND_AT = "2026-08-03T22:38:33.178Z";
const INBOUND_AT = "2026-08-03T22:40:31.039Z";

/** Minimal supabase double for the single send_queue lookup. */
function supabaseWithLastOutbound(rows) {
  return {
    from() {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        not: () => builder,
        lte: () => builder,
        order: () => builder,
        limit: async () => ({ data: rows, error: null }),
      };
      return builder;
    },
  };
}

const INCIDENT_ROW = {
  id: "4d211395-bc7b-4bfe-8afb-16a329e636a4",
  message_type: "ownership_check",
  provider_message_id: "SMOTahEuK3QR8WgJi9NEqOseg==",
  sent_at: "2026-08-03T22:38:07.091Z",
  delivered_at: OUTBOUND_AT,
  queue_status: "delivered",
};

// ── the incident ────────────────────────────────────────────────────────────

test("the exact production thread now yields a VALID context", async () => {
  const context = await buildConversationContext({
    thread_key: THREAD,
    inbound_received_at: INBOUND_AT,
    supabase: supabaseWithLastOutbound([INCIDENT_ROW]),
    canonical_stage: "ownership_confirmation",
  });

  assert.ok(context, "the delivered outbound question must resolve to a context");
  assert.equal(context.last_outbound_use_case, "ownership_check");
  assert.equal(context.last_outbound_question_type, "ownership");
  assert.equal(context.canonical_thread, THREAD);

  const validation = validateConversationContext(context);
  assert.equal(
    validation.context_status,
    "valid",
    `context must validate, got ${validation.context_status}: ${validation.reasons}`
  );
});

test('"Yeah" binds to the ownership question above the 0.82 automation gate', async () => {
  const context = await buildConversationContext({
    thread_key: THREAD,
    inbound_received_at: INBOUND_AT,
    supabase: supabaseWithLastOutbound([INCIDENT_ROW]),
  });
  const validated = validateConversationContext(context);

  const applied = applyContextualShortReply("Yeah", validated);
  assert.equal(applied.applied, true, "the resolver must bind the short reply");
  assert.equal(applied.primary_intent, "ownership_confirmed");
  assert.ok(
    applied.confidence >= 0.82,
    `contextual confidence ${applied.confidence} must clear the 0.82 automation gate`
  );
  // The incident value. Any regression that reintroduces it fails here.
  assert.notEqual(applied.confidence, 0.72);
});

// ── affirmative / negative variants against the same context ────────────────

for (const text of [
  "Yeah.",
  "yeah",
  "Yea",
  "Yep",
  "Yup",
  "yes",
  "Sure",
  "Correct",
  "I do",
  "Still do",
  "👍",
  "Si",
  "Sí",
  "Claro",
]) {
  test(`affirmative variant ${JSON.stringify(text)} → ownership_confirmed`, async () => {
    const context = await buildConversationContext({
      thread_key: THREAD,
      inbound_received_at: INBOUND_AT,
      supabase: supabaseWithLastOutbound([INCIDENT_ROW]),
    });
    const validated = validateConversationContext(context);
    const applied = applyContextualShortReply(text, validated);
    assert.equal(applied.applied, true, `${text} must bind to the ownership question`);
    assert.equal(applied.primary_intent, "ownership_confirmed");
    assert.ok(applied.confidence >= 0.82, `${text} confidence ${applied.confidence} too low`);
  });
}

for (const text of ["Nah", "Nope", "no", "Not anymore", "Sold it", "Wrong house", "👎", "ya no"]) {
  test(`negative variant ${JSON.stringify(text)} does not confirm ownership`, async () => {
    const context = await buildConversationContext({
      thread_key: THREAD,
      inbound_received_at: INBOUND_AT,
      supabase: supabaseWithLastOutbound([INCIDENT_ROW]),
    });
    const validated = validateConversationContext(context);
    const applied = applyContextualShortReply(text, validated);
    assert.notEqual(
      applied.primary_intent,
      "ownership_confirmed",
      `${text} must never be read as an ownership confirmation`
    );
  });
}

// ── the same word under a different question resolves differently ───────────

test('"Yeah" after a proposal-interest question is not ownership_confirmed', async () => {
  const context = await buildConversationContext({
    thread_key: THREAD,
    inbound_received_at: INBOUND_AT,
    supabase: supabaseWithLastOutbound([
      { ...INCIDENT_ROW, message_type: "proposal_interest" },
    ]),
  });
  assert.equal(context.last_outbound_use_case, "proposal_interest");
  const validated = validateConversationContext(context);
  const applied = applyContextualShortReply("Yeah", validated);
  assert.notEqual(
    applied.primary_intent,
    "ownership_confirmed",
    "intent must follow the question that was actually asked"
  );
});

// ── the builder never fabricates context ────────────────────────────────────

test("no outbound on the thread → null, never a guessed context", async () => {
  const context = await buildConversationContext({
    thread_key: THREAD,
    inbound_received_at: INBOUND_AT,
    supabase: supabaseWithLastOutbound([]),
  });
  assert.equal(context, null);
  assert.equal(validateConversationContext(context).context_status, "unavailable");
});

test("an unmappable message_type yields null rather than a wrong use case", async () => {
  const context = await buildConversationContext({
    thread_key: THREAD,
    inbound_received_at: INBOUND_AT,
    supabase: supabaseWithLastOutbound([
      { ...INCIDENT_ROW, message_type: "some_unknown_campaign_blast" },
    ]),
  });
  assert.equal(context, null);
});

test("a non-E.164 thread is rejected", async () => {
  const context = await buildConversationContext({
    thread_key: "6128072000",
    inbound_received_at: INBOUND_AT,
    supabase: supabaseWithLastOutbound([INCIDENT_ROW]),
  });
  assert.equal(context, null);
});

test("a supabase failure degrades to null, never throws", async () => {
  const failing = {
    from() {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        not: () => builder,
        lte: () => builder,
        order: () => builder,
        limit: async () => ({ data: null, error: { message: "boom" } }),
      };
      return builder;
    },
  };
  assert.equal(
    await buildConversationContext({
      thread_key: THREAD,
      inbound_received_at: INBOUND_AT,
      supabase: failing,
    }),
    null
  );
});

test("message_type mapping covers the real queue vocabulary", () => {
  assert.equal(mapMessageTypeToUseCase("ownership_check"), "ownership_check");
  assert.equal(mapMessageTypeToUseCase("Follow-Up"), "general_followup");
  assert.equal(mapMessageTypeToUseCase("followup"), "general_followup");
  assert.equal(mapMessageTypeToUseCase("unknown_type"), null);
  assert.equal(mapMessageTypeToUseCase(""), null);
  assert.equal(mapMessageTypeToUseCase(null), null);
});

// ── the legacy threshold no longer re-vetoes a resolved reply ───────────────

test("legacy auto-reply plan accepts a context-resolved 0.88", async () => {
  const { shouldSuppressSellerAutoReply, SELLER_AUTO_REPLY_CONFIDENCE_THRESHOLD } = await import(
    "@/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js"
  );
  assert.equal(SELLER_AUTO_REPLY_CONFIDENCE_THRESHOLD, 0.82);

  const verdict = shouldSuppressSellerAutoReply({
    auto_reply_enabled: true,
    classification: { confidence: 0.88, primary_intent: "ownership_confirmed" },
    intent: "ownership_confirmed",
  });
  assert.notEqual(
    verdict.reason,
    "confidence_too_low",
    "0.88 cleared the canonical gate and must not be re-vetoed here"
  );
});

test("a genuinely uncertain message is still suppressed", async () => {
  const { shouldSuppressSellerAutoReply } = await import(
    "@/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js"
  );
  const verdict = shouldSuppressSellerAutoReply({
    auto_reply_enabled: true,
    classification: { confidence: 0.4, primary_intent: "unclear" },
    intent: "unclear",
  });
  assert.equal(verdict.suppress, true);
  assert.equal(verdict.reason, "confidence_too_low");
});
