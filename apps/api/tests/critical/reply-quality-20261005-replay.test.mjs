/**
 * Reply-quality fixtures for 2026-10-05 (tests/fixtures/reply-quality/2026-10-05.json,
 * produced by scripts/ops/reply-quality-report.mjs), promoted to tests.
 *
 * Every row is replayed the way the live webhook does it: the prior question
 * becomes the last delivered send_queue row, the intervening inbound rows keep
 * their stored intent, buildConversationContext builds the context, and
 * classify(heuristicOnly) decides. The labels below are the expected
 * behaviour, set 2026-10-05; rows whose live outcome is refined by the
 * property-relationship / referral layers (not modelled here) are labelled
 * with the classifier-level intent only or left out.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildConversationContext } from "@/lib/domain/classification/build-conversation-context.js";
import { classify } from "@/lib/domain/classification/classify.js";

const FIXTURES = JSON.parse(
  readFileSync(new URL("../fixtures/reply-quality/2026-10-05.json", import.meta.url), "utf8")
);
const byId = new Map(FIXTURES.candidates.map((c) => [c.fixture_id.slice(-3), c]));

// The auto-reply rows today were rendered from sms_templates 400065
// (use_case consider_selling) and stored with message_type "Follow-Up".
const AUTO_REPLY_TEMPLATE_ID = "400065";

function supabaseFor(c) {
  const kind = c.prior_question?.kind;
  const outbound = {
    id: `out-${c.fixture_id}`,
    message_type: c.prior_question?.message_type ?? null,
    message_body: c.prior_question?.text || "",
    template_id: kind === "auto_reply" ? AUTO_REPLY_TEMPLATE_ID : null,
    provider_message_id: null,
    sent_at: "2026-10-05T12:00:00.000Z",
    delivered_at: "2026-10-05T12:00:10.000Z",
    queue_status: "delivered",
  };
  const intervening = (c.intervening_inbound || []).map((row, i) => ({
    id: `in-${c.fixture_id}-${i}`,
    created_at: `2026-10-05T12:0${Math.min(i + 1, 9)}:00.000Z`,
    direction: "inbound",
    message_body: row.text,
    detected_intent: row.intent,
  }));
  const templates = { [AUTO_REPLY_TEMPLATE_ID]: [{ use_case: "consider_selling" }] };
  const make = (rows) => {
    const b = {
      select: () => b, eq: () => b, in: () => b, not: () => b, lte: () => b,
      gt: () => b, lt: () => b, order: () => b,
      limit: async () => ({ data: rows, error: null }),
    };
    return b;
  };
  return {
    from: (table) =>
      make(
        table === "message_events"
          ? intervening
          : table === "sms_templates"
            ? templates[outbound.template_id] || []
            : [outbound]
      ),
  };
}

async function replay(id) {
  const c = byId.get(id);
  assert.ok(c, `fixture ${id} exists`);
  const ctx = await buildConversationContext({
    thread_key: "+18175550123",
    inbound_received_at: "2026-10-05T13:00:00.000Z",
    supabase: supabaseFor(c),
  });
  const r = await classify(c.seller_message, null, { heuristicOnly: true, conversation_context: ctx });
  return { c, ctx, r };
}

// id -> expected. `auto` = auto_reply_allowed, `review` = human_review_required,
// `suppress` = suppression_action, `lang` = reply language.
const LABELS = {
  // ── COMPLIANCE ──
  "005": { intent: "opt_out", suppress: "opt_out", auto: false, lang: "Spanish" },
  "048": { intent: "opt_out", suppress: "opt_out", auto: false, lang: "Spanish" },
  "053": { intent: "opt_out", suppress: "opt_out", auto: false, lang: "Spanish" },
  // ── context: replies to our auto-reply ("Would you be open to a proposal?") ──
  "032": { intent: "seller_interested", auto: true, ctx_use_case: "proposal_interest" },
  // ── offer requests ──
  "010": { intent: "asks_offer", auto: true },
  "020": { intent: "asks_offer", auto: true },
  "021": { intent: "asks_offer", auto: true },
  "045": { intent: "asks_offer", auto: true },
  // ── house number is not a price ──
  "028": { not_intent: "asking_price_provided", intent: "not_interested", auto: false, review: true },
  // ── language of short Spanish replies ──
  "023": { intent: "ownership_confirmed", auto: true, lang: "Spanish" },
  "046": { intent: "ownership_confirmed", auto: true, lang: "Spanish" },
  "050": { intent: "ownership_confirmed", auto: true, lang: "Spanish" },
  "031": { intent: "who_is_this", auto: true, lang: "Spanish" },
  "044": { intent: "ownership_confirmed", auto: true, lang: "Spanish" },
  "042": { intent: "sold_property", lang: "Spanish" },
  "025": { lang: "Spanish", not_intent: "opt_out" },
  // ── unclear Spanish ──
  "026": { intent: "not_interested", lang: "Spanish", suppress: "none" },
  "047": { intent: "not_interested", lang: "Spanish", suppress: "none" },
  // Round 10 (owner 2026-10-08): ownership denials are property-scoped.
  "034": { intent: "property_specific_non_owner", lang: "Spanish" },
  "052": { intent: "property_specific_non_owner", lang: "Spanish" },
  "036": { intent: "hostile_or_legal", lang: "Spanish", auto: false },
  "040": { intent: "who_is_this", lang: "Spanish" },
  "041": { intent: "who_is_this", lang: "Spanish" },
  "051": { intent: "who_is_this", auto: true },
  // ── thanks-only after the seller already answered ──
  "035": { intent: "acknowledgement", auto: false, review: false, lang: "Spanish" },
  "043": { intent: "acknowledgement", auto: false, review: false, lang: "Spanish" },
  // ── already fixed in 8.4.2 (kept as regressions) ──
  "003": { intent: "ownership_confirmed", auto: true },
  "004": { intent: "seller_interested", auto: true },
  "006": { intent: "who_is_this", auto: true },
  "011": { intent: "ownership_confirmed", auto: true },
  "029": { intent: "ownership_confirmed", auto: true },
  "015": { intent: "unclear", auto: false, review: true },
  "018": { intent: "not_interested" },
  // ── review by design ──
  "002": { intent: "unclear", review: true },
  "016": { intent: "unclear", review: true },
  "022": { intent: "unclear", review: true },
  // Round 8 owner rule: a bare "?" gets the who_is_this reply.
  "030": { intent: "who_is_this", auto: true },
  "039": { intent: "unclear", review: true },
  "012": { intent: "hostile_or_legal", auto: false },
  // ── bare "No" to the ownership question: ONE clarifier (owner decision 2026-10-06) ──
  "001": { intent: "unclear", auto: true, review: false },
  "013": { intent: "unclear", auto: true, review: false },
  "019": { intent: "unclear", auto: true, review: false },
  "033": { intent: "unclear", auto: true, review: false },
  "037": { intent: "unclear", auto: true, review: false },
  // ── classifier-level intent (live layers refine these) ──
  // Round 10: "I do not own any property …" / "Not the owner" are property-scoped.
  "009": { intent: "property_specific_non_owner" },
  "024": { intent: "property_specific_non_owner" },
  "049": { intent: "property_specific_non_owner" },
  "014": { intent: "not_interested" },
  "017": { intent: "sold_property" },
};

for (const [id, e] of Object.entries(LABELS)) {
  test(`reply-quality 2026-10-05 #${id}: ${JSON.stringify(byId.get(id)?.seller_message || "").slice(0, 60)}`, async () => {
    const { r, ctx } = await replay(id);
    const d = r.automation_decision;
    const at = `#${id} → ${r.primary_intent} ${r.language} auto=${d.auto_reply_allowed} review=${d.human_review_required}`;
    if (e.intent) assert.equal(r.primary_intent, e.intent, at);
    if (e.not_intent) assert.notEqual(r.primary_intent, e.not_intent, at);
    if (e.auto !== undefined) assert.equal(d.auto_reply_allowed, e.auto, at);
    if (e.review !== undefined) assert.equal(d.human_review_required, e.review, at);
    if (e.suppress) assert.equal(d.suppression_action, e.suppress, at);
    if (e.lang) assert.equal(r.language, e.lang, at);
    if (e.ctx_use_case) assert.equal(ctx?.last_outbound_use_case, e.ctx_use_case, at);
  });
}

// ── focused variants beyond the fixture rows ────────────────────────────────

const plain = (m, ctx = null) => classify(m, null, { heuristicOnly: true, conversation_context: ctx });

test("COMPLIANCE family: remove/delete my number and blocking are opt-outs, even beside a yes", async () => {
  for (const m of [
    "Ya quita mi número de tus contactos", "Quita mi numero", "Borra mi número por favor",
    "Borren mi numero", "Elimina mi número", "Mejor te blokeo...", "Te voy a bloquear",
    "Te bloqueo", "Ya te bloqueé", "Si soy yo pero te voy a bloquear", "No me vuelvas a escribir",
    "No me vuelvan a escribir",
  ]) {
    const r = await plain(m);
    assert.equal(r.primary_intent, "opt_out", m);
    assert.equal(r.automation_decision.suppression_action, "opt_out", m);
    assert.equal(r.automation_decision.auto_reply_allowed, false, m);
  }
});

test("offer requests route to asks_offer; statements about someone else's offer do not", async () => {
  for (const m of ["Send a bid", "Send me your number", "What your price", "What's your offer?", "You like to buy it", "Do you want to buy it?", "Go ahead take look and offer me", "Make me an offer"]) {
    assert.equal((await plain(m)).primary_intent, "asks_offer", m);
  }
  for (const m of ["Someone offered me 300k", "They will offer me more"]) {
    assert.notEqual((await plain(m)).primary_intent, "asks_offer", m);
  }
});

test("thanks-only: a polite close, whether or not our question is still open (owner rule 2026-10-06)", async () => {
  for (const m of ["Gracias", "Thanks", "Thank you!", "Muchas gracias", "ok thanks", "Thanks 🙏"]) {
    const r = await plain(m);
    assert.equal(r.primary_intent, "acknowledgement", m);
    assert.equal(r.automation_decision.human_review_required, false, m);
    assert.equal(r.automation_decision.auto_reply_allowed, false, m);
  }
  const open = await buildConversationContext({
    thread_key: "+18175550123",
    inbound_received_at: "2026-10-05T13:00:00.000Z",
    supabase: supabaseFor({ fixture_id: "open", prior_question: { kind: "campaign", text: "Hola Pat, sigues siendo el dueno de 1 Main St?", message_type: null }, intervening_inbound: [] }),
  });
  assert.equal(open.question_status, "unanswered");
  // Owner rule 2026-10-06 (round 6): a thanks-only reply is a polite close even
  // while our question is open.
  const r = await plain("Gracias", open);
  assert.equal(r.automation_decision.reply_kind, "polite_close");
  // Compliance still wins.
  assert.equal((await plain("Gracias, ya no me escriba")).primary_intent, "opt_out");
});

test("a specific message_type still beats the template; Follow-Up never hides the template question", async () => {
  const make = (row, templates = []) => {
    const mk = (rows) => { const b = { select: () => b, eq: () => b, in: () => b, not: () => b, lte: () => b, gt: () => b, lt: () => b, order: () => b, limit: async () => ({ data: rows, error: null }) }; return b; };
    return { from: (t) => mk(t === "message_events" ? [] : t === "sms_templates" ? templates : [row]) };
  };
  const base = { id: "o", provider_message_id: null, sent_at: "2026-10-05T12:00:00Z", delivered_at: "2026-10-05T12:00:10Z", queue_status: "delivered" };
  const ctxOf = (row, templates) => buildConversationContext({ thread_key: "+18175550123", inbound_received_at: "2026-10-05T13:00:00Z", supabase: make({ ...base, ...row }, templates) });
  const followUp = await ctxOf({ message_type: "Follow-Up", template_id: "400065", message_body: "Thanks for confirming." }, [{ use_case: "consider_selling" }]);
  assert.equal(followUp.last_outbound_use_case, "proposal_interest");
  assert.equal(followUp.last_outbound_use_case_source, "template_use_case");
  const followUpBody = await ctxOf({ message_type: "Follow-Up", template_id: null, message_body: "Would you be open to a proposal on it?" });
  assert.equal(followUpBody.last_outbound_use_case, "proposal_interest");
  const followUpNothing = await ctxOf({ message_type: "Follow-Up", template_id: null, message_body: "Hope you are well." });
  assert.equal(followUpNothing.last_outbound_use_case, "general_followup");
  const explicit = await ctxOf({ message_type: "ownership_check", template_id: "400065", message_body: "x" }, [{ use_case: "consider_selling" }]);
  assert.equal(explicit.last_outbound_use_case, "ownership_check");
});

test("short Spanish replies are detected as Spanish", async () => {
  for (const m of ["Si", "Sí", "Por que?", "Gracias", "No vendo", "Ya la vendi", "Claro", "No esta en venta"]) {
    assert.equal((await plain(m)).language, "Spanish", m);
  }
  for (const m of ["Yes", "No thanks", "Not for sale"]) {
    assert.equal((await plain(m)).language, "English", m);
  }
});
