// ─── internal-proof-contact-window-bypass.test.mjs ───────────────────────────
// The bounded internal-proof session is the ONLY contact-window bypass, and it
// requires the FULL conjunction: scoped-canary dispatch with a validated
// single-use authorization, single-row manifest, queue_execution_mode =
// scoped_canary_only, an active unexpired operator session, and the exact
// pinned internal recipient/sender/campaign/row. These tests pin:
//   * the exact controlled row may bypass the contact window;
//   * changing ANY single required field denies the bypass;
//   * real seller rows remain deferred outside contact hours;
//   * the bypass expires automatically with the session;
//   * auto-replies on the same internal proof thread may execute during the
//     bounded session — and only there;
//   * no other internal allowlisted number inherits the override.

import test from "node:test";
import assert from "node:assert/strict";

import {
  INTERNAL_PROOF_SESSION_KEY,
  INTERNAL_PROOF_SESSION_MAX_MINUTES,
  parseInternalProofSession,
  evaluateInternalProofContactWindowBypass,
} from "@/lib/domain/queue/internal-proof-session.js";
import { processSendQueueItem } from "@/lib/domain/queue/process-send-queue.js";
import {
  insertSupabaseSendQueueRow,
  normalizeSendQueueRow,
} from "@/lib/supabase/sms-engine.js";

// 2026-08-01T05:30Z = 00:30 America/Chicago — firmly outside the 08:00-21:00
// local send window.
const NOW = "2026-08-01T05:30:00.000Z";
const CAMPAIGN = "b7c9a000-7ad3-468b-9b9b-4647dbefc35f";
const PINNED_ROW = "4d211395-bc7b-4bfe-8afb-16a329e636a4";
const RECIPIENT = "+16128072000";
const SENDER = "+16128060495";
const OTHER_INTERNAL = "+16127433952"; // registered internal number, NOT the pinned recipient
const REPLY_ROW = "9a0d0000-0000-4000-8000-000000000001";
const REAL_SELLER_ROW = "9a0d0000-0000-4000-8000-000000000002";

function makeSession(overrides = {}) {
  return {
    session_id: "proof-20260801T0500Z",
    campaign_id: CAMPAIGN,
    queue_row_id: PINNED_ROW,
    recipient: RECIPIENT,
    sender: SENDER,
    created_at: "2026-08-01T05:00:00.000Z",
    expires_at: "2026-08-01T07:00:00.000Z",
    allow_thread_auto_replies: true,
    ...overrides,
  };
}

function makeGetSystemValue(overrides = {}) {
  const values = {
    queue_execution_mode: "scoped_canary_only",
    [INTERNAL_PROOF_SESSION_KEY]: JSON.stringify(makeSession()),
    ...overrides,
  };
  return async (key) => values[key];
}

function makePinnedRow(overrides = {}) {
  const { metadata: metadata_overrides, ...rest } = overrides;
  return normalizeSendQueueRow({
    id: PINNED_ROW,
    queue_status: "queued",
    campaign_id: CAMPAIGN,
    to_phone_number: RECIPIENT,
    from_phone_number: SENDER,
    thread_key: RECIPIENT,
    seller_first_name: "Scott",
    message_body: "Internal canary transport proof message body.",
    message_text: "Internal canary transport proof message body.",
    retry_count: 0,
    max_retries: 1,
    lock_token: "lock-token-proof",
    is_locked: true,
    metadata: {
      internal_canary: true,
      origin_surface: "internal_canary",
      agent_first_name: "Scott",
      selected_template_id: "tmpl-canary",
      candidate_snapshot: {
        seller_first_name: "Scott",
        internal_canary: true,
        touch_number: 1,
      },
      ...(metadata_overrides || {}),
    },
    ...rest,
  });
}

function makeReplyRow(overrides = {}) {
  return makePinnedRow({
    id: REPLY_ROW,
    inbound_message_id: "evt-internal-inbound-1",
    metadata: {
      origin_surface: "canonical_automation",
      source_event_id: "evt-internal-inbound-1",
    },
    ...overrides,
  });
}

function makeContext(overrides = {}) {
  return {
    now: NOW,
    scoped_canary: true,
    authorization_validated: true,
    canary_run_id: "canary-proof-run-1",
    scoped_canary_max_rows: 1,
    scoped_canary_requested_ids: [PINNED_ROW],
    getSystemValue: makeGetSystemValue(),
    ...overrides,
  };
}

// ── Session parsing ─────────────────────────────────────────────────────────

test("parseInternalProofSession: accepts a fully-specified bounded session", () => {
  const parsed = parseInternalProofSession(JSON.stringify(makeSession()), NOW);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.session.recipient, RECIPIENT);
  assert.equal(parsed.session.allow_thread_auto_replies, true);
});

test("parseInternalProofSession: fail-closed parse matrix", () => {
  const cases = [
    ["", "session_not_configured"],
    ["not-json", "session_invalid_json"],
    [JSON.stringify([1]), "session_not_configured"],
    [JSON.stringify(makeSession({ session_id: "" })), "session_id_required"],
    [JSON.stringify(makeSession({ campaign_id: "" })), "session_campaign_id_required"],
    [JSON.stringify(makeSession({ queue_row_id: "" })), "session_queue_row_id_required"],
    [JSON.stringify(makeSession({ recipient: "" })), "session_recipient_required"],
    [JSON.stringify(makeSession({ sender: "" })), "session_sender_required"],
    // A session pinned to a REAL seller number is invalid in its entirety.
    [JSON.stringify(makeSession({ recipient: "+16125551234" })), "session_recipient_not_internal"],
    // The pins are structural: even another REGISTERED internal number, or any
    // other sender/campaign, invalidates the whole session.
    [JSON.stringify(makeSession({ recipient: OTHER_INTERNAL })), "session_recipient_not_pinned"],
    [JSON.stringify(makeSession({ sender: "+16125550000" })), "session_sender_not_pinned"],
    [JSON.stringify(makeSession({ campaign_id: "11111111-1111-4111-8111-111111111111" })), "session_campaign_not_pinned"],
    [JSON.stringify(makeSession({ created_at: "garbage" })), "session_created_at_invalid"],
    [JSON.stringify(makeSession({ expires_at: "garbage" })), "session_expires_at_invalid"],
    [JSON.stringify(makeSession({ expires_at: "2026-08-01T05:29:59.000Z" })), "session_expired"],
    [JSON.stringify(makeSession({ created_at: "2026-08-01T06:00:00.000Z", expires_at: "2026-08-01T07:00:00.000Z" })), "session_created_in_future"],
    [
      JSON.stringify(
        makeSession({
          created_at: "2026-08-01T05:00:00.000Z",
          expires_at: new Date(
            Date.parse("2026-08-01T05:00:00.000Z") +
              (INTERNAL_PROOF_SESSION_MAX_MINUTES + 1) * 60_000
          ).toISOString(),
        })
      ),
      "session_exceeds_max_length",
    ],
  ];
  for (const [raw, want] of cases) {
    const parsed = parseInternalProofSession(raw, NOW);
    assert.equal(parsed.ok, false, `expected reject: ${want}`);
    assert.equal(parsed.reason, want);
  }
});

// ── Full-conjunction evaluation ─────────────────────────────────────────────

test("bypass: exact pinned canary row is allowed under the full conjunction", async () => {
  const verdict = await evaluateInternalProofContactWindowBypass(makePinnedRow(), makeContext());
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.leg, "primary_canary_row");
  assert.equal(verdict.session_id, "proof-20260801T0500Z");
});

test("bypass: changing any single conjunct denies", async () => {
  const cases = [
    ["scoped_canary false", makePinnedRow(), makeContext({ scoped_canary: false }), "not_scoped_canary_dispatch"],
    ["authorization not validated", makePinnedRow(), makeContext({ authorization_validated: false }), "authorization_not_validated"],
    ["canary_run_id missing", makePinnedRow(), makeContext({ canary_run_id: "" }), "canary_run_id_required"],
    ["max_rows 2", makePinnedRow(), makeContext({ scoped_canary_max_rows: 2 }), "max_rows_must_be_one"],
    ["manifest has two rows", makePinnedRow(), makeContext({ scoped_canary_requested_ids: [PINNED_ROW, REPLY_ROW] }), "request_manifest_not_single_row"],
    ["manifest names another row", makePinnedRow(), makeContext({ scoped_canary_requested_ids: [REPLY_ROW] }), "request_manifest_not_single_row"],
    ["mode normal", makePinnedRow(), makeContext({ getSystemValue: makeGetSystemValue({ queue_execution_mode: "normal" }) }), "queue_execution_mode_not_scoped_canary_only"],
    ["mode paused", makePinnedRow(), makeContext({ getSystemValue: makeGetSystemValue({ queue_execution_mode: "paused" }) }), "queue_execution_mode_not_scoped_canary_only"],
    ["session absent", makePinnedRow(), makeContext({ getSystemValue: makeGetSystemValue({ [INTERNAL_PROOF_SESSION_KEY]: undefined }) }), "session_not_configured"],
    ["session expired", makePinnedRow(), makeContext({ getSystemValue: makeGetSystemValue({ [INTERNAL_PROOF_SESSION_KEY]: JSON.stringify(makeSession({ expires_at: "2026-08-01T05:29:00.000Z" })) }) }), "session_expired"],
    ["recipient differs from session pin", makePinnedRow({ to_phone_number: OTHER_INTERNAL, thread_key: OTHER_INTERNAL }), makeContext(), "recipient_mismatch"],
    ["sender differs from session pin", makePinnedRow({ from_phone_number: "+16125550000" }), makeContext(), "sender_mismatch"],
    ["campaign differs from session pin", makePinnedRow({ campaign_id: "11111111-1111-4111-8111-111111111111" }), makeContext(), "campaign_mismatch"],
    ["internal_canary stamp missing", makePinnedRow({ metadata: { internal_canary: undefined } }), makeContext(), "internal_canary_stamp_missing"],
    ["origin surface not internal_canary", makePinnedRow({ metadata: { origin_surface: "campaign_feeder" } }), makeContext(), "origin_surface_not_internal_canary"],
  ];
  for (const [label, row, context, want] of cases) {
    const verdict = await evaluateInternalProofContactWindowBypass(row, context);
    assert.equal(verdict.allowed, false, `expected deny: ${label}`);
    assert.equal(verdict.reason, want, `deny reason for: ${label}`);
  }
});

test("bypass: no other internal allowlisted number inherits the override", async () => {
  // Session pinned to RECIPIENT; a row to another registered internal number
  // under an otherwise identical conjunction must still be denied.
  const row = makePinnedRow({ to_phone_number: OTHER_INTERNAL, thread_key: OTHER_INTERNAL });
  const verdict = await evaluateInternalProofContactWindowBypass(
    row,
    makeContext({ scoped_canary_requested_ids: [PINNED_ROW] })
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "recipient_mismatch");
});

test("bypass: auto-reply on the pinned internal thread is allowed during the session", async () => {
  const reply = makeReplyRow();
  const verdict = await evaluateInternalProofContactWindowBypass(
    reply,
    makeContext({ scoped_canary_requested_ids: [REPLY_ROW], canary_run_id: "canary-proof-reply-1" })
  );
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.leg, "internal_thread_auto_reply");
});

test("bypass: auto-reply leg is denied without session allowance or inbound linkage", async () => {
  const no_allowance = await evaluateInternalProofContactWindowBypass(
    makeReplyRow(),
    makeContext({
      scoped_canary_requested_ids: [REPLY_ROW],
      getSystemValue: makeGetSystemValue({
        [INTERNAL_PROOF_SESSION_KEY]: JSON.stringify(makeSession({ allow_thread_auto_replies: false })),
      }),
    })
  );
  assert.equal(no_allowance.allowed, false);
  assert.equal(no_allowance.reason, "thread_auto_replies_not_allowed");

  const no_linkage = await evaluateInternalProofContactWindowBypass(
    makeReplyRow({ inbound_message_id: null, metadata: { source_event_id: undefined, origin_surface: "canonical_automation" } }),
    makeContext({ scoped_canary_requested_ids: [REPLY_ROW] })
  );
  assert.equal(no_linkage.allowed, false);
  assert.equal(no_linkage.reason, "auto_reply_missing_inbound_linkage");
});

test("bypass: getSystemValue failure denies fail-closed", async () => {
  const verdict = await evaluateInternalProofContactWindowBypass(
    makePinnedRow(),
    makeContext({
      getSystemValue: async () => {
        throw new Error("system_control_unreachable");
      },
    })
  );
  assert.equal(verdict.allowed, false);
});

// ── Integration: processSendQueueItem contact-window branch ─────────────────

function makeItemDeps(overrides = {}) {
  const updates = [];
  const lock_updates = [];
  const info_calls = [];
  const deps = {
    now: NOW,
    claimedLockToken: "lock-token-proof",
    getSystemValue: makeGetSystemValue(),
    scoped_canary: true,
    authorization_validated: true,
    canary_run_id: "canary-proof-run-1",
    scoped_canary_max_rows: 1,
    scoped_canary_requested_ids: [PINNED_ROW],
    updateQueueRow: async (id, payload) => {
      updates.push({ id, payload });
      return { ok: true, id, payload };
    },
    updateSendQueueRowWithLock: async (id, lock_token, payload) => {
      lock_updates.push({ id, lock_token, payload });
      return normalizeSendQueueRow({ id, ...payload });
    },
    info: (event, meta) => info_calls.push({ event, meta }),
    warn: () => {},
    supabase: {
      from() {
        throw new Error("unexpected_supabase_access_in_test");
      },
    },
    ...overrides,
  };
  return { deps, updates, lock_updates, info_calls };
}

test("integration: real seller row remains deferred outside contact hours", async () => {
  const seller_row = makePinnedRow({
    id: REAL_SELLER_ROW,
    to_phone_number: "+16125551234",
    thread_key: "+16125551234",
    metadata: { internal_canary: undefined, origin_surface: "campaign_feeder" },
  });
  const { deps, lock_updates } = makeItemDeps({
    scoped_canary_requested_ids: [REAL_SELLER_ROW],
  });
  const result = await processSendQueueItem(seller_row, deps);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "deferred_contact_window");
  assert.equal(result.final_queue_status, "scheduled");
  assert.equal(lock_updates.length, 1);
  assert.equal(lock_updates[0].payload.metadata.deferred_contact_window, true);
});

test("integration: pinned canary row passes the contact window under the full conjunction", async () => {
  // provider_message_sid evidence makes the row terminate at the idempotency
  // guard immediately after the window branch — proving it crossed the window
  // without touching the provider.
  const row = makePinnedRow({ metadata: { provider_message_sid: "SMevidence1" } });
  const { deps, lock_updates } = makeItemDeps();
  const result = await processSendQueueItem(row, deps);
  assert.equal(result.sent, true);
  assert.equal(result.reason, "idempotency_blocked_sid_exists");
  // Durable, lock-gated bypass audit stamped onto the row before transport.
  const bypass_update = lock_updates.find((u) => u.payload?.metadata?.contact_window_bypass);
  assert.ok(bypass_update, "lock-gated bypass audit write expected");
  assert.equal(bypass_update.lock_token, "lock-token-proof");
  assert.equal(bypass_update.payload.metadata.contact_window_bypass.leg, "primary_canary_row");
  assert.equal(bypass_update.payload.metadata.contact_window_bypass.session_id, "proof-20260801T0500Z");
  assert.equal(bypass_update.payload.metadata.contact_window_bypass.canary_run_id, "canary-proof-run-1");
  assert.ok(
    !lock_updates.some((u) => u.payload?.queue_status === "scheduled"),
    "row must not be deferred"
  );
});

test("integration: denied lock-gated audit write falls back to deferral", async () => {
  const row = makePinnedRow({ metadata: { provider_message_sid: "SMevidence6" } });
  const textgrid_calls = [];
  const { deps, lock_updates } = makeItemDeps({
    sendTextgridSMS: async (fields) => {
      textgrid_calls.push(fields);
      return { ok: true, sid: "SM_must_never_send" };
    },
    updateSendQueueRowWithLock: async (id, lock_token, payload) => {
      lock_updates.push({ id, lock_token, payload });
      // Simulate a stolen lock: the bypass audit write does not land, the
      // deferral release afterwards does.
      return payload?.metadata?.contact_window_bypass ? null : { id, ...payload };
    },
  });
  const result = await processSendQueueItem(row, deps);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "deferred_contact_window");
  // Zero-row audit write is a denied bypass, never a transport failure: no
  // TextGrid call, no failed finalization.
  assert.equal(textgrid_calls.length, 0, "TextGrid must never be called");
  assert.notEqual(result.sent, true);
  assert.ok(!lock_updates.some((u) => u.payload?.queue_status === "failed"));
});

test("integration: thrown lock-gated audit write denies the bypass without a transport failure", async () => {
  // A Supabase error thrown from the audit write must read as "bypass denied",
  // never as a send failure: the row defers normally, is not finalized failed,
  // writes no outbound FAILURE event, and TextGrid is never called.
  const row = makePinnedRow();
  const textgrid_calls = [];
  const { deps, lock_updates } = makeItemDeps({
    sendTextgridSMS: async (fields) => {
      textgrid_calls.push(fields);
      return { ok: true, sid: "SM_must_never_send" };
    },
    updateSendQueueRowWithLock: async (id, lock_token, payload) => {
      lock_updates.push({ id, lock_token, payload });
      if (payload?.metadata?.contact_window_bypass) {
        throw new Error("supabase_unreachable_audit_write");
      }
      return normalizeSendQueueRow({ id, ...payload });
    },
  });
  // The queue logger is module-scoped (not DI'd) and emits JSON lines through
  // console.log outside development — capture them to observe warn events.
  const logged_events = [];
  const original_console_log = console.log;
  console.log = (...args) => {
    for (const arg of args) {
      if (typeof arg === "string" && arg.startsWith("{")) {
        try {
          const entry = JSON.parse(arg);
          if (entry?.event) logged_events.push(entry);
        } catch {}
      }
    }
  };
  let result;
  try {
    result = await processSendQueueItem(row, deps);
  } finally {
    console.log = original_console_log;
  }
  // Denied bypass falls through to the ordinary contact-window deferral.
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "deferred_contact_window");
  assert.equal(result.final_queue_status, "scheduled");
  assert.notEqual(result.sent, true);
  const deferral_update = lock_updates.find(
    (u) => u.payload?.metadata?.deferred_contact_window === true
  );
  assert.ok(deferral_update, "deferral release expected after the thrown audit write");
  assert.equal(deferral_update.payload.queue_status, "scheduled");
  // The audit failure is surfaced as its own warnings (failed + denied)...
  assert.ok(
    logged_events.some(
      (e) =>
        e.event === "queue.contact_window_bypass_audit_write_failed" &&
        e.meta?.queue_row_id === PINNED_ROW &&
        e.meta?.message === "supabase_unreachable_audit_write"
    ),
    "audit write failure warning expected"
  );
  assert.ok(
    logged_events.some((e) => e.event === "queue.contact_window_bypass_audit_write_denied"),
    "denied-bypass warning expected"
  );
  // ...and the transport-failure path never runs: no TextGrid call, no
  // transport-failure log, no failed finalization, no outbound FAILURE event,
  // and no bypass-crossed info event.
  assert.equal(textgrid_calls.length, 0, "TextGrid must never be called");
  assert.ok(!logged_events.some((e) => e.event === "queue.textgrid_send_failure"));
  assert.ok(!logged_events.some((e) => e.event === "queue.failure_message_event_write_failed"));
  assert.ok(!logged_events.some((e) => e.event === "queue.contact_window_internal_proof_bypass"));
  assert.ok(!lock_updates.some((u) => u.payload?.queue_status === "failed"));
});

test("integration: expired session restores the deferral automatically", async () => {
  const row = makePinnedRow({ metadata: { provider_message_sid: "SMevidence2" } });
  const { deps, lock_updates } = makeItemDeps({
    getSystemValue: makeGetSystemValue({
      [INTERNAL_PROOF_SESSION_KEY]: JSON.stringify(
        makeSession({ expires_at: "2026-08-01T05:29:00.000Z" })
      ),
    }),
  });
  const result = await processSendQueueItem(row, deps);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "deferred_contact_window");
  assert.equal(lock_updates.length, 1);
});

test("integration: internal thread auto-reply passes the window during the session", async () => {
  const reply = makeReplyRow({ metadata: { provider_message_sid: "SMevidence3", source_event_id: "evt-internal-inbound-1", origin_surface: "canonical_automation" } });
  const { deps, lock_updates } = makeItemDeps({
    canary_run_id: "canary-proof-reply-1",
    scoped_canary_requested_ids: [REPLY_ROW],
  });
  const result = await processSendQueueItem(reply, deps);
  assert.equal(result.sent, true);
  assert.equal(result.reason, "idempotency_blocked_sid_exists");
  const bypass_update = lock_updates.find((u) => u.payload?.metadata?.contact_window_bypass);
  assert.equal(bypass_update.payload.metadata.contact_window_bypass.leg, "internal_thread_auto_reply");
});

// ── Scoped-canary allowlist: quarantine-marked internal rows stay dispatchable ──

test("allowlist: quarantine-stamped internal canary row is dispatchable; no-send rows never are", async () => {
  const { validateScopedCanaryAllowlist } = await import(
    "@/lib/domain/queue/run-scoped-campaign-canary.js"
  );
  // Builder-shaped internal canary row: internal_test_phone + exclude_from_kpis
  // + internal_canary, addressed to the registered internal recipient.
  const internal_row = makePinnedRow({
    metadata: { internal_test_phone: true, exclude_from_kpis: true },
  });
  const ok_result = validateScopedCanaryAllowlist([internal_row], {
    campaign_id: CAMPAIGN,
    queue_row_ids: [PINNED_ROW],
  });
  assert.equal(ok_result.ok, true, ok_result.reason);

  // Same markers on a REAL seller recipient: still excluded.
  const seller_marked = makePinnedRow({
    to_phone_number: "+16125551234",
    thread_key: "+16125551234",
    metadata: { internal_test_phone: true, exclude_from_kpis: true, internal_canary: undefined },
  });
  const seller_result = validateScopedCanaryAllowlist([seller_marked], {
    campaign_id: CAMPAIGN,
    queue_row_ids: [PINNED_ROW],
  });
  assert.equal(seller_result.ok, false);
  assert.equal(seller_result.reason, "scoped_canary_proof_row_excluded");

  // Absolute no-send markers exclude even a genuine internal canary row.
  const no_send_row = makePinnedRow({ metadata: { no_send: true } });
  const no_send_result = validateScopedCanaryAllowlist([no_send_row], {
    campaign_id: CAMPAIGN,
    queue_row_ids: [PINNED_ROW],
  });
  assert.equal(no_send_result.ok, false);
  assert.equal(no_send_result.reason, "scoped_canary_proof_row_excluded");
});

test("integration: auto-reply outside the session allowance stays deferred", async () => {
  const reply = makeReplyRow({ metadata: { provider_message_sid: "SMevidence4", source_event_id: "evt-internal-inbound-1", origin_surface: "canonical_automation" } });
  const { deps, lock_updates } = makeItemDeps({
    canary_run_id: "canary-proof-reply-1",
    scoped_canary_requested_ids: [REPLY_ROW],
    getSystemValue: makeGetSystemValue({
      [INTERNAL_PROOF_SESSION_KEY]: JSON.stringify(makeSession({ allow_thread_auto_replies: false })),
    }),
  });
  const result = await processSendQueueItem(reply, deps);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "deferred_contact_window");
  assert.equal(lock_updates.length, 1);
});

test("integration: normal (non-canary) dispatch context never bypasses", async () => {
  // Under queue_execution_mode=scoped_canary_only the canonical send authority
  // now denies an UNRESTRICTED (non-canary) dispatch before the contact-window
  // logic is even reached. That is strictly stronger than the original
  // guarantee: not only is the bypass unavailable, the send is refused outright
  // and nothing is claimed.
  const row = makePinnedRow({ metadata: { provider_message_sid: "SMevidence5" } });
  const { deps, lock_updates } = makeItemDeps({
    scoped_canary: undefined,
    authorization_validated: undefined,
    canary_run_id: undefined,
    scoped_canary_max_rows: undefined,
    scoped_canary_requested_ids: undefined,
  });
  const result = await processSendQueueItem(row, deps);
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  // Brakes are evaluated before the execution-mode gate, so either canonical
  // denial is correct here. The guarantee under test is that an unrestricted
  // context is REFUSED and claims nothing -- not which gate fired first.
  assert.ok(
    ["queue_processor_paused", "queue_emergency_stop_active", "queue_execution_mode_scoped_canary_only"].includes(result.reason),
    `unexpected denial reason: ${result.reason}`
  );
  assert.equal(lock_updates.length, 0, "a denied dispatch claims nothing");
});

test("integration: non-canary dispatch under an AUTHORIZING mode still defers on the contact window", async () => {
  // The original coverage, preserved: with execution mode `normal` the send
  // authority permits, so the contact-window rail is the thing under test and
  // a non-canary context still gets no bypass.
  const row = makePinnedRow({ metadata: { provider_message_sid: "SMevidence5b" } });
  const { deps, lock_updates } = makeItemDeps({
    scoped_canary: undefined,
    authorization_validated: undefined,
    canary_run_id: undefined,
    scoped_canary_max_rows: undefined,
    scoped_canary_requested_ids: undefined,
    getSystemValue: makeGetSystemValue({
      queue_execution_mode: "normal",
      queue_processor_mode: "live",
    }),
  });
  const result = await processSendQueueItem(row, deps);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "deferred_contact_window");
  assert.equal(lock_updates.length, 1);
});

// ── Internal-phone quarantine stamp at the queue-insert choke point ─────────

test("insertSupabaseSendQueueRow: stamps internal_canary for internal recipients", async () => {
  let captured = null;
  const result = await insertSupabaseSendQueueRow(
    {
      to_phone_number: RECIPIENT,
      from_phone_number: SENDER,
      thread_key: RECIPIENT,
      message_body: "Internal proof auto reply body.",
      queue_status: "queued",
    },
    {
      now: NOW,
      insertSupabaseSendQueueRow: (payload) => ({ ok: true, queue_row_id: "q-1", raw: payload }),
    }
  );
  captured = result.raw;
  assert.equal(captured.metadata.internal_canary, true);
  assert.equal(captured.metadata.internal_canary_stamped_by, "internal_phone_registry");
});

test("insertSupabaseSendQueueRow: does not stamp real seller recipients", async () => {
  const result = await insertSupabaseSendQueueRow(
    {
      to_phone_number: "+16125551234",
      from_phone_number: SENDER,
      thread_key: "+16125551234",
      message_body: "Normal outbound body for a seller.",
      queue_status: "queued",
    },
    {
      now: NOW,
      insertSupabaseSendQueueRow: (payload) => ({ ok: true, queue_row_id: "q-2", raw: payload }),
    }
  );
  assert.equal(result.raw.metadata?.internal_canary, undefined);
  assert.equal(result.raw.metadata?.internal_canary_stamped_by, undefined);
});
