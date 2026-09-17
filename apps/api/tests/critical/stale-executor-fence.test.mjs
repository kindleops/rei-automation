import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  resolveRuntimeIdentity,
  DEPLOYMENT_PROVIDERS,
  DEPLOYMENT_ENVIRONMENTS,
} from "@/lib/config/runtime-environment.js";

/**
 * PRODUCTION-COMMISSIONING-1B §1/§2 — the stale-executor fence.
 *
 * THE HAZARD. A Vercel deployment of this same app held its OWN copies of
 * SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL, SUPABASE_DB_URL, TEXTGRID_AUTH_TOKEN
 * and every internal secret, and ran 15 crons against the production database —
 * including /api/internal/queue/run every minute — from a build 135 commits
 * behind production. It is currently silent only because the project is
 * billing-disabled (HTTP 402, x-vercel-error: DEPLOYMENT_DISABLED). That is an
 * accident of billing, not a safety boundary: restoring billing resurrects it,
 * and the live 9-day-old deployment still carries the old cron list.
 *
 * WHY SECRET ROTATION IS THE WRONG FENCE. Vercel Cron invokes a path on its own
 * deployment, and that route validates the incoming secret against its own
 * process.env. Caller and validator are the same deployment, so it
 * authenticates against itself regardless of what this side rotates. Worse, it
 * does not need this API at all — it holds the production service-role key
 * directly.
 *
 * THE FENCE THAT WORKS. An automated production mutation now requires the
 * cloudflare PROVIDER, not merely a production environment.
 * DEPLOYMENT_PROVIDER=cloudflare is baked into the container image
 * (apps/api/Dockerfile) and forwarded by the Worker to the container
 * (infra/cloudflare/worker/index.ts). The Vercel runtime uses neither, and
 * Vercel injects VERCEL_ENV itself, so it resolves to `vercel:production`.
 *
 * WHAT THIS FENCE DOES NOT DO — corrected after tracing it properly.
 *
 * It does NOT reach the existing stale Vercel deployment. That deployment
 * serves its OWN 9-day-old build, which does not contain this check, and its
 * cron calls ITSELF rather than the governed API. No code written here can be
 * executed by a build that predates it. So this fence protects the GOVERNED
 * path: it denies Cloudflare staging (which shares the production database and
 * defaults to DEPLOYMENT_ENV=staging) and any future non-governed redeploy of
 * the current code. That is its real and narrower value.
 *
 * WHAT ACTUALLY CONTAINS THE STALE EXECUTOR TODAY is the database, not this
 * file. queue_atomic_claim_send_row calls queue_execution_mode_normalized() and
 * queue_processor_mode_normalized(), which read system_control inside SQL and
 * DEFAULT CLOSED ('stopped' / 'off'). Every claim passes through them whoever
 * calls, so while queue_execution_mode = scoped_canary_only an unrestricted
 * claim from ANY deployment — including the stale one — is refused with
 * queue_execution_mode_scoped_canary_only.
 *
 * That property is deliberately NOT asserted here. It was verified against
 * production on 2026-09-17 by reading pg_get_functiondef for all three
 * routines, and it lives only in the database: none of them appears in
 * supabase/migrations (the repo holds 7 migrations against prod's ~135 — the
 * known divergence). A test asserting it from this checkout would have to
 * either reach production or match a file that does not exist, so an earlier
 * version of this file failed honestly and was removed rather than weakened
 * into something that passes without checking anything.
 *
 * THE ORDERING CONSTRAINT THAT FOLLOWS, and it is hard: that containment ends
 * the moment queue_execution_mode = 'normal', which live sending requires. A
 * resurrected stale executor could then claim and send using its own
 * SUPABASE_SERVICE_ROLE_KEY and TEXTGRID_AUTH_TOKEN. The Vercel deployment must
 * therefore be genuinely removed — project deleted, env stripped, or the
 * service-role key rotated — BEFORE execution_mode goes to 'normal'. This fence
 * is not a substitute for that step.
 *
 * It is also configurational, not cryptographic: adding
 * DEPLOYMENT_PROVIDER=cloudflare to that project's env would forge it.
 */

const VERCEL_STALE_ENV = {
  // Exactly what that deployment presents: Vercel injects VERCEL_ENV, and it
  // has no DEPLOYMENT_PROVIDER because it never runs the container image.
  VERCEL_ENV: "production",
  NODE_ENV: "production",
};

const CLOUDFLARE_PROD_ENV = {
  DEPLOYMENT_PROVIDER: "cloudflare",
  DEPLOYMENT_ENV: "production",
  NODE_ENV: "production",
};

test("the stale Vercel deployment resolves to vercel:production, and passes the OLD environment-only test", () => {
  const identity = resolveRuntimeIdentity(VERCEL_STALE_ENV);
  assert.equal(identity.provider, DEPLOYMENT_PROVIDERS.VERCEL);
  assert.equal(identity.environment, DEPLOYMENT_ENVIRONMENTS.PRODUCTION);
  // This is the precise gap that existed: an environment-only gate admits it.
  assert.equal(
    identity.is_production_deployment,
    true,
    "environment alone cannot distinguish the governed deployment"
  );
});

test("the governed container resolves to cloudflare:production", () => {
  const identity = resolveRuntimeIdentity(CLOUDFLARE_PROD_ENV);
  assert.equal(identity.provider, DEPLOYMENT_PROVIDERS.CLOUDFLARE);
  assert.equal(identity.environment, DEPLOYMENT_ENVIRONMENTS.PRODUCTION);
  assert.equal(identity.is_production_deployment, true);
});

test("the provider identity is baked into the runner image, not only injected", async () => {
  // The Worker also forwards DEPLOYMENT_PROVIDER, so this is defence in depth
  // rather than the sole source: if the image stops declaring it, the fence
  // would rest entirely on deploy-time config and this test should go red.
  const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
  assert.match(
    dockerfile,
    /DEPLOYMENT_PROVIDER=cloudflare/,
    "DEPLOYMENT_PROVIDER=cloudflare must be baked into the runner image"
  );
});

test("§2 the scheduled-mutation gate now requires the governed provider", async () => {
  const src = await readFile(
    new URL("../../src/lib/security/cron-auth.js", import.meta.url),
    "utf8"
  );
  assert.match(
    src,
    /identity\.provider === DEPLOYMENT_PROVIDERS\.CLOUDFLARE/,
    "requireScheduledMutationAuth must test the provider, not only the environment"
  );
  // The non-production escape must survive, or the whole suite would have to
  // impersonate production to test anything.
  assert.match(src, /is_explicit_non_production/);
});

test("§2 the send-capable queue runner refuses an automated run from a foreign provider", async () => {
  const src = await readFile(
    new URL("../../src/lib/domain/queue/queue-run-request.js", import.meta.url),
    "utf8"
  );
  assert.match(src, /scheduled_send_runtime_not_authorized/, "the fence must exist in the send lane");
  assert.match(src, /identity\.provider === DEPLOYMENT_PROVIDERS\.CLOUDFLARE/);
  // Scoped to automated runs only: the attended scoped-canary proof and
  // operator dispatch must keep working while the unattended lane is fenced.
  assert.match(
    src,
    /if \(auth\.auth\.is_scheduled_cron\) \{/,
    "the fence must be scoped to scheduled runs so attended dispatch still works"
  );
});

test("the fence denies a Vercel-shaped identity and admits the governed one", () => {
  // The decision the two gates make, expressed directly.
  const decide = (env) => {
    const id = resolveRuntimeIdentity(env);
    return (
      (id.is_production_deployment && id.provider === DEPLOYMENT_PROVIDERS.CLOUDFLARE) ||
      id.is_explicit_non_production
    );
  };
  assert.equal(decide(VERCEL_STALE_ENV), false, "stale Vercel executor must be denied");
  assert.equal(decide(CLOUDFLARE_PROD_ENV), true, "governed production must be allowed");
  // A provider that merely CLAIMS cloudflare without the image still needs a
  // production environment; and an unknown identity stays denied.
  assert.equal(decide({ NODE_ENV: "production" }), false, "unknown identity must be denied");
  assert.equal(decide({ NODE_ENV: "test" }), true, "test runtime must remain allowed");
});

test("billing state is not an input to the governed-provider decision", () => {
  // Narrowly what it says. This does NOT claim the stale deployment is fenced:
  // that build predates this check and cannot execute it. See the header.
  for (const billing of [{}, { VERCEL_DEPLOYMENT_DISABLED: "false" }]) {
    const id = resolveRuntimeIdentity({ ...VERCEL_STALE_ENV, ...billing });
    const governed =
      id.is_production_deployment && id.provider === DEPLOYMENT_PROVIDERS.CLOUDFLARE;
    assert.equal(governed, false);
  }
});

