// ─── suppression-21610-canonical-precedence.test.mjs ─────────────────────────
// Canonical sms_suppression_list is authoritative over historical send_queue
// 21610 evidence. No internal-canary bypass. No dispatch.

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  isPhoneSuppressedFor21610,
  build21610ReconciliationResult,
  enqueueSendQueueItem,
} from "@/lib/supabase/sms-engine.js";

const TO = "+16128072000";
const FROM = "+16128060495";
const OTHER_FROM = "+16125551212";
const HIST_A = "5940278f-ca2b-47b7-9255-573079e33ddd";
const HIST_B = "cea6c250-8b1c-49b0-b2bc-6323e3e0ec69";
const HELD_ID = "856319a0-978f-49ed-b70f-6bdca196f663";

const RECIPIENT_INACTIVE = {
  id: "2016a186-7b46-4eb4-a37a-0fcd41a91987",
  phone_e164: TO,
  is_active: false,
  sender_phone_e164: null,
  suppression_type: "blacklist_pair",
  reason: 'TextGrid HTTP failure: {"status":"400","code":"21610","message":"blacklist"}',
  suppression_reason: 'TextGrid HTTP failure: {"status":"400","code":"21610","message":"blacklist"}',
};

const PAIR_INACTIVE = {
  id: "632de519-a639-4611-92d6-cde84f0f4cd8",
  phone_e164: TO,
  is_active: false,
  sender_phone_e164: FROM,
  suppression_type: "blacklist_pair",
  reason: 'TextGrid HTTP failure: {"status":"400","code":"21610","message":"blacklist"}',
  suppression_reason: 'TextGrid HTTP failure: {"status":"400","code":"21610","message":"blacklist"}',
};

const HIST_QUEUE = [
  {
    id: HIST_A,
    to_phone_number: TO,
    from_phone_number: FROM,
    queue_status: "paused_invalid_queue_row",
    failed_reason: "TextGrid 21610 blacklist rule for self-test From/To pair",
  },
  {
    id: HIST_B,
    to_phone_number: TO,
    from_phone_number: FROM,
    queue_status: "paused_global_lock",
    failed_reason:
      'TextGrid HTTP failure: {"status":"400","code":"21610","message":"The message From/To pair violates a blacklist rule."}',
  },
];

function makeSupabase({ listRows = [], queueRows = [], eventRows = [], throwOn = null } = {}) {
  return {
    from(table) {
      const filters = {};
      const chain = {
        select() {
          return chain;
        },
        eq(col, val) {
          filters[col] = val;
          return chain;
        },
        is(col, val) {
          filters[`is:${col}`] = val;
          return chain;
        },
        in(col, vals) {
          filters[`in:${col}`] = vals;
          return chain;
        },
        or(expr) {
          filters.or = expr;
          return chain;
        },
        ilike(col, val) {
          filters[`ilike:${col}`] = val;
          return chain;
        },
        insert() {
          return {
            select: () => ({
              maybeSingle: async () => ({
                data: null,
                error: new Error("tests must not dispatch or insert live queue rows"),
              }),
            }),
          };
        },
        then(resolve) {
          return Promise.resolve(run()).then(resolve);
        },
      };

      function run() {
        if (throwOn === table) {
          return { data: null, error: new Error(`forced_lookup_error:${table}`), count: null };
        }
        if (table === "send_queue") {
          let rows = queueRows.slice();
          if (filters.to_phone_number) {
            rows = rows.filter((r) => r.to_phone_number === filters.to_phone_number);
          }
          if (filters.from_phone_number) {
            rows = rows.filter((r) => r.from_phone_number === filters.from_phone_number);
          }
          return { data: rows, error: null, count: rows.length };
        }
        if (table === "message_events") {
          let rows = eventRows.slice();
          if (filters.to_phone_number) {
            rows = rows.filter((r) => r.to_phone_number === filters.to_phone_number);
          }
          if (filters.from_phone_number) {
            rows = rows.filter((r) => r.from_phone_number === filters.from_phone_number);
          }
          if (filters.failure_bucket) {
            rows = rows.filter((r) => r.failure_bucket === filters.failure_bucket);
          }
          return { data: rows, error: null, count: rows.length };
        }
        if (table === "sms_suppression_list") {
          let rows = listRows.slice();
          if (filters.phone_e164) rows = rows.filter((r) => r.phone_e164 === filters.phone_e164);
          return { data: rows, error: null, count: rows.length };
        }
        return { data: [], error: null, count: 0 };
      }

      return chain;
    },
  };
}

// ── 1–5: inactive/active with history ───────────────────────────────────────

test("1. active recipient suppression + historical queue failure → blocked", async () => {
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    {
      supabase: makeSupabase({
        listRows: [{ ...RECIPIENT_INACTIVE, is_active: true }],
        queueRows: HIST_QUEUE,
      }),
    }
  );
  assert.equal(result.suppressed, true);
  assert.equal(result.blocked_by_active_21610, true);
  assert.equal(result.scope, "recipient");
});

test("2. inactive recipient suppression + historical queue failure → allowed by 21610 gate", async () => {
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    {
      supabase: makeSupabase({
        listRows: [RECIPIENT_INACTIVE],
        queueRows: HIST_QUEUE,
      }),
    }
  );
  assert.equal(result.suppressed, false);
  assert.equal(result.blocked_by_active_21610, false);
  assert.equal(result.reconciliation_required, false);
  assert.equal(result["21610_gate"], "clear");
  assert.ok(result.historical_evidence_preserved);
});

test("3. active matching pair suppression + historical queue failure → blocked", async () => {
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    {
      supabase: makeSupabase({
        listRows: [{ ...PAIR_INACTIVE, is_active: true }],
        queueRows: HIST_QUEUE,
      }),
    }
  );
  assert.equal(result.suppressed, true);
  assert.equal(result.blocked_by_active_21610, true);
  assert.equal(result.scope, "pair");
});

test("4. inactive matching pair suppression + historical queue failure → allowed", async () => {
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    {
      supabase: makeSupabase({
        listRows: [PAIR_INACTIVE],
        queueRows: HIST_QUEUE,
      }),
    }
  );
  assert.equal(result.suppressed, false);
  assert.equal(result["21610_gate"], "clear");
});

test("5. both recipient and pair canonical inactive + multiple historical failures → allowed", async () => {
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    {
      supabase: makeSupabase({
        listRows: [RECIPIENT_INACTIVE, PAIR_INACTIVE],
        queueRows: HIST_QUEUE,
      }),
    }
  );
  assert.equal(result.suppressed, false);
  assert.equal(result.reconciliation_required, false);
  assert.equal(result.blocked_by_active_21610, false);
  assert.equal(result["21610_gate"], "clear");
  assert.ok(result.historical_evidence_count >= 2);
  assert.deepEqual(
    new Set(result.inactive_canonical_suppression_ids),
    new Set([RECIPIENT_INACTIVE.id, PAIR_INACTIVE.id])
  );
  assert.deepEqual(new Set(result.historical_queue_evidence_ids), new Set([HIST_A, HIST_B]));
});

// ── 6–8: no canonical → reconciliation ──────────────────────────────────────

test("6. no canonical rows + historical recipient/pair failure → blocked, reconciliation required", async () => {
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    {
      supabase: makeSupabase({
        listRows: [],
        queueRows: HIST_QUEUE,
      }),
    }
  );
  assert.equal(result.suppressed, true);
  assert.equal(result.reconciliation_required, true);
  assert.equal(result.reason, "legacy_21610_history_requires_reconciliation");
  assert.equal(result.authorized_to_send, false);
  assert.ok(result.legacy_evidence_row_ids.includes(HIST_A));
  assert.ok(result.legacy_evidence_row_ids.includes(HIST_B));
});

test("7. no canonical rows + historical matching pair failure → blocked, reconciliation required", async () => {
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    {
      supabase: makeSupabase({
        listRows: [],
        queueRows: [HIST_QUEUE[1]],
      }),
    }
  );
  assert.equal(result.suppressed, true);
  assert.equal(result.reconciliation_required, true);
  assert.equal(result.scope, "pair");
});

test("8. no canonical rows + unrelated sender-pair failure → allowed for current sender", async () => {
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    {
      supabase: makeSupabase({
        listRows: [],
        queueRows: [
          {
            id: "other-pair",
            to_phone_number: TO,
            from_phone_number: OTHER_FROM,
            failed_reason: "21610 other pair",
          },
        ],
      }),
    }
  );
  assert.equal(result.suppressed, false);
  assert.equal(result.reconciliation_required, false);
});

// ── 9–10: fail closed + audit metadata ──────────────────────────────────────

test("9. canonical lookup error → fail closed", async () => {
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    { supabase: makeSupabase({ throwOn: "sms_suppression_list" }) }
  );
  assert.equal(result.suppressed, true);
  assert.equal(result.scope, "lookup_failed");
  assert.equal(result["21610_gate"], "fail_closed");
});

test("10. inactive suppression evidence remains returned in audit metadata", async () => {
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    {
      supabase: makeSupabase({
        listRows: [RECIPIENT_INACTIVE, PAIR_INACTIVE],
        queueRows: HIST_QUEUE,
      }),
    }
  );
  assert.equal(result.suppressed, false);
  assert.equal(result.historical_evidence_preserved, true);
  assert.ok(result.inactive_canonical_suppression_ids.includes(RECIPIENT_INACTIVE.id));
  assert.ok(result.inactive_canonical_suppression_ids.includes(PAIR_INACTIVE.id));
  assert.ok(result.historical_queue_evidence_ids.includes(HIST_A));
  assert.ok(result.historical_queue_evidence_ids.includes(HIST_B));
});

// ── 11–13: other paths unchanged / no canary bypass ─────────────────────────

test("11. opt-out/DNC rows without 21610 are not 21610-blocked by this gate", async () => {
  // This gate only evaluates 21610 text; opt-out uses separate paths.
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    {
      supabase: makeSupabase({
        listRows: [
          {
            id: "optout",
            phone_e164: TO,
            is_active: true,
            sender_phone_e164: null,
            suppression_type: "opt_out",
            reason: "seller replied STOP",
            suppression_reason: "opt_out",
          },
        ],
      }),
    }
  );
  assert.equal(result.suppressed, false, "non-21610 active rows must not trip this gate");
});

test("12. public seller (non-internal) uses same precedence — no special casing", async () => {
  const publicTo = "+16125550100";
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: publicTo, from_phone_number: FROM },
    {
      supabase: makeSupabase({
        listRows: [
          {
            id: "pub-inactive",
            phone_e164: publicTo,
            is_active: false,
            sender_phone_e164: FROM,
            suppression_reason: "21610",
          },
        ],
        queueRows: [
          {
            id: "pub-hist",
            to_phone_number: publicTo,
            from_phone_number: FROM,
            failed_reason: "21610",
          },
        ],
      }),
    }
  );
  assert.equal(result.suppressed, false);
  assert.equal(result["21610_gate"], "clear");
});

test("13. internal-canary markers do not change the decision", async () => {
  const result = await isPhoneSuppressedFor21610(
    {
      to_phone_number: TO,
      from_phone_number: FROM,
      // markers ignored by design — only phones matter
      metadata: { internal_canary: true, proof_run: true },
    },
    {
      supabase: makeSupabase({
        listRows: [RECIPIENT_INACTIVE, PAIR_INACTIVE],
        queueRows: HIST_QUEUE,
      }),
    }
  );
  assert.equal(result.suppressed, false);
  assert.equal(result.reconciliation_required, false);
});

// ── 14: held row does not dispatch during tests ─────────────────────────────

test("14. held queue row does not dispatch during tests", async () => {
  let providerCalled = false;
  let insertedStatus = null;
  const base = makeSupabase({
    listRows: [RECIPIENT_INACTIVE, PAIR_INACTIVE],
    queueRows: HIST_QUEUE,
  });
  const supabase = {
    from(table) {
      if (table !== "send_queue") return base.from(table);
      return {
        select: () => base.from(table).select(),
        insert(payload) {
          insertedStatus = payload?.queue_status || null;
          const row = { id: HELD_ID, ...payload };
          return {
            select: () => ({
              maybeSingle: async () => ({ data: row, error: null }),
            }),
          };
        },
      };
    },
  };
  // Terminal held status may insert a held audit row but must never call TextGrid.
  const result = await enqueueSendQueueItem(
    {
      queue_key: `test-held-${Date.now()}`,
      to_phone_number: TO,
      from_phone_number: FROM,
      message_body: "Hi Ryan, test held body about the property.",
      queue_status: "held",
      metadata: {
        internal_canary: true,
        held_row_id: HELD_ID,
        no_dispatch_until_explicit_approval: true,
      },
    },
    {
      supabase,
      textgrid: {
        sendMessage: async () => {
          providerCalled = true;
          throw new Error("must not send");
        },
      },
    }
  );
  assert.equal(providerCalled, false, "TextGrid must not be invoked");
  assert.equal(result.ok, true);
  assert.equal(insertedStatus, "held");
  assert.equal(result.queue_row_id, HELD_ID);
});

// ── Reconciliation helper + production-shaped canary fixture ────────────────

test("build21610ReconciliationResult never authorizes send", () => {
  const r = build21610ReconciliationResult({
    recipient: TO,
    sender: FROM,
    legacy_evidence_row_ids: [HIST_A, HIST_B],
    scope: "pair",
  });
  assert.equal(r.reconciliation_required, true);
  assert.equal(r.authorized_to_send, false);
  assert.equal(r.suppressed, true);
  assert.equal(r.reason_code, "legacy_21610_history_requires_reconciliation");
  assert.deepEqual(r.legacy_evidence_row_ids, [HIST_A, HIST_B]);
});

test("production-shaped canary fixture: inactive canonical + hist queue → 21610 clear", async () => {
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    {
      supabase: makeSupabase({
        listRows: [RECIPIENT_INACTIVE, PAIR_INACTIVE],
        queueRows: HIST_QUEUE,
      }),
    }
  );

  assert.equal(result.blocked_by_active_21610, false);
  assert.equal(result.reconciliation_required, false);
  assert.equal(result.suppressed, false);
  assert.equal(result["21610_gate"], "clear");
  assert.equal(result.historical_evidence_preserved, true);
  assert.ok(result.historical_evidence_count >= 2);
  // Terminal historical failures are not pending outbounds
  assert.ok(
    HIST_QUEUE.every((r) =>
      ["paused_invalid_queue_row", "paused_global_lock", "failed", "failed_transport"].includes(
        r.queue_status
      )
    )
  );
});
