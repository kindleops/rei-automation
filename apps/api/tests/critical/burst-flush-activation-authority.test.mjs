// ─── burst-flush-activation-authority.test.mjs ───────────────────────────────
// Adversarial coverage for the FLUSH worker's activation authority.
//
// THE DEFECT: flush-inbound-bursts-request.js built its coordinator with a
// hardcoded `enabled: true`, which reaches
// isSellerInboundBurstEnabled({enabled}) → `if (enabled != null) return
// Boolean(enabled)` and short-circuits ALL mode resolution. The flush worker
// was globally live regardless of SELLER_INBOUND_BURST_ENABLED, and
// flushEligible() never consulted any gate: it listed eligible rows and
// finalized every one.
//
// THE ROW THAT MUST NEVER BE TOUCHED: burst
// sib:+16128072000:g1:ba199924-5f13-4b2e-9f2e-471658cc8d2c — status open,
// eligible_at 2026-08-03T22:40:51Z, claimed_at null, attempt_count 0. It has
// matched the eligible predicate for ~36h. On the first cron tick after a
// deploy it would be claimed; that is why deployment was aborted.
//
// THE SUBTLETY these tests exist to pin: the burst was created INSIDE the OLD
// (now closed) proof session window 22:37:12Z → 23:09:22Z. A naive "burst
// inside *a* session window" rule ADMITS it. Authority must bind to the
// CURRENTLY ACTIVE session's own id and window.
//
// SCOPE OF THIS FILE — the handler is the AUTHORITY-GRANTING layer for the
// cron/POST leg only. Ingest-leg protection (onPersistedInbound's rollover and
// safety-latch finalize) lives in the coordinator and store and is not
// exercised here. Nothing in this file reads or writes a database; the
// "preserved burst" is always a seeded in-memory row shaped like the real one.

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  handleFlushInboundBurstsRequest,
  summarizeFlushResults,
  redactFlushResults,
  auditClaimedBurstAdmissions,
  isFatalActivationPolicy,
  sanitizeReason,
  BURST_FLUSH_OUTCOMES,
  BURST_FLUSH_OUTCOME_VALUES,
} from "@/lib/domain/seller-flow/flush-inbound-bursts-request.js";
import {
  resolveBurstFlushActivationPolicy,
  isBurstAdmittedByActivationPolicy,
  toBurstFlushScopeDescriptor,
  BURST_FLUSH_ACTIVATION_REASONS as REASONS,
} from "@/lib/domain/seller-flow/burst-flush-activation-policy.js";
import { activationScopeFromDescriptor } from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";
import { createMemorySellerInboundBurstStore } from "@/lib/domain/seller-flow/seller-inbound-burst-store.js";
import { loadBurstFlushActivationPolicy } from "@/lib/domain/seller-flow/burst-flush-activation-policy.js";

/** The production translation chain, kept in one place so tests exercise it whole. */
const scopeFromPolicy = (policy) => activationScopeFromDescriptor(toBurstFlushScopeDescriptor(policy));

const CRON_SECRET = "cron-secret-for-activation-test";
const INTERNAL_SECRET = "internal-secret-for-activation-test";

// Code-pinned by INTERNAL_PROOF_PINNED — a session naming anything else is
// invalid in its entirety, so these are not arbitrary fixtures.
const PINNED_RECIPIENT = "+16128072000";
const PINNED_SENDER = "+16128060495";
const PINNED_CAMPAIGN = "b7c9a000-7ad3-468b-9b9b-4647dbefc35f";

const NOW_ISO = "2026-08-05T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

// The preserved incident burst, field for field.
const PRESERVED_BURST_ID = "sib:+16128072000:g1:ba199924-5f13-4b2e-9f2e-471658cc8d2c";
const PRESERVED_BURST = Object.freeze({
  burst_id: PRESERVED_BURST_ID,
  thread_key: PINNED_RECIPIENT,
  generation: 1,
  status: "open",
  first_received_at: "2026-08-03T22:40:31.039Z",
  last_received_at: "2026-08-03T22:40:31.039Z",
  eligible_at: "2026-08-03T22:40:51.039Z",
  hard_close_at: "2026-08-03T22:42:01.039Z",
  created_at: "2026-08-03T22:40:31.039Z",
  claimed_at: null,
  claim_token: null,
  attempt_count: 0,
  completed_at: null,
  safety_latched: false,
  version: 1,
  // Eighth recorded field of the containment fingerprint. Aligned with
  // preserved-burst-acceptance.test.mjs so the two files are one canonical
  // replica rather than two partial ones claiming the same fidelity.
  updated_at: "2026-08-03T22:42:16.901Z",
});

// The OLD session the preserved burst was created inside. Kept as data so the
// "inside *a* window" trap is a fixture, not a story in a comment.
const OLD_SESSION_WINDOW = Object.freeze({
  created_at: "2026-08-03T22:37:12.000Z",
  expires_at: "2026-08-03T23:09:22.000Z",
});

function activeSession(overrides = {}) {
  return {
    session_id: "proof-session-2026-08-05-A",
    campaign_id: PINNED_CAMPAIGN,
    queue_row_id: "11111111-2222-3333-4444-555555555555",
    recipient: PINNED_RECIPIENT,
    sender: PINNED_SENDER,
    created_at: "2026-08-05T11:50:00.000Z",
    expires_at: "2026-08-05T13:50:00.000Z",
    allow_thread_auto_replies: true,
    ...overrides,
  };
}

/** A burst legitimately belonging to the active session. */
function inSessionBurst(overrides = {}) {
  return {
    burst_id: "sib:+16128072000:g2:cccccccc-dddd-eeee-ffff-000000000000",
    thread_key: PINNED_RECIPIENT,
    generation: 2,
    status: "open",
    first_received_at: "2026-08-05T11:55:00.000Z",
    last_received_at: "2026-08-05T11:55:00.000Z",
    eligible_at: "2026-08-05T11:55:20.000Z",
    created_at: "2026-08-05T11:55:00.000Z",
    claimed_at: null,
    attempt_count: 0,
    completed_at: null,
    safety_latched: false,
    version: 1,
    ...overrides,
  };
}

function makeRequest({ method = "GET", headers = {}, body = null } = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    method,
    headers: { get: (key) => lower[String(key).toLowerCase()] ?? null },
    json: async () => {
      if (body === null) throw new Error("no body");
      return body;
    },
  };
}

function vercelCronRequest() {
  return makeRequest({
    method: "GET",
    headers: {
      authorization: `Bearer ${CRON_SECRET}`,
      "user-agent": "vercel-cron/1.0",
      "x-vercel-id": "iad1::activation-test",
    },
  });
}

function internalPostRequest(body = {}) {
  return makeRequest({
    method: "POST",
    headers: { "x-internal-api-secret": INTERNAL_SECRET },
    body,
  });
}

function withSecrets(fn) {
  return async (...args) => {
    const saved_cron = process.env.CRON_SECRET;
    const saved_internal = process.env.INTERNAL_API_SECRET;
    process.env.CRON_SECRET = CRON_SECRET;
    process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
    try {
      return await fn(...args);
    } finally {
      if (saved_cron === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = saved_cron;
      if (saved_internal === undefined) delete process.env.INTERNAL_API_SECRET;
      else process.env.INTERNAL_API_SECRET = saved_internal;
    }
  };
}

/**
 * Harness. `flushResults` is what the (faked) coordinator hands back, so a test
 * can simulate a correct coordinator, a buggy one, or a hostile one. Every
 * flushEligible invocation is recorded, so "zero work" is asserted against the
 * call log rather than against a counter the handler itself computed.
 */
function harness({
  burstEnv = null,
  session = undefined,
  sessionThrows = false,
  flushResults = [],
  flushThrows = null,
  flushRefusal = null,
} = {}) {
  const calls = [];
  const alerts = [];
  const logs = [];
  // Coordinator CONSTRUCTION is captured too, not just invocation: activation
  // authority is bound at construction (activation_scope), so a test that only
  // watched flushEligible's arguments would be blind to the grant itself.
  const built = [];

  const deps = {
    supabase: {},
    now: () => NOW_MS,
    env: burstEnv == null ? {} : { SELLER_INBOUND_BURST_ENABLED: burstEnv },
    getSystemValue: async (key) => {
      if (sessionThrows) throw new Error("system_control_unreachable");
      if (key !== "internal_proof_session") return null;
      return session === undefined ? null : JSON.stringify(session);
    },
    buildCoordinator: async ({ policy, worker_id, method }) => {
      // Mirrors production wiring: the real builder translates the policy into
      // the store-facing scope and binds it at construction.
      built.push({ policy, worker_id, method, activation_scope: scopeFromPolicy(policy) });
      return {
        flushEligible: async (args) => {
          calls.push(args);
          if (flushThrows) throw new Error(flushThrows);
          return flushRefusal || { ok: true, results: flushResults };
        },
      };
    },
    logger: {
      info: (event, meta) => logs.push({ level: "info", event, meta }),
      warn: (event, meta) => logs.push({ level: "warn", event, meta }),
    },
    launchAlerts: {
      burstFlushFailure: async (meta) => alerts.push({ kind: "burstFlushFailure", meta }),
      canaryScopeViolation: async (meta) => alerts.push({ kind: "canaryScopeViolation", meta }),
    },
  };

  return { deps, calls, alerts, logs, built };
}

async function runCron(options) {
  const h = harness(options);
  const response = await handleFlushInboundBurstsRequest(vercelCronRequest(), {
    ...h.deps,
    method: "GET",
  });
  return { ...h, response, body: await response.json() };
}

async function runPost(body, options) {
  const h = harness(options);
  const response = await handleFlushInboundBurstsRequest(internalPostRequest(body), {
    ...h.deps,
    method: "POST",
  });
  return { ...h, response, body: await response.json() };
}

/** Every response must name exactly one outcome from the canonical vocabulary. */
function assertOneOutcome(body) {
  assert.ok(
    BURST_FLUSH_OUTCOME_VALUES.includes(body.outcome),
    `outcome "${body.outcome}" is not in the canonical vocabulary`
  );
}

function assertNoWork(result, { outcome, reason = null }) {
  assertOneOutcome(result.body);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.outcome, outcome);
  if (reason) assert.equal(result.body.reason, reason);
  assert.equal(result.calls.length, 0, "an unactivated flush must never reach the coordinator");
  assert.equal(result.body.eligible_count, 0);
  assert.equal(result.body.claimed_count, 0);
  assert.equal(result.body.completed_count, 0);
  assert.equal(result.body.flushed, 0);
  assert.deepEqual(result.body.results, []);
  assert.equal(result.alerts.length, 0, "a benign no-op must never raise a failure alert");
}

// ══ 1-2. disabled: the default, and every unknown value ═════════════════════

test(
  "disabled mode: the cron GET does zero work, touches no store, and does not alert",
  withSecrets(async () => {
    const result = await runCron({ burstEnv: null });
    assertNoWork(result, {
      outcome: BURST_FLUSH_OUTCOMES.DISABLED_NOOP,
      reason: REASONS.MODE_DISABLED,
    });
    assert.equal(result.body.mode, "disabled");
    assert.equal(result.body.proof_session_id, null);
  })
);

test(
  "unknown SELLER_INBOUND_BURST_ENABLED values fail closed to disabled",
  withSecrets(async () => {
    // "internal-proof" (hyphen) is the plausible typo; "2" and "yes-please" are
    // the truthy-looking ones a boolean coercion would have accepted.
    for (const value of ["sideways", "internal-proof", " ", "2", "yes-please", "TRUE-ish"]) {
      const result = await runCron({ burstEnv: value });
      assertNoWork(result, { outcome: BURST_FLUSH_OUTCOMES.DISABLED_NOOP });
      assert.equal(result.body.mode, "disabled", `"${value}" must not activate anything`);
    }
  })
);

// ══ 3-5. internal_proof without a usable session ════════════════════════════

test(
  "internal_proof with no session configured: zero work, no alert",
  withSecrets(async () => {
    const result = await runCron({ burstEnv: "internal_proof", session: undefined });
    assertNoWork(result, {
      outcome: BURST_FLUSH_OUTCOMES.INTERNAL_PROOF_NO_ACTIVE_SESSION,
      reason: "session_not_configured",
    });
    assert.equal(result.body.mode, "internal_proof");
  })
);

test(
  "internal_proof with an expired session: zero work, cause surfaced, no alert",
  withSecrets(async () => {
    const result = await runCron({
      burstEnv: "internal_proof",
      session: activeSession({
        created_at: "2026-08-05T09:00:00.000Z",
        expires_at: "2026-08-05T10:00:00.000Z",
      }),
    });
    assertNoWork(result, {
      outcome: BURST_FLUSH_OUTCOMES.INTERNAL_PROOF_NO_ACTIVE_SESSION,
      reason: "session_expired",
    });
  })
);

test(
  "internal_proof with a session on any other phone: zero work",
  withSecrets(async () => {
    // The proof lane is code-pinned. A session naming a different recipient is
    // invalid in its entirety — not merely scoped elsewhere.
    const result = await runCron({
      burstEnv: "internal_proof",
      session: activeSession({ recipient: "+15559990000" }),
    });
    assertNoWork(result, {
      outcome: BURST_FLUSH_OUTCOMES.INTERNAL_PROOF_NO_ACTIVE_SESSION,
      reason: "session_recipient_not_internal",
    });
  })
);

test(
  "internal_proof with an explicitly closed session: zero work",
  withSecrets(async () => {
    // parseInternalProofSession never reads closed_at, so an operator who closes
    // a session early would otherwise keep a live authority until wall-clock
    // expiry. The policy layers the check on top.
    const result = await runCron({
      burstEnv: "internal_proof",
      session: activeSession({ closed_at: "2026-08-05T11:55:00.000Z" }),
    });
    assertNoWork(result, {
      outcome: BURST_FLUSH_OUTCOMES.INTERNAL_PROOF_NO_ACTIVE_SESSION,
      reason: "session_closed",
    });
  })
);

test(
  "internal_proof with an unparseable closed_at fails closed",
  withSecrets(async () => {
    const result = await runCron({
      burstEnv: "internal_proof",
      session: activeSession({ closed_at: "not-a-timestamp" }),
    });
    assertNoWork(result, {
      outcome: BURST_FLUSH_OUTCOMES.INTERNAL_PROOF_NO_ACTIVE_SESSION,
      reason: "session_closed_at_invalid",
    });
  })
);

// ══ 6. THE PRESERVED BURST — denied by the authority itself ═════════════════

test("the preserved incident burst is denied under every reachable session state", () => {
  // (a) No session at all.
  const no_session = resolveBurstFlushActivationPolicy({
    mode: "internal_proof",
    session_raw: null,
    now: new Date(NOW_MS),
  });
  assert.equal(no_session.may_claim, false);
  assert.equal(
    isBurstAdmittedByActivationPolicy({ policy: no_session, burst: PRESERVED_BURST }).admitted,
    false
  );

  // (b) A session opened today — the realistic proof state.
  const today = resolveBurstFlushActivationPolicy({
    mode: "internal_proof",
    session_raw: JSON.stringify(activeSession()),
    now: new Date(NOW_MS),
  });
  assert.equal(today.may_claim, true, "a real session must genuinely activate");
  assert.equal(today.allowed_thread_key, PINNED_RECIPIENT);
  const verdict = isBurstAdmittedByActivationPolicy({ policy: today, burst: PRESERVED_BURST });
  assert.equal(verdict.admitted, false, "the preserved burst must never be admitted");
  assert.equal(verdict.reason, "burst_received_before_session");

  // (c) The trap: the burst sits INSIDE the OLD session's window, and the thread
  // is the pinned proof thread — so thread identity plus "inside a window" both
  // say yes. Only binding to the ACTIVE session's own window says no.
  const first_received = Date.parse(PRESERVED_BURST.first_received_at);
  assert.ok(
    first_received >= Date.parse(OLD_SESSION_WINDOW.created_at) &&
      first_received <= Date.parse(OLD_SESSION_WINDOW.expires_at),
    "fixture check: the preserved burst really is inside the old session window"
  );
  assert.equal(PRESERVED_BURST.thread_key, today.allowed_thread_key);
});

test("a session backdated far enough to contain the preserved burst cannot be active", async () => {
  // The structural argument behind the time floor: an ACTIVE session's window
  // can never reach back 36h, because expires_at must be in the future AND
  // within 240 minutes of created_at. Pinned so the argument stays true if the
  // parser is ever edited.
  const { parseInternalProofSession } = await import(
    "@/lib/domain/queue/internal-proof-session.js"
  );

  // Backdated to cover the burst, expiry pushed out to "stay active" → rejected
  // for exceeding the maximum session length.
  const stretched = parseInternalProofSession(
    activeSession({ created_at: PRESERVED_BURST.first_received_at, expires_at: "2026-08-05T13:50:00.000Z" }),
    new Date(NOW_MS)
  );
  assert.equal(stretched.ok, false);
  assert.equal(stretched.reason, "session_exceeds_max_length");

  // Backdated with a legal 240-minute span → long since expired.
  const honest = parseInternalProofSession(
    activeSession({ ...OLD_SESSION_WINDOW }),
    new Date(NOW_MS)
  );
  assert.equal(honest.ok, false);
  assert.equal(honest.reason, "session_expired");
});

test(
  "internal_proof + active session + only the preserved-shaped burst: nothing is claimed",
  withSecrets(async () => {
    // A correctly-scoped coordinator finds nothing to do. The row is not
    // mentioned in the response, not counted, and not alerted on.
    const result = await runCron({
      burstEnv: "internal_proof",
      session: activeSession(),
      flushResults: [],
    });
    assertOneOutcome(result.body);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.outcome, BURST_FLUSH_OUTCOMES.INTERNAL_PROOF_NO_AUTHORIZED_BURSTS);
    assert.equal(result.body.claimed_count, 0);
    assert.equal(result.body.out_of_scope_claimed, 0);
    assert.equal(result.alerts.length, 0, "no work is not a failure");
    assert.equal(result.body.proof_session_id, "proof-session-2026-08-05-A");
  })
);

// ══ 7. THE AUDIT — the only executor of the policy's anti-backdating leg ════

test(
  "a coordinator that claims the preserved burst anyway is caught, alerted, and non-2xx",
  withSecrets(async () => {
    // Simulates the one seam nothing else checks: a correct policy translated
    // into a wrong scope. The store obeys the scope it is handed, so only a
    // post-hoc audit against the POLICY can see this.
    const result = await runCron({
      burstEnv: "internal_proof",
      session: activeSession(),
      flushResults: [{ ok: true, queued: true, burst: { ...PRESERVED_BURST, status: "completed" } }],
    });

    assertOneOutcome(result.body);
    assert.equal(result.response.status, 500, "a scope violation must never be a 200");
    assert.equal(result.body.outcome, BURST_FLUSH_OUTCOMES.FLUSH_FAILED);
    assert.equal(result.body.reason, "burst_scope_violation_after_claim");
    assert.equal(result.body.out_of_scope_claimed, 1);

    const violation_alerts = result.alerts.filter((a) => a.kind === "canaryScopeViolation");
    assert.equal(violation_alerts.length, 1, "a scope violation has its own alert code");
    assert.equal(violation_alerts[0].meta.violations[0].burst_id, PRESERVED_BURST_ID);
    assert.equal(
      violation_alerts[0].meta.violations[0].admission_reason,
      "burst_received_before_session"
    );
  })
);

test("the audit enforces the anti-backdating leg that the scope contract omits", () => {
  // The scope contract is {thread_keys, first_received_at_min/max} — it carries
  // NO created_at bound. Policy leg 3 (session.created_at <= burst.created_at)
  // is therefore unenforceable by scope alone. This burst has a
  // first_received_at inside the window and a 36-hour-old row: it passes every
  // bound the scope can express, and must still be refused.
  const policy = resolveBurstFlushActivationPolicy({
    mode: "internal_proof",
    session_raw: JSON.stringify(activeSession()),
    now: new Date(NOW_MS),
  });
  const backdated = inSessionBurst({
    burst_id: "sib:+16128072000:g9:backdated",
    created_at: PRESERVED_BURST.created_at,
  });

  const verdict = isBurstAdmittedByActivationPolicy({ policy, burst: backdated });
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, "burst_created_before_session");

  const violations = auditClaimedBurstAdmissions({
    policy,
    results: [{ ok: true, burst: backdated }],
    isBurstAdmitted: isBurstAdmittedByActivationPolicy,
  });
  assert.equal(violations.length, 1, "the audit is the layer that catches this");
});

test("an audit that throws reads as a violation, never as a pass", () => {
  const violations = auditClaimedBurstAdmissions({
    policy: { may_claim: true, scope: "thread" },
    results: [{ ok: true, burst: inSessionBurst() }],
    isBurstAdmitted: () => {
      throw new Error("predicate_exploded");
    },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0].admission_reason, /audit_threw/);
});

test("a failed claim is not audited as a claimed burst", () => {
  // finalizeBurst returns {ok:false, reason, claim} with NO top-level burst when
  // the claim itself lost. Auditing that as a claim would alert on ordinary
  // concurrency.
  const violations = auditClaimedBurstAdmissions({
    policy: resolveBurstFlushActivationPolicy({
      mode: "internal_proof",
      session_raw: JSON.stringify(activeSession()),
      now: new Date(NOW_MS),
    }),
    results: [{ ok: false, reason: "claim_lease_active", claim: { ok: false, burst: PRESERVED_BURST } }],
    isBurstAdmitted: isBurstAdmittedByActivationPolicy,
  });
  assert.equal(violations.length, 0);
});

// ══ 8. The authorized burst DOES get worked ════════════════════════════════

test(
  "internal_proof + active session + an in-window burst: exactly that one is flushed",
  withSecrets(async () => {
    const result = await runCron({
      burstEnv: "internal_proof",
      session: activeSession(),
      flushResults: [{ ok: true, queued: true, burst: inSessionBurst() }],
    });

    assertOneOutcome(result.body);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.outcome, BURST_FLUSH_OUTCOMES.INTERNAL_PROOF_FLUSHED);
    assert.equal(result.body.claimed_count, 1);
    assert.equal(result.body.completed_count, 1);
    assert.equal(result.body.queued_count, 1);
    assert.equal(result.body.out_of_scope_claimed, 0);
    assert.equal(result.alerts.length, 0);
  })
);

test(
  "the resolved policy is bound to the coordinator as a narrow session scope",
  withSecrets(async () => {
    const result = await runCron({ burstEnv: "internal_proof", session: activeSession() });
    assert.equal(result.built.length, 1, "exactly one coordinator is constructed");
    const { policy, activation_scope } = result.built[0];

    // The handler grants authority; the coordinator translates it. This asserts
    // the grant, which is the handler's actual product.
    assert.equal(policy.mode, "internal_proof");
    assert.equal(policy.may_claim, true);
    assert.equal(policy.allowed_thread_key, PINNED_RECIPIENT);
    assert.equal(policy.received_not_before, "2026-08-05T11:50:00.000Z");
    assert.equal(policy.received_not_after, "2026-08-05T13:50:00.000Z");

    // The translated scope must be narrow, never global.
    assert.equal(activation_scope.authorized, true);
    assert.equal(activation_scope.global, false, "internal_proof must never be global");
    assert.deepEqual(activation_scope.thread_keys, [PINNED_RECIPIENT]);
    assert.equal(activation_scope.min_first_received_at, "2026-08-05T11:50:00.000Z");
    assert.equal(activation_scope.max_first_received_at, "2026-08-05T13:50:00.000Z");

    // CONTRACT: allowed_thread_key !== null ⇒ the scan is scoped to it.
    assert.equal(result.calls[0].thread_key, PINNED_RECIPIENT);
  })
);

test("no policy the module can emit yields a global scope outside enabled mode", () => {
  // The single highest-consequence field in the architecture: `global: true`
  // short-circuits every bound in the store's scope resolver, and one flipped
  // boolean in translation reverts the system to pre-incident behaviour with
  // every gate still nominally "on". Swept across the reachable policy space.
  const session_variants = [
    undefined,
    activeSession(),
    activeSession({ closed_at: "2026-08-05T11:55:00.000Z" }),
    activeSession({ recipient: "+15559990000" }),
    activeSession({ created_at: "2026-08-05T09:00:00.000Z", expires_at: "2026-08-05T10:00:00.000Z" }),
    activeSession({ campaign_id: "00000000-0000-0000-0000-000000000000" }),
  ];
  const modes = ["disabled", "internal_proof", "sideways", "", "0"];

  for (const mode of modes) {
    for (const session of session_variants) {
      const policy = resolveBurstFlushActivationPolicy({
        mode,
        session_raw: session === undefined ? null : JSON.stringify(session),
        now: new Date(NOW_MS),
      });
      const scope = scopeFromPolicy(policy);
      assert.notEqual(
        scope.global,
        true,
        `mode "${mode}" must never translate to a global scope`
      );
    }
  }

  // …and the one mode that legitimately is global says so explicitly.
  const enabled = scopeFromPolicy(
    resolveBurstFlushActivationPolicy({ mode: "enabled", now: new Date(NOW_MS) })
  );
  assert.equal(enabled.global, true);
  assert.equal(enabled.authorized, true);
});

test(
  "a coordinator that refuses an authorized policy is loud, not a quiet idle tick",
  withSecrets(async () => {
    // The refusal arrives shaped exactly like "nothing to do" (`results: []`).
    // Two layers disagreeing about the same policy must never render as a green
    // 200 — that is the incident's signature, one layer further down.
    const result = await runCron({
      burstEnv: "internal_proof",
      session: activeSession(),
      flushRefusal: {
        ok: false,
        reason: "burst_scope_unauthorized",
        scope_reason: "no_activation_scope",
        results: [],
      },
    });

    assertOneOutcome(result.body);
    assert.equal(result.response.status, 503);
    assert.equal(result.body.outcome, BURST_FLUSH_OUTCOMES.PROOF_SCOPE_RESOLUTION_FAILED);
    assert.match(result.body.reason, /coordinator_refused:burst_scope_unauthorized/);
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0].meta.reason, "coordinator_refused_authorized_policy");
  })
);

// ══ 9. Thread-scoped POST cannot reach past the authority ══════════════════

test(
  "POST thread_key on the pinned thread does not claim the preserved burst",
  withSecrets(async () => {
    // The live bypass: the thread-scoped branch used to call
    // finalizeBurst({thread_key}) with no burst_id, and
    // claim_seller_inbound_burst resolves p_burst_id IS NULL to
    // `ORDER BY eligible_at ASC LIMIT 1` — the OLDEST eligible row on the
    // thread, which on this thread is the preserved burst by ~36 hours.
    const result = await runPost(
      { thread_key: PINNED_RECIPIENT },
      { burstEnv: "internal_proof", session: activeSession(), flushResults: [] }
    );

    assertOneOutcome(result.body);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.outcome, BURST_FLUSH_OUTCOMES.INTERNAL_PROOF_NO_AUTHORIZED_BURSTS);
    const claimed = (result.body.results || []).map((r) => r.burst_id);
    assert.ok(
      !claimed.includes(PRESERVED_BURST_ID),
      `POST must never claim ${PRESERVED_BURST_ID}`
    );
    // The authority still bounds the run even though the operator named the
    // authorized thread: the session window is what excludes the old row, and
    // it is bound to the coordinator regardless of what the body asked for.
    assert.equal(
      result.built[0].activation_scope.min_first_received_at,
      "2026-08-05T11:50:00.000Z"
    );
    assert.equal(result.built[0].activation_scope.global, false);
  })
);

test(
  "POST thread_key outside the authorized thread does zero work",
  withSecrets(async () => {
    const result = await runPost(
      { thread_key: "+15551234567" },
      { burstEnv: "internal_proof", session: activeSession() }
    );
    assertNoWork(result, {
      outcome: BURST_FLUSH_OUTCOMES.INTERNAL_PROOF_NO_AUTHORIZED_BURSTS,
      reason: "thread_key_not_allowed",
    });
  })
);

test(
  "POST thread_key under disabled mode does zero work",
  withSecrets(async () => {
    const result = await runPost({ thread_key: PINNED_RECIPIENT }, { burstEnv: null });
    assertNoWork(result, { outcome: BURST_FLUSH_OUTCOMES.DISABLED_NOOP });
  })
);

test(
  "a GET carrying a body cannot widen its own scope",
  withSecrets(async () => {
    // Vercel Cron sends no body. A GET that carries one must be ignored
    // entirely, so an attacker-shaped body cannot enlarge the scheduled run.
    const h = harness({ burstEnv: "internal_proof", session: activeSession() });
    const request = makeRequest({
      method: "GET",
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
        "user-agent": "vercel-cron/1.0",
      },
      body: { thread_key: "+15551234567", limit: 9999, worker_id: "../../etc/passwd" },
    });
    const response = await handleFlushInboundBurstsRequest(request, { ...h.deps, method: "GET" });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(h.calls.length, 1, "the GET still runs its authorized scan");
    assert.equal(h.calls[0].thread_key, PINNED_RECIPIENT, "the body's thread_key was ignored");
    assert.equal(h.calls[0].limit, 20, "the body's limit was ignored");
    assertOneOutcome(body);
  })
);

test(
  "POST limit is clamped and worker_id is sanitized",
  withSecrets(async () => {
    const result = await runPost(
      { limit: 100000, worker_id: "evil worker/../id" },
      { burstEnv: "internal_proof", session: activeSession() }
    );
    assert.equal(result.calls[0].limit, 100, "limit is bounded");
    // worker_id lands in claimed_by. Path separators, spaces and traversal
    // sequences are stripped rather than merely bounded.
    assert.equal(result.built[0].worker_id, "evilworkerid", "worker_id is sanitized");

    const zero = await runPost(
      { limit: -5 },
      { burstEnv: "internal_proof", session: activeSession() }
    );
    assert.equal(zero.calls[0].limit, 20, "a nonsense limit falls back to the default");
  })
);

// ══ 10. Resolver failure: loud, non-2xx, never a global fallback ═══════════

test(
  "a session lookup failure is alertable and non-2xx, never a quiet idle tick",
  withSecrets(async () => {
    // The shape of the original incident was a scheduled worker that reported
    // success while doing nothing. A DB read error must never be indistinguishable
    // from "the operator has not opened a session".
    const result = await runCron({ burstEnv: "internal_proof", sessionThrows: true });

    assertOneOutcome(result.body);
    assert.equal(result.response.status, 503);
    assert.equal(result.body.outcome, BURST_FLUSH_OUTCOMES.PROOF_SCOPE_RESOLUTION_FAILED);
    assert.match(
      result.body.reason,
      /session_lookup_failed|activation_policy_resolution_failed/,
      "the operator must see the real cause"
    );
    assert.equal(result.calls.length, 0, "a faulted resolver must never reach the coordinator");
    assert.equal(result.alerts.length, 1, "a resolver fault must page");
    assert.equal(result.alerts[0].kind, "burstFlushFailure");
  })
);

test(
  "a resolver fault is never mistaken for a benign no-session tick, whatever it is called",
  withSecrets(async () => {
    // Regression pin for a real integration break. This handler read
    // `policy.alertable`; the field was renamed to `fatal` mid-flight and the
    // read silently became `undefined`, so a FATAL session-lookup failure
    // rendered as a benign 200 no-session no-op — the precise collapse the
    // discriminator exists to prevent, reintroduced by a rename.
    //
    // The fault signal is therefore asserted across every spelling the policy
    // module has carried, plus the reason string alone. Under-reporting a fault
    // costs a worker that reports clean idle ticks forever while the subsystem
    // is down; over-reporting costs one spurious page. Not symmetric.
    const base = {
      mode: "internal_proof",
      may_scan: false,
      may_claim: false,
      scope: "none",
      allowed_thread_key: null,
      proof_session_id: null,
      received_not_before: null,
      received_not_after: null,
    };
    const fault_shapes = [
      { ...base, reason: "session_lookup_failed", fatal: true },
      { ...base, reason: "session_lookup_failed", alertable: true },
      { ...base, reason: "activation_policy_resolution_failed:boom" },
      { ...base, reason: "session_lookup_failed" },
    ];

    for (const policy of fault_shapes) {
      const calls = [];
      const alerts = [];
      const response = await handleFlushInboundBurstsRequest(vercelCronRequest(), {
        method: "GET",
        supabase: {},
        now: () => NOW_MS,
        env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" },
        loadActivationPolicy: async () => policy,
        coordinator: { flushEligible: async (a) => (calls.push(a), { ok: true, results: [] }) },
        logger: { info: () => {}, warn: () => {} },
        launchAlerts: {
          burstFlushFailure: async (meta) => alerts.push(meta),
          canaryScopeViolation: async () => {},
        },
      });
      const body = await response.json();
      const label = JSON.stringify({ fatal: policy.fatal, alertable: policy.alertable });

      assert.equal(response.status, 503, `${label}: a resolver fault must be non-2xx`);
      assert.equal(body.outcome, BURST_FLUSH_OUTCOMES.PROOF_SCOPE_RESOLUTION_FAILED, label);
      assert.equal(calls.length, 0, `${label}: must never reach the coordinator`);
      assert.equal(alerts.length, 1, `${label}: must page`);
    }

    // …and a genuinely benign denial is still quiet.
    const quiet = await runCron({ burstEnv: "internal_proof", session: undefined });
    assert.equal(quiet.response.status, 200);
    assert.equal(quiet.alerts.length, 0);
  })
);

test("the policy still publishes a fault flag — tolerance must not degrade into reading nothing", async () => {
  // The handler tolerates `fatal` OR `alertable` OR the reason string, because a
  // rename already silently downgraded a fatal fault to a benign 200 once. That
  // tolerance is a shock absorber, not a licence for the contract to evaporate:
  // if BOTH flags disappear, the handler would still catch today's faults via
  // the reason prefix, and would quietly stop catching any future fault whose
  // reason is spelled differently.
  //
  // So this asserts the PRODUCER, not the consumer: the real policy module must
  // publish an explicit boolean fault flag on a real fault. Tolerate spellings;
  // do not tolerate absence.
  const faulted = await loadBurstFlushActivationPolicy({
    env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" },
    now: new Date(NOW_MS),
    getSystemValue: async () => {
      throw new Error("system_control_unreachable");
    },
  });

  const has_flag =
    Object.hasOwn(faulted, "fatal") || Object.hasOwn(faulted, "alertable");
  assert.ok(
    has_flag,
    "the policy must publish `fatal` or `alertable`; the handler's tolerant read is a shock absorber, not a substitute for the contract"
  );
  assert.equal(
    faulted.fatal === true || faulted.alertable === true,
    true,
    "a session-lookup failure must be flagged as a fault, not merely described in prose"
  );
  assert.equal(faulted.may_scan, false, "a faulted policy licences nothing");
  assert.equal(faulted.may_claim, false);

  // The mirror image: a benign denial must NOT carry the fault flag, or every
  // idle tick pages.
  const benign = await loadBurstFlushActivationPolicy({
    env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" },
    now: new Date(NOW_MS),
    getSystemValue: async () => null,
  });
  assert.equal(benign.fatal === true || benign.alertable === true, false);
  assert.equal(isFatalActivationPolicy(benign), false, "no session open is not a fault");
  assert.equal(isFatalActivationPolicy(faulted), true, "a lookup failure is");
});

test(
  "a policy loader that throws fails closed with no global fallback",
  withSecrets(async () => {
    const calls = [];
    const alerts = [];
    const response = await handleFlushInboundBurstsRequest(vercelCronRequest(), {
      method: "GET",
      supabase: {},
      now: () => NOW_MS,
      env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" },
      loadActivationPolicy: async () => {
        throw new Error("policy_module_exploded");
      },
      coordinator: { flushEligible: async (args) => (calls.push(args), { ok: true, results: [] }) },
      logger: { info: () => {}, warn: () => {} },
      launchAlerts: {
        burstFlushFailure: async (meta) => alerts.push(meta),
        canaryScopeViolation: async () => {},
      },
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.outcome, BURST_FLUSH_OUTCOMES.PROOF_SCOPE_RESOLUTION_FAILED);
    assert.equal(calls.length, 0);
    assert.equal(alerts.length, 1);
  })
);

test(
  "a malformed policy object fails closed",
  withSecrets(async () => {
    const calls = [];
    const response = await handleFlushInboundBurstsRequest(vercelCronRequest(), {
      method: "GET",
      supabase: {},
      now: () => NOW_MS,
      env: { SELLER_INBOUND_BURST_ENABLED: "internal_proof" },
      loadActivationPolicy: async () => null,
      coordinator: { flushEligible: async (args) => (calls.push(args), { ok: true, results: [] }) },
      logger: { info: () => {}, warn: () => {} },
      launchAlerts: { burstFlushFailure: async () => {}, canaryScopeViolation: async () => {} },
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.outcome, BURST_FLUSH_OUTCOMES.PROOF_SCOPE_RESOLUTION_FAILED);
    assert.equal(calls.length, 0);
  })
);

test(
  "a crashing flush is contained, alerted, and reported as flush_failed",
  withSecrets(async () => {
    const result = await runCron({
      burstEnv: "internal_proof",
      session: activeSession(),
      flushThrows: "store_unreachable",
    });
    assertOneOutcome(result.body);
    assert.equal(result.response.status, 500);
    assert.equal(result.body.outcome, BURST_FLUSH_OUTCOMES.FLUSH_FAILED);
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0].meta.error_message, "store_unreachable");
  })
);

// ══ 11. enabled mode: existing global behaviour, and honest idleness ═══════

test(
  "enabled mode preserves global behaviour",
  withSecrets(async () => {
    const result = await runCron({
      burstEnv: "1",
      flushResults: [{ ok: true, queued: true, burst: inSessionBurst() }],
    });
    assertOneOutcome(result.body);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.outcome, BURST_FLUSH_OUTCOMES.ENABLED_FLUSHED);
    assert.equal(result.body.mode, "enabled");
    assert.equal(result.body.claimed_count, 1);
    assert.equal(result.built[0].policy.scope, "global");
    assert.equal(result.built[0].policy.allowed_thread_key, null);
    assert.equal(result.built[0].activation_scope.global, true);
    assert.equal(result.calls[0].thread_key, null);
  })
);

test(
  "enabled mode with nothing to do reports enabled_no_work, not a green flush",
  withSecrets(async () => {
    // A success outcome that means "nothing happened" is the exact signature
    // that hid the original incident for 36 hours.
    const result = await runCron({ burstEnv: "true", flushResults: [] });
    assertOneOutcome(result.body);
    assert.equal(result.body.outcome, BURST_FLUSH_OUTCOMES.ENABLED_NO_WORK);
    assert.equal(result.body.claimed_count, 0);
    assert.equal(result.alerts.length, 0);
  })
);

test(
  "DEPLOYMENT CONSTRAINT: in enabled mode the preserved burst IS admitted",
  withSecrets(async () => {
    // Uncomfortable and true. Global activation has no temporal bound, so the
    // preserved row is claimed by the first tick. The preservation guarantee
    // rests entirely on SELLER_INBOUND_BURST_ENABLED being `internal_proof`
    // and never `1`/`true`/`on`. Pinned so the constraint is executable rather
    // than folklore.
    const policy = resolveBurstFlushActivationPolicy({
      mode: "enabled",
      now: new Date(NOW_MS),
    });
    assert.equal(policy.scope, "global");
    assert.equal(
      isBurstAdmittedByActivationPolicy({ policy, burst: PRESERVED_BURST }).admitted,
      true,
      "global activation admits the preserved burst — this is why the mode matters"
    );

    const result = await runCron({
      burstEnv: "1",
      flushResults: [{ ok: true, queued: true, burst: PRESERVED_BURST }],
    });
    // The audit cannot save it: in enabled mode there is no authority to violate.
    assert.equal(result.body.out_of_scope_claimed, 0);
    assert.equal(result.body.outcome, BURST_FLUSH_OUTCOMES.ENABLED_FLUSHED);
  })
);

// ══ 12. DOCUMENTED RESIDUAL: crash recovery is scope-gated ════════════════

test("DOCUMENTED HAZARD: a session expiring mid-flight strands a claimed burst forever", async () => {
  // CHARACTERIZATION, NOT A FIX. Binding activation authority to the session
  // window also binds CRASH RECOVERY to it. Stale-lease reclaim is the mechanism
  // that rescues a burst whose worker died mid-finalize; it runs through the
  // scoped eligible list, so a burst outside the active scope is invisible to it.
  //
  // For the preserved 2026-08-03 burst that is exactly the intent. The
  // unintended case is a burst claimed legitimately INSIDE a session whose
  // session then expires before the finalize completes. Its lease expires, but
  // no future session's window can ever contain it — a session's floor is its
  // own created_at, and the burst is older than any session opened afterwards.
  // The row parks at status=claimed with completed_at null, and its constituent
  // ledger rows keep `awaiting_burst_finalization`, which
  // findInboundLedgerSlaBreaches EXCLUDES from breach_count. Nobody is paged.
  //
  // This pins the behaviour so whoever addresses it inherits a signal rather
  // than rediscovering it.
  const THREAD = PINNED_RECIPIENT;
  let clock = "2026-08-05T11:55:00.000Z";
  const store = createMemorySellerInboundBurstStore({ now: () => clock });

  const session_1 = activeSession(); // 11:50 → 13:50
  const scope_1 = scopeFromPolicy(
    resolveBurstFlushActivationPolicy({
      mode: "internal_proof",
      session_raw: JSON.stringify(session_1),
      now: new Date("2026-08-05T11:56:00.000Z"),
    })
  );
  assert.equal(scope_1.authorized, true, "precondition: session 1 genuinely authorizes");

  const appended = await store.appendMessage({
    thread_key: THREAD,
    message: { event_id: "evt-midflight", body: "Yeah", received_at: clock },
    now: clock,
    scope: scope_1,
  });
  assert.equal(appended.ok, true, "precondition: an in-session append is authorized");
  const burst_id = appended.burst.burst_id;

  // A worker claims it legitimately, inside the session, then dies before
  // completeClaimed — the crash the lease exists to recover from.
  clock = "2026-08-05T11:56:00.000Z";
  const claim = await store.claimEligible({
    thread_key: THREAD,
    burst_id,
    now: clock,
    worker_id: "worker-that-dies",
    scope: scope_1,
  });
  assert.equal(claim.ok, true, "precondition: the in-session claim succeeds");

  // While the session still lives, stale-lease reclaim works exactly as designed.
  const during_session = await store.listEligible({
    now: "2026-08-05T12:05:00.000Z", // past the 300s lease
    limit: 20,
    scope: scope_1,
  });
  assert.equal(during_session.length, 1, "reclaim works while the session is open");

  // The session expires. A NEW session is opened afterwards — the operator's
  // natural recovery move.
  const session_2 = activeSession({
    session_id: "proof-session-2026-08-05-B",
    created_at: "2026-08-05T14:00:00.000Z",
    expires_at: "2026-08-05T16:00:00.000Z",
  });
  const scope_2 = scopeFromPolicy(
    resolveBurstFlushActivationPolicy({
      mode: "internal_proof",
      session_raw: JSON.stringify(session_2),
      now: new Date("2026-08-05T14:05:00.000Z"),
    })
  );
  assert.equal(scope_2.authorized, true, "the new session is genuinely active");

  const after_expiry = await store.listEligible({
    now: "2026-08-05T14:05:00.000Z",
    limit: 20,
    scope: scope_2,
  });
  assert.equal(after_expiry.length, 0, "THE RESIDUAL: the stranded burst is unreachable");

  // And it is unreachable from EVERY future session, not just this one: a
  // session's floor is its own created_at, so a burst predating it can never
  // re-enter scope. Swept forward a week to make the permanence explicit.
  for (const day of ["2026-08-06", "2026-08-08", "2026-08-12"]) {
    const later = scopeFromPolicy(
      resolveBurstFlushActivationPolicy({
        mode: "internal_proof",
        session_raw: JSON.stringify(
          activeSession({
            created_at: `${day}T10:00:00.000Z`,
            expires_at: `${day}T12:00:00.000Z`,
          })
        ),
        now: new Date(`${day}T10:05:00.000Z`),
      })
    );
    const rows = await store.listEligible({
      now: `${day}T10:05:00.000Z`,
      limit: 20,
      scope: later,
    });
    assert.equal(rows.length, 0, `still stranded on ${day}`);
  }

  // The row itself is still mid-flight: claimed, never completed. This is the
  // parked state no watchdog alarms on.
  const stranded = await store.getById?.(burst_id);
  const row = stranded || store._debug.listAll().find((b) => b.burst_id === burst_id);
  assert.equal(row.completed_at, null, "never finalized");
  assert.equal(row.status, "claimed", "parked mid-flight");
});

// ══ 13. Counters, redaction, hygiene ══════════════════════════════════════

test("summarizeFlushResults derives counters from the coordinator's real shape", () => {
  const counts = summarizeFlushResults([
    { ok: true, queued: true },
    { ok: true, suppressed: true, queued: false },
    { ok: false, reason: "burst_claim_conflict", claim: { ok: false } },
    { ok: false, reason: "attempts_exhausted" },
    { ok: false, reason: "no_eligible_burst" },
  ]);
  assert.equal(counts.eligible_count, 4, "no_eligible_burst is not an eligible burst");
  assert.equal(counts.claimed_count, 3, "a failed claim is not a claim");
  assert.equal(counts.completed_count, 1);
  assert.equal(counts.suppressed_count, 1);
  assert.equal(counts.queued_count, 1);
  assert.equal(counts.failed_count, 1, "no_eligible_burst is not a failure");
  assert.equal(counts.no_eligible_burst_count, 1);
});

test("a claimed-then-abandoned burst counts as a failure, not benign contention", () => {
  // finalizeBurst attaches a SUCCESSFUL claim alongside ok:false on the
  // missing_process_seller_inbound path. Keying on the presence of `claim`
  // rather than `claim.ok === false` classified that as a lost race, so a burst
  // that was claimed and then abandoned mid-flight was never counted or alerted.
  const counts = summarizeFlushResults([
    {
      ok: false,
      reason: "missing_process_seller_inbound",
      claim: { ok: true, claim_token: "tok" },
      burst: inSessionBurst(),
    },
  ]);
  assert.equal(counts.failed_count, 1);
  assert.equal(counts.claimed_count, 1);
  assert.deepEqual(counts.failed_reasons, ["missing_process_seller_inbound"]);
});

test("the response never carries seller message content", () => {
  const redacted = redactFlushResults([
    {
      ok: true,
      queued: true,
      burst: inSessionBurst(),
      aggregated: { message: "CANARY_SELLER_BODY yes I want to sell", message_count: 2 },
      orchestration: { reply_text: "CANARY_SELLER_BODY" },
    },
  ]);
  const serialized = JSON.stringify(redacted);
  assert.ok(!serialized.includes("CANARY_SELLER_BODY"), "aggregated content must not be echoed");
  assert.equal(redacted[0].burst_id, "sib:+16128072000:g2:cccccccc-dddd-eeee-ffff-000000000000");
  assert.equal(redacted[0].queued, true);
});

test(
  "no response, log or alert payload carries seller bodies or secrets",
  withSecrets(async () => {
    const CANARY_BODY = "CANARY_SELLER_BODY_do_not_leak";
    const result = await runCron({
      burstEnv: "internal_proof",
      session: activeSession(),
      flushResults: [
        {
          ok: false,
          reason: "attempts_exhausted",
          burst: { ...inSessionBurst(), constituents: [{ body: CANARY_BODY }] },
          aggregated: { message: CANARY_BODY },
        },
      ],
    });

    const surfaces = JSON.stringify({
      body: result.body,
      logs: result.logs,
      alerts: result.alerts,
    });
    assert.ok(!surfaces.includes(CANARY_BODY), "seller message content must not leave the handler");
    assert.ok(!surfaces.includes(CRON_SECRET), "secrets must never appear in observability");
    assert.ok(!surfaces.includes(INTERNAL_SECRET), "secrets must never appear in observability");
    // The failure itself is still reported and alerted.
    assert.equal(result.body.failed_count, 1);
    assert.ok(result.alerts.some((a) => a.kind === "burstFlushFailure"));
  })
);

test("sanitizeReason passes authored codes verbatim and redacts unauthored prose", () => {
  // Everything this system authors is an identifier, so it survives untouched —
  // sanitization must not cost us the diagnostics we do control.
  for (const authored of [
    "attempts_exhausted",
    "no_eligible_burst",
    "burst_scope_unauthorized",
    "coordinator_refused:burst_scope_unauthorized",
    "activation_policy_resolution_failed:system_control_unreachable",
    "seller_inbound_burst_flush_failed",
  ]) {
    assert.equal(sanitizeReason(authored), authored, `${authored} must survive verbatim`);
  }

  // Free-form prose is by construction not ours.
  const leaky = `Unexpected token 'Y', "Yeah I wan"... is not valid JSON`;
  const out = sanitizeReason(leaky);
  assert.match(out, /^unauthored_error_redacted:[0-9a-f]{12}$/);
  assert.ok(!out.includes("Yeah"), "not one character of the payload survives");

  // Stable, so "the same error is recurring" stays observable without the text.
  assert.equal(sanitizeReason(leaky), out);
  assert.notEqual(sanitizeReason("a different failure entirely"), out);
});

test(
  "an exception message that echoes seller text cannot escape through `reason`",
  withSecrets(async () => {
    // CWE-532. `reason` is the one field in this pipeline whose content we do
    // not author: on the coordinator's process_error path it is `err.message`
    // from inside processSellerInboundMessage. Truncation bounded its length,
    // never its content.
    //
    // The mechanism is real and needs no exotic throw site — V8's own JSON.parse
    // echoes the first ten characters of its input, and
    // natural-response-engine.js:353 parses raw LLM completion content. That one
    // is caught by its caller today; this test does not depend on that catch
    // surviving, which is the point.
    const CANARY_BODY = "CANARY_SELLER_BODY_do_not_leak";
    const leaked_exception = `Unexpected token 'C', "${CANARY_BODY}"... is not valid JSON`;

    const result = await runCron({
      burstEnv: "internal_proof",
      session: activeSession(),
      flushResults: [
        {
          ok: false,
          reason: leaked_exception, // exactly what process_error would carry
          retry_after_lease: true,
          burst: inSessionBurst(),
        },
      ],
    });

    // All three sinks: HTTP response, structured log, alert payload.
    const surfaces = JSON.stringify({
      body: result.body,
      logs: result.logs,
      alerts: result.alerts,
    });
    assert.ok(
      !surfaces.includes(CANARY_BODY),
      "an exception message must not carry seller text into any sink"
    );
    assert.ok(!surfaces.includes("Unexpected token"), "nor the surrounding prose");

    // The failure is still counted, reported and alerted — redaction must not
    // buy privacy by discarding the signal.
    assert.equal(result.body.failed_count, 1);
    assert.match(result.body.failed_reasons[0], /^unauthored_error_redacted:/);
    assert.ok(result.alerts.some((a) => a.kind === "burstFlushFailure"));
  })
);

test("CONTAINMENT: a model returning non-JSON cannot leak seller text through its exception", async () => {
  // Pins natural-response-engine.js, which is not this file's subject but is
  // the upstream source of the exception messages the flush worker's `reason`
  // field carries. Placed here rather than in a new file so the shard
  // composition the suite measurement depends on is unchanged.
  //
  // THE MECHANISM, exercised for real rather than simulated: :353 does
  // `JSON.parse(String(content ?? ""))` on RAW LLM completion content — text
  // generated from, and routinely paraphrasing, the seller's own message. A
  // model that returns a prose preamble, a markdown fence, or a refusal throws,
  // and V8 puts the first ten characters of the input INTO the error message.
  //
  // THE CONTAINMENT, which is what this asserts: the caller at :508 catches
  // every throw from that path and maps it to a fixed `model_error` token, so
  // `err.message` never escapes. That containment is one `catch` block away from
  // disappearing and was previously untested. A refactor that lets the message
  // through now fails here, loudly, instead of quietly shipping seller text into
  // logs and alerts.
  const { buildModelCallFromEnv, generateConstrainedReply } = await import(
    "@/lib/domain/seller-flow/natural-response-engine.js"
  );

  const CANARY = "CANARY_SELLER_BODY_do_not_leak";
  // Exactly the common failure: the model ignores response_format and answers
  // in prose that echoes the seller.
  const non_json_content = `${CANARY} — sure, I'd take $150k for it`;

  // Parsing prose throws on every runtime — that part is the premise.
  //
  // What it throws is NOT: the message format is V8-version-specific. On the
  // Node this repo currently runs (23.x) it echoes the first ten characters of
  // the input — `Unexpected token 'C', "CANARY_SEL"... is not valid JSON` —
  // which is precisely how seller-derived text reaches an exception message
  // with no exotic throw site. Other supported versions report position, line
  // and column with no snippet at all.
  //
  // So the leak is version-dependent and the containment must not be. Asserting
  // the message's shape would make this test fail on a runtime where the
  // containment is working perfectly — a test that fails without its property
  // being broken, which is the same defect as one that passes without checking
  // its property. The assertions below are therefore all containment claims:
  // the fixed-token check guards the catch block on every runtime (it fails if
  // `err.message` is propagated, regardless of phrasing), and the canary checks
  // add a direct content assertion on the runtimes that can actually leak.
  let v8_message = null;
  try {
    JSON.parse(non_json_content);
  } catch (error) {
    v8_message = error.message;
  }
  assert.ok(v8_message, "premise: parsing prose throws");

  // Counted, because `model_error` is also what a fetch failure produces. Without
  // proving the request completed and delivered this content, the test would pass
  // for the wrong reason and stop guarding the parse it exists to guard.
  let fetch_calls = 0;
  let content_delivered = false;
  const modelCall = buildModelCallFromEnv({
    env: { GROQ_API_KEY: "test-key-not-used-no-network" },
    fetchImpl: async () => {
      fetch_calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => {
          content_delivered = true;
          return { choices: [{ message: { content: non_json_content } }] };
        },
      };
    },
  });
  assert.ok(modelCall, "precondition: the env yields a model call");

  const result = await generateConstrainedReply({
    objective: "acknowledge",
    deterministicText: "Thanks — what's the address?",
    modelCall,
    timeoutMs: 5000,
  });

  // The failure really came from parsing delivered content, not from the transport.
  assert.equal(fetch_calls, 1, "the model request completed — this is not a transport failure");
  assert.ok(content_delivered, "the non-JSON content reached the parse");

  // Contained: fixed token, deterministic fallback, no seller text anywhere.
  assert.equal(result.fallback_reason, "model_error", "the throw maps to a fixed token");
  assert.equal(result.source, "deterministic_fallback");

  const surfaces = JSON.stringify(result);
  assert.ok(
    !surfaces.includes(CANARY),
    "the model's echoed seller text must not survive in any returned field"
  );
  // Phrase-independent: no runtime's parse message survives, whatever it says.
  assert.ok(
    !surfaces.includes("Unexpected token") && !surfaces.includes("not valid JSON"),
    "nor the raw parse message that carries it"
  );
});

test(
  "a thrown flush error cannot carry seller text into the alert either",
  withSecrets(async () => {
    const CANARY_BODY = "CANARY_SELLER_BODY_do_not_leak";
    const result = await runCron({
      burstEnv: "internal_proof",
      session: activeSession(),
      flushThrows: `Unexpected token 'C', "${CANARY_BODY}"... is not valid JSON`,
    });

    assert.equal(result.response.status, 500);
    const surfaces = JSON.stringify({
      body: result.body,
      logs: result.logs,
      alerts: result.alerts,
    });
    assert.ok(!surfaces.includes(CANARY_BODY), "the throw path is sanitized too");
    assert.equal(result.alerts.length, 1, "and the failure still pages");
    assert.match(result.alerts[0].meta.error_message, /^unauthored_error_redacted:/);
  })
);

// ══ 13. Auth and preconditions ════════════════════════════════════════════

test("an anonymous GET is rejected before any activation work", async () => {
  const calls = [];
  const response = await handleFlushInboundBurstsRequest(makeRequest({ method: "GET" }), {
    method: "GET",
    supabase: {},
    coordinator: { flushEligible: async (a) => (calls.push(a), { ok: true, results: [] }) },
    loadActivationPolicy: async () => assert.fail("policy must not resolve for an anonymous caller"),
    logger: { info: () => {}, warn: () => {} },
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
  // A rejection at the door never became an invocation, so it names no outcome.
  assert.equal(body.outcome, undefined);
  assert.equal(calls.length, 0);
});

test(
  "an authenticated caller with no Supabase configuration reports precondition_failed",
  withSecrets(async () => {
    const alerts = [];
    const calls = [];
    const response = await handleFlushInboundBurstsRequest(vercelCronRequest(), {
      method: "GET",
      hasSupabaseConfig: () => false,
      now: () => NOW_MS,
      env: {},
      coordinator: { flushEligible: async (a) => (calls.push(a), { ok: true, results: [] }) },
      logger: { info: () => {}, warn: () => {} },
      launchAlerts: {
        burstFlushFailure: async (meta) => alerts.push(meta),
        canaryScopeViolation: async () => {},
      },
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.outcome, BURST_FLUSH_OUTCOMES.PRECONDITION_FAILED);
    assert.equal(body.reason, "missing_supabase");
    assert.equal(calls.length, 0);
    assert.equal(alerts.length, 1, "an infrastructure precondition failure is alertable");
  })
);

// ══ 14. The one-outcome invariant, exhaustively ═══════════════════════════

test(
  "every authenticated invocation names exactly one canonical outcome",
  withSecrets(async () => {
    const scenarios = [
      { name: "disabled", options: { burstEnv: null } },
      { name: "unknown value", options: { burstEnv: "sideways" } },
      { name: "no session", options: { burstEnv: "internal_proof" } },
      {
        name: "expired session",
        options: {
          burstEnv: "internal_proof",
          session: activeSession({
            created_at: "2026-08-05T09:00:00.000Z",
            expires_at: "2026-08-05T10:00:00.000Z",
          }),
        },
      },
      {
        name: "active, no work",
        options: { burstEnv: "internal_proof", session: activeSession() },
      },
      {
        name: "active, flushed",
        options: {
          burstEnv: "internal_proof",
          session: activeSession(),
          flushResults: [{ ok: true, queued: true, burst: inSessionBurst() }],
        },
      },
      { name: "enabled, no work", options: { burstEnv: "1" } },
      {
        name: "enabled, flushed",
        options: { burstEnv: "1", flushResults: [{ ok: true, burst: inSessionBurst() }] },
      },
      { name: "resolver fault", options: { burstEnv: "internal_proof", sessionThrows: true } },
      {
        name: "flush throws",
        options: { burstEnv: "1", flushThrows: "boom" },
      },
      {
        name: "scope violation",
        options: {
          burstEnv: "internal_proof",
          session: activeSession(),
          flushResults: [{ ok: true, burst: PRESERVED_BURST }],
        },
      },
    ];

    const seen = new Set();
    for (const scenario of scenarios) {
      const result = await runCron(scenario.options);
      assert.ok(
        BURST_FLUSH_OUTCOME_VALUES.includes(result.body.outcome),
        `${scenario.name}: "${result.body.outcome}" is not canonical`
      );
      assert.equal(typeof result.body.mode, "string", `${scenario.name}: mode must be reported`);
      seen.add(result.body.outcome);
    }

    // Every outcome except precondition_failed is reachable from this table;
    // precondition_failed has its own test above.
    for (const outcome of BURST_FLUSH_OUTCOME_VALUES) {
      if (outcome === BURST_FLUSH_OUTCOMES.PRECONDITION_FAILED) continue;
      assert.ok(seen.has(outcome), `outcome ${outcome} is unreachable — dead vocabulary`);
    }
  })
);
