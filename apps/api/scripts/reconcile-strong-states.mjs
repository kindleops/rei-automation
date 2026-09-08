/**
 * reconcile-strong-states.mjs
 *
 * The unambiguous half of the 16-row review set. Three DIFFERENT canonical
 * outcomes, applied through the canonical writer -- never collapsed into one
 * another just because all three make FUS2 inappropriate.
 *
 *   NOT OWNER  disposition=wrong_person. Deliberately NOT wrong_number, which
 *              maps to contactability invalid_number and would mark a
 *              perfectly reachable phone dead.
 *   OPT-OUT    binding contact suppression, with the source inbound as
 *              evidence, through the same authority STOP uses.
 *   DECLINED   the identical patch used for the approved 28.
 *
 * #7-14 are NOT in this file. They carry live commercial signal (prices,
 * timing, alternate properties) and belong to a separate opportunity pass.
 *
 *   node scripts/reconcile-strong-states.mjs           # dry run
 *   node scripts/reconcile-strong-states.mjs --apply
 */

import { patchUniversalLeadState } from "@/lib/domain/lead-state/patch-universal-lead-state.js";
import { supabase } from "@/lib/supabase/client.js";

const APPLY = process.argv.includes("--apply");

const NOT_OWNER = [
  { threadKey: "+12097409959", why: 'answered "No" to "21 Pereira Ave es tu propiedad?"' },
  { threadKey: "+12188314492", why: 'answered "No" to "do you own 6542 E Boise St"' },
  { threadKey: "+14042740963", why: 'answered "No" to "are you still the owner of 6915 Oswego Trl"' },
  { threadKey: "+14794149087", why: 'explicit denial: "I do not own any land in Oklahoma" (Black Diamond LLC ownership-data dispute)' },
  { threadKey: "+12523719212", why: 'not the owner; named the actual owner: "the owner is chris cole"' },
];

const OPT_OUT = [
  {
    threadKey: "+12094964194",
    sourceEventId: "9047083d-f9d8-45b6-925d-a55d2b70f932",
    why: '"It\'s not for sale lose my number" -- contact cessation, stronger than the commercial refusal it also contains',
  },
];

const DECLINED = [
  { threadKey: "+14102940284", why: '"Not selling" / "To investors"' },
  { threadKey: "+18165825049", why: '"Nope" / "Its not for sell"' },
];

/** Never touched here: live commercial signal, separate pass. */
const HELD_FOR_OPPORTUNITY_PASS = [
  "+12087225854", "+16128028200", "+13176279734", "+13108774442",
  "+17086024812", "+14012633135", "+18327642354", "+12089365404",
];

const all = [...NOT_OWNER, ...OPT_OUT, ...DECLINED].map((r) => r.threadKey);
if (all.length !== 8) throw new Error(`expected 8 rows, got ${all.length}`);
for (const held of HELD_FOR_OPPORTUNITY_PASS) {
  if (all.includes(held)) throw new Error(`${held} is held for the opportunity pass and must not be written`);
}

const results = [];

for (const row of NOT_OWNER) {
  const res = await patchUniversalLeadState({
    threadKey: row.threadKey,
    patch: { disposition: "wrong_person", operational_status: "paused", lead_temperature: "cold" },
    meta: { change_source: "manual", change_reason: `not_owner: ${row.why}`, reconciliation: "strong_state_triage" },
    dryRun: !APPLY,
    supabase,
  });
  results.push({ category: "not_owner", ...row, ok: res?.ok === true, reason: res?.reason || null });
}

for (const row of OPT_OUT) {
  const res = await patchUniversalLeadState({
    threadKey: row.threadKey,
    // Binding suppression, through the same authority STOP uses.
    patch: {
      contactability_status: "opted_out",
      is_suppressed: true,
      operational_status: "paused",
      lead_temperature: "cold",
    },
    meta: {
      change_source: "manual",
      change_reason: `contact_cessation: ${row.why}`,
      reconciliation: "strong_state_triage",
      // The gate requires provenance pointing at the inbound that produced it.
      suppression_evidence: {
        type: "explicit_opt_out",
        source_event_id: row.sourceEventId,
        source_authority: "seller_inbound_message",
        binding: true,
      },
    },
    dryRun: !APPLY,
    supabase,
  });
  results.push({ category: "opt_out", ...row, ok: res?.ok === true, reason: res?.reason || null });
}

for (const row of DECLINED) {
  const res = await patchUniversalLeadState({
    threadKey: row.threadKey,
    patch: { disposition: "not_interested", operational_status: "paused", lead_temperature: "cold" },
    meta: { change_source: "manual", change_reason: "ontology_state_hints:not_interested", reconciliation: "strong_state_triage" },
    dryRun: !APPLY,
    supabase,
  });
  results.push({ category: "declined", ...row, ok: res?.ok === true, reason: res?.reason || null });
}

console.log(`${APPLY ? "APPLIED" : "DRY RUN"}: ${results.filter((r) => r.ok).length}/${results.length} ok`);
for (const r of results.filter((r) => !r.ok)) console.log(`  BLOCKED ${r.category} ${r.threadKey}: ${r.reason}`);
