/**
 * Round 10 (owner, 2026-10-08) — regression set the owner asked for:
 *   nurture creation (full render context, seller-evidence language only),
 *   cancellation (substantive reply vs the old false not-interested cancel),
 *   restoration (a restored row whose language came from our outbound),
 *   language (EN / ES; unknown or conflicting -> hold), missing context -> hold
 *   (never the S1 pool), opt-outs vs not-interested in every language,
 *   ownership denials vs wrong numbers, and final-send suppression of a nurture
 *   row through the P1 send-time guard (send-time-contact-guard.js).
 * Pure / injected; no network.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { identifyReplyLanguage } from "@/lib/domain/classification/seller-reply-language.js";
import { buildNurtureRenderContext, missingNurtureContextFields } from "@/lib/domain/seller-flow/nurture-render-context.js";
import { scheduleFollowUp } from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { resolveDeferredQueueMessage, NURTURE_TEMPLATE_CANDIDATES } from "@/lib/domain/queue/resolve-deferred-queue-message.js";
import { shouldKeepNurtureFollowUps } from "@/lib/domain/automation/automation-actions.js";
import { resolveRound10ReplyLanguage } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { evaluateSendTimeContactGuard, SEND_TIME_GUARD_REASONS as G } from "@/lib/domain/queue/send-time-contact-guard.js";

const SELLER = "+13125550100";
const OUR = "+16125550199";
const NOW = Date.parse("2026-11-08T15:00:00.000Z");

function captureSupabase(inserted) {
  const chain = () => {
    const c = {
      select: () => c, eq: () => c, in: () => c, or: () => c, not: () => c, order: () => c, limit: () => c,
      ilike: async () => ({ count: 0, data: [], error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve) => resolve({ data: [], count: 0, error: null }),
    };
    return c;
  };
  return {
    from(table) {
      const base = chain();
      if (table === "send_queue") {
        base.insert = (payload) => {
          inserted.push(payload);
          return { select: () => ({ maybeSingle: async () => ({ data: { id: 901, ...payload }, error: null }) }) };
        };
      }
      return base;
    },
  };
}
function templatesSupabase(templates) {
  return {
    from(table) {
      const f = {};
      const c = {
        select: () => c,
        eq: (k, v) => { f[k] = v; return c; },
        in: (k, v) => { f[k] = v; return c; },
        maybeSingle: async () => ({ data: null, error: null }),
        limit: async () => ({ data: table === "sms_templates" ? templates.filter((t) => (f.language || []).includes(t.language) && (f.use_case || []).includes(t.use_case)) : [], error: null }),
      };
      return c;
    },
  };
}
const TEMPLATES = [
  { template_id: "400065", use_case: "consider_selling", language: "English", is_active: true, safe_for_auto_reply: true, template_body: "Thanks for confirming. Would you consider a proposal for the property?" },
  { template_id: "521105", use_case: "consider_selling_follow_up", language: "English", is_active: true, safe_for_auto_reply: true, template_body: "{{seller_first_name}}, just checking back on {{property_address}}. Would you be open to a proposal?" },
  { template_id: "es-1", use_case: "consider_selling_follow_up", language: "Spanish", is_active: true, safe_for_auto_reply: true, template_body: "{{seller_first_name}}, le escribo de nuevo sobre {{property_address}}. ¿Consideraría una propuesta?" },
];
const sentRows = (language) => [{ property_id: "p1", seller_first_name: "Maria", property_address: "412 W Oak St", from_phone_number: OUR, agent_name: "Alex", language }];

async function schedule(reply_text, { sent_language = "English", history = [] } = {}) {
  const inserted = [];
  const result = await scheduleFollowUp(
    "not_interested",
    SELLER,
    {
      source: "seller_inbound_orchestrator",
      master_owner_id: "mo_1",
      property_id: "p1",
      inbound_message_event_id: "me-1",
      inbound_to: OUR,
      reply_text,
      render_context_loader: async (_s, args) =>
        buildNurtureRenderContext({ known: args.known, sent_rows_newest_first: sentRows(sent_language), thread_state: { our_number: OUR }, reply_text: args.reply_text, inbound_rows_newest_first: history, intent: args.intent }),
    },
    captureSupabase(inserted)
  );
  return { result, row: inserted[0] };
}

// ── nurture creation ────────────────────────────────────────────────────────
test("nurture creation: full render context; the language is the SELLER's ('No me interesa' -> Spanish) even after an English outbound", async () => {
  const { result, row } = await schedule("No me interesa", { sent_language: "English" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(row.seller_first_name, "Maria");
  assert.equal(row.property_address, "412 W Oak St");
  assert.equal(row.from_phone_number, OUR);
  assert.equal(row.agent_name, "Alex");
  assert.equal(row.metadata.language, "Spanish");
  assert.equal(row.metadata.nurture_render_context.language_source, "seller_reply");
  assert.equal(row.metadata.nurture_render_context.outbound_language_context, "English");
  assert.equal(row.metadata.followup_reason, "nurture_followup:not_interested");
});

test("nurture creation: no seller language evidence -> no language written (never our outbound's, never English)", async () => {
  const { row } = await schedule("👍", { sent_language: "Spanish" });
  assert.equal(row.metadata.language, undefined);
  assert.equal(row.metadata.nurture_render_context.language_source, "unknown");
  assert.equal(row.metadata.nurture_render_context.outbound_language_context, "Spanish");
  assert.ok(missingNurtureContextFields(row).includes("language"));
});

test("nurture creation: the seller's earlier inbound decides when this reply cannot ('ok' after 'No estoy vendiendo')", async () => {
  const { row } = await schedule("ok", { history: [{ message_body: "No estoy vendiendo" }] });
  assert.equal(row.metadata.language, "Spanish");
  assert.equal(row.metadata.nurture_render_context.language_source, "seller_history");
});

test("nurture creation: conflicting seller evidence (English reply, Spanish history) -> no language (hold)", async () => {
  const { row } = await schedule("Not interested in selling", { history: [{ message_body: "No estoy vendiendo la casa" }] });
  assert.equal(row.metadata.language, undefined);
  assert.equal(row.metadata.nurture_render_context.language_source, "conflict");
});

// ── send time: missing context / language -> hold, never the S1 pool ──────
const nurtureRow = (extra = {}) => ({
  id: "q-1", to_phone_number: SELLER, property_id: "p1", use_case_template: "nurture_not_interested", message_body: "",
  seller_first_name: "Maria", property_address: "412 W Oak St", agent_name: "Alex", from_phone_number: OUR,
  metadata: { deferred_message_resolution: true, intent: "not_interested", inbound_message_event_id: "me-1" },
  ...extra,
});

test("send time: never the S1 consider_selling pool; missing language -> HOLD_LANGUAGE (no send)", async () => {
  assert.ok(!NURTURE_TEMPLATE_CANDIDATES.not_interested.includes("consider_selling"));
  const r = await resolveDeferredQueueMessage(nurtureRow(), { supabase: templatesSupabase(TEMPLATES), loadNurtureRenderContext: async () => ({ language: null }) });
  assert.equal(r.resolved, false);
  assert.equal(r.reason, "hold_language");
});

test("send time: missing name -> pause (no 'Thanks for confirming' copy)", async () => {
  const r = await resolveDeferredQueueMessage(nurtureRow({ seller_first_name: null, language: "English" }), {
    supabase: templatesSupabase(TEMPLATES),
    loadNurtureRenderContext: async () => ({ seller_first_name: null }),
  });
  assert.equal(r.resolved, false);
  assert.notEqual(r.template_id, "400065");
});

test("send time: a Spanish row renders Spanish copy only; English copy never answers it", async () => {
  const es = await resolveDeferredQueueMessage(nurtureRow({ language: "Spanish" }), { supabase: templatesSupabase(TEMPLATES), loadNurtureRenderContext: async () => ({}) });
  assert.equal(es.resolved, true);
  assert.equal(es.template_id, "es-1");
  const esOnlyEnglish = await resolveDeferredQueueMessage(nurtureRow({ language: "Spanish" }), { supabase: templatesSupabase(TEMPLATES.filter((t) => t.language === "English")), loadNurtureRenderContext: async () => ({}) });
  assert.equal(esOnlyEnglish.resolved, false);
});

// ── restoration ─────────────────────────────────────────────────────────────
test("restoration: a restored row whose language came only from our outbound re-resolves from the seller, else holds", async () => {
  const restored = nurtureRow({ language: "English" });
  restored.metadata = { ...restored.metadata, language: "English", nurture_render_context: { language_source: "last_outbound" } };
  assert.ok(missingNurtureContextFields(restored).includes("language"));
  const held = await resolveDeferredQueueMessage(restored, { supabase: templatesSupabase(TEMPLATES), loadNurtureRenderContext: async () => ({ language: null }) });
  assert.equal(held.reason, "hold_language");
  const fromSeller = await resolveDeferredQueueMessage(restored, { supabase: templatesSupabase(TEMPLATES), loadNurtureRenderContext: async () => ({ language: "Spanish" }) });
  assert.equal(fromSeller.template_id, "es-1");
});

// ── cancellation ────────────────────────────────────────────────────────────
test("cancellation: the 'not interested' cancel spares the nurture (the old false cancel); compliance / wrong number / not owner cancel it", () => {
  assert.equal(shouldKeepNurtureFollowUps({ reason: "not_interested" }), true);
  assert.equal(shouldKeepNurtureFollowUps({ reason: "seller_not_interested", keep_nurture_follow_ups: true }), true);
  for (const reason of ["opt_out", "stop_texting", "wrong_number", "not_owner", "suppression"]) {
    assert.equal(shouldKeepNurtureFollowUps({ reason }), false, reason);
  }
});

// ── language (EN / ES; unknown / conflicting -> hold) ──────────────────────
for (const [message, lang] of [
  ["No me interesa", "Spanish"], ["No estoy vendiendo", "Spanish"], ["No estoy vendiendo la casa", "Spanish"],
  ["borra mi número", "Spanish"], ["quite este número de la lista", "Spanish"], ["no me escriba más", "Spanish"], ["deja de molestar", "Spanish"],
  ["Not interested", "English"], ["Not for sale", "English"], ["Yes. Why", "English"],
  ["👍", null], ["150k", null], ["ok", null], ["No", null],
]) {
  test(`language evidence: ${JSON.stringify(message)} -> ${lang}`, async () => {
    assert.equal(identifyReplyLanguage(message), lang, message);
    if (lang) assert.equal((await classify(message, null, { heuristicOnly: true })).language, lang, message);
  });
}

test("auto-reply language: unknown -> hold; conflicting -> hold; our outbound never decides", () => {
  const u = { language: "unknown", source: "unknown", is_unknown: true };
  assert.equal(resolveRound10ReplyLanguage(u, { classification: { language: "Spanish", reply_language_source: "thread" } }).is_unknown, true);
  const conflict = resolveRound10ReplyLanguage(u, { classification: { language: "English", reply_language_source: "seller_reply", seller_history_language: "Spanish" } });
  assert.equal(conflict.is_unknown, true);
  assert.equal(conflict.source, "hold_language_conflict");
  assert.equal(resolveRound10ReplyLanguage(u, { classification: { language: "Spanish", reply_language_source: "seller_reply", seller_history_language: "Spanish" } }).language, "Spanish");
  assert.equal(resolveRound10ReplyLanguage(u, { classification: { language: "Spanish", reply_language_source: "language_switch_request", seller_history_language: "English" } }).language, "Spanish");
});

// ── opt-out vs not interested, every language ───────────────────────────────
for (const message of ["borra mi número", "quite este número de la lista", "no me escriba más", "deja de molestar", "Stop texting me", "please do not bother us", "remove me from all your lists", "Pare de me mandar mensagem"]) {
  test(`opt-out: ${JSON.stringify(message)}`, async () => {
    const c = await classify(message, null, { heuristicOnly: true });
    assert.equal(c.compliance_flag, "stop_texting", message);
    assert.equal(c.automation_decision.suppression_action, "opt_out");
  });
}
for (const message of ["No me interesa", "No estoy vendiendo", "No está en venta", "Not interested", "Not for sale", "Não estou vendendo", "No gracias"]) {
  test(`negative selling intent is NOT an opt-out: ${JSON.stringify(message)}`, async () => {
    const c = await classify(message, null, { heuristicOnly: true });
    assert.notEqual(c.compliance_flag, "stop_texting", message);
    assert.notEqual(c.primary_intent, "opt_out", message);
    assert.notEqual(c.automation_decision.suppression_action, "opt_out", message);
  });
}

// ── ownership denial vs wrong number ────────────────────────────────────────
for (const [message, intent, action] of [
  ["I never owned it", "property_specific_non_owner", "close_property_not_owner"],
  ["Nunca tuve esa propiedad", "property_specific_non_owner", "close_property_not_owner"],
  ["That's not my house", "property_specific_non_owner", "close_property_not_owner"],
  ["wrong number", "wrong_number", "archive_wrong_number"],
  ["you have the wrong person", "wrong_number", "archive_wrong_number"],
  ["número equivocado", "wrong_number", "archive_wrong_number"],
]) {
  test(`${JSON.stringify(message)} -> ${intent}`, async () => {
    const c = await classify(message, null, { heuristicOnly: true });
    assert.equal(c.primary_intent, intent, message);
    assert.equal(c.automation_decision.suppression_action, action);
  });
}

// ── final-send suppression of a nurture row (P1 send-time guard) ────────────
const nurtureSend = (extra = {}) => ({
  id: "q-n", to_phone_number: SELLER, thread_key: SELLER, from_phone_number: OUR, property_id: "p1", prospect_id: "pr-1",
  type: "followup", message_type: "followup", touch_number: 2, queue_status: "processing", created_at: "2026-11-08T14:00:00.000Z",
  metadata: { followup_reason: "nurture_followup:not_interested" }, ...extra,
});
const guard = (facts) => evaluateSendTimeContactGuard(nurtureSend(), facts, { now: NOW });

test("final send: a clean nurture row passes the send-time guard (and is exempt from the opener already-contacted rule)", () => {
  const r = guard({ prior_sends: [{ to_phone_number: SELLER, sent_at: "2026-10-08T14:00:00.000Z", property_id: "p1" }] });
  assert.equal(r.blocked, false);
});

for (const [name, facts, reason] of [
  ["an opt-out on the suppression list", { suppressions: [{ phone_e164: SELLER, is_active: true }] }, G.SUPPRESSION_LIST],
  ["an opt-out reply after scheduling", { inbound_replies: [{ from_phone_number: SELLER, detected_intent: "opt_out" }] }, G.OPT_OUT_REPLY],
  ["a wrong-number reply", { inbound_replies: [{ from_phone_number: SELLER, detected_intent: "wrong_number" }] }, G.WRONG_NUMBER],
  ["a round-10 ownership denial for this property", { inbound_replies: [{ from_phone_number: SELLER, detected_intent: "property_specific_non_owner", property_id: "p1" }] }, G.PRIOR_REPLY_NOT_OWNER],
  ["a suppressed thread", { threads: [{ thread_key: SELLER, is_suppressed: true }] }, G.THREAD_SUPPRESSED],
]) {
  test(`final send: a nurture row is blocked by ${name}`, () => {
    const r = guard(facts);
    assert.equal(r.blocked, true);
    assert.equal(r.reason, reason);
  });
}

test("final send: an ownership denial for ANOTHER property does not block this property's nurture (phone kept)", () => {
  const r = guard({ inbound_replies: [{ from_phone_number: SELLER, detected_intent: "property_specific_non_owner", property_id: "p-other" }] });
  assert.equal(r.blocked, false);
});

// Owner correction (2026-10-08): NOT INTERESTED IS NOT AN OPT-OUT. No round-10
// rule may turn a rejection, a not-now or a price objection into suppression.
for (const message of ["No more", "No", "Not now", "Maybe later", "Not at this time", "Not interested, thanks", "Too low", "Your offer is too low", "No thanks, not selling", "No me interesa, gracias", "No está en venta", "Never selling", "Not for sale. Have a nice day"]) {
  test(`a decline is never suppressed by a round-10 rule: ${JSON.stringify(message)}`, async () => {
    const c = await classify(message, null, { heuristicOnly: true });
    assert.notEqual(c.compliance_flag, "stop_texting", message);
    assert.notEqual(c.automation_decision.suppression_action, "opt_out", message);
    assert.ok(!(c.round10_rules?.rule_ids || []).some((r) => /opt_out|remove|bother|cease|no_more|stop/.test(r)), JSON.stringify(c.round10_rules));
  });
}
