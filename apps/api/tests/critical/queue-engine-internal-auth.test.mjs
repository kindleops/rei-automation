/**
 * INTERNAL-AUTH DRIFT, pinned.
 *
 * /api/internal/queue/run resolved its credential from the Worker env WITH a
 * control-plane fallback; /api/internal/campaigns/enqueue-target-one resolved
 * env ONLY. Production has INTERNAL_API_SECRET / CRON_SECRET set but not
 * QUEUE_ENGINE_SHARED_SECRET, so the canonical control-plane credential could
 * authenticate the DISPATCH half of a scoped canary and was refused by the
 * ENQUEUE half - the queue engine could be told to send a row it was not
 * allowed to create.
 *
 * Authentication and authorization stay separate here. These tests prove the
 * credential is accepted or refused correctly; they do NOT prove anything
 * about what an authenticated caller may then do, which the scoped-canary
 * authorization suite covers.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  requireQueueEngineInternalAuth,
  resolveQueueEngineOperationalSecrets,
} from "@/lib/security/queue-engine-internal-auth.js";

const ENV_KEYS = [
  "SCOPED_CANARY_EXECUTION_SECRET",
  "QUEUE_ENGINE_SHARED_SECRET",
  "INTERNAL_API_SECRET",
  "CRON_SECRET",
];
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }
const req = (headers = {}) => ({
  headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
});

test("no credential is denied", async () => {
  clearEnv();
  process.env.INTERNAL_API_SECRET = "env-secret-aaa";
  const verdict = await requireQueueEngineInternalAuth(req());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 401);
  assert.equal(verdict.error, "unauthorized");
});

test("a wrong credential is denied", async () => {
  clearEnv();
  process.env.INTERNAL_API_SECRET = "env-secret-aaa";
  const verdict = await requireQueueEngineInternalAuth(req({ "x-internal-api-secret": "nope" }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 401);
});

test("a valid Worker env credential authenticates", async () => {
  clearEnv();
  process.env.INTERNAL_API_SECRET = "env-secret-aaa";
  for (const header of ["x-internal-api-secret", "x-queue-engine-secret", "x-cron-secret"]) {
    const verdict = await requireQueueEngineInternalAuth(req({ [header]: "env-secret-aaa" }));
    assert.equal(verdict.ok, true, `${header} must authenticate`);
  }
  const bearer = await requireQueueEngineInternalAuth(req({ authorization: "Bearer env-secret-aaa" }));
  assert.equal(bearer.ok, true, "bearer must authenticate");
});

test("ROTATION: env and control-plane credentials are BOTH valid concurrently", async () => {
  // The drift itself: production env carried one value and the control plane
  // another. Both must work, or the engine cannot talk to itself mid-rotation.
  clearEnv();
  process.env.INTERNAL_API_SECRET = "env-rotating-old";
  const { primeSystemControlValue } = await import("@/lib/system-control.js");
  primeSystemControlValue("queue_engine_shared_secret", "control-plane-new");

  const secrets = await resolveQueueEngineOperationalSecrets();
  assert.ok(secrets.includes("env-rotating-old"), "env credential must remain valid");
  assert.ok(secrets.includes("control-plane-new"), "control-plane credential must be valid");

  assert.equal((await requireQueueEngineInternalAuth(req({ "x-internal-api-secret": "env-rotating-old" }))).ok, true);
  assert.equal((await requireQueueEngineInternalAuth(req({ "x-queue-engine-secret": "control-plane-new" }))).ok, true);
  assert.equal((await requireQueueEngineInternalAuth(req({ "x-queue-engine-secret": "neither" }))).ok, false);
});

test("FAIL CLOSED: nothing configured denies rather than permits", async () => {
  clearEnv();
  const { primeSystemControlValue } = await import("@/lib/system-control.js");
  primeSystemControlValue("queue_engine_shared_secret", "");
  const verdict = await requireQueueEngineInternalAuth(req({ "x-queue-engine-secret": "anything" }));
  assert.equal(verdict.ok, false, "no configured secret must never authenticate");
  assert.equal(verdict.status, 500);
  assert.equal(verdict.error, "internal_secret_not_configured");
});

test("a secret value never appears in the verdict", async () => {
  clearEnv();
  process.env.INTERNAL_API_SECRET = "super-secret-value-do-not-leak";
  for (const verdict of [
    await requireQueueEngineInternalAuth(req()),
    await requireQueueEngineInternalAuth(req({ "x-internal-api-secret": "wrong" })),
    await requireQueueEngineInternalAuth(req({ "x-internal-api-secret": "super-secret-value-do-not-leak" })),
  ]) {
    const serialized = JSON.stringify(verdict);
    assert.ok(!serialized.includes("super-secret-value-do-not-leak"), "verdict leaked the secret");
  }
});

test("LEAST PRIVILEGE: only queue-engine execution routes use this helper", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const users = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (entry !== "route.js") continue;
      if (readFileSync(full, "utf8").includes("requireQueueEngineInternalAuth")) {
        users.push(full.replace("src/app/api/", "").replace("/route.js", ""));
      }
    }
  };
  walk("src/app/api");
  users.sort();

  // The control-plane credential must not become a skeleton key. Acquisition
  // scoring, the AI router, automation rules, Discord and inbound purges stay
  // on env-only auth.
  //
  // repair-target-readiness is admitted on exactly the principle that excludes
  // the generative routes below: it CANNOT create outbound inventory. It
  // prepares one already-existing target (market + governance-selected
  // template) and writes only that row, with no path to a send_queue insert or
  // a dispatch. The list stays an exact match on purpose — a new consumer of
  // this credential has to be an explicit decision, never an inherited one.
  assert.deepEqual(users, [
    "internal/campaigns/enqueue-target-one",
    "internal/campaigns/repair-target-readiness",
    "internal/queue/status",
  ]);

  for (const forbidden of [
    "internal/ai-router", "internal/automation/rules", "internal/discord/reply-sms",
    "internal/acquisition/score-property", "internal/inbound/ledger-retention-purge",
    "internal/campaigns/feed", "internal/campaigns/activate-due",
  ]) {
    assert.ok(!users.includes(forbidden), `${forbidden} must not accept the queue-engine credential`);
  }
});

test("generative campaign routes deliberately keep env-only auth", async () => {
  const { readFileSync } = await import("node:fs");
  // feed / activate-due / rebuild-target-graph can CREATE outbound inventory.
  // Widening their auth while sending is contained would increase blast radius
  // for no benefit, so they are excluded on purpose, not by oversight.
  for (const route of [
    "src/app/api/internal/campaigns/feed/route.js",
    "src/app/api/internal/campaigns/activate-due/route.js",
    "src/app/api/internal/campaigns/rebuild-target-graph/route.js",
  ]) {
    const source = readFileSync(route, "utf8");
    assert.ok(source.includes("requireInternalSecret"), `${route} must keep env-only auth`);
    assert.ok(!source.includes("requireQueueEngineInternalAuth"), `${route} must not be widened`);
  }
});
