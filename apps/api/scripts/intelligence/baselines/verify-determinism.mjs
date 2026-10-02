#!/usr/bin/env node
/**
 * IC8 Phase 4 -- determinism proof: train + OPE + feasibility are rerun on the
 * same sealed snapshot into a scratch root and every output file is compared
 * (sha256, with the output root path normalised) against the published run.
 * Writes <models root>/determinism.json. Offline; no database access.
 *
 *   node --no-warnings --loader ./tests/alias-loader.mjs \
 *     scripts/intelligence/baselines/verify-determinism.mjs --dataset=<dir> [--published=<models root>]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashTree, MODELS_ROOT } from "./train-first-touch-baselines.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAMILIES = ["seller_first_touch_reply", "send_opt_out_risk", "send_carrier_filtering", "template_ope", "stage_progression"];

function run(script, args) {
  execFileSync(process.execPath, ["--no-warnings", "--loader", "./tests/alias-loader.mjs", path.join(HERE, script), ...args], { stdio: "inherit" });
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
if (!args.dataset) throw new Error("usage: --dataset=<dir> [--published=<models root>]");
const published = args.published || MODELS_ROOT;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ic8-determinism-"));
run("train-first-touch-baselines.mjs", [`--dataset=${args.dataset}`, `--out=${scratch}`]);
run("train-first-text-variants.mjs", [`--dataset=${args.dataset}`, `--out=${scratch}`]);
run("template-ope.mjs", [`--dataset=${args.dataset}`, `--out=${scratch}`]);
run("stage-feasibility.mjs", [`--out=${scratch}`]);
const files = {};
let identical = true;
for (const family of FAMILIES) {
  const a = hashTree(path.join(published, family, "v0"));
  const b = hashTree(path.join(scratch, family, "v0"));
  for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const same = a[name] !== undefined && a[name] === b[name];
    identical = identical && same;
    files[`${family}/v0/${name}`] = { published: a[name] ?? null, rerun: b[name] ?? null, identical: same };
  }
}
const report = { dataset: args.dataset, identical, compared_files: Object.keys(files).length, note: "sha256 of each file with its output root replaced by <root>", files };
fs.writeFileSync(path.join(published, "determinism.json"), `${JSON.stringify(report, null, 2)}\n`);
fs.rmSync(scratch, { recursive: true, force: true });
console.log(`determinism: ${identical ? "IDENTICAL" : "DIFFERENT"} across ${report.compared_files} files`);
if (!identical) process.exit(1);
