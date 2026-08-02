// ─── inbound-terminal-disposition.test.mjs ───────────────────────────────────
// The canonical disposition contract: every handler result maps to exactly one
// of the ten dispositions; the resolver never returns anything else; the
// ledger refuses non-canonical values; the handler wrapper records a
// disposition even when the core throws.

import test from "node:test";
import assert from "node:assert/strict";

import {
  TERMINAL_DISPOSITIONS,
  TERMINAL_DISPOSITION_SET,
  isTerminalDisposition,
  resolveInboundTerminalDisposition,
} from "@/lib/domain/inbound/terminal-disposition.js";
import {
  beginInboundLedgerEntry,
  recordInboundTerminalDisposition,
} from "@/lib/domain/inbound/inbound-processing-ledger.js";
import {
  handleTextgridInboundWebhook,
  __setTextgridInboundTestDeps,
  __resetTextgridInboundTestDeps,
} from "@/lib/flows/handle-textgrid-inbound.js";

test("canonical set is exactly the ten launch dispositions", () => {
  assert.deepEqual(
    [...TERMINAL_DISPOSITION_SET].sort(),
    [
      "duplicate_ignored",
      "failed_retriable",
      "failed_terminal",
      "human_review_required",
      "no_reply_required",
      "reply_deferred_compliance",
      "reply_sent",
      "suppressed_opt_out",
      "suppressed_wrong_number",
      "suppressed_policy",
    ].sort()
  );
});

test("resolver maps every handler result shape to a canonical disposition", () => {
  const cases = [
    [null, TERMINAL_DISPOSITIONS.HUMAN_REVIEW_REQUIRED],
    [{ ok: true, stage: "after_extract" }, TERMINAL_DISPOSITIONS.NO_REPLY_REQUIRED],
    [{ ok: true, duplicate: true }, TERMINAL_DISPOSITIONS.DUPLICATE_IGNORED],
    [{ ok: false, reason: "missing_inbound_from" }, TERMINAL_DISPOSITIONS.FAILED_TERMINAL],
    [{ ok: false, reason: "empty_inbound_body" }, TERMINAL_DISPOSITIONS.HUMAN_REVIEW_REQUIRED],
    [{ ok: false, reason: "textgrid_inbound_failed_podio_write" }, TERMINAL_DISPOSITIONS.FAILED_RETRIABLE],
    [
      { ok: true, classification: { compliance_flag: "stop_texting" } },
      TERMINAL_DISPOSITIONS.SUPPRESSED_OPT_OUT,
    ],
    [
      { ok: true, classification: { primary_intent: "wrong_number" } },
      TERMINAL_DISPOSITIONS.SUPPRESSED_WRONG_NUMBER,
    ],
    [
      { ok: true, classification: { primary_intent: "seller_interested" }, seller_stage_reply: { queued: true, queue_row_id: "q1" } },
      TERMINAL_DISPOSITIONS.REPLY_SENT,
    ],
    [
      { ok: true, classification: {}, seller_stage_reply: { queued: false, reason: "manual_review_required" } },
      TERMINAL_DISPOSITIONS.HUMAN_REVIEW_REQUIRED,
    ],
    [
      { ok: true, classification: {}, seller_stage_reply: { queued: false, reason: "deferred_contact_window" } },
      TERMINAL_DISPOSITIONS.REPLY_DEFERRED_COMPLIANCE,
    ],
    [
      { ok: true, classification: {}, seller_stage_reply: { queued: false, reason: "suppressed_by_auto_reply_plan" } },
      TERMINAL_DISPOSITIONS.SUPPRESSED_POLICY,
    ],
    [
      { ok: true, classification: { primary_intent: "hostile_or_legal" }, seller_stage_reply: { queued: false, reason: "x" } },
      TERMINAL_DISPOSITIONS.HUMAN_REVIEW_REQUIRED,
    ],
    [
      { ok: true, classification: { primary_intent: "acknowledgement" }, seller_stage_reply: { queued: false, reason: "system_control_disabled" } },
      TERMINAL_DISPOSITIONS.NO_REPLY_REQUIRED,
    ],
  ];

  for (const [input, want] of cases) {
    const { disposition } = resolveInboundTerminalDisposition(input);
    assert.equal(disposition, want, JSON.stringify(input));
    assert.ok(isTerminalDisposition(disposition));
  }
});

test("ledger refuses non-canonical dispositions", async () => {
  const result = await recordInboundTerminalDisposition(
    { idempotency_key: "k1", disposition: "made_up_state" },
    { supabase: { from: () => ({}) } }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_terminal_disposition");
});

test("ledger persists a failed_retriable terminal disposition with the error message", async () => {
  const recorded = [];
  const supabase_double = (() => {
    const rows = new Map();
    return {
      from() {
        const chain = {
          _filters: {},
          select: () => chain,
          eq: (col, val) => ((chain._filters[col] = val), chain),
          maybeSingle: async () => ({ data: rows.get(chain._filters.idempotency_key) || null, error: null }),
          single: async () => ({ data: { id: "ledger-1" }, error: null }),
          insert: (row) => ({
            select: () => ({
              single: async () => {
                rows.set(row.idempotency_key, { id: "ledger-1", status: "processing", attempt_count: 1 });
                return { data: { id: "ledger-1" }, error: null };
              },
            }),
          }),
          update: (patch) => {
            recorded.push(patch);
            return {
              // The writer requests { count: "exact" }; exactly one row matched.
              eq: async () => ({ error: null, count: 1 }),
            };
          },
        };
        return chain;
      },
    };
  })();

  const begin = await beginInboundLedgerEntry(
    { idempotency_key: "textgrid_inbound:SMx", provider_message_sid: "SMx" },
    { supabase: supabase_double }
  );
  assert.equal(begin.ok, true);
  const record_result = await recordInboundTerminalDisposition(
    {
      ledger_id: begin.ledger_id,
      idempotency_key: "textgrid_inbound:SMx",
      disposition: TERMINAL_DISPOSITIONS.FAILED_RETRIABLE,
      error_message: "boom",
    },
    { supabase: supabase_double }
  );
  assert.equal(record_result.ok, true);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].status, "failed");
  assert.equal(recorded[0].terminal_disposition, "failed_retriable");
  assert.equal(recorded[0].error_message, "boom");
});

test("handler wrapper records failed_retriable when the core throws", async () => {
  const recorded = [];
  __setTextgridInboundTestDeps({
    beginInboundLedgerEntry: async () => ({ ok: true, ledger_id: "ledger-throw-1" }),
    recordInboundTerminalDisposition: async (args) => {
      recorded.push(args);
      return { ok: true, disposition: args.disposition };
    },
    // First awaited dependency inside the core: throwing here proves the
    // WRAPPER's catch path records the disposition — no inner failure handler
    // is reachable yet.
    getSystemFlags: async () => {
      throw new Error("core exploded");
    },
  });
  try {
    await assert.rejects(
      () =>
        handleTextgridInboundWebhook({
          message_id: "SM-throw-1",
          from: "+15550000001",
          to: "+15550000002",
          body: "hello",
          status: "received",
        }),
      /core exploded/
    );
  } finally {
    __resetTextgridInboundTestDeps();
  }

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].disposition, TERMINAL_DISPOSITIONS.FAILED_RETRIABLE);
  assert.equal(recorded[0].idempotency_key, "textgrid_inbound:SM-throw-1");
  assert.equal(recorded[0].ledger_id, "ledger-throw-1");
  assert.equal(recorded[0].error_message, "core exploded");
  assert.deepEqual(recorded[0].detail, { thrown: true });
});
