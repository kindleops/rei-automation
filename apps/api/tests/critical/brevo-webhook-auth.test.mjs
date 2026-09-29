import test from "node:test";
import assert from "node:assert/strict";

import { POST } from "@/app/api/webhooks/brevo/events/route.js";

function post(headers = {}) {
  return new Request("http://localhost/api/webhooks/brevo/events", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ event: "hard_bounce", email: "someone@example.com" }),
  });
}

test("brevo webhook fails closed when no secret is configured", async () => {
  const prior = process.env.BREVO_WEBHOOK_SECRET;
  delete process.env.BREVO_WEBHOOK_SECRET;
  try {
    const res = await POST(post());
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "brevo_webhook_secret_not_configured");
  } finally {
    if (prior !== undefined) process.env.BREVO_WEBHOOK_SECRET = prior;
  }
});

test("brevo webhook rejects a wrong secret when configured", async () => {
  const prior = process.env.BREVO_WEBHOOK_SECRET;
  process.env.BREVO_WEBHOOK_SECRET = "expected-secret";
  try {
    const res = await POST(post({ "x-brevo-webhook-secret": "wrong" }));
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "invalid_brevo_webhook_secret");
  } finally {
    if (prior === undefined) delete process.env.BREVO_WEBHOOK_SECRET;
    else process.env.BREVO_WEBHOOK_SECRET = prior;
  }
});
