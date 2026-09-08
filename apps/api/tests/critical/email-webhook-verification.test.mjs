/**
 * email-webhook-verification.test.mjs
 *
 * WHO sent this webhook, and how much may we let it change?
 *
 * The hole this closes: the previous implementation returned ok when
 * BREVO_WEBHOOK_SECRET was unset, so an unconfigured deploy accepted anything.
 * Anyone who found the URL could mark a seller unsubscribed or mark an
 * undelivered message delivered.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { verifyBrevoWebhook } from "@/lib/domain/email/brevo-webhook-verification.js";
import { TRUST_CLASS, mayAdvanceCanonicalTruthWithTrust }
  from "@/lib/domain/communications/callback-trust-policy.js";

const SECRET = "s3cr3t-webhook-value";
const BODY = '{"event":"delivered","message-id":"<m1@brevo>"}';

const verify = (over = {}) =>
  verifyBrevoWebhook({ secret: SECRET, raw_body: BODY, headers: {}, ...over });

// ── the configuration hole ─────────────────────────────────────────────────

test("an UNSET secret refuses, and is reported as a configuration fault", () => {
  const result = verifyBrevoWebhook({ secret: "", raw_body: BODY, headers: {} });
  assert.equal(result.ok, false);
  assert.equal(result.configured, false);
  assert.equal(result.reason, "brevo_webhook_secret_not_configured");
  assert.equal(result.trust_class, TRUST_CLASS.UNAUTHENTICATED);
});

test("an unset secret is told apart from a forged request", () => {
  // Both refuse, but they need different fixes, and an alert that cannot
  // distinguish them wastes the on-call engineer's only real resource.
  const unconfigured = verifyBrevoWebhook({ secret: "", raw_body: BODY, headers: {} });
  const forged = verify({ headers: { "x-brevo-webhook-secret": "wrong" } });
  assert.equal(unconfigured.configured, false);
  assert.equal(forged.configured, true);
  assert.notEqual(unconfigured.reason, forged.reason);
});

// ── shared secret ──────────────────────────────────────────────────────────

test("a correct shared secret authenticates, in any accepted header", () => {
  for (const header of ["x-brevo-webhook-secret", "x-webhook-secret", "x-brevo-secret"]) {
    const result = verify({ headers: { [header]: SECRET } });
    assert.equal(result.ok, true, `${header} was not accepted`);
    assert.equal(result.trust_class, TRUST_CLASS.AUTHENTICATED);
    assert.equal(result.mode, "shared_secret");
  }
});

test("a bearer token authenticates", () => {
  assert.equal(verify({ headers: { authorization: `Bearer ${SECRET}` } }).ok, true);
  assert.equal(verify({ headers: { authorization: SECRET } }).ok, true);
});

test("a query-string secret authenticates", () => {
  const result = verify({ url: `https://example.com/api/webhooks/brevo/events?secret=${SECRET}` });
  assert.equal(result.ok, true);
});

test("a wrong secret refuses", () => {
  const result = verify({ headers: { "x-brevo-webhook-secret": "not-the-secret" } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "brevo_webhook_credential_mismatch");
});

test("no credential at all refuses, and says which kind of nothing it got", () => {
  const result = verify({ headers: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "brevo_webhook_credential_absent");
});

test("an EMPTY credential never matches an empty comparison", () => {
  // Hashing both sides makes the comparison constant-time, and would happily
  // report that "" equals "" -- so emptiness is rejected explicitly.
  const result = verifyBrevoWebhook({
    secret: SECRET, raw_body: BODY, headers: { "x-brevo-webhook-secret": "" },
  });
  assert.equal(result.ok, false);
});

// ── HMAC, for a proxy that adds one ────────────────────────────────────────

test("a valid HMAC over the RAW body authenticates, hex or base64", () => {
  for (const digest of ["hex", "base64"]) {
    const signature = crypto.createHmac("sha256", SECRET).update(BODY, "utf8").digest(digest);
    const result = verify({ headers: { "x-brevo-signature": signature } });
    assert.equal(result.ok, true, `${digest} signature was not accepted`);
    assert.equal(result.mode, "hmac");
  }
});

test("an HMAC over DIFFERENT bytes refuses", () => {
  // This is why the route must hand over the exact bytes it received: a signature
  // checked against a re-serialized body verifies nothing.
  const signature = crypto.createHmac("sha256", SECRET).update('{"event":"opened"}', "utf8").digest("hex");
  assert.equal(verify({ headers: { "x-brevo-signature": signature } }).ok, false);
});

test("a sha256= prefix is tolerated", () => {
  const signature = crypto.createHmac("sha256", SECRET).update(BODY, "utf8").digest("hex");
  assert.equal(verify({ headers: { "x-brevo-signature": `sha256=${signature}` } }).ok, true);
});

// ── the trust class feeds the SHARED policy, not a local one ───────────────

test("an authenticated receipt may advance canonical truth; an unauthenticated one may not", () => {
  // The threshold is the same constant SMS uses. A trust threshold each channel
  // sets for itself is one that will eventually differ by accident.
  assert.equal(mayAdvanceCanonicalTruthWithTrust(verify({ headers: { "x-brevo-webhook-secret": SECRET } }).trust_class), true);
  assert.equal(mayAdvanceCanonicalTruthWithTrust(verify({ headers: {} }).trust_class), false);
});

test("verification never throws on a hostile header bag", () => {
  for (const headers of [null, undefined, {}, { "x-brevo-signature": {} }, { authorization: 12345 }]) {
    assert.doesNotThrow(() => verifyBrevoWebhook({ secret: SECRET, raw_body: BODY, headers }));
  }
  assert.doesNotThrow(() => verify({ url: "not a url" }));
});

test("a Headers-like object is read the same as a plain object", () => {
  const headers = new Map([["x-brevo-webhook-secret", SECRET]]);
  headers.get = Map.prototype.get.bind(headers);
  assert.equal(verify({ headers }).ok, true);
});
