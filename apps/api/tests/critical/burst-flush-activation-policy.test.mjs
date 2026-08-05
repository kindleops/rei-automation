// Activation authority for the seller-inbound burst FLUSH worker.
//
// The defect being pinned: the flush worker built its coordinator with a
// hardcoded `enabled: true`, which short-circuited ALL mode resolution and made
// the worker globally live regardless of SELLER_INBOUND_BURST_ENABLED.
//
// The subtlety these tests exist to pin: the preserved 2026-08-03 incident
// burst (first_received_at 22:40:31Z) was created INSIDE the old proof
// session's window (22:37:12Z → 23:09:22Z). A naive "burst inside SOME session
// window" rule ADMITS it. Every temporal bound here must come from the
// CURRENTLY ACTIVE session, so a session opened today excludes it.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BURST_FLUSH_ACTIVATION_MODES,
  BURST_FLUSH_ACTIVATION_SCOPES,
  BURST_FLUSH_ACTIVATION_REASONS as R,
  resolveBurstFlushActivationPolicy,
  isBurstAdmittedByActivationPolicy,
  loadBurstFlushActivationPolicy,
} from "@/lib/domain/seller-flow/burst-flush-activation-policy.js";

const PINNED_RECIPIENT = "+16128072000";
const PINNED_SENDER = "+16128060495";
const PINNED_CAMPAIGN = "b7c9a000-7ad3-468b-9b9b-4647dbefc35f";
// Registered internal test number that is NOT the pinned proof recipient.
const OTHER_INTERNAL = "+16127433952";
const REAL_SELLER = "+19015551234";

// "Now" for every current-state assertion.
const NOW = new Date("2026-08-05T12:00:00.000Z");

// The real closed session as it exists in production today (verbatim shape).
const PRODUCTION_CLOSED_SESSION = Object.freeze({
  session_id: "proof-20260803T223712Z",
  campaign_id: PINNED_CAMPAIGN,
  queue_row_id: "3f1c5f4e-0b6a-4a3e-9a1f-0c9a2f7d5b11",
  recipient: PINNED_RECIPIENT,
  sender: PINNED_SENDER,
  created_at: "2026-08-03T22:37:12.343Z",
  expires_at: "2026-08-03T23:09:22.563Z",
  allow_thread_auto_replies: true,
  opened_by: "operator_internal_proof_runbook",
  closed_at: "2026-08-03T23:09:23.563Z",
});

// A session opened today, still open.
function activeSession(overrides = {}) {
  return {
    session_id: "proof-20260805T115500Z",
    campaign_id: PINNED_CAMPAIGN,
    queue_row_id: "8c2e1a90-77bd-4f0e-b3d2-6a4c8e01f992",
    recipient: PINNED_RECIPIENT,
    sender: PINNED_SENDER,
    created_at: "2026-08-05T11:55:00.000Z",
    expires_at: "2026-08-05T13:00:00.000Z",
    allow_thread_auto_replies: true,
    opened_by: "operator_internal_proof_runbook",
    ...overrides,
  };
}

// The preserved incident burst — never mutated, only read.
const PRESERVED_INCIDENT_BURST = Object.freeze({
  thread_key: PINNED_RECIPIENT,
  burst_id: "sib:+16128072000:g1:ba199924",
  generation: 1,
  first_received_at: "2026-08-03T22:40:31.000Z",
  eligible_at: "2026-08-03T22:40:51.000Z",
  created_at: "2026-08-03T22:40:31.200Z",
});

function burst(overrides = {}) {
  return {
    thread_key: PINNED_RECIPIENT,
    burst_id: "sib:+16128072000:g7:abc123",
    generation: 7,
    first_received_at: "2026-08-05T12:00:00.000Z",
    created_at: "2026-08-05T12:00:00.100Z",
    ...overrides,
  };
}

function policyFor(session, now = NOW) {
  return resolveBurstFlushActivationPolicy({
    mode: BURST_FLUSH_ACTIVATION_MODES.INTERNAL_PROOF,
    session_raw: JSON.stringify(session),
    now,
  });
}

// ── Mode resolution ─────────────────────────────────────────────────────────

test("mode: unset env resolves to disabled with a hard no-op", () => {
  const policy = resolveBurstFlushActivationPolicy({ env: {}, now: NOW });
  assert.equal(policy.mode, BURST_FLUSH_ACTIVATION_MODES.DISABLED);
  assert.equal(policy.may_scan, false);
  assert.equal(policy.may_claim, false);
  assert.equal(policy.scope, BURST_FLUSH_ACTIVATION_SCOPES.NONE);
  assert.equal(policy.reason, R.DISABLED_NOOP);
  assert.equal(policy.allowed_thread_key, null);
  assert.equal(policy.received_not_before, null);
  assert.equal(policy.received_not_after, null);
});

test("mode: boolean-truthy env values resolve to global activation", () => {
  for (const raw of ["true", "1", "on", "yes", "TRUE", "On"]) {
    const policy = resolveBurstFlushActivationPolicy({
      env: { SELLER_INBOUND_BURST_ENABLED: raw },
      now: NOW,
    });
    assert.equal(policy.mode, BURST_FLUSH_ACTIVATION_MODES.ENABLED, raw);
    assert.equal(policy.may_scan, true, raw);
    assert.equal(policy.may_claim, true, raw);
    assert.equal(policy.scope, BURST_FLUSH_ACTIVATION_SCOPES.GLOBAL, raw);
    assert.equal(policy.allowed_thread_key, null, raw);
    assert.equal(policy.reason, R.GLOBAL_ACTIVATION, raw);
  }
});

test("mode: unknown values resolve to disabled, NEVER to enabled", () => {
  for (const raw of ["sideways", "2", "internal-proof", "", "enabled_maybe", "off", "false", "null"]) {
    const policy = resolveBurstFlushActivationPolicy({
      env: { SELLER_INBOUND_BURST_ENABLED: raw },
      now: NOW,
    });
    assert.equal(policy.mode, BURST_FLUSH_ACTIVATION_MODES.DISABLED, raw);
    assert.notEqual(policy.mode, BURST_FLUSH_ACTIVATION_MODES.ENABLED, raw);
    assert.equal(policy.may_scan, false, raw);
    assert.equal(policy.may_claim, false, raw);
  }
});

test("mode: there is NO boolean override — the original defect is unrepresentable", () => {
  // The old gate did `if (enabled != null) return Boolean(enabled)`, which is
  // exactly how the flush worker went globally live. No such parameter exists
  // here: unknown keys are ignored and mode resolution always runs.
  for (const override of [{ enabled: true }, { enabled: 1 }, { enabled: "true" }, { force: true }]) {
    const policy = resolveBurstFlushActivationPolicy({ env: {}, now: NOW, ...override });
    assert.equal(policy.mode, BURST_FLUSH_ACTIVATION_MODES.DISABLED, JSON.stringify(override));
    assert.equal(policy.may_scan, false, JSON.stringify(override));
    assert.equal(policy.may_claim, false, JSON.stringify(override));
  }
});

// ── disabled semantics ──────────────────────────────────────────────────────

test("disabled: even a perfectly matching internal burst is denied", () => {
  const policy = resolveBurstFlushActivationPolicy({ env: {}, now: NOW });
  const verdict = isBurstAdmittedByActivationPolicy({ policy, burst: burst() });
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, R.NOT_ACTIVATED);
  assert.equal(verdict.policy_reason, R.DISABLED_NOOP);
});

// ── internal_proof: session resolution ──────────────────────────────────────

test("internal_proof: session resolution failures all deny, none fall back to global", () => {
  const cases = [
    ["not configured", null, "session_not_configured"],
    ["empty string", "", "session_not_configured"],
    ["invalid json", "{not json", "session_invalid_json"],
    ["expired", JSON.stringify(activeSession({ expires_at: "2026-08-05T11:59:00.000Z" })), "session_expired"],
    [
      "recipient not pinned",
      JSON.stringify(activeSession({ recipient: OTHER_INTERNAL })),
      "session_recipient_not_pinned",
    ],
    [
      "sender not pinned",
      JSON.stringify(activeSession({ sender: "+16125550000" })),
      "session_sender_not_pinned",
    ],
    ["missing session_id", JSON.stringify(activeSession({ session_id: "" })), "session_id_required"],
  ];
  for (const [label, session_raw, expected_reason] of cases) {
    const policy = resolveBurstFlushActivationPolicy({
      mode: BURST_FLUSH_ACTIVATION_MODES.INTERNAL_PROOF,
      session_raw,
      now: NOW,
    });
    assert.equal(policy.reason, expected_reason, label);
    assert.equal(policy.may_scan, false, label);
    assert.equal(policy.may_claim, false, label);
    assert.equal(policy.scope, BURST_FLUSH_ACTIVATION_SCOPES.NONE, label);
    assert.equal(policy.allowed_thread_key, null, label);
    // The critical anti-regression: a failed session lookup is never global.
    assert.notEqual(policy.mode, BURST_FLUSH_ACTIVATION_MODES.ENABLED, label);
  }
});

test("internal_proof: closed_at <= now is terminal even when expires_at is in the future", () => {
  // The shared parser ignores closed_at entirely — verified: a session with
  // closed_at 22:40Z and expires_at 23:09Z parses ok:true at 22:50Z. This
  // module layers the check so an operator who closed a session is actually
  // safe.
  const policy = policyFor(activeSession({ closed_at: "2026-08-05T11:58:00.000Z" }));
  assert.equal(policy.reason, R.SESSION_CLOSED);
  assert.equal(policy.may_scan, false);
  assert.equal(policy.may_claim, false);
});

test("internal_proof: a future closed_at does not deactivate a live session", () => {
  const policy = policyFor(activeSession({ closed_at: "2026-08-05T12:59:00.000Z" }));
  assert.equal(policy.reason, R.INTERNAL_PROOF_SESSION_ACTIVE);
  assert.equal(policy.may_claim, true);
});

test("internal_proof: an unparseable closed_at fails closed", () => {
  const policy = policyFor(activeSession({ closed_at: "whenever" }));
  assert.equal(policy.reason, R.SESSION_CLOSED_AT_INVALID);
  assert.equal(policy.may_claim, false);
});

test("internal_proof: an absent closed_at is fine (field is optional)", () => {
  const policy = policyFor(activeSession());
  assert.equal(policy.reason, R.INTERNAL_PROOF_SESSION_ACTIVE);
  assert.equal(policy.may_claim, true);
});

test("internal_proof: an active session is thread-scoped and carries its OWN window", () => {
  const session = activeSession();
  const policy = policyFor(session);
  assert.equal(policy.mode, BURST_FLUSH_ACTIVATION_MODES.INTERNAL_PROOF);
  assert.equal(policy.may_scan, true);
  assert.equal(policy.may_claim, true);
  assert.equal(policy.scope, BURST_FLUSH_ACTIVATION_SCOPES.THREAD);
  assert.equal(policy.allowed_thread_key, PINNED_RECIPIENT);
  assert.equal(policy.proof_session_id, session.session_id);
  assert.equal(policy.received_not_before, session.created_at);
  assert.equal(policy.received_not_after, session.expires_at);
  // Contract: a non-null allowed_thread_key obliges the caller to scope the scan.
  assert.notEqual(policy.allowed_thread_key, null);
  assert.equal(policy.scope, BURST_FLUSH_ACTIVATION_SCOPES.THREAD);
});

test("internal_proof: a throwing session parser is alertable, not permissive", () => {
  const policy = resolveBurstFlushActivationPolicy({
    mode: BURST_FLUSH_ACTIVATION_MODES.INTERNAL_PROOF,
    session_raw: JSON.stringify(activeSession()),
    now: NOW,
    parseSession: () => {
      throw new Error("boom");
    },
  });
  assert.equal(policy.may_scan, false);
  assert.equal(policy.may_claim, false);
  assert.equal(policy.alertable, true);
  assert.match(policy.reason, /^activation_policy_resolution_failed:boom$/);
});

test("mode resolution that throws is alertable and disabled", () => {
  const policy = resolveBurstFlushActivationPolicy({
    now: NOW,
    resolveMode: () => {
      throw new Error("env_read_failed");
    },
  });
  assert.equal(policy.mode, BURST_FLUSH_ACTIVATION_MODES.DISABLED);
  assert.equal(policy.may_claim, false);
  assert.equal(policy.alertable, true);
});

// ── THE INCIDENT: the preserved 2026-08-03 burst ────────────────────────────

test("INCIDENT: the production closed session yields no scan when evaluated today", () => {
  // Verbatim production artifact, not a synthetic one. It is both expired and
  // closed; expiry is reached first, and either alone denies.
  const policy = resolveBurstFlushActivationPolicy({
    mode: BURST_FLUSH_ACTIVATION_MODES.INTERNAL_PROOF,
    session_raw: JSON.stringify(PRODUCTION_CLOSED_SESSION),
    now: NOW,
  });
  assert.equal(policy.may_scan, false);
  assert.equal(policy.may_claim, false);
  assert.equal(policy.scope, BURST_FLUSH_ACTIVATION_SCOPES.NONE);
  assert.equal(policy.allowed_thread_key, null);
  assert.equal(policy.reason, "session_expired");

  // …and therefore the preserved burst is not claimable through it.
  const verdict = isBurstAdmittedByActivationPolicy({
    policy,
    burst: PRESERVED_INCIDENT_BURST,
  });
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, R.NOT_ACTIVATED);
});

test("INCIDENT: a NEW session opened today excludes the preserved 2026-08-03 burst", () => {
  // This is the case a naive "inside some session window" rule gets wrong: the
  // preserved burst IS inside the old session's window. Binding to the ACTIVE
  // session's own window is what excludes it.
  const policy = policyFor(activeSession());
  assert.equal(policy.may_claim, true, "policy itself is active");

  const verdict = isBurstAdmittedByActivationPolicy({
    policy,
    burst: PRESERVED_INCIDENT_BURST,
  });
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, R.BURST_RECEIVED_BEFORE_SESSION);
});

test("INCIDENT: the preserved burst sits inside the OLD window — proving the naive rule would admit it", () => {
  const old_start = Date.parse(PRODUCTION_CLOSED_SESSION.created_at);
  const old_end = Date.parse(PRODUCTION_CLOSED_SESSION.expires_at);
  const first = Date.parse(PRESERVED_INCIDENT_BURST.first_received_at);
  assert.ok(first > old_start && first < old_end, "burst is inside the old session window");
  // Yet under this policy there is no reachable state that admits it:
  // no session, the old session, and a new session all deny.
  const no_session = resolveBurstFlushActivationPolicy({
    mode: BURST_FLUSH_ACTIVATION_MODES.INTERNAL_PROOF,
    session_raw: null,
    now: NOW,
  });
  assert.equal(
    isBurstAdmittedByActivationPolicy({ policy: no_session, burst: PRESERVED_INCIDENT_BURST }).admitted,
    false
  );
});

// ── internal_proof: per-burst admission ─────────────────────────────────────

test("internal_proof: a burst on the pinned thread inside the active window is admitted", () => {
  const session = activeSession();
  const policy = policyFor(session);
  const verdict = isBurstAdmittedByActivationPolicy({
    policy,
    burst: burst({
      first_received_at: "2026-08-05T12:10:00.000Z",
      created_at: "2026-08-05T12:10:00.050Z",
    }),
  });
  assert.equal(verdict.admitted, true);
  assert.equal(verdict.reason, R.ADMITTED);
  assert.equal(verdict.proof_session_id, session.session_id);
});

test("internal_proof: a real seller thread inside the window is denied", () => {
  const policy = policyFor(activeSession());
  const verdict = isBurstAdmittedByActivationPolicy({
    policy,
    burst: burst({ thread_key: REAL_SELLER }),
  });
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, R.THREAD_KEY_NOT_ALLOWED);
});

test("internal_proof: registry membership is NOT sufficient — only the pinned recipient", () => {
  // +16127433952 is in INTERNAL_TEST_PHONE_SET but is not the pinned proof
  // recipient. A phone-only gate would admit it; this policy must not.
  const policy = policyFor(activeSession());
  const verdict = isBurstAdmittedByActivationPolicy({
    policy,
    burst: burst({ thread_key: OTHER_INTERNAL }),
  });
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, R.THREAD_KEY_NOT_ALLOWED);
});

test("internal_proof: temporal and provenance denial matrix", () => {
  const policy = policyFor(activeSession()); // 11:55:00.000Z → 13:00:00.000Z
  const cases = [
    [
      "received after expiry",
      burst({ first_received_at: "2026-08-05T13:00:00.001Z", created_at: "2026-08-05T13:00:00.001Z" }),
      R.BURST_RECEIVED_AFTER_SESSION,
    ],
    [
      "received before window",
      burst({ first_received_at: "2026-08-05T11:54:59.999Z", created_at: "2026-08-05T12:00:00.000Z" }),
      R.BURST_RECEIVED_BEFORE_SESSION,
    ],
    [
      "backdated artifact: in-window first_received, created before window",
      burst({ first_received_at: "2026-08-05T12:10:00.000Z", created_at: "2026-08-05T11:00:00.000Z" }),
      R.BURST_CREATED_BEFORE_SESSION,
    ],
    [
      "created after window",
      burst({ first_received_at: "2026-08-05T12:10:00.000Z", created_at: "2026-08-05T13:30:00.000Z" }),
      R.BURST_CREATED_AFTER_SESSION,
    ],
    ["created_at missing", burst({ created_at: null }), R.BURST_CREATED_AT_MISSING],
    ["created_at empty", burst({ created_at: "   " }), R.BURST_CREATED_AT_MISSING],
    ["created_at unparseable", burst({ created_at: "not-a-date" }), R.BURST_CREATED_AT_INVALID],
    [
      "first_received_at missing",
      burst({ first_received_at: null }),
      R.BURST_FIRST_RECEIVED_AT_INVALID,
    ],
    [
      "first_received_at unparseable",
      burst({ first_received_at: "sometime" }),
      R.BURST_FIRST_RECEIVED_AT_INVALID,
    ],
    ["thread_key missing", burst({ thread_key: null }), R.THREAD_KEY_MISSING],
    ["no burst at all", null, R.MISSING_BURST],
  ];
  for (const [label, candidate, expected] of cases) {
    const verdict = isBurstAdmittedByActivationPolicy({ policy, burst: candidate });
    assert.equal(verdict.admitted, false, label);
    assert.equal(verdict.reason, expected, label);
  }
});

test("internal_proof: window bounds are inclusive at both ends", () => {
  const session = activeSession();
  const policy = policyFor(session);
  const at_start = isBurstAdmittedByActivationPolicy({
    policy,
    burst: burst({ first_received_at: session.created_at, created_at: session.created_at }),
  });
  assert.equal(at_start.admitted, true, "exactly at created_at");
  const at_end = isBurstAdmittedByActivationPolicy({
    policy,
    burst: burst({ first_received_at: session.expires_at, created_at: session.expires_at }),
  });
  assert.equal(at_end.admitted, true, "exactly at expires_at");
});

// ── enabled semantics are unchanged ─────────────────────────────────────────

test("enabled: global activation admits any burst, including real sellers", () => {
  const policy = resolveBurstFlushActivationPolicy({
    env: { SELLER_INBOUND_BURST_ENABLED: "true" },
    now: NOW,
  });
  for (const thread_key of [REAL_SELLER, PINNED_RECIPIENT, OTHER_INTERNAL]) {
    const verdict = isBurstAdmittedByActivationPolicy({ policy, burst: burst({ thread_key }) });
    assert.equal(verdict.admitted, true, thread_key);
    assert.equal(verdict.reason, R.ADMITTED, thread_key);
  }
  // Even the preserved burst — global mode is deliberately unchanged, and the
  // containment for it comes from never selecting `enabled`.
  assert.equal(
    isBurstAdmittedByActivationPolicy({ policy, burst: PRESERVED_INCIDENT_BURST }).admitted,
    true
  );
});

// ── async loader ────────────────────────────────────────────────────────────

test("loader: disabled mode never reads the session at all", async () => {
  let reads = 0;
  const policy = await loadBurstFlushActivationPolicy({
    env: {},
    now: NOW,
    getSystemValue: async () => {
      reads += 1;
      return null;
    },
  });
  assert.equal(policy.mode, BURST_FLUSH_ACTIVATION_MODES.DISABLED);
  assert.equal(policy.may_scan, false);
  assert.equal(reads, 0);
});

test("loader: internal_proof reads the session and resolves it", async () => {
  const session = activeSession();
  const keys = [];
  const policy = await loadBurstFlushActivationPolicy({
    env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" },
    now: NOW,
    getSystemValue: async (key) => {
      keys.push(key);
      return JSON.stringify(session);
    },
  });
  assert.deepEqual(keys, ["internal_proof_session"]);
  assert.equal(policy.may_claim, true);
  assert.equal(policy.allowed_thread_key, PINNED_RECIPIENT);
  assert.equal(policy.proof_session_id, session.session_id);
});

test("loader: a failing session lookup is alertable and never global", async () => {
  const policy = await loadBurstFlushActivationPolicy({
    env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" },
    now: NOW,
    getSystemValue: async () => {
      throw new Error("supabase_down");
    },
  });
  assert.equal(policy.mode, BURST_FLUSH_ACTIVATION_MODES.INTERNAL_PROOF);
  assert.equal(policy.may_scan, false);
  assert.equal(policy.may_claim, false);
  assert.equal(policy.scope, BURST_FLUSH_ACTIVATION_SCOPES.NONE);
  assert.equal(policy.alertable, true);
  assert.match(policy.reason, /^activation_policy_resolution_failed:supabase_down$/);
});

test("loader: no session source supplied fails closed rather than reading a stale cache", async () => {
  const policy = await loadBurstFlushActivationPolicy({
    env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" },
    now: NOW,
  });
  assert.equal(policy.may_claim, false);
  assert.equal(policy.alertable, true);
  assert.match(policy.reason, /session_source_unavailable/);
});

test("loader: supabase path reads system_control directly (cache-bypassing)", async () => {
  const session = activeSession();
  const calls = [];
  const supabase = {
    from(table) {
      calls.push(table);
      return {
        select: () => ({
          eq: (col, val) => {
            calls.push(`${col}=${val}`);
            return { maybeSingle: async () => ({ data: { value: JSON.stringify(session) }, error: null }) };
          },
        }),
      };
    },
  };
  const policy = await loadBurstFlushActivationPolicy({
    env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" },
    now: NOW,
    supabase,
  });
  assert.deepEqual(calls, ["system_control", "key=internal_proof_session"]);
  assert.equal(policy.may_claim, true);
  assert.equal(policy.proof_session_id, session.session_id);
});

test("reason vocabulary is a frozen single source of truth", () => {
  assert.ok(Object.isFrozen(R));
  assert.ok(Object.isFrozen(BURST_FLUSH_ACTIVATION_MODES));
  assert.ok(Object.isFrozen(BURST_FLUSH_ACTIVATION_SCOPES));
  // No duplicate reason strings — two names mapping to one value would let two
  // call sites drift while appearing canonical.
  const values = Object.values(R);
  assert.equal(new Set(values).size, values.length);
});
