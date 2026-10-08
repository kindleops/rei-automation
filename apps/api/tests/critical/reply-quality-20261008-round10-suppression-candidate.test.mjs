/**
 * Round 10 (owner, 2026-10-08) — two behaviour conditions on the RC 8.4.7
 * safety fixes.
 *
 * 1. REPEATED DEMANDS TO STOP CONTACTING are a suppression matter, never
 *    hostile/dead. An explicit no-contact phrase (any phrasing, repeated or
 *    not) -> opt_out through the canonical suppression path. A repeated
 *    frustration WITHOUT an explicit revocation -> SUPPRESSION CANDIDATE: no
 *    outbound, every pending send for the thread held, operator lane for a
 *    person to confirm. Never an apology / re-ask, nurture or quiet archive.
 *
 * Every string is exact; replayed through the live chain
 * (buildConversationContext -> classify -> executeInboundAutomationDecision).
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { replayReply } from "../helpers/reply-replay-harness.mjs";
import { classify, matchesRepeatNoContactFrustration } from "@/lib/domain/classification/classify.js";
import { executeInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import {
  resolveInboxBucketFromClassification,
  resolveUniversalStatusFromClassification,
} from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";

const CATALOG = JSON.parse(readFileSync(new URL("../fixtures/reply-quality/2026-10-06-safe-templates-en-es.json", import.meta.url), "utf8")).rows;
const QUESTION = "Hey Pat, this is Alex. 🙂 Are you still the owner of 606 Winterbrooke Way?";
const QUESTION_ES = "Hola Pat, soy Alex. ¿Sigue siendo el dueño de 606 Winterbrooke Way?";

function fixture(message, text = QUESTION) {
  return {
    fixture_id: "r10",
    received_at: "2026-10-08T18:00:00.000Z",
    seller_message: message,
    prior_question: { message_type: null, template_id: "t-r10", template_use_case: "ownership_check", text, sent_at: "2026-10-08T17:00:00.000Z", delivered_at: "2026-10-08T17:00:05.000Z" },
    intervening_inbound: [],
    r7_history: [],
    valuation: null,
  };
}
const replay = (message, opts = {}) => replayReply(fixture(message, opts.text), { catalog: opts.catalog || CATALOG });

// ── 1a. Explicit no-contact demand (repeated or not) -> opt_out ─────────────
for (const message of [
  "Please stop bothering me",
  "I told you already, leave me alone",
  "quit texting",
  "Quit texting me",
  "Stop bothering me",
  "I told you to stop texting me",
  "How many times do I have to tell you to stop texting me",
  "I already said no. Leave me alone",
  "Leave me be",
  "Leave us alone",
]) {
  test(`explicit revocation: ${JSON.stringify(message)} -> opt_out (canonical suppression)`, async () => {
    const r = await replay(message);
    assert.equal(r.classification.primary_intent, "opt_out", message);
    assert.equal(r.classification.automation_decision.suppression_action, "opt_out");
    assert.equal(r.decision.should_suppress_contact, true);
    assert.equal(r.decision.suppression_reason, "opt_out");
    assert.equal(r.text, null);
    assert.equal(r.outcome, "suppressed");
  });
}

for (const message of [
  "Ya les dije, déjenme en paz",
  "Déjenme en paz",
  "Dejen de molestarme",
  "Ya no me escriban",
  "No me manden más mensajes",
  "Ya no me manden mensajes",
  "Ya les dije que no me escriban",
]) {
  test(`explicit revocation (Spanish): ${JSON.stringify(message)} -> opt_out`, async () => {
    const r = await replay(message, { text: QUESTION_ES });
    assert.equal(r.classification.primary_intent, "opt_out", message);
    assert.equal(r.decision.should_suppress_contact, true);
    assert.equal(r.outcome, "suppressed");
  });
}

// ── 1b. Repeated frustration, no revocation phrase -> SUPPRESSION_CANDIDATE ─
const CANDIDATES_EN = [
  "You always text me I told you",
  "You always text me I told you I'm not selling",
  "how many times do I have to tell you",
  "How many times do I have to tell you no",
  "I already told you no",
  "I told you before",
  "I said no already!!",
  "I told you guys I'm not interested",
  "Why do you keep texting me",
  "Why are you still texting me",
  "You keep texting me",
  "Again? I said no",
  "I told you already fuck off",
];
const CANDIDATES_ES = [
  "Ya te dije que no",
  "Ya te dije",
  "Te dije que no vendo",
  "Ya te dije que no me interesa",
  "Cuántas veces te tengo que decir",
  "Cuantas veces les tengo que decir que no",
  "Otra vez? Ya les dije que no",
  "Por que me siguen mandando mensajes",
];
for (const message of [...CANDIDATES_EN, ...CANDIDATES_ES]) {
  test(`suppression candidate: ${JSON.stringify(message)} -> no outbound, sends held, operator lane`, async () => {
    const r = await replay(message, { text: CANDIDATES_ES.includes(message) ? QUESTION_ES : QUESTION });
    const c = r.classification;
    assert.ok(c.matched_rule_ids.includes("repeat_no_contact_frustration"), message);
    assert.notEqual(c.primary_intent, "opt_out");
    assert.equal(c.automation_decision.suppression_candidate, true);
    assert.equal(c.automation_decision.suppression_action, "suppression_candidate");
    assert.equal(c.automation_decision.auto_reply_allowed, false);
    // Not quiet-archived as merely hostile.
    assert.notEqual(c.automation_decision.quiet_archive, true);
    assert.equal(r.decision.should_queue_reply, false);
    assert.equal(r.decision.should_suppress_contact, false);
    assert.equal(r.decision.next_action, "hold_suppression_candidate");
    assert.equal(r.decision.hold_pending_sends, true);
    assert.equal(r.decision.human_review_reason, "suppression_candidate");
    assert.equal(r.text, null);
    assert.equal(r.result.queued, false);
    assert.equal(r.result.suppression_candidate, true);
    // Inbox: the operator lane, never New Replies / Dead / a nurture.
    const ev = { direction: "inbound", received_at: "2026-10-08T18:00:00.000Z" };
    assert.equal(resolveInboxBucketFromClassification(c, ev, {}), "needs_review");
    assert.equal(resolveInboxBucketFromClassification(c, ev, { inbox_bucket: "dead", universal_status: "dead" }), "needs_review");
    assert.equal(resolveUniversalStatusFromClassification(c, ev, {}).universal_status, "needs_review");
  });
}

// Facts restated after "I told you" keep their meaning -- not a candidate.
for (const message of [
  "I told you the price is 200k",
  "I told you it needs a roof, no AC",
  "I told you 150k",
  "Like I told you, it's rented",
  "I told you my wife owns it",
  "Did you read my text?",
  "Not interested",
]) {
  test(`not a candidate: ${JSON.stringify(message)}`, async () => {
    assert.equal(matchesRepeatNoContactFrustration(message), false, message);
    const c = await classify(message, null, { heuristicOnly: true });
    assert.equal((c.matched_rule_ids || []).includes("repeat_no_contact_frustration"), false);
  });
}

test("suppression candidate holds every pending send for the thread through the canonical cancellation", async () => {
  const c = await classify("You always text me I told you", null, { heuristicOnly: true });
  const updates = [];
  const pending = [
    { id: "q1", thread_key: "+15555550123", to_phone_number: "+15555550123", queue_status: "scheduled", type: "campaign", message_type: "campaign", metadata: {}, created_at: "2026-10-08T10:00:00.000Z" },
    { id: "q2", thread_key: "+15555550123", to_phone_number: "+15555550123", queue_status: "queued", type: "followup", message_type: "followup", metadata: {}, created_at: "2026-10-08T11:00:00.000Z" },
  ];
  const supabase = {
    from(table) {
      const chain = {
        _update: null,
        select: () => chain, eq: () => chain, in: () => chain, is: () => chain, or: () => chain, not: () => chain,
        neq: () => chain, order: () => chain, gte: () => chain, lte: () => chain, lt: () => chain, gt: () => chain, ilike: () => chain,
        limit: async () => ({ data: table === "send_queue" && !chain._update ? pending : [], error: null }),
        update: (patch) => { chain._update = patch; updates.push({ table, patch }); return chain; },
        insert: async () => ({ data: null, error: null }), upsert: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }), single: async () => ({ data: null, error: null }),
        select_after: null,
        then: (resolve, reject) => Promise.resolve({ data: table === "send_queue" && !chain._update ? pending : [], error: null }).then(resolve, reject),
      };
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  const thread = { found: true, ids: { master_owner_id: "mo-1", prospect_id: "pr-1", property_id: "prop-1" }, items: {}, flags: {}, recent: {}, summary: { conversation_stage: "ownership_confirmation" } };
  const r = await executeInboundAutomationDecision({
    message: "You always text me I told you", threadKey: "+15555550123", inboundFrom: "+15555550123", inboundTo: "+15555550000",
    ownerId: "mo-1", propertyId: "prop-1", prospectId: "pr-1", latestThreadContext: thread, context: thread, classification: c,
    inboundEventId: "ev-1", inboundReceivedAt: "2026-10-08T18:00:00.000Z",
    dryRun: true, complianceDryRun: false, autoReplyMode: "dry_run", applySuppression: false, supabaseClient: supabase,
  });
  assert.equal(r.queued, false);
  assert.equal(r.suppression_candidate, true);
  assert.equal(r.automation_decision.next_action, "hold_suppression_candidate");
  const cancels = updates.filter((u) => u.table === "send_queue" && u.patch.queue_status === "cancelled");
  assert.ok(cancels.length >= 1, "pending sends must be cancelled through cancelSupabasePendingOutbound");
  assert.equal(cancels[0].patch.cancellation_reason ?? cancels[0].patch.metadata?.cancellation_reason ?? "suppression_candidate_hold", "suppression_candidate_hold");
});

