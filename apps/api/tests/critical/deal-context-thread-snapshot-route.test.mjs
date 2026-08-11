// ─── deal-context-thread-snapshot-route.test.mjs ─────────────────────────────
// The G12 thread automation snapshot had no call site: it was resolvable code
// with no way for an operator to read it. This locks the route that wires it —
// shared-secret gated, GET-only, read-only.

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { GET } from "@/app/api/internal/deal-context/thread-snapshot/route.js";

const URL_BASE = "http://localhost/api/internal/deal-context/thread-snapshot";
const SECRET = process.env.INTERNAL_API_SECRET || "test";

function request(query = "", { secret = SECRET } = {}) {
  const headers = secret ? { "x-internal-api-secret": secret } : {};
  return new Request(`${URL_BASE}${query}`, { method: "GET", headers });
}

test("an unauthenticated request is rejected and resolves nothing", async () => {
  const response = await GET(request("?thread_key=%2B13055550123", { secret: null }));
  assert.ok(response.status === 401 || response.status === 403, `got ${response.status}`);
});

test("a wrong secret is rejected", async () => {
  const response = await GET(
    request("?thread_key=%2B13055550123", { secret: "not-the-secret" }),
  );
  assert.ok(response.status === 401 || response.status === 403, `got ${response.status}`);
});

test("an authed request without thread_key is a 400, not a resolve", async () => {
  const response = await GET(request(""));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "missing_thread_key");
});

test("an authed request returns the snapshot and the operator summary", async () => {
  const response = await GET(request("?thread_key=%2B13055550123"));
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.route, "internal/deal-context/thread-snapshot");
  assert.equal(body.snapshot.thread_key, "+13055550123");
  assert.ok(body.snapshot.automation?.state, "an automation verdict is always present");
  assert.ok(Array.isArray(body.snapshot.reason_codes));
  assert.match(body.summary, /Automation:/);

  // No backing data in the test environment ⇒ it must not claim ACTIVE.
  assert.notEqual(body.snapshot.automation.state, "active");
});
