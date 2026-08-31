/**
 * cron-auth-production-detection.test.mjs
 *
 * Regression cover for the Cloudflare cron fail-open.
 *
 * BUG: getCronAuthResult() detected production with `VERCEL_ENV === "production"`
 * ALONE. On Cloudflare Containers (and any non-Vercel host) VERCEL_ENV is unset,
 * so a missing CRON_SECRET took the permissive branch and returned ok:true -
 * silently authorizing every cron caller.
 *
 * INVARIANT: production runtime + missing CRON_SECRET => hard failure (500).
 * Never a silent authorization. An unrecognised environment counts as
 * production, so a misconfigured deploy fails closed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { getCronAuthResult } from "@/lib/security/cron-auth.js";

const CRON_ENV_KEYS = ["NODE_ENV", "VERCEL_ENV", "CRON_SECRET"];

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of CRON_ENV_KEYS) previous[key] = process.env[key];
  for (const key of CRON_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of CRON_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function request({ authorization = null, user_agent = "vercel-cron/1.0" } = {}) {
  const headers = new Map();
  if (authorization) headers.set("authorization", authorization);
  headers.set("user-agent", user_agent);
  return { headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null } };
}

// ─── 1. Vercel production, secret missing -> reject ──────────────────────────

test("VERCEL_ENV=production with no CRON_SECRET is rejected (500)", () => {
  withEnv({ VERCEL_ENV: "production" }, () => {
    const result = getCronAuthResult(request());
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
    assert.equal(result.reason, "missing_cron_secret");
  });
});

// ─── 2. THE CLOUDFLARE CASE: NODE_ENV=production, VERCEL_ENV unset ──────────

test("NODE_ENV=production with VERCEL_ENV unset and no CRON_SECRET is rejected (500)", () => {
  withEnv({ NODE_ENV: "production" }, () => {
    assert.equal(process.env.VERCEL_ENV, undefined, "precondition: VERCEL_ENV unset");
    const result = getCronAuthResult(request());
    assert.equal(
      result.ok,
      false,
      "this is the Cloudflare fail-open: it must NOT silently authorize"
    );
    assert.equal(result.status, 500);
    assert.equal(result.reason, "missing_cron_secret");
    assert.equal(result.runtime_environment, "production");
  });
});

// ─── 2b. Fail closed on a completely unmarked environment ───────────────────

test("an unrecognised runtime with no CRON_SECRET fails CLOSED, not open", () => {
  withEnv({}, () => {
    const result = getCronAuthResult(request());
    assert.equal(
      result.ok,
      false,
      "a misconfigured deploy that sets no env markers must not authorize crons"
    );
    assert.equal(result.status, 500);
    assert.equal(result.runtime_environment, "unknown");
  });
});

// ─── 3. Cloudflare-like production + correct secret -> authorize ─────────────

test("Cloudflare-like production with the correct secret authorizes", () => {
  withEnv({ NODE_ENV: "production", CRON_SECRET: "s3cr3t-value" }, () => {
    const result = getCronAuthResult(request({ authorization: "Bearer s3cr3t-value" }));
    assert.equal(result.ok, true);
    assert.equal(result.authenticated, true);
    assert.equal(result.required, true);
    assert.equal(result.reason, "authorized");
  });
});

// ─── 4. Incorrect secret -> reject ───────────────────────────────────────────

test("an incorrect secret is rejected (401) in production", () => {
  withEnv({ NODE_ENV: "production", CRON_SECRET: "s3cr3t-value" }, () => {
    const result = getCronAuthResult(request({ authorization: "Bearer wrong-value" }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.reason, "invalid_cron_authorization");
  });
});

test("a missing secret header is rejected (401) when a secret is configured", () => {
  withEnv({ NODE_ENV: "production", CRON_SECRET: "s3cr3t-value" }, () => {
    const result = getCronAuthResult(request());
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.reason, "invalid_cron_authorization");
  });
});

// ─── 5. Explicit dev/test without a secret keeps development behaviour ──────

test("NODE_ENV=test with no CRON_SECRET preserves the permissive dev behaviour", () => {
  withEnv({ NODE_ENV: "test" }, () => {
    const result = getCronAuthResult(request());
    assert.equal(result.ok, true);
    assert.equal(result.authenticated, false);
    assert.equal(result.required, false);
    assert.equal(result.reason, "cron_secret_not_configured");
    assert.equal(result.runtime_environment, "non_production");
  });
});

test("NODE_ENV=development with no CRON_SECRET preserves the permissive dev behaviour", () => {
  withEnv({ NODE_ENV: "development" }, () => {
    const result = getCronAuthResult(request());
    assert.equal(result.ok, true);
    assert.equal(result.required, false);
    assert.equal(result.reason, "cron_secret_not_configured");
  });
});

test("a Vercel preview with no CRON_SECRET keeps the permissive behaviour", () => {
  withEnv({ VERCEL_ENV: "preview" }, () => {
    const result = getCronAuthResult(request());
    assert.equal(result.ok, true);
    assert.equal(result.required, false);
  });
});

// ─── Valid-secret behaviour is unchanged in dev too ─────────────────────────

test("a configured secret is still enforced in development", () => {
  withEnv({ NODE_ENV: "development", CRON_SECRET: "dev-secret" }, () => {
    assert.equal(getCronAuthResult(request({ authorization: "Bearer dev-secret" })).ok, true);
    assert.equal(getCronAuthResult(request({ authorization: "Bearer nope" })).ok, false);
  });
});

// ─── The x-vercel-cron-secret header path still works ───────────────────────

test("the x-vercel-cron-secret header is still accepted", () => {
  withEnv({ NODE_ENV: "production", CRON_SECRET: "header-secret" }, () => {
    const headers = new Map([
      ["x-vercel-cron-secret", "header-secret"],
      ["user-agent", "vercel-cron/1.0"],
    ]);
    const result = getCronAuthResult({
      headers: { get: (n) => headers.get(String(n).toLowerCase()) ?? null },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, "authorized");
  });
});
