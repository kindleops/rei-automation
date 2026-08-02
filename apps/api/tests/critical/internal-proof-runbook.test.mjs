// ─── internal-proof-runbook.test.mjs ─────────────────────────────────────────
// Operator-runbook contract tests for the bounded internal-proof session:
//   * open-session renewal preserves the FIRST-open created_at — repeated
//     opens can never reset the absolute session lifetime;
//   * the hard absolute cap is enforced from that first-open timestamp
//     (renewals clamp to it; an exhausted lifetime refuses to extend);
//   * an expired/absent session starts a deliberate fresh lifetime;
//   * getControl surfaces Supabase read errors instead of returning null;
//   * close never claims "expired" unless the expiry write succeeds AND is
//     read back and verified;
//   * stamp-reply is a conditional write keyed on the observed queue_status,
//     verifies exactly one row matched, and aborts loudly otherwise.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createInternalProofRunbook,
  PINNED,
  SESSION_ABSOLUTE_MAX_MINUTES,
} from "../../scripts/ops/internal-proof-runbook.mjs";
import {
  INTERNAL_PROOF_SESSION_MAX_MINUTES,
  parseInternalProofSession,
} from "@/lib/domain/queue/internal-proof-session.js";

const NOW_ISO = "2026-08-01T10:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const minutes = (n) => n * 60_000;
const iso = (ms) => new Date(ms).toISOString();

function makeStoredSession(overrides = {}) {
  return {
    session_id: "proof-ORIGINAL0000Z",
    campaign_id: PINNED.campaign,
    queue_row_id: PINNED.row,
    recipient: PINNED.recipient,
    sender: PINNED.sender,
    created_at: iso(NOW_MS - minutes(60)),
    expires_at: iso(NOW_MS + minutes(60)),
    allow_thread_auto_replies: true,
    opened_by: "operator_internal_proof_runbook",
    ...overrides,
  };
}

// Minimal PostgREST-shaped mock covering exactly the chains the runbook uses:
// system_control select/eq/maybeSingle + upsert, and send_queue
// select/eq/neq/in/order/limit + update(payload, {count})/eq/eq.
function makeSupabaseMock({
  controls = {},
  reply_rows = [],
  reply_update_count = 1,
  control_read_error = null, // Error | (key, nth_read_of_key) => Error | null
  drop_upsert_keys = [], // upserts report success but do not persist (lost write)
} = {}) {
  const control_values = new Map(Object.entries(controls));
  const read_counts = new Map();
  const calls = { upserts: [], updates: [], reads: [] };
  const client = {
    from(table) {
      if (table === "system_control") {
        return {
          select() {
            return {
              eq(_column, key) {
                return {
                  async maybeSingle() {
                    const nth = (read_counts.get(key) || 0) + 1;
                    read_counts.set(key, nth);
                    calls.reads.push(key);
                    const failure =
                      typeof control_read_error === "function"
                        ? control_read_error(key, nth)
                        : control_read_error;
                    if (failure) return { data: null, error: failure };
                    return control_values.has(key)
                      ? { data: { value: control_values.get(key) }, error: null }
                      : { data: null, error: null };
                  },
                };
              },
            };
          },
          async upsert(row) {
            calls.upserts.push(row);
            if (!drop_upsert_keys.includes(row.key)) control_values.set(row.key, row.value);
            return { error: null };
          },
        };
      }
      if (table === "send_queue") {
        return {
          select() {
            const chain = {
              eq: () => chain,
              neq: () => chain,
              in: () => chain,
              order: () => chain,
              limit: async () => ({ data: reply_rows, error: null }),
              maybeSingle: async () => ({ data: reply_rows[0] ?? null, error: null }),
            };
            return chain;
          },
          update(payload, options) {
            const update_call = { payload, options, filters: [] };
            calls.updates.push(update_call);
            const chain = {
              eq(column, value) {
                update_call.filters.push([column, value]);
                return chain;
              },
              then(resolve, reject) {
                return Promise.resolve({ data: null, error: null, count: reply_update_count }).then(
                  resolve,
                  reject
                );
              },
            };
            return chain;
          },
        };
      }
      throw new Error(`unexpected table access in test: ${table}`);
    },
  };
  return { client, control_values, calls };
}

function makeRunbook(mock_options = {}) {
  const mock = makeSupabaseMock(mock_options);
  const logs = [];
  const steps = createInternalProofRunbook({
    supabase: mock.client,
    now: () => new Date(NOW_MS),
    log: (...args) =>
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
  });
  return { steps, logs, ...mock };
}

function storedSession(control_values) {
  return JSON.parse(control_values.get("internal_proof_session"));
}

// ── Drift guard ─────────────────────────────────────────────────────────────

test("runbook absolute cap mirrors the engine parser cap", () => {
  assert.equal(SESSION_ABSOLUTE_MAX_MINUTES, INTERNAL_PROOF_SESSION_MAX_MINUTES);
});

// ── open-session lifetime ───────────────────────────────────────────────────

test("open-session: first open stamps created_at=now with a 2h expiry", async () => {
  const { steps, logs, control_values } = makeRunbook();
  await steps["open-session"]();
  const session = storedSession(control_values);
  assert.equal(session.created_at, NOW_ISO);
  assert.equal(session.expires_at, iso(NOW_MS + minutes(120)));
  assert.match(session.session_id, /^proof-/);
  assert.equal(session.renewed_at, undefined);
  assert.ok(logs.some((l) => l.includes("session opened:")));
});

test("open-session renewal: preserves first-open created_at and session_id, never resets the lifetime", async () => {
  const { steps, logs, control_values } = makeRunbook({
    controls: { internal_proof_session: JSON.stringify(makeStoredSession()) },
  });
  await steps["open-session"]();
  const session = storedSession(control_values);
  // First-open timestamp preserved — NOT reset to now.
  assert.equal(session.created_at, iso(NOW_MS - minutes(60)));
  assert.equal(session.session_id, "proof-ORIGINAL0000Z");
  assert.equal(session.renewed_at, NOW_ISO);
  // Renewal window granted, still inside the absolute cap from first open.
  assert.equal(session.expires_at, iso(NOW_MS + minutes(120)));
  assert.ok(logs.some((l) => l.includes("session renewed (first-open preserved):")));
  // The renewed session stays valid under the engine parser.
  const parsed = parseInternalProofSession(JSON.stringify(session), new Date(NOW_MS));
  assert.equal(parsed.ok, true, parsed.reason);
});

test("open-session renewal: hard absolute cap clamps the expiry from first open", async () => {
  // Session first opened 210 minutes ago and still active: a renewal may only
  // extend to first_open + cap (30 more minutes), not now + 2h.
  const { steps, control_values } = makeRunbook({
    controls: {
      internal_proof_session: JSON.stringify(
        makeStoredSession({
          created_at: iso(NOW_MS - minutes(210)),
          expires_at: iso(NOW_MS + minutes(25)),
        })
      ),
    },
  });
  await steps["open-session"]();
  const session = storedSession(control_values);
  assert.equal(session.created_at, iso(NOW_MS - minutes(210)));
  assert.equal(
    session.expires_at,
    iso(NOW_MS - minutes(210) + minutes(SESSION_ABSOLUTE_MAX_MINUTES))
  );
  assert.equal(session.expires_at, iso(NOW_MS + minutes(30)));
  // Exactly at the cap is still engine-parseable (> cap is rejected).
  const parsed = parseInternalProofSession(JSON.stringify(session), new Date(NOW_MS));
  assert.equal(parsed.ok, true, parsed.reason);
});

test("open-session: exhausted absolute lifetime refuses to extend and writes nothing", async () => {
  // A (hand-tampered) still-active session whose first open is already past
  // the cap: renewal must refuse rather than mint any usable expiry.
  const original = JSON.stringify(
    makeStoredSession({
      created_at: iso(NOW_MS - minutes(250)),
      expires_at: iso(NOW_MS + minutes(10)),
    })
  );
  const { steps, control_values, calls } = makeRunbook({
    controls: { internal_proof_session: original },
  });
  await assert.rejects(steps["open-session"](), /absolute lifetime exhausted/);
  assert.equal(control_values.get("internal_proof_session"), original, "session must be untouched");
  assert.ok(!calls.upserts.some((u) => u.key === "internal_proof_session"));
});

test("open-session: an expired session starts a deliberate fresh lifetime", async () => {
  const { steps, control_values } = makeRunbook({
    controls: {
      internal_proof_session: JSON.stringify(
        makeStoredSession({
          created_at: iso(NOW_MS - minutes(300)),
          expires_at: iso(NOW_MS - minutes(10)),
        })
      ),
    },
  });
  await steps["open-session"]();
  const session = storedSession(control_values);
  assert.equal(session.created_at, NOW_ISO);
  assert.equal(session.expires_at, iso(NOW_MS + minutes(120)));
  assert.notEqual(session.session_id, "proof-ORIGINAL0000Z");
  assert.equal(session.renewed_at, undefined);
});

// ── getControl read errors ──────────────────────────────────────────────────

test("getControl: Supabase read errors propagate instead of reading as a missing key", async () => {
  const read_error = new Error("transient system_control read failure");
  const { steps } = makeRunbook({ control_read_error: read_error });
  await assert.rejects(steps["open-session"](), (error) => error === read_error);
});

// ── close verification ──────────────────────────────────────────────────────

test("close: expires the session and claims 'expired' only after read-back verification", async () => {
  const { steps, logs, control_values } = makeRunbook({
    controls: {
      queue_execution_mode: "scoped_canary_only",
      internal_proof_session: JSON.stringify(makeStoredSession()),
    },
  });
  await steps.close();
  assert.equal(control_values.get("queue_execution_mode"), "paused");
  const session = storedSession(control_values);
  assert.equal(session.expires_at, iso(NOW_MS - 1000));
  assert.equal(session.closed_at, NOW_ISO);
  assert.ok(logs.some((l) => l.includes("internal_proof_session expired (verified by read-back)")));
});

test("close: a session read error fails the step and never claims expired", async () => {
  const read_error = new Error("transient session read failure");
  const { steps, logs, control_values } = makeRunbook({
    controls: {
      queue_execution_mode: "scoped_canary_only",
      internal_proof_session: JSON.stringify(makeStoredSession()),
    },
    control_read_error: (key) => (key === "internal_proof_session" ? read_error : null),
  });
  await assert.rejects(steps.close(), (error) => error === read_error);
  // The mode restore already happened, but the session was NOT reported closed.
  assert.equal(control_values.get("queue_execution_mode"), "paused");
  assert.ok(!logs.some((l) => l.includes("internal_proof_session expired")));
});

test("close: a lost expiry write must not claim expired", async () => {
  // Upsert reports success but does not persist: read-back still sees the
  // active session, so close must fail loudly instead of printing "expired".
  const { steps, logs, control_values } = makeRunbook({
    controls: {
      queue_execution_mode: "scoped_canary_only",
      internal_proof_session: JSON.stringify(makeStoredSession()),
    },
    drop_upsert_keys: ["internal_proof_session"],
  });
  await assert.rejects(steps.close(), /did not verify on read-back/);
  assert.ok(!logs.some((l) => l.includes("internal_proof_session expired")));
  // The stored session is untouched and still active.
  const session = storedSession(control_values);
  assert.equal(session.expires_at, iso(NOW_MS + minutes(60)));
});

test("close: a read-back failure after the write must not claim expired", async () => {
  const read_error = new Error("transient read-back failure");
  const { steps, logs } = makeRunbook({
    controls: {
      queue_execution_mode: "scoped_canary_only",
      internal_proof_session: JSON.stringify(makeStoredSession()),
    },
    control_read_error: (key, nth) =>
      key === "internal_proof_session" && nth === 2 ? read_error : null,
  });
  await assert.rejects(steps.close(), (error) => error === read_error);
  assert.ok(!logs.some((l) => l.includes("internal_proof_session expired")));
});

test("close: absent session reports nothing-to-expire, never expired", async () => {
  const { steps, logs, control_values } = makeRunbook({
    controls: { queue_execution_mode: "scoped_canary_only" },
  });
  await steps.close();
  assert.equal(control_values.get("queue_execution_mode"), "paused");
  assert.ok(logs.some((l) => l.includes("internal_proof_session absent — nothing to expire")));
  assert.ok(!logs.some((l) => l.includes("internal_proof_session expired")));
});

test("close: unparseable session value is cleared and the clear is verified", async () => {
  const { steps, logs, control_values } = makeRunbook({
    controls: {
      queue_execution_mode: "scoped_canary_only",
      internal_proof_session: "not-json{{{",
    },
  });
  await steps.close();
  assert.equal(control_values.get("internal_proof_session"), "");
  assert.ok(logs.some((l) => l.includes("cleared (unparseable value removed; verified)")));
  assert.ok(!logs.some((l) => l.includes("internal_proof_session expired")));
});

// ── stamp-reply row concurrency ─────────────────────────────────────────────

function makeReplyRow(overrides = {}) {
  return {
    id: "9a0d0000-0000-4000-8000-0000000000aa",
    queue_status: "queued",
    campaign_id: null,
    metadata: { origin_surface: "canonical_automation", source_event_id: "evt-internal-1" },
    created_at: iso(NOW_MS - minutes(5)),
    ...overrides,
  };
}

test("stamp-reply: conditional update is keyed on the observed queue_status with count verification", async () => {
  const reply = makeReplyRow();
  const { steps, logs, calls } = makeRunbook({ reply_rows: [reply], reply_update_count: 1 });
  await steps["stamp-reply"]();
  assert.equal(calls.updates.length, 1);
  const update = calls.updates[0];
  // Exact-count request and both predicates: id AND the previously observed
  // eligible queue status.
  assert.deepEqual(update.options, { count: "exact" });
  assert.deepEqual(update.filters, [
    ["id", reply.id],
    ["queue_status", "queued"],
  ]);
  // Metadata merge preserves the snapshot and adds the stamp fields.
  assert.equal(update.payload.campaign_id, PINNED.campaign);
  assert.equal(update.payload.metadata.origin_surface, "canonical_automation");
  assert.equal(update.payload.metadata.source_event_id, "evt-internal-1");
  assert.equal(update.payload.metadata.internal_canary, true);
  assert.equal(update.payload.metadata.campaign_id_stamped_for_internal_proof, true);
  assert.equal(update.payload.metadata.campaign_stamped_at, NOW_ISO);
  assert.ok(logs.some((l) => l.includes(`stamped reply row: ${reply.id}`)));
});

test("stamp-reply: aborts when the row transitioned between read and write (count 0)", async () => {
  const reply = makeReplyRow();
  const { steps, logs } = makeRunbook({ reply_rows: [reply], reply_update_count: 0 });
  await assert.rejects(
    steps["stamp-reply"](),
    (error) =>
      error.message.includes(reply.id) &&
      error.message.includes("transitioned from 'queued'") &&
      error.message.includes("nothing stamped")
  );
  assert.ok(!logs.some((l) => l.includes("stamped reply row")));
});

test("stamp-reply: aborts when the update matches more than one row", async () => {
  const reply = makeReplyRow();
  const { steps, logs } = makeRunbook({ reply_rows: [reply], reply_update_count: 2 });
  await assert.rejects(steps["stamp-reply"](), /update matched 2 rows/);
  assert.ok(!logs.some((l) => l.includes("stamped reply row")));
});

test("stamp-reply: refuses a reply row carrying a foreign campaign", async () => {
  const reply = makeReplyRow({ campaign_id: "11111111-1111-4111-8111-111111111111" });
  const { steps, calls } = makeRunbook({ reply_rows: [reply] });
  await assert.rejects(steps["stamp-reply"](), /foreign campaign/);
  assert.equal(calls.updates.length, 0);
});
