#!/usr/bin/env node
/**
 * SENDER ROUTING 2.0 — generate the PROPOSED seed SQL from the one proposal
 * source (proposed-initial-graph.js) and the evidence backfill computed by
 * dry-run.mjs. Writes a file; touches no database.
 *
 *   node --import ./scripts/register-aliases-ops.mjs scripts/ops/sender-routing/build-seed-sql.mjs \
 *     --evidence=<dry-run.json> --out=../../supabase/migrations/20261002130100_sender_routing_v2_seed_proposed_graph.sql
 */
import fs from "node:fs";
import { arg } from "./_readonly.mjs";
import { PROPOSED_GRAPH_VERSION, PROPOSED_POOLS, PROPOSED_ROUTES } from "../../../src/lib/domain/routing/sender-routing/proposed-initial-graph.js";

const evidencePath = arg("evidence");
const out = arg("out");
if (!evidencePath || !out) {
  console.error("--evidence=<dry-run.json> and --out=<file.sql> are required");
  process.exit(2);
}
const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
const q = (v) => (v === null || v === undefined ? "null" : `'${String(v).replaceAll("'", "''")}'`);

const L = [];
L.push(
  `-- SENDER ROUTING 2.0 — PROPOSED INITIAL GRAPH SEED — PROPOSED, NOT APPLIED.`,
  `-- Generated ${new Date().toISOString()} by apps/api/scripts/ops/sender-routing/build-seed-sql.mjs`,
  `-- from proposed-initial-graph.js (${PROPOSED_GRAPH_VERSION}) and the dry-run evidence of ${evidence.generated_at}.`,
  `--`,
  `-- APPLY ONLY AFTER: (1) 20261002130000_sender_routing_v2.sql is applied, and`,
  `-- (2) the owner has approved the graph table (owner / proposal / confirm rows).`,
  `-- Applying it does NOT enable routing: system_control.sender_routing_v2_enabled stays 'false'.`,
  `-- Idempotent (on conflict do nothing / guarded updates). Rollback: the 130000 rollback file.`,
  `--`,
  `-- Indianapolis (+13173494612) and Tampa (+18138947553) are NOT in textgrid_numbers yet, so they`,
  `-- get no pool membership here; their pools exist (empty) and fill on onboarding`,
  `-- (scripts/ops/sender-routing/sql/onboard-indianapolis-tampa.sql, WARMING step).`,
  `-- +13057604780 (local-only, absent from the provider) is in no pool (retirement script).`,
  ``,
  `begin;`,
  ``,
  `-- ── 1. evidence backfill on textgrid_numbers (registration + webhook evidence only) ──`,
  `--    registered   = provider (TextGrid API GET, 2026-10-02) reports campaign CHM4NL2 and nothing local disputes it`,
  `--    verified     = inbound SMS has reached LeadCommand on the number (message_events history)`,
  `--    configured   = provider points at the inbound URL; no inbound yet`,
  `--    Atlanta 2 / Atlanta 3 are NOT marked registered: the API says CHM4NL2, the owner's console paste and the local`,
  `--    hold_reason say "not linked" — CONFIG MISMATCH until the owner confirms.`
);
for (const b of evidence.backfill || []) {
  const sets = [];
  if (b.registration_status) sets.push(`registration_status = coalesce(registration_status, ${q(b.registration_status)})`);
  if (b.sms_webhook_status) sets.push(`metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sms_webhook_status', ${q(b.sms_webhook_status)}, 'sms_webhook_evidence_at', '2026-10-02')`);
  L.push(`update public.textgrid_numbers set ${sets.join(", ")} where phone_number = ${q(b.phone)};`);
}
L.push(``, `-- ── 2. pools (sending hubs) ──`);
for (const p of PROPOSED_POOLS) {
  L.push(`insert into public.sender_pools (pool_key, display_name, home_market_id) values (${q(p.pool_key)}, ${q(p.display_name)}, ${q(p.home_market_id)}) on conflict (pool_key) do nothing;`);
}
L.push(``, `-- ── 3. pool membership (one pool per number) ──`);
for (const p of PROPOSED_POOLS) {
  for (const phone of p.members) {
    L.push(`insert into public.sender_pool_numbers (sender_pool_id, textgrid_number_id) select sp.id, tn.id from public.sender_pools sp, public.textgrid_numbers tn where sp.pool_key = ${q(p.pool_key)} and tn.phone_number = ${q(phone)} on conflict (textgrid_number_id) do nothing;`);
  }
}
L.push(``, `-- ── 4. market routes (array order = priority 10, 20, 30 …) ──`);
for (const [market_id, routes] of Object.entries(PROPOSED_ROUTES)) {
  routes.forEach((r, i) => {
    L.push(`insert into public.market_sender_routes (market_id, sender_pool_id, priority, affinity_tier, provenance, notes) select ${q(market_id)}, sp.id, ${(i + 1) * 10}, ${q(r.tier)}, ${q(r.provenance)}, ${q(r.notes)} from public.sender_pools sp where sp.pool_key = ${q(r.pool_key)} on conflict (market_id, sender_pool_id) do nothing;`);
  });
}
L.push(
  ``,
  `-- ── 5. version + audit ──`,
  `insert into public.sender_routing_audit (graph_version, event_type, actor, reason, subject)`,
  `select nextval('public.sender_routing_graph_version_seq'), 'graph_seed', 'owner_approved_seed', ${q(`proposal ${PROPOSED_GRAPH_VERSION}`)}, jsonb_build_object('markets', ${Object.keys(PROPOSED_ROUTES).length}, 'pools', ${PROPOSED_POOLS.length})`,
  ` where not exists (select 1 from public.sender_routing_audit where event_type = 'graph_seed' and reason = ${q(`proposal ${PROPOSED_GRAPH_VERSION}`)});`,
  ``,
  `commit;`,
  ``
);
fs.writeFileSync(out, L.join("\n"));
console.log(`wrote ${out}: ${(evidence.backfill || []).length} backfill updates, ${PROPOSED_POOLS.length} pools, ${Object.values(PROPOSED_ROUTES).flat().length} routes`);
