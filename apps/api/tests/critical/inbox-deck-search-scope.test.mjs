/**
 * INBOX DESKTOP 4.0 — Command Deck search is an explicit, bounded opt-in.
 *
 * The desktop Command Deck searches the Inbox as the operator types. With
 * `search_scope=deck` the live endpoint matches the identity columns people
 * type (names, phone, street, city, ZIP, market) plus the latest reply, and
 * skips the message-history corpus scan that made common phrases take 20s+.
 * Without the parameter nothing changes: the Inbox's own search keeps the
 * corpus. These pin both sides.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DECK_SEARCH_COLUMNS,
  getLiveInbox,
  isDeckSearchScope,
  threadMatchesDeckSearch,
} from "../../src/lib/domain/inbox/live-inbox-service.js";

const WENDY = {
  thread_key: "+16122232473",
  canonical_thread_key: "+16122232473",
  canonical_e164: "+16122232473",
  seller_phone: "+16122232473",
  owner_name: "Wendy B Stuhr",
  seller_display_name: "Wendy B Stuhr",
  prospect_name: "Wendy B Stuhr",
  property_address_full: "3831 Sheridan Ave N, Minneapolis, Mn 55412",
  property_address_city: "Minneapolis",
  property_zip: "55412",
  market: "Minneapolis, MN",
  latest_message_body: "Yes. I am not interested in selling. Thanks.",
  latest_message_at: "2026-09-30T20:20:43.090Z",
  latest_message_direction: "inbound",
  inbox_bucket: "follow_up",
};

/** Every chain method returns the chain; awaiting it resolves the table's rows. */
function makeSupabase(rowsByTable = {}) {
  const log = [];
  return {
    log,
    from(table) {
      const entry = { table, or: [], ilike: [] };
      log.push(entry);
      const chain = new Proxy({}, {
        get(_target, prop) {
          if (prop === "then") {
            return (resolve) => Promise.resolve().then(() => resolve({ data: rowsByTable[table] ?? [], error: null, count: null }));
          }
          if (prop === "or") return (clause) => { entry.or.push(clause); return chain; };
          if (prop === "ilike") return (column, pattern) => { entry.ilike.push({ column, pattern }); return chain; };
          return () => chain;
        },
      });
      return chain;
    },
  };
}

test("the scope is opt-in and named", () => {
  assert.equal(isDeckSearchScope({ search_scope: "deck" }), true);
  assert.equal(isDeckSearchScope({ searchScope: "DECK" }), true);
  assert.equal(isDeckSearchScope({}), false);
  assert.equal(isDeckSearchScope({ search_scope: "corpus" }), false);
});

test("the deck net matches the columns the SQL matched on", () => {
  assert.equal(threadMatchesDeckSearch(WENDY, "55412"), true, "ZIP");
  assert.equal(threadMatchesDeckSearch(WENDY, "minneapolis"), true, "city / market");
  assert.equal(threadMatchesDeckSearch(WENDY, "stuhr"), true, "name");
  assert.equal(threadMatchesDeckSearch(WENDY, "6122232473"), true, "phone digits");
  assert.equal(threadMatchesDeckSearch(WENDY, "not interested"), true, "latest reply");
  assert.equal(threadMatchesDeckSearch(WENDY, "dallas"), false);
});

test("deck search matches identity columns and skips the corpus scan", async () => {
  const supabase = makeSupabase({ canonical_inbox_threads: [WENDY] });
  const result = await getLiveInbox(
    { filter: "all", q: "55412", limit: 8, timeout_mode: "manual_bucket_switch", search_scope: "deck", skip_counts: "1", skip_delivery: "1" },
    { listOnly: true, skipCounts: true, skipDelivery: true },
    { supabase },
  );
  const corpus = supabase.log.filter((entry) => entry.table === "message_events" && entry.ilike.some((call) => call.column === "message_body"));
  assert.equal(corpus.length, 0, "no message-history corpus scan for deck search");
  const source = supabase.log.find((entry) => entry.table === "canonical_inbox_threads");
  assert.ok(source, "the canonical thread source answered");
  const clause = source.or.join(",");
  for (const column of DECK_SEARCH_COLUMNS) assert.ok(clause.includes(`${column}.ilike.%55412%`), `searches ${column}`);
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0].thread_key, "+16122232473");
});

test("without the scope, the Inbox search keeps its corpus and its columns", async () => {
  const supabase = makeSupabase({ canonical_inbox_threads: [WENDY] });
  await getLiveInbox(
    { filter: "all", q: "sheridan", limit: 8, timeout_mode: "manual_bucket_switch", skip_counts: "1", skip_delivery: "1" },
    { listOnly: true, skipCounts: true, skipDelivery: true },
    { supabase },
  );
  const corpus = supabase.log.filter((entry) => entry.table === "message_events" && entry.ilike.some((call) => call.column === "message_body"));
  assert.equal(corpus.length, 1, "the corpus is consulted exactly as before");
  const clause = supabase.log.find((entry) => entry.table === "canonical_inbox_threads").or.join(",");
  assert.ok(!clause.includes("prospect_name.ilike"), "deck-only columns are not added to the Inbox search");
  assert.ok(clause.includes("owner_name.ilike.%sheridan%"));
});
