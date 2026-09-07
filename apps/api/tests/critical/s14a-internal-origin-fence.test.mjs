/**
 * s14a-internal-origin-fence.test.mjs
 *
 * THE DEFECT THIS PINS WAS LIVE IN PRODUCTION.
 *
 *   callInternal built its URL from APP_BASE_URL and attached BOTH
 *   `x-internal-api-secret` and `Authorization: Bearer CRON_SECRET`. In the
 *   production container APP_BASE_URL pointed at a stale Vercel deployment --
 *   693 commits behind, no §11 dispatch seam, same production database. So
 *   operator actions executed against pre-§11 code and two privileged
 *   credentials were posted to that host. Reachable targets included
 *   /api/internal/queue/run and /api/internal/outbound/campaign-resume.
 *
 * THE CONTRACT
 *   PRIVILEGED_INTERNAL_REQUEST_EXTERNAL_ORIGIN = 0
 *   No production code may send privileged internal credentials to an origin
 *   outside the allowlist, and the refusal must happen BEFORE the network call.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveInternalApiOrigin,
  mayCarryPrivilegedInternalCredentials,
  CANONICAL_INTERNAL_HOSTS,
} from "@/lib/security/internal-api-origin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.resolve(__dirname, "../../src/lib/discord/discord-action-router.js");

const PROD = { DEPLOYMENT_ENV: "production" };
const STALE = "https://real-estate-automation-three.vercel.app";
const GOOD = "https://ops.leadcommand.ai";

// ── origin resolution ─────────────────────────────────────────────────────

test("production: the canonical Cloudflare origin is allowed", () => {
  const r = resolveInternalApiOrigin({ ...PROD, INTERNAL_API_BASE_URL: GOOD });
  assert.equal(r.ok, true);
  assert.equal(r.origin, GOOD);
});

test("production: the stale Vercel origin is REFUSED by name", () => {
  const r = resolveInternalApiOrigin({ ...PROD, INTERNAL_API_BASE_URL: STALE });
  assert.equal(r.ok, false);
  assert.match(r.reason, /forbidden_host/);
});

test("production: a missing dedicated origin FAILS CLOSED, it does not fall back", () => {
  const r = resolveInternalApiOrigin({ ...PROD, APP_BASE_URL: STALE });
  assert.equal(r.ok, false, "must refuse rather than borrow APP_BASE_URL");
  assert.match(r.reason, /missing_in_production/);
});

test("APP_BASE_URL cannot influence privileged routing at all", () => {
  // Even set to something plausible, it must not be consulted.
  const r = resolveInternalApiOrigin({ ...PROD, APP_BASE_URL: GOOD });
  assert.equal(r.ok, false, "APP_BASE_URL is not an input to privileged routing");
});

const REFUSALS = [
  ["http scheme", "http://ops.leadcommand.ai", /https/],
  ["foreign host", "https://evil.example", /not_allowlisted/],
  ["another vercel host", "https://something-else.vercel.app", /not_allowlisted/],
  ["userinfo smuggling", "https://ops.leadcommand.ai@evil.example", /userinfo|not_allowlisted/],
  ["unexpected port", "https://ops.leadcommand.ai:8443", /port/],
  ["path included", "https://ops.leadcommand.ai/api", /origin_only/],
  ["query string", "https://ops.leadcommand.ai/?x=1", /query|origin_only/],
  ["unparseable", "not a url", /unparseable/],
];

for (const [label, value, expect] of REFUSALS) {
  test(`production refuses ${label}`, () => {
    const r = resolveInternalApiOrigin({ ...PROD, INTERNAL_API_BASE_URL: value });
    assert.equal(r.ok, false, `${label} must be refused`);
    assert.match(r.reason, expect);
  });
}

test("userinfo smuggling resolves to the attacker host, which is why it is refused", () => {
  // Documents WHY the check exists: the string looks like our host.
  assert.equal(new URL("https://ops.leadcommand.ai@evil.example").hostname, "evil.example");
});

test("development may use a loopback fallback; production may not", () => {
  const dev = resolveInternalApiOrigin({ NODE_ENV: "test" });
  assert.equal(dev.ok, true);
  assert.match(dev.origin, /^http:\/\/127\.0\.0\.1/, "dev fallback must be loopback only");
  assert.equal(dev.development_fallback, true);
});

// ── the credential contract ───────────────────────────────────────────────

test("CONTRACT: privileged credentials may not target the stale host", () => {
  const r = mayCarryPrivilegedInternalCredentials(`${STALE}/api/internal/queue/run`, PROD);
  assert.equal(r.ok, false);
  assert.match(r.reason, /forbidden_host/);
});

test("CONTRACT: privileged credentials may target the canonical host", () => {
  assert.equal(
    mayCarryPrivilegedInternalCredentials(`${GOOD}/api/internal/queue/run`, PROD).ok, true);
});

test("CONTRACT: the two send-capable targets specifically cannot reach stale Vercel", () => {
  for (const p of ["/api/internal/queue/run", "/api/internal/outbound/campaign-resume"]) {
    assert.equal(mayCarryPrivilegedInternalCredentials(`${STALE}${p}`, PROD).ok, false,
      `${p} must never be reachable on the stale host`);
  }
});

// ── static contract over the router source ────────────────────────────────

test("STATIC: callInternal does not read APP_BASE_URL", () => {
  const src = fs.readFileSync(ROUTER, "utf8");
  const code = src.split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  assert.ok(!/process\.env\.APP_BASE_URL/.test(code),
    "APP_BASE_URL must not appear in executable router code");
  assert.ok(/resolveInternalApiOrigin/.test(code), "must use the dedicated resolver");
  assert.ok(/mayCarryPrivilegedInternalCredentials/.test(code),
    "must run the credential contract before the request");
});

test("STATIC: the credential contract is checked BEFORE fetch", () => {
  const src = fs.readFileSync(ROUTER, "utf8");
  const guard = src.indexOf("mayCarryPrivilegedInternalCredentials(url");
  const fetchAt = src.indexOf("await fetch(url", guard > 0 ? guard : 0);
  assert.ok(guard > 0, "contract call not found");
  assert.ok(fetchAt > guard,
    "the origin contract must be evaluated before the network request, not after");
});

test("the allowlist is a literal set, not a permissive pattern", () => {
  assert.deepEqual(CANONICAL_INTERNAL_HOSTS, ["ops.leadcommand.ai"]);
  // A wildcard would have admitted the stale deployment.
  assert.ok(!CANONICAL_INTERNAL_HOSTS.some((h) => h.includes("*")));
});
