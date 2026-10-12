/**
 * Round 9 lanes (2026-10-08) were COUNTED (v_inbox_bucket_counts.unclear /
 * .price_gap) but could not be LISTED: BUCKET_FLAG_COLUMNS had no unclear /
 * price_gap entry, so filter=unclear and filter=price_gap failed closed with [].
 * The list must filter the same flag the chip counts (.eq('in_unclear' |
 * 'in_price_gap', true), authoritative), and each chip equals its list length.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { getLiveInbox, resolveBucketFlagColumn } from "../../src/lib/domain/inbox/live-inbox-service.js";
import { CANONICAL_INBOX_COUNT_KEYS } from "../../src/lib/domain/inbox/canonical-inbox-row-contract.js";
import { makeLiveInboxThreadSupabase } from "../helpers/chainable-supabase.mjs";

const NOW = Date.now();
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const reply = (key, extra = {}) => ({
  thread_key: key, canonical_e164: key, latest_direction: "inbound", last_inbound_at: hoursAgo(1), latest_message_at: hoursAgo(1),
  last_outbound_at: hoursAgo(3), inbox_bucket: "new_replies", property_id: `p-${key}`, latest_message_body: "hi", ...extra,
});

const STATE_ROWS = [
  reply("+15550000001", { last_intent: "unclear" }),
  reply("+15550000002", { last_intent: "who_is_this" }),
  reply("+15550000003", { last_intent: "unclear", latest_message_at: hoursAgo(2), last_inbound_at: hoursAgo(2) }),
  reply("+15550000004", { last_intent: "asking_price_implausible", inbox_bucket: "follow_up" }),
  reply("+15550000005", { last_intent: "asking_price_provided", inbox_bucket: "follow_up", metadata: { deal_economics: { verdict: "price_far_above_value" } } }),
  reply("+15550000006", { last_intent: "asks_offer", inbox_bucket: "priority" }),
  reply("+15550000007", { last_intent: "ownership_confirmed" }),
];

function recordingSupabase() {
  const base = makeLiveInboxThreadSupabase([], { stateRows: STATE_ROWS });
  const eqCalls = [];
  return {
    eqCalls,
    base,
    from(table) {
      const q = base.from(table);
      const wrap = (inner) => new Proxy(inner, {
        get(target, prop) {
          const value = target[prop];
          if (typeof value !== "function") return value;
          return (...args) => {
            if (prop === "eq") eqCalls.push({ table, column: args[0], value: args[1] });
            const out = value.apply(target, args);
            return out === target ? wrap(target) : out;
          };
        },
      });
      return wrap(q);
    },
    rpc: (...args) => base.rpc?.(...args),
  };
}

test("unclear and price_gap resolve to their flag columns and are canonical count keys", () => {
  assert.equal(resolveBucketFlagColumn("unclear"), "in_unclear");
  assert.equal(resolveBucketFlagColumn("price_gap"), "in_price_gap");
  assert.ok(CANONICAL_INBOX_COUNT_KEYS.includes("unclear"));
  assert.ok(CANONICAL_INBOX_COUNT_KEYS.includes("price_gap"));
});

for (const [filter, flag] of [["unclear", "in_unclear"], ["price_gap", "in_price_gap"]]) {
  test(`filter=${filter} lists authoritatively on .eq('${flag}', true) and the chip equals the list`, async () => {
    const sb = recordingSupabase();
    const out = await getLiveInbox({ filter, limit: 50 }, { supabase: sb });
    assert.ok(sb.eqCalls.some((c) => c.table === "v_inbox_thread_state_buckets" && c.column === flag && c.value === true), `no .eq(${flag}, true): ${JSON.stringify(sb.eqCalls)}`);
    const rows = out.threads || out.data || out.rows || [];
    assert.ok(rows.length > 0, `${filter} returned no rows`);
    assert.notEqual(out.unknownFilter ?? out.unknown_filter, filter, "must not fail closed");
    const counts = await getLiveInbox({ filter: "all", limit: 1 }, { supabase: recordingSupabase() });
    const chip = Number((counts.counts || {})[filter]);
    assert.equal(chip, rows.length, `${filter}: chip ${chip} vs list ${rows.length}`);
  });
}
