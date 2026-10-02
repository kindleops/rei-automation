#!/usr/bin/env node
/**
 * IC8.1 first-text variant F inputs -- production extract (READ-ONLY, gentle,
 * checkpointed; same reader discipline as extract-first-touch.mjs):
 *   - prospects.net_asset_value / buying_power (modeled wealth bands, owner
 *     decision 8.1 #1) for the primary prospects already resolved;
 *   - master_owners portfolio / company rollups (property_count,
 *     portfolio_total_units, max_ownership_years, portfolio value / equity /
 *     loan balance, active_lien_count, tax_delinquent_count) from the
 *     2026-04 import.
 *
 *   - properties.school_district_name (8.1 #2; foundation property.school_district@1).
 *
 * Not extracted: seller.* mortgages/liens (schema not exposed via PostgREST).
 *
 *   node --env-file=.env.local --no-warnings --loader ./tests/alias-loader.mjs \
 *     scripts/intelligence/baselines/extract-graph-extras.mjs
 */

import { DEFAULT_WORK_DIR } from "./extract-first-touch.mjs";
import { createRestReader } from "./lib/rest-reader.mjs";

export async function runGraphExtrasExtract({ workDir = DEFAULT_WORK_DIR, log = console.log } = {}) {
  const { supabase, hasSupabaseConfig } = await import("@/lib/supabase/client.js");
  if (!hasSupabaseConfig()) throw new Error("supabase_config_missing");
  const reader = createRestReader({ supabase, workDir, paceMs: 300, log });
  const phones = reader.readTable("phones");
  const sends = reader.readTable("sends");
  log("prospect wealth bands");
  await reader.lookup("prospect_wealth", {
    ids: phones.map((p) => p.primary_prospect_id),
    column: "prospect_id",
    query: () => supabase.from("prospects").select("prospect_id,net_asset_value,buying_power"),
  });
  log("property school district (8.1 #2: a property/geography fact)");
  await reader.lookup("property_school", {
    ids: sends.filter((s) => s.use_case_template === "ownership_check" && s.sent_at).map((s) => s.property_id),
    column: "property_id",
    query: () => supabase.from("properties").select("property_id,school_district_name"),
  });
  log("owner portfolio / company rollups");
  await reader.lookup("owner_portfolio", {
    ids: sends.filter((s) => s.use_case_template === "ownership_check" && s.sent_at).map((s) => s.master_owner_id),
    column: "master_owner_id",
    query: () =>
      supabase
        .from("master_owners")
        .select(
          "master_owner_id,property_count,portfolio_total_units,max_ownership_years,portfolio_total_value,portfolio_total_equity,portfolio_total_loan_balance,active_lien_count,tax_delinquent_count,created_at",
        ),
  });
  log(`graph extras extract complete (${reader.stats().calls} calls in this work dir)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGraphExtrasExtract().catch((error) => {
    console.error(`graph extras extract failed: ${String(error?.message || error).slice(0, 300)}`);
    process.exit(1);
  });
}
