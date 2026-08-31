/**
 * deployment-provenance.test.mjs
 *
 * /api/version read VERCEL_* directly, so on any non-Vercel host it reported
 * env:"development" and deployment_id:null -- a production container would
 * describe itself as a dev box, making provenance actively misleading.
 *
 * The contract is now provider-neutral, and critically: absence of deployment
 * metadata resolves to "unknown", never to a confident claim.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveDeploymentEnv,
  resolveDeploymentHostname,
  resolveDeploymentId,
  resolveDeploymentProject,
  resolveDeploymentProvider,
} from "@/lib/domain/deploy/resolve-deploy-sha.js";

const KEYS = [
  "NODE_ENV", "VERCEL_ENV", "VERCEL", "VERCEL_DEPLOYMENT_ID", "VERCEL_URL",
  "VERCEL_PROJECT_NAME", "DEPLOYMENT_ENV", "DEPLOYMENT_ID", "DEPLOYMENT_PROVIDER",
  "DEPLOYMENT_PROJECT", "DEPLOYMENT_HOSTNAME", "DEPLOY_ENV", "DEPLOY_ID",
  "DEPLOY_PROVIDER", "DEPLOY_PROJECT", "DEPLOY_HOSTNAME",
];

function withEnv(overrides, fn) {
  const previous = {};
  for (const k of KEYS) { previous[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) process.env[k] = v;
  try { return fn(); } finally {
    for (const k of KEYS) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
  }
}

test("Vercel mapping still works", () => {
  withEnv({
    VERCEL_ENV: "production",
    VERCEL_DEPLOYMENT_ID: "dpl_abc123",
    VERCEL_URL: "api-steel-three-96.vercel.app",
    VERCEL_PROJECT_NAME: "rei-api",
  }, () => {
    assert.equal(resolveDeploymentEnv(), "production");
    assert.equal(resolveDeploymentId(), "dpl_abc123");
    assert.equal(resolveDeploymentProvider(), "vercel");
    assert.equal(resolveDeploymentHostname(), "api-steel-three-96.vercel.app");
    assert.equal(resolveDeploymentProject(), "rei-api");
  });
});

test("Cloudflare / generic values work", () => {
  withEnv({
    NODE_ENV: "production",
    DEPLOYMENT_ENV: "production",
    DEPLOYMENT_ID: "cf-container-42",
    DEPLOYMENT_PROVIDER: "cloudflare",
    DEPLOYMENT_HOSTNAME: "api.leadcommand.ai",
    DEPLOYMENT_PROJECT: "rei-automation-api",
  }, () => {
    assert.equal(resolveDeploymentEnv(), "production");
    assert.equal(resolveDeploymentId(), "cf-container-42");
    assert.equal(resolveDeploymentProvider(), "cloudflare");
    assert.equal(resolveDeploymentHostname(), "api.leadcommand.ai");
    assert.equal(resolveDeploymentProject(), "rei-automation-api");
  });
});

test("generic names take precedence over legacy Vercel names", () => {
  withEnv({ DEPLOYMENT_ENV: "staging", VERCEL_ENV: "production" }, () => {
    assert.equal(resolveDeploymentEnv(), "staging");
  });
});

test("local development remains clearly identified", () => {
  withEnv({ NODE_ENV: "development" }, () => {
    assert.equal(resolveDeploymentEnv(), "development");
    assert.equal(resolveDeploymentProvider(), "unknown");
    assert.equal(resolveDeploymentId(), null);
  });
});

test("absence of metadata NEVER falsely claims production", () => {
  withEnv({}, () => {
    const env = resolveDeploymentEnv();
    assert.equal(env, "unknown");
    assert.notEqual(env, "production", "an unmarked runtime must not claim production");
    assert.notEqual(env, "development", "nor confidently claim development");
    assert.equal(resolveDeploymentProvider(), "unknown");
    assert.equal(resolveDeploymentId(), null);
    assert.equal(resolveDeploymentHostname(), null);
  });
});

test("a production NODE_ENV alone is enough to report production", () => {
  withEnv({ NODE_ENV: "production" }, () => {
    assert.equal(resolveDeploymentEnv(), "production");
  });
});

test("project falls back to a stable default, never empty", () => {
  withEnv({}, () => {
    assert.equal(resolveDeploymentProject(), "rei-automation-api");
  });
});
