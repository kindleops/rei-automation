// ─── seller-burst-internal-proof-gate.test.mjs ───────────────────────────────
// Burst activation modes and the internal-proof burst gate:
//   * SELLER_INBOUND_BURST_ENABLED boolean-truthy → enabled (unchanged);
//     "internal_proof" → internal-proof mode; anything else → disabled.
//   * In internal_proof mode the webhook engages burst ONLY for an internal
//     test phone AND an active bounded internal-proof session; every failure
//     mode (real seller thread, no session, expired session, session lookup
//     error) leaves burst disabled for that message. Real seller burst
//     behavior stays off until the full proof passes.

import test from "node:test";
import assert from "node:assert/strict";

import "../helpers/critical-test-environment.mjs";

import {
  resolveSellerInboundBurstMode,
  isSellerInboundBurstEnabledForThread,
} from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";

import {
  handleTextgridInboundWebhook,
  __setTextgridInboundTestDeps,
  __resetTextgridInboundTestDeps,
} from "@/lib/flows/handle-textgrid-inbound.js";

// ── mode resolver ────────────────────────────────────────────────────────────

test("burst mode resolution: boolean-truthy → enabled, internal_proof → internal_proof, else disabled", () => {
  assert.equal(resolveSellerInboundBurstMode({ env: { SELLER_INBOUND_BURST_ENABLED: "true" } }), "enabled");
  assert.equal(resolveSellerInboundBurstMode({ env: { SELLER_INBOUND_BURST_ENABLED: "1" } }), "enabled");
  assert.equal(resolveSellerInboundBurstMode({ env: { SELLER_INBOUND_BURST_ENABLED: "on" } }), "enabled");
  assert.equal(
    resolveSellerInboundBurstMode({ env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" } }),
    "internal_proof"
  );
  assert.equal(
    resolveSellerInboundBurstMode({ env: { SELLER_INBOUND_BURST_ENABLED: "INTERNAL_PROOF" } }),
    "internal_proof"
  );
  assert.equal(resolveSellerInboundBurstMode({ env: {} }), "disabled");
  assert.equal(resolveSellerInboundBurstMode({ env: { SELLER_INBOUND_BURST_ENABLED: "false" } }), "disabled");
  assert.equal(
    resolveSellerInboundBurstMode({ env: { SELLER_INBOUND_BURST_ENABLED: "sideways" } }),
    "disabled",
    "unknown values fail closed"
  );
});

test("thread-scoped gate: internal_proof engages only internal phones; enabled engages all; disabled none", () => {
  const internal = () => true;
  const external = () => false;

  assert.equal(
    isSellerInboundBurstEnabledForThread({
      thread_key: "+16128072000",
      env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" },
      isInternalPhone: internal,
    }),
    true
  );
  assert.equal(
    isSellerInboundBurstEnabledForThread({
      thread_key: "+15559990000",
      env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" },
      isInternalPhone: external,
    }),
    false,
    "a real seller thread can never engage burst in internal_proof mode"
  );
  assert.equal(
    isSellerInboundBurstEnabledForThread({
      thread_key: "+15559990000",
      env: { SELLER_INBOUND_BURST_ENABLED: "true" },
      isInternalPhone: external,
    }),
    true
  );
  assert.equal(
    isSellerInboundBurstEnabledForThread({
      thread_key: "+16128072000",
      env: {},
      isInternalPhone: internal,
    }),
    false
  );
  assert.equal(
    isSellerInboundBurstEnabledForThread({
      thread_key: "",
      env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" },
      isInternalPhone: internal,
    }),
    false,
    "no thread key → no burst"
  );
  assert.equal(
    isSellerInboundBurstEnabledForThread({ thread_key: "x", enabled: true, env: {} }),
    true,
    "explicit override wins"
  );
});

// ── webhook integration ──────────────────────────────────────────────────────

const PAYLOAD = {
  SmsMessageSid: "SMBURSTGATE1",
  From: "+16128072000",
  To: "+16128060495",
  Body: "internal proof fragment",
  SmsStatus: "received",
  http_received_at: "2026-08-02T15:00:00.000Z",
};

function gateDeps(overrides = {}) {
  return {
    getSystemFlags: async () => ({}),
    getSystemValue: async () => null,
    normalizeInboundTextgridPhone: (v) => v,
    getSupabaseClient: () => null,
    claimInboundProcessing: async () => ({
      ok: false,
      authority: "unavailable",
      outcome: null,
      reason: "supabase_unconfigured",
      fail_closed: false,
    }),
    beginIdempotentProcessing: async () => ({
      ok: true,
      duplicate: false,
      record_item_id: null,
    }),
    beginInboundLedgerEntry: async () => ({ ok: true, ledger_id: "led-gate" }),
    recordInboundTerminalDisposition: async () => ({ ok: true }),
    ...overrides,
  };
}

async function runGate({ mode, internal_phone, session, session_error = false }) {
  const loader_calls = [];
  __setTextgridInboundTestDeps(
    gateDeps({
      resolveSellerInboundBurstMode: () => mode,
      isSellerInboundBurstEnabled: () => mode === "enabled",
      isInternalTestPhone: () => internal_phone,
      loadActiveInternalProofSession: async (args) => {
        loader_calls.push(args);
        if (session_error) throw new Error("system_control unavailable");
        return session;
      },
    })
  );
  try {
    const result = await handleTextgridInboundWebhook(
      { ...PAYLOAD },
      { inbound_debug_stage: "after_message_event_lookup" }
    );
    return { result, loader_calls };
  } finally {
    __resetTextgridInboundTestDeps();
  }
}

test("internal_proof + internal phone + active session engages burst for the message", async () => {
  const { result, loader_calls } = await runGate({
    mode: "internal_proof",
    internal_phone: true,
    session: { active: true, session: { session_id: "proof-1" } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.seller_burst_mode, "internal_proof");
  assert.equal(result.seller_burst_enabled, true);
  assert.equal(loader_calls.length, 1, "session must be checked");
});

test("internal_proof + internal phone WITHOUT an active session leaves burst disabled", async () => {
  const { result } = await runGate({
    mode: "internal_proof",
    internal_phone: true,
    session: { active: false, reason: "session_expired" },
  });
  assert.equal(result.seller_burst_enabled, false);
});

test("internal_proof session lookup failure fails closed (burst disabled)", async () => {
  const { result } = await runGate({
    mode: "internal_proof",
    internal_phone: true,
    session: null,
    session_error: true,
  });
  assert.equal(result.seller_burst_enabled, false);
});

test("internal_proof mode never checks the session for a real seller thread and never engages", async () => {
  const { result, loader_calls } = await runGate({
    mode: "internal_proof",
    internal_phone: false,
    session: { active: true, session: { session_id: "proof-1" } },
  });
  assert.equal(result.seller_burst_enabled, false);
  assert.equal(loader_calls.length, 0, "real seller threads must not even consult the session");
});

test("globally enabled mode engages burst without consulting the proof session", async () => {
  const { result, loader_calls } = await runGate({
    mode: "enabled",
    internal_phone: false,
    session: { active: true, session: { session_id: "proof-1" } },
  });
  assert.equal(result.seller_burst_enabled, true);
  assert.equal(loader_calls.length, 0);
});

test("disabled mode leaves burst off everywhere", async () => {
  const { result, loader_calls } = await runGate({
    mode: "disabled",
    internal_phone: true,
    session: { active: true, session: { session_id: "proof-1" } },
  });
  assert.equal(result.seller_burst_enabled, false);
  assert.equal(loader_calls.length, 0);
});
