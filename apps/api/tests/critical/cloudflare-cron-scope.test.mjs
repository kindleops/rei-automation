import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Cloudflare scheduler scope.
//
// The Worker is release-only TypeScript with no runtime harness here, so this
// asserts against its SOURCE. That is the right level: "no send-capable job is
// reachable from a schedule" is a static property of the job tables, the
// per-job flags, and the trigger lists.

const WORKER = new URL("../../../../infra/cloudflare/worker/index.ts", import.meta.url);
const STAGING = new URL("../../../../infra/cloudflare/wrangler.jsonc", import.meta.url);
const PRODUCTION = new URL("../../../../infra/cloudflare/wrangler.production.jsonc", import.meta.url);

// The complete set of paths any environment may schedule. Both are
// reconciliation lanes; neither can produce a dispatchable send_queue row.
const ALLOWED_JOB_PATHS = [
  "/api/internal/seller-flow/reconcile-state",
  "/api/internal/webhooks/recover-delivery",
];

// Every one of these can send a seller-visible message, or arm a row that a
// later processor run would send. None may be reachable from a schedule.
const FORBIDDEN_JOBS = [
  "/api/internal/queue/run",
  "/api/internal/queue/retry",
  "/api/internal/queue/force-due",
  "/api/internal/campaigns/feed",
  "/api/internal/campaigns/activate-due",
  "/api/internal/campaigns/recover-stale-expired",
  "/api/internal/autopilot/run",
  "/api/internal/seller-flow/flush-inbound-bursts",
  // The BROAD recovery route: replays inbound under live_limited and runs all
  // seven gap sweeps. The narrow reconcile-state adapter replaces it.
  "/api/internal/seller-flow/recover-inbound",
  "/api/internal/webhooks/recover-inbound",
  "/api/internal/offers/recalculate",
];

/** Worker source with comments stripped: prose names forbidden jobs on purpose. */
async function workerCode() {
  const raw = await readFile(WORKER, "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

async function declaredCrons(configUrl) {
  const raw = await readFile(configUrl, "utf8");
  const stripped = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const block = stripped.match(/"triggers"\s*:\s*\{\s*"crons"\s*:\s*\[([^\]]*)\]/);
  if (!block) return [];
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

async function configVars(configUrl) {
  const raw = await readFile(configUrl, "utf8");
  const stripped = raw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const block = stripped.match(/"vars"\s*:\s*\{([\s\S]*?)\n\s*\}/);
  if (!block) return {};
  return Object.fromEntries([...block[1].matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

test("no send-capable job appears anywhere in the worker's executable code", async () => {
  const code = await workerCode();
  for (const job of FORBIDDEN_JOBS) {
    assert.ok(!code.includes(job), `a schedule could reach a send-capable job: ${job}`);
  }
});

test("every registered job path is on the reconciliation allowlist", async () => {
  const code = await workerCode();
  const registered = [...code.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(registered.length > 0, "expected at least one registered job");
  for (const path of registered) {
    assert.ok(ALLOWED_JOB_PATHS.includes(path), `unexpected scheduled job registered: ${path}`);
  }
});

test("EVERY job carries its own enable flag, so the master switch cannot awaken it alone", async () => {
  const code = await workerCode();
  const jobBlocks = [...code.matchAll(/\{\s*id:\s*"([^"]+)",\s*enabledBy:\s*"([^"]+)",\s*path:\s*"([^"]+)"/g)];
  assert.ok(jobBlocks.length >= 2, "expected the reconciliation jobs to declare id + enabledBy + path");

  const flags = new Set();
  for (const [, id, enabledBy, path] of jobBlocks) {
    assert.ok(enabledBy.startsWith("CRON_"), `${id} must name a CRON_* flag, got ${enabledBy}`);
    assert.notEqual(enabledBy, "CRON_ENABLED", `${id} must not reuse the master switch as its job flag`);
    assert.ok(ALLOWED_JOB_PATHS.includes(path), `${id} points at an unapproved path`);
    flags.add(enabledBy);
  }
  assert.equal(flags.size, jobBlocks.length, "each job needs a DISTINCT flag, else one toggle moves two jobs");
});

test("the dispatcher filters on the per-job flag and defaults it to false", async () => {
  const code = await workerCode();
  assert.match(code, /job\.enabledBy/, "dispatch must consult each job's own flag");
  assert.match(code, /\?\?\s*"false"/, "an absent per-job flag must read as false");
  assert.ok(/jobs\.length === 0/.test(code), "an empty enabled set must return without dispatching");
});

test("job resolution is default-deny on BOTH environment and expression", async () => {
  const code = await workerCode();
  assert.match(code, /CRON_JOBS_BY_ENV\[[^\]]*\]\s*\?\?\s*\{\}/, "unknown env must resolve to an empty table");
  assert.match(code, /table\[event\.cron\]\s*\?\?\s*\[\]/, "unknown expression must resolve to no jobs");
});

test("CRON_ENABLED and CRON_SECRET both still gate dispatch", async () => {
  const code = await workerCode();
  assert.match(code, /env\.CRON_ENABLED\s*\?\?\s*"false"/, "missing CRON_ENABLED must default to false");
  assert.ok(code.includes("CRON_SECRET"), "CRON_SECRET guard must remain");
});

test("the delivery reconciler still runs with its outbound provider call disabled", async () => {
  const code = await workerCode();
  assert.match(code, /include_polling_fallback:\s*false/);
});

test("production declares exactly one schedule and commissions only reconciliation flags", async () => {
  assert.deepEqual(await declaredCrons(PRODUCTION), ["*/5 * * * *"]);

  const vars = await configVars(PRODUCTION);
  assert.equal(vars.DEPLOYMENT_ENV, "production");
  assert.equal(vars.CRON_ENABLED, "true", "production is commissioned");

  // Only reconciliation flags may be true. Any other CRON_* flag turned on is
  // an unapproved job.
  const enabled = Object.entries(vars).filter(([k, v]) => k.startsWith("CRON_") && v === "true").map(([k]) => k);
  assert.deepEqual(
    enabled.sort(),
    ["CRON_DELIVERY_RECONCILE_ENABLED", "CRON_ENABLED", "CRON_SELLER_STATE_RECONCILE_ENABLED"],
    `unexpected enabled cron flags: ${enabled.join(", ")}`
  );
});

test("STAGING declares no schedule and registers no job at all", async () => {
  // Staging shares the production database, so it gets no scheduler surface.
  assert.deepEqual(await declaredCrons(STAGING), [], "staging must declare no cron expressions");

  const vars = await configVars(STAGING);
  assert.equal(vars.DEPLOYMENT_ENV, "staging");
  assert.equal(vars.CRON_ENABLED, "false", "staging master switch stays off");
  for (const [k, v] of Object.entries(vars)) {
    if (k.startsWith("CRON_")) assert.notEqual(v, "true", `staging must not enable ${k}`);
  }

  const code = await workerCode();
  const staging = code.match(/STAGING_CRON_JOBS[^=]*=\s*(\{[\s\S]*?\});/);
  assert.ok(staging, "STAGING_CRON_JOBS must exist");
  assert.match(staging[1].replace(/\s/g, ""), /^\{\}$/, "the staging job table must be EMPTY");
});

test("production's declared schedule maps to registered jobs, and staging's absence maps to none", async () => {
  const code = await workerCode();
  const prod = code.match(/PRODUCTION_CRON_JOBS[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(prod, "PRODUCTION_CRON_JOBS must exist");
  for (const expr of await declaredCrons(PRODUCTION)) {
    assert.ok(prod[1].includes(expr), `${expr} is declared but maps to no job`);
  }
  assert.ok(prod[1].includes("SELLER_STATE_RECONCILIATION"), "seller-state lane must be registered");
});
