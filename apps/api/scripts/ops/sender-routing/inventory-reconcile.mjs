#!/usr/bin/env node
/**
 * SENDER ROUTING 2.0 — inventory reconciliation report. READ-ONLY.
 *
 *   node --import ./scripts/register-aliases-ops.mjs scripts/ops/sender-routing/inventory-reconcile.mjs [--out=<file.json>]
 *
 * Provider side: TextGrid IncomingPhoneNumbers (GET) when credentials exist,
 * and ALSO the owner's pasted console (2026-10-02); disagreements between the
 * two are reported, never silently resolved. Local side: textgrid_numbers,
 * the operator blocklist, inbound message history (the only webhook evidence).
 */
import { readOnlyClient, readTextgridInventory, readAll, arg, writeOut, OWNER_PASTE_2026_10_02 } from "./_readonly.mjs";
import { reconcileInventory, compareProviderSnapshots } from "../../../src/lib/domain/routing/sender-routing/sender-inventory-reconciliation.js";
import { PROPOSED_POOLS } from "../../../src/lib/domain/routing/sender-routing/proposed-initial-graph.js";
import { normalizeE164 } from "../../../src/lib/domain/routing/sender-routing/sender-routing-policy.js";

const sb = readOnlyClient();
const local = await readAll(sb, "textgrid_numbers", "*");
const { data: sc } = await sb.from("system_control").select("key,value").eq("key", "sms_blocked_sender_numbers");
const blocked = new Set(String(sc?.[0]?.value || "").split(",").map(normalizeE164).filter(Boolean));

let api = null;
let apiError = null;
try {
  api = await readTextgridInventory();
} catch (error) {
  apiError = error.message;
}
const provider = api || OWNER_PASTE_2026_10_02;
const providerSource = api ? "textgrid_api_get" : "owner_paste_2026_10_02";

const phones = [...new Set([...provider.map((p) => normalizeE164(p.phone_number)), ...local.map((l) => normalizeE164(l.phone_number))])];
const inboundCounts = new Map();
for (const phone of phones) {
  const { count } = await sb.from("message_events").select("id", { count: "exact", head: true }).eq("to_phone_number", phone).eq("direction", "inbound");
  inboundCounts.set(phone, count || 0);
}
const poolOf = new Map();
for (const p of PROPOSED_POOLS) for (const phone of [...p.members, ...(p.pending_onboarding || [])]) poolOf.set(phone, `${p.pool_key} (proposed)`);

const report = reconcileInventory(provider, local, { blocked, inboundCounts, poolOf });
const sourceDisagreements = api ? compareProviderSnapshots(api, OWNER_PASTE_2026_10_02, { labels: ["textgrid_api", "owner_paste"] }) : [];

console.log(`provider source: ${providerSource}${apiError ? ` (API read failed: ${apiError}; used the owner paste)` : ""}`);
console.log(JSON.stringify(report.totals));
console.log("phone | state | webhook | campaign | local status/health | lifecycle | pool | flags | mismatches");
for (const r of report.rows) {
  console.log([r.phone, r.state, r.webhook_state, r.provider?.campaign ?? "-", r.local ? `${r.local.status}/${r.local.health_state}` : "-", r.lifecycle, r.pool ?? "-", r.flags.join(",") || "-", r.mismatches.join(",") || "-"].join(" | "));
}
if (sourceDisagreements.length) {
  console.log("\nAPI vs owner paste disagreements:");
  for (const d of sourceDisagreements) console.log(" ", JSON.stringify(d));
}
writeOut(arg("out"), { generated_at: new Date().toISOString(), provider_source: providerSource, source_disagreements: sourceDisagreements, ...report });
