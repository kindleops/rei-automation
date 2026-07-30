/**
 * Podio network containment.
 *
 * Production carries zero Podio environment variables. Before this change the
 * codebase still attempted OAuth with undefined credentials on every Podio lane
 * (delivery webhook correlation, queue reconcile scans, inbound phone-lookup
 * fallback, system-alert reads/writes), which meant real network I/O plus, in
 * the delivery webhook's case, a 500 back to TextGrid for a receipt already
 * persisted in Supabase.
 *
 * These tests assert the guard refuses BEFORE any I/O and that each companion
 * lane degrades cleanly.
 */

import test from "node:test";
import assert from "node:assert/strict";

import "../helpers/critical-test-environment.mjs";

import {
  PodioError,
  podioRequest,
  hasPodioCredentials,
  getPodioAvailability,
  isPodioAvailable,
  isPodioUnavailableError,
  isPodioExplicitlyDisabled,
  buildPodioUnavailableError,
} from "@/lib/providers/podio.js";

const CREDENTIAL_KEYS = [
  "PODIO_CLIENT_ID",
  "PODIO_CLIENT_SECRET",
  "PODIO_USERNAME",
  "PODIO_PASSWORD",
];

/** Run fn with Podio credentials removed, then restore. */
async function withoutPodioCredentials(fn) {
  const saved = {};
  for (const key of CREDENTIAL_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of CREDENTIAL_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function withPodioDisabledFlag(fn) {
  const saved = process.env.PODIO_INTEGRATION_DISABLED;
  process.env.PODIO_INTEGRATION_DISABLED = "true";
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.PODIO_INTEGRATION_DISABLED;
    else process.env.PODIO_INTEGRATION_DISABLED = saved;
  }
}

// ── credential availability is evaluated at call time ────────────────────────

test("credential availability reflects the live environment", async () => {
  // The critical-test env sets PODIO_* = test, so Podio looks available here.
  assert.equal(hasPodioCredentials(), true);
  assert.equal(isPodioAvailable(), true);

  await withoutPodioCredentials(() => {
    assert.equal(hasPodioCredentials(), false);
    const availability = getPodioAvailability();
    assert.equal(availability.ok, false);
    assert.equal(availability.reason, "podio_credentials_unavailable");
    assert.deepEqual(availability.missing.sort(), [...CREDENTIAL_KEYS].sort());
  });
});

test("explicit kill switch disables Podio even with credentials present", async () => {
  assert.equal(isPodioExplicitlyDisabled(), false);
  await withPodioDisabledFlag(() => {
    assert.equal(isPodioExplicitlyDisabled(), true);
    const availability = getPodioAvailability();
    assert.equal(availability.ok, false);
    assert.equal(availability.reason, "podio_integration_disabled");
  });
});

// ── the chokepoint performs zero network I/O ─────────────────────────────────

test("podioRequest throws a typed error with zero network attempts when credentials are absent", async () => {
  await withoutPodioCredentials(async () => {
    // Trap any outbound socket/HTTP attempt: if the guard leaks, this fails.
    const attempts = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      attempts.push(args?.[0]);
      throw new Error("network_should_not_be_reached");
    };
    try {
      await assert.rejects(
        () => podioRequest("GET", "/item/123"),
        (error) => {
          assert.ok(error instanceof PodioError, "must be the typed Podio error");
          assert.equal(error.name, "PodioError");
          assert.equal(error.code, "podio_credentials_unavailable");
          assert.equal(error.operation, "podio_availability_guard");
          assert.equal(error.method, "GET");
          assert.equal(error.path, "/item/123");
          assert.equal(isPodioUnavailableError(error), true);
          return true;
        },
      );
      assert.deepEqual(attempts, [], "no network attempt may occur");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("podioRequest refuses for every HTTP verb when Podio is disabled", async () => {
  await withPodioDisabledFlag(async () => {
    for (const [method, path] of [
      ["GET", "/item/1"],
      ["POST", "/item/app/123/"],
      ["PUT", "/item/1"],
      ["DELETE", "/item/1"],
    ]) {
      await assert.rejects(
        () => podioRequest(method, path),
        (error) => error.code === "podio_integration_disabled" && isPodioUnavailableError(error),
      );
    }
  });
});

test("unavailable-error helper is distinguishable from a rate-limit error", () => {
  const unavailable = buildPodioUnavailableError(
    { ok: false, reason: "podio_credentials_unavailable", missing: ["PODIO_CLIENT_ID"] },
    "GET",
    "/x",
  );
  assert.equal(isPodioUnavailableError(unavailable), true);
  assert.equal(unavailable.cooldown_active, false);
  // A generic PodioError is not an unavailability error.
  assert.equal(isPodioUnavailableError(new PodioError("boom", { status: 500 })), false);
  assert.equal(isPodioUnavailableError(new Error("boom")), false);
});

// ── companion lane: delivery webhook must stay 2xx ───────────────────────────

test("delivery webhook skips the Podio lane and returns 2xx when Podio is unavailable", async () => {
  const { handleTextgridDeliveryRequest } = await import(
    "@/lib/webhooks/textgrid-delivery-request.js"
  );

  let podioCalled = false;
  const supabaseWrites = [];
  const request = {
    headers: { get: () => "application/json" },
    clone: () => ({ text: async () => JSON.stringify({ MessageSid: "SM1", MessageStatus: "delivered" }) }),
    json: async () => ({ MessageSid: "SM1", MessageStatus: "delivered" }),
  };

  const result = await handleTextgridDeliveryRequest(request, {
    logger: { info() {}, warn() {}, error() {} },
    verifyTextgridWebhookSignatureImpl: () => ({ ok: true, mode: "test", verified: true }),
    writeWebhookLogImpl: async (row) => {
      supabaseWrites.push(row);
      return { id: "log-1" };
    },
    processDeliveryWebhookLiveImpl: async () => ({ ok: true }),
    handleTextgridDeliveryImpl: async () => {
      podioCalled = true;
      return { ok: true };
    },
    getPodioAvailabilityImpl: () => ({
      ok: false,
      reason: "podio_credentials_unavailable",
      missing: CREDENTIAL_KEYS,
    }),
    recordLaunchCriticalAlertImpl: async () => ({ ok: true }),
  });

  assert.equal(result.status, 200);
  assert.equal(podioCalled, false, "Podio correlation must not be attempted");
  assert.equal(result.payload.result.skipped, true);
  assert.equal(result.payload.result.reason, "podio_credentials_unavailable");
});

test("delivery webhook contains a Podio failure instead of returning 500", async () => {
  const { handleTextgridDeliveryRequest } = await import(
    "@/lib/webhooks/textgrid-delivery-request.js"
  );

  const alerts = [];
  const request = {
    headers: { get: () => "application/json" },
    clone: () => ({ text: async () => JSON.stringify({ MessageSid: "SM2", MessageStatus: "failed" }) }),
    json: async () => ({ MessageSid: "SM2", MessageStatus: "failed" }),
  };

  const result = await handleTextgridDeliveryRequest(request, {
    logger: { info() {}, warn() {}, error() {} },
    verifyTextgridWebhookSignatureImpl: () => ({ ok: true, mode: "test", verified: true }),
    writeWebhookLogImpl: async () => ({ id: "log-2" }),
    processDeliveryWebhookLiveImpl: async () => ({ ok: true }),
    handleTextgridDeliveryImpl: async () => {
      throw new PodioError("Podio exploded", { status: 500 });
    },
    getPodioAvailabilityImpl: () => ({ ok: true, reason: null, missing: [] }),
    recordLaunchCriticalAlertImpl: async (alert) => {
      alerts.push(alert);
      return { ok: true };
    },
  });

  // The receipt is already durable in Supabase; the provider must not retry.
  assert.equal(result.status, 200);
  assert.equal(result.payload.result.contained, true);
  assert.equal(result.payload.result.reason, "podio_correlation_failed");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, "delivery_webhook_podio_lane_failed");
});

// ── companion lane: queue reconcile ─────────────────────────────────────────

test("queue reconcile skips its Podio lane when Podio is unavailable", async () => {
  const { handleQueueReconcileRequest } = await import(
    "@/lib/domain/queue/queue-reconcile-request.js"
  );
  const heartbeats = [];
  const responses = [];

  await handleQueueReconcileRequest(
    { url: "https://app.example.com/api/internal/queue/reconcile", json: async () => ({}) },
    "GET",
    {
      // The handler reads deps.requireCronOrEngineAuth — injecting the wrong key
      // would fall through to the real cron-auth import and make this test pass
      // or fail on ambient env rather than on the containment logic.
      requireCronOrEngineAuth: async () => ({
        authorized: true,
        auth: { authenticated: true },
        response: null,
      }),
      getSystemFlag: async () => true,
      // A Podio lane that must never be entered: if containment leaks, this throws.
      runQueueReconcileRunner: async () => {
        throw new Error("podio_reconcile_lane_should_not_run");
      },
      getPodioAvailability: () => ({
        ok: false,
        reason: "podio_credentials_unavailable",
        missing: CREDENTIAL_KEYS,
      }),
      setSystemValues: async (patch) => {
        heartbeats.push(patch);
        return { ok: true };
      },
      reconcileCanonicalQueueLifecycle: async () => ({ ok: true }),
      reconcileSupabaseDeliveryStatuses: async () => ({ ok: true }),
      reconcileCampaignExecutionHealth: async () => ({ ok: true }),
      logger: { info() {}, warn() {}, error() {} },
      jsonResponse: (body, init) => {
        responses.push({ body, status: init?.status ?? 200 });
        return { body, status: init?.status ?? 200 };
      },
    },
  );

  const heartbeat = heartbeats.at(-1) || {};
  assert.ok(heartbeats.length > 0, "heartbeat must be written, proving the handler ran");
  assert.equal(heartbeat.queue_reconcile_last_podio_ok, "false");
  // A deliberate containment skip must be distinguishable from a Podio outage.
  assert.equal(
    heartbeat.queue_reconcile_last_podio_state,
    "skipped_podio_credentials_unavailable",
  );
  assert.notEqual(responses[0]?.status, 500);
});

// ── companion lane: inbound context fallback ────────────────────────────────

test("inbound context fallback does not attempt the Podio phone lookup when unavailable", async () => {
  const { loadContextWithFallback } = await import(
    "@/lib/domain/context/load-context-with-fallback.js"
  );

  let podioLookupCalled = false;
  const context = await loadContextWithFallback({
    inbound_from: "+15551230000",
    inbound_to: "+15559990000",
    findRecentOutboundContextPairImpl: async () => null,
    loadContextImpl: async () => {
      podioLookupCalled = true;
      throw new Error("podio_lookup_should_not_run");
    },
    getPodioAvailabilityImpl: () => ({
      ok: false,
      reason: "podio_credentials_unavailable",
      missing: CREDENTIAL_KEYS,
    }),
  });

  assert.equal(podioLookupCalled, false);
  assert.equal(context.found, false);
  assert.equal(context.podio_skipped, true);
  assert.equal(context.podio_skip_reason, "podio_credentials_unavailable");
  assert.ok(context.lookup_sources_tried.includes("phone_skipped_podio_unavailable"));
});

// ── companion lane: system alerts must never throw into the caller ──────────

test("recordSystemAlert persists to Supabase and never throws when Podio is unavailable", async () => {
  await withoutPodioCredentials(async () => {
    const { recordSystemAlert } = await import("@/lib/domain/alerts/system-alerts.js");
    const result = await recordSystemAlert({
      subsystem: "queue",
      code: "runner_failed",
      severity: "high",
      summary: "queue runner failed",
    });
    assert.equal(result.podio_skipped, true);
    assert.equal(result.podio_skip_reason, "podio_unavailable");
    assert.equal(result.alert_item_id, null);
  });
});

test("resolveSystemAlert never throws when Podio is unavailable", async () => {
  await withoutPodioCredentials(async () => {
    const { resolveSystemAlert } = await import("@/lib/domain/alerts/system-alerts.js");
    const result = await resolveSystemAlert({ subsystem: "queue", code: "runner_failed" });
    assert.equal(result.ok, true);
    assert.equal(result.podio_skipped, true);
  });
});
