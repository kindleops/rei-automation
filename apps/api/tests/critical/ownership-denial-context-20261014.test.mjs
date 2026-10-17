/**
 * RC 8.5.15 (owner spec "LEADCOMMAND 8.5.15 — AUTONOMOUS AI ACTIVATION"):
 * a bare "No" means what it answers. Reverses 8.5.13's
 * ctx_bare_no_after_ownership_check_not_interested default.
 *
 *  - S1 ownership question -> ownership denied / unverified: recorded at
 *    contact x property scope, no property outreach to this recipient for this
 *    property, NO nurture, no further ownership question, never qualified, and
 *    never a phone suppression (other properties stay contactable).
 *  - S2 "would you consider selling" -> disinterest, no automatic follow-up
 *    (S2_DECLINE_FOLLOWUP_POLICY; conflicts with the 2026-10-05 owner rule).
 *  - Condition question -> no repairs reported; the workflow continues.
 *  - "Can we check back?" -> outreach in that scope ends.
 *  - STOP / wrong number / opt-out unchanged.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { replayReply } from "../helpers/reply-replay-harness.mjs";
import { classify } from "@/lib/domain/classification/classify.js";
import {
  bareNoOwnershipMode,
  BARE_NO_OWNERSHIP_MODES,
  DEFAULT_BARE_NO_OWNERSHIP_MODE,
} from "@/lib/domain/classification/conversation-context.js";
import { deriveUseCaseFromBody } from "@/lib/domain/classification/build-conversation-context.js";
import {
  NO_FOLLOWUP_NEXT_ACTION,
  resolveDeclineFollowupPolicy,
  suppressesAutomaticFollowup,
} from "@/lib/domain/seller-flow/decline-followup-policy.js";
import { resolveOwnershipProbeDisinterestTransition } from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";
import { resolveFollowUpPlan } from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { resolveInboundRelationship } from "@/lib/domain/seller-flow/resolve-inbound-relationship.js";
import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";

const CATALOG = JSON.parse(readFileSync(new URL("../fixtures/reply-quality/2026-10-06-safe-templates-en-es.json", import.meta.url), "utf8")).rows;

const QUESTIONS = {
  s1_still_own: ["ownership_check", "Hey Pat, this is Carlos. Do you still own 1 Main St?"],
  s1_yours: ["ownership_check", "Hi Pat, Carlos here. Is 1 Main St yours?"],
  s1_es: ["ownership_check", "Hola Pat, soy Carlos. ¿Sigue siendo usted el dueño de 1 Main St?"],
  s2: ["consider_selling", "Would you consider an offer on 1 Main St if the number made sense?"],
  s4: ["ask_condition_clarifier", "Got it. What kind of shape is it in? Anything major it needs?"],
  // Real production check-back bodies (sms_templates future_nurture /
  // not_interested / not_ready, 2026-10-14). Their template use case names no
  // question; the body does.
  permission_future_nurture: ["future_nurture", "No problem at all. Is it alright if I check back down the road?"],
  permission_not_interested: ["not_interested", "Understood, I'll leave it alone. If that ever changes, want me to check back down the road?"],
  permission_not_ready: ["not_ready", "Totally understand, Pat, no rush at all. Want me to check back in a few months?"],
  permission_es: ["future_nurture", "No hay problema. ¿Esta bien si le escribo mas adelante?"],
};

async function replay(message, q) {
  const [use_case, text] = QUESTIONS[q];
  return replayReply(
    {
      fixture_id: "r20261014",
      received_at: "2026-10-14T18:00:00.000Z",
      seller_message: message,
      prior_question: { template_id: "t-r20261014", template_use_case: use_case, text, sent_at: "2026-10-14T17:00:00.000Z", delivered_at: "2026-10-14T17:00:05.000Z" },
      intervening_inbound: [],
      r7_history: [],
      valuation: null,
    },
    { catalog: CATALOG }
  );
}

function assertNoFollowupDecline(r, audit_reason) {
  const d = r.decision;
  assert.equal(d.next_action, NO_FOLLOWUP_NEXT_ACTION);
  assert.equal(d.audit_reason, audit_reason);
  assert.equal(d.should_suppress_contact, false, "never a phone suppression");
  assert.equal(d.suppression_reason ?? null, null);
  assert.equal(d.should_queue_reply, false, "no reply");
  assert.equal(d.should_mark_human_review, false, "deterministic, not a review item");
  assert.equal(d.follow_up_at ?? null, null, "no follow-up date");
  assert.equal(r.text, null);
  assert.equal(r.outcome, "no_reply_by_design");
}

test("the default bare-No ownership mode is ownership_unverified; 8.5.13's not_interested is an explicit mode only", () => {
  assert.equal(DEFAULT_BARE_NO_OWNERSHIP_MODE, "ownership_unverified");
  assert.ok(BARE_NO_OWNERSHIP_MODES.includes("not_interested"));
  const before = process.env.LC_BARE_NO_OWNERSHIP_MODE;
  try {
    delete process.env.LC_BARE_NO_OWNERSHIP_MODE;
    assert.equal(bareNoOwnershipMode(), "ownership_unverified");
    process.env.LC_BARE_NO_OWNERSHIP_MODE = "garbage";
    assert.equal(bareNoOwnershipMode(), "ownership_unverified");
  } finally {
    if (before === undefined) delete process.env.LC_BARE_NO_OWNERSHIP_MODE;
    else process.env.LC_BARE_NO_OWNERSHIP_MODE = before;
  }
});

// ── 1. S1: a bare "No" denies ownership ─────────────────────────────────────
const S1_DENIALS = [
  ["No", "s1_still_own", "ctx_bare_no_after_ownership_check_ownership_unverified"],
  ["NO", "s1_yours", "ctx_bare_no_after_ownership_check_ownership_unverified"],
  ["Nope", "s1_still_own", "ctx_bare_no_after_ownership_check_ownership_unverified"],
  ["No!!!!!", "s1_still_own", "ctx_bare_no_after_ownership_check_ownership_unverified"],
  ["Not really", "s1_still_own", "ctx_bare_no_after_ownership_check_ownership_unverified"],
  ["No", "s1_es", "ctx_bare_no_after_ownership_check_ownership_unverified"],
  ["No Carlos", "s1_still_own", "ctx_bare_no_after_ownership_check_ownership_unverified"],
  ["No I don't", "s1_still_own", "ctx_no_after_ownership_check_ownership_unverified"],
  ["No, I'm not", "s1_yours", "ctx_no_after_ownership_check_ownership_unverified"],
];

for (const [message, q, rule] of S1_DENIALS) {
  test(`S1 (${q}) ${JSON.stringify(message)} -> ownership denied / unverified: no nurture, no reply, no review, no suppression`, async () => {
    const r = await replay(message, q);
    const c = r.classification;
    assert.equal(c.primary_intent, "property_specific_non_owner");
    assert.ok(c.matched_rule_ids.includes(rule), c.matched_rule_ids.join(","));
    assert.ok(!c.matched_rule_ids.includes("ctx_bare_no_after_ownership_check_not_interested"));
    assert.ok(c.secondary_intents.includes("ownership_denied"));
    assert.ok(c.secondary_intents.includes("ownership_unverified"));
    assert.equal(c.compliance_flag ?? null, null);
    assert.notEqual(c.automation_decision?.suppression_action, "archive_wrong_number");
    assert.notEqual(c.automation_decision?.suppression_action, "opt_out");
    assert.equal(c.automation_decision?.clarification_use_case ?? null, null, "no further ownership question");
    assertNoFollowupDecline(r, "s1_ownership_denied_unverified_no_followup");
    // Never a qualified seller.
    assert.notEqual(r.decision.route_hint, "consider_selling");
    assert.equal(suppressesAutomaticFollowup(c), true);
  });
}

test("S1 'Not anymore' is a former owner (sold lane): property pairing closed, phone never suppressed", async () => {
  const r = await replay("Not anymore", "s1_still_own");
  assert.equal(r.classification.primary_intent, "sold_property");
  assert.equal(r.decision.should_suppress_contact, false);
  assert.equal(r.decision.next_action, "disposition_property_sold");
});

test("S1 polite declines ('No thanks', 'No gracias Carlos!') answer a sales approach: decline, 30-day nurture (unchanged)", async () => {
  for (const [message, q] of [["No thanks", "s1_still_own"], ["No gracias Carlos!", "s1_es"]]) {
    const r = await replay(message, q);
    assert.equal(r.classification.primary_intent, "not_interested", message);
    assert.ok(r.classification.matched_rule_ids.includes("ctx_polite_no_after_ownership_check_not_interested"));
    assert.equal(r.decision.audit_reason, "s1_not_for_sale_advance_with_followup");
    assert.equal(r.decision.should_suppress_contact, false);
    assert.ok(r.decision.follow_up_at, "keeps the 30-day nurture");
  }
});

test("rc-8.5.21 (owner P0 2026-10-16): an emoji negative ('No 👎', 'Nope 🙅') to the OWNERSHIP question is the property-scoped denial (the 103-thread cohort), no nurture; to S2 it stays the decline", async () => {
  for (const [message, q] of [["No 👎", "s1_yours"], ["Nope 🙅", "s1_still_own"]]) {
    const r = await replay(message, q);
    assert.equal(r.classification.primary_intent, "property_specific_non_owner", message);
    assert.ok(r.classification.matched_rule_ids.includes("ctx_emoji_no_after_ownership_check_ownership_unverified"), r.classification.matched_rule_ids.join(","));
    assertNoFollowupDecline(r, "s1_ownership_denied_unverified_no_followup");
  }
  const s2 = await replay("No 👎", "s2");
  assert.equal(s2.classification.primary_intent, "not_interested");
});

test("written ownership denials are the property-scoped denial, never wrong_number + suppression; explicit wrong number / sold keep their lanes", async () => {
  for (const message of ["not mine", "I don't own it", "Never owned it", "Not my house", "No soy el dueño"]) {
    const r = await replay(message, "s1_still_own");
    assert.equal(r.classification.primary_intent, "property_specific_non_owner", message);
    assert.ok(r.classification.secondary_intents.includes("ownership_unverified"), message);
    assert.equal(r.decision.should_suppress_contact, false, message);
    assert.equal(r.decision.next_action, NO_FOLLOWUP_NEXT_ACTION, message);
    assert.notEqual(r.classification.automation_decision?.suppression_action, "archive_wrong_number", message);
  }
  // Without any context too: a written denial is never a wrong-number suppression.
  const bare = await classify("not mine", null, { heuristicOnly: true });
  assert.equal(bare.primary_intent, "property_specific_non_owner");
  for (const [message, intent] of [["wrong number", "wrong_number"], ["Wrong person", "wrong_number"], ["No, I sold it", "sold_property"]]) {
    const r = await replay(message, "s1_still_own");
    assert.equal(r.classification.primary_intent, intent, message);
  }
});

test("an explicit STOP or ANY request to stop messaging suppresses in both engines (eval #83 + the 2026-10-14 production misses)", async () => {
  const { deterministicPrecheck } = await import("@/lib/domain/conversation-ai/precheck.js");
  // The three production misses of 2026-10-14 (suppressed by hand), masked.
  for (const message of ["God bless JesusSTOP 🛑", "Thank you Jesus STOP 🛑", "JesusSTOP", "🛑", "stop🛑", "Not interested please stop sending", "Stop asking me about [address]", "Stop asking me about 1 Main St", "Please stop sending me these", "stop texting me about this house"]) {
    const c = await classify(message, null, { heuristicOnly: true });
    assert.equal(c.primary_intent, "opt_out", message);
    assert.equal(c.compliance_flag, "stop_texting", message);
    const p = deterministicPrecheck({ text: message, inboundId: "x" });
    assert.equal(p.decided, true, message);
    assert.equal(p.decision.outcome, "SUPPRESS", message);
  }
  for (const message of ["I work nonstop", "Bus stop near the house", "Stop calling me, text me instead"]) {
    const c = await classify(message, null, { heuristicOnly: true });
    assert.notEqual(c.compliance_flag, "stop_texting", message);
  }
});

test("STOP / opt-out after S1 still suppresses; no ownership-denial rule can swallow it", async () => {
  for (const message of ["STOP", "No. Stop texting me", "no, remove me", "No stop"]) {
    const r = await replay(message, "s1_still_own");
    assert.equal(r.classification.primary_intent, "opt_out", message);
    assert.equal(r.decision.should_suppress_contact, true, message);
    assert.equal(r.decision.suppression_reason, "opt_out", message);
  }
});

test("8.5.13 behaviour is still reachable as an explicit mode (LC_BARE_NO_OWNERSHIP_MODE=not_interested), and non_owner keeps the wrong-number lane", async () => {
  const before = process.env.LC_BARE_NO_OWNERSHIP_MODE;
  try {
    process.env.LC_BARE_NO_OWNERSHIP_MODE = "not_interested";
    const a = await replay("No", "s1_still_own");
    assert.equal(a.classification.primary_intent, "not_interested");
    assert.ok(a.classification.matched_rule_ids.includes("ctx_bare_no_after_ownership_check_not_interested"));
    process.env.LC_BARE_NO_OWNERSHIP_MODE = "non_owner";
    const b = await replay("No", "s1_still_own");
    assert.equal(b.classification.primary_intent, "wrong_number");
  } finally {
    if (before === undefined) delete process.env.LC_BARE_NO_OWNERSHIP_MODE;
    else process.env.LC_BARE_NO_OWNERSHIP_MODE = before;
  }
});

test("S1 ownership denial is property-scoped in the relationship layer: recorded non-owner for THIS property, phone/person never invalidated, no review", async () => {
  const r = await replay("No", "s1_still_own");
  const rel = resolveInboundRelationship({
    message: "No",
    classification: r.classification,
    source_contact_phone: "+15555550123",
    property_id: "prop-1",
    master_owner_id: "mo-1",
  });
  assert.equal(rel.relationship_claim, "ownership_unverified");
  assert.equal(rel.canonical_intent, "property_specific_non_owner");
  assert.equal(rel.relationship_outcome, "property_specific_non_owner");
  assert.equal(rel.is_property_scoped, true);
  assert.equal(rel.suppression_scope, "property");
  assert.equal(rel.suppression_property_id, "prop-1");
  assert.equal(rel.should_suppress_contact, false);
  assert.equal(rel.invalidate_phone_globally, false);
  assert.equal(rel.invalidate_person_globally, false);
  assert.equal(rel.is_global_suppression, false);
  assert.equal(rel.human_review_required, false);
  assert.equal(rel.ownership_confirmed, false);
  const mark = rel.proposed_operations.find((op) => op.op === "mark_contact_property_non_owner");
  assert.ok(mark, "contact x property non-owner record proposed");
  assert.equal(mark.property_id, "prop-1");
  assert.equal(mark.invalidate_globally, false);
  // The follow-up scheduler gives the property-scoped non-owner no nurture.
  const plan = resolveFollowUpPlan("property_specific_non_owner", { thread_key: "+15555550123", property_scoped_only: true });
  assert.equal(plan.followup_created, false);
});

// ── 2. S2: "No" is disinterest, no automatic follow-up ─────────────────────
for (const message of ["No", "Nope", "No. Thank you", "No thanks", "Nah"]) {
  test(`S2 ${JSON.stringify(message)} -> not_interested: the existing 30-day nurture (owner decision 2026-10-14), never suppressed`, async () => {
    const r = await replay(message, "s2");
    const c = r.classification;
    assert.equal(c.primary_intent, "not_interested");
    assert.ok(c.matched_rule_ids.includes("ctx_no_after_proposal_interest"), c.matched_rule_ids.join(","));
    assert.equal(r.decision.should_suppress_contact, false);
    assert.equal(r.decision.next_action, "do_not_reply", "existing nurture route");
    assert.equal(resolveDeclineFollowupPolicy(c), null, "no S2 no-follow-up variant exists");
    assert.equal(suppressesAutomaticFollowup(c), false);
  });
}

test("an explicit 'Not interested' at S2 keeps the 30-day nurture route (owner rule 2026-10-05; not a bare No)", async () => {
  const r = await replay("Not interested", "s2");
  assert.equal(r.classification.primary_intent, "not_interested");
  assert.equal(r.decision.next_action, "do_not_reply");
});

test("'Sold' to S2 still goes to the sold detector, never the S2 decline", async () => {
  const r = await replay("Sold", "s2");
  assert.equal(r.classification.primary_intent, "sold_property");
});

// ── 3. Condition: "No" = no repairs reported ────────────────────────────────
test("condition question: 'No' reports no repairs (condition_disclosed) and the workflow continues as for 'No repairs needed'", async () => {
  const bare = await replay("No", "s4");
  const explicit = await replay("No repairs needed", "s4");
  assert.equal(bare.classification.primary_intent, "condition_disclosed");
  assert.ok(bare.classification.matched_rule_ids.includes("ctx_no_after_condition_no_repairs"));
  assert.ok(bare.classification.secondary_intents.includes("no_repairs_reported"));
  assert.notEqual(bare.classification.primary_intent, "not_interested");
  assert.equal(bare.decision.should_suppress_contact, false);
  assert.equal(bare.decision.should_mark_human_review, explicit.decision.should_mark_human_review);
  assert.equal(bare.decision.next_action, explicit.decision.next_action);
  assert.equal(bare.template?.use_case ?? null, explicit.template?.use_case ?? null, "same next step as the explicit answer");
  assert.equal(bare.decision.follow_up_at ?? null, null, "never shelved for 30 days");
});

// ── 4. "Can we check back?" -> "No" ends outreach in that scope ─────────────
test("the check-back bodies name the contact_permission question; the closes that ask nothing do not", () => {
  for (const q of ["permission_future_nurture", "permission_not_interested", "permission_not_ready", "permission_es"]) {
    assert.equal(deriveUseCaseFromBody(QUESTIONS[q][1]), "contact_permission", q);
  }
  for (const body of [
    "All good. I’ll close the loop on my end. If circumstances ever change, you know where to find me.",
    "That’s fine. I can step back and follow up later, or send the number now so you have it if anything changes.",
  ]) {
    assert.equal(deriveUseCaseFromBody(body), null, body);
  }
});

for (const q of ["permission_future_nurture", "permission_not_interested", "permission_not_ready", "permission_es"]) {
  test(`contact permission (${q}): 'No' ends outreach in scope -- no follow-up, no reply, never suppressed`, async () => {
    const r = await replay("No", q);
    assert.equal(r.classification.primary_intent, "not_interested");
    assert.ok(r.classification.matched_rule_ids.includes("ctx_no_after_contact_permission"));
    assertNoFollowupDecline(r, "contact_permission_declined_no_followup");
  });
}

test("contact permission: 'Yes' grants a later check-in -- never read as ownership confirmed / an S2 proposal question", async () => {
  for (const message of ["Yes", "Sure"]) {
    const r = await replay(message, "permission_future_nurture");
    assert.notEqual(r.classification.primary_intent, "ownership_confirmed", message);
    assert.equal(r.decision.should_queue_reply, false, message);
    assert.notEqual(r.template?.use_case, "consider_selling", message);
  }
});

// ── 5. No overlay can re-add a nurture ─────────────────────────────────────
test("the S1 ownership-probe nurture overlay never fires for an S1 denial or a declined check-back", async () => {
  for (const [message, q] of [["No", "s1_still_own"], ["not mine", "s1_still_own"], ["No", "permission_future_nurture"]]) {
    const r = await replay(message, q);
    const probe = resolveOwnershipProbeDisinterestTransition({
      classification: r.classification,
      messageEvent: { message_body: message, direction: "inbound" },
      existingState: { conversation_stage: "ownership_confirmation" },
    });
    assert.equal(probe, null, `${q}: ${message}`);
  }
  // An explicit decline at S1 keeps it.
  const explicit = await replay("Not interested", "s1_still_own");
  const probe = resolveOwnershipProbeDisinterestTransition({
    classification: explicit.classification,
    messageEvent: { message_body: "Not interested", direction: "inbound" },
    existingState: { conversation_stage: "ownership_confirmation" },
  });
  assert.ok(probe?.follow_up_at);
});

// ── 6. The real orchestrator, offline ──────────────────────────────────────
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


const CATALOG_E2E = [
  tpl("400065", "consider_selling", "S2", "auto_reply", "Any Residential", "Thanks for confirming. Would you consider a proposal for the property?"),
  tpl("1040", "not_interested", "SP", "auto_reply", "Residential", "Understood, I'll leave it alone. If that ever changes, want me to check back down the road?"),
  tpl("lc-future-nurture-en-1", "future_nurture", "S2F", "auto", "Any Residential", "No problem at all. Is it alright if I check back down the road?"),
  tpl("1009", "who_is_this", "SP", "auto_reply", "Residential", "I'm a local investor here in the area. I reached out about your property. Would you be open to a proposal on it?"),
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

async function runInbound({ message, priorBody, stage = "ownership_check" }) {
  const thread = "+12145550101";
  const deliveredAt = "2026-10-14T17:00:05.000Z";
  const receivedAt = "2026-10-14T17:05:00.000Z";
  const db = memoryDb({
    sms_templates: CATALOG_E2E,
    send_queue: [
      { id: "prior-1", to_phone_number: thread, thread_key: thread, message_type: null, message_body: priorBody, provider_message_id: "SM-prior", sent_at: deliveredAt, delivered_at: deliveredAt, queue_status: "delivered", type: "campaign", created_at: deliveredAt },
    ],
  });
  const followups = [];
  const resolutions = [];
  __setSellerInboundOrchestratorDeps({
    getSupabaseClient: () => db.client,
    getDealContextByThread: async () => null,
    probeDealContextAmbiguity: async () => ({ ambiguous: false }),
    runContactResolutionPhase: async (args) => {
      resolutions.push(args);
      return { ran: false, sends: 0 };
    },
    cancelPendingFollowUpsForThread: async () => ({ ok: true, cancelled: 0 }),
    cancelPendingSellerEmails: async () => ({ ok: true, cancelled: 0 }),
    patchUniversalLeadState: async () => ({ ok: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    executeReferralAutomation: async () => ({ ok: true }),
    scoreProperty: async () => ({ ok: false, error: "no_ade_offline" }),
    scheduleFollowUp: async (intent) => {
      followups.push(intent);
      return { ok: true, followup_created: true, scheduled_for: "2026-11-13T00:00:00.000Z" };
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
      canonical_stage: stage,
    });
    const classification = await classify(message, null, { heuristicOnly: true, conversation_context });
    const out = await processSellerInboundMessage({
      message,
      threadKey: thread,
      inboundFrom: thread,
      inboundTo: "+16125550100",
      propertyId: "prop-e2e-1",
      ownerId: "mo-e2e-1",
      prospectId: "pros-e2e-1",
      phoneId: "phone-e2e-1",
      classification,
      context: {
        found: true,
        ids: { property_id: "prop-e2e-1", master_owner_id: "mo-e2e-1", prospect_id: "pros-e2e-1", phone_item_id: "phone-e2e-1" },
        summary: { conversation_stage: stage, seller_stage: stage, property_address: "1547 Summers Dr", seller_first_name: "Charles" },
      },
      route: { stage, use_case: stage },
      inboundEventId: "evt-e2e-1",
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
    const suppressionWrites = db.writes.filter((w) => ["sms_suppression_list", "automation_suppressions"].includes(w.table));
    const phoneWrites = db.writes.filter((w) => w.table === "phones").flatMap((w) => w.rows);
    return { out, inserts, followups, resolutions, suppressionWrites, phoneWrites, classification };
  } finally {
    __resetSellerInboundOrchestratorDeps();
  }
}

const S1_BODY = "Hi Charles, this is Alex. Quick question, do you still own the property at 1547 Summers Dr?";
const S2_BODY = "Thanks for confirming. Would you consider a proposal for the property?";

test("orchestrator: S1 bare 'No' schedules no follow-up, queues nothing, suppresses nothing, records the property-scoped non-owner outcome", async () => {
  const r = await runInbound({ message: "No", priorBody: S1_BODY });
  assert.equal(r.classification.primary_intent, "property_specific_non_owner");
  assert.deepEqual(r.followups, [], "no nurture");
  assert.equal(r.inserts.length, 0, "no send_queue row");
  assert.equal(r.suppressionWrites.length, 0, "no suppression list write");
  assert.ok(!r.phoneWrites.some((row) => row.phone_contact_status === "wrong_number"), "phone never marked wrong_number");
  assert.equal(r.resolutions.length, 1);
  assert.equal(r.resolutions[0].relationship.relationship_outcome, "property_specific_non_owner");
  assert.equal(r.resolutions[0].relationship.relationship_claim, "ownership_unverified");
});

test("orchestrator: S2 'No' keeps the existing 30-day nurture (owner decision), queues nothing, suppresses nothing", async () => {
  const r = await runInbound({ message: "No", priorBody: S2_BODY, stage: "consider_selling" });
  assert.equal(r.classification.primary_intent, "not_interested");
  assert.deepEqual(r.followups, ["not_interested"]);
  assert.equal(r.inserts.length, 0);
  assert.equal(r.suppressionWrites.length, 0);
});

test("orchestrator: an explicit 'Not interested' at S1 still schedules the 30-day nurture (unchanged)", async () => {
  const r = await runInbound({ message: "Not interested", priorBody: S1_BODY });
  assert.equal(r.classification.primary_intent, "not_interested");
  assert.deepEqual(r.followups, ["not_interested"]);
});

test("orchestrator: STOP after S1 suppresses and schedules nothing", async () => {
  const r = await runInbound({ message: "STOP", priorBody: S1_BODY });
  assert.equal(r.classification.primary_intent, "opt_out");
  assert.deepEqual(r.followups, []);
  assert.equal(r.inserts.length, 0);
});

// ── 7. Deterministic eval fixes (blind 150-item gold set, 2026-10-14) ───────
test("eval #131: a 'No' that names someone else as the owner is the ownership denial", async () => {
  const r = await replay("Nope should be the city of Jennings", "s1_yours");
  assert.equal(r.classification.primary_intent, "property_specific_non_owner");
  assert.equal(r.decision.should_suppress_contact, false);
});

test("eval #55: 'Si pero no estoy vendiéndola' / 'Yes but I'm not selling' confirms ownership AND declines: the 30-day decline, never the S2 question again", async () => {
  for (const [m, q] of [["Si pero no estoy vendiéndola", "s1_es"], ["Yes but I'm not selling", "s1_still_own"]]) {
    const r = await replay(m, q);
    assert.equal(r.classification.primary_intent, "not_interested", m);
    assert.notEqual(r.template?.use_case, "consider_selling", m);
  }
  const yes = await replay("Yes I own it", "s1_still_own");
  assert.equal(yes.classification.primary_intent, "ownership_confirmed");
});

test("eval #20: 'market value' to our asking-price question names no number -- never latent interest that re-asks the price", async () => {
  const ask = ["seller_asking_price", "Got it. What price would you be looking for?"];
  QUESTIONS.s3 = ask;
  for (const m of ["No but market value", "Market value", "Valor de mercado"]) {
    const r = await replay(m, "s3");
    assert.equal(r.classification.primary_intent, "asking_price_absent", m);
    assert.ok(r.classification.matched_rule_ids.includes("ctx_market_value_after_asking_price"), m);
    assert.notEqual(r.template?.use_case, "seller_asking_price", m);
  }
});

test("eval #120: someone who works for an investor is a counterparty: a person reads it, no price question", async () => {
  for (const m of ["No this is Sam and I work for an investor we do have another property we are trying to sell"]) {
    const r = await replay(m, "s1_es");
    assert.ok(r.classification.matched_rule_ids.includes("r11_counterparty_investor_pitch"), m);
    assert.equal(r.decision.should_queue_reply, false, m);
    assert.notEqual(r.template?.use_case, "seller_asking_price", m);
  }
});
