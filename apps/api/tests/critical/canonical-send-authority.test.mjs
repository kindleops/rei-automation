import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateCanonicalSendAuthority,
  CANONICAL_SEND_AUTHORITY_VERSION,
  REQUIRED_CONTROL_KEYS,
} from "@/lib/domain/queue/canonical-send-authority.js";
import { executeManualInboxSendNow } from "@/lib/domain/inbox/send-now-service.js";

// THE canonical runtime send authority (Part A).
//
// INVARIANT: no seller-visible message may be sent unless the same canonical
// runtime authority that protects normal queue execution authorizes it.
//
// This file is the adversarial matrix for the authority itself. Route-level and
// compliance-level enforcement live in manual-inbox-emergency-stop-enforced,
// compliance-entry-point-matrix and queue-execution-lockdown.

const AUTHORIZING = async (key) => {
  if (key === "queue_processor_mode") return "live";
  if (key === "queue_execution_mode") return "normal";
  if (key === "queue_emergency_stop_at") return null;
  return null;
};

const withValues = (overrides = {}) => async (key) =>
  Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : await AUTHORIZING(key);

// ── the permitting baseline (otherwise every deny below is vacuous) ──────────

test("an authorizing control plane permits, and names the authority", async () => {
  const r = await evaluateCanonicalSendAuthority({ getSystemValue: AUTHORIZING, action: "t" });
  assert.equal(r.ok, true);
  assert.equal(r.authority, "canonical_runtime");
  assert.equal(r.authority_version, CANONICAL_SEND_AUTHORITY_VERSION);
  assert.equal(r.queue_execution_mode, "normal");
});

// ── the three required controls, each denying on its own ─────────────────────

test("emergency stop DENIES", async () => {
  const r = await evaluateCanonicalSendAuthority({
    getSystemValue: withValues({ queue_emergency_stop_at: "2026-05-31T12:00:00.000Z" }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "queue_emergency_stop_active");
  assert.equal(r.sent, false);
});

test("queue_processor_mode=off DENIES", async () => {
  const r = await evaluateCanonicalSendAuthority({ getSystemValue: withValues({ queue_processor_mode: "off" }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "queue_processor_paused");
});

test("queue_execution_mode=scoped_canary_only DENIES unrestricted dispatch", async () => {
  const r = await evaluateCanonicalSendAuthority({ getSystemValue: withValues({ queue_execution_mode: "scoped_canary_only" }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "queue_execution_mode_scoped_canary_only");
});

test("queue_execution_mode=stopped DENIES", async () => {
  const r = await evaluateCanonicalSendAuthority({ getSystemValue: withValues({ queue_execution_mode: "stopped" }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "queue_execution_mode_stopped");
});

// ── fail closed: absence and malformation are never permission ───────────────

test("EVERY required control is load-bearing: removing any one DENIES", async () => {
  for (const key of REQUIRED_CONTROL_KEYS) {
    if (key === "queue_emergency_stop_at") continue; // absence of a brake is correct
    const r = await evaluateCanonicalSendAuthority({ getSystemValue: withValues({ [key]: null }) });
    assert.equal(r.ok, false, `${key} absent must deny`);
  }
});

test("absent / malformed / hostile control values DENY", async () => {
  const cases = [
    ["all absent", async () => null],
    ["empty strings", async () => ""],
    ["malformed processor mode", withValues({ queue_processor_mode: "¯\\_(ツ)_/¯" })],
    ["malformed execution mode", withValues({ queue_execution_mode: "totally-bogus" })],
    ["numeric junk", async () => 12345],
    ["object junk", async () => ({ nope: true })],
  ];
  for (const [label, getSystemValue] of cases) {
    const r = await evaluateCanonicalSendAuthority({ getSystemValue });
    assert.equal(r.ok, false, label);
  }
});

test("an unreadable control plane DENIES rather than throwing", async () => {
  const thrown = await evaluateCanonicalSendAuthority({
    getSystemValue: async () => { throw new Error("control plane down"); },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.reason, "control_plane_unreadable");

  const missing = await evaluateCanonicalSendAuthority({});
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "control_plane_unreadable");
});

// ── scoped canary: delegated, never skipped ─────────────────────────────────

test("scopedCanary delegates to the scoped-canary authorization architecture", async () => {
  const r = await evaluateCanonicalSendAuthority({
    getSystemValue: withValues({ queue_execution_mode: "scoped_canary_only" }),
    scopedCanary: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.authority, "scoped_canary_authorization");
});

test("scopedCanary must be exactly true; truthy values do not qualify", async () => {
  for (const v of ["true", 1, {}, [], "yes"]) {
    const r = await evaluateCanonicalSendAuthority({
      getSystemValue: withValues({ queue_emergency_stop_at: "2026-05-31T12:00:00.000Z" }),
      scopedCanary: v,
    });
    assert.equal(r.ok, false, `scopedCanary=${JSON.stringify(v)} must not confer authority`);
  }
});

// ── no input may manufacture authority ──────────────────────────────────────

test("INTERNAL/OPS secrets and operator intent are not send authority", async () => {
  // The authority reads ONLY the control plane. It takes no secret, header,
  // query parameter or operator flag, so none can influence its verdict.
  const raw = await (await import("node:fs/promises")).readFile(
    new URL("../../src/lib/domain/queue/canonical-send-authority.js", import.meta.url),
    "utf8"
  );
  // Strip comments: the header documents the defect being closed by name, which
  // is prose, not a code path.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  for (const forbidden of [
    "INTERNAL_API_SECRET",
    "OPS_DASHBOARD_SECRET",
    "operator_override",
    "force",
    "bypassed_queue_emergency_stop",
    "req.headers",
    "searchParams",
  ]) {
    assert.ok(!src.includes(forbidden), `authority must not consult ${forbidden}`);
  }
});

// ── end-to-end: a denied manual send touches nothing ────────────────────────

test("a denied manual send performs no claim, no insert, and no provider call", async () => {
  let touched = 0;
  let provider = 0;
  let created = 0;
  const result = await executeManualInboxSendNow(
    {
      thread_key: "+12146072916",
      to_phone_number: "+12146072916",
      from_phone_number: "+18885551212",
      message_body: "must never send",
      queue_key: "inbox:send_now:authority-proof",
    },
    {
      getSystemValue: withValues({ queue_execution_mode: "scoped_canary_only" }),
      supabase: { from() { touched += 1; throw new Error("send_queue must not be touched"); } },
      createQueueRowImpl: async () => { created += 1; return { ok: true, queue_row_id: "nope" }; },
      sendTextgridImpl: async () => { provider += 1; return { ok: true, sid: "nope" }; },
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "queue_execution_mode_scoped_canary_only");
  assert.equal(result.provider_attempted, false);
  assert.equal(result.provider_message_id, null);
  assert.equal(result.provider_message_sid, null);
  assert.equal(created, 0, "no queue row");
  assert.equal(touched, 0, "no send_queue access");
  assert.equal(provider, 0, "no provider call");
});

test("repeating a denied request is still denied (retries cannot wear the brake down)", async () => {
  let provider = 0;
  const deps = {
    getSystemValue: withValues({ queue_emergency_stop_at: "2026-05-31T12:00:00.000Z" }),
    supabase: { from() { throw new Error("must not touch send_queue"); } },
    createQueueRowImpl: async () => ({ ok: true, queue_row_id: "nope" }),
    sendTextgridImpl: async () => { provider += 1; return { ok: true }; },
  };
  const payload = {
    thread_key: "+12146072916",
    to_phone_number: "+12146072916",
    from_phone_number: "+18885551212",
    message_body: "retry proof",
    queue_key: "inbox:send_now:retry-proof",
  };
  for (let i = 0; i < 5; i += 1) {
    const r = await executeManualInboxSendNow(payload, deps);
    assert.equal(r.ok, false, `attempt ${i}`);
    assert.equal(r.reason, "queue_emergency_stop_active", `attempt ${i}`);
  }
  assert.equal(provider, 0, "no attempt may reach the provider");
});

// ── the route has no path to the wire except the gated one ──────────────────

test("the send-now route reaches a provider ONLY through the gated queue processor", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(
    new URL("../../src/app/api/internal/inbox/send-now/route.js", import.meta.url),
    "utf8"
  );

  // If the route ever imports a transport directly it would sidestep
  // processSendQueueItem, which is where the canonical authority lives.
  for (const transport of ["sendTextgrid", "textgrid-client", "sendSMS", "fetch("]) {
    assert.ok(!src.includes(transport), `route must not reach a transport directly: ${transport}`);
  }
  assert.ok(src.includes("processSendQueueItem"), "the gated processor must be the send path");

  // And that processor is the module carrying the canonical authority.
  const processor = await readFile(
    new URL("../../src/lib/domain/queue/process-send-queue.js", import.meta.url),
    "utf8"
  );
  assert.ok(
    processor.includes("evaluateCanonicalSendAuthority"),
    "processSendQueueItem must consult the canonical send authority"
  );

  const service = await readFile(
    new URL("../../src/lib/domain/inbox/send-now-service.js", import.meta.url),
    "utf8"
  );
  assert.ok(
    service.includes("evaluateCanonicalSendAuthority"),
    "executeManualInboxSendNow must consult the canonical send authority"
  );
  // The old bypass vocabulary must never gate again.
  assert.ok(
    !/if\s*\([^)]*bypassed_(runtime_brake|queue_emergency_stop)/.test(service),
    "no branch may key off the legacy bypass flags"
  );
});
