/**
 * reconcile-approved-declines.mjs
 *
 * Applies the operator-approved historical decline reconciliation through the
 * CANONICAL writer (patchUniversalLeadState), not raw SQL, so the field
 * mapping, suppression gate and audit trail are exactly the live ones.
 *
 * The 28 identities are PINNED here rather than re-derived from a predicate.
 * A broad UPDATE is what would sweep in the 16 review rows -- among them three
 * sellers whose "No" answered an OWNERSHIP question (they are not the owner),
 * one $1.5M conditional seller, one seller offering a different property, and
 * one possible opt-out ("lose my number"). Those must not be recorded as
 * "declined to sell".
 *
 *   node scripts/reconcile-approved-declines.mjs           # dry run
 *   node scripts/reconcile-approved-declines.mjs --apply   # write
 */

import { patchUniversalLeadState } from "@/lib/domain/lead-state/patch-universal-lead-state.js";
import { supabase } from "@/lib/supabase/client.js";

const APPLY = process.argv.includes("--apply");

/** Compound: ownership confirmed AND sale declined in one message. */
const COMPOUND = new Set(["+13106170071"]);

const APPROVED_28 = [
  "+18323258938", "+15129256927", "+18054031157", "+15126291872",
  "+16025509844", "+19515054047", "+19132062326", "+14047204232",
  "+15129233124", "+19175473891", "+19012339373", "+19516550306",
  "+19518589211", "+12094995311", "+12098151023", "+18478526841",
  "+13036197900", "+19134331044", "+18327971842", "+17028109883",
  "+12522662553", "+16512351208", "+12088694635", "+15122034629",
  "+13106170071", "+13107222747", "+14014297593", "+13239746347",
];

/** Never to be reconciled in this pass. Asserted, not assumed. */
const REVIEW_EXCLUDED = [
  "+12097409959", "+12188314492", "+14042740963", "+14794149087",
  "+12087225854", "+13176279734", "+17086024812", "+12094964194",
];

if (APPROVED_28.length !== 28) throw new Error(`expected 28, got ${APPROVED_28.length}`);
if (new Set(APPROVED_28).size !== 28) throw new Error("duplicate thread key in approved set");
for (const key of REVIEW_EXCLUDED) {
  if (APPROVED_28.includes(key)) throw new Error(`review row ${key} must not be in the approved set`);
}

const results = [];
for (const threadKey of APPROVED_28) {
  const reason = COMPOUND.has(threadKey)
    ? "compound_ownership_confirmed_with_sale_decline"
    : "ontology_state_hints:not_interested";

  const res = await patchUniversalLeadState({
    threadKey,
    // ONLY the fields the promotion resolver owns.
    patch: {
      disposition: "not_interested",
      operational_status: "paused",
      lead_temperature: "cold",
    },
    meta: {
      change_source: "manual",
      change_reason: reason,
      reconciliation: "historical_decline_promotion_28",
    },
    dryRun: !APPLY,
    supabase,
  });
  results.push({ threadKey, ok: res?.ok === true, blocked: res?.blocked === true, reason: res?.reason || null });
}

const ok = results.filter((r) => r.ok).length;
const blocked = results.filter((r) => !r.ok);
console.log(`${APPLY ? "APPLIED" : "DRY RUN"}: ${ok}/${APPROVED_28.length} ok`);
for (const b of blocked) console.log(`  BLOCKED ${b.threadKey}: ${b.reason}`);
