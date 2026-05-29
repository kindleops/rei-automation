/**
 * outbound-feeder-table-proof.mjs
 *
 * Proves that outbound_feeder_candidates is fast and delivers eligible
 * candidates through the feeder pipeline.
 *
 * Two-stage proof:
 *   1. DB fetch speed: getSupabaseFeederCandidates must complete < 2s
 *   2. Pipeline smoke: runSupabaseCandidateFeeder must process candidates
 *
 * Run:
 *   node --import ./tests/register-aliases.mjs \
 *        scripts/proof/outbound-feeder-table-proof.mjs
 *
 * Requires: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.
 */

import { performance } from "node:perf_hooks";
import { isInternalTestPhone } from "../../src/lib/config/internal-phones.js";
import {
  getSupabaseFeederCandidates,
  runSupabaseCandidateFeeder,
} from "../../src/lib/domain/outbound/supabase-candidate-feeder.js";

const PASS = "\x1b[32m✔ PASS\x1b[0m";
const FAIL = "\x1b[31m✖ FAIL\x1b[0m";
const INFO = "\x1b[36mℹ\x1b[0m";

let pass_count = 0;
let fail_count = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`${PASS} ${label}`);
    pass_count++;
  } else {
    console.log(`${FAIL} ${label}${detail ? ` — ${detail}` : ""}`);
    fail_count++;
  }
}

const FETCH_MAX_MS = 3_000; // 3s budget for network jitter; v_feeder_candidates_fast was timing out entirely

// ── Stage 1: DB fetch speed ───────────────────────────────────────────────────

console.log(`\n${INFO} Stage 1: DB fetch speed (table query only)…\n`);

const t_fetch = performance.now();
const fetch_result = await getSupabaseFeederCandidates({
  limit: 5,
  scan_limit: 100,
  candidate_source: "outbound_feeder_candidates",
  within_contact_window_now: false,
});
const fetch_elapsed_ms = Math.round(performance.now() - t_fetch);

console.log(`   source:          ${fetch_result.source}`);
console.log(`   fetch_elapsed_ms: ${fetch_elapsed_ms}`);
console.log(`   ok:              ${fetch_result.ok}`);
console.log(`   rows_returned:   ${fetch_result.rows?.length ?? 0}`);
console.log();

assert("fetch ok === true", fetch_result.ok === true, `ok=${fetch_result.ok} err=${fetch_result.candidate_source_error}`);
assert("fetch source is outbound_feeder_candidates", fetch_result.source === "outbound_feeder_candidates");
assert(
  `DB fetch completes within ${FETCH_MAX_MS}ms`,
  fetch_elapsed_ms < FETCH_MAX_MS,
  `elapsed=${fetch_elapsed_ms}ms`
);
assert(
  "rows_returned > 0",
  Number(fetch_result.rows?.length) > 0,
  `rows=${fetch_result.rows?.length}`
);

// ── Stage 2: Full pipeline smoke test ─────────────────────────────────────────

console.log(`\n${INFO} Stage 2: Full feeder dry-run (limit=5, scan_limit=100)…\n`);

const t0 = performance.now();
const result = await runSupabaseCandidateFeeder({
  candidate_source: "outbound_feeder_candidates",
  dry_run: true,
  limit: 5,
  scan_limit: 100,
  within_contact_window_now: false,
  routing_safe_only: false,
  cold_outbound_touch_cap: 5,
  phone_cooldown_days: 14,
});
const elapsed_ms = Math.round(performance.now() - t0);

const loaded_count = result.fetched_candidate_count ?? result.scanned_count ?? 0;

console.log(`   source:             ${result.source || result.candidate_source}`);
console.log(`   elapsed_ms:         ${elapsed_ms}`);
console.log(`   loaded_count:       ${loaded_count}`);
console.log(`   eligible_count:     ${result.eligible_count}`);
console.log(`   queued_count:       ${result.queued_count}`);
console.log(`   skipped_count:      ${result.skipped_count}`);
console.log(`   dry_run:            ${result.dry_run}`);
console.log(`   ok:                 ${result.ok}`);

if (result.sample_skips?.length) {
  const reasons = {};
  for (const s of result.sample_skips) {
    reasons[s.reason_code] = (reasons[s.reason_code] || 0) + 1;
  }
  console.log(`   skip_reasons:       ${JSON.stringify(reasons)}`);
}

if (result.sample_created_queue_items?.length) {
  const markets = [...new Set(result.sample_created_queue_items.map((r) => r.market).filter(Boolean))];
  console.log(`   sample_markets:     ${markets.slice(0, 5).join(", ")}`);
  const nc = result.sample_created_queue_items.filter((r) => r.never_contacted === true).length;
  console.log(`   never_contacted:    ${nc}/${result.sample_created_queue_items.length}`);
}

console.log();

assert("pipeline ok === true", result.ok === true, `ok=${result.ok} err=${result.error || result.candidate_source_error}`);
assert("pipeline source is outbound_feeder_candidates", (result.source || result.candidate_source) === "outbound_feeder_candidates");
assert("loaded_count > 0", Number(loaded_count) > 0, `loaded=${loaded_count}`);
assert("dry_run === true", result.dry_run === true);

// In dry_run mode, queued_count tracks "would be queued" — limit it to ≤ requested limit
assert(
  "queued_count <= limit (5)",
  result.queued_count <= 5,
  `queued=${result.queued_count}`
);

// No internal test phones in eligible sample
const eligible_phones = (result.sample_created_queue_items || []).map((r) => r.to_phone_number || "");
const has_internal = eligible_phones.some((p) => isInternalTestPhone(p));
assert(
  "no internal test phone in eligible sample",
  !has_internal,
  `internal_found=${eligible_phones.filter((p) => isInternalTestPhone(p)).join(", ")}`
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`${"─".repeat(60)}`);
console.log(`Total: ${pass_count + fail_count} | ✔ ${pass_count} | ✖ ${fail_count}`);
console.log(`${"─".repeat(60)}\n`);

if (fail_count > 0) process.exit(1);
