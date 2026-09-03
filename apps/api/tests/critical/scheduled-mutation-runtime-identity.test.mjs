/**
 * scheduled-mutation-runtime-identity.test.mjs
 *
 * Deployment IDENTITY, not merely production BUILD mode.
 *
 * THE GAP THIS CLOSES. cron-auth already fails closed on a missing CRON_SECRET
 * in production (see cron-auth-production-detection.test.mjs). But the
 * Cloudflare Worker sets NODE_ENV=production for the STAGING container too, and
 * staging SHARES THE PRODUCTION DATABASE. So "is production" was satisfied by
 * staging, and a scheduled mutation gated only on that would have run from
 * staging against real seller rows.
 *
 * INVARIANT: a scheduled mutation requires an unambiguous deployment identity.
 * cloudflare:production proceeds; cloudflare:staging is DENIED; a provably
 * local/test runtime proceeds; anything unknown is DENIED.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveRuntimeIdentity,
  getDeploymentProvider,
  getDeploymentEnvironment,
  isProductionRuntime,
  DEPLOYMENT_PROVIDERS,
  DEPLOYMENT_ENVIRONMENTS,
} from "@/lib/config/runtime-environment.js";
import { requireScheduledMutationAuth } from "@/lib/security/cron-auth.js";

const ENV_KEYS = [
  "NODE_ENV",
  "VERCEL_ENV",
  "CRON_SECRET",
  "DEPLOYMENT_ENV",
  "DEPLOY_ENV",
  "APP_ENV",
  "DEPLOYMENT_PROVIDER",
  "RUNTIME_PROVIDER",
];

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of ENV_KEYS) previous[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function cronRequest(secret) {
  const headers = new Map([
    ["authorization", secret ? `Bearer ${secret}` : ""],
    ["user-agent", "cloudflare-cron/1.0"],
    ["x-internal-cron-source", "cloudflare"],
  ]);
  return { headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null } };
}

// The two real Cloudflare deployments. Note NODE_ENV is production for BOTH:
// that is exactly why NODE_ENV cannot be the discriminator.
const CF_PRODUCTION = {
  NODE_ENV: "production",
  DEPLOYMENT_ENV: "production",
  DEPLOYMENT_PROVIDER: "cloudflare",
};
const CF_STAGING = {
  NODE_ENV: "production",
  DEPLOYMENT_ENV: "staging",
  DEPLOYMENT_PROVIDER: "cloudflare",
};

// ── identity resolution ─────────────────────────────────────────────────────

test("cloudflare production and staging are DISTINGUISHED despite identical NODE_ENV", () => {
  const prod = withEnv(CF_PRODUCTION, () => resolveRuntimeIdentity());
  const stg = withEnv(CF_STAGING, () => resolveRuntimeIdentity());

  // Both are production BUILDS...
  assert.equal(prod.is_production_build, true);
  assert.equal(stg.is_production_build, true);

  // ...but only one is the production DEPLOYMENT.
  assert.equal(prod.is_production_deployment, true);
  assert.equal(stg.is_production_deployment, false);

  assert.equal(prod.label, "cloudflare:production");
  assert.equal(stg.label, "cloudflare:staging");
});

test("provider and environment resolve from the canonical bindings", () => {
  withEnv(CF_PRODUCTION, () => {
    assert.equal(getDeploymentProvider(), DEPLOYMENT_PROVIDERS.CLOUDFLARE);
    assert.equal(getDeploymentEnvironment(), DEPLOYMENT_ENVIRONMENTS.PRODUCTION);
  });
  withEnv({ NODE_ENV: "production", VERCEL_ENV: "production" }, () => {
    assert.equal(getDeploymentProvider(), DEPLOYMENT_PROVIDERS.VERCEL);
    assert.equal(getDeploymentEnvironment(), DEPLOYMENT_ENVIRONMENTS.PRODUCTION);
  });
  withEnv({ NODE_ENV: "test" }, () => {
    assert.equal(getDeploymentEnvironment(), DEPLOYMENT_ENVIRONMENTS.TEST);
  });
});

test("a production BUILD with no deployment binding is UNKNOWN, never production", () => {
  const identity = withEnv({ NODE_ENV: "production" }, () => resolveRuntimeIdentity());
  assert.equal(identity.is_production_build, true);
  assert.equal(identity.environment, DEPLOYMENT_ENVIRONMENTS.UNKNOWN);
  assert.equal(identity.is_production_deployment, false, "must not guess production from NODE_ENV alone");
});

test("an explicit but unrecognised deployment binding resolves to UNKNOWN", () => {
  for (const value of ["prd", "qa", "canary", "¯\\_(ツ)_/¯", " "]) {
    const identity = withEnv(
      { NODE_ENV: "production", DEPLOYMENT_ENV: value, DEPLOYMENT_PROVIDER: "cloudflare" },
      () => resolveRuntimeIdentity()
    );
    assert.equal(
      identity.is_production_deployment,
      false,
      `DEPLOYMENT_ENV=${JSON.stringify(value)} must not confer production authority`
    );
  }
});

test("DEPLOY_ENV and APP_ENV are honoured as canonical bindings", () => {
  for (const key of ["DEPLOY_ENV", "APP_ENV"]) {
    const identity = withEnv({ NODE_ENV: "production", [key]: "production" }, () => resolveRuntimeIdentity());
    assert.equal(identity.is_production_deployment, true, `${key} should establish identity`);
  }
});

test("the legacy production predicate still recognises both hosts", () => {
  assert.equal(withEnv({ NODE_ENV: "production" }, () => isProductionRuntime()), true);
  assert.equal(withEnv({ VERCEL_ENV: "production" }, () => isProductionRuntime()), true);
  assert.equal(withEnv({ NODE_ENV: "test" }, () => isProductionRuntime()), false);
});

// ── the scheduled-mutation gate ─────────────────────────────────────────────

const SECRET = "s".repeat(48);

test("cloudflare PRODUCTION with a valid secret is authorized", () => {
  const result = withEnv({ ...CF_PRODUCTION, CRON_SECRET: SECRET }, () =>
    requireScheduledMutationAuth(cronRequest(SECRET))
  );
  assert.equal(result.authorized, true);
  assert.equal(result.auth.runtime_identity.label, "cloudflare:production");
});

test("cloudflare STAGING with a VALID production secret is DENIED", () => {
  // The single most important case: staging shares the production database, so
  // holding the correct secret must not be sufficient.
  const result = withEnv({ ...CF_STAGING, CRON_SECRET: SECRET }, () =>
    requireScheduledMutationAuth(cronRequest(SECRET))
  );
  assert.equal(result.authorized, false, "staging must never gain production authority");
  assert.equal(result.response.status, 403);
});

test("an UNKNOWN runtime with a valid secret is DENIED", () => {
  const result = withEnv({ NODE_ENV: "production", CRON_SECRET: SECRET }, () =>
    requireScheduledMutationAuth(cronRequest(SECRET))
  );
  assert.equal(result.authorized, false, "a missing deployment binding must fail closed");
  assert.equal(result.response.status, 403);
});

test("production with a MISSING secret is denied before identity is even consulted", () => {
  const result = withEnv(CF_PRODUCTION, () => requireScheduledMutationAuth(cronRequest(null)));
  assert.equal(result.authorized, false);
  assert.equal(result.response.status, 500, "missing CRON_SECRET in production is a hard failure");
});

test("production with an EMPTY, WRONG or MALFORMED secret is denied", () => {
  const cases = [
    ["empty configured secret", { ...CF_PRODUCTION, CRON_SECRET: "" }, SECRET, 500],
    ["wrong secret", { ...CF_PRODUCTION, CRON_SECRET: SECRET }, "w".repeat(48), 401],
    ["shorter secret", { ...CF_PRODUCTION, CRON_SECRET: SECRET }, "s".repeat(10), 401],
    ["longer secret", { ...CF_PRODUCTION, CRON_SECRET: SECRET }, "s".repeat(64), 401],
    ["malformed secret", { ...CF_PRODUCTION, CRON_SECRET: SECRET }, "  \n\t ", 401],
    ["no secret presented", { ...CF_PRODUCTION, CRON_SECRET: SECRET }, null, 401],
  ];
  for (const [label, env, presented, status] of cases) {
    const result = withEnv(env, () => requireScheduledMutationAuth(cronRequest(presented)));
    assert.equal(result.authorized, false, label);
    assert.equal(result.response.status, status, label);
  }
});

test("a provably local/test runtime is allowed, so the suite is not vacuous", () => {
  const result = withEnv({ NODE_ENV: "test" }, () => requireScheduledMutationAuth(cronRequest(null)));
  assert.equal(result.authorized, true, "test runtimes keep the permissive dev behaviour");
});

test("a manual caller cannot impersonate a scheduled run without the secret", () => {
  const headers = new Map([
    ["user-agent", "curl/8.0"],
    ["x-internal-cron-source", "cloudflare"],
  ]);
  const req = { headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null } };
  const result = withEnv({ ...CF_PRODUCTION, CRON_SECRET: SECRET }, () =>
    requireScheduledMutationAuth(req)
  );
  assert.equal(result.authorized, false, "provenance headers are not authentication");
});

test("repeated identical invocations are deterministic (duplicate cron events)", () => {
  const results = withEnv({ ...CF_PRODUCTION, CRON_SECRET: SECRET }, () =>
    [0, 1, 2].map(() => requireScheduledMutationAuth(cronRequest(SECRET)).authorized)
  );
  assert.deepEqual(results, [true, true, true], "auth must be a pure function of env + request");
});
