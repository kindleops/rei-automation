import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTimestamp } from "@/lib/utils/normalize-timestamp.js";
import { toTimestamp } from "@/lib/domain/outbound/supabase-candidate-feeder.js";
import {
  SEND_QUEUE_HISTORY_SELECT,
  MESSAGE_EVENTS_HISTORY_SELECT,
  collectRecentTemplateIdsFromRows,
  normalizeOutreachHistoryRow,
} from "@/lib/domain/outbound/outreach-history-projection.js";
import {
  classifyTextGridProviderError,
  extractTextGridProviderCode,
} from "@/lib/domain/messaging/textgrid-provider-error-classifier.js";
import {
  enqueueSendQueueItem,
  insertSupabaseSendQueueRow,
  finalizeSendQueueFailure,
} from "@/lib/supabase/sms-engine.js";

// ─── Timestamp normalization ───────────────────────────────────────────────────

test("normalizeTimestamp: ISO string", () => {
  const iso = "2026-06-22T16:00:00.000Z";
  assert.equal(normalizeTimestamp(iso), Date.parse(iso));
});

test("normalizeTimestamp: timezone offset string", () => {
  const value = "2026-06-22T11:00:00-05:00";
  assert.equal(normalizeTimestamp(value), Date.parse(value));
});

test("normalizeTimestamp: epoch milliseconds", () => {
  assert.equal(normalizeTimestamp(1_700_000_000_000), 1_700_000_000_000);
});

test("normalizeTimestamp: epoch seconds", () => {
  assert.equal(normalizeTimestamp(1_700_000_000), 1_700_000_000_000);
});

test("normalizeTimestamp: Date object", () => {
  const date = new Date("2026-06-22T12:00:00Z");
  assert.equal(normalizeTimestamp(date), date.getTime());
});

test("normalizeTimestamp: null/undefined/empty", () => {
  assert.equal(normalizeTimestamp(null), null);
  assert.equal(normalizeTimestamp(undefined), null);
  assert.equal(normalizeTimestamp(""), null);
});

test("normalizeTimestamp: malformed and invalid calendar values", () => {
  assert.equal(normalizeTimestamp("definitely-not-a-date"), null);
  assert.equal(normalizeTimestamp("2026-13-40T99:99:99Z"), null);
});

test("toTimestamp re-export matches normalizeTimestamp", () => {
  assert.equal(toTimestamp("2026-06-22T10:00:00Z"), normalizeTimestamp("2026-06-22T10:00:00Z"));
});

// ─── History projection contract ───────────────────────────────────────────────

test("history select projections exclude invalid production columns", () => {
  assert.ok(!SEND_QUEUE_HISTORY_SELECT.includes("stage_code"));
  assert.ok(!MESSAGE_EVENTS_HISTORY_SELECT.includes("use_case"));
  assert.ok(!MESSAGE_EVENTS_HISTORY_SELECT.includes("stage_code"));
});

test("normalizeOutreachHistoryRow extracts metadata fallbacks", () => {
  const row = normalizeOutreachHistoryRow({
    template_id: "tmpl_1",
    to_phone_number: "+15550001111",
    created_at: "2026-06-01T00:00:00Z",
    use_case_template: "ownership_check",
    metadata: { template_stage_code: "S1" },
  });
  assert.equal(row.template_id, "tmpl_1");
  assert.equal(row.use_case, "ownership_check");
  assert.equal(row.stage_code, "S1");
});

test("collectRecentTemplateIdsFromRows respects phone and stage filters", () => {
  const cutoff = Date.parse("2026-05-01T00:00:00Z");
  const ids = collectRecentTemplateIdsFromRows(
    [
      {
        template_id: "a",
        to_phone_number: "+15550001111",
        created_at: "2026-06-10T00:00:00Z",
        use_case_template: "ownership_check",
        metadata: { template_stage_code: "S1" },
      },
      {
        template_id: "b",
        to_phone_number: "+15550002222",
        created_at: "2026-06-10T00:00:00Z",
        use_case_template: "ownership_check",
        metadata: { template_stage_code: "S1" },
      },
    ],
    {
      cutoff_ms: cutoff,
      selector: { use_case: "ownership_check", stage_code: "S1", canonical_e164: "+15550001111" },
      normalizePhoneFn: (v) => String(v || "").trim(),
    }
  );
  assert.deepEqual(ids, ["a"]);
});

// ─── 21610 classifier ──────────────────────────────────────────────────────────

test("classifyTextGridProviderError: 21610 is terminal compliance blacklist", () => {
  const error = new Error(
    'TextGrid HTTP failure: {"status":"400","code":"21610","message":"The message From/To pair violates a blacklist rule."}'
  );
  const classified = classifyTextGridProviderError(error);
  assert.equal(extractTextGridProviderCode(error), "21610");
  assert.equal(classified.retryable, false);
  assert.equal(classified.is_terminal, true);
  assert.equal(classified.compliance_related, true);
  assert.equal(classified.non_retryable_reason, "textgrid_21610_blacklist");
  assert.equal(classified.no_sender_rotation, true);
});

test("finalizeSendQueueFailure: 21610 uses textgrid_21610_blacklist non_retryable_reason", async () => {
  const captured = [];
  const deps = {
    updateSendQueueRowWithLock: async (row_id, lock_token, payload) => {
      captured.push(payload);
      return payload;
    },
  };
  const error = new Error(
    'TextGrid HTTP failure: {"code":"21610","message":"The message From/To pair violates a blacklist rule."}'
  );
  await finalizeSendQueueFailure(
    {
      id: "q1",
      retry_count: 0,
      max_retries: 3,
      from_phone_number: "+13235589881",
      to_phone_number: "+16023329348",
      metadata: {},
    },
    "lock",
    error,
    deps
  );
  assert.equal(captured[0].queue_status, "failed");
  assert.equal(captured[0].next_retry_at, null);
  assert.equal(captured[0].metadata.provider_error.non_retryable_reason, "textgrid_21610_blacklist");
});

// ─── Idempotency ───────────────────────────────────────────────────────────────

function makeDedupeSupabase({ existing = null } = {}) {
  let insert_attempts = 0;
  return {
    client: {
      from(table) {
        if (table === "send_queue") {
          return {
            insert() {
              insert_attempts += 1;
              return {
                select: () => ({
                  maybeSingle: async () => ({
                    data: null,
                    error: { code: "23505", message: "duplicate key" },
                  }),
                }),
              };
            },
            select() {
              const chain = {
                eq() {
                  return chain;
                },
                order() {
                  return chain;
                },
                limit() {
                  return chain;
                },
                maybeSingle: async () => ({ data: existing, error: null }),
              };
              return chain;
            },
          };
        }
        if (table === "sms_suppression_list") {
          return {
            select: () => ({
              eq: () => ({
                ilike: async () => ({ count: 0, error: null }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({
              ilike: async () => ({ count: 0, error: null }),
            }),
          }),
        };
      },
    },
    insert_attempts,
  };
}

test("insertSupabaseSendQueueRow: dedupe conflict returns idempotent replay", async () => {
  const existing = {
    id: 99,
    queue_key: "feed:abc",
    dedupe_key: "mo:prop:phone:case:1:session",
    queue_status: "queued",
    scheduled_for: "2026-06-23T16:00:00Z",
  };
  const { client } = makeDedupeSupabase({ existing });
  const result = await insertSupabaseSendQueueRow(
    {
      queue_key: "feed:abc",
      dedupe_key: existing.dedupe_key,
      to_phone_number: "+15550001234",
      from_phone_number: "+15559990000",
      message_body: "Hello there from automation test message body.",
      queue_status: "queued",
      scheduled_for: "2026-06-23T16:00:00Z",
    },
    { supabase: client }
  );
  assert.equal(result.ok, true);
  assert.equal(result.idempotent_replay, true);
  assert.equal(result.queue_row_id, 99);
});

function makeCountSelectChain(count = 0, rows = null) {
  const data =
    rows ??
    (count > 0
      ? Array.from({ length: count }, (_, i) => ({
          id: `hist-${i}`,
          is_active: true,
          sender_phone_e164: null,
          reason: "21610",
          suppression_reason: "21610",
        }))
      : []);
  const payload = { data, count: data.length, error: null };
  const chain = {
    eq() {
      return chain;
    },
    is() {
      return chain;
    },
    or() {
      return chain;
    },
    ilike: async () => payload,
    then(resolve) {
      return resolve(payload);
    },
  };
  return chain;
}

test("enqueueSendQueueItem: blocks 21610-suppressed phone", async () => {
  const client = {
    from(table) {
      if (table === "sms_suppression_list") {
        return {
          select: () =>
            makeCountSelectChain(1, [
              {
                id: "active-21610",
                is_active: true,
                sender_phone_e164: null,
                reason: "21610",
                suppression_reason: "21610",
              },
            ]),
        };
      }
      if (table === "send_queue") {
        return {
          select: () => makeCountSelectChain(0),
          insert: () => ({
            select: () => ({
              maybeSingle: async () => ({
                data: null,
                error: new Error("must not insert when 21610 blocked"),
              }),
            }),
          }),
        };
      }
      if (table === "message_events") {
        return {
          select: () => makeCountSelectChain(0),
        };
      }
      return {
        select: () => makeCountSelectChain(0),
      };
    },
  };
  const result = await enqueueSendQueueItem(
    {
      queue_key: "test:21610",
      to_phone_number: "+15005550001",
      from_phone_number: "+15005550002",
      message_body: "Hi John, this is a test message about your property.",
      queue_status: "queued",
      scheduled_for: new Date().toISOString(),
    },
    { supabase: client }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "phone_suppressed_21610");
});