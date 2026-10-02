#!/usr/bin/env node
/**
 * IC8.1 variant F -- sealed PIT augmentation of a first-touch snapshot with
 * the owner / company / portfolio features of lib/variant-sets.mjs
 * (ft_graph_extras@1).
 *
 * Why an augmentation: the foundation dataset builder reads only the
 * foundation's PIT collections, and these master_owners rollups are not one
 * of them. The augmentation uses the SAME harness (features/pit.js
 * computeFeatureVector: as-of-bounded reader + leakage assertion) with the
 * extra `owner_portfolio` collection, keyed by the snapshot's subject ids,
 * and is sealed next to the snapshot (sha256 in its manifest). Offline: reads
 * the sealed snapshot and the extract work dir only.
 *
 *   node --no-warnings --loader ./tests/alias-loader.mjs \
 *     scripts/intelligence/baselines/build-graph-extras-augmentation.mjs --dataset=<dir>
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { appendGzipMember, encodeNdjson, readNdjsonGz } from "../../../src/lib/domain/intelligence/datasets/ndjson-gz.js";
import { computeFeatureVector } from "../../../src/lib/domain/intelligence/features/pit.js";
import { createV1Registry } from "../../../src/lib/domain/intelligence/features/v1-features.js";
import { DEFAULT_WORK_DIR } from "./extract-first-touch.mjs";
import { gitHead } from "./build-first-touch-snapshot.mjs";
import { EXTRA_COLLECTIONS, registerVariantSets, VARIANT_SETS_VERSION } from "./lib/variant-sets.mjs";

export const AUGMENT_SET = "ft_graph_extras@1";

export function augmentationPath(datasetDir) {
  return path.join(datasetDir, `augment-${AUGMENT_SET}.ndjson.gz`);
}

export function readAugmentation(datasetDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(datasetDir, `augment-${AUGMENT_SET}.manifest.json`), "utf8"));
  const gz = fs.readFileSync(augmentationPath(datasetDir));
  if (createHash("sha256").update(gz).digest("hex") !== manifest.sha256) throw new Error("augmentation sha256 mismatch");
  return { manifest, bySubject: new Map(readNdjsonGz(augmentationPath(datasetDir)).map((r) => [r.subject_id, r])) };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
  if (!args.dataset) throw new Error("usage: --dataset=<dir>");
  const snapshot = JSON.parse(fs.readFileSync(path.join(args.dataset, "manifest.json"), "utf8"));
  const out = augmentationPath(args.dataset);
  const manifestPath = path.join(args.dataset, `augment-${AUGMENT_SET}.manifest.json`);
  if (fs.existsSync(manifestPath)) throw new Error(`${manifestPath} is sealed`);
  const records = readNdjsonGz(snapshot.uri.replace(/^file:\/\//, ""));
  const registry = createV1Registry();
  registerVariantSets(registry);
  const set = registry.getSet(AUGMENT_SET);
  const read = (name) =>
    fs
      .readFileSync(path.join(DEFAULT_WORK_DIR, `${name}.ndjson`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const sends = new Map(read("sends").map((s) => [String(s.id), s]));
  const owners = new Map(read("owner_portfolio").map((o) => [String(o.master_owner_id), o]));
  fs.writeFileSync(out, Buffer.alloc(0));
  const counts = { rows: 0, missing: {}, missingness: {} };
  let page = [];
  const flush = () => {
    if (page.length) appendGzipMember(out, encodeNdjson(page));
    page = [];
  };
  for (const r of records) {
    const send = sends.get(String(r.subject_id));
    const owner = send ? owners.get(String(send.master_owner_id)) : null;
    const vector = computeFeatureVector({
      registry,
      featureSetId: set.featureSetId,
      entityType: "send",
      entity: { id: r.subject_id, property_id: send?.property_id ?? null, master_owner_id: send?.master_owner_id ?? null, sent_at: send?.sent_at ?? null, created_at: send?.created_at ?? null },
      asOf: r.as_of,
      bundle: { owner_portfolio: owner ? [owner] : [] },
      collections: EXTRA_COLLECTIONS,
    });
    for (const k of vector.missing) counts.missing[k] = (counts.missing[k] || 0) + 1;
    for (const [k, kind] of Object.entries(vector.missingness || {})) counts.missingness[`${k}:${kind}`] = (counts.missingness[`${k}:${kind}`] || 0) + 1;
    page.push({ subject_id: r.subject_id, as_of: vector.as_of, max_input_time: vector.max_input_time, features: vector.values, missing: vector.missing, missingness: vector.missingness || {}, quality: vector.quality || {} });
    counts.rows += 1;
    if (page.length >= 500) flush();
  }
  flush();
  const gz = fs.readFileSync(out);
  const manifest = {
    augments_dataset_id: snapshot.dataset_id,
    augments_sha256: snapshot.sha256,
    feature_set_id: set.featureSetId,
    feature_set_hash: set.definitionHash,
    variant_sets_version: VARIANT_SETS_VERSION,
    members: set.members.map((m) => `${m.key}@${m.version}`),
    harness: "features/pit.js computeFeatureVector + EXTRA_COLLECTIONS.owner_portfolio (placed at master_owners.created_at)",
    counts,
    sha256: createHash("sha256").update(gz).digest("hex"),
    code_commit: gitHead(),
    built_at: snapshot.built_at,
    sealed: true,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`augmentation sealed: ${counts.rows} rows, sha256 ${manifest.sha256}`);
  console.log(JSON.stringify(counts.missing));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
