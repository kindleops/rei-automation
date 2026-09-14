/**
 * INBOX-COMPOSER-LOCK-1 — search reaches the corpus, not the last message.
 *
 * Every thread source carries exactly ONE message body: latest_message_body. So
 * searching matched only what the seller said MOST RECENTLY. Measured on
 * production 2026-09-14 against thread +18135909446, whose history contains
 * "Let me guess, you are offering cash for dirt cheap?" and whose latest message
 * is "What's a fair price":
 *
 *     q="fair price"  -> 1 thread
 *     q="dirt cheap"  -> 0 threads
 *
 * An operator searching a phrase they remember reading could not find the
 * conversation. message_events is the corpus; these pin that it is consulted,
 * that it is never shipped to the browser, and that the in-memory net does not
 * quietly undo it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveCorpusSearchThreadKeys } from "../../src/lib/domain/inbox/live-inbox-service.js";

function makeSupabase(events, { failOn = null } = {}) {
  const seen = [];
  return {
    seen,
    from(table) {
      const state = { table, ilike: null, limit: null };
      const api = {
        select() { return api; },
        not() { return api; },
        ilike(column, pattern) { state.ilike = { column, pattern }; return api; },
        order() { return api; },
        limit(n) { state.limit = n; return api; },
        then(resolve) {
          seen.push(state);
          if (failOn === table) {
            return Promise.resolve().then(() => resolve({ data: null, error: { message: "boom" } }));
          }
          const needle = String(state.ilike?.pattern ?? "").replace(/%/g, "").toLowerCase();
          const matched = events.filter((e) => String(e.message_body ?? "").toLowerCase().includes(needle));
          return Promise.resolve().then(() => resolve({ data: matched.slice(0, state.limit ?? matched.length), error: null }));
        },
      };
      return api;
    },
  };
}

const EVENTS = [
  { thread_key: "+18135909446", message_body: "Let me guess, you are offering cash for dirt cheap?" },
  { thread_key: "+18135909446", message_body: "What's a fair price" },
  { thread_key: "+14018296044", message_body: "Cash or financed?" },
  { thread_key: "+19995550000", message_body: "Not interested, thanks" },
];

test("a phrase from an older message resolves its thread", async () => {
  const supabase = makeSupabase(EVENTS);
  const keys = await resolveCorpusSearchThreadKeys(supabase, "dirt cheap");
  assert.deepEqual(keys, ["+18135909446"]);
});

test("the corpus is queried, and only thread keys come back", async () => {
  const supabase = makeSupabase(EVENTS);
  const keys = await resolveCorpusSearchThreadKeys(supabase, "cash");
  assert.equal(supabase.seen[0].table, "message_events");
  assert.equal(supabase.seen[0].ilike.column, "message_body");
  // Thread keys only -- message bodies never cross into the response.
  for (const key of keys) assert.equal(typeof key, "string");
  assert.deepEqual([...keys].sort(), ["+14018296044", "+18135909446"]);
});

test("one thread is returned once, however many of its messages matched", async () => {
  const supabase = makeSupabase([
    { thread_key: "+15550000001", message_body: "cash offer please" },
    { thread_key: "+15550000001", message_body: "still want cash" },
    { thread_key: "+15550000001", message_body: "cash cash cash" },
  ]);
  const keys = await resolveCorpusSearchThreadKeys(supabase, "cash");
  assert.deepEqual(keys, ["+15550000001"]);
});

test("the key list is capped, so a common word cannot build an unbounded query", async () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({ thread_key: `+1555${String(i).padStart(7, "0")}`, message_body: "yes" }));
  const supabase = makeSupabase(many);
  const keys = await resolveCorpusSearchThreadKeys(supabase, "yes", { cap: 400 });
  assert.equal(keys.length, 400);
});

test("a term too short to be a phrase does not touch the corpus", async () => {
  const supabase = makeSupabase(EVENTS);
  assert.deepEqual(await resolveCorpusSearchThreadKeys(supabase, "ca"), []);
  assert.deepEqual(await resolveCorpusSearchThreadKeys(supabase, ""), []);
  assert.equal(supabase.seen.length, 0, "the thread columns already cover short tokens");
});

test("a corpus failure degrades search, it does not 500 the Inbox", async () => {
  const supabase = makeSupabase(EVENTS, { failOn: "message_events" });
  const keys = await resolveCorpusSearchThreadKeys(supabase, "dirt cheap");
  assert.deepEqual(keys, [], "falls back to thread-column matching rather than throwing");
});
