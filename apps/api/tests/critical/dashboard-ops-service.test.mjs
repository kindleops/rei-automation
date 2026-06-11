import test from "node:test";
import assert from "node:assert/strict";

import { getOpsFeederSnapshot, parseOpsFilters } from "@/lib/dashboard/ops-service.js";

function clean(value) {
  return String(value ?? "").trim();
}

function asTime(value) {
  const ts = new Date(value || 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function passthroughCache(_key, _ttl, loader) {
  return loader();
}

function buildLiveInboxCountRow(rows = []) {
  const byBucket = (bucket) => rows.filter((row) => row.inbox_bucket === bucket).length;
  const cold = rows.filter(
    (row) => row.inbox_bucket === "waiting" && row.inbox_category === "cold_no_response",
  ).length;
  const waiting = byBucket("waiting");
  return {
    all: rows.length,
    all_messages: rows.length,
    priority: byBucket("priority"),
    hot_leads: byBucket("priority"),
    new_replies: byBucket("new_replies"),
    new_inbound: byBucket("new_replies"),
    needs_reply: byBucket("new_replies"),
    needs_review: byBucket("needs_review"),
    manual_review: byBucket("needs_review"),
    automated: byBucket("needs_review"),
    follow_up: byBucket("follow_up"),
    outbound_active: byBucket("follow_up"),
    cold,
    cold_no_response: cold,
    dead: byBucket("dead"),
    suppressed: byBucket("suppressed"),
    dnc_opt_out: byBucket("suppressed"),
    active: rows.filter(
      (row) => ["priority", "new_replies", "needs_review", "follow_up", "waiting"].includes(row.inbox_bucket),
    ).length,
    waiting,
    waiting_on_seller: waiting,
    unlinked: rows.filter((row) => row.property_id == null).length,
  };
}

function makeLiveInboxSupabaseStub(rows = []) {
  return {
    from(table) {
      const state = {
        table,
        filters: [],
        searchClause: null,
        orders: [],
        limit: null,
        range: null,
      };

      const api = {
        select() { return api; },
        eq(column, value) {
          state.filters.push((row) => clean(row?.[column]) === clean(value));
          return api;
        },
        in(column, values) {
          const allowed = new Set((values || []).map(clean));
          state.filters.push((row) => allowed.has(clean(row?.[column])));
          return api;
        },
        or(clause) {
          state.searchClause = clause;
          return api;
        },
        order(column, options = {}) {
          state.orders.push({ column, ascending: options.ascending !== false });
          return api;
        },
        range(start, end) {
          state.range = [start, end];
          return api;
        },
        limit(value) {
          state.limit = value;
          return api;
        },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            let data;
            if (table === "canonical_inbox_counts") {
              data = [buildLiveInboxCountRow(rows)];
            } else if (table === "message_events" || table === "send_queue") {
              data = [];
            } else {
              data = [...rows];
            }

            for (const filter of state.filters) {
              data = data.filter((row) => filter(row));
            }

            if (state.searchClause) {
              const needle = state.searchClause
                .split(",")
                .map((entry) => entry.split(".").slice(2).join("."))
                .map((entry) => clean(entry).replaceAll("%", "").toLowerCase())
                .find(Boolean);
              if (needle) {
                data = data.filter((row) => [
                  row.thread_key,
                  row.canonical_e164,
                  row.seller_phone,
                  row.owner_name,
                  row.property_address_full,
                  row.latest_message_body,
                ].some((value) => clean(value).toLowerCase().includes(needle)));
              }
            }

            data.sort((left, right) => {
              for (const order of state.orders) {
                const leftValue = order.column.includes("_at") ? asTime(left?.[order.column]) : clean(left?.[order.column]);
                const rightValue = order.column.includes("_at") ? asTime(right?.[order.column]) : clean(right?.[order.column]);
                if (leftValue === rightValue) continue;
                if (typeof leftValue === "number" && typeof rightValue === "number") {
                  return order.ascending ? leftValue - rightValue : rightValue - leftValue;
                }
                return order.ascending
                  ? String(leftValue).localeCompare(String(rightValue))
                  : String(rightValue).localeCompare(String(leftValue));
              }
              return 0;
            });

            const count = data.length;
            if (state.range) {
              data = data.slice(state.range[0], state.range[1] + 1);
            } else if (typeof state.limit === "number") {
              data = data.slice(0, state.limit);
            }

            return { data, count, error: null };
          }).then(resolve, reject);
        },
      };
      return api;
    },
  };
}

test("parseOpsFilters defaults dashboard feeder to v_sms_ready_contacts with safe routing", () => {
  const filters = parseOpsFilters({});

  assert.equal(filters.candidate_source, "v_sms_ready_contacts");
  assert.equal(filters.routing_safe_only, true);
  assert.equal(filters.legacy_feeder, false);
});

test("getOpsFeederSnapshot uses Supabase candidate feeder and preserves dashboard shape", async () => {
  let captured_input = null;

  const result = await getOpsFeederSnapshot(
    {
      limit: 3,
      scan_limit: 15,
    },
    {
      readThroughCache: passthroughCache,
      getOpsFilterOptions: async () => ({
        views: [
          { view_id: 123, name: "SMS / TIER #1 / ALL" },
        ],
      }),
      runSupabaseCandidateFeeder: async (input) => {
        captured_input = input;
        return {
          ok: true,
          dry_run: true,
          candidate_source: "v_sms_ready_contacts",
          fetched_candidate_count: 7,
          eligible_count: 4,
          queued_count: 3,
          skipped_count: 4,
          sample_skips: [{ reason_code: "NO_APPROVED_ROUTING_PATH" }],
          selected_textgrid_market_counts: { "Los Angeles, CA": 2, "Dallas, TX": 1 },
          routing_tier_counts: { approved_regional_fallback: 3 },
          sample_created_queue_items: [
            { master_owner_id: "mo_1" },
            { master_owner_id: "mo_2" },
            { master_owner_id: "mo_3" },
          ],
          error: null,
        };
      },
    }
  );

  assert.deepEqual(captured_input, {
    dry_run: true,
    candidate_source: "v_sms_ready_contacts",
    routing_safe_only: true,
    scan_limit: 15,
    limit: 3,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.loaded_count, 7);
  assert.equal(result.eligible_count, 4);
  assert.equal(result.inserted_count, 3);
  assert.equal(result.queued_count, 3);
  assert.equal(result.skipped_count, 4);
  assert.deepEqual(result.sample_skips, [{ reason_code: "NO_APPROVED_ROUTING_PATH" }]);
  assert.deepEqual(result.selected_textgrid_market_counts, { "Los Angeles, CA": 2, "Dallas, TX": 1 });
  assert.deepEqual(result.routing_tier_counts, { approved_regional_fallback: 3 });
  assert.equal(result.error, null);
  assert.deepEqual(result.queued_owner_ids, ["mo_1", "mo_2", "mo_3"]);
});

test("getOpsFeederSnapshot rejects legacy feeder requests unless env flag is true", async () => {
  const previous_value = process.env.LEGACY_PODIO_FEEDER_ENABLED;
  delete process.env.LEGACY_PODIO_FEEDER_ENABLED;

  try {
    const result = await getOpsFeederSnapshot(
      { legacy: true },
      {
        readThroughCache: passthroughCache,
        getOpsFilterOptions: async () => ({ views: [] }),
        runSupabaseCandidateFeeder: async () => {
          throw new Error("Supabase feeder should not be called for disabled legacy requests");
        },
      }
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "LEGACY_PODIO_FEEDER_DISABLED");
    assert.equal(result.message, "Dashboard feeder actions now use Supabase candidate feeder.");
    assert.equal(result.loaded_count, 0);
    assert.equal(result.queued_count, 0);
  } finally {
    if (previous_value === undefined) {
      delete process.env.LEGACY_PODIO_FEEDER_ENABLED;
    } else {
      process.env.LEGACY_PODIO_FEEDER_ENABLED = previous_value;
    }
  }
});
test('live inbox exposes cursor pagination, filters, keyword matches, and map pins', async () => {
  const { getLiveInbox } = await import('@/lib/domain/inbox/live-inbox-service.js');
  const rows = Array.from({ length: 260 }, (_, idx) => ({
    thread_key: `thread-${String(idx + 1).padStart(3, '0')}`,
    canonical_thread_key: `thread-${String(idx + 1).padStart(3, '0')}`,
    canonical_e164: `+1555${String(idx + 1).padStart(7, '0')}`,
    seller_phone: `+1555${String(idx + 1).padStart(7, '0')}`,
    owner_name: 'Test Seller',
    property_address_full: '123 Main St',
    latest_message_at: new Date(Date.UTC(2026, 4, 6, 12, 0, 0) - idx * 1000).toISOString(),
    latest_message_body: idx === 0 ? 'yes I am interested, make offer' : idx === 3 ? 'how much is your offer' : `message ${idx}`,
    latest_message_direction: idx % 3 === 0 ? 'inbound' : 'outbound',
    inbox_bucket: idx === 0 ? 'priority' : idx % 3 === 0 ? 'new_replies' : 'follow_up',
    property_id: idx < 10 ? `prop-${idx + 1}` : null,
    master_owner_id: `owner-${idx + 1}`,
    latitude: idx === 0 ? 34.1 : null,
    longitude: idx === 0 ? -118.2 : null,
    market: 'Test Market',
  }));
  const supabase = makeLiveInboxSupabaseStub(rows);
  const page = await getLiveInbox({ limit: '100', direction: 'all', map: 'true' }, { supabase });
  assert.strictEqual(page.messages.length, 100);
  assert.ok(page.pagination.has_more);
  assert.ok(page.pagination.next_cursor);
  assert.ok(page.mapPins.length >= 1);

  const inbound = await getLiveInbox({ limit: '100', direction: 'inbound' }, { supabase });
  assert.ok(inbound.messages.every((m) => m.direction === 'inbound'));

  const keyword = await getLiveInbox({ limit: '10', q: 'interested' }, { supabase });
  assert.ok(keyword.messages[0].matched_keywords.includes('interested'));

  const hot = await getLiveInbox({ limit: '10', filter: 'positive_hot' }, { supabase });
  assert.ok(hot.messages.some((m) => m.flags.positive_hot));

  const needsReply = await getLiveInbox({ limit: '10', filter: 'needs_reply' }, { supabase });
  assert.ok(needsReply.messages.every((m) => m.direction === 'inbound'));
});
