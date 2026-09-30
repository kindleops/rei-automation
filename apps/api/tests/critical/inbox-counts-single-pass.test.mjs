/**
 * inbox-counts-single-pass.test.mjs
 *
 * The authoritative inbox counts are the path polls fall into when the count
 * views time out. It paged the whole inbox_thread_state table once PER TAB
 * (9 passes, ~100 requests per poll), so under load it multiplied the load
 * that sent it there (2026-09-30). One pass must count every tab.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { countThreadsForTabs } from "@/lib/domain/inbox/live-inbox-service.js";
import { threadMatchesInboxTab } from "@/lib/domain/inbox/inbox-thread-state-contract.js";

const NOW = Date.parse("2026-09-30T15:00:00.000Z");

function tableClient(rows) {
  const calls = { pages: 0, ordered: 0 };
  return {
    calls,
    from(table) {
      assert.equal(table, "inbox_thread_state");
      const api = {
        select() { return api; },
        order(column) { assert.equal(column, "thread_key"); calls.ordered += 1; return api; },
        range(from, to) {
          calls.pages += 1;
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        },
      };
      return api;
    },
  };
}

test("every tab is counted in ONE pass over the table", async () => {
  const buckets = ["priority", "new_replies", "needs_review", "waiting", null];
  const rows = Array.from({ length: 2500 }, (_, i) => ({
    thread_key: `+1555${String(i).padStart(7, "0")}`,
    inbox_bucket: buckets[i % buckets.length],
    latest_direction: i % 2 ? "inbound" : "outbound",
    last_inbound_at: new Date(NOW - 3600_000).toISOString(),
    last_outbound_at: new Date(NOW - 7200_000).toISOString(),
  }));
  const tabs = ["priority", "new_replies", "needs_review", "follow_up", "waiting", "cold", "dead", "suppressed", "all_messages"];
  const client = tableClient(rows);
  const totals = await countThreadsForTabs(client, tabs, { pageSize: 1000, nowMs: NOW });

  assert.equal(client.calls.pages, 3, "2,500 rows at 1,000 per page = 3 requests for ALL tabs (was 27)");
  assert.equal(client.calls.ordered, 3, "stable primary-key order on every page");
  for (const tab of tabs) {
    const expected = rows.filter((row) => threadMatchesInboxTab(row, tab, NOW)).length;
    assert.equal(totals[tab], expected, `tab ${tab} matches the per-tab predicate`);
  }
});
