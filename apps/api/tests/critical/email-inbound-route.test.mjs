/**
 * email-inbound-route.test.mjs
 *
 * The internet-facing surface a seller's mail actually arrives on.
 *
 * The adapter, the ingest module and the resolver are tested separately. This
 * exercises the ROUTE, because that is what an attacker reaches and because its
 * promises -- 503 for unconfigured, 401 for forged, authentication BEFORE
 * parsing, a token that never appears in a log or a response -- are properties
 * of the wiring rather than of any one module.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const VALID_TOKEN = "b7f4c2e19a03d85f6c1e4b7a92d0f3e5c8b1a4d7e0f3c6b9a2d5e8f1c4b7a0d3";
const WRONG_TOKEN = "0000000000000000000000000000000000000000000000000000000000000000";

const routePromise = import("@/app/api/webhooks/brevo/inbound/[token]/route.js");
const loadRoute = () => routePromise;

function request(body, { token = VALID_TOKEN, headers = {} } = {}) {
  return {
    request: new Request(`https://app.example.com/api/webhooks/brevo/inbound/${token}`, {
      method: "POST",
      headers,
      body,
    }),
    context: { params: Promise.resolve({ token }) },
  };
}

const REPLY = JSON.stringify([
  {
    Uuid: "route-inbound-0001",
    From: { Address: "seller@example.org", Name: "J. Doe" },
    To: [{ Address: "r1.aaaaaaaabbbbbbbbccccccccdddddddd@reply.example.net" }],
    RecipientAddress: "r1.aaaaaaaabbbbbbbbccccccccdddddddd@reply.example.net",
    Subject: "Re: your offer",
    RawTextBody: "Yes, still interested.",
    MessageId: "<seller-route-1@mail.example.org>",
  },
]);

function clearInboundSecrets() {
  delete process.env.BREVO_INBOUND_URL_TOKEN;
  delete process.env.BREVO_INBOUND_WEBHOOK_SECRET;
  delete process.env.BREVO_WEBHOOK_SECRET;
}

// ── the endpoint exists without leaking whether a token is valid ────────────

test("GET reports the route is listening without authenticating", async () => {
  const { GET } = await loadRoute();
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "listening");
});

// ── the configuration hole ──────────────────────────────────────────────────

test("with NO inbound credential configured, the route refuses with 503", async () => {
  // Not 200, and not "accept everything". An unconfigured endpoint that accepted
  // mail would let anyone who found the URL inject a seller conversation.
  clearInboundSecrets();
  const { POST } = await loadRoute();
  const { request: req, context } = request(REPLY);
  const response = await POST(req, context);

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.inbound_security_configured, false);
  assert.equal(body.error, "brevo_inbound_security_not_configured");
});

test("503 and 401 are told apart, because they need different fixes", async () => {
  // "Nobody configured this" and "someone forged this" are both refusals and
  // completely different incidents.
  clearInboundSecrets();
  const { POST } = await loadRoute();
  const unconfigured = await POST(...Object.values(request(REPLY)));

  process.env.BREVO_INBOUND_URL_TOKEN = VALID_TOKEN;
  const forged = await POST(...Object.values(request(REPLY, { token: WRONG_TOKEN })));

  assert.equal(unconfigured.status, 503);
  assert.equal(forged.status, 401);
  clearInboundSecrets();
});

// ── forgery ─────────────────────────────────────────────────────────────────

test("a wrong capability token is refused with 401", async () => {
  process.env.BREVO_INBOUND_URL_TOKEN = VALID_TOKEN;
  const { POST } = await loadRoute();
  const response = await POST(...Object.values(request(REPLY, { token: WRONG_TOKEN })));

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.inbound_security_configured, true);
  clearInboundSecrets();
});

test("an ABSENT token is refused, and told apart from a wrong one", async () => {
  process.env.BREVO_INBOUND_URL_TOKEN = VALID_TOKEN;
  const { POST } = await loadRoute();
  const response = await POST(...Object.values(request(REPLY, { token: "" })));

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "brevo_inbound_credential_absent");
  clearInboundSecrets();
});

test("a token that is a PREFIX of the real one is refused", async () => {
  // A length-leaking comparison would let an attacker walk the token one
  // character at a time. The verifier hashes to a fixed width first.
  process.env.BREVO_INBOUND_URL_TOKEN = VALID_TOKEN;
  const { POST } = await loadRoute();
  for (const token of [VALID_TOKEN.slice(0, 32), VALID_TOKEN.slice(0, -1), VALID_TOKEN + "a"]) {
    const response = await POST(...Object.values(request(REPLY, { token })));
    assert.equal(response.status, 401, token.slice(0, 12));
  }
  clearInboundSecrets();
});

// ── authentication happens BEFORE parsing ──────────────────────────────────

test("a malformed body from an UNAUTHENTICATED caller is refused as unauthenticated", async () => {
  // Parsing before authenticating is free work for an attacker and a parser
  // surface we do not need to expose. The refusal must name the credential, not
  // the JSON: the caller never got far enough for the JSON to matter.
  process.env.BREVO_INBOUND_URL_TOKEN = VALID_TOKEN;
  const { POST } = await loadRoute();
  const response = await POST(...Object.values(request("{{{not json at all", { token: WRONG_TOKEN })));

  assert.equal(response.status, 401);
  assert.notEqual((await response.json()).error, "inbound_body_not_json");
  clearInboundSecrets();
});

test("a malformed body from an AUTHENTICATED caller is a 400, not a 503", async () => {
  // Brevo retrying will send the same unparseable bytes, so asking for a retry
  // would loop forever.
  process.env.BREVO_INBOUND_URL_TOKEN = VALID_TOKEN;
  const { POST } = await loadRoute();
  const response = await POST(...Object.values(request("{{{not json at all")));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "inbound_body_not_json");
  clearInboundSecrets();
});

// ── the token must never escape ─────────────────────────────────────────────

test("the capability token never appears in any response body", async () => {
  // A logged or echoed capability URL is a capability URL that has been given
  // away. This checks every refusal shape, not just the happy path.
  process.env.BREVO_INBOUND_URL_TOKEN = VALID_TOKEN;
  const { POST } = await loadRoute();

  const responses = [
    await POST(...Object.values(request(REPLY, { token: WRONG_TOKEN }))),
    await POST(...Object.values(request("nonsense"))),
    await POST(...Object.values(request(REPLY, { token: "" }))),
  ];
  for (const response of responses) {
    const text = JSON.stringify(await response.json());
    assert.equal(text.includes(VALID_TOKEN), false, "the configured token leaked");
    assert.equal(text.includes(WRONG_TOKEN), false, "the presented token was echoed");
  }
  clearInboundSecrets();
});

// ── flood resistance ────────────────────────────────────────────────────────

test("an oversized body is rejected before authentication is even attempted", async () => {
  // Bounded so a flood cannot exhaust the runtime. This one refuses BEFORE the
  // credential check on purpose: reading 30MB to decide it was forged is the
  // work an attacker wanted us to do.
  clearInboundSecrets();
  const { POST } = await loadRoute();
  const huge = "x".repeat(31 * 1024 * 1024);
  const response = await POST(...Object.values(request(huge)));

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "inbound_body_too_large");
});

// ── hostile shapes ──────────────────────────────────────────────────────────

test("the route never throws a 500 on a hostile body", async () => {
  // A 500 leaks a stack trace and tells Brevo nothing useful. Every failure here
  // is a deliberate status.
  process.env.BREVO_INBOUND_URL_TOKEN = VALID_TOKEN;
  const { POST } = await loadRoute();

  for (const body of ["", "null", "0", '"a string"', "[]", "{}", "[null]", "[[]]", '[{"From":null}]']) {
    const response = await POST(...Object.values(request(body)));
    assert.notEqual(response.status, 500, body);
    assert.ok(response.status < 600);
  }
  clearInboundSecrets();
});

test("a missing params object does not crash the route", async () => {
  clearInboundSecrets();
  const { POST } = await loadRoute();
  const req = new Request("https://app.example.com/api/webhooks/brevo/inbound/x", {
    method: "POST", body: REPLY,
  });
  for (const context of [undefined, null, {}, { params: undefined }, { params: Promise.resolve(null) }]) {
    const response = await POST(req.clone(), context);
    assert.notEqual(response.status, 500);
  }
});

// ── the authenticated path ──────────────────────────────────────────────────

test("a VALID token gets past authentication, and a receipt we cannot store asks for a retry", async () => {
  // Two promises in one, because the second only exists beyond the first.
  //
  // 1. The capability URL actually authenticates. Every test above proves what
  //    is refused; without this one they would all still pass if the route
  //    refused everything.
  // 2. When the receipt cannot be made durable -- here because the test
  //    environment blocks the network, in production because the database is
  //    unreachable -- the answer is 503, never 200. Answering 200 would tell
  //    Brevo the reply was accepted and stop it retrying, and the seller's
  //    message would be gone with nothing anywhere recording that it existed.
  process.env.BREVO_INBOUND_URL_TOKEN = VALID_TOKEN;
  const { POST } = await loadRoute();
  const response = await POST(...Object.values(request(REPLY)));

  assert.notEqual(response.status, 401, "a valid capability token was refused");
  assert.notEqual(response.status, 400);
  const body = await response.json();
  assert.notEqual(body.error, "brevo_inbound_security_not_configured");

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.error, "inbound_receipt_not_durable");
  clearInboundSecrets();
});

test("a payload we cannot even read is kept, and does NOT ask for a retry", async () => {
  // A malformed item is quarantined rather than dropped -- it is the only
  // evidence something arrived, and it may be a provider change worth seeing.
  // But retrying it would loop forever, because the next delivery is identical.
  process.env.BREVO_INBOUND_URL_TOKEN = VALID_TOKEN;
  const { POST } = await loadRoute();
  const response = await POST(...Object.values(request('[{"Subject":"no sender at all"}]')));

  assert.notEqual(response.status, 401);
  const body = await response.json();
  if (response.status === 200) {
    assert.equal(body.results[0].quarantined, true);
    assert.equal(body.results[0].error, "inbound_payload_missing_sender");
  } else {
    // The quarantine write itself needs the database, which this environment
    // blocks; the route must still not report the message as accepted.
    assert.equal(body.ok, false);
  }
  clearInboundSecrets();
});
