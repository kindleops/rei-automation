/**
 * brevo-webhook-route.test.mjs
 *
 * The internet-facing surface itself, not just the modules behind it.
 *
 * The verification and reconciliation units are tested separately. This exercises
 * the ROUTE, because that is what an attacker reaches, and because the promises
 * made about it -- 503 for unconfigured, 401 for forged, the exact bytes handed
 * to the verifier -- are properties of the wiring rather than of any one module.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const SECRET = "route-test-webhook-secret";

/** Build a Request the route can consume, with the exact body bytes. */
function request(body, headers = {}, url = "https://app.example.com/api/webhooks/brevo/events") {
  return new Request(url, { method: "POST", headers, body });
}

const EVENT = JSON.stringify({
  event: "delivered",
  "message-id": "<route-1@brevo>",
  email: "seller@example.com",
  date: "2026-09-08T18:00:00Z",
});

// Imported ONCE. The secret is read inside verifyBrevoWebhook at call time
// rather than at module load, so a per-test env change is picked up without
// cache-busting -- and cache-busting is not available anyway, because the @/
// alias loader does not resolve a query string.
const routePromise = import("@/app/api/webhooks/brevo/events/route.js");
const loadRoute = () => routePromise;

test("GET reports the route is listening without authenticating", async () => {
  const { GET } = await loadRoute();
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "listening");
});

// ── the configuration hole, at the route ───────────────────────────────────

test("an UNSET secret refuses everything with 503", async () => {
  // Not 200. The old route returned ok and processed the events.
  delete process.env.BREVO_WEBHOOK_SECRET;
  const { POST } = await loadRoute();
  const response = await POST(request(EVENT));

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "brevo_webhook_secret_not_configured");
  assert.equal(body.webhook_secret_configured, false);
});

test("a forged request refuses with 401, told apart from a misconfiguration", async () => {
  process.env.BREVO_WEBHOOK_SECRET = SECRET;
  const { POST } = await loadRoute();
  const response = await POST(request(EVENT, { "x-brevo-webhook-secret": "wrong" }));

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.webhook_secret_configured, true,
    "401 vs 503 is how an operator tells a forgery from a missing env var");
});

test("no credential at all refuses with 401", async () => {
  process.env.BREVO_WEBHOOK_SECRET = SECRET;
  const { POST } = await loadRoute();
  assert.equal((await POST(request(EVENT))).status, 401);
});

test("a refused request processes NOTHING", async () => {
  process.env.BREVO_WEBHOOK_SECRET = SECRET;
  const { POST } = await loadRoute();
  const body = await (await POST(request(EVENT))).json();
  assert.equal(body.events_received, undefined, "a refusal must not report work it did not do");
  assert.equal(body.results, undefined);
});

// ── authenticated requests ─────────────────────────────────────────────────

test("a correct shared secret is accepted and names its mode", async () => {
  process.env.BREVO_WEBHOOK_SECRET = SECRET;
  const { POST } = await loadRoute();
  const response = await POST(request(EVENT, { "x-brevo-webhook-secret": SECRET }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.verification_mode, "shared_secret");
  assert.equal(body.events_received, 1);
});

test("an HMAC is verified against the EXACT received bytes", async () => {
  // If the route re-serialized the body before verifying, this would fail:
  // JSON.stringify does not reproduce the sender's key order or spacing.
  process.env.BREVO_WEBHOOK_SECRET = SECRET;
  const oddly_spaced = '{ "event" : "delivered" , "message-id" : "<hmac-1@brevo>" }';
  const signature = crypto.createHmac("sha256", SECRET).update(oddly_spaced, "utf8").digest("hex");

  const { POST } = await loadRoute();
  const response = await POST(request(oddly_spaced, { "x-brevo-signature": signature }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).verification_mode, "hmac");
});

// ── payload shapes ─────────────────────────────────────────────────────────

test("a bare object, an array and a wrapped batch are all accepted", async () => {
  process.env.BREVO_WEBHOOK_SECRET = SECRET;
  const { POST } = await loadRoute();
  const one = { event: "opened", "message-id": "<a@brevo>", email: "a@b.com" };

  for (const [label, body, expected] of [
    ["bare object", JSON.stringify(one), 1],
    ["array", JSON.stringify([one, one]), 2],
    ["wrapped batch", JSON.stringify({ events: [one, one, one] }), 3],
  ]) {
    const response = await POST(request(body, { "x-brevo-webhook-secret": SECRET }));
    assert.equal(response.status, 200, label);
    assert.equal((await response.json()).events_received, expected, label);
  }
});

test("a malformed body is a 400, not a silent zero-event success", async () => {
  // Processing zero events from a broken body looks identical to success, and
  // Brevo would never retry it.
  process.env.BREVO_WEBHOOK_SECRET = SECRET;
  const { POST } = await loadRoute();
  const response = await POST(request("{not json", { "x-brevo-webhook-secret": SECRET }));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "brevo_webhook_body_not_json");
});

test("an empty body is accepted as an empty batch", async () => {
  // Brevo sends one on webhook configuration tests.
  process.env.BREVO_WEBHOOK_SECRET = SECRET;
  const { POST } = await loadRoute();
  const response = await POST(request("", { "x-brevo-webhook-secret": SECRET }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).events_received, 0);
});

// ── batch isolation ────────────────────────────────────────────────────────

test("one unusable event does not discard the rest of the batch", async () => {
  // Brevo retries the WHOLE batch on a non-2xx, so rejecting the response over
  // one bad sibling replays every good one.
  process.env.BREVO_WEBHOOK_SECRET = SECRET;
  const { POST } = await loadRoute();
  const batch = JSON.stringify([
    { event: "opened", "message-id": "<ok-1@brevo>", email: "a@b.com" },
    { event: null },
    { event: "opened", "message-id": "<ok-2@brevo>", email: "c@d.com" },
  ]);

  const response = await POST(request(batch, { "x-brevo-webhook-secret": SECRET }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).events_received, 3);
});

test("the response summarises what actually happened", async () => {
  process.env.BREVO_WEBHOOK_SECRET = SECRET;
  const { POST } = await loadRoute();
  const response = await POST(request(EVENT, { "x-brevo-webhook-secret": SECRET }));
  const body = await response.json();

  assert.equal(typeof body.applied, "number");
  assert.equal(typeof body.suppressed, "number");
  assert.ok(Array.isArray(body.results));
});
