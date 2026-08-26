// ─── inbound-cancellation-policy-scope.test.mjs ──────────────────────────────
// Certification regression: pending-outbound cancellation scope.
//
// Root defect locked here (backend certification pass, 2026-08-25):
//   * The burst coordinator passed policy "superseded_by_newer_inbound" —
//     not a member of CANCELLATION_POLICIES — and both burst wirings fell
//     through to the COMPLIANCE_TERMINAL default (no type filter), so every
//     benign inbound fragment cancelled unrelated campaign touches.
//   * The "never cancel a newer inbound's reply" guard required
//     INBOUND_TAKEOVER + inbound_received_at, which no production caller
//     passed — a slow older inbound could cancel a newer inbound's queued
//     reply (silent reply drop).
// Now: unknown policies fail NARROW (inbound_takeover + warn), the burst
// wirings pass inbound_takeover + inbound_received_at, and the compliance
// paths still cancel everything.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  cancelSupabasePendingOutbound,
  CANCELLATION_POLICIES,
} from "@/lib/domain/queue/cancel-supabase-pending-outbound.js";

const THREAD = "+15005550006";
const NOW = "2026-08-25T18:00:00.000Z";

function makeRow(id, overrides = {}) {
  return {
    id,
    thread_key: THREAD,
    to_phone_number: THREAD,
    queue_status: "queued",
    type: "auto_reply",
    message_type: null,
    metadata: {},
    master_owner_id: null,
    prospect_id: null,
    property_id: null,
    phone_number_id: null,
    created_at: "2026-08-25T17:00:00.000Z",
    ...overrides,
  };
}

function makeSupabase(rows) {
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  function applyFilters(filters) {
    let result = [...byId.values()];
    for (const f of filters) {
      if (f.op === "eq") result = result.filter((r) => String(r[f.col]) === String(f.val));
      if (f.op === "in") result = result.filter((r) => f.vals.includes(r[f.col]));
    }
    return result;
  }
  return {
    from(table) {
      assert.equal(table, "send_queue");
      return {
        select() {
          const q = {
            _filters: [],
            eq(col, val) { q._filters.push({ op: "eq", col, val }); return q; },
            in(col, vals) { q._filters.push({ op: "in", col, vals }); return q; },
            limit() { return { data: applyFilters(q._filters), error: null }; },
          };
          return q;
        },
        update(patch) {
          const u = {
            _filters: [],
            eq(col, val) { u._filters.push({ op: "eq", col, val }); return u; },
            in(col, vals) {
              u._filters.push({ op: "in", col, vals });
              const targets = applyFilters(u._filters);
              for (const row of targets) Object.assign(row, patch);
              return { error: null };
            },
          };
          return u;
        },
      };
    },
  };
}

test("COMPLIANCE_TERMINAL cancels every pending outbound type", async () => {
  const rows = [
    makeRow("r1", { type: "auto_reply" }),
    makeRow("r2", { type: "followup" }),
    makeRow("r3", { type: "initial_outreach", message_type: "Campaign" }),
  ];
  const result = await cancelSupabasePendingOutbound(
    {
      thread_key: THREAD,
      policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL,
      reason: "opt_out",
      inbound_event_id: "evt-1",
      now: NOW,
    },
    { supabase: makeSupabase(rows) }
  );
  assert.equal(result.cancelled, 3);
  assert.ok(rows.every((r) => r.queue_status === "cancelled"));
});

test("INBOUND_TAKEOVER cancels only automated reply/follow-up rows, never campaign touches", async () => {
  const rows = [
    makeRow("r1", { type: "auto_reply" }),
    makeRow("r2", { type: "followup" }),
    makeRow("r3", { type: "initial_outreach", message_type: "Campaign" }),
  ];
  const result = await cancelSupabasePendingOutbound(
    {
      thread_key: THREAD,
      policy: CANCELLATION_POLICIES.INBOUND_TAKEOVER,
      reason: "superseded_by_newer_inbound",
      inbound_event_id: "evt-1",
      now: NOW,
    },
    { supabase: makeSupabase(rows) }
  );
  assert.equal(result.cancelled, 2);
  assert.equal(rows[0].queue_status, "cancelled");
  assert.equal(rows[1].queue_status, "cancelled");
  assert.equal(rows[2].queue_status, "queued", "campaign touch must survive a benign inbound");
});

test("unknown policy fails NARROW (the historical fall-through cancelled everything)", async () => {
  const rows = [
    makeRow("r1", { type: "auto_reply" }),
    makeRow("r3", { type: "initial_outreach", message_type: "Campaign" }),
  ];
  const result = await cancelSupabasePendingOutbound(
    {
      thread_key: THREAD,
      policy: "superseded_by_newer_inbound", // the exact invalid string production passed
      reason: "superseded_by_newer_inbound",
      inbound_event_id: "evt-1",
      now: NOW,
    },
    { supabase: makeSupabase(rows) }
  );
  assert.equal(result.cancelled, 1);
  assert.equal(rows[0].queue_status, "cancelled");
  assert.equal(rows[1].queue_status, "queued", "unknown policy must never widen to compliance scope");
});

test("supersession guard: a reply queued for a NEWER inbound survives an older inbound's takeover", async () => {
  const inbound_received_at = "2026-08-25T17:30:00.000Z";
  const rows = [
    makeRow("older", { type: "auto_reply", created_at: "2026-08-25T17:00:00.000Z" }),
    makeRow("newer", { type: "auto_reply", created_at: "2026-08-25T17:45:00.000Z" }),
  ];
  const result = await cancelSupabasePendingOutbound(
    {
      thread_key: THREAD,
      policy: CANCELLATION_POLICIES.INBOUND_TAKEOVER,
      reason: "superseded_by_newer_inbound",
      inbound_event_id: "evt-old",
      inbound_received_at,
      now: NOW,
    },
    { supabase: makeSupabase(rows) }
  );
  assert.equal(result.cancelled, 1);
  assert.equal(rows[0].queue_status, "cancelled", "stale pre-inbound reply is superseded");
  assert.equal(rows[1].queue_status, "queued", "the newer inbound's reply must never be cancelled");
});

test("a row owned by the cancelling inbound event itself is never cancelled", async () => {
  const rows = [
    makeRow("own", {
      type: "auto_reply",
      metadata: { inbound_message_event_id: "evt-self" },
    }),
  ];
  const result = await cancelSupabasePendingOutbound(
    {
      thread_key: THREAD,
      policy: CANCELLATION_POLICIES.INBOUND_TAKEOVER,
      reason: "superseded_by_newer_inbound",
      inbound_event_id: "evt-self",
      now: NOW,
    },
    { supabase: makeSupabase(rows) }
  );
  assert.equal(result.cancelled, 0);
  assert.equal(rows[0].queue_status, "queued");
});

// ── Phase 8 (closure pass 2026-08-26, operator-directed) ────────────────────
// OPERATOR RULE: "not interested" / "not for sale" does NOT cancel further
// communication — the seller flow schedules the nurture follow-up. Soft
// negatives therefore run INBOUND_TAKEOVER (supersede the stale queued
// auto-reply/follow-up, which the flow replaces) and never touch campaign
// rows. PROPERTY_DISPOSITION below is reserved for a SOLD property (factually
// terminal): its campaign touches stop, the owner's other properties survive,
// the contact is never suppressed.
test("PROPERTY_DISPOSITION (sold pairing): cancels replies/follow-ups + SOLD-property campaign touches; other properties survive", async () => {
  const rows = [
    makeRow("r-reply", { type: "auto_reply", property_id: "prop-A" }),
    makeRow("r-follow", { type: "followup", property_id: "prop-A" }),
    makeRow("r-camp-A", { type: "initial_outreach", message_type: "Campaign", property_id: "prop-A" }),
    makeRow("r-camp-B", { type: "initial_outreach", message_type: "Campaign", property_id: "prop-B" }),
  ];
  const result = await cancelSupabasePendingOutbound(
    {
      thread_key: THREAD,
      property_id: "prop-A",
      policy: CANCELLATION_POLICIES.PROPERTY_DISPOSITION,
      reason: "inbound_negative_reply",
      inbound_event_id: "evt-soft-1",
      now: NOW,
    },
    { supabase: makeSupabase(rows) }
  );
  assert.equal(result.cancelled, 3);
  assert.equal(rows[0].queue_status, "cancelled");
  assert.equal(rows[1].queue_status, "cancelled");
  assert.equal(rows[2].queue_status, "cancelled", "current-property campaign touch stops");
  assert.equal(rows[3].queue_status, "queued", "the owner's OTHER property keeps its valid outreach");
});

test("classifyNegativeReply: hard vs soft vocabulary", async () => {
  const { classifyNegativeReply } = await import(
    "../../src/lib/domain/classification/is-negative-reply.js"
  );
  for (const hard of ["STOP", "stop texting me", "unsubscribe", "remove me", "wrong number", "don't contact me again"]) {
    assert.equal(classifyNegativeReply(hard), "hard", hard);
  }
  for (const soft of ["not interested", "not for sale", "no thanks", "wrong house", "not selling"]) {
    assert.equal(classifyNegativeReply(soft), "soft", soft);
  }
  assert.equal(classifyNegativeReply("sounds good, tell me more"), null);
});

test("PROPERTY_DISPOSITION honors the newer-inbound supersession guard", async () => {
  const inbound_received_at = "2026-08-25T17:30:00.000Z";
  const rows = [
    makeRow("newer-reply", { type: "auto_reply", property_id: "prop-A", created_at: "2026-08-25T17:45:00.000Z" }),
  ];
  const result = await cancelSupabasePendingOutbound(
    {
      thread_key: THREAD,
      property_id: "prop-A",
      policy: CANCELLATION_POLICIES.PROPERTY_DISPOSITION,
      reason: "inbound_negative_reply",
      inbound_event_id: "evt-old-soft",
      inbound_received_at,
      now: NOW,
    },
    { supabase: makeSupabase(rows) }
  );
  assert.equal(result.cancelled, 0);
  assert.equal(rows[0].queue_status, "queued", "a newer inbound's reply survives an older soft negative");
});
