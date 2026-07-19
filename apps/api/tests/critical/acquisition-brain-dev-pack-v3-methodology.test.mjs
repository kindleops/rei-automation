// PR #42 methodology correction — development pack + freeze verifier
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const v3 = join(
  __dirname,
  "../fixtures/acquisition-brain/independent-calibration-v3"
);
const v31 = join(
  __dirname,
  "../fixtures/acquisition-brain/independent-calibration-v3.1"
);

const GOLD_HASH =
  "dcbfdea9b54e60dceeaca750be7db4ba67de9f5169ba0e77e90437c3816d7b3d";
const MANIFEST_HASH =
  "571a81af0d83d0f527b761076e68d55428670b556e30c41e2bd1f44cbdd13c8a";

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

test("original gold hash preserved bit-for-bit", () => {
  const body = readFileSync(join(v3, "gold-labels.jsonl"));
  assert.equal(sha256(body), GOLD_HASH);
  const imm = JSON.parse(
    readFileSync(join(v3, "immutable-content-hashes.json"), "utf8")
  );
  assert.equal(imm.gold_labels_jsonl_sha256, GOLD_HASH);
  assert.equal(imm.example_count, 791);
});

test("original manifest hash preserved", () => {
  const body = readFileSync(join(v3, "manifest.json"));
  assert.equal(sha256(body), MANIFEST_HASH);
});

test("preservation record documents non-authority status", () => {
  const p = JSON.parse(readFileSync(join(v3, "PRESERVATION_RECORD.json"), "utf8"));
  assert.equal(
    p.conceptual_reclassification,
    "acquisition_brain_adversarial_development_pack_v3"
  );
  assert.equal(p.may_count_for_authority_confidence, false);
  assert.equal(
    p.calibration_status_for_all_examples,
    "development_after_methodology_review"
  );
  assert.ok(p.why_not_independent_authority_evidence.length >= 5);
});

test("methodology overlay tags all 791 examples", () => {
  const lines = readFileSync(join(v3, "methodology-overlay.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 791);
  for (const line of lines) {
    const o = JSON.parse(line);
    assert.equal(o.calibration_status, "development_after_methodology_review");
    assert.equal(o.may_count_for_authority_confidence, false);
    assert.ok(o.true_semantic_family_id);
  }
});

test("true family count is not 791 one-per-surface", () => {
  const fam = JSON.parse(readFileSync(join(v3, "true-family-map.json"), "utf8"));
  assert.ok(fam.true_semantic_family_count < 791);
  assert.ok(fam.true_semantic_family_count >= 50);
  assert.equal(fam.original_claimed_family_count, 791);
  assert.ok(fam.clustering_rationale.length >= 3);
  assert.ok(Object.keys(fam.family_size_distribution).length >= 2);
});

test("semantic routing dual labels present", () => {
  const lines = readFileSync(join(v3, "semantic-routing-labels.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 791);
  const sample = JSON.parse(lines[0]);
  for (const k of [
    "canonical_semantic_outcome",
    "classifier_primary_intent",
    "production_routing_outcome",
    "suppression_action",
    "terminal_state",
    "authority_candidate_eligibility",
  ]) {
    assert.ok(k in sample, k);
  }
  // Authority eligibility forced false for pack
  for (const line of lines) {
    assert.equal(JSON.parse(line).authority_candidate_eligibility, false);
  }
});

test("statistical support all insufficient_independent_support", () => {
  const s = JSON.parse(
    readFileSync(join(v3, "statistical-support-assessment.json"), "utf8")
  );
  assert.equal(s.authority_use, "forbidden");
  for (const c of s.candidates) {
    assert.equal(c.status, "insufficient_independent_support");
  }
});

test("natural language percentage is low and reported", () => {
  const n = JSON.parse(readFileSync(join(v3, "naturalness-metrics.json"), "utf8"));
  assert.ok(n.natural_language_percentage < 50);
  assert.ok(n.constructed_language_percentage > 50);
});

test("read-only freeze verifier passes", () => {
  const r = spawnSync(process.execPath, [join(v3, "verify-frozen-corpus.mjs")], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.read_only, true);
  assert.equal(out.gold_labels_jsonl_sha256, GOLD_HASH);
});

test("verifier rejects --write / --rebuild", () => {
  const r = spawnSync(
    process.execPath,
    [join(v3, "verify-frozen-corpus.mjs"), "--rebuild"],
    { encoding: "utf8" }
  );
  assert.notEqual(r.status, 0);
});

test("builder refuses --overwrite-frozen", () => {
  const r = spawnSync(
    process.execPath,
    [join(v3, "build-and-freeze-corpus.mjs"), "--overwrite-frozen"],
    { encoding: "utf8" }
  );
  assert.equal(r.status, 2);
});

test("v3.1 workspace empty of gold and predictions", () => {
  assert.ok(existsSync(join(v31, "COLLECTION_PROTOCOL.md")));
  assert.ok(existsSync(join(v31, "schema.json")));
  const gold = readFileSync(join(v31, "gold-labels.jsonl"), "utf8").trim();
  assert.equal(gold, "");
  const tmpl = JSON.parse(
    readFileSync(join(v31, "manifest.template.json"), "utf8")
  );
  assert.equal(tmpl.example_count, 0);
  assert.equal(tmpl.predictions, null);
});

test("independent labeling contract requires curators", () => {
  const md = readFileSync(join(v3, "INDEPENDENT_LABELING_CONTRACT.md"), "utf8");
  assert.match(md, /Isolated Curator A available \| \*\*no\*\*/);
  assert.match(md, /Independent curation still required \| \*\*yes\*\*/);
});

test("contracts present", () => {
  for (const f of [
    "SEMANTIC_VS_ROUTING_LABEL_CONTRACT.md",
    "STATISTICAL_SAMPLE_SIZE_REQUIREMENTS.md",
    "CONTEXT_COVERAGE_REQUIREMENTS.md",
    "LEAKAGE_AUDIT_PROTOCOL.md",
    "METHODOLOGY_AUDIT.md",
  ]) {
    assert.ok(existsSync(join(v3, f)), f);
  }
});
