// GLOBAL ROUTING regression (2026-10-12). chooseTextgridNumber computed the
// first-touch regional override and never used it, so every first touch required
// an exact-market number: HOT LEADS held 875 ready sellers (Detroit, Cleveland,
// Phoenix…) as no_local_sender_number while their regional pools had live
// numbers. Owner rule (10-02): exact → alias → approved regional cluster → hold,
// for every send; the operator switches live in system_control.
import test from "node:test";
import assert from "node:assert/strict";

import { chooseTextgridNumber } from "@/lib/domain/routing/choose-textgrid-number.js";
import { clearSystemControlCache, primeSystemControlValue } from "@/lib/system-control.js";

const number = (item_id, normalized_phone, market_name) => ({
  item_id,
  normalized_phone,
  phone_number: normalized_phone,
  market_name,
  status: "_ Active",
  priority: 5,
  daily_limit: 100,
  daily_sent: 0,
  hourly_limit: 50,
  hourly_sent: 0,
  hard_pause: "No",
  risk_spike_flag: "No",
  allowed_send_window_start_local: "00:00",
  allowed_send_window_end_local: "23:59",
  area_code: "",
  last_used_at: "2026-04-08T00:00:00.000Z",
});

// Detroit has no number of its own; its cluster (minneapolis_cluster) does.
const POOL = [number(41, "+16125550101", "Minneapolis, MN"), number(42, "+12135550102", "Los Angeles, CA")];
const detroit = (summary = {}) => ({ ids: { phone_item_id: 7001 }, summary: { market_name: "Detroit, MI", ...summary } });

test.afterEach(() => clearSystemControlCache());

test("first touch with the regional override routes Detroit to its regional cluster", async () => {
  const selected = await chooseTextgridNumber({ context: detroit(), candidate_records: POOL, first_touch: true, allow_regional_fallback_for_first_touch: true });
  assert.equal(selected.item_id, 41);
  assert.equal(selected.selection_reason, "regional_cluster_fallback");
});

test("a caller that passes nothing follows system_control (allow_regional_fallback_for_first_touch=true)", async () => {
  primeSystemControlValue("allow_regional_fallback_for_first_touch", "true");
  primeSystemControlValue("require_local_routing", "false");
  const selected = await chooseTextgridNumber({ context: detroit(), candidate_records: POOL, first_touch: true });
  assert.equal(selected.item_id, 41);
  assert.equal(selected.selection_reason, "regional_cluster_fallback");
});

test("the operator can still turn first-touch regional off: then the seller is held, never mis-routed", async () => {
  primeSystemControlValue("allow_regional_fallback_for_first_touch", "false");
  primeSystemControlValue("require_local_routing", "false");
  const selected = await chooseTextgridNumber({ context: detroit(), candidate_records: POOL, first_touch: true });
  assert.ok(!selected?.item_id, "no sender selected");
  assert.equal(selected.routing_block_reason, "NO_VALID_LOCAL_TEXTGRID_NUMBER");
});

test("require_local_routing still forces exact market even with the regional override on", async () => {
  const selected = await chooseTextgridNumber({ context: detroit(), candidate_records: POOL, first_touch: true, allow_regional_fallback_for_first_touch: true, require_local_routing: true });
  assert.ok(!selected?.item_id);
  assert.equal(selected.routing_block_reason, "NO_VALID_LOCAL_TEXTGRID_NUMBER");
});

test("an exact-market number still wins over the regional cluster", async () => {
  const pool = [...POOL, number(43, "+13135550103", "Detroit, MI")];
  const selected = await chooseTextgridNumber({ context: detroit(), candidate_records: pool, first_touch: true, allow_regional_fallback_for_first_touch: true });
  assert.equal(selected.item_id, 43);
  assert.equal(selected.selection_reason, "exact_market_match");
});

test("regional never crosses clusters: Detroit is never sent from Los Angeles", async () => {
  const selected = await chooseTextgridNumber({ context: detroit(), candidate_records: [POOL[1]], first_touch: true, allow_regional_fallback_for_first_touch: true });
  assert.ok(!selected?.item_id);
});

// ── The campaign planner's router (supabase-candidate-feeder) ────────────────
// Second regression, same day: the launch plan / rolling feeder / readiness call
// THIS router with first_touch=true and never pass the switches, so they
// defaulted to false and HOT LEADS stayed held after the first fix shipped.
import { chooseTextgridNumber as choosePlannerSender } from "@/lib/domain/outbound/supabase-candidate-feeder.js";

const fleet = (rows) => ({
  from() {
    return { select() { return { limit: () => Promise.resolve({ data: rows, error: null }) }; } };
  },
});
const tg = (id, market) => ({ id, market, phone_number: `+1612555${String(1000 + id).slice(-4)}`, status: "active", messages_sent_today: 0 });
const switches = (values) => async (key) => values[key] ?? null;

test("planner router: first touch with no switch passed follows system_control=true → regional pool", async () => {
  const result = await choosePlannerSender(
    { market: "Detroit, MI", state: "MI" },
    { routing_safe_only: true, first_touch: true },
    { supabase: fleet([tg(1, "Minneapolis, MN"), tg(2, "Los Angeles, CA")]), getSystemValue: switches({ allow_regional_fallback_for_first_touch: "true", require_local_routing: "false" }) }
  );
  assert.equal(result.ok, true);
  assert.equal(result.routing_tier, "approved_regional_fallback");
  assert.equal(result.selected_textgrid_market, "Minneapolis, MN");
});

test("planner router: system_control=false still holds a first touch with no local number (never mis-routes)", async () => {
  const result = await choosePlannerSender(
    { market: "Detroit, MI", state: "MI" },
    { routing_safe_only: true, first_touch: true },
    { supabase: fleet([tg(1, "Minneapolis, MN")]), getSystemValue: switches({ allow_regional_fallback_for_first_touch: "false", require_local_routing: "false" }) }
  );
  assert.notEqual(result.ok, true);
});

test("planner router: an explicitly passed switch beats system_control", async () => {
  const result = await choosePlannerSender(
    { market: "Detroit, MI", state: "MI" },
    { routing_safe_only: true, first_touch: true, allow_regional_fallback_for_first_touch: false },
    { supabase: fleet([tg(1, "Minneapolis, MN")]), getSystemValue: switches({ allow_regional_fallback_for_first_touch: "true" }) }
  );
  assert.notEqual(result.ok, true);
});
