/**
 * send-now-sender-continuity.test.mjs  (dispatch-parity contract 5)
 *
 * The manual sender resolver consults the dispatch block list ONLY in its
 * market-fallback pool (Priority 4). An established conversation keeps its
 * sender (Priorities 0-3) even if that number is currently dispatch-blocked --
 * we never silently rotate a seller across numbers; dispatch, not selection,
 * decides what happens to that row.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveFromPhoneNumber } from "@/lib/domain/inbox/send-now-service.js";

const THREAD = "+13055550142";
const BLOCKED = "+13055552000";
const VALID = "+13055553000";

function fakeSupabase({ established = null, pool = [] } = {}) {
  const chain = (rows) => {
    const q = {
      select() { return q; }, eq() { return q; }, order() { return q; }, in() { return q; }, not() { return q; }, gte() { return q; },
      limit: async () => ({ data: rows, error: null }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      then(res) { return Promise.resolve({ data: rows, error: null }).then(res); },
    };
    return q;
  };
  return {
    from(table) {
      if (table === "inbox_thread_state") return chain(established ? [{ thread_key: THREAD, our_number: established }] : []);
      if (table === "textgrid_numbers") return chain(pool.map((p) => ({ phone_number: p })));
      return chain([]); // deal_thread_state, send_queue, message_events -> nothing
    },
  };
}

const withBlockedEnv = async (fn) => {
  const prev = process.env.SMS_BLOCKED_SENDER_NUMBERS;
  process.env.SMS_BLOCKED_SENDER_NUMBERS = BLOCKED;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.SMS_BLOCKED_SENDER_NUMBERS; else process.env.SMS_BLOCKED_SENDER_NUMBERS = prev;
  }
};

test("5. an established conversation keeps its sender even when that number is dispatch-blocked", async () => {
  const out = await withBlockedEnv(() => resolveFromPhoneNumber({
    thread_key: THREAD, to_phone_number: THREAD, market: "Miami, FL",
    supabase: fakeSupabase({ established: BLOCKED, pool: [BLOCKED, VALID] }),
  }));
  assert.equal(out, BLOCKED, "continuity wins over the block at selection time");
});

test("fallback pool skips a dispatch-blocked number for a NEW thread", async () => {
  const out = await withBlockedEnv(() => resolveFromPhoneNumber({
    thread_key: THREAD, to_phone_number: THREAD, market: "Miami, FL",
    supabase: fakeSupabase({ established: null, pool: [BLOCKED, VALID] }),
  }));
  assert.equal(out, VALID);
});

test("fallback pool that is entirely dispatch-blocked yields no sender rather than a refusable one", async () => {
  const out = await withBlockedEnv(() => resolveFromPhoneNumber({
    thread_key: THREAD, to_phone_number: THREAD, market: "Miami, FL",
    supabase: fakeSupabase({ established: null, pool: [BLOCKED] }),
  }));
  assert.equal(out, null);
});

test("with no block configured the fallback picks the first active number (no regression)", async () => {
  const out = await resolveFromPhoneNumber({
    thread_key: THREAD, to_phone_number: THREAD, market: "Miami, FL",
    supabase: fakeSupabase({ established: null, pool: [VALID, BLOCKED] }),
  });
  assert.equal(out, VALID);
});
