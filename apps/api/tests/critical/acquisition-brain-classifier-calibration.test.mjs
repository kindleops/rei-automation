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
  splitSeedFamily,
  buildConfusionMatrix,
  TAXONOMY_CORRECTIONS,
  CALIBRATION_MANIFEST_VERSION,
  isAuthorityEligibleIntent,
} from "@/lib/domain/acquisition-brain/classifier-calibration.js";

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

test("allowlist empty by default", () => {
  assert.equal(AUTHORITY_INTENT_ALLOWLIST.length, 0);
  assert.equal(isAuthorityEligibleIntent("ownership_confirmed"), false);
});

test("held-out gates documented", () => {
  assert.equal(HELD_OUT_GATES.precision_min, 0.99);
  assert.equal(HELD_OUT_GATES.opt_out_confusion, 0);
});

test("family-level deterministic split", () => {
  const a = splitSeedFamily("own_yes", "en");
  const b = splitSeedFamily("own_yes", "en");
  assert.deepEqual(a, b);
  assert.ok(["held_out", "development"].includes(a.split));
});

test("English confusion matrix from seed texts via classify", async () => {
  const pairs = [];
  for (const s of seedsEn) {
    const c = await classify(s.text, null, { heuristicOnly: true });
    pairs.push({ expected: s.expected_primary_intent, actual: c.primary_intent });
  }
  const cm = buildConfusionMatrix(pairs);
  assert.equal(cm.n, seedsEn.length);
  assert.ok(typeof cm.accuracy === "number");
  // Publish original matrix for PR report
  globalThis.__CLF_CM_EN__ = cm;
  console.log("[CLASSIFIER_CM_EN]", JSON.stringify({ accuracy: cm.accuracy, n: cm.n }));
});

test("Spanish confusion matrix from seed texts", async () => {
  const pairs = [];
  for (const s of seedsEs) {
    const c = await classify(s.text, null, { heuristicOnly: true });
    pairs.push({ expected: s.expected_primary_intent, actual: c.primary_intent });
  }
  const cm = buildConfusionMatrix(pairs);
  globalThis.__CLF_CM_ES__ = cm;
  console.log("[CLASSIFIER_CM_ES]", JSON.stringify({ accuracy: cm.accuracy, n: cm.n }));
  assert.equal(cm.n, seedsEs.length);
});

test("taxonomy maps known intents", () => {
  assert.equal(INTENT_TAXONOMY.opt_out.terminal, true);
  assert.equal(INTENT_TAXONOMY.ownership_confirmed.stage, 1);
  assert.equal(INTENT_TAXONOMY.asking_price_provided.automatable_candidate, true);
});

test("taxonomy corrections documented", () => {
  assert.ok(TAXONOMY_CORRECTIONS.length >= 1);
});

test("no intent eligible until held-out gates pass", () => {
  for (const intent of Object.keys(INTENT_TAXONOMY)) {
    assert.equal(isAuthorityEligibleIntent(intent), false);
  }
});

test("manifest version present", () => {
  assert.ok(CALIBRATION_MANIFEST_VERSION.includes("calibration"));
});

test("held-out and development families disjoint", () => {
  const en = seedsEn.map((s) => splitSeedFamily(s.family, "en"));
  const held = new Set(en.filter((x) => x.split === "held_out").map((x) => x.family));
  const dev = new Set(en.filter((x) => x.split === "development").map((x) => x.family));
  for (const f of held) assert.equal(dev.has(f), false);
});
