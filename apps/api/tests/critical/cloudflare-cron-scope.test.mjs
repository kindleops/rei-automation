import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Cloudflare scheduler scope (Part D / Part E).
//
// The Worker is release-only TypeScript with no runtime harness here, so this
// asserts against its SOURCE. That is the right level: the property we need is
// "no send-capable path is registered", which is a static property of the job
// tables and the trigger lists.

const WORKER = new URL("../../../../infra/cloudflare/worker/index.ts", import.meta.url);
const STAGING = new URL("../../../../infra/cloudflare/wrangler.jsonc", import.meta.url);
const PRODUCTION = new URL("../../../../infra/cloudflare/wrangler.production.jsonc", import.meta.url);

const THE_ONLY_ALLOWED_JOB = "/api/internal/webhooks/recover-delivery";

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
  "/api/internal/seller-flow/recover-inbound",
  "/api/internal/webhooks/recover-inbound",
  "/api/internal/offers/recalculate",
];

/** The worker source with comments stripped: prose names forbidden jobs on purpose. */
async function workerCode() {
  const raw = await readFile(WORKER, "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/** Cron expressions declared in a wrangler config's triggers.crons. */
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

test("no send-capable job appears anywhere in the worker's executable code", async () => {
  const code = await workerCode();
  for (const job of FORBIDDEN_JOBS) {
    assert.ok(!code.includes(job), `a schedule could reach a send-capable job: ${job}`);
  }
});

test("the only job registered for ANY environment is the delivery reconciler", async () => {
  const code = await workerCode();
  const registered = [...code.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]);

  assert.ok(registered.length > 0, "expected at least one registered job");
  for (const path of registered) {
    assert.equal(path, THE_ONLY_ALLOWED_JOB, `unexpected scheduled job registered: ${path}`);
  }
});

test("the reconciler runs with its outbound provider call disabled", async () => {
  const code = await workerCode();
  assert.match(
    code,
    /include_polling_fallback:\s*false/,
    "the reconciler must disable its provider polling leg, leaving pure DB reconciliation"
  );
});

test("job resolution is default-deny on BOTH environment and expression", async () => {
  const code = await workerCode();
  // Unknown DEPLOYMENT_ENV -> empty table; unknown expression -> empty list.
  assert.match(code, /CRON_JOBS_BY_ENV\[[^\]]*\]\s*\?\?\s*\{\}/, "unknown env must resolve to an empty table");
  assert.match(code, /table\[event\.cron\]\s*\?\?\s*\[\]/, "unknown expression must resolve to no jobs");
  assert.ok(
    /jobs\.length === 0/.test(code),
    "an empty job list must return without dispatching"
  );
});

test("CRON_ENABLED and CRON_SECRET both still gate dispatch", async () => {
  const code = await workerCode();
  assert.ok(code.includes("CRON_ENABLED"), "CRON_ENABLED guard must remain");
  assert.ok(code.includes("CRON_SECRET"), "CRON_SECRET guard must remain");
  // Default-deny: a missing CRON_ENABLED must read as "false", not as enabled.
  assert.match(code, /env\.CRON_ENABLED\s*\?\?\s*"false"/, "missing CRON_ENABLED must default to false");
});

test("production declares exactly one schedule, and it maps only to the reconciler", async () => {
  const crons = await declaredCrons(PRODUCTION);
  assert.deepEqual(crons, ["*/5 * * * *"], "production must declare exactly one cron expression");

  const code = await workerCode();
  const prod = code.match(/PRODUCTION_CRON_JOBS[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(prod, "PRODUCTION_CRON_JOBS table must be present");
  for (const expr of crons) {
    assert.ok(prod[1].includes(expr), `production schedule ${expr} has no registered job`);
  }
  // Exactly one job entry in the production table.
  assert.equal((prod[1].match(/RECONCILE_DELIVERY_OUTCOMES/g) ?? []).length, 1);
});

test("staging blast radius is reduced to the same single schedule", async () => {
  // Staging shares the PRODUCTION database, so it gets production's standard.
  const crons = await declaredCrons(STAGING);
  assert.deepEqual(crons, ["*/5 * * * *"], "staging must not re-register the 6-expression cron surface");
});

test("every declared schedule in every config has a registered job, and vice versa", async () => {
  const code = await workerCode();
  const registeredExprs = [...code.matchAll(/"(\*[^"]*\* \* \* \*|[\d*/,\- ]+)":\s*\[/g)].map((m) => m[1]);

  for (const configUrl of [PRODUCTION, STAGING]) {
    for (const expr of await declaredCrons(configUrl)) {
      assert.ok(
        registeredExprs.includes(expr),
        `${expr} is declared but maps to no job (it would fire and silently do nothing)`
      );
    }
  }
});
