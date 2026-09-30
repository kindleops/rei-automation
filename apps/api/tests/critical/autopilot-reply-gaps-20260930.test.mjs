/**
 * 2026-09-30 autopilot audit: why real seller replies got no automatic answer.
 *
 * Every message below is verbatim production traffic. Three defects are
 * pinned, each proven against the REAL classifier, the REAL intelligence phase
 * and the REAL executor with an in-memory database — no network, no provider:
 *
 *   1. Purpose / identity questions ("What can I do for you?", "Which company
 *      r u with") fell to unclear@0.60; the classifier's own
 *      human_review_required verdict then forbade even the safe clarifier.
 *   2. Language keyword collisions: "ok" was Italian/German evidence and "sale"
 *      Spanish evidence, so "Ok I am ready to sell." resolved Italian and the
 *      template layer failed closed (language_template_missing).
 *   3. A decline ("Yes and I'm not interested in selling it") had
 *      consider_selling -- "Would you consider a proposal for the property?" --
 *      selected for it, because the S1 overlay's lifecycle stages were unioned
 *      into the reply candidates and catalog ties break on row order.
 *
 * The classifier fixes authorize nothing on their own: the pipeline tests at
 * the bottom show the same question is still withheld by suppression, the
 * auto-reply mode, the live_limited cutoff and template/property compatibility.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import {
  applyInboundAutomationDecision,
  selectSafeAutoReplyTemplate,
  isPureDeclineTurn,
  DECLINE_SAFE_REPLY_USE_CASES,
} from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const ALL_GROUPS = ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "multifamily_5_plus"];
const TIE = "2026-09-25T07:02:27.703827+00:00";
const tpl = (template_id, use_case, stage_code, reply_mode, property_type_scope, template_body, language = "English") => ({
  template_id,
  id: `uuid-${template_id}`,
  use_case,
  stage_code,
  stage_label: null,
  template_name: `${use_case}_${stage_code}_${language}_${template_id}`,
  language,
  reply_mode,
  property_type_scope,
  allowed_property_groups: property_type_scope ? ALL_GROUPS : null,
  prohibited_property_groups: null,
  usage_count: 0,
  success_rate: null,
  updated_at: TIE,
  is_active: true,
  safe_for_auto_reply: true,
  template_body,
});

// Production catalog rows (2026-09-30), interest probes FIRST -- the order
// that made consider_selling win every tie.
const CONSIDER_SELLING = tpl("400065", "consider_selling", "S2", "auto_reply", "Any Residential", "Thanks for confirming. Would you consider a proposal for the property?");
const CS_FOLLOW_UP_A = tpl("521101", "consider_selling_follow_up", "S2F", "auto", "Follow-Up", "{{seller_first_name}}, circling back on {{property_address}}. If the numbers made sense, would you look at a proposal?");
const CS_FOLLOW_UP_B = tpl("521105", "consider_selling_follow_up", "S2F", "auto", "Follow-Up", "{{seller_first_name}}, just checking back on {{property_address}}. Would you be open to a proposal?");
const NOT_INTERESTED = tpl("1040", "not_interested", "SP", "auto_reply", "Residential", "Understood, I'll leave it alone. If that ever changes, want me to check back down the road?");
const FUTURE_NURTURE = tpl("lc-future-nurture-en-1", "future_nurture", "S2F", "auto", "Any Residential", "No problem at all. Is it alright if I check back down the road?");
const WHO_IS_THIS = tpl("1009", "who_is_this", "SP", "auto_reply", "Residential", "I'm a local investor here in the area. I reached out about your property. Would you be open to a proposal on it?");
const SELLER_ASKING_PRICE = { ...tpl("occ_seller_asking_price_en_v1", "seller_asking_price", "S3", "auto_reply", null, "Got it. What price would you have in mind for the property?"), updated_at: "2026-07-17T08:57:54.218+00:00" };
const PRICE_PROBE = tpl("550002", "price_high_condition_probe", "S4B", "auto_reply", "Residential", "Got it. Is the property updated, or does it need work?");
const SELLER_ASKING_PRICE_ES = { ...tpl("occ_seller_asking_price_es_v1", "seller_asking_price", "S3", "auto_reply", null, "Entendido. ¿Qué precio tendría en mente para la propiedad?", "Spanish") };

const CATALOG = [
  CONSIDER_SELLING, CS_FOLLOW_UP_A, CS_FOLLOW_UP_B, WHO_IS_THIS, SELLER_ASKING_PRICE,
  PRICE_PROBE, NOT_INTERESTED, FUTURE_NURTURE, SELLER_ASKING_PRICE_ES,
];

const PROD_SYSTEM_CONTROL = Object.freeze({
  auto_reply_mode: "live_limited",
  auto_reply_eligibility_cutoff_at: "2026-09-09T23:08:01.626Z",
  auto_reply_thread_allowlist: "",
  campaign_mode: "live_limited",
  queue_emergency_stop_at: "",
});

/** In-memory PostgREST-shaped client. Filters rows, records every write. */
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

/** conversation_context_v1 exactly as buildConversationContext emits it for a delivered S1 question. */
function ownershipContext(thread, deliveredAt, receivedAt) {
  return {
    context_version: "conversation_context_v1",
    canonical_thread: thread,
    inbound_thread: thread,
    canonical_stage: "ownership_check",
    last_outbound_message_id: "SM-prior",
    last_outbound_use_case: "ownership_check",
    last_outbound_question_type: "ownership",
    last_outbound_delivered_at: deliveredAt,
    current_inbound_received_at: receivedAt,
    intervening_outbound_count: 0,
    intervening_inbound_count: 0,
    question_status: "unanswered",
    unanswered_question: true,
  };
}

// ── 1. Purpose / identity questions ─────────────────────────────────────────

const PRODUCTION_PURPOSE_QUESTIONS = [
  "What can I do for you?", // +12143662400, 2026-09-30
  "Which company r u with", // +16125886543, 2026-09-28
  "Alex from where", // +16124233864, 2026-09-28
  "You have been investing in what?", // +16122756497, 2026-09-30
  "You have been doing what 3635 Emerson ave n?", // +16122756497, 2026-09-30
];

const PURPOSE_QUESTION_VARIANTS = [
  "How can I help you?",
  "Yes, what can I do for you?",
  "Which company are you with?",
  "What company are you with?",
  "What company do you work for?",
  "Where are you from?",
  "From where?",
  "Investing in what?",
  "You're doing what?",
  "Regarding what?",
  "What's it about?",
  "What do you want?",
  "What do you want from me?",
];

test("production purpose/identity questions classify who_is_this and clear the classifier's own autonomy gate", async () => {
  for (const text of [...PRODUCTION_PURPOSE_QUESTIONS, ...PURPOSE_QUESTION_VARIANTS]) {
    const c = await classify(text, null, { heuristicOnly: true });
    assert.equal(c.primary_intent, "who_is_this", text);
    assert.ok(c.confidence >= 0.82, `${text} confidence ${c.confidence}`);
    assert.equal(c.automation_decision.auto_reply_allowed, true, text);
    assert.equal(c.automation_decision.human_review_required, false, text);
    assert.equal(c.automation_decision.suppression_action, "none", text);
  }
});

test("the identity questions named in the audit brief were already who_is_this and stay pinned", async () => {
  for (const text of ["Who is this?", "What's this about?", "Who are you with", "What company is this?"]) {
    const c = await classify(text, null, { heuristicOnly: true });
    assert.equal(c.primary_intent, "who_is_this", text);
    assert.equal(c.automation_decision.auto_reply_allowed, true, text);
  }
});

test("purpose-question coverage never swallows a second clause, profanity, an offer ask or a compliance signal", async () => {
  const cases = [
    ["What do you want from me generally", (i) => i !== "who_is_this"], // frozen calibration negative (ic3_en_prop_a04)
    ["What do you want for it?", (i) => i !== "who_is_this"],
    ["What the fuck do you want?", (i) => i === "hostile_or_legal"],
    ["Which company bought it?", (i) => i !== "who_is_this"],
    ["Doing what I can", (i) => i !== "who_is_this"],
    ["Who is Derik?", (i) => i !== "who_is_this"], // wrong-person signal, not an identity question
    ["What can I do for you? Not selling though", (i) => i === "not_interested"],
    ["Not interested. What company are you with?", (i) => i === "not_interested"],
    ["Stop texting me, what company is this?", (i) => i === "opt_out"],
    ["Where are you from? Stop texting me", (i) => i === "opt_out"],
    ["Wrong number, who is this?", (i) => i === "wrong_number"],
  ];
  for (const [text, ok] of cases) {
    const c = await classify(text, null, { heuristicOnly: true });
    assert.ok(ok(c.primary_intent), `${text} -> ${c.primary_intent}`);
  }
});

test("'I am' and 'I am and I am selling it now' bind to a validated ownership question, and stay unclear without one", async () => {
  const thread = "+16124020705";
  const ctx = ownershipContext(thread, "2026-09-28T15:58:00.000Z", "2026-09-28T16:01:20.402Z");
  for (const text of ["I am", "I am and I am selling it now", "Yes is what's up?"]) {
    const bound = await classify(text, null, { heuristicOnly: true, conversation_context: ctx });
    assert.equal(bound.primary_intent, "ownership_confirmed", text);
    assert.equal(bound.automation_decision.auto_reply_allowed, true, text);

    const unbound = await classify(text, null, { heuristicOnly: true });
    assert.equal(unbound.primary_intent, "unclear", `${text} without context must not assert ownership`);
    assert.equal(unbound.automation_decision.auto_reply_allowed, false, text);
  }
});

// ── 2. Language keyword collisions ──────────────────────────────────────────

test("'ok' and 'sale' are not foreign-language evidence; real Italian/Spanish/German still is", async () => {
  const english = ["Ok I am ready to sell.", "Ok what is your offer?", "ok", "Not for sale", "Yes it's for sale", "Not for sale at no price"];
  for (const text of english) {
    const c = await classify(text, null, { heuristicOnly: true });
    assert.equal(c.language, "English", text);
  }
  const foreign = [
    ["Ok, grazie", "Italian"],
    ["No está en venta", "Spanish"],
    ["Sale pues, gracias", "Spanish"],
    ["Danke, ok", "German"],
  ];
  for (const [text, language] of foreign) {
    const c = await classify(text, null, { heuristicOnly: true });
    assert.equal(c.language, language, text);
  }
});

test("an English 'for sale' reply is answered from the English template, never the Spanish one", async () => {
  const classification = await classify("Ok what is your offer? Is it still for sale?", null, { heuristicOnly: true });
  assert.equal(classification.language, "English");
  const db = memoryDb({ sms_templates: [SELLER_ASKING_PRICE_ES, SELLER_ASKING_PRICE] });
  const result = await selectSafeAutoReplyTemplate({
    supabaseClient: db.client,
    classification,
    decision: { route_hint: "seller_asking_price", allowed_template_stages: ["seller_asking_price"] },
    context: { summary: {} }, // no established thread language, as in production
  });
  assert.equal(result.ok, true);
  assert.equal(result.template.language, "English");
});

// ── 3. A decline never gets an interest probe ───────────────────────────────

const INTEREST_PROBES = new Set(["consider_selling", "consider_selling_follow_up"]);

function s1Decision(message, classification) {
  return applyInboundAutomationDecision({
    message,
    threadKey: "+14697324317",
    propertyId: "2128256486",
    ownerId: "mo_26ddd31bc8ecbf06796a5472",
    classification,
    latestThreadContext: { summary: { conversation_stage: "ownership_check" } },
  });
}

test("the production decline turn selects a decline-safe template in every catalog order", async () => {
  const message = "Yes and I'm not interested in selling it"; // +14697324317, 2026-09-30
  const classification = await classify(message, null, { heuristicOnly: true });
  assert.equal(classification.primary_intent, "not_interested");
  const decision = s1Decision(message, classification);
  // The S1 overlay still owns the lifecycle: advance to S2, nurture, no reply.
  assert.equal(decision.audit_reason, "s1_not_for_sale_advance_with_followup");
  assert.equal(decision.should_queue_reply, false);
  assert.equal(decision.route_hint, "consider_selling");
  assert.equal(isPureDeclineTurn({ classification, decision }), true);

  const orders = [CATALOG, [...CATALOG].reverse(), [CS_FOLLOW_UP_B, CONSIDER_SELLING, FUTURE_NURTURE, NOT_INTERESTED]];
  for (const rows of orders) {
    const result = await selectSafeAutoReplyTemplate({
      supabaseClient: memoryDb({ sms_templates: rows }).client,
      classification,
      decision,
      context: { summary: { language_preference: "English" } },
    });
    assert.equal(result.ok, true);
    assert.ok(DECLINE_SAFE_REPLY_USE_CASES.includes(result.template.use_case), result.template.use_case);
    assert.equal(INTEREST_PROBES.has(result.template.use_case), false);
  }
});

test("a decline with only interest-probe templates in the catalog never asks 'would you consider' -- local nurture or nothing", async () => {
  const message = "Not for sale";
  const classification = await classify(message, null, { heuristicOnly: true });
  const decision = s1Decision(message, classification);
  const probesOnly = () => memoryDb({ sms_templates: [CONSIDER_SELLING, CS_FOLLOW_UP_A, CS_FOLLOW_UP_B] }).client;
  const context = { summary: { language_preference: "English" } };

  // The approved, hash-pinned local future_nurture may answer; a probe may not.
  const fallback = await selectSafeAutoReplyTemplate({ supabaseClient: probesOnly(), classification, decision, context });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.template.source, "local_registry");
  assert.equal(fallback.template.use_case, "future_nurture");

  // With the local fallback revoked there is nothing decline-safe: fail closed.
  const previous = process.env.LOCAL_TEMPLATE_FALLBACK_DISABLED;
  process.env.LOCAL_TEMPLATE_FALLBACK_DISABLED = "true";
  try {
    const result = await selectSafeAutoReplyTemplate({ supabaseClient: probesOnly(), classification, decision, context });
    assert.equal(result.ok, false);
    assert.equal(result.template, null);
  } finally {
    if (previous === undefined) delete process.env.LOCAL_TEMPLATE_FALLBACK_DISABLED;
    else process.env.LOCAL_TEMPLATE_FALLBACK_DISABLED = previous;
  }

  const required = await selectSafeAutoReplyTemplate({
    supabaseClient: memoryDb({ sms_templates: CATALOG }).client,
    classification,
    decision: { ...decision, required_template_use_case: "consider_selling_follow_up" },
    context: { summary: { language_preference: "English" } },
  });
  assert.equal(required.ok, false);
  assert.equal(required.reason, "decline_turn_no_decline_safe_route");
});

test("the decline rule narrows only pure declines: compound offer asks, negotiation turns and positive intents keep their routes", async () => {
  const declined = await classify("Not for sale", null, { heuristicOnly: true });
  assert.equal(
    isPureDeclineTurn({ classification: declined, decision: { audit_reason: "declined_but_asks_offer", route_hint: "ask_seller_price_or_basic_condition" } }),
    false
  );
  assert.equal(
    isPureDeclineTurn({ classification: declined, decision: { negotiation_strategy: "expectation_reset", send_authority: "negotiation_strategy_directive" } }),
    false
  );

  const owner = await classify("Yes I own it", null, { heuristicOnly: true });
  const ownerDecision = { route_hint: "consider_selling", allowed_template_stages: ["consider_selling", "stage_2_consider_selling"] };
  assert.equal(isPureDeclineTurn({ classification: owner, decision: ownerDecision }), false);
  const selected = await selectSafeAutoReplyTemplate({
    supabaseClient: memoryDb({ sms_templates: CATALOG }).client,
    classification: owner,
    decision: ownerDecision,
    context: { summary: { language_preference: "English" } },
  });
  assert.equal(selected.template.use_case, "consider_selling", "an owner confirmation still gets the S2 question");
});

// ── 4. The real pipeline, offline ───────────────────────────────────────────

async function runInbound({
  message,
  thread,
  deliveredAt,
  receivedAt,
  priorBody,
  autoReplyMode = "live_limited",
  seed = {},
  propertyType = null,
  ownerId = "mo-audit-1",
}) {
  const db = memoryDb({
    sms_templates: CATALOG,
    send_queue: [
      { id: "prior-1", to_phone_number: thread, thread_key: thread, message_type: null, message_body: priorBody, provider_message_id: "SM-prior", sent_at: deliveredAt, delivered_at: deliveredAt, queue_status: "delivered", type: "campaign", created_at: deliveredAt },
    ],
    ...seed,
  });
  const followups = [];
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
    scheduleFollowUp: async (intent) => {
      followups.push(intent);
      return { ok: true, followup_created: true, scheduled_for: "2026-10-30T00:00:00.000Z" };
    },
    info: () => {},
    warn: () => {},
  });
  try {
    const { buildConversationContext } = await import("@/lib/domain/classification/build-conversation-context.js");
    const conversation_context = await buildConversationContext({
      thread_key: thread,
      inbound_received_at: receivedAt,
      supabase: db.client,
      canonical_stage: "ownership_check",
    });
    const classification = await classify(message, null, { heuristicOnly: true, conversation_context });
    const out = await processSellerInboundMessage({
      message,
      threadKey: thread,
      inboundFrom: thread,
      inboundTo: "+16125550100",
      propertyId: "prop-audit-1",
      ownerId,
      prospectId: "pros-audit-1",
      phoneId: "phone-audit-1",
      classification,
      // Production live contexts carry neither a thread language nor (usually)
      // a property type -- mirrored here.
      context: {
        found: true,
        ids: { property_id: "prop-audit-1", master_owner_id: ownerId, prospect_id: "pros-audit-1", phone_item_id: "phone-audit-1" },
        summary: { conversation_stage: "ownership_check", seller_stage: "ownership_check", property_address: "1547 Summers Dr", seller_first_name: "Charles", ...(propertyType ? { property_type: propertyType } : {}) },
      },
      route: { stage: "ownership_check", use_case: "ownership_check" },
      inboundEventId: `evt-${thread}`,
      inboundReceivedAt: receivedAt,
      stageBefore: "ownership_check",
      autoReplyMode,
      dryRun: false,
      proofRun: false,
      skipNotifications: true,
      supabaseClient: db.client,
      getSystemValue: async (key) => PROD_SYSTEM_CONTROL[key] ?? null,
    });
    const inserts = db.writes
      .filter((w) => w.table === "send_queue" && w.mode === "insert")
      .flatMap((w) => w.rows);
    return { out, inserts, followups, classification };
  } finally {
    __resetSellerInboundOrchestratorDeps();
  }
}

const PURPOSE_TURN = {
  message: "What can I do for you?",
  thread: "+12143662400",
  priorBody: "Hi Messele, this is Alex. Quick question, do you still own the commercial property at 4327 Malcolm X Blvd?",
  deliveredAt: "2026-09-30T14:28:07.300Z",
  receivedAt: "2026-09-30T14:31:58.734Z",
};

test("'What can I do for you?' now queues the approved identity reply through every gate", async () => {
  const { out, inserts, classification } = await runInbound(PURPOSE_TURN);
  assert.equal(classification.primary_intent, "who_is_this");
  assert.equal(out.execution.queued, true);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].use_case_template, "who_is_this");
  assert.equal(inserts[0].message_body, WHO_IS_THIS.template_body);
});

test("the same question is still withheld by suppression, mode, the live_limited cutoff and property compatibility", async () => {
  const suppressed = await runInbound({
    ...PURPOSE_TURN,
    seed: { sms_suppression_list: [{ id: "sup-1", phone_e164: PURPOSE_TURN.thread, is_active: true, suppression_reason: "opt_out", suppression_type: "opt_out" }] },
  });
  assert.equal(suppressed.inserts.length, 0, "an active suppression row still blocks");
  assert.equal(suppressed.out.execution.queued, false);
  assert.equal(suppressed.out.execution.automation_decision.should_suppress_contact, true);
  assert.equal(suppressed.out.execution.automation_decision.suppression_reason, "opt_out");

  const disabled = await runInbound({ ...PURPOSE_TURN, autoReplyMode: "disabled" });
  assert.equal(disabled.inserts.length, 0, "auto_reply_mode=disabled still blocks");
  assert.equal(disabled.out.execution.execution_blocked_reason, "auto_reply_mode_disabled");

  const beforeCutoff = await runInbound({ ...PURPOSE_TURN, deliveredAt: "2026-09-01T14:28:07.300Z", receivedAt: "2026-09-01T14:31:58.734Z" });
  assert.equal(beforeCutoff.inserts.length, 0, "an inbound before the live_limited cutoff still blocks");
  assert.equal(beforeCutoff.out.queue_permission.reason, "auto_reply_inbound_before_cutoff");

  const commercial = await runInbound({ ...PURPOSE_TURN, propertyType: "Other" });
  assert.equal(commercial.inserts.length, 0, "a residential-only template is still refused for a commercial property");
  assert.equal(commercial.out.execution.audit_reason, "no_safe_template");
});

test("'Yes and I'm not interested in selling it' sends nothing, records a decline-safe template and keeps the nurture", async () => {
  const { out, inserts, followups } = await runInbound({
    message: "Yes and I'm not interested in selling it",
    thread: "+14697324317",
    priorBody: "Hi Charles, this is Alex. Is 1547 Summers Dr yours?",
    deliveredAt: "2026-09-30T14:33:07.398Z",
    receivedAt: "2026-09-30T14:34:24.142Z",
  });
  assert.equal(inserts.length, 0);
  assert.equal(out.execution.queued, false);
  assert.equal(out.execution.automation_decision.audit_reason, "s1_not_for_sale_advance_with_followup");
  assert.deepEqual(followups, ["not_interested"]);
  const recorded = out.intelligence_snapshot.selected_template?.use_case;
  assert.ok(DECLINE_SAFE_REPLY_USE_CASES.includes(recorded), `recorded ${recorded}`);
  assert.equal(INTEREST_PROBES.has(out.decision.template_key), false, `timeline template ${out.decision.template_key}`);
});

test("'Wrong number' still suppresses and sends nothing", async () => {
  const { out, inserts } = await runInbound({
    message: "Wrong number",
    thread: "+14695085384",
    priorBody: "Hey Charles & Louise Downey, hope all is well. This is Alex reaching out about 3526 York St. Is this the correct number for the owner?",
    deliveredAt: "2026-09-30T14:28:07.300Z",
    receivedAt: "2026-09-30T14:29:39.823Z",
    ownerId: null,
  });
  assert.equal(inserts.length, 0);
  assert.equal(out.execution.automation_decision.should_suppress_contact, true);
  assert.equal(out.execution.automation_decision.suppression_reason, "wrong_number");
});

test("'Ok I am ready to sell.' with no established thread language is answered in English", async () => {
  const { out, inserts, classification } = await runInbound({
    message: "Ok I am ready to sell.", // +16122756497, 2026-09-30: no_safe_template via language_template_missing
    thread: "+16122756497",
    priorBody: "I’m a real estate investor. Would you be open to a proposal on the property?",
    deliveredAt: "2026-09-30T14:51:20.509Z",
    receivedAt: "2026-09-30T14:58:01.099Z",
  });
  assert.equal(classification.language, "English");
  assert.equal(classification.primary_intent, "seller_interested");
  assert.equal(out.execution.queued, true);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].use_case_template, "seller_asking_price");
  assert.equal(inserts[0].message_body, SELLER_ASKING_PRICE.template_body);
  assert.equal(out.execution.selected_template.language, "English");
});
