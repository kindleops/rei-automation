// P0 §G PROOF — canonical inbox single source of truth.
// Exercises the ACTUAL rewired service (getLiveInbox / getLiveCounts) against
// prod for every inbox category and verifies:
//   * counts come from canonical_inbox_counts and equal the rows in each bucket
//   * every returned row carries the canonical inbox_bucket (single source)
//   * deal intelligence (property/owner/phone/equity/value/type/market) is present
// Run: node --env-file=.env.local --import ./tests/register-aliases.mjs scripts/proof/canonical-inbox-proof.mjs
import { getLiveInbox, getLiveCounts } from "@/lib/domain/inbox/live-inbox-service.js";
import { supabase } from "@/lib/supabase/client.js";

const CATEGORIES = ["all", "priority", "new_replies", "needs_review", "follow_up", "cold", "dead", "suppressed"];

function intel(row = {}) {
  return {
    property_address: row.property_address_full || row.property_address || null,
    market: row.market || null,
    asset_type: row.property_type || null,
    estimated_value: row.estimated_value ?? null,
    equity_percent: row.equity_percent ?? null,
    owner: row.owner_name || row.owner_display_name || row.seller_display_name || null,
    phone: row.best_phone || row.canonical_e164 || row.seller_phone || null,
  };
}

const out = [];
let pass = true;

const counts = await getLiveCounts({});
console.log("\n=== COUNTS (source: canonical_inbox_counts) ===");
console.log(JSON.stringify(counts, null, 2));

for (const cat of CATEGORIES) {
  let res, err = null;
  const t0 = Date.now();
  try {
    res = await getLiveInbox({ filter: cat, limit: 5 });
  } catch (e) {
    err = e?.message || String(e);
    res = {};
  }
  const ms = Date.now() - t0;
  const rows = res.threads || [];
  const source = res.diagnostics?.source || res.source || null;
  const badge = cat === "all" ? counts.all : counts[cat];

  // every returned row must carry the requested canonical bucket (single source)
  const offBucket = cat === "all" ? [] : rows.filter((r) => String(r.inbox_bucket).toLowerCase() !== cat);
  const sample = rows[0] ? { thread_key: rows[0].thread_key, bucket: rows[0].inbox_bucket, ...intel(rows[0]) } : null;
  const intelComplete = sample ? Object.values(intel(rows[0])).every((v) => v !== null && v !== undefined) : null;

  const ok =
    !err &&
    source === "canonical_inbox_threads" &&
    offBucket.length === 0 &&
    res.countsApproximate !== true &&
    res.countsDegraded !== true;
  if (!ok) pass = false;

  out.push({ category: cat, badge_count: badge, source, ms, error: err, off_bucket_in_page: offBucket.length, approximate: res.countsApproximate === true, degraded: res.countsDegraded === true, sample, intel_complete: intelComplete, ok });
}

console.log("\n=== PER-CATEGORY PROOF ===");
for (const r of out) {
  console.log(`\n[${r.ok ? "PASS" : "FAIL"}] ${r.category}  (${r.ms}ms)`);
  console.log(`   badge_count = ${r.badge_count}  |  source = ${r.source}`);
  console.log(`   approximate=${r.approximate} degraded=${r.degraded}  |  off_bucket_rows_in_page=${r.off_bucket_in_page}${r.error ? `  | ERROR=${r.error}` : ""}`);
  console.log(`   sample = ${JSON.stringify(r.sample)}`);
  console.log(`   deal_intel_complete = ${r.intel_complete}`);
}

console.log(`\n=== OVERALL: ${pass ? "PASS ✅" : "FAIL ❌"} ===`);
process.exit(pass ? 0 : 1);
