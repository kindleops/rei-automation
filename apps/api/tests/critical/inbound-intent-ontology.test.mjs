// ─── inbound-intent-ontology.test.mjs ────────────────────────────────────────
// Critical suite for the canonical seller-inbound intent ontology registry.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  ONTOLOGY_VERSION,
  INBOUND_INTENT_ONTOLOGY,
  TERMINAL_DISPOSITION_HINTS,
  normalizeToCanonicalIntent,
  getIntentDefinition,
  listIntentsWithoutClassifierCoverage,
} from "@/lib/domain/classification/inbound-intent-ontology.js";
// The classifier's REAL exported output vocabulary — the same export the
// ontology validates against at load time. Never re-mirror this list by hand.
import { INTENT_PRIORITY as CLASSIFY_INTENT_PRIORITY } from "@/lib/domain/classification/classify.js";

const REQUIRED_SLUGS = [
  "owner_confirmation", "wrong_number", "not_owner", "former_owner",
  "sold_property", "family_member", "tenant", "property_manager",
  "partner_co_owner", "agent_represents_owner", "business_office",
  "spam_unrelated", "unclear_identity", "interested",
  "conditionally_interested", "requests_offer", "asks_price",
  "gives_asking_price", "not_interested", "follow_up_later",
  "already_listed", "agent_involved", "trust_concern",
  "family_approval_needed", "hostile", "re_engagement", "changed_mind",
  "asks_buyer_still_interested", "requests_call", "requests_email",
  "asks_who_we_are", "asks_how_number_obtained", "asks_which_property",
  "multiple_properties", "property_correction", "price_negotiation",
  "timeline_negotiation", "condition_disclosure", "occupancy_disclosure",
  "tenant_issue", "probate_estate", "trust_ownership", "llc_corporation",
  "authority_question", "title_issue", "lien_tax_issue",
  "foreclosure_urgency", "contract_request", "contract_question",
  "contract_declined", "awaiting_spouse_cosigner",
  "awaiting_executor_trustee", "referral_new_decision_maker",
  "language_switch", "ambiguous_question", "compound_intent", "sarcasm",
  "typo_heavy", "single_word_response", "emoji_only",
  "voicemail_call_request", "retraction_correction",
  "duplicate_replayed_webhook", "delayed_old_campaign_reply",
  "seller_initiated_after_stop", "opt_out", "who_is_this", "need_time",
  "tenant_occupied", "condition_disclosed", "info_request", "reaction_only",
  "acknowledgement", "unclear",
];

test("ontology version is pinned", () => {
  assert.equal(ONTOLOGY_VERSION, "inbound_intent_ontology_v1");
});

test("(a) every required canonical slug exists with a complete entry shape", () => {
  for (const slug of REQUIRED_SLUGS) {
    const def = INBOUND_INTENT_ONTOLOGY[slug];
    assert.ok(def, `missing ontology entry: ${slug}`);
    assert.equal(def.intent, slug);
    assert.equal(typeof def.category, "string");
    assert.equal(typeof def.description, "string");
    assert.ok(def.description.length > 0, `${slug} description empty`);
    assert.equal(typeof def.reply_policy.reply_required, "boolean");
    assert.equal(typeof def.reply_policy.reply_permitted, "boolean");
    assert.equal(typeof def.reply_policy.escalate_to_human, "boolean");
    assert.equal(typeof def.reply_policy.objective, "string");
    assert.ok(Array.isArray(def.classifier_aliases), `${slug} aliases not array`);
    assert.equal(typeof def.compliance.legally_binding_opt_out, "boolean");
    assert.equal(typeof def.compliance.blocks_all_future_contact, "boolean");
    assert.ok(
      ["continue", "pause", "stop"].includes(def.state_hints.automation),
      `${slug} bad automation mode`
    );
  }
});

test("(b) no classifier alias maps to two entries", () => {
  const seen = new Map();
  for (const def of Object.values(INBOUND_INTENT_ONTOLOGY)) {
    for (const alias of def.classifier_aliases) {
      const key = alias.trim().toLowerCase();
      assert.ok(
        !seen.has(key),
        `alias "${key}" appears on both ${seen.get(key)} and ${def.intent}`
      );
      seen.set(key, def.intent);
    }
  }
});

test("(c) every live INTENT_PRIORITY label exported by classify.js maps to exactly one canonical slug", () => {
  assert.ok(
    Array.isArray(CLASSIFY_INTENT_PRIORITY) && CLASSIFY_INTENT_PRIORITY.length >= 19,
    "classify.js must export its real output vocabulary"
  );
  assert.ok(CLASSIFY_INTENT_PRIORITY.includes("unclear"), "vocabulary must include unclear");
  const aliasOwner = new Map();
  for (const def of Object.values(INBOUND_INTENT_ONTOLOGY)) {
    for (const alias of def.classifier_aliases) {
      aliasOwner.set(alias.trim().toLowerCase(), def.intent);
    }
  }
  for (const label of CLASSIFY_INTENT_PRIORITY) {
    assert.ok(
      aliasOwner.has(label),
      `live classifier label "${label}" is not registered in any entry's classifier_aliases`
    );
    const slug = normalizeToCanonicalIntent(label);
    assert.ok(INBOUND_INTENT_ONTOLOGY[slug], `label "${label}" normalized to unknown slug ${slug}`);
    assert.equal(slug, aliasOwner.get(label), `normalize(${label}) disagrees with alias registration`);
  }
});

test("(d) not_interested is non-binding; opt_out is a legally binding block", () => {
  const notInterested = INBOUND_INTENT_ONTOLOGY.not_interested;
  assert.equal(notInterested.compliance.legally_binding_opt_out, false);
  assert.equal(notInterested.compliance.blocks_all_future_contact, false);
  assert.equal(notInterested.state_hints.automation, "pause");
  assert.equal(notInterested.state_hints.disposition, "not_interested");

  const optOut = INBOUND_INTENT_ONTOLOGY.opt_out;
  assert.equal(optOut.compliance.legally_binding_opt_out, true);
  assert.equal(optOut.compliance.blocks_all_future_contact, true);
  assert.equal(optOut.terminal_hint, "suppressed_opt_out");
  assert.equal(optOut.state_hints.automation, "stop");

  // wrong_number blocks the phone, not the lead entity.
  const wrongNumber = INBOUND_INTENT_ONTOLOGY.wrong_number;
  assert.equal(wrongNumber.terminal_hint, "suppressed_wrong_number");
  assert.equal(wrongNumber.compliance.legally_binding_opt_out, false);
  assert.equal(wrongNumber.compliance.blocks_all_future_contact, false);
});

test("(e) re-engagement intents supersede stale not-interested state", () => {
  for (const slug of ["re_engagement", "changed_mind", "asks_buyer_still_interested"]) {
    const def = INBOUND_INTENT_ONTOLOGY[slug];
    assert.equal(def.state_hints.automation, "continue", `${slug} must continue automation`);
    assert.equal(def.reply_policy.reply_required, true, `${slug} must require a reply`);
    assert.ok(["warm", "hot"].includes(def.state_hints.lead_temperature), `${slug} must be warm/hot`);
    assert.equal(def.state_hints.disposition, "interested", `${slug} disposition must be interested`);
  }
  // seller_initiated_after_stop supersedes not-interested but can never clear
  // a legally binding opt-out on its own — human re-consent is required.
  const afterStop = INBOUND_INTENT_ONTOLOGY.seller_initiated_after_stop;
  assert.equal(afterStop.state_hints.automation, "continue");
  assert.equal(afterStop.reply_policy.reply_required, true);
  assert.equal(afterStop.reply_policy.escalate_to_human, true);
  assert.equal(afterStop.compliance.legally_binding_opt_out, false);
  assert.match(afterStop.description, /opt.out/i);
});

test("(f) every terminal_hint is one of the 10 canonical terminal dispositions", () => {
  const allowed = new Set(TERMINAL_DISPOSITION_HINTS);
  assert.equal(allowed.size, 10);
  for (const def of Object.values(INBOUND_INTENT_ONTOLOGY)) {
    assert.ok(
      allowed.has(def.terminal_hint),
      `${def.intent} has non-canonical terminal_hint ${def.terminal_hint}`
    );
  }
});

test("(g) normalizeToCanonicalIntent folds known aliases and defaults unknown to unclear", () => {
  // Folds mirrored from canonical-intent-aliases.js.
  assert.equal(normalizeToCanonicalIntent("wrong_person"), "wrong_number");
  assert.equal(normalizeToCanonicalIntent("stop"), "opt_out");
  assert.equal(normalizeToCanonicalIntent("unsubscribe"), "opt_out");
  assert.equal(normalizeToCanonicalIntent("seller_interested"), "interested");
  assert.equal(normalizeToCanonicalIntent("asking_price_provided"), "gives_asking_price");
  assert.equal(normalizeToCanonicalIntent("asking_price_value"), "gives_asking_price");
  assert.equal(normalizeToCanonicalIntent("hostile_or_legal"), "hostile");
  assert.equal(normalizeToCanonicalIntent("callback_requested"), "requests_call");
  assert.equal(normalizeToCanonicalIntent("ownership_confirmed"), "owner_confirmation");
  // Free-text fold + case/whitespace tolerance.
  assert.equal(normalizeToCanonicalIntent("  Wrong Person! "), "wrong_number");
  assert.equal(normalizeToCanonicalIntent("STOP"), "opt_out");
  // Canonical slugs pass through.
  assert.equal(normalizeToCanonicalIntent("probate_estate"), "probate_estate");
  // Unknown / empty collapse to unclear.
  assert.equal(normalizeToCanonicalIntent("totally_unknown_label_xyz"), "unclear");
  assert.equal(normalizeToCanonicalIntent(null), "unclear");
  assert.equal(normalizeToCanonicalIntent(""), "unclear");
});

test("getIntentDefinition falls back to unclear and resolves aliases", () => {
  assert.equal(getIntentDefinition("wrong_person").intent, "wrong_number");
  assert.equal(getIntentDefinition("no_such_intent").intent, "unclear");
  assert.equal(getIntentDefinition(undefined).intent, "unclear");
});

test("listIntentsWithoutClassifierCoverage reports exactly the entries with empty aliases", () => {
  const gaps = listIntentsWithoutClassifierCoverage();
  for (const slug of gaps) {
    assert.equal(INBOUND_INTENT_ONTOLOGY[slug].classifier_aliases.length, 0);
  }
  for (const def of Object.values(INBOUND_INTENT_ONTOLOGY)) {
    if (def.classifier_aliases.length === 0) {
      assert.ok(gaps.includes(def.intent), `${def.intent} missing from gap list`);
    }
  }
  // Known-covered intents must never appear as gaps.
  for (const covered of ["opt_out", "wrong_number", "interested", "gives_asking_price"]) {
    assert.ok(!gaps.includes(covered), `${covered} incorrectly reported as a gap`);
  }
});
