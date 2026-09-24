import test from "node:test";
import assert from "node:assert/strict";

import { fetchCampaignFailureRows } from "@/lib/domain/campaigns/campaign-failures.js";

const CAMPAIGN_ID = "320c798a-84c9-45b8-a7c9-d166ddd7bd46";

/**
 * A PostgREST-shaped fake. Rows carry the `meta_<key>` aliases the module
 * selects with `metadata->>key`; `serverRowCap` imitates a max-rows setting
 * smaller than the page the module asks for.
 */
function fakeSupabase({ queueRows = [], failedTargets = [], lookupTargets = [], serverRowCap = Infinity } = {}) {
  const calls = [];

  function from(table) {
    const state = { table, columns: null, options: null, filters: [], order: null, limit: null, range: null };
    calls.push(state);

    const matches = (rows) =>
      rows.filter((row) =>
        state.filters.every(([op, column, value]) =>
          op === "eq" ? row[column] === value : value.includes(row[column])));

    const source = () => {
      if (table === "send_queue") return queueRows;
      if (table === "campaign_targets") {
        const byId = state.filters.some(([op, column]) => op === "in" && column === "id");
        return byId ? lookupTargets : failedTargets;
      }
      return [];
    };

    const chain = {
      select(columns, options) {
        state.columns = columns;
        state.options = options ?? null;
        return chain;
      },
      eq(column, value) {
        state.filters.push(["eq", column, value]);
        return chain;
      },
      in(column, values) {
        state.filters.push(["in", column, values]);
        return chain;
      },
      order(column, opts = {}) {
        state.order = { column, ...opts };
        return chain;
      },
      limit(n) {
        state.limit = n;
        return chain;
      },
      async range(fromIndex, toIndex) {
        state.range = [fromIndex, toIndex];
        const rows = matches(source());
        const size = Math.min(toIndex - fromIndex + 1, serverRowCap);
        return {
          data: rows.slice(fromIndex, fromIndex + size),
          count: state.options?.count === "exact" ? rows.length : null,
          error: null,
        };
      },
      async maybeSingle() {
        return { data: null, error: null };
      },
      then(resolve, reject) {
        let rows = matches(source());
        if (state.order?.column === "updated_at") {
          rows = [...rows].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
        }
        if (state.limit != null) rows = rows.slice(0, state.limit);
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return chain;
  }

  return { from, calls };
}

let seq = 0;
function queueRow(overrides = {}) {
  seq += 1;
  return {
    id: `q-${String(seq).padStart(5, "0")}`,
    campaign_id: CAMPAIGN_ID,
    campaign_target_id: null,
    queue_status: "expired",
    failed_reason: "stale_runnable_row_expired",
    to_phone_number: `+1305555${String(seq).padStart(4, "0")}`,
    from_phone_number: "+13055550000",
    updated_at: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)).toISOString(),
    scheduled_for: null,
    template_id: null,
    ...overrides,
  };
}

/** Miami's real shape on 2026-09-24: 595 expired, 15 × 21610, 1 blacklisted pair, 1 missing SID. */
function miamiRows() {
  const rows = [];
  for (let i = 0; i < 595; i += 1) rows.push(queueRow());
  for (let i = 0; i < 15; i += 1) {
    rows.push(queueRow({
      queue_status: "failed",
      failed_reason: 'TextGrid HTTP failure: {"status":"400","code":"21610","message":"The message From/To pair violates a blacklist rule."}',
      meta_failure_category: "compliance_terminalization",
      // Oldest rows: a 500-row "most recent" sample never reached these.
      updated_at: new Date(Date.UTC(2026, 5, 26, 19, 38, i)).toISOString(),
    }));
  }
  rows.push(queueRow({ queue_status: "failed", failed_reason: "The message From/To pair violates a blacklist rule." }));
  rows.push(queueRow({ queue_status: "failed", failed_reason: "SEND FAILED - NO SID" }));
  return rows;
}

const groupCounts = (groups) => Object.fromEntries(groups.map((g) => [g.failure_category, g.count]));

test("execution totals and groups count every failure row, not the most recent 500", async () => {
  const supabase = fakeSupabase({ queueRows: miamiRows() });
  const result = await fetchCampaignFailureRows(CAMPAIGN_ID, { supabase });

  assert.equal(result.ok, true);
  assert.equal(result.execution.total, 612);
  assert.equal(result.execution.truncated, false);
  assert.deepEqual(groupCounts(result.execution.groups), {
    expired_before_send: 595,
    compliance_terminalization: 16,
    provider_unconfirmed: 1,
  });
  // The row-level list stays a bounded sample.
  assert.equal(result.execution.failures.length, 500);
  assert.equal(result.execution.sample_limit, 500);
});

test("a server row cap smaller than the page does not end the count early", async () => {
  const supabase = fakeSupabase({ queueRows: miamiRows(), serverRowCap: 250 });
  const result = await fetchCampaignFailureRows(CAMPAIGN_ID, { supabase, includeRows: false });

  assert.equal(result.execution.total, 612);
  const scans = supabase.calls.filter((c) => c.table === "send_queue" && c.range);
  assert.equal(scans.length, 3, "612 rows at 250 per response is three pages");
  assert.equal(scans[0].options?.count, "exact", "the first page asks for the exact total");
});

test("sample reasons are distinct, so 595 expiries show one reason, not five copies", async () => {
  const supabase = fakeSupabase({ queueRows: miamiRows() });
  const result = await fetchCampaignFailureRows(CAMPAIGN_ID, { supabase, includeRows: false });
  const expired = result.execution.groups.find((g) => g.failure_category === "expired_before_send");
  assert.deepEqual(expired.sample_reasons, ["stale_runnable_row_expired"]);
});

test("a provider failure no longer throws a ReferenceError", async () => {
  const supabase = fakeSupabase({
    queueRows: [
      queueRow({ queue_status: "failed", failed_reason: 'TextGrid HTTP failure: {"status":"503"}' }),
      queueRow({ queue_status: "failed", failed_reason: 'TextGrid HTTP failure: {"status":"400","code":"21610"}' }),
    ],
  });
  const result = await fetchCampaignFailureRows(CAMPAIGN_ID, { supabase });

  const byCategory = Object.fromEntries(result.execution.failures.map((f) => [f.failure_category, f]));
  assert.equal(byCategory.provider_failure.retryable, true);
  assert.equal(byCategory.compliance_terminalization.retryable, false);
});

test("recipient names are looked up in chunks of at most 100 ids", async () => {
  const queueRows = [];
  const lookupTargets = [];
  for (let i = 0; i < 250; i += 1) {
    const targetId = `t-${i}`;
    queueRows.push(queueRow({ campaign_target_id: targetId }));
    lookupTargets.push({ id: targetId, owner_name: `Owner ${i}`, property_address: `${i} Main St`, language: "en", market: "Miami" });
  }
  const supabase = fakeSupabase({ queueRows, lookupTargets });
  const result = await fetchCampaignFailureRows(CAMPAIGN_ID, { supabase });

  const lookups = supabase.calls.filter((c) => c.table === "campaign_targets" && c.filters.some(([op, col]) => op === "in" && col === "id"));
  assert.equal(lookups.length, 3);
  for (const lookup of lookups) {
    const ids = lookup.filters.find(([op, col]) => op === "in" && col === "id")[2];
    assert.ok(ids.length <= 100, `lookup carried ${ids.length} ids`);
  }
  assert.ok(result.execution.failures.every((f) => /^Owner \d+$/.test(f.recipient)), "every recipient resolved to a name");
});

test("includeRows:false skips the detail sample and returns no row lists", async () => {
  const supabase = fakeSupabase({ queueRows: miamiRows() });
  const result = await fetchCampaignFailureRows(CAMPAIGN_ID, { supabase, includeRows: false });

  assert.equal(result.execution.total, 612);
  assert.deepEqual(result.execution.failures, []);
  assert.deepEqual(result.failures, []);
  const samples = supabase.calls.filter((c) => c.table === "send_queue" && c.order?.column === "updated_at");
  assert.equal(samples.length, 0);
});

test("send_queue reads name metadata keys, never the whole document or a bare failure_category column", async () => {
  const supabase = fakeSupabase({ queueRows: miamiRows() });
  await fetchCampaignFailureRows(CAMPAIGN_ID, { supabase });

  for (const call of supabase.calls.filter((c) => c.table === "send_queue")) {
    const expressions = String(call.columns).split(",").map((part) => part.trim().split(":").pop().trim());
    assert.ok(!expressions.includes("metadata"), `whole metadata selected: ${call.columns}`);
    assert.ok(!expressions.includes("failure_category"), `bare failure_category selected: ${call.columns}`);
  }
});

test("each group carries when it last happened", async () => {
  const supabase = fakeSupabase({ queueRows: miamiRows() });
  const result = await fetchCampaignFailureRows(CAMPAIGN_ID, { supabase, includeRows: false });
  const refused = result.execution.groups.find((g) => g.failure_category === "compliance_terminalization");
  assert.ok(refused.latest_at, "latest_at present");
  // The one blacklisted pair was updated after the fifteen June refusals.
  assert.ok(Date.parse(refused.latest_at) > Date.UTC(2026, 5, 27), `latest_at ${refused.latest_at}`);
});

test("terminal no-send statuses are exceptions, classified by what the status says", async () => {
  const supabase = fakeSupabase({
    queueRows: [
      ...Array.from({ length: 84 }, () => queueRow({ queue_status: "blocked_by_health_guard", failed_reason: "blocked_template_id" })),
      queueRow({ queue_status: "blocked_by_health_guard", failed_reason: "blocked_sender_number" }),
      ...Array.from({ length: 13 }, () => queueRow({ queue_status: "failed_transport", failed_reason: "delivery_failed" })),
      queueRow({ queue_status: "failed_transport", failed_reason: "socket hang up" }),
      ...Array.from({ length: 8 }, () => queueRow({ queue_status: "paused_invalid_queue_row", failed_reason: "missing_candidate_snapshot" })),
      queueRow({ queue_status: "carrier_blocked", failed_reason: "content filtered" }),
      queueRow({ queue_status: "opted_out", failed_reason: "21610" }),
      queueRow({ queue_status: "invalid_number", failed_reason: "not a valid phone" }),
      // Not exceptions: a withdrawal and a stopped duplicate.
      queueRow({ queue_status: "cancelled", failed_reason: "superseded_by_newer_inbound" }),
      queueRow({ queue_status: "duplicate_blocked", failed_reason: "hard_idempotency_blocked_24h" }),
    ],
  });
  const result = await fetchCampaignFailureRows(CAMPAIGN_ID, { supabase, includeRows: false });

  assert.deepEqual(groupCounts(result.execution.groups), {
    template_held: 84,
    undelivered: 13,
    held_incomplete: 8,
    sender_held: 1,
    transport_failure: 1,
    content_filtered: 1,
    compliance_terminalization: 1,
    invalid_destination: 1,
  });
  assert.equal(result.execution.total, 110);
});
