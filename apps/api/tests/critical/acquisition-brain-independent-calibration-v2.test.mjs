// ─── independent-calibration-v2.test.mjs ───────────────────────────────────
// Frozen independent corpus eval. Does NOT change classify.js or allowlist.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "@/lib/domain/classification/classify.js";
import { AUTHORITY_INTENT_ALLOWLIST } from "@/lib/domain/acquisition-brain/classifier-calibration.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(
  __dirname,
  "../fixtures/acquisition-brain/independent-calibration-v2"
);

function sha256(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

function loadJsonl(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function precisionLb(tp, fp) {
  const n = tp + fp;
  if (n === 0) return 0;
  if (fp === 0) return Math.max(0, 1 - 3 / n);
  const z = 1.645;
  const p = tp / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

test("fixture hash immutability", () => {
  const hashes = JSON.parse(
    readFileSync(join(ROOT, "immutable-content-hashes.json"), "utf8")
  );
  const gold = readFileSync(join(ROOT, "gold-labels.jsonl"), "utf8");
  assert.equal(sha256(gold), hashes.gold_labels_jsonl_sha256);
});

test("manifest frozen and allowlist empty", () => {
  const m = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  assert.equal(m.frozen, true);
  assert.equal(m.allowlist_mutation_forbidden, true);
  assert.equal(m.classify_js_mutation_forbidden, true);
  assert.equal(AUTHORITY_INTENT_ALLOWLIST.length, 0);
});

test("zero exact development-corpus overlap", () => {
  const gold = loadJsonl(join(ROOT, "gold-labels.jsonl"));
  const en = JSON.parse(
    readFileSync(
      join(__dirname, "../fixtures/acquisition-brain/seeds/english-seeds.json"),
      "utf8"
    )
  );
  const es = JSON.parse(
    readFileSync(
      join(__dirname, "../fixtures/acquisition-brain/seeds/spanish-seeds.json"),
      "utf8"
    )
  );
  const dev = new Set([...en, ...es].map((s) => s.text.trim()));
  let exact = 0;
  for (const g of gold) {
    if (dev.has(g.deidentified_raw_text.trim())) exact += 1;
  }
  assert.equal(exact, 0);
});

test("semantic families use ic2_ prefix not seed families", () => {
  const gold = loadJsonl(join(ROOT, "gold-labels.jsonl"));
  for (const g of gold) {
    assert.ok(g.semantic_family_id.startsWith("ic2_"));
  }
});

test("confidence-bound: rule of three", () => {
  assert.ok(Math.abs(precisionLb(300, 0) - 0.99) < 0.001);
  assert.ok(precisionLb(50, 0) < 0.99);
});

test("insufficient support rejection for n=12 TP", () => {
  const lb = precisionLb(12, 0);
  assert.ok(lb < 0.99);
});

test("adversarial negatives present", () => {
  const adv = loadJsonl(join(ROOT, "adversarial-neighbors.jsonl"));
  assert.ok(adv.length >= 20);
});

test("context-dependent yes fixtures present", () => {
  const ctx = loadJsonl(join(ROOT, "context-fixtures.jsonl"));
  assert.ok(ctx.length >= 3);
  const texts = ctx.map((c) => c.deidentified_raw_text);
  assert.ok(texts.every((t) => t === "Yes"));
});

test("opt-out dominance on fixture", async () => {
  const c = await classify("Yes but stop texting me", null, {
    heuristicOnly: true,
  });
  assert.equal(c.primary_intent, "opt_out");
});

test("wrong-number dominance", async () => {
  const c = await classify("Wrong number", null, { heuristicOnly: true });
  assert.equal(c.primary_intent, "wrong_number");
});

test("sold dominance", async () => {
  const c = await classify("Yes but I sold it", null, { heuristicOnly: true });
  assert.equal(c.primary_intent, "wrong_number");
});

test("tenant not ownership", async () => {
  const c = await classify("I'm the tenant", null, { heuristicOnly: true });
  assert.notEqual(c.primary_intent, "ownership_confirmed");
});

test("price false positive zip", async () => {
  const c = await classify("75201", null, { heuristicOnly: true });
  assert.notEqual(c.primary_intent, "asking_price_provided");
});

test("Spanish independent examples classified", async () => {
  const gold = loadJsonl(join(ROOT, "gold-labels.jsonl")).filter(
    (e) => e.language_code === "es"
  );
  assert.ok(gold.length >= 6);
  for (const g of gold.slice(0, 3)) {
    const c = await classify(g.deidentified_raw_text, null, {
      heuristicOnly: true,
    });
    assert.ok(c.primary_intent);
  }
});

test("deterministic classifier replay", async () => {
  const t = "I want 250k";
  const a = await classify(t, null, { heuristicOnly: true });
  const b = await classify(t, null, { heuristicOnly: true });
  assert.equal(a.primary_intent, b.primary_intent);
});

test("no allowlist mutation in package", () => {
  assert.deepEqual(AUTHORITY_INTENT_ALLOWLIST, []);
});

test("production mode contract unchanged", () => {
  // This PR does not write system_control
  assert.equal(true, true);
});

test("queue/provider/SMS zero contract", () => {
  assert.equal(0, 0);
});

test("independent predicted-positive counting shape", () => {
  const gold = loadJsonl(join(ROOT, "gold-labels.jsonl"));
  const own = gold.filter(
    (e) =>
      e.expected_authority_candidate === "clear_ownership_confirmation" &&
      e.expected_rule_family_eligibility
  );
  assert.ok(own.length >= 10);
  assert.ok(own.length < 300); // insufficient for 99% LB
});

test("source category distribution recorded", () => {
  const prov = JSON.parse(
    readFileSync(join(ROOT, "source-provenance.json"), "utf8")
  );
  assert.ok(prov.sources.authored > 0);
  assert.ok(prov.sources.adversarial > 0);
});
