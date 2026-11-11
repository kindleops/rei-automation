import test from "node:test";
import assert from "node:assert/strict";

import {
  handleDirectSendRequestData,
  normalizeDirectSendInput,
} from "@/lib/domain/outbound/direct-send-request.js";
import {
  appRefField,
  categoryField,
  createPodioItem,
  textField,
} from "../helpers/test-helpers.js";

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

function buildPhoneItem() {
  return createPodioItem(401, {
    "phone-activity-status": categoryField("Active for 12 months or longer"),
    "phone-hidden": textField("2087034955"),
    "canonical-e164": textField("+12087034955"),
    "linked-master-owner": appRefField(201),
    "linked-contact": appRefField(301),
    "primary-property": appRefField(601),
  });
}

test("normalizeDirectSendInput parses ids and preserves the custom message", () => {
  const normalized = normalizeDirectSendInput({
    from_number: "12085550111",
    to_number: "12087034955",
    message_text: "Manual reply",
    phone_item_id: "401",
    textgrid_number_item_id: "701",
  });

  assert.equal(normalized.from_number, "12085550111");
  assert.equal(normalized.to_number, "12087034955");
  assert.equal(normalized.message_text, "Manual reply");
  assert.equal(normalized.phone_item_id, 401);
  assert.equal(normalized.textgrid_number_item_id, 701);
});

test("direct-send POST queues the exact manual message and processes it immediately", async () => {
  const calls = {
    queued: null,
    processed: null,
  };
  const { logger } = makeLogger();
  const items = new Map([
    [401, buildPhoneItem()],
    [201, createPodioItem(201, { "owner-full-name": textField("Jose Seller") })],
    [301, createPodioItem(301, { title: textField("Jose Seller") })],
    [601, createPodioItem(601, { title: textField("5521 Laster Ln") })],
    [701, createPodioItem(701, { title: textField("+12085550111") })],
  ]);

  const response = await handleDirectSendRequestData(
    new Request("http://localhost/api/internal/outbound/direct-send", {
      method: "POST",
      body: JSON.stringify({
        from_number: "12085550111",
        to_number: "12087034955",
        message_text:
          "Got it Jose, thanks. Would you be open to an offer on 5521 Laster Ln?",
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
      findPhoneRecordImpl: async () => items.get(401),
      getItemImpl: async (item_id) => items.get(Number(item_id)) || null,
      fetchAllItemsImpl: async () => [items.get(701)],
      buildSendQueueItemImpl: async (payload) => {
        calls.queued = payload;
        return {
          ok: true,
          queue_item_id: 9901,
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
  assert.equal(calls.queued.rendered_message_text, "Got it Jose, thanks. Would you be open to an offer on 5521 Laster Ln?");
  assert.equal(calls.queued.textgrid_number_item_id, 701);
  assert.equal(calls.queued.template_id ?? null, null);
  assert.equal(calls.queued.context.ids.phone_item_id, 401);
  assert.equal(calls.processed.queue_item_id, 9901);
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.result.phone_item_id, 401);
  assert.equal(response.payload.result.textgrid_number_item_id, 701);
});

test("direct-send returns 400 for missing required numbers", async () => {
  const { logger } = makeLogger();

  const response = await handleDirectSendRequestData(
    new Request("http://localhost/api/internal/outbound/direct-send", {
      method: "POST",
      body: JSON.stringify({
        to_number: "12087034955",
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
    }
  );

  assert.equal(response.status, 400);
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.error, "outbound_direct_send_failed");
  assert.equal(response.payload.message, "missing_from_number");
});

// ── Send-authorization fix (2026-11-11) ─────────────────────────────────────

function directSendRequest(headers = {}) {
  return new Request("http://localhost/api/internal/outbound/direct-send", {
    method: "POST",
    body: JSON.stringify({ from_number: "12085550111", to_number: "12087034955", message_text: "Manual reply" }),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function trippedDeps(calls, getSystemValue = HEALTHY) {
  const trip = (label) => async () => { calls.push(label); throw new Error(`${label} must not run`); };
  return {
    logger: makeLogger().logger,
    getSystemValue,
    findPhoneRecordImpl: trip("findPhoneRecord"),
    getItemImpl: trip("getItem"),
    fetchAllItemsImpl: trip("fetchAllItems"),
    buildSendQueueItemImpl: trip("buildSendQueueItem"),
    processSendQueueImpl: trip("processSendQueue"),
  };
}

test("direct-send refuses an unauthenticated request before any lookup, queue or send", async () => {
  for (const headers of [{}, { "x-internal-api-secret": "wrong" }, { authorization: "Bearer nope" }, { "x-queue-engine-secret": "test" }]) {
    const calls = [];
    const response = await handleDirectSendRequestData(directSendRequest(headers), "POST", trippedDeps(calls));
    assert.equal(response.status, 401, JSON.stringify(headers));
    assert.equal(response.payload.ok, false);
    assert.match(response.payload.error, /internal_api_secret_token$/);
    assert.deepEqual(calls, [], "no dependency ran");
  }
});

test("direct-send fails closed on absent campaign_mode, emergency stop, global shutdown and an unreadable control plane", async () => {
  for (const [getSystemValue, reason] of [
    [async () => null, "campaign_paused"],
    [async (k) => (k === "campaign_mode" ? "live_limited" : k === "queue_emergency_stop_at" ? "2026-11-11T00:00:00Z" : null), "queue_emergency_stop_active"],
    [async (k) => (k === "campaign_mode" ? "live_limited" : k === "global_send_shutdown_at" ? "2026-11-11T00:00:00Z" : null), "global_send_shutdown_active"],
    [async () => { throw new Error("down"); }, "control_plane_unreadable"],
  ]) {
    const calls = [];
    const response = await handleDirectSendRequestData(directSendRequest(AUTH), "POST", trippedDeps(calls, getSystemValue));
    assert.equal(response.status, 423, reason);
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.message, reason);
    assert.deepEqual(calls, [], `${reason}: no dependency ran`);
  }
});
