#!/usr/bin/env node
/**
 * SENDER ROUTING 2.0 — ACTIVATION GATE for one number. READ-ONLY. SENDS NOTHING.
 * Writes nothing: when every check passes it PRINTS the guarded activation SQL
 * for the owner/lead to run; any failure prints why and exits 1.
 *
 *   node --import ./scripts/register-aliases-ops.mjs scripts/ops/sender-routing/activate-number.mjs \
 *     --number=+13173494612 [--max-proof-age-days=7] [--out=<file.sql>]
 *
 * The live TextGrid API is the source of truth (owner, 2026-10-02). Re-read
 * IMMEDIATELY before activating — never from a cached snapshot or a paste:
 *   provider_present      the number is on the TextGrid account (GET)
 *   campaign_assigned     campaignId === CHM4NL2
 *   inbound_webhook       sms_url === https://ops.leadcommand.ai/api/webhooks/textgrid/inbound
 *   local_record          exactly one textgrid_numbers row, not retired
 *   inbound_verified      a REAL inbound SMS to this number reached message_events within
 *                         --max-proof-age-days (the owner's proof text) — for a new number
 *                         also metadata.onboarding_stage = 'inbound_verified'
 *   not_operator_blocked  not on sms_blocked_sender_numbers (routing never overrides a block)
 * Applies to Chicago +18722547122 (new, r3), Indianapolis/Tampa (done 2026-10-03) and to
 * Atlanta 2/3 (their campaign assignment was disputed: API CHM4NL2 vs the owner's paste /
 * local hold "not linked").
 * Daily limit on activation: 800, the fleet standard (= system_control queue_per_number_cap).
 * The owner REJECTED 25/day on 2026-10-03 ("far too low"); never activate lower.
 */
import { readOnlyClient, readTextgridInventory, arg, writeOut } from "./_readonly.mjs";
import { normalizeE164 } from "../../../src/lib/domain/routing/sender-routing/sender-routing-policy.js";
import { EXPECTED_CAMPAIGN_ID, EXPECTED_INBOUND_WEBHOOK } from "../../../src/lib/domain/routing/sender-routing/sender-inventory-reconciliation.js";

const ACTIVATION_DAILY_LIMIT = 800;
const POOL_OF = { "+18722547122": "chicago", "+13149268488": "st_louis", "+13173494612": "indianapolis", "+18138947553": "tampa", "+14702936385": "atlanta", "+14702936402": "atlanta" };

const number = normalizeE164(arg("number"));
const maxAgeDays = Number(arg("max-proof-age-days", 7));
if (!number) {
  console.error("--number=<E.164> required");
  process.exit(2);
}
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });

// 1. provider, re-read now
let provider = null;
try {
  const inventory = await readTextgridInventory();
  if (!inventory) check("provider_read", false, "TextGrid credentials absent: cannot re-read the provider; refusing");
  else provider = inventory.find((p) => normalizeE164(p.phone_number) === number) || null;
} catch (error) {
  check("provider_read", false, `TextGrid read failed: ${error.message}`);
}
if (!checks.length) {
  check("provider_present", provider, provider ? `on the account as "${provider.friendly_name}"` : "not on the TextGrid account");
  check("campaign_assigned", provider?.campaign === EXPECTED_CAMPAIGN_ID, `campaignId=${provider?.campaign ?? "none"} (expected ${EXPECTED_CAMPAIGN_ID})`);
  check("inbound_webhook", String(provider?.sms_url || "").replace(/\/+$/, "") === EXPECTED_INBOUND_WEBHOOK, `sms_url=${provider?.sms_url || "none"}`);
}

// 2. local record + inbound evidence + blocklist
const sb = readOnlyClient();
const { data: rows } = await sb.from("textgrid_numbers").select("*").eq("phone_number", number);
const local = (rows || [])[0] || null;
const meta = local?.metadata || {};
check("local_record", (rows || []).length === 1 && meta.lifecycle_state !== "retired", (rows || []).length === 1 ? `status=${local.status} stage=${meta.onboarding_stage || "-"}` : `${(rows || []).length} local rows`);
const since = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
const { data: inbound } = await sb.from("message_events").select("id,created_at").eq("to_phone_number", number).eq("direction", "inbound").gte("created_at", since).order("created_at", { ascending: false }).limit(1);
const isNew = Boolean(meta.onboarding_stage);
const proofOk = (inbound || []).length > 0 && (!isNew || meta.onboarding_stage === "inbound_verified");
check("inbound_verified", proofOk, (inbound || []).length ? `last inbound ${inbound[0].created_at}${isNew ? `; stage ${meta.onboarding_stage}` : ""}` : `no inbound SMS to this number in the last ${maxAgeDays} days — the owner sends the proof text first (inbound-proof.mjs)`);
const { data: sc } = await sb.from("system_control").select("value").eq("key", "sms_blocked_sender_numbers").maybeSingle();
const blocked = new Set(String(sc?.value || "").split(",").map(normalizeE164).filter(Boolean));
check("not_operator_blocked", !blocked.has(number), blocked.has(number) ? "on the operator blocklist; routing never overrides a block" : "not blocked");

for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name.padEnd(22)} ${c.detail}`);
const pass = checks.every((c) => c.pass);
if (!pass) {
  console.log("\nREFUSED: nothing to activate. Fix the failures and re-run immediately before activating.");
  process.exit(1);
}

const pool = POOL_OF[number] || null;
const sql = `-- ACTIVATION for ${number} — generated ${new Date().toISOString()} by activate-number.mjs after a
-- LIVE re-read (TextGrid campaign ${provider.campaign}, sms_url set, inbound ${inbound[0].created_at}).
-- Run promptly; the WHERE clause re-checks the local state and does nothing if it changed.
begin;
update public.textgrid_numbers
   set status = 'active',
       daily_limit = ${ACTIVATION_DAILY_LIMIT},
       registration_status = 'registered',
       metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
         'onboarding_stage', 'active', 'activated_at', now(), 'activation_daily_limit', ${ACTIVATION_DAILY_LIMIT},
         'campaign_id_10dlc', '${provider.campaign}', 'sms_webhook_status', 'verified',
         'activation_provider_check_at', '${new Date().toISOString()}', 'activation_inbound_event_id', '${inbound[0].id}')
           - 'hold_reason'
 where phone_number = '${number}'
   and coalesce(metadata->>'lifecycle_state', '') <> 'retired'
   and ${isNew ? "metadata->>'onboarding_stage' = 'inbound_verified'" : "status = 'paused'"};
${pool ? `do $$ begin
  if to_regclass('public.sender_pool_numbers') is not null then
    insert into public.sender_pool_numbers (sender_pool_id, textgrid_number_id)
    select sp.id, tn.id from public.sender_pools sp, public.textgrid_numbers tn
     where sp.pool_key = '${pool}' and tn.phone_number = '${number}'
    on conflict (textgrid_number_id) do update set status = 'active';
    insert into public.sender_routing_audit (graph_version, event_type, actor, reason, subject)
    values (nextval('public.sender_routing_graph_version_seq'), 'activation', 'owner', 'activate-number.mjs live checks passed',
            jsonb_build_object('phone', '${number}', 'pool', '${pool}', 'daily_limit', ${ACTIVATION_DAILY_LIMIT}));
  end if;
end $$;` : ""}
select phone_number, status, daily_limit, metadata->>'onboarding_stage' as stage from public.textgrid_numbers where phone_number = '${number}';
-- change to COMMIT only with the owner:
rollback;
`;
console.log(`\nALL CHECKS PASSED. Activation SQL (dry-run by default, ends in ROLLBACK):\n\n${sql}`);
writeOut(arg("out"), sql);
