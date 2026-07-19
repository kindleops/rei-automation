#!/usr/bin/env node
/**
 * READ-ONLY verifier for preserved independent_calibration_v3 artifacts.
 * Must not write gold, manifest, or immutable hashes.
 * Wall-clock must not affect pass/fail (no Date.now in hash path).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, openSync, closeSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const EXPECTED = {
  gold: "dcbfdea9b54e60dceeaca750be7db4ba67de9f5169ba0e77e90437c3816d7b3d",
  manifest: "571a81af0d83d0f527b761076e68d55428670b556e30c41e2bd1f44cbdd13c8a",
  example_count: 791,
  english_count: 507,
  spanish_count: 284,
};

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function fail(msg) {
  console.error(JSON.stringify({ ok: false, error: msg }, null, 2));
  process.exit(1);
}

// Refuse if invoked with a write flag
if (process.argv.includes("--write") || process.argv.includes("--rebuild")) {
  fail("verify-frozen-corpus.mjs is read-only; rebuild of frozen gold is forbidden");
}

const goldPath = join(ROOT, "gold-labels.jsonl");
const manifestPath = join(ROOT, "manifest.json");
const immutablePath = join(ROOT, "immutable-content-hashes.json");

const goldBody = readFileSync(goldPath);
const manifestBody = readFileSync(manifestPath);
const immutable = JSON.parse(readFileSync(immutablePath, "utf8"));

const goldHash = sha256(goldBody);
const manifestHash = sha256(manifestBody);

if (goldHash !== EXPECTED.gold) {
  fail(`gold hash mismatch: ${goldHash} !== ${EXPECTED.gold}`);
}
if (manifestHash !== EXPECTED.manifest) {
  fail(`manifest hash mismatch: ${manifestHash} !== ${EXPECTED.manifest}`);
}
if (immutable.gold_labels_jsonl_sha256 !== EXPECTED.gold) {
  fail("immutable-content-hashes.json gold hash drift");
}
if (immutable.manifest_json_sha256 !== EXPECTED.manifest) {
  fail("immutable-content-hashes.json manifest hash drift");
}
if (immutable.example_count !== EXPECTED.example_count) {
  fail("example_count drift");
}
if (immutable.predictions_sha256 != null) {
  fail("predictions must be null on frozen pre-prediction artifacts");
}

const lines = goldBody.toString("utf8").trim().split("\n").filter(Boolean);
if (lines.length !== EXPECTED.example_count) {
  fail(`line count ${lines.length} !== ${EXPECTED.example_count}`);
}

let en = 0;
let es = 0;
for (const line of lines) {
  const o = JSON.parse(line);
  if (o.language_code === "en") en++;
  if (o.language_code === "es") es++;
}
if (en !== EXPECTED.english_count || es !== EXPECTED.spanish_count) {
  fail(`lang counts en=${en} es=${es}`);
}

// Prove we do not open gold for write
try {
  const fd = openSync(goldPath, constants.O_RDONLY);
  closeSync(fd);
} catch (e) {
  fail(`cannot open gold read-only: ${e.message}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      read_only: true,
      gold_labels_jsonl_sha256: goldHash,
      manifest_json_sha256: manifestHash,
      example_count: lines.length,
      english_count: en,
      spanish_count: es,
      predictions: null,
      note: "Frozen artifacts verified. Content change requires a new corpus version.",
    },
    null,
    2
  )
);
