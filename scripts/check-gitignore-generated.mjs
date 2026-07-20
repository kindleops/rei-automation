#!/usr/bin/env node
/**
 * Regression check: proven local-generated paths must be ignored.
 * Run: node scripts/check-gitignore-generated.mjs
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Paths that must match .gitignore (virtual paths; need not exist on disk). */
const mustBeIgnored = [
  "packages/seller-engine/var/staging/example.ndjson",
  "packages/seller-engine/var/pilot/docker-pgdata/PG_VERSION",
  "packages/seller-engine/var/shadow/run.json",
  "packages/seller-engine/var/checkpoints/x.json",
  "packages/seller-engine/var/reports/out.md",
  "apps/api/scripts/.rollback-snapshots/example.json",
  ".playwright-mcp/console-example.log",
  "apps/dashboard/test-results/.last-run.json",
  "node_modules/foo/package.json",
  ".next/cache",
  "dist/index.js",
  "coverage/lcov.info",
  ".env.local",
];

/** Paths that must NOT be ignored (source / fixtures / migrations). */
const mustNotBeIgnored = [
  "packages/seller-engine/package.json",
  "packages/seller-engine/features/engine.mjs",
  "packages/seller-engine/fixtures/properties_fixture.csv",
  "packages/seller-engine/tests/example.test.mjs",
  "docs/seller-engine/phase1/SELLER_CANONICAL_SCHEMA_V1.md",
  "supabase/migrations-draft/seller-engine/0001_seller_engine_canonical.sql",
  "apps/api/scripts/dispatch-auto-reply-once.mjs",
  "apps/dashboard/static/sounds/new-sms.mp3",
  "package.json",
  "README.md",
];

function isIgnored(relPath) {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", relPath], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch (err) {
    // exit 1 = not ignored
    if (err && err.status === 1) return false;
    throw err;
  }
}

const failures = [];

for (const p of mustBeIgnored) {
  if (!isIgnored(p)) {
    failures.push(`expected IGNORED: ${p}`);
  }
}

for (const p of mustNotBeIgnored) {
  if (isIgnored(p)) {
    failures.push(`expected NOT ignored: ${p}`);
  }
}

if (failures.length) {
  console.error("gitignore regression check FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `gitignore regression check OK (${mustBeIgnored.length} ignored, ${mustNotBeIgnored.length} not ignored)`,
);
