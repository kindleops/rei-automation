// One truth for "can a sender carry this seller's first text?" (2026-10-06).
//
// Prod, read-only: St. Louis (2,249) and Detroit (1,236) read queue-ready in
// campaign_target_graph because resolve_campaign_safe_sender_route counted a
// hardcoded legacy state fallback (MO/MI -> Minneapolis), while the campaign
// planner and the Composer cohort route first texts exact-market only and send 0.
// The proposed resolver uses the planner's own rule. These tests pin it to the
// JS authority so the two cannot drift again.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BLOCKING_HEALTH_STATE, BLOCKING_NUMBER_STATUS } from "@/lib/supabase/sms-engine.js";
import { evaluateAudienceSenderCoverage } from "@/lib/domain/campaigns/campaign-launch-readiness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(
  path.resolve(here, "../../../../supabase/migrations/PROPOSED_20261007010000_graph_sender_coverage_one_truth.sql"),
  "utf8"
);
const body = SQL.slice(SQL.indexOf("AS $function$"), SQL.lastIndexOf("$function$;"));
const code = body.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

function sqlList(afterPattern) {
  const at = code.search(afterPattern);
  assert.ok(at >= 0, `pattern not found: ${afterPattern}`);
  const open = code.indexOf("(", at + code.slice(at).search(/NOT IN|IN\s*\(/));
  const close = code.indexOf(")", open);
  return new Set(code.slice(open + 1, close).split(",").map((v) => v.trim().replace(/^'|'$/g, "")));
}

test("graph coverage SQL denies exactly the number statuses the planner denies", () => {
  assert.deepEqual([...sqlList(/lower\(trim\(COALESCE\(tn\.status/)].sort(), [...BLOCKING_NUMBER_STATUS].sort());
});

test("graph coverage SQL denies exactly the health states the planner denies, and honours cooling_until", () => {
  assert.deepEqual([...sqlList(/lower\(trim\(COALESCE\(tn\.health_state/)].sort(), [...BLOCKING_HEALTH_STATE].sort());
  assert.match(code, /tn\.cooling_until > now\(\)/);
  assert.match(code, /sms_blocked_sender_numbers/);
});

test("graph coverage SQL has no unapproved cross-market fallback (first texts are exact-market while Routing 2.0 is off)", () => {
  assert.doesNotMatch(code, /route_rules|midwest_to_minneapolis|approved_state_fallback/);
  assert.match(code, /false AS fallback_covered/);
  // the only selection is the row's own canonical market
  assert.match(code, /WHERE inventory\.market_key = input\.market_key\s+ORDER BY/);
});

const fleet = [
  { id: "atl-1", phone_number: "+14704920588", market: "Atlanta, GA", status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 0 },
  { id: "atl-2", phone_number: "+14705556385", market: "Atlanta, GA", status: "paused", health_state: "unverified", daily_limit: 800, messages_sent_today: 0 },
  { id: "mpls-1", phone_number: "+16128060495", market: "Minneapolis, MN", status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 0 },
  { id: "mia-1", phone_number: "+17866052999", market: "Miami, FL", status: "active", health_state: "cooling", daily_limit: 800, messages_sent_today: 0 },
];
const deps = {
  textgridNumberRows: fleet,
  loadDispatchBlockedSets: async () => ({ template_ids: new Set(), sender_numbers: new Set() }),
};

test("router (what the Composer cohort and planner use): St. Louis / Detroit have no local number -> not sendable, named", async () => {
  const rows = [
    ...Array.from({ length: 3 }, () => ({ market: "St. Louis, MO", state: "MO" })),
    ...Array.from({ length: 2 }, () => ({ market: "Detroit, MI", state: "MI" })),
  ];
  const result = await evaluateAudienceSenderCoverage(rows, deps);
  assert.equal(result.sendable_now, 0);
  assert.equal(result.no_sendable_number, 5);
  const stl = result.markets.find((m) => m.market === "St. Louis, MO");
  assert.equal(stl.sendable, false);
  assert.equal(stl.block_reason, "NO_VALID_LOCAL_TEXTGRID_NUMBER");
  assert.match(stl.summary, /St\. Louis, MO \(3 sellers\): there is no sender number in this market/);
  // Minneapolis has an eligible number, but a first text never borrows it
  assert.equal(result.markets.find((m) => m.market === "Detroit, MI").sendable, false);
});

test("router: Atlanta with one active number is sendable (the graph's all-false Atlanta was stale, not policy)", async () => {
  const result = await evaluateAudienceSenderCoverage([{ market: "Atlanta, GA", state: "GA" }], deps);
  assert.equal(result.sendable_now, 1);
  assert.equal(result.markets[0].route_tier, "exact_market_match");
});

test("router: a cooling local number does not cover its market (Miami 2999)", async () => {
  const result = await evaluateAudienceSenderCoverage([{ market: "Miami, FL", state: "FL" }], deps);
  assert.equal(result.sendable_now, 0);
  assert.notEqual(result.markets[0].block_reason, "NO_VALID_LOCAL_TEXTGRID_NUMBER");
});
