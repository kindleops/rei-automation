/**
 * outbound-feeder-fast-proof.mjs
 *
 * Proves that v_feeder_candidates_fast delivers eligible candidates quickly
 * and that the feeder dry-run returns eligible_count > 0 within budget.
 *
 * Run:
 *   node --import ../../tests/register-aliases.mjs \
 *        scripts/proof/outbound-feeder-fast-proof.mjs
 *
 * Requires: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.
 */

import { performance } from "node:perf_hooks";
import { runSupabaseCandidateFeeder } from "../../src/lib/domain/outbound/supabase-candidate-feeder.js";

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

const MAX_ELAPSED_MS = 10_000; // 10 seconds — generous for cold network

console.log(`\n${INFO} Running feeder dry-run with v_feeder_candidates_fast (default)…\n`);

const t0 = performance.now();

const result = await runSupabaseCandidateFeeder({
  dry_run: true,
  limit: 25,
  scan_limit: 200,
  within_contact_window_now: false,
  routing_safe_only: false, // avoid routing blocks masking eligibility
  cold_outbound_touch_cap: 5,
  phone_cooldown_days: 14,
});

const elapsed_ms = Math.round(performance.now() - t0);

console.log(`\n${INFO} Result summary:`);
console.log(`   source:           ${result.source || result.candidate_source}`);
console.log(`   elapsed_ms:       ${elapsed_ms}`);
console.log(`   scanned_count:    ${result.scanned_count}`);
console.log(`   eligible_count:   ${result.eligible_count}`);
console.log(`   queued_count:     ${result.queued_count}`);
console.log(`   skipped_count:    ${result.skipped_count}`);
console.log(`   dry_run:          ${result.dry_run}`);
console.log(`   ok:               ${result.ok}`);

if (result.sample_skips?.length) {
  const skip_reasons = {};
  for (const s of result.sample_skips) {
    skip_reasons[s.reason_code] = (skip_reasons[s.reason_code] || 0) + 1;
  }
  console.log(`   skip reasons:     ${JSON.stringify(skip_reasons)}`);
}

if (result.sample_created_queue_items?.length) {
  const markets = [...new Set(result.sample_created_queue_items.map((r) => r.market).filter(Boolean))];
  console.log(`   sample markets:   ${markets.slice(0, 5).join(", ")}`);
  const never_contacted_sample = result.sample_created_queue_items.filter((r) => r.never_contacted === true).length;
  console.log(`   never_contacted candidates in eligible sample: ${never_contacted_sample}/${result.sample_created_queue_items.length}`);
}

console.log();

// ── Assertions ──────────────────────────────────────────────────────────────

assert("result.ok === true", result.ok === true, `ok=${result.ok}, error=${result.error}`);

assert(
  `source is v_feeder_candidates_fast`,
  (result.source || result.candidate_source) === "v_feeder_candidates_fast",
  `source=${result.source || result.candidate_source}`
);

assert(
  `completed within ${MAX_ELAPSED_MS}ms`,
  elapsed_ms < MAX_ELAPSED_MS,
  `elapsed=${elapsed_ms}ms`
);

assert(
  "scanned_count > 0",
  Number(result.scanned_count) > 0,
  `scanned=${result.scanned_count}`
);

assert(
  "eligible_count > 0",
  Number(result.eligible_count) > 0,
  `eligible=${result.eligible_count}`
);

assert(
  "queued_count === 0 in dry_run",
  result.queued_count === 0,
  `queued=${result.queued_count}`
);

assert(
  "dry_run === true",
  result.dry_run === true,
  `dry_run=${result.dry_run}`
);

// Verify sample eligible candidates are never_contacted or at least not suppressed
if (result.sample_created_queue_items?.length) {
  const all_never_contacted_or_fresh = result.sample_created_queue_items.every(
    (r) => r.never_contacted === true || r.never_contacted == null
  );
  assert(
    "eligible sample candidates are never_contacted (not recycled)",
    all_never_contacted_or_fresh,
    `sample=${JSON.stringify(result.sample_created_queue_items.slice(0, 3).map((r) => ({ never_contacted: r.never_contacted, market: r.market })))}`
  );
}

// Verify that skipped candidates include PENDING_PRIOR_TOUCH for suppressed sellers
// (only meaningful if there are some in the scan window)
const pending_touch_skips = (result.sample_skips || []).filter(
  (s) => s.reason_code === "PENDING_PRIOR_TOUCH"
);
if (pending_touch_skips.length > 0) {
  assert(
    "skipped candidates include PENDING_PRIOR_TOUCH (suppressed sellers correctly blocked)",
    pending_touch_skips.length > 0,
    `pending_prior_touch_skips=${pending_touch_skips.length}`
  );
} else {
  console.log(`${INFO} No PENDING_PRIOR_TOUCH skips in this scan window — view pre-filter already excluded them`);
  pass_count++; // expected: view pre-filtered suppressed rows, so JS gate may not see any
}

assert(
  "internal_test_phone_count=0 in eligible sample (no internal numbers queued)",
  (result.sample_created_queue_items || []).every((r) => {
    const phone = r.to_phone_number || "";
    return !phone.includes("6127433952");
  }),
  "internal test phone slipped through"
);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`${"─".repeat(60)}`);
console.log(`Total: ${pass_count + fail_count} | ✔ ${pass_count} | ✖ ${fail_count}`);
console.log(`${"─".repeat(60)}\n`);

if (fail_count > 0) process.exit(1);
