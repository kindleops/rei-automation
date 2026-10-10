/**
 * OWNER P0 2026-10-10 -- inbox + pipeline hygiene.
 *
 *   "I don't need bullshit in New Replies, Needs Review or Priority. We have all
 *    the data on the property. We should know what's a deal and what isn't ...
 *    A seller asking $3M on a $174K property should never be in Priority."
 *
 * Covers: the deal-economics verdict (lanes, bands, value authority), the
 * Priority gate, the writer (absurd ask -> Price gap nurture, never Priority),
 * the JS mirror (in_price_gap, no HOT), classify end-to-end, the PROPOSED view
 * gate and the PROPOSED cleanup SQL invariants (no suppression, read-only dry run).
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assessDealEconomics,
  resolveAssetLane,
  resolveReferenceValue,
  DEAL_ECONOMICS_VERDICTS as V,
} from "@/lib/domain/inbox/deal-economics-gate.js";
import {
  resolvePriorityGate,
  isPriceGapRow,
  resolveCanonicalLeadHeat,
} from "@/lib/domain/inbox/reply-actionability.js";
import { resolveInboxBucketFromClassification } from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";
import { resolveInboxBucketFlags } from "@/lib/domain/inbox/inbox-bucket-predicates.js";
import { classify } from "@/lib/domain/classification/classify.js";

const PAS = (mid, conf = 70, comps = 8) => ({ valuation_mid: mid, valuation_confidence: conf, comp_count: comps });
const NOW = Date.parse("2026-10-10T12:00:00Z");
const inbound = { direction: "inbound" };

// ── 1. The verdict ──────────────────────────────────────────────────────────

test("economics: $3M on a $174K house is price_far_above_value (credible PAS and AVM-only alike)", () => {
  assert.equal(assessDealEconomics({ ask: 3_000_000, valuation: PAS(174_000) }).verdict, V.FAR_ABOVE);
  assert.equal(assessDealEconomics({ ask: 3_000_000, property: { estimated_value: 174_000 } }).verdict, V.FAR_ABOVE);
});

test("economics: bands per lane -- credible, stretch, far above (2x credible / 2.5x AVM-only), too low", () => {
  const sfr = (ask, valuation = PAS(200_000), property = null) => assessDealEconomics({ ask, valuation, property }).verdict;
  assert.equal(sfr(240_000), V.CREDIBLE); // 1.2x
  assert.equal(sfr(250_000), V.CREDIBLE); // 1.25x edge
  assert.equal(sfr(300_000), V.STRETCH); // 1.5x
  assert.equal(sfr(400_000), V.STRETCH); // 2.0x edge (not "more than 2x")
  assert.equal(sfr(410_000), V.FAR_ABOVE); // >2x a credible value
  // AVM only = low confidence: the band widens to the classifier's own 2.5x
  assert.equal(sfr(450_000, null, { estimated_value: 200_000 }), V.STRETCH);
  assert.equal(sfr(510_000, null, { estimated_value: 200_000 }), V.FAR_ABOVE);
  // thin PAS (conf < 50 or < 3 comps) is low confidence too
  assert.equal(sfr(450_000, PAS(200_000, 40, 8)), V.STRETCH);
  assert.equal(sfr(450_000, PAS(200_000, 70, 2)), V.STRETCH);
  // a rent, a typo, "$1"
  assert.equal(sfr(1_500), V.IMPLAUSIBLY_LOW);
  assert.equal(sfr(20_000), V.IMPLAUSIBLY_LOW);
  // MF 5+ per lane: 1.35x credible
  assert.equal(assessDealEconomics({ ask: 1_300_000, valuation: PAS(1_000_000), property: { units_count: 11 } }).lane, "mf_5_plus");
  assert.equal(assessDealEconomics({ ask: 1_300_000, valuation: PAS(1_000_000), property: { units_count: 11 } }).verdict, V.CREDIBLE);
  assert.equal(resolveAssetLane({ property_type: "Multi-Family", units: 2 }), "mf_2_4");
  assert.equal(resolveAssetLane({ property_type: "Vacant Land" }), "land_other");
  assert.equal(resolveAssetLane({ property_type: "Single Family", units: 1 }), "sfr");
});

test("economics: more than 1.5x ARV is far above in any lane", () => {
  const r = assessDealEconomics({ ask: 320_000, valuation: PAS(180_000), property: { arv_estimate: 200_000 } });
  assert.equal(r.verdict, V.FAR_ABOVE);
  assert.equal(r.rule, "above_1_5x_arv");
});

test("economics: unknown is unknown -- no ask, or no reference value, is never a deal by default", () => {
  assert.equal(assessDealEconomics({ ask: null, valuation: PAS(200_000) }).verdict, V.UNKNOWN);
  assert.equal(assessDealEconomics({ ask: 250_000 }).verdict, V.UNKNOWN);
  assert.equal(assessDealEconomics({ ask: 250_000 }).rule, "no_reference_value");
});

test("economics: PAS is canonical, but a contaminated PAS (>3x off the AVM) yields to the AVM", () => {
  // prod 10-10: valuation_mid $332M on a ~$300K house
  const bad = resolveReferenceValue({ valuation: PAS(332_498_300, 30, 1), property: { estimated_value: 300_000 } });
  assert.equal(bad.source, "properties_avm");
  assert.equal(bad.conflict, "pas_avm_conflict");
  assert.equal(assessDealEconomics({ ask: 425_000, valuation: PAS(332_498_300, 30, 1), property: { estimated_value: 300_000 } }).verdict, V.STRETCH);
  // a credible PAS far from the AVM keeps its value but loses "credible"
  const odd = resolveReferenceValue({ valuation: PAS(1_000_000), property: { estimated_value: 200_000 } });
  assert.equal(odd.source, "property_acquisition_scores");
  assert.equal(odd.confidence, "low");
  const good = resolveReferenceValue({ valuation: PAS(210_000), property: { estimated_value: 200_000 } });
  assert.equal(good.confidence, "credible");
});

// ── 2. The Priority gate ────────────────────────────────────────────────────

test("priority gate: an ask needs the credible band; interest needs good identity", () => {
  const thread = { property_id: "p1", disposition: null };
  assert.equal(resolvePriorityGate({ intent: "asking_price_provided", economics: { verdict: V.CREDIBLE }, thread }).bucket, "priority");
  assert.equal(resolvePriorityGate({ intent: "asking_price_provided", economics: { verdict: V.STRETCH }, thread }).bucket, "new_replies");
  assert.equal(resolvePriorityGate({ intent: "asking_price_provided", economics: { verdict: V.UNKNOWN }, thread }).bucket, "new_replies");
  assert.equal(resolvePriorityGate({ intent: "asking_price_provided", economics: null, thread }).bucket, "new_replies");
  assert.equal(resolvePriorityGate({ intent: "asking_price_provided", economics: { verdict: V.FAR_ABOVE }, thread }).bucket, "follow_up");
  assert.equal(resolvePriorityGate({ intent: "asking_price_implausible", economics: null, thread }).bucket, "follow_up");
  assert.equal(resolvePriorityGate({ intent: "asks_offer", thread }).bucket, "priority");
  assert.equal(resolvePriorityGate({ intent: "asks_offer", thread: { disposition: "wrong_person", property_id: "p1" } }).bucket, "new_replies");
  assert.equal(resolvePriorityGate({ intent: "seller_interested", thread: { disposition: null, inbox_bucket: "cold" } }).reason, "identity_unlinked_property");
  // "2 million" ... then "so what's your offer?" is still the same price gap
  assert.equal(resolvePriorityGate({ intent: "asks_offer", thread: { ...thread, last_intent: "asking_price_implausible" } }).bucket, "new_replies");
  assert.equal(resolvePriorityGate({ intent: "unclear", thread }).bucket, null);
});

// ── 3. The writer: an absurd ask never reaches Priority ─────────────────────

test("writer: an absurd ask is the Price gap nurture (follow_up) -- never Priority, never New Replies", () => {
  const w = (classification, existing = { property_id: "p1" }) => resolveInboxBucketFromClassification(classification, inbound, existing, NOW);
  assert.equal(w({ primary_intent: "asking_price_implausible" }), "follow_up");
  assert.equal(w({ primary_intent: "asking_price_provided", price_parse: { value: 3e6, deal_economics: { verdict: V.FAR_ABOVE } } }), "follow_up");
  assert.equal(w({ primary_intent: "asking_price_provided", price_parse: { value: 180_000, deal_economics: { verdict: V.CREDIBLE } } }), "priority");
  assert.equal(w({ primary_intent: "asking_price_provided", price_parse: { value: 300_000, deal_economics: { verdict: V.STRETCH } } }), "new_replies");
  // a priority-grade objection with a non-priority intent keeps its route
  assert.equal(w({ primary_intent: "unclear", objection: "send_offer_first" }), "priority");
});

test("classify: a far-above ask is read as asking_price_implausible with the verdict on price_parse", async () => {
  const ctx = (pv) => ({ heuristicOnly: true, conversation_context: { property_valuation: pv } });
  const big = await classify("3 million", null, ctx({ estimated_value: 174_000 }));
  assert.equal(big.primary_intent, "asking_price_implausible");
  assert.equal(big.price_parse.deal_economics.verdict, V.FAR_ABOVE);
  // 2.3x a CREDIBLE PAS value: the classifier's own 2.5x AVM rule would pass it;
  // the economics gate does not.
  const pas = await classify("$400,000", null, ctx({ estimated_value: 174_000, acquisition_score: PAS(174_000) }));
  assert.equal(pas.primary_intent, "asking_price_implausible");
  assert.equal(pas.price_parse.implausibility.rule, "price_far_above_value");
  const ok = await classify("$180k", null, ctx({ estimated_value: 174_000, acquisition_score: PAS(174_000) }));
  assert.equal(ok.primary_intent, "asking_price_provided");
  assert.equal(ok.price_parse.deal_economics.verdict, V.CREDIBLE);
  assert.equal(resolveInboxBucketFromClassification(ok, inbound, { property_id: "p1" }, NOW), "priority");
  assert.equal(resolveInboxBucketFromClassification(big, inbound, { property_id: "p1" }, NOW), "follow_up");
});

// ── 4. The reader (JS mirror of the view) ───────────────────────────────────

const row = (extra = {}) => ({
  id: "t1", thread_key: "+15555550100", property_id: "p1", latest_direction: "inbound",
  last_inbound_at: "2026-10-10T11:00:00Z", last_outbound_at: "2026-10-10T10:00:00Z",
  is_archived: false, is_suppressed: false, ...extra,
});

test("reader: a stored priority carrying the far-above fact is the Price gap, not Priority, not New Replies, not HOT", () => {
  const legacy = row({ inbox_bucket: "priority", last_intent: "asking_price_provided", reason_codes: ["price_far_above_value"], lead_temperature: "hot", is_hot_lead: true });
  const f = resolveInboxBucketFlags(legacy, NOW);
  assert.equal(f.in_priority, false);
  assert.equal(f.in_new_replies, false);
  assert.equal(f.in_price_gap, true);
  assert.equal(isPriceGapRow(legacy), true);
  assert.equal(resolveCanonicalLeadHeat(legacy).is_hot_lead, false);
  const nurture = resolveInboxBucketFlags(row({ inbox_bucket: "follow_up", last_intent: "asking_price_implausible" }), NOW);
  assert.equal(nurture.in_follow_up, true);
  assert.equal(nurture.in_price_gap, true);
  assert.equal(nurture.in_priority, false);
  // a later real reply is judged on its own (the tag alone does not bury it)
  const later = row({ inbox_bucket: "new_replies", last_intent: "condition_disclosed", reason_codes: ["price_far_above_value"] });
  assert.equal(isPriceGapRow(later), false);
  assert.equal(resolveInboxBucketFlags(later, NOW).in_new_replies, true);
  // a credible-band priority is untouched
  assert.equal(resolveInboxBucketFlags(row({ inbox_bucket: "priority", last_intent: "asking_price_provided" }), NOW).in_priority, true);
});

// ── 5. The PROPOSED view and cleanup SQL ────────────────────────────────────

const sql = (name) => readFileSync(new URL(`../../../../supabase/migrations/${name}`, import.meta.url), "utf8");

test("PROPOSED view: the price gap gates Priority, New Replies, Unclear and HOT, and is its own counted lane", () => {
  const v = sql("PROPOSED_20261010120000_inbox_price_gap_gate.sql");
  assert.match(v, /as f_price_gap/);
  assert.match(v, /and not i\.f_price_gap as p_priority/);
  assert.equal((v.match(/and not j\.f_price_gap\n/g) || []).length >= 3, true, "new replies + unclear + hot");
  assert.match(v, /as in_price_gap\nfrom k;/);
  assert.match(v, /AS price_gap\n   FROM v_inbox_thread_state_buckets/);
  // the literal must match the JS constant
  assert.match(v, /'price_far_above_value'/);
  assert.match(v, /f_thread_intent = 'asking_price_implausible'/);
  const rb = sql("PROPOSED_20261010120000_inbox_price_gap_gate_rollback.sql");
  assert.match(rb, /false as f_price_gap,\n    false as in_price_gap/);
});

test("PROPOSED cleanup: never suppresses, never touches sends or message_events; the dry run only reads; it ends in ROLLBACK", () => {
  const apply = sql("PROPOSED_20261010130000_inbox_pipeline_hygiene_cleanup.sql");
  const body = apply.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(body, /is_suppressed\s*=/);
  assert.doesNotMatch(body, /sms_suppression_list|send_queue/);
  assert.doesNotMatch(body, /UPDATE\s+message_events/i);
  assert.match(body, /archive_scope = 'quiet_hostility'/);
  assert.match(body, /disposition = 'not_interested'/);
  assert.match(body, /_hyg20261010_inbox_backup/);
  assert.match(body, /_hyg20261010_opp_backup/);
  assert.match(body.trim(), /ROLLBACK; -- change to COMMIT after review$/);
  const dry = sql("PROPOSED_20261010130000_inbox_pipeline_hygiene_cleanup_dryrun.sql")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(dry, /\b(UPDATE|INSERT|DELETE|CREATE|ALTER|DROP)\b/i);
  const rb = sql("PROPOSED_20261010130000_inbox_pipeline_hygiene_cleanup_rollback.sql");
  assert.match(rb, /FROM public\._hyg20261010_inbox_backup/);
});
