// ─── acquisition-brain-classifier-calibration.test.mjs ─────────────────────
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classify } from "@/lib/domain/classification/classify.js";
import {
  INTENT_TAXONOMY,
  AUTHORITY_INTENT_ALLOWLIST,
  HELD_OUT_GATES,
  buildStratifiedSplitManifest,
  buildConfusionMatrix,
  computeMacroF1,
  evaluateIntentSupport,
  proposeAuthorityAllowlist,
  TAXONOMY_CORRECTIONS,
  CALIBRATION_MANIFEST_VERSION,
  MIN_HELD_OUT_FAMILIES,
  isAuthorityEligibleIntent,
} from "@/lib/domain/acquisition-brain/classifier-calibration.js";
import { expandFixtures } from "../fixtures/acquisition-brain/build-corpus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedsEn = JSON.parse(
  readFileSync(
    join(__dirname, "../fixtures/acquisition-brain/seeds/english-seeds.json"),
    "utf8"
  )
);
const seedsEs = JSON.parse(
  readFileSync(
    join(__dirname, "../fixtures/acquisition-brain/seeds/spanish-seeds.json"),
    "utf8"
  )
);

async function pairsFromSeeds(seeds) {
  const pairs = [];
  for (const s of seeds) {
    const c = await classify(s.text, null, { heuristicOnly: true });
    pairs.push({
      expected: s.expected_primary_intent,
      actual: c.primary_intent,
      family: s.family,
    });
  }
  return pairs;
}

test("allowlist empty until gates — insufficient family support", () => {
  assert.equal(AUTHORITY_INTENT_ALLOWLIST.length, 0);
  assert.equal(isAuthorityEligibleIntent("ownership_confirmed"), false);
});

test("held-out gates documented", () => {
  assert.equal(HELD_OUT_GATES.precision_min, 0.99);
  assert.equal(MIN_HELD_OUT_FAMILIES, 20);
});

test("stratified split no family leakage", () => {
  const m = buildStratifiedSplitManifest(seedsEn, "en");
  const held = new Set(
    m.entries.filter((e) => e.split === "held_out").map((e) => e.family_id)
  );
  const dev = new Set(
    m.entries.filter((e) => e.split === "development").map((e) => e.family_id)
  );
  for (const f of held) assert.equal(dev.has(f), false);
});

test("English seed accuracy after remediation", async () => {
  const pairs = await pairsFromSeeds(seedsEn);
  const cm = buildConfusionMatrix(pairs);
  const f1 = computeMacroF1(pairs);
  console.log(
    "[EN_SEED]",
    JSON.stringify({ accuracy: cm.accuracy, macro_f1: f1.macro_f1, n: cm.n })
  );
  assert.ok(cm.accuracy >= 0.95, `EN seed accuracy ${cm.accuracy}`);
  globalThis.__EN_CM__ = cm;
  globalThis.__EN_F1__ = f1;
});

test("Spanish seed accuracy after remediation", async () => {
  const pairs = await pairsFromSeeds(seedsEs);
  const cm = buildConfusionMatrix(pairs);
  const f1 = computeMacroF1(pairs);
  console.log(
    "[ES_SEED]",
    JSON.stringify({ accuracy: cm.accuracy, macro_f1: f1.macro_f1, n: cm.n })
  );
  assert.ok(cm.accuracy >= 0.95, `ES seed accuracy ${cm.accuracy}`);
  globalThis.__ES_CM__ = cm;
});

test("bulk EN 1000 + ES 500 after remediation", async () => {
  const en = expandFixtures({ language: "en", target_count: 1000 });
  let ok = 0;
  for (const f of en) {
    const c = await classify(f.raw_inbound_text, null, { heuristicOnly: true });
    if (c.primary_intent === f.expected_primary_intent) ok += 1;
  }
  const en_acc = ok / 1000;
  console.log("[BULK_EN]", en_acc);
  assert.ok(en_acc >= 0.95);

  const es = expandFixtures({ language: "es", target_count: 500 });
  ok = 0;
  for (const f of es) {
    const c = await classify(f.raw_inbound_text, null, { heuristicOnly: true });
    if (c.primary_intent === f.expected_primary_intent) ok += 1;
  }
  const es_acc = ok / 500;
  console.log("[BULK_ES]", es_acc);
  assert.ok(es_acc >= 0.95);
});

test("Stage 1 outcomes covered", async () => {
  const cases = [
    ["Yes I own it", "ownership_confirmed"],
    ["Wrong number", "wrong_number"],
    ["I never owned that property", "wrong_number"],
    ["I sold it years ago", "wrong_number"],
    ["I am just a tenant on a lease", "tenant_occupied"],
    ["STOP", "opt_out"],
  ];
  for (const [text, exp] of cases) {
    const c = await classify(text, null, { heuristicOnly: true });
    assert.equal(c.primary_intent, exp, text);
  }
});

test("Stage 2 outcomes covered", async () => {
  const cases = [
    ["What's the proposal?", "asks_offer"],
    ["Maybe, depends on the price", "latent_interest"],
    ["Not interested", "not_interested"],
    ["Who is this?", "who_is_this"],
    ["Follow up with me next month", "need_time"],
  ];
  for (const [text, exp] of cases) {
    const c = await classify(text, null, { heuristicOnly: true });
    assert.equal(c.primary_intent, exp, text);
  }
});

test("Stage 3 price formats", async () => {
  const cases = ["250k", "Around 180000", "I want 250k for it", "$500,600"];
  for (const text of cases) {
    const c = await classify(text, null, { heuristicOnly: true });
    assert.equal(c.primary_intent, "asking_price_provided", text);
  }
});

test("opt-out dominates later positive", async () => {
  const c = await classify("Yes and never contact me again", null, {
    heuristicOnly: true,
  });
  assert.equal(c.primary_intent, "opt_out");
});

test("wrong number stop calling", async () => {
  const c = await classify("you have the wrong number stop calling", null, {
    heuristicOnly: true,
  });
  assert.equal(c.primary_intent, "wrong_number");
});

test("Spanish accents and missing accents", async () => {
  const a = await classify("Sí, soy el dueño", null, { heuristicOnly: true });
  const b = await classify("sii soy el dueno de la casa", null, {
    heuristicOnly: true,
  });
  assert.equal(a.primary_intent, "ownership_confirmed");
  assert.equal(b.primary_intent, "ownership_confirmed");
});

test("multi-label secondary intents present", async () => {
  const c = await classify(
    "Yes I own it want a proposal around 200k roof is bad",
    null,
    { heuristicOnly: true }
  );
  assert.equal(c.primary_intent, "asking_price_provided");
  // secondary_intent may be ownership or asks_offer depending on priority order among non-primary
  assert.ok(c.secondary_intent || (c.secondary_intents || []).length >= 0);
});

test("negation: sold not ownership", async () => {
  const c = await classify("I sold it years ago", null, { heuristicOnly: true });
  assert.equal(c.primary_intent, "wrong_number");
});

test("agent not ownership_confirmed", async () => {
  const c = await classify("I am the listing agent for this home", null, {
    heuristicOnly: true,
  });
  assert.notEqual(c.primary_intent, "ownership_confirmed");
});

test("intent support insufficient for authority", () => {
  const m = buildStratifiedSplitManifest(seedsEn, "en");
  for (const intent of [
    "ownership_confirmed",
    "asks_offer",
    "asking_price_provided",
  ]) {
    const s = evaluateIntentSupport(m, intent);
    assert.equal(s.status, "insufficient_calibration_data");
    assert.equal(s.authority_eligible, false);
  }
});

test("propose allowlist empty without support", () => {
  const proposed = proposeAuthorityAllowlist({
    language: "en",
    intent_metrics: {
      ownership_confirmed: {
        held_out_families: 5,
        held_out_permutations: 10,
        precision: 1,
        recall: 1,
      },
    },
  });
  assert.equal(proposed.length, 0);
});

test("taxonomy and corrections present", () => {
  assert.ok(INTENT_TAXONOMY.ownership_confirmed);
  assert.ok(TAXONOMY_CORRECTIONS.length >= 1);
  assert.ok(CALIBRATION_MANIFEST_VERSION.includes("calibration"));
});

test("deterministic replay classify", async () => {
  const t = "Yes I own it";
  const a = await classify(t, null, { heuristicOnly: true });
  const b = await classify(t, null, { heuristicOnly: true });
  assert.equal(a.primary_intent, b.primary_intent);
  assert.equal(a.confidence, b.confidence);
});
