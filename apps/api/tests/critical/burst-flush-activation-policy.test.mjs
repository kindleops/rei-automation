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
  toBurstFlushScopeDescriptor,
  isBurstWithinFlushScope,
  isBurstAdmittedByActivationPolicy,
  loadBurstFlushActivationPolicy,
} from "@/lib/domain/seller-flow/burst-flush-activation-policy.js";
import {
  INTERNAL_PROOF_SESSION_MAX_MINUTES,
  parseInternalProofSession,
} from "@/lib/domain/queue/internal-proof-session.js";

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

test("internal_proof: a throwing session parser is fatal, not permissive", () => {
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

test("mode resolution that throws is fatal and disabled", () => {
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

test("loader: a failing session lookup is fatal and never global", async () => {
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
  assert.ok(policy.reason.startsWith(R.RESOLUTION_FAILED), policy.reason);
  assert.equal(policy.error_message, "supabase_down");
});

test("loader: no session source supplied fails closed rather than reading a stale cache", async () => {
  const policy = await loadBurstFlushActivationPolicy({
    env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" },
    now: NOW,
  });
  assert.equal(policy.may_claim, false);
  assert.equal(policy.alertable, true);
  assert.ok(policy.reason.startsWith(R.RESOLUTION_FAILED), policy.reason);
  assert.equal(policy.error_message, "session_source_unavailable");
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

// ── fatal vs quiet ──────────────────────────────────────────────────────────

test("fatal: a lookup failure is fatal and NEVER collapses to session_not_configured", () => {
  // The Incident-A shape: a Supabase read error rendering as "the operator
  // hasn't started a session" gives a cron reporting clean idle ticks forever
  // while the subsystem is down. These two must be distinguishable.
  const lookup_failed = { fatal: true };
  return loadBurstFlushActivationPolicy({
    env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" },
    now: NOW,
    getSystemValue: async () => {
      throw new Error("ECONNRESET");
    },
  }).then(async (broken) => {
    assert.equal(broken.alertable, lookup_failed.fatal);
    assert.ok(broken.reason.startsWith(R.RESOLUTION_FAILED), broken.reason);
    assert.equal(broken.error_message, "ECONNRESET");
    assert.equal(broken.may_scan, false);

    const quiet = await loadBurstFlushActivationPolicy({
      env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" },
      now: NOW,
      getSystemValue: async () => null,
    });
    assert.equal(quiet.alertable, false);
    assert.equal(quiet.reason, "session_not_configured");
    assert.equal(quiet.may_scan, false);

    // Same denial, different operational meaning — that is the whole point.
    assert.notEqual(broken.reason, quiet.reason);
    assert.notEqual(broken.alertable, quiet.alertable);
  });
});

test("fatal: classification matrix — quiet states are quiet, thrown states are fatal", () => {
  const quiet = [
    ["mode_disabled", resolveBurstFlushActivationPolicy({ env: {}, now: NOW })],
    [
      "session_not_configured",
      resolveBurstFlushActivationPolicy({
        mode: BURST_FLUSH_ACTIVATION_MODES.INTERNAL_PROOF,
        session_raw: null,
        now: NOW,
      }),
    ],
    [
      "session_expired",
      policyFor(activeSession({ expires_at: "2026-08-05T11:59:00.000Z" })),
    ],
    ["session_recipient_not_pinned", policyFor(activeSession({ recipient: OTHER_INTERNAL }))],
    ["session_closed", policyFor(activeSession({ closed_at: "2026-08-05T11:58:00.000Z" }))],
  ];
  for (const [label, policy] of quiet) {
    assert.equal(policy.alertable, false, `${label} must be quiet`);
    assert.equal(policy.may_scan, false, label);
  }

  const fatal = [
    [
      "parser throws",
      resolveBurstFlushActivationPolicy({
        mode: BURST_FLUSH_ACTIVATION_MODES.INTERNAL_PROOF,
        session_raw: JSON.stringify(activeSession()),
        now: NOW,
        parseSession: () => {
          throw new Error("x");
        },
      }),
    ],
    [
      "mode resolution throws",
      resolveBurstFlushActivationPolicy({
        now: NOW,
        resolveMode: () => {
          throw new Error("y");
        },
      }),
    ],
  ];
  for (const [label, policy] of fatal) {
    assert.equal(policy.alertable, true, `${label} must be fatal`);
    assert.equal(policy.may_scan, false, label);
  }
});

// ── shared scope predicate ──────────────────────────────────────────────────

test("REGRESSION: a RESOLUTION_FAILED policy projects to {ok:false, fatal:true}", () => {
  // The descriptor exposes `fatal` but the resolver's field is `alertable`.
  // If that alias ever stops tracking its source — e.g. the descriptor reads a
  // `fatal` key the policy does not have — every resolution failure renders as
  // {ok:true, fatal:false} and the handler returns a SILENT 200 on a subsystem
  // outage. This assertion is the only thing standing between us and that.
  const sources = [
    resolveBurstFlushActivationPolicy({
      now: NOW,
      resolveMode: () => {
        throw new Error("mode_boom");
      },
    }),
    resolveBurstFlushActivationPolicy({
      mode: BURST_FLUSH_ACTIVATION_MODES.INTERNAL_PROOF,
      session_raw: JSON.stringify(activeSession()),
      now: NOW,
      parseSession: () => {
        throw new Error("parse_boom");
      },
    }),
  ];
  for (const policy of sources) {
    assert.equal(policy.alertable, true, "resolver marks it alertable");
    const d = toBurstFlushScopeDescriptor(policy);
    assert.equal(d.fatal, true, "descriptor alias must track alertable");
    assert.equal(d.ok, false, "ok must be false so the 503 path fires");
    assert.equal(d.allowed, false);
  }

  // And the converse: a QUIET denial must not trip the 503 path.
  const quiet = toBurstFlushScopeDescriptor(
    resolveBurstFlushActivationPolicy({
      mode: BURST_FLUSH_ACTIVATION_MODES.INTERNAL_PROOF,
      session_raw: null,
      now: NOW,
    })
  );
  assert.equal(quiet.fatal, false);
  assert.equal(quiet.ok, true);
  assert.equal(quiet.allowed, false);
});

test("REGRESSION: created_not_before floors the ROW insert instant independently", () => {
  // Flooring on first_received_at alone lets a backfilled row carry an
  // in-window message time while the row itself predates the session.
  const session = activeSession();
  const policy = policyFor(session);
  assert.equal(policy.created_not_before, session.created_at);

  const d = toBurstFlushScopeDescriptor(policy);
  assert.equal(d.scope.min_created_at, session.created_at);

  const backfilled = burst({
    first_received_at: "2026-08-05T12:10:00.000Z", // in window
    created_at: "2026-08-05T11:00:00.000Z", // row predates the session
  });
  assert.equal(
    isBurstAdmittedByActivationPolicy({ policy, burst: backfilled }).reason,
    R.BURST_CREATED_BEFORE_SESSION
  );
  assert.equal(isBurstWithinFlushScope({ burst: backfilled, scope: d.scope }), false);

  // Back-compat: a policy predating the field falls back to received_not_before
  // rather than becoming unbounded.
  const legacy = { ...policy };
  delete legacy.created_not_before;
  assert.equal(
    toBurstFlushScopeDescriptor(legacy).scope.min_created_at,
    session.created_at,
    "absent created_not_before must fall back, never go unbounded"
  );
});

test("scope descriptor: ratified shape, with the session's own window and no grace", () => {
  const session = activeSession();
  const d = toBurstFlushScopeDescriptor(policyFor(session));
  assert.equal(d.ok, true);
  assert.equal(d.mode, BURST_FLUSH_ACTIVATION_MODES.INTERNAL_PROOF);
  assert.equal(d.allowed, true);
  assert.equal(d.fatal, false);
  assert.equal(d.reason, R.INTERNAL_PROOF_SESSION_ACTIVE);
  assert.equal(d.scope.kind, BURST_FLUSH_ACTIVATION_SCOPES.THREAD);
  assert.deepEqual(d.scope.thread_keys, [PINNED_RECIPIENT]);
  // No grace window: the floor IS the session's created_at.
  assert.equal(d.scope.min_first_received_at, session.created_at);
  assert.equal(d.scope.max_first_received_at, session.expires_at);
  assert.equal(d.scope.min_created_at, session.created_at);
  assert.equal(d.scope.session_id, session.session_id);
  assert.equal(d.scope.session_created_at, session.created_at);
  assert.equal(d.scope.session_expires_at, session.expires_at);
  // Every ratified key present.
  for (const key of [
    "kind", "thread_keys", "min_first_received_at", "max_first_received_at",
    "min_created_at", "session_id", "session_created_at", "session_expires_at",
  ]) {
    assert.ok(key in d.scope, `missing ratified key ${key}`);
  }
});

test("scope descriptor: disabled and fatal policies project to a closed scope", () => {
  const off = toBurstFlushScopeDescriptor(resolveBurstFlushActivationPolicy({ env: {}, now: NOW }));
  assert.equal(off.ok, true, "disabled is a determined answer, so ok");
  assert.equal(off.allowed, false);
  assert.equal(off.fatal, false);
  assert.equal(off.scope.kind, BURST_FLUSH_ACTIVATION_SCOPES.NONE);
  assert.deepEqual(off.scope.thread_keys, []);

  const broken = toBurstFlushScopeDescriptor(
    resolveBurstFlushActivationPolicy({
      now: NOW,
      resolveMode: () => {
        throw new Error("z");
      },
    })
  );
  assert.equal(broken.ok, false);
  assert.equal(broken.allowed, false);
  // Descriptor exposes `fatal`; the policy it came from exposes `alertable`.
  assert.equal(broken.fatal, true);

  // A null/garbage policy must never project to an open scope.
  for (const bad of [null, undefined, {}, "nope", 7]) {
    const d = toBurstFlushScopeDescriptor(bad);
    assert.equal(d.allowed, false, JSON.stringify(bad));
    assert.notEqual(d.scope.kind, BURST_FLUSH_ACTIVATION_SCOPES.GLOBAL, JSON.stringify(bad));
    assert.equal(isBurstWithinFlushScope({ burst: burst(), scope: d.scope }), false);
  }
});

test("scope predicate: it is THE rule — admission and filtering agree on every case", () => {
  const policy = policyFor(activeSession());
  const scope = toBurstFlushScopeDescriptor(policy).scope;
  const candidates = [
    PRESERVED_INCIDENT_BURST,
    burst(),
    burst({ thread_key: REAL_SELLER }),
    burst({ thread_key: OTHER_INTERNAL }),
    burst({ thread_key: null }),
    burst({ created_at: null }),
    burst({ created_at: "nope" }),
    burst({ first_received_at: null }),
    burst({ first_received_at: "2026-08-05T13:00:00.001Z" }),
    burst({ first_received_at: "2026-08-05T12:10:00.000Z", created_at: "2026-08-05T11:00:00.000Z" }),
    burst({ first_received_at: "2026-08-05T12:10:00.000Z", created_at: "2026-08-05T13:30:00.000Z" }),
    null,
  ];
  for (const candidate of candidates) {
    const admitted = isBurstAdmittedByActivationPolicy({ policy, burst: candidate }).admitted;
    const within = isBurstWithinFlushScope({ burst: candidate, scope });
    assert.equal(
      admitted,
      within,
      `divergence between admission and scope filter for ${JSON.stringify(candidate)}`
    );
  }
});

test("scope predicate: denies on any missing or unparseable scope field", () => {
  const good = toBurstFlushScopeDescriptor(policyFor(activeSession())).scope;
  const b = burst({ first_received_at: "2026-08-05T12:10:00.000Z", created_at: "2026-08-05T12:10:00.000Z" });
  assert.equal(isBurstWithinFlushScope({ burst: b, scope: good }), true, "baseline admits");

  const mutations = [
    ["no scope", null],
    ["empty thread_keys", { ...good, thread_keys: [] }],
    ["thread_keys not an array", { ...good, thread_keys: PINNED_RECIPIENT }],
    ["min_first missing", { ...good, min_first_received_at: null }],
    ["max_first missing", { ...good, max_first_received_at: null }],
    ["min_created missing", { ...good, min_created_at: null }],
    ["min_first unparseable", { ...good, min_first_received_at: "soon" }],
    ["inverted window", { ...good, min_first_received_at: good.max_first_received_at, max_first_received_at: good.min_first_received_at }],
    ["unknown kind", { ...good, kind: "everything" }],
  ];
  for (const [label, scope] of mutations) {
    assert.equal(isBurstWithinFlushScope({ burst: b, scope }), false, label);
  }
});

// ── the structural-sufficiency invariant (the load-bearing beam) ────────────

test("INVARIANT: the 240-minute cap is what makes the time floor sufficient", () => {
  // Teammate 3's argument: an ACTIVE session's created_at can never be more
  // than INTERNAL_PROOF_SESSION_MAX_MINUTES old, because the parser demands
  // expires_at > now AND expires_at - created_at <= that cap. If anyone raises
  // the cap, the floor widens and this test must fail loudly.
  assert.equal(INTERNAL_PROOF_SESSION_MAX_MINUTES, 240);

  const base = {
    session_id: "s",
    campaign_id: PINNED_CAMPAIGN,
    queue_row_id: "q",
    recipient: PINNED_RECIPIENT,
    sender: PINNED_SENDER,
  };
  let worst_floor_age_minutes = 0;
  let active_count = 0;
  for (let age = 1; age <= 600; age += 1) {
    for (const ahead of [1, 60, 239, 240, 241]) {
      const raw = JSON.stringify({
        ...base,
        created_at: new Date(NOW.getTime() - age * 60_000).toISOString(),
        expires_at: new Date(NOW.getTime() + ahead * 60_000).toISOString(),
      });
      const parsed = parseInternalProofSession(raw, NOW);
      if (!parsed.ok) continue;
      active_count += 1;
      const floor_age = (NOW.getTime() - Date.parse(parsed.session.created_at)) / 60_000;
      worst_floor_age_minutes = Math.max(worst_floor_age_minutes, floor_age);
    }
  }
  assert.ok(active_count > 0, "the sweep must actually produce active sessions");
  assert.ok(
    worst_floor_age_minutes < INTERNAL_PROOF_SESSION_MAX_MINUTES,
    `no active session may have a floor older than the cap; worst was ${worst_floor_age_minutes}`
  );

  // The preserved burst is ~2239 minutes old — an order of magnitude beyond
  // the widest reachable floor. No craftable active session can contain it.
  const burst_age_minutes =
    (NOW.getTime() - Date.parse(PRESERVED_INCIDENT_BURST.first_received_at)) / 60_000;
  assert.ok(
    burst_age_minutes > INTERNAL_PROOF_SESSION_MAX_MINUTES,
    "the preserved burst must be older than any reachable session floor"
  );
});

test("INVARIANT: a backdated session crafted to contain the preserved burst is rejected", () => {
  const crafted = [
    // Wide window covering the burst → exceeds the 240-minute cap.
    ["long window", "2026-08-03T22:00:00.000Z", "2026-08-05T13:00:00.000Z", "session_exceeds_max_length"],
    // Legal 240-minute window at the burst's time → long expired.
    ["240min at burst time", "2026-08-03T22:00:00.000Z", "2026-08-04T02:00:00.000Z", "session_expired"],
  ];
  for (const [label, created_at, expires_at, expected] of crafted) {
    const policy = policyFor(activeSession({ created_at, expires_at }));
    assert.equal(policy.reason, expected, label);
    assert.equal(policy.may_claim, false, label);
    assert.equal(
      isBurstAdmittedByActivationPolicy({ policy, burst: PRESERVED_INCIDENT_BURST }).admitted,
      false,
      label
    );
  }

  // And the widest LEGAL active session still cannot reach back to the burst.
  const widest = policyFor(
    activeSession({ created_at: "2026-08-05T09:00:00.000Z", expires_at: "2026-08-05T13:00:00.000Z" })
  );
  assert.equal(widest.may_claim, true, "widest legal session is active");
  assert.equal(
    isBurstAdmittedByActivationPolicy({ policy: widest, burst: PRESERVED_INCIDENT_BURST }).reason,
    R.BURST_RECEIVED_BEFORE_SESSION
  );
});

test("INVARIANT: the closed_at layer only ever tightens the floor, never widens it", () => {
  // FINDING A cannot undermine the sufficiency argument: the layered check adds
  // denials and removes none. Any session the layer rejects was already denied
  // or is denied now — never newly admitted.
  const session = activeSession();
  const open = policyFor(session);
  const closed = policyFor({ ...session, closed_at: "2026-08-05T11:58:00.000Z" });
  assert.equal(open.may_claim, true);
  assert.equal(closed.may_claim, false);
  assert.equal(closed.reason, R.SESSION_CLOSED);
  // The floor never moves earlier as a result of the layer.
  assert.equal(closed.received_not_before, null, "a denied policy exposes no window at all");
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
