import assert from "node:assert/strict";
import test from "node:test";

import { handleQueueReconcileRequest } from "@/lib/domain/queue/queue-reconcile-request.js";

function buildRequest(url = "https://api.example.com/api/internal/queue/reconcile") {
  return {
    url,
    headers: {
      get(name) {
        if (name === "host") return "api.example.com";
        return null;
      },
    },
    json: async () => ({}),
  };
}

test("queue reconcile returns 200 when canonical lifecycle succeeds and Podio fails", async () => {
  let lifecycleCalled = false;
  const response = await handleQueueReconcileRequest(buildRequest(), "GET", {
    logger: { info() {}, warn() {}, error() {} },
    requireCronOrEngineAuth: async () => ({
      authorized: true,
      auth: { authenticated: true, is_vercel_cron: true },
    }),
    getSystemFlag: async () => true,
    reconcileCanonicalQueueLifecycle: async () => ({
      ok: true,
      reconciled_rows: 0,
      lifecycle_version: "stale-expiration-containment-v3",
    }),
    reconcileSupabaseDeliveryStatuses: async () => ({ ok: true, total_normalized: 0 }),
    setSystemValues: async () => ({}),
    runQueueReconcileRunner: async () => {
      throw new Error("Sorry, you've supplied an invalid client id.");
    },
    jsonResponse: (payload, init = {}) => ({
      status: init.status || 200,
      payload,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.canonical_lifecycle_reconcile.ok, true);
  assert.equal(
    response.payload.optional_integrations.podio_queue_reconcile.ok,
    false
  );
  lifecycleCalled = response.payload.canonical_lifecycle_reconcile.reconciled_rows !== undefined;
  assert.equal(lifecycleCalled, true);
});