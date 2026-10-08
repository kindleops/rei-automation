/**
 * Seller Autopilot S1–S4 v2 — end-to-end flows through the REAL classifier,
 * conversation context, orchestrator and executor (in-memory database, no
 * network). The catalog = today's approved EN/ES rows + the legacy rows the
 * owner would flag safe + the PROPOSED v2 rows treated as approved, i.e. the
 * state after the owner signs off. With the flag OFF nothing v2 runs.
 */
import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import { withBareNoClarifierOn } from "../helpers/bare-no-clarifier-flag.mjs";
import assert from "node:assert/strict";

import { memoryDb, tpl, adeSnapshot, runSellerTurn, seedOpener } from "../helpers/seller-autopilot-v2-harness.mjs";
import { proposedTemplateRows } from "../../scripts/ops/seller-autopilot-v2-templates.proposed.mjs";

const CATALOG = [
  tpl("400065", "consider_selling", "English", "Thanks for confirming. Would you consider a proposal for the property?", { property_type_scope: "Any Residential" }),
  tpl("occ_seller_asking_price_en_v1", "seller_asking_price", "English", "Got it. What price would you have in mind for the property?", { property_type_scope: null }),
  tpl("550002", "price_high_condition_probe", "English", "Got it. Is the property updated, or does it need work?"),
  tpl("540001", "price_works_confirm_basics", "English", "Got it. That may work on our end. Is the property vacant right now?"),
  tpl("1009", "who_is_this", "English", "I'm a local investor here in the area. I reached out about your property. Would you be open to a proposal on it?"),
  tpl("400002", "consider_selling", "Spanish", "Gracias por confirmar. Solo por curiosidad, estarias abierto a una propuesta sobre la propiedad?", { property_type_scope: "Any Residential" }),
  tpl("occ_seller_asking_price_es_v1", "seller_asking_price", "Spanish", "Entendido. ¿Qué precio tendría en mente para la propiedad?", { property_type_scope: null }),
  tpl("550102", "price_high_condition_probe", "Spanish", "Entiendo. ¿La propiedad está actualizada o necesita trabajo?"),
  tpl("540101", "price_works_confirm_basics", "Spanish", "Entiendo, eso podría funcionar para nosotros. ¿La propiedad está vacía en este momento?"),
  tpl("1067", "who_is_this", "Spanish", "Soy un inversionista local aquí en la zona. Le escribí por su propiedad. ¿Estaría abierto a una propuesta?"),
  tpl("400003", "consider_selling", "Portuguese", "Obrigado por confirmar. So por curiosidade, voce estaria aberto a uma proposta sobre a propriedade?", { property_type_scope: "Any Residential" }),
  tpl("840003", "seller_asking_price", "Portuguese", "Voce tinha um preco em mente?"),
  tpl("550202", "price_high_condition_probe", "Portuguese", "Entendi. O imóvel está atualizado ou precisa de obra?"),
  tpl("540206", "price_works_confirm_basics", "Portuguese", "Parece estar em faixa. Está vazio ou ocupado?"),
  tpl("400007", "consider_selling", "Mandarin", "Xie xie nin queren. Zhi shi hao qi, nin dui zhege proposal hui kaifang ma?", { property_type_scope: "Any Residential" }),
  tpl("840007", "seller_asking_price", "Mandarin", "Nin you xinli jiawei ma?"),
  tpl("550802", "price_high_condition_probe", "Mandarin", "明白了。房子是已经更新过，还是需要维修？"),
  tpl("400012", "consider_selling", "French", "Merci pour la confirmation. Juste par curiosite, seriez vous ouvert a une proposition sur ce bien?", { property_type_scope: "Any Residential" }),
  tpl("840012", "seller_asking_price", "French", "Vous aviez un prix en tete?"),
  ...proposedTemplateRows().map((r) => tpl(r.template_id, r.use_case, r.language, r.template_body)),
];

const OPENERS = {
  English: "Hi Pat, this is Alex. Do you still own 1547 Summers Dr?",
  Spanish: "Hola Pat, soy Alex. ¿Sigues siendo el dueño de 1547 Summers Dr?",
  Portuguese: "Ola Pat, aqui e o Alex. Voce ainda e o proprietario de 1547 Summers Dr?",
  Mandarin: "Nin hao Pat, wo shi Alex. Nin hai yongyou 1547 Summers Dr ma?",
  French: "Bonjour Pat, c est Alex. Est a vous 1547 Summers Dr?",
};

afterEach(() => {
  delete process.env.SELLER_AUTOPILOT_V2;
});

const ALL_LANGUAGES = "English,Spanish,Portuguese,Mandarin,French";

async function runFlow({ language = "English", turns, ade = adeSnapshot(), summary = {}, flag = true, systemControl = {} }) {
  if (flag) process.env.SELLER_AUTOPILOT_V2 = "true";
  else delete process.env.SELLER_AUTOPILOT_V2;
  const thread = "+16125550123";
  const db = memoryDb({
    sms_templates: CATALOG,
    acquisition_opportunities: [{ id: "opp-v2-1", primary_thread_key: thread, dedupe_key: "opp-v2-1", metadata: {}, updated_at: "2026-10-01T00:00:00.000Z" }],
  });
  seedOpener(db, { thread, body: OPENERS[language], deliveredAt: "2026-10-05T14:00:00.000Z" });
  let t = Date.parse("2026-10-05T14:00:00.000Z");
  const results = [];
  for (const [message, stageBefore] of turns) {
    t += 5 * 60_000;
    results.push(
      await runSellerTurn({ db, thread, message, receivedAt: new Date(t).toISOString(), stageBefore, ade, propertySummary: summary, systemControl })
    );
  }
  return { db, results };
}

const sent = (r) => r.inserts.map((i) => i.use_case_template);
const body = (r) => r.inserts[0]?.message_body || "";
const plan = (r) => r.out?.seller_autopilot_v2?.plan || null;

test("EN: S1 yes → S2 yes → S3 $240k (> MAO) → condition probe → ANCHOR at the lowest nearby as-is comp", async () => {
  const { db, results: [s1, s2, s3, s4] } = await runFlow({
    turns: [["Yes", "ownership_check"], ["Yes", "offer_interest"], ["$240,000", "asking_price"], ["It needs a new roof", "property_condition"]],
  });
  assert.deepEqual(sent(s1), ["consider_selling"]);
  assert.deepEqual(sent(s2), ["seller_asking_price"]);
  assert.deepEqual(sent(s3), ["price_high_condition_probe"]);
  assert.equal(plan(s3).price_branch, "ask_above_range");
  assert.deepEqual(sent(s4), ["as_is_comp_anchor"]);
  assert.match(body(s4), /as-is sales nearby are going for around \$150,000\. Would you consider/);
  assert.equal(plan(s4).monetary.amount, 150_000);
  assert.ok(plan(s4).monetary.amount <= plan(s4).monetary.ceiling, "never above MAO");
  // Logged with its evidence: the event and the queue row's decision snapshot.
  const ev = s4.events.find((e) => e.event_type === "SELLER_AUTOPILOT_V2_NUMBER_SENT");
  assert.ok(ev, "number-sent evidence event");
  assert.equal(ev.payload.amount, 150_000);
  assert.deepEqual(ev.payload.evidence.comp_ids, ["comp-1"]);
  assert.equal(ev.payload.evidence.offer_version.snapshot_id, "snap-prop-v2-1");
  assert.equal(s4.inserts[0].metadata.automation_decision_snapshot.seller_autopilot_v2.monetary.amount, 150_000);
  assert.equal(s4.inserts[0].template_id, "lc-ap2-acanc-en-1");
  // LOGGING MODEL: an ANCHOR row in negotiation_quotes — never the active formal offer.
  const quotes = db.tables.negotiation_quotes || [];
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].quote_type, "anchor");
  assert.equal(quotes[0].amount, 150_000);
  assert.equal(quotes[0].max_offer_at_quote, 170_000);
  assert.equal(quotes[0].rule_branch, "lowest_nearby_as_is_comp");
  assert.deepEqual(quotes[0].comp_ids, ["comp-1"]);
  assert.equal(quotes[0].language, "English");
  assert.equal(quotes[0].template_id, "lc-ap2-acanc-en-1");
  assert.equal(quotes[0].send_queue_key, s4.inserts[0].queue_key);
  assert.equal((db.tables.seller_offers || []).length, 0, "an anchor is not a formal offer");
});

test("EN: S3 price ≤ our offer → accept / confirm basics (no number sent)", async () => {
  const { db, results } = await runFlow({ turns: [["Yes", "ownership_check"], ["Sure", "offer_interest"], ["$145k", "asking_price"]] });
  const s3 = results[2];
  assert.deepEqual(sent(s3), ["price_works_confirm_basics"]);
  assert.equal(plan(s3).price_branch, "ask_at_or_below_offer");
  assert.doesNotMatch(body(s3), /\$/);
  const q = (db.tables.negotiation_quotes || []).find((r) => r.quote_type === "confirm_basics_no_number");
  assert.ok(q, "confirm-basics recorded");
  assert.equal(q.amount, null);
  assert.equal(q.asking_price, 145_000);
});

test("EN: no price → 'no worries, I'll run my numbers; condition?' → comps ABOVE max → engine-offer anchor with NO comp language", async () => {
  const { db, results } = await runFlow({
    ade: adeSnapshot({ comp_prices: [200_000, 210_000, 220_000, 230_000, 240_000], mao: 172_500, offer: 152_300 }),
    turns: [["Yes", "ownership_check"], ["Yes", "offer_interest"], ["I have no idea", "asking_price"], ["Its in good shape", "property_condition"]],
  });
  assert.deepEqual(sent(results[2]), ["no_price_condition_probe"]);
  assert.match(body(results[2]), /^No worries, I can run the numbers/);
  const s4 = results[3];
  assert.deepEqual(sent(s4), ["price_anchor_above_max"]);
  assert.equal(plan(s4).monetary.rule, "above_max");
  assert.equal(plan(s4).monetary.amount, 150_000, "the engine's offer 152,300, floored to $5K, never above MAO 172,500");
  assert.equal(body(s4), "Based on the property and the numbers, we'd need to be around $150,000 to make it work. Would you consider something in that range?");
  assert.doesNotMatch(body(s4), /sales|comps?|nearby/i);
  const quote = (db.tables.negotiation_quotes || [])[0];
  assert.equal(quote.rule_branch, "above_max");
  assert.equal(quote.quote_type, "anchor");
});

test("EN: 'send a bid' → condition → anchor uses the average of 3 when the lowest comp is an outlier", async () => {
  const { results } = await runFlow({
    ade: adeSnapshot({ comp_prices: [90_000, 160_000, 165_000, 170_000, 180_000] }),
    turns: [["Yes", "ownership_check"], ["Send a bid", "offer_interest"], ["fair", "property_condition"]],
  });
  assert.deepEqual(sent(results[1]), ["no_price_condition_probe"]);
  assert.equal(plan(results[2]).monetary.rule, "average_of_3_lowest_non_outlier_comps");
  assert.match(body(results[2]), /\$165,000/);
});

test("EN: capital gains → creative probe; conditional interest → price question", async () => {
  const cg = await runFlow({ turns: [["Yes", "ownership_check"], ["Almost certainly no. Little equity so 1031 not possible and capital gains would kill me", "offer_interest"]] });
  assert.deepEqual(sent(cg.results[1]), ["capital_gains_creative_probe"]);
  assert.match(body(cg.results[1]), /seller financing or a lease option/);
  const maybe = await runFlow({ turns: [["Yes", "ownership_check"], ["Maybe if it is a good offer", "offer_interest"]] });
  assert.deepEqual(sent(maybe.results[1]), ["seller_asking_price"]);
});

test("EN: why → who_is_this (resume S1) → yes → resumes the flow; who at S3 resumes the price question", async () => {
  const s1 = await runFlow({ turns: [["Why do you ask?", "ownership_check"], ["Yes", "ownership_check"]] });
  assert.deepEqual(sent(s1.results[0]), ["who_is_this_resume_ownership"]);
  assert.match(body(s1.results[0]), /Are you the owner\?$/);
  assert.deepEqual(sent(s1.results[1]), ["consider_selling"]);
  const s3 = await runFlow({ turns: [["Yes", "ownership_check"], ["Sure", "offer_interest"], ["Who is this?", "asking_price"], ["$160k", "asking_price"]] });
  assert.deepEqual(sent(s3.results[2]), ["who_is_this_resume_price"]);
  assert.deepEqual(sent(s3.results[3]), ["price_works_confirm_basics"]);
});

test("ES: the full flow answers in Spanish, including a condition reply the classifier labels English", async () => {
  const { results } = await runFlow({
    language: "Spanish",
    turns: [["Sí", "ownership_check"], ["Sí", "offer_interest"], ["$240,000", "asking_price"], ["Necesita techo nuevo", "property_condition"]],
  });
  assert.deepEqual(results.map(sent), [["consider_selling"], ["seller_asking_price"], ["price_high_condition_probe"], ["as_is_comp_anchor"]]);
  // send_queue.language is not populated by the insert path; the template snapshot carries it.
  for (const r of results) assert.equal(r.inserts[0].metadata.selected_template_snapshot.language, "Spanish", body(r));
  assert.match(body(results[3]), /^Gracias por confirmar\. Viendo los números, .*\$150,000/);
});

test("PT: sim → sim → price within range → confirm basics in Portuguese", async () => {
  const { results } = await runFlow({ language: "Portuguese", systemControl: { seller_autopilot_v2_languages: ALL_LANGUAGES }, turns: [["Sim", "ownership_check"], ["Sim", "offer_interest"], ["$160,000", "asking_price"]] });
  assert.deepEqual(results.map(sent), [["consider_selling"], ["seller_asking_price"], ["price_works_confirm_basics"]]);
  assert.equal(body(results[2]), "Parece estar em faixa. Está vazio ou ocupado?");
});

test("ZH: 是 → 是 → 24万 (local units) → condition → anchor in Mandarin", async () => {
  const { results } = await runFlow({ language: "Mandarin", systemControl: { seller_autopilot_v2_languages: ALL_LANGUAGES }, turns: [["是", "ownership_check"], ["是", "offer_interest"], ["24万", "asking_price"], ["需要维修", "property_condition"]] });
  assert.deepEqual(results.map(sent), [["consider_selling"], ["seller_asking_price"], ["price_high_condition_probe"], ["as_is_comp_anchor"]]);
  assert.equal(plan(results[2]).asking_price, 240_000);
  assert.match(body(results[3]), /^谢谢确认。.*\$150,000/);
});

test("FR: oui → oui → 'faites-moi une offre' → condition → anchor in French", async () => {
  const { results } = await runFlow({ language: "French", systemControl: { seller_autopilot_v2_languages: ALL_LANGUAGES }, turns: [["Oui", "ownership_check"], ["Oui", "offer_interest"], ["Faites-moi une offre", "asking_price"], ["Bon état", "property_condition"]] });
  assert.deepEqual(results.map(sent), [["consider_selling"], ["seller_asking_price"], ["no_price_condition_probe"], ["as_is_comp_anchor"]]);
  assert.match(body(results[3]), /^Merci de confirmer\./);
});

test("GUARD: multifamily → human review, nothing sent", async () => {
  const { results } = await runFlow({ summary: { property_type: "Duplex", unit_count: 2 }, turns: [["Yes", "ownership_check"], ["Yes", "offer_interest"], ["$240,000", "asking_price"]] });
  assert.equal(results[2].inserts.length, 0);
  assert.equal(plan(results[2]).action, "review");
  assert.equal(results[2].out.execution.automation_decision.should_mark_human_review, true);
  assert.equal(results[2].out.execution.audit_reason, "v2_hold_not_single_family");
});

test("GUARD: no authoritative offer → number-free condition probe, then human review instead of a number", async () => {
  const none = await runFlow({ ade: null, turns: [["Yes", "ownership_check"], ["Yes", "offer_interest"], ["$240,000", "asking_price"], ["Needs work", "property_condition"]] });
  assert.deepEqual(sent(none.results[2]), ["price_high_condition_probe"]);
  assert.doesNotMatch(body(none.results[2]), /\$/);
  assert.equal(none.results[3].inserts.length, 0);
  assert.equal(none.results[3].out.execution.audit_reason, "v2_hold_no_offer_engine_result");
  assert.equal(none.results[3].out.execution.automation_decision.should_mark_human_review, true);
  const lowTier = await runFlow({ ade: adeSnapshot({ tier: "CREATIVE_TERMS" }), turns: [["Yes", "ownership_check"], ["Yes", "offer_interest"], ["$240,000", "asking_price"], ["Needs work", "property_condition"]] });
  assert.equal(lowTier.results[3].inserts.length, 0);
  assert.match(lowTier.results[3].out.execution.audit_reason, /^v2_hold_offer_not_authoritative/);
  for (const r of lowTier.results) for (const i of r.inserts) assert.doesNotMatch(i.message_body, /\$\d/, "no number without authority");
});

test("GUARD: opt-out beats everything (suppressed, nothing sent); 'not interested' keeps the 30-day nurture", async () => {
  const stop = await runFlow({ turns: [["Yes", "ownership_check"], ["Yes send a bid. Actually stop texting me", "offer_interest"]] });
  assert.equal(stop.results[1].inserts.length, 0);
  assert.equal(stop.results[1].out.execution.automation_decision.should_suppress_contact, true);
  const ni = await runFlow({ turns: [["Yes", "ownership_check"], ["Not interested", "offer_interest"]] });
  assert.equal(ni.results[1].inserts.length, 0);
  assert.deepEqual(ni.results[1].followups, ["not_interested"]);
});

test("FLAG OFF: identical to today — no v2 output, no v2 templates, no anchor", async () => {
  const { results } = await runFlow({ flag: false, turns: [["Yes", "ownership_check"], ["Yes", "offer_interest"], ["$240,000", "asking_price"], ["It needs a new roof", "property_condition"]] });
  for (const r of results) {
    assert.equal(r.out.seller_autopilot_v2, undefined);
    for (const i of r.inserts) assert.doesNotMatch(String(i.template_id), /^lc-ap2-/);
  }
});

test("PER-LANGUAGE: Portuguese is not enabled by default → human review even with approved templates", async () => {
  const { results } = await runFlow({ language: "Portuguese", turns: [["Sim", "ownership_check"]] });
  assert.equal(results[0].inserts.length, 0);
  assert.equal(results[0].out.execution.audit_reason, "v2_language_not_enabled");
  assert.equal(results[0].out.execution.automation_decision.human_review_reason, "v2_language_not_enabled:Portuguese");
  const es = await runFlow({ language: "Spanish", turns: [["Sí", "ownership_check"]] });
  assert.deepEqual(sent(es.results[0]), ["consider_selling"], "EN/ES are on by default");
});

test("BARE NO to the ownership question → ONE clarifier (BARE_NO_AUTO_CLARIFIER on); next reply decides; never a second clarification", async () => {
  const off = await runFlow({ turns: [["No", "ownership_check"]] });
  assert.deepEqual(sent(off.results[0]), [], "round 10: flag OFF (default) -> no clarifier");
  await withBareNoClarifierOn(async () => {
  // Round 10 (owner 2026-10-08): a bare "No" carries no seller language
  // evidence (shared by English and Spanish) and our outbound language never
  // decides -> even with the flag on, the clarifier HOLDS (no send).
  const wrong = await runFlow({ turns: [["No", "ownership_check"], ["Wrong number", "ownership_check"]] });
  assert.deepEqual(sent(wrong.results[0]), [], "no language evidence: the clarifier holds");
  assert.equal(wrong.results[1].inserts.length, 0);
  assert.equal(wrong.results[1].out.execution.automation_decision.should_suppress_contact, true);
  assert.equal(wrong.results[1].out.execution.automation_decision.suppression_reason, "wrong_number");

  // (The identity answers to a SENT clarifier -- v2_identity_resolution -- are
  // unreachable while the clarifier holds for language; they need no send.)
  for (const msg of ["I manage it for the owner", "My wife owns it", "My LLC owns it"]) {
    const id = await runFlow({ turns: [["No", "ownership_check"], [msg, "ownership_check"]] });
    assert.equal(id.results[1].inserts.length, 0, msg);
  }

  const again = await runFlow({ turns: [["No", "ownership_check"], ["No", "ownership_check"]] });
  assert.equal(again.results[1].inserts.length, 0, "no second clarification");

  // Round 10: a Spanish thread does not make a bare "No" Spanish -- hold.
  const es = await runFlow({ language: "Spanish", turns: [["No", "ownership_check"]] });
  assert.deepEqual(sent(es.results[0]), []);
  });
});

test("DEFECT 4a: the legacy comp_anchor cannot send an unlogged number (flag on: logged as an anchor, blocked if the log fails)", async () => {
  process.env.SELLER_AUTOPILOT_V2 = "true";
  const { executeInboundAutomationDecision } = await import("@/lib/domain/seller-flow/apply-inbound-automation-decision.js");
  const db = memoryDb({ sms_templates: [tpl("lc-comp-anchor-en-1", "comp_anchor", "English", "Recent as-is sales nearby have come in under retail, so I'd be around {{offer_price}}. Worth a conversation?")] });
  const args = {
    message: "What would you pay?",
    threadKey: "+16125550199",
    inboundFrom: "+16125550199",
    inboundTo: "+16125550100",
    inboundEventId: "evt-comp-anchor",
    inboundReceivedAt: "2026-10-05T15:00:00.000Z",
    propertyId: "prop-v2-1",
    classification: { primary_intent: "asks_offer", confidence: 0.9, language: "English", automation_decision: { auto_reply_allowed: true, human_review_required: false } },
    strategyDirective: { strategy: "comp_anchor", reason_code: "x", template_use_case: "comp_anchor", allowed_template_use_cases: ["comp_anchor"], next_action: "send_message_now" },
    dealAuthority: { offer_authoritative: true, authorized_offer_amount: 140_000, authorized_offer_ceiling: 170_000, recommended_offer: 140_000 },
    enableQueueInsert: true,
    dryRun: false,
    autoReplyMode: "live_limited",
    supabaseClient: db.client,
    getSystemValue: async (k) => ({ auto_reply_mode: "live_limited", auto_reply_eligibility_cutoff_at: "2026-09-09T00:00:00.000Z", campaign_mode: "live_limited" })[k] ?? null,
  };
  const failed = await executeInboundAutomationDecision({ ...args, negotiationQuoteImpl: async () => ({ ok: false, reason: "negotiation_quote_write_failed:42P01" }) });
  assert.equal(failed.queued, false);
  assert.equal(failed.audit_reason, "negotiation_quote_log_failed");
  const ok = await executeInboundAutomationDecision(args);
  assert.equal(ok.queued, true);
  const q = db.tables.negotiation_quotes[0];
  assert.equal(q.quote_type, "anchor");
  assert.equal(q.rule_branch, "legacy_comp_anchor");
  assert.equal(q.amount, 140_000);
});
