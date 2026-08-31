#!/usr/bin/env node
/**
 * Chunked runner for the critical suite.
 *
 * WHY: as one process the suite is long-lived and memory-heavy. It has been
 * killed mid-run three times -- twice locally under memory pressure and once on
 * a GitHub runner -- each time dying with NO summary line, which is
 * indistinguishable from success if you only check for failures.
 *
 * Running the files in sequential chunks keeps each process short-lived, and
 * more importantly makes an incomplete chunk DETECTABLE: a chunk that produces
 * no summary is reported as INCOMPLETE and fails the run. Silence is never
 * treated as a pass.
 *
 *   node scripts/run-critical-suite.mjs
 *   CRITICAL_CHUNKS=8 node scripts/run-critical-suite.mjs
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const API_ROOT = path.resolve(import.meta.dirname, "..");
const TEST_DIR = path.join(API_ROOT, "tests/critical");
const CHUNKS = Math.max(Number(process.env.CRITICAL_CHUNKS || 8), 1);

const files = fs
  .readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort()
  .map((f) => path.join("tests/critical", f));

if (!files.length) {
  console.error("no test files found");
  process.exit(2);
}

const per = Math.ceil(files.length / CHUNKS);
const totals = { tests: 0, pass: 0, fail: 0, skipped: 0 };
const problems = [];

console.log(`critical suite: ${files.length} files in ${CHUNKS} chunks (~${per} each)\n`);

for (let i = 0; i < CHUNKS; i += 1) {
  const slice = files.slice(i * per, (i + 1) * per);
  if (!slice.length) continue;

  const res = spawnSync(
    process.execPath,
    [
      "--import",
      "./tests/register-aliases.mjs",
      "--test",
      "--test-concurrency=1",
      // Pin the reporter. Node picks spec vs tap based on version/TTY, so the
      // summary format is otherwise environment-dependent -- and this parser is
      // the thing that decides pass/fail. TAP everywhere, deterministically.
      "--test-reporter=tap",
      ...slice,
    ],
    {
      cwd: API_ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env,
        NODE_ENV: "test",
        PODIO_CLIENT_ID: "test",
        PODIO_CLIENT_SECRET: "test",
        PODIO_USERNAME: "test",
        PODIO_PASSWORD: "test",
        INTERNAL_API_SECRET: "test",
        BUYER_WEBHOOK_SECRET: "test",
        OPS_DASHBOARD_SECRET: "test",
        APP_BASE_URL: "http://localhost:3000",
      },
    }
  );

  const out = `${res.stdout || ""}\n${res.stderr || ""}`;
  const num = (label) => {
    const m = out.match(new RegExp(`^# ${label} (\\d+)$`, "m"));
    return m ? Number(m[1]) : null;
  };

  const tests = num("tests");
  const pass = num("pass");
  const fail = num("fail");
  const skipped = num("skipped");

  if (tests === null || fail === null) {
    // No summary => the runner died (OOM/kill). This MUST fail the build; a
    // silently truncated chunk previously looked identical to a clean one.
    problems.push(`chunk ${i + 1}: INCOMPLETE (no summary; exit=${res.status}, signal=${res.signal})`);
    console.error(`chunk ${i + 1}/${CHUNKS}  files=${slice.length}  INCOMPLETE exit=${res.status} signal=${res.signal}`);
    continue;
  }

  totals.tests += tests;
  totals.pass += pass;
  totals.fail += fail;
  totals.skipped += skipped ?? 0;

  console.log(
    `chunk ${i + 1}/${CHUNKS}  files=${slice.length}  tests=${tests} pass=${pass} fail=${fail} skipped=${skipped ?? 0}`
  );

  if (fail > 0) {
    problems.push(`chunk ${i + 1}: ${fail} failing`);
    for (const line of out.split("\n").filter((l) => /^not ok \d+ - /.test(l))) {
      console.error(`   ${line}`);
    }
  }
}

console.log(
  `\nTOTAL tests=${totals.tests} pass=${totals.pass} fail=${totals.fail} skipped=${totals.skipped}`
);

if (problems.length) {
  console.error(`\nSUITE FAILED:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("SUITE PASSED");
