import test from "node:test";
import assert from "node:assert/strict";

import {
  handleSendNowRequestData,
  normalizeSendNowInput,
} from "@/lib/domain/outbound/send-now-request.js";

function makeLogger() {
  const entries = [];
  return {
    entries,
    logger: {
      info: (event, meta) => entries.push({ level: "info", event, meta }),
      warn: (event, meta) => entries.push({ level: "warn", event, meta }),
      error: (event, meta) => entries.push({ level: "error", event, meta }),
    },
  };
}

// INTERNAL_API_SECRET=test in the critical environment (package.json test:critical).
const AUTH = { "x-internal-api-secret": "test" };

/** A control plane that permits queue creation: no stop, no shutdown, live_limited. */
const HEALTHY = async (key) => (key === "campaign_mode" ? "live_limited" : null);

test("normalizeSendNowInput keeps missing touch_number as null", () => {
  const normalized = normalizeSendNowInput({
    phone: "12087034955",
  });

  assert.equal(normalized.touch_number, null);
  assert.equal(normalized.rendered_message_text, null);
});

test("send-now POST accepts custom message_text and forwards it as a real override", async () => {
  const calls = {
    queued: null,
    processed: null,
  };
  const { logger } = makeLogger();

  const response = await handleSendNowRequestData(
    new Request("http://localhost/api/internal/outbound/send-now", {
      method: "POST",
      body: JSON.stringify({
        phone: "12087034955",
        message_text: "Got it Jose, thanks. Would you be open to an offer on 5521 Laster Ln?",
      }),
      headers: {
        "Content-Type": "application/json",
        ...AUTH,
      },
    }),
    "POST",
    {
      logger,
      getSystemValue: HEALTHY,
      queueOutboundMessageImpl: async (payload) => {
        calls.queued = payload;
        return {
          ok: true,
          queue_item_id: 7001,
        };
      },
      processSendQueueImpl: async (payload) => {
        calls.processed = payload;
        return {
          ok: true,
          sent: true,
        };
      },
    }
  );

  assert.equal(response.status, 200);
  assert.equal(calls.queued.phone, "12087034955");
  assert.equal(calls.queued.touch_number, null);
  assert.equal(
    calls.queued.rendered_message_text,
    "Got it Jose, thanks. Would you be open to an offer on 5521 Laster Ln?"
  );
  assert.deepEqual(calls.processed, { queue_item_id: 7001 });

  const payload = response.payload;
  assert.equal(payload.ok, true);
  assert.equal(payload.result.queued.queue_item_id, 7001);
});

// FOUNDER P0 2026-11-23 item 6: no sending via URL parameters. A GET that is
// fully AUTHENTICATED and carries a phone + message in the query string is
// refused with 405 before anything is read, queued or sent, and the URL's
// phone / message never reach a log line.
test("send-now GET is refused (405) even when authenticated; nothing from the URL is queued, sent or logged", async () => {
  let queued = 0;
  let processed = 0;
  const { entries, logger } = makeLogger();

  const response = await handleSendNowRequestData(
    new Request(
      "http://localhost/api/internal/outbound/send-now?phone=12087034955&rendered_message_text=Manual%20reply",
      { headers: AUTH }
    ),
    "GET",
    {
      logger,
      getSystemValue: HEALTHY,
      queueOutboundMessageImpl: async () => { queued += 1; return { ok: true, queue_item_id: 7002 }; },
      processSendQueueImpl: async () => { processed += 1; return { ok: true, sent: true }; },
    }
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers?.Allow, "POST");
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.error, "method_not_allowed");
  assert.equal(queued + processed, 0, "a URL-parameter send never queues or sends");
  const logged = JSON.stringify(entries);
  assert.ok(!logged.includes("12087034955") && !logged.includes("4955"), "no part of the phone reaches a log");
  assert.ok(!logged.includes("Manual reply"), "the message text never reaches a log");
});

test("the route module exports no GET handler (only POST can send)", async () => {
  const route = await import("@/app/api/internal/outbound/send-now/route.js");
  assert.equal(typeof route.GET, "undefined");
  assert.equal(typeof route.POST, "function");
});

test("send-now POST logs a masked destination and the message LENGTH, never the phone or the text", async () => {
  const { entries, logger } = makeLogger();
  await handleSendNowRequestData(
    new Request("http://localhost/api/internal/outbound/send-now", {
      method: "POST",
      body: JSON.stringify({ phone: "12087034955", message_text: "Private seller text" }),
      headers: { "Content-Type": "application/json", ...AUTH },
    }),
    "POST",
    {
      logger,
      getSystemValue: HEALTHY,
      queueOutboundMessageImpl: async () => ({ ok: true, queue_item_id: 7010 }),
      processSendQueueImpl: async () => ({ ok: true, sent: true }),
    }
  );
  const logged = JSON.stringify(entries);
  assert.ok(entries.length > 0);
  assert.ok(!logged.includes("12087034955"), "raw phone is not logged");
  assert.ok(!logged.includes("Private seller text"), "message text is not logged");
  const requested = entries.find((e) => e.event === "outbound_send_now.requested");
  assert.equal(requested.meta.phone_masked, "***4955");
  assert.equal(requested.meta.message_length, "Private seller text".length);
});

test("send-now route returns a structured queue-build failure instead of a blind 500", async () => {
  const { entries, logger } = makeLogger();

  const response = await handleSendNowRequestData(
    new Request("http://localhost/api/internal/outbound/send-now", {
      method: "POST",
      body: JSON.stringify({
        phone: "12087034955",
        message_text: "Manual reply",
      }),
      headers: {
        "Content-Type": "application/json",
        ...AUTH,
      },
    }),
    "POST",
    {
      logger,
      getSystemValue: HEALTHY,
      queueOutboundMessageImpl: async () => {
        throw new Error("queue_override_failed");
      },
    }
  );

  assert.equal(response.status, 400);
  const payload = response.payload;
  assert.equal(payload.ok, false);
  assert.equal(payload.result.queued.stage, "queue_build");
  assert.equal(payload.result.queued.reason, "queue_build_failed");
  assert.equal(payload.result.queued.message, "queue_override_failed");

  const completed_entry = entries.find((entry) => entry.event === "outbound_send_now.completed");
  assert.ok(completed_entry, "expected completion log entry");
  assert.equal(completed_entry.meta.phone, undefined, "the raw phone is never logged");
  assert.equal(completed_entry.meta.phone_masked, "***4955");
  assert.equal(completed_entry.meta.message_override_present, true);
  assert.equal(completed_entry.meta.queued_stage, "queue_build");
  assert.equal(completed_entry.meta.queued_reason, "queue_build_failed");
});

test("send-now route returns a structured queue-processing failure when immediate send crashes", async () => {
  const response = await handleSendNowRequestData(
    new Request("http://localhost/api/internal/outbound/send-now", {
      method: "POST",
      body: JSON.stringify({
        phone: "12087034955",
        message_text: "Manual reply",
      }),
      headers: {
        "Content-Type": "application/json",
        ...AUTH,
      },
    }),
    "POST",
    {
      logger: makeLogger().logger,
      getSystemValue: HEALTHY,
      queueOutboundMessageImpl: async () => ({
        ok: true,
        queue_item_id: 7003,
      }),
      processSendQueueImpl: async () => {
        throw new Error("send_stage_failed");
      },
    }
  );

  assert.equal(response.status, 400);
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.result.processed.stage, "queue_processing");
  assert.equal(response.payload.result.processed.reason, "queue_processing_failed");
  assert.equal(response.payload.result.processed.message, "send_stage_failed");
});

// ── Send-authorization fix (2026-11-11): authentication ─────────────────────

function sendNowRequest(headers = {}) {
  return new Request("http://localhost/api/internal/outbound/send-now", {
    method: "POST",
    body: JSON.stringify({ phone: "12087034955", message_text: "Manual reply" }),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function neverSendDeps(calls) {
  return {
    logger: makeLogger().logger,
    getSystemValue: HEALTHY,
    queueOutboundMessageImpl: async () => { calls.queued += 1; return { ok: true, queue_item_id: 1 }; },
    processSendQueueImpl: async () => { calls.processed += 1; return { ok: true, sent: true }; },
  };
}

test("send-now refuses a request with no credential, a wrong credential, or a query-string credential, before queueing", async () => {
  for (const [headers, reason] of [
    [{}, "missing_internal_api_secret_token"],
    [{ "x-internal-api-secret": "wrong" }, "invalid_internal_api_secret_token"],
    [{ authorization: "Bearer wrong" }, "invalid_internal_api_secret_token"],
    [{ "x-cron-secret": "test" }, "missing_internal_api_secret_token"],
    [{ "x-ops-dashboard-secret": "test" }, "missing_internal_api_secret_token"],
  ]) {
    const calls = { queued: 0, processed: 0 };
    const response = await handleSendNowRequestData(sendNowRequest(headers), "POST", neverSendDeps(calls));
    assert.equal(response.status, 401, JSON.stringify(headers));
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.error, reason, JSON.stringify(headers));
    assert.equal(calls.queued, 0, "nothing is queued without authentication");
    assert.equal(calls.processed, 0, "nothing is sent without authentication");
  }

  const calls = { queued: 0, processed: 0 };
  const via_query = await handleSendNowRequestData(
    new Request("http://localhost/api/internal/outbound/send-now?phone=12087034955&message_text=x&x-internal-api-secret=test"),
    "GET",
    neverSendDeps(calls)
  );
  // A GET is refused before authentication is even attempted (405), so a
  // query-string credential can never be evaluated, let alone accepted.
  assert.equal(via_query.status, 405);
  assert.equal(calls.queued + calls.processed, 0);

  const bearer = await handleSendNowRequestData(sendNowRequest({ authorization: "Bearer test" }), "POST", neverSendDeps({ queued: 0, processed: 0 }));
  assert.equal(bearer.status, 200, "a Bearer INTERNAL_API_SECRET is accepted");
});

test("the internal send auth fails closed when INTERNAL_API_SECRET is not configured, in every environment", async () => {
  const { authorizeInternalSendRoute } = await import("@/lib/security/internal-send-route-auth.js");
  for (const env of [{}, { INTERNAL_API_SECRET: "" }, { INTERNAL_API_SECRET: "   " }, { NODE_ENV: "development" }]) {
    const result = authorizeInternalSendRoute(sendNowRequest({ "x-internal-api-secret": "anything" }), { env });
    assert.equal(result.ok, false, JSON.stringify(env));
    assert.equal(result.status, 503);
    assert.equal(result.error, "internal_api_secret_not_configured");
  }
  const ok = authorizeInternalSendRoute(sendNowRequest({ "x-internal-api-secret": "s3cret" }), { env: { INTERNAL_API_SECRET: "s3cret" } });
  assert.equal(ok.ok, true);
});

// ── Send-authorization fix: the runtime brakes fail closed ──────────────────

test("send-now fails closed: absent campaign_mode, emergency stop, global shutdown, unreadable stop and a throwing reader all refuse with 423", async () => {
  const cases = [
    [async () => null, "campaign_paused"],
    [async (k) => (k === "campaign_mode" ? "live_limited" : k === "queue_emergency_stop_at" ? "2026-11-11T00:00:00Z" : null), "queue_emergency_stop_active"],
    [async (k) => (k === "campaign_mode" ? "live_limited" : k === "queue_emergency_stop_at" ? "control_plane_unreadable" : null), "queue_emergency_stop_active"],
    [async (k) => (k === "campaign_mode" ? "live_limited" : k === "global_send_shutdown_at" ? "2026-11-11T00:00:00Z" : null), "global_send_shutdown_active"],
    [async () => { throw new Error("control plane down"); }, "control_plane_unreadable"],
  ];
  for (const [getSystemValue, reason] of cases) {
    const calls = { queued: 0, processed: 0 };
    const response = await handleSendNowRequestData(sendNowRequest(AUTH), "POST", { ...neverSendDeps(calls), getSystemValue });
    assert.equal(response.status, 423, reason);
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.result.queued.stage, "runtime_brake");
    assert.equal(response.payload.result.queued.reason, reason);
    assert.equal(calls.queued + calls.processed, 0, `${reason}: nothing queued or sent`);
  }
});
