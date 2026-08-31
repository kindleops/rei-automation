/**
 * durable-state-backend-contract.test.mjs
 *
 * Proves that no process-local (filesystem) correctness state can be selected
 * in production, and that the backend selector fails closed rather than
 * silently degrading.
 *
 * This is the guard that makes multi-instance operation safe: run locks and
 * idempotency claims MUST be shared state. An in-process Map is correct for a
 * single test process and catastrophically wrong for two instances, so
 * production may only ever resolve to Postgres.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DURABLE_BACKEND_MEMORY,
  DURABLE_BACKEND_POSTGRES,
  resolveDurableBackendName,
  assertDurableBackendAllowed,
  getDurableBackend,
} from "@/lib/domain/runtime/durable-state-backend.js";

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("default backend under NODE_ENV=test is the in-process memory backend", () => {
  withEnv({ NODE_ENV: "test", RUNTIME_STATE_BACKEND: undefined }, () => {
    assert.equal(resolveDurableBackendName(), DURABLE_BACKEND_MEMORY);
  });
});

test("default backend outside tests is Postgres", () => {
  withEnv({ NODE_ENV: "development", RUNTIME_STATE_BACKEND: undefined }, () => {
    assert.equal(resolveDurableBackendName(), DURABLE_BACKEND_POSTGRES);
  });
  withEnv({ NODE_ENV: "production", RUNTIME_STATE_BACKEND: undefined }, () => {
    assert.equal(resolveDurableBackendName(), DURABLE_BACKEND_POSTGRES);
  });
});

test("production REFUSES the in-process backend instead of silently degrading", () => {
  withEnv({ NODE_ENV: "production", RUNTIME_STATE_BACKEND: "memory" }, () => {
    assert.throws(
      () => assertDurableBackendAllowed(),
      /durable_state_backend_forbidden_in_production/,
      "selecting memory in production must throw"
    );
    assert.throws(
      () => getDurableBackend(),
      /durable_state_backend_forbidden_in_production/,
      "the guard must also fire on the resolution path callers actually use"
    );
  });
});

test("production accepts Postgres", () => {
  withEnv({ NODE_ENV: "production", RUNTIME_STATE_BACKEND: "postgres" }, () => {
    assert.equal(assertDurableBackendAllowed(), DURABLE_BACKEND_POSTGRES);
    assert.equal(getDurableBackend().name, DURABLE_BACKEND_POSTGRES);
  });
});

test("an unknown backend name is rejected, never coerced to a default", () => {
  withEnv({ NODE_ENV: "development", RUNTIME_STATE_BACKEND: "filesystem" }, () => {
    assert.throws(
      () => resolveDurableBackendName(),
      /unknown_runtime_state_backend:filesystem/,
      "the deleted filesystem backend must not resolve to anything"
    );
  });
  withEnv({ NODE_ENV: "development", RUNTIME_STATE_BACKEND: "redis" }, () => {
    assert.throws(() => resolveDurableBackendName(), /unknown_runtime_state_backend/);
  });
});

test("the filesystem runtime-state store is gone from the tree entirely", async () => {
  await assert.rejects(
    () => import("@/lib/domain/runtime/runtime-state-store.js"),
    "runtime-state-store.js must no longer exist; /tmp is not a correctness store"
  );
});
