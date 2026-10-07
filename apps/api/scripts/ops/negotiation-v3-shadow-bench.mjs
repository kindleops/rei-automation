#!/usr/bin/env node
/**
 * NEGOTIATION v3 — offline shadow + timing bench. Reads a JSON array of
 * property_acquisition_scores rows in OFFER_READY_V3_PROJECTION shape (export
 * them read-only first), builds a plan per row and a first move against a
 * synthetic ask grid, and reports plan/move timings and the authority split.
 * No DB access, no writes, no sends. Flags are forced ON in-memory only to
 * measure the autonomous path; nothing here can send.
 *
 *   cd apps/api && nice -n 15 node --import ./tests/register-aliases.mjs \
 *     scripts/ops/negotiation-v3-shadow-bench.mjs --rows=<file.json> [--now=ISO] [--iters=2000]
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { buildNegotiationPlan, nextNegotiationMove, isOfferReady } from "../../src/lib/domain/negotiation-v3/index.js";

const arg = (k, d = null) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=").slice(1).join("=") || d;
const text = readFileSync(arg("rows"), "utf8").split("\n").filter((l) => !/^(Time:|Timing is)/.test(l)).join("\n").trim();
const rows = JSON.parse(text) || [];
const now = Date.parse(arg("now", new Date().toISOString()));
const iters = Number(arg("iters", 2000));
const env = { NEGOTIATION_ENGINE_V3: "true", AUTONOMOUS_MONETARY_QUOTES: "true" };

const pct = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
const summary = { rows: rows.length, offer_ready: 0, plan_ok: 0, by_reason: {}, by_first_move: {}, floor_binds_target: 0, al_to_c: [], anchor_to_target: [] };
const planT = [];
const moveT = [];
for (const row of rows) {
  const property = { property_type: row.asset_family === "multifamily" ? "Multi-Family" : "Single Family", units_count: row.units != null ? Number(row.units) : null };
  if (isOfferReady(row, { now }).ready) summary.offer_ready += 1;
  const ctx = { ade_snapshot: row, property, seller: { asking_price: Math.round(Number(row.valuation_mid || 0) * 0.8), condition: "dated" }, now, env };
  let plan;
  const t0 = performance.now();
  for (let i = 0; i < iters; i += 1) plan = buildNegotiationPlan(ctx);
  planT.push((performance.now() - t0) / iters);
  const t1 = performance.now();
  let move;
  for (let i = 0; i < iters; i += 1) move = nextNegotiationMove(plan, { lc_positions: plan.ok ? [plan.ladder_anchor] : [], seller_positions: [] }, { kind: "counter", amount: ctx.seller.asking_price });
  moveT.push((performance.now() - t1) / iters);
  if (plan.ok) {
    summary.plan_ok += 1;
    if (plan.anchor_floor != null && plan.ladder_anchor === plan.anchor_floor) summary.floor_binds_target += 1;
    summary.autonomy_eligible = (summary.autonomy_eligible || 0) + (plan.autonomy.eligible ? 1 : 0);
    summary.al_to_c.push(+(plan.autonomous_limit / plan.ceiling).toFixed(3));
    summary.anchor_to_target.push(+(plan.ladder_anchor / plan.target).toFixed(3));
  } else {
    const k = plan.reasons.slice(0, 3).join("|");
    summary.by_reason[k] = (summary.by_reason[k] || 0) + 1;
  }
  const first = nextNegotiationMove(plan, {}, { kind: "price", amount: ctx.seller.asking_price });
  const key = `${first.action}:${first.rule_branch}`;
  summary.by_first_move[key] = (summary.by_first_move[key] || 0) + 1;
}
// Autonomy ladder split (owner 10-07): position + reason, and the legacy ungraded fallback for comparison.
summary.ladder = { autonomous: 0, proposal_review: 0, no_numbers: 0, legacy_authorized_only_autonomous: 0, top_reasons: {} };
for (const row of rows) {
  const property = { property_type: row.asset_family === "multifamily" ? "Multi-Family" : "Single Family", units_count: row.units != null ? Number(row.units) : null };
  const p = buildNegotiationPlan({ ade_snapshot: row, property, seller: {}, now, env });
  if (!p.ok) summary.ladder.no_numbers += 1;
  else summary.ladder[p.autonomy.ladder_position] += 1;
  for (const r of p.autonomy?.reasons || []) summary.ladder.top_reasons[r] = (summary.ladder.top_reasons[r] || 0) + 1;
  const legacy = buildNegotiationPlan({ ade_snapshot: row, property, seller: {}, now, env, config: { autonomy: { ungraded: "authorized_only" } } });
  if (legacy.ok && legacy.autonomy.eligible) summary.ladder.legacy_authorized_only_autonomous += 1;
}
summary.al_to_c = { p10: pct(summary.al_to_c, 0.1), p50: pct(summary.al_to_c, 0.5), p90: pct(summary.al_to_c, 0.9) };
summary.anchor_to_target = { p10: pct(summary.anchor_to_target, 0.1), p50: pct(summary.anchor_to_target, 0.5), p90: pct(summary.anchor_to_target, 0.9) };
summary.timing_ms = {
  plan_p50: +pct(planT, 0.5).toFixed(4), plan_p99: +pct(planT, 0.99).toFixed(4),
  move_p50: +pct(moveT, 0.5).toFixed(4), move_p99: +pct(moveT, 0.99).toFixed(4),
};
console.log(JSON.stringify(summary, null, 1));
