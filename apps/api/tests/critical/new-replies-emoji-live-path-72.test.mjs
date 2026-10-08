/**
 * EMOJI INTELLIGENCE 7.2 — the live path, offline.
 *
 * The REAL classifier, the REAL orchestrator and the REAL executor against an
 * in-memory database (no network, no provider). Pins the owner's table:
 *   ownership question + 👍  -> engagement, likely yes, ONE confirmation
 *                               question from sms_templates (template_id
 *                               stamped), ownership NOT confirmed, no advance
 *   "Yes 👍"                 -> explicit, no repeat question
 *   🖕                        -> hostile: no reply, no DNC
 *   "Stop texting me 👍"     -> opt-out, suppression, no automation
 *   a language with no row   -> Needs Review, never free text
 * plus reaction parsing, target linking and one-logical-event dedupe, and the
 * typed platform events.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import {
  interpretEmojiReply,
  parsePlatformReaction,
  linkReactionTarget,
  collapseReactionDuplicates,
  reactionLogicalEventKey,
  extractEmojis,
} from "@/lib/domain/classification/emoji-interpretation.js";
import { resolveSafeFallbackClarifierDispatch } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { inboundReplyKind } from "@/lib/domain/platform/events/adapters/messages.js";

const ALL_GROUPS = ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "multifamily_5_plus"];
const TIE = "2026-09-25T07:02:27.703827+00:00";
const tpl = (template_id, use_case, stage_code, template_body, language = "English", is_active = true) => ({
  template_id,
  id: `uuid-${template_id}`,
  use_case,
  stage_code,
  stage_label: null,
  template_name: null,
  language,
  reply_mode: "auto",
  property_type_scope: "Any Residential",
  allowed_property_groups: ALL_GROUPS,
  prohibited_property_groups: null,
  usage_count: 0,
  success_rate: null,
  updated_at: TIE,
  is_active,
  safe_for_auto_reply: true,
  template_body,
});

// The rows of apps/api/scripts/repairs/20261001_emoji_clarification_templates.sql
// (as they will be once activated).
const CONFIRM_OWNER_EN = tpl("lc-emoji-confirm-ownership-en-1", "emoji_confirm_ownership", "S1", "Thanks for the response. Just to confirm, you're the owner, correct?");
const CONFIRM_OFFER_EN = tpl("lc-emoji-confirm-offer-interest-en-1", "emoji_confirm_offer_interest", "S2", "Thanks. Just to confirm, you'd be open to hearing an offer?");
const CONFIRM_NO_EN = tpl("lc-emoji-confirm-not-interested-en-1", "emoji_confirm_not_interested", "S2", "No problem. Just to confirm, you're not interested in an offer right now?");
const CONSIDER_SELLING = tpl("400065", "consider_selling", "S2", "Thanks for confirming. Would you consider a proposal for the property?");
const WHO_IS_THIS = tpl("1009", "who_is_this", "SP", "I'm a local investor here in the area. I reached out about your property. Would you be open to a proposal on it?");
const CATALOG = [CONFIRM_OWNER_EN, CONFIRM_OFFER_EN, CONFIRM_NO_EN, CONSIDER_SELLING, WHO_IS_THIS];

const PROD_SYSTEM_CONTROL = Object.freeze({
  auto_reply_mode: "live_limited",
  auto_reply_eligibility_cutoff_at: "2026-09-09T23:08:01.626Z",
  auto_reply_thread_allowlist: "",
  campaign_mode: "live_limited",
  queue_emergency_stop_at: "",
});

function memoryDb(seed = {}) {
  const tables = Object.fromEntries(Object.entries(seed).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
  const writes = [];
  let seq = 0;
  const rowsOf = (t) => (tables[t] ||= []);
  const query = (table, mode, payload = null) => {
    const filters = [];
    let limit = null;
    let single = false;
    const b = {
      select: () => b,
      eq: (c, v) => (filters.push((r) => r[c] === v), b),
      neq: (c, v) => (filters.push((r) => r[c] !== v), b),
      in: (c, vs) => (filters.push((r) => (vs || []).includes(r[c])), b),
      is: (c, v) => (filters.push((r) => (v === null ? r[c] == null : r[c] === v)), b),
      not: (c, op, v) => (op === "is" && v === null && filters.push((r) => r[c] != null), b),
      lt: (c, v) => (filters.push((r) => r[c] != null && String(r[c]) < String(v)), b),
      lte: (c, v) => (filters.push((r) => r[c] != null && String(r[c]) <= String(v)), b),
      gt: (c, v) => (filters.push((r) => r[c] != null && String(r[c]) > String(v)), b),
      gte: (c, v) => (filters.push((r) => r[c] != null && String(r[c]) >= String(v)), b),
      or: () => b, ilike: () => b, like: () => b, contains: () => b, filter: () => b, match: () => b, range: () => b,
      order: () => b,
      limit: (n) => ((limit = n), b),
      maybeSingle: () => ((single = true), b),
      single: () => ((single = true), b),
      then(resolve, reject) {
        let out;
        if (mode === "select") {
          let rows = rowsOf(table).filter((r) => filters.every((f) => f(r)));
          if (limit != null) rows = rows.slice(0, limit);
          out = { data: single ? rows[0] ?? null : rows, error: null };
        } else {
          const saved = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: `mem-${table}-${++seq}`, ...r }));
          writes.push({ table, mode, rows: saved });
          if (mode === "insert" || mode === "upsert") rowsOf(table).push(...saved);
          out = { data: single ? saved[0] ?? null : saved, error: null };
        }
        return Promise.resolve(out).then(resolve, reject);
      },
    };
    return b;
  };
  return {
    writes,
    client: {
      from: (table) => ({
        select: () => query(table, "select"),
        insert: (p) => query(table, "insert", p),
        upsert: (p) => query(table, "upsert", p),
        update: (p) => query(table, "update", p),
        delete: () => query(table, "delete", {}),
      }),
      rpc: async () => ({ data: null, error: null }),
    },
  };
}

async function runInbound({ message, thread = "+16125550123", priorBody, deliveredAt = "2026-09-30T14:28:07.300Z", receivedAt = "2026-09-30T14:31:58.734Z", catalog = CATALOG, seed = {}, stage = "ownership_check", summary = {} }) {
  const db = memoryDb({
    sms_templates: catalog,
    send_queue: [
      { id: "prior-1", to_phone_number: thread, thread_key: thread, message_type: null, message_body: priorBody, provider_message_id: "SM-prior", sent_at: deliveredAt, delivered_at: deliveredAt, queue_status: "delivered", type: "campaign", created_at: deliveredAt },
    ],
    ...seed,
  });
  const ownerId = "mo-emoji-1";
  __setSellerInboundOrchestratorDeps({
    getSupabaseClient: () => db.client,
    getDealContextByThread: async () => null,
    probeDealContextAmbiguity: async () => ({ ambiguous: false }),
    runContactResolutionPhase: async () => ({ ran: false, sends: 0 }),
    cancelPendingFollowUpsForThread: async () => ({ ok: true, cancelled: 0 }),
    cancelPendingSellerEmails: async () => ({ ok: true, cancelled: 0 }),
    patchUniversalLeadState: async () => ({ ok: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    executeReferralAutomation: async () => ({ ok: true }),
    scoreProperty: async () => ({ ok: false, error: "no_ade_offline" }),
    scheduleFollowUp: async () => ({ ok: true, followup_created: true }),
    info: () => {},
    warn: () => {},
  });
  try {
    const { buildConversationContext } = await import("@/lib/domain/classification/build-conversation-context.js");
    const conversation_context = await buildConversationContext({
      thread_key: thread,
      inbound_received_at: receivedAt,
      supabase: db.client,
      canonical_stage: stage,
    });
    const classification = await classify(message, null, { heuristicOnly: true, conversation_context });
    const out = await processSellerInboundMessage({
      message,
      threadKey: thread,
      inboundFrom: thread,
      inboundTo: "+16125550100",
      propertyId: "prop-emoji-1",
      ownerId,
      prospectId: "pros-emoji-1",
      phoneId: "phone-emoji-1",
      classification,
      context: {
        found: true,
        ids: { property_id: "prop-emoji-1", master_owner_id: ownerId, prospect_id: "pros-emoji-1", phone_item_id: "phone-emoji-1" },
        summary: { conversation_stage: stage, seller_stage: stage, property_address: "123 Main St", seller_first_name: "Pat", ...summary },
      },
      route: { stage, use_case: stage },
      inboundEventId: `evt-${thread}-${message.length}`,
      inboundReceivedAt: receivedAt,
      stageBefore: stage,
      autoReplyMode: "live_limited",
      dryRun: false,
      proofRun: false,
      skipNotifications: true,
      supabaseClient: db.client,
      getSystemValue: async (key) => PROD_SYSTEM_CONTROL[key] ?? null,
    });
    const inserts = db.writes.filter((w) => w.table === "send_queue" && w.mode === "insert").flatMap((w) => w.rows);
    const suppressionWrites = db.writes.filter((w) => w.table === "sms_suppression_list");
    return { out, inserts, classification, suppressionWrites };
  } finally {
    __resetSellerInboundOrchestratorDeps();
  }
}

const OWNERSHIP_Q = "Hi Pat, this is Sam. Are you still the owner of 123 Main St?";

// OWNER RULE 2026-10-06 (round 6) replaces the 7.2 confirmation question for
// a TYPED 👍 / ✅ to our ownership or sale question: it answers THAT question
// and gets exactly the reply the affirmative gets. Tapbacks, 👎, laughter and
// every price / offer / contract stage keep the 7.2 rules below.
test("ownership question + 👍: answered like 'Yes' -- ownership_confirmed and the S2 reply (owner rule 2026-10-06)", async () => {
  const { out, inserts, classification } = await runInbound({ message: "👍", priorBody: OWNERSHIP_Q });
  const yes = await runInbound({ message: "Yes", priorBody: OWNERSHIP_Q });
  assert.equal(classification.primary_intent, "ownership_confirmed");
  assert.equal(classification.primary_intent, yes.classification.primary_intent);
  assert.notEqual(classification.automation_decision.reply_kind, "clarification");
  assert.equal(inserts.some((r) => String(r.use_case_template).startsWith("emoji_confirm")), false);
  // Round 10 (owner 2026-10-08): "Yes" is English evidence and gets the S2
  // reply; a 👍 alone carries no seller language evidence -> language HOLD.
  assert.ok(yes.inserts.length >= 1, "the typed Yes still gets the S2 reply");
  assert.equal(inserts.length, 0, "no language evidence: no send");
  assert.equal(out.execution.queued, false);
});

test("✅ behaves like 👍 after an ownership question", async () => {
  const { inserts, classification } = await runInbound({ message: "✅", priorBody: OWNERSHIP_Q });
  assert.equal(classification.primary_intent, "ownership_confirmed");
  assert.equal(inserts.some((r) => String(r.use_case_template).startsWith("emoji_confirm")), false);
});

test("the stage moves on a 👍 exactly as it does on 'Yes'", async () => {
  const stageOf = (out) => out.decision?.stage_after ?? out.transition?.stage_after ?? out.intelligence_snapshot?.universal_stage ?? null;
  const thumbs = await runInbound({ message: "👍", priorBody: OWNERSHIP_Q });
  const yes = await runInbound({ message: "Yes", priorBody: OWNERSHIP_Q });
  assert.equal(stageOf(thumbs.out), stageOf(yes.out));
});

test("'Yes 👍' is explicit: no confirmation question is asked", async () => {
  const { inserts, classification } = await runInbound({ message: "Yes 👍", priorBody: OWNERSHIP_Q });
  assert.equal(classification.primary_intent, "ownership_confirmed");
  assert.notEqual(classification.automation_decision.reply_kind, "clarification");
  assert.equal(inserts.some((r) => String(r.use_case_template).startsWith("emoji_confirm")), false);
});

test("a language with no confirmation row fails closed to review: never free text, never English to a Spanish thread", async () => {
  const spanishPrior = "Hola Pat, soy Sam. Todavia eres el dueno de 123 Main St?";
  const { inserts, out } = await runInbound({
    message: "👍",
    priorBody: spanishPrior,
    summary: { language: "Spanish", language_preference: "Spanish" },
  });
  assert.equal(inserts.length, 0, "no English clarifier to a Spanish thread, no generated text");
  assert.equal(out.execution.queued, false);
});

test("inactive emoji-confirmation rows do not matter for a typed 👍 to the ownership question", async () => {
  const inactive = CATALOG.map((r) => (String(r.use_case).startsWith("emoji_confirm") ? { ...r, is_active: false } : r));
  const { inserts, classification } = await runInbound({ message: "👍", priorBody: OWNERSHIP_Q, catalog: inactive });
  assert.equal(classification.primary_intent, "ownership_confirmed");
  // Round 10: never an emoji-confirmation row; with no seller language evidence it holds.
  assert.equal(inserts.some((r) => String(r.use_case_template).startsWith("emoji_confirm")), false);
  assert.equal(inserts.length, 0);
});

test("🖕 is hostile: no reply and no DNC write", async () => {
  const { inserts, classification, suppressionWrites } = await runInbound({ message: "🖕", priorBody: OWNERSHIP_Q });
  assert.equal(classification.primary_intent, "hostile_or_legal");
  assert.equal(classification.automation_decision.suppression_action, "none");
  assert.equal(inserts.length, 0);
  assert.equal(suppressionWrites.length, 0, "hostility is never a global DNC");
});

test("'Stop texting me 👍' is an opt-out: suppression, no automation", async () => {
  const { inserts, classification, out } = await runInbound({ message: "Stop texting me 👍", priorBody: OWNERSHIP_Q });
  assert.equal(classification.primary_intent, "opt_out");
  assert.equal(inserts.length, 0);
  assert.equal(out.execution.automation_decision.should_suppress_contact, true);
  assert.equal(out.execution.automation_decision.suppression_reason, "opt_out");
});

test("👎 to an offer question: likely negative, confirm with the not-interested question, never an opt-out", async () => {
  const offerQ = "Would you be open to a proposal on the property?";
  const { inserts, classification } = await runInbound({ message: "👎", priorBody: offerQ, stage: "offer_interest" });
  assert.equal(classification.primary_intent, "unclear");
  assert.equal(classification.emoji_interpretation.semantic_signal, "likely_negative");
  assert.notEqual(classification.compliance_flag, "stop_texting");
  // Round 10: the confirmation question needs seller language evidence; none -> HOLD.
  assert.equal(inserts.length, 0);
});

test("😂 after 'Would you take $175,000?' is non-literal: no acceptance, no price fact", async () => {
  const ctx = {
    context_version: "conversation_context_v1",
    canonical_thread: "+16125550123",
    inbound_thread: "+16125550123",
    canonical_stage: "offer",
    last_outbound_message_id: "o1",
    last_outbound_use_case: "asking_price",
    last_outbound_delivered_at: "2026-10-01T15:00:00Z",
    current_inbound_received_at: "2026-10-01T15:01:00Z",
    intervening_outbound_count: 0,
    unanswered_question: true,
  };
  const c = await classify("😂", null, { heuristicOnly: true, conversation_context: ctx });
  assert.equal(c.emoji_interpretation.semantic_signal, "amusement");
  assert.equal(c.factual_commitment, "NON_LITERAL");
  assert.notEqual(c.primary_intent, "asking_price_provided");
  assert.notEqual(c.automation_decision.reply_kind, "clarification");
});

test("the clarifier gate refuses an emoji clarification the classifier did not authorize", () => {
  const decision = { should_queue_reply: false, should_mark_human_review: true, human_review_reason: "unclear_low_confidence" };
  const authorized = resolveSafeFallbackClarifierDispatch({
    decision,
    classification: {
      primary_intent: "unclear",
      emoji_interpretation: { answers: { stage_bucket: "S1" }, clarification: { strategy: "confirm_ownership" } },
      automation_decision: { auto_reply_allowed: true, human_review_required: false, suppression_action: "none", reply_kind: "clarification", clarification_use_case: "emoji_confirm_ownership" },
    },
    message: "👍",
    stage: "ownership_confirmation",
  });
  assert.equal(authorized.template_use_case, "emoji_confirm_ownership");
  assert.equal(authorized.suggested_text, null, "the copy comes from sms_templates, never code");
  const pureEmojiWithoutAuthority = resolveSafeFallbackClarifierDispatch({
    decision,
    classification: { primary_intent: "unclear", automation_decision: { auto_reply_allowed: true, human_review_required: false, suppression_action: "none" } },
    message: "👍",
    stage: "ownership_confirmation",
  });
  assert.equal(pureEmojiWithoutAuthority, null);
});

// ── Reactions: parse, link to the target, one logical event ─────────────────

test("TextGrid delivers tapbacks as text: both observed formats parse, quoted text is OUR message", () => {
  const android = "​👍​ to “ Hello Pat, this is Sam. Are you still the owner of 123 Main St? ”";
  const ios = "Questioned “Hello Pat, this is Sam. Do you still own 123 Main St?”";
  const a = parsePlatformReaction(android);
  assert.equal(a.emoji, "👍");
  assert.match(a.target_text, /Are you still the owner/);
  const i = parsePlatformReaction(ios);
  assert.equal(i.verb, "questioned");
  assert.equal(i.family, "confusion");
  assert.equal(parsePlatformReaction("I liked your offer"), null);
});

test("a reaction is read against its TARGET: a question stays open, an acknowledgement closes the turn", () => {
  const onQuestion = interpretEmojiReply("Liked “Are you still the owner of 123 Main St?”");
  assert.equal(onQuestion.semantic_signal, "likely_affirmative");
  assert.equal(onQuestion.clarification.template_use_case, "emoji_confirm_ownership");
  const onAck = interpretEmojiReply("Liked “Sounds good, I'll follow up next month.”");
  assert.equal(onAck.semantic_signal, "acknowledgement");
  assert.equal(onAck.requires_clarification, false);
  assert.equal(onAck.engagement_signal, false);
});

test("the reaction is linked to the outbound it quotes", () => {
  const events = [
    { id: "o1", direction: "outbound", message_body: "Hello Pat, this is Sam. Are you still the owner of 123 Main St?", created_at: "2026-10-01T10:00:00Z" },
    { id: "o2", direction: "outbound", message_body: "Just checking back.", created_at: "2026-10-01T11:00:00Z" },
  ];
  const link = linkReactionTarget("​👍​ to “ Hello Pat, this is Sam. Are you still the owner of 123 Main St? ”", events, { before: "2026-10-01T12:00:00Z" });
  assert.equal(link.message_event_id, "o1");
});

test("a reaction delivered twice (provider metadata + its synthetic text, or a replay) is ONE logical event", () => {
  const body = "​👍​ to “ Hello Pat, this is Sam. Are you still the owner of 123 Main St? ”";
  const rows = [
    { id: "r1", thread_key: "+1", message_body: body, received_at: "2026-10-01T12:00:05Z" },
    { id: "r2", thread_key: "+1", message_body: body.replace(/​/g, ""), received_at: "2026-10-01T12:00:41Z" },
    { id: "r3", thread_key: "+1", message_body: "Yes", received_at: "2026-10-01T12:01:00Z" },
  ];
  const kept = collapseReactionDuplicates(rows);
  assert.deepEqual(kept.map((r) => r.id), ["r1", "r3"]);
  assert.equal(
    reactionLogicalEventKey({ thread_key: "+1", message: rows[0].message_body, received_at: rows[0].received_at }),
    reactionLogicalEventKey({ thread_key: "+1", message: rows[1].message_body, received_at: rows[1].received_at })
  );
});

test("multiple emoji combine conservatively: never just the first one", () => {
  assert.equal(interpretEmojiReply("👍🖕").family, "hostile");
  assert.equal(interpretEmojiReply("👍👎", { last_outbound_use_case: "ownership_check" }).requires_clarification, false);
  assert.equal(interpretEmojiReply("👍😂", { last_outbound_use_case: "proposal_interest" }).family, "laughter");
  assert.deepEqual(extractEmojis("👍🏽✅"), ["👍", "✅"]);
});

// ── Platform events: typed, still one event per inbound ─────────────────────

test("inbound events are typed by what the reply was (operator-level, one per row)", () => {
  assert.equal(inboundReplyKind({ message_body: "​👍​ to “ Are you the owner? ”" }).type, "seller.reaction");
  assert.equal(inboundReplyKind({ message_body: "👍" }).type, "seller.emoji_reply");
  assert.equal(inboundReplyKind({ message_body: "Not James", detected_intent: "wrong_number" }).type, "seller.wrong_person");
  assert.equal(inboundReplyKind({ message_body: "get a real job", detected_intent: "hostile_or_legal" }).type, "seller.hostile");
  assert.equal(inboundReplyKind({ message_body: "call me", detected_intent: "callback_requested" }).type, "seller.call_request");
  assert.equal(inboundReplyKind({ message_body: "English", detected_intent: "language_switch" }).type, "seller.language_request");
  assert.equal(inboundReplyKind({ message_body: "What's your offer?", detected_intent: "asks_offer" }).type, "seller.replied");
});
