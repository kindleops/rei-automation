import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
  DatasetSealedError,
  DatasetSpecError,
  PiiLeakError,
  buildDatasetSnapshot,
  toDatasetSnapshotRow,
} from "../../src/lib/domain/intelligence/datasets/snapshot-builder.js";
import { readNdjsonGz } from "../../src/lib/domain/intelligence/datasets/ndjson-gz.js";
import { createV1Registry } from "../../src/lib/domain/intelligence/features/v1-features.js";
import { SYNTHETIC_SPEC, TEST_SALT, createInMemorySource, syntheticSends } from "./helpers/synthetic-dataset.mjs";

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic8-snapshot-"));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const deps = (outDir, source, extra = {}) => ({
  source,
  registry: createV1Registry(),
  outDir,
  codeCommit: "test-commit",
  salt: TEST_SALT,
  sleep: async () => {},
  ...extra,
});

test("builds NDJSON.gz + manifest: exclusions counted, features as of the send, outcomes labeled, no phones", async () => {
  const outDir = tempDir();
  const rows = syntheticSends(24);
  const manifest = await buildDatasetSnapshot(SYNTHETIC_SPEC, deps(outDir, createInMemorySource(rows)));
  assert.equal(manifest.sealed, true);
  assert.equal(manifest.row_count, 24);
  assert.equal(manifest.counts.rows_read, 26);
  assert.equal(manifest.counts.exclusions.rows_dropped, 2);
  assert.equal(manifest.counts.exclusions.dropped_by_reason.internal_test_phone, 1);
  assert.equal(manifest.counts.exclusions.dropped_by_reason.internal_canary_source, 1);
  assert.equal(manifest.code_commit, "test-commit");
  assert.equal(manifest.feature_set_id, "seller_first_touch@1");
  assert.ok(manifest.card.known_biases.some((note) => note.includes("properties re-imported 2026-08")));

  const dataPath = path.join(outDir, `${SYNTHETIC_SPEC.name}.ndjson.gz`);
  const gz = fs.readFileSync(dataPath);
  assert.equal(manifest.sha256, createHash("sha256").update(gz).digest("hex"));
  assert.equal(manifest.content_sha256, createHash("sha256").update(zlib.gunzipSync(gz)).digest("hex"));
  const text = zlib.gunzipSync(gz).toString("utf8");
  assert.ok(!/\+1602555/.test(text) && !text.includes("6025551"), "thread keys never written");
  assert.ok(!text.includes("yes I own it"), "message text never written");

  const records = readNdjsonGz(dataPath);
  assert.equal(records.length, 24);
  const first = records.find((r) => r.subject_id === "send-003");
  assert.match(first.unit, /^[0-9a-f]{32}$/);
  assert.equal(first.features["seller.prior_touch_count"], 1);
  assert.equal(first.features["property.market"], "phoenix");
  assert.equal(first.outcomes["reply_any@1"].status, "mature");
  assert.equal(first.outcomes["reply_any@1"].value, true);
  assert.ok(Date.parse(first.max_input_time) < Date.parse(first.as_of));
  assert.deepEqual(first.strata, { template_language: "English" });
  const positives = records.filter((r) => r.outcomes["reply_any@1"].status === "mature" && r.outcomes["reply_any@1"].value === true).length;
  assert.equal(manifest.positive_count, positives);
  assert.equal(manifest.counts.outcome_status["reply_any@1"].positive, positives);

  const row = toDatasetSnapshotRow(manifest);
  assert.equal(row.sealed, true);
  assert.equal(row.dataset_id, manifest.dataset_id);
});

test("an interrupted build resumes from its checkpoint and produces the identical bytes", async () => {
  const rows = syntheticSends(24);
  const cleanDir = tempDir();
  const clean = await buildDatasetSnapshot(SYNTHETIC_SPEC, deps(cleanDir, createInMemorySource(rows)));

  const crashDir = tempDir();
  await assert.rejects(buildDatasetSnapshot(SYNTHETIC_SPEC, deps(crashDir, createInMemorySource(rows, { failOnPage: 3 }))), /simulated source outage/);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(crashDir, `${SYNTHETIC_SPEC.name}.checkpoint.json`), "utf8"));
  assert.equal(checkpoint.page_index, 3);
  // simulate a torn write after the checkpoint: garbage appended to the data file
  fs.appendFileSync(path.join(crashDir, `${SYNTHETIC_SPEC.name}.ndjson.gz`), Buffer.from("partial-page-garbage"));
  const resumedSource = createInMemorySource(rows);
  const resumed = await buildDatasetSnapshot(SYNTHETIC_SPEC, deps(crashDir, resumedSource));
  assert.equal(resumed.sha256, clean.sha256);
  assert.equal(resumed.content_sha256, clean.content_sha256);
  assert.equal(resumed.dataset_id, clean.dataset_id);
  assert.equal(resumed.build_stats.resumes, 1);
  assert.equal(resumedSource.pageReads, 3, "only the pages after the checkpoint are re-read");
  assert.equal(fs.existsSync(path.join(crashDir, `${SYNTHETIC_SPEC.name}.checkpoint.json`)), false);
});

test("maxPages stops early and a later run finishes; sealed snapshots are immutable", async () => {
  const rows = syntheticSends(12);
  const outDir = tempDir();
  const partial = await buildDatasetSnapshot(SYNTHETIC_SPEC, deps(outDir, createInMemorySource(rows), { maxPages: 1 }));
  assert.equal(partial.status, "partial");
  assert.equal(partial.checkpoint.page_index, 1);
  const done = await buildDatasetSnapshot(SYNTHETIC_SPEC, deps(outDir, createInMemorySource(rows)));
  assert.equal(done.sealed, true);
  await assert.rejects(buildDatasetSnapshot(SYNTHETIC_SPEC, deps(outDir, createInMemorySource(rows))), DatasetSealedError);
});

test("same spec + same source + same salt -> identical snapshot (reproducible)", async () => {
  const rows = syntheticSends(15);
  const a = await buildDatasetSnapshot(SYNTHETIC_SPEC, deps(tempDir(), createInMemorySource(rows)));
  const b = await buildDatasetSnapshot(SYNTHETIC_SPEC, deps(tempDir(), createInMemorySource(rows)));
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.dataset_id, b.dataset_id);
  const otherSalt = await buildDatasetSnapshot(SYNTHETIC_SPEC, deps(tempDir(), createInMemorySource(rows), { salt: "another-salt-0123456789" }));
  assert.notEqual(otherSalt.content_sha256, a.content_sha256, "units are salted per dataset");
  assert.notEqual(otherSalt.pii.salt_fingerprint, a.pii.salt_fingerprint);
  assert.ok(!JSON.stringify(a).includes(TEST_SALT), "the salt itself is never written");
});

test("PII guard rejects a phone number leaking through strata; spec validation is strict", async () => {
  const rows = syntheticSends(6);
  await assert.rejects(
    buildDatasetSnapshot(SYNTHETIC_SPEC, deps(tempDir(), createInMemorySource(rows, { leakPhoneInStrata: true }))),
    PiiLeakError,
  );
  const noCutoff = { ...SYNTHETIC_SPEC };
  delete noCutoff.labelNow;
  await assert.rejects(buildDatasetSnapshot(noCutoff, deps(tempDir(), createInMemorySource(rows))), DatasetSpecError);
  await assert.rejects(
    buildDatasetSnapshot({ ...SYNTHETIC_SPEC, outcomes: [{ key: "fact_acquired:asking_price", version: 1 }] }, deps(tempDir(), createInMemorySource(rows))),
    /labels thread, not send/,
  );
  await assert.rejects(buildDatasetSnapshot({ ...SYNTHETIC_SPEC, exclusionsVersion: "ic8_exclusions@0" }, deps(tempDir(), createInMemorySource(rows))), /exclusionsVersion/);
  await assert.rejects(buildDatasetSnapshot(SYNTHETIC_SPEC, deps(tempDir(), createInMemorySource(rows), { salt: "short" })), /salt/);
});
