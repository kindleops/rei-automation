/**
 * runner-build-stamp.test.mjs
 *
 * Production incident (2026-09-09): the Worker served commit 77334a4b from
 * 04:05Z while the queue-runner container kept EXECUTING pre-cutover code for
 * ~11 more hours, then instances recycled one at a time so two workers ran
 * different code in the same minute. 60 first-touch rows were refused by a
 * hardcoded list the release had already deleted. /api/version reported the new
 * SHA throughout, because that value is process.env.DEPLOY_GIT_SHA -- what the
 * Worker was TOLD to run, not what the container is running.
 *
 * Contract: BUILD_SHA is a COMPILED-IN constant that travels with the image, so
 * comparing it against the environment's SHA makes a stale runner visible.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GENERATED = resolve(API_ROOT, "src/lib/domain/deploy/build-stamp.generated.js");

test("the build stamp module is importable and exports both constants", async () => {
  const mod = await import("@/lib/domain/deploy/build-stamp.generated.js");
  assert.equal(typeof mod.BUILD_SHA, "string");
  assert.equal(typeof mod.BUILD_TIMESTAMP, "string");
  assert.ok(mod.BUILD_SHA.length > 0);
});

test("the generated file is tracked, not gitignored", () => {
  // A missing module here fails every import of the queue runner and
  // /api/version at load time, which would take the runner down.
  assert.match(readFileSync(GENERATED, "utf8"), /export const BUILD_SHA/);
  // `git check-ignore -q` exits 0 when the path IS ignored and 1 when it is not.
  let isIgnored = true;
  try {
    execFileSync("git", ["check-ignore", "-q", GENERATED], {
      cwd: API_ROOT,
      stdio: "ignore",
    });
  } catch {
    isIgnored = false;
  }
  assert.equal(isIgnored, false, "build-stamp.generated.js must not be gitignored");
});

test("the build script regenerates the stamp with the real sha", () => {
  const placeholder = readFileSync(GENERATED, "utf8");
  try {
    execFileSync(process.execPath, ["scripts/write-deploy-sha.mjs"], {
      cwd: API_ROOT,
      encoding: "utf8",
      env: { ...process.env, DEPLOY_GIT_SHA: "abc123deadbeef" },
    });
    const after = readFileSync(GENERATED, "utf8");
    assert.match(after, /export const BUILD_SHA = "abc123deadbeef";/);
    assert.match(after, /export const BUILD_TIMESTAMP = "/);
    assert.notEqual(after, placeholder, "the build must overwrite the placeholder");
  } finally {
    // Restore by content: the file may not be in the index yet.
    writeFileSync(GENERATED, placeholder);
  }
});

test("the runner stamps both shas onto its heartbeat", () => {
  // Guards the exact keys the operator compares. Divergence between these two
  // is the detection rule; equality is healthy.
  const source = readFileSync(
    resolve(API_ROOT, "src/lib/domain/queue/run-send-queue.js"),
    "utf8"
  );
  assert.match(source, /queue_processor_last_build_sha:\s*String\(BUILD_SHA/);
  assert.match(source, /queue_processor_last_deploy_sha:\s*String\(resolveDeployGitSha\(\)/);
  assert.match(
    source,
    /import \{ BUILD_SHA \} from "@\/lib\/domain\/deploy\/build-stamp\.generated\.js"/
  );
});
