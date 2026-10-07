// Generates, from seller-conversation-v3-templates.proposed.mjs + every other
// PROPOSED draft + the prod catalog snapshot (read-only fetch, 2026-10-07):
//   supabase/migrations/PROPOSED_20261007030000_seller_conversation_v3_templates.sql (+ _rollback)
//   tmp/conversation-v3/TEMPLATE_MATRIX.csv      every reply the machine needs × 16 languages
//   tmp/conversation-v3/EN_ES_COPY_REVIEW.md     the EN/ES wording list for owner approval
//
//   cd apps/api && node --import ./tests/register-aliases.mjs scripts/ops/seller-conversation-v3-gen-templates.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { V3_LANGS, V3_NEW_USE_CASES, V3_COPY_ALTERNATIVES, proposedV3TemplateRows } from "./seller-conversation-v3-templates.proposed.mjs";
import { draftRows, PROD_SAFE } from "../../tests/helpers/seller-conversation-v3-catalog.mjs";

const ROOT = new URL("../../../../", import.meta.url);
const MIG = new URL("supabase/migrations/", ROOT);
const OUT = new URL("tmp/conversation-v3/", ROOT);
const sq = (s) => (s == null ? "null" : `'${String(s).replace(/'/g, "''")}'`);

// ── 1. the PROPOSED migration ────────────────────────────────────────────────
const rows = proposedV3TemplateRows();
const values = rows
  .map((r) => `  (${[r.use_case, r.template_id, `${r.use_case} — ${r.language} (seller conversation v3)`, r.language, r.template_body, r.english_translation, r.stage_code, r.stage_label].map(sq).join(", ")}, ${r.native_review}, ${sq(r.kind)})`)
  .join(",\n");
const sql = `-- PROPOSED — NOT APPLIED. REQUIRES OWNER APPROVAL OF THE WORDING (tmp/conversation-v3/EN_ES_COPY_REVIEW.md)
-- AND NATIVE REVIEW OF EVERY NON-EN/ES ROW BEFORE ANY ROW IS ACTIVATED.
--
-- SELLER CONVERSATION MACHINE v3 (owner brief 2026-10-06 late): ${rows.length} sms_templates rows,
-- ${Object.keys(V3_NEW_USE_CASES).length} NEW use cases × 16 languages (${rows.filter((r) => r.kind === "new_use_case").length} rows) + ${rows.filter((r) => r.kind === "missing_language").length} rows for EXISTING use cases
-- that had no row at all in a language (ask_condition_clarifier, seller_frustration_apology,
-- not_interested, already_listed, text_only_redirect, future_nurture):
${Object.entries(V3_NEW_USE_CASES).map(([uc, s]) => `--   ${uc}: ${s.fires}`).join("\n")}
--
-- SAFE TO APPLY EARLY: every row is INACTIVE (is_active = false) AND
-- safe_for_auto_reply = false. The auto-reply selector reads only active + safe
-- rows, and only the SELLER_CONVERSATION_V3 layer (env flag, default OFF, on top
-- of SELLER_AUTOPILOT_V2) names these use cases. Nothing can send from this file.
--
-- v3_mf_per_door_anchor uses {{per_door_low}} / {{per_door_high}}, which the
-- renderer does not support yet (render-template.js ALLOWED_TEMPLATE_PLACEHOLDERS):
-- that row fails closed until the renderer + negotiation quote log accept a range.
--
-- Activate per row after approval:
--   update public.sms_templates set is_active = true, safe_for_auto_reply = true, updated_at = now()
--    where template_id in (...approved ids...);
-- Idempotent: inserts only template_ids that do not exist yet.

begin;
set local lock_timeout = '5s';

insert into public.sms_templates (
  use_case, template_id, template_name, language, agent_persona, template_body,
  english_translation, variables, is_active, safe_for_auto_reply, reply_mode,
  identity_contact_mode, property_type_scope, stage_code, stage_label,
  is_first_touch, is_follow_up, fallback_rank, quarantine_state, metadata
)
select v.use_case, v.template_id, v.template_name, v.language, 'Alex', v.template_body,
       v.english_translation, '{}'::jsonb,
       false, false, 'auto',
       'neutral', case when v.use_case = 'v3_mf_per_door_anchor' then 'Multifamily' else 'Residential' end,
       v.stage_code, v.stage_label,
       false, false, 1, 'active',
       jsonb_build_object(
         'authored_by', 'seller_conversation_v3_2026_10_06',
         'approval_status', 'proposed_pending_owner_approval',
         'native_review', v.native_review,
         'proposal_kind', v.kind,
         'flag', 'SELLER_CONVERSATION_V3'
       )
from (values
${values}
) as v(use_case, template_id, template_name, language, template_body, english_translation, stage_code, stage_label, native_review, kind)
where not exists (
  select 1 from public.sms_templates t where t.template_id = v.template_id
);

commit;

-- POSTCHECK (read-only):
--   select use_case, count(*), count(*) filter (where is_active) active, count(*) filter (where safe_for_auto_reply) safe
--     from public.sms_templates where metadata->>'authored_by' = 'seller_conversation_v3_2026_10_06' group by 1 order by 1;
--   -- expect ${rows.length} rows total, 0 active, 0 safe
`;
writeFileSync(new URL("PROPOSED_20261007030000_seller_conversation_v3_templates.sql", MIG), sql);
writeFileSync(
  new URL("PROPOSED_20261007030000_seller_conversation_v3_templates_rollback.sql", MIG),
  `-- ROLLBACK for PROPOSED_20261007030000_seller_conversation_v3_templates.sql
-- Deletes ONLY the rows that migration inserted, and only while they are still
-- inactive (an approved/activated row is never deleted by this rollback).
begin;
set local lock_timeout = '5s';
delete from public.sms_templates
 where metadata->>'authored_by' = 'seller_conversation_v3_2026_10_06'
   and is_active = false;
commit;
`,
);

// ── 2. TEMPLATE_MATRIX.csv ───────────────────────────────────────────────────
// Every reply the machine can name (seller-conversation-v3.js) + the existing
// automatic lanes it defers to, with when it fires.
const NEEDED = [
  ["ownership_check", "S1 first touch (campaign) / ownership question"],
  ["v3_reask_ownership", "S1 unclear reply: re-ask once; mid-thread ownership question; language switch"],
  ["ownership_connection_clarifier", "S1 bare 'No' / 'No I'm not': connected to the property or wrong number? (once)"],
  ["consider_selling", "S2 interest question (after ownership)"],
  ["consider_selling_follow_up", "S2 interest fallback"],
  ["v3_reask_interest", "S2 unclear reply: re-ask once"],
  ["seller_asking_price", "S3 asking price question"],
  ["asking_price_follow_up", "S3 unclear reply WITH a number: re-ask once"],
  ["no_price_condition_probe", "No price / 'make me an offer': 'I can run the numbers — condition?'"],
  ["price_high_condition_probe", "Price near value, or no trusted value: condition question (no number)"],
  ["ask_condition_clarifier", "Condition question fallback; MF condition"],
  ["repair_clarification", "S4 unclear reply: re-ask once"],
  ["v3_update_year_follow_up", "Generic condition answer: kitchen/baths/roof update years (once)"],
  ["v3_below_value_condition_occupancy", "Price below value: condition + occupancy in one question"],
  ["v3_occupancy_check", "Condition known, occupancy missing"],
  ["v3_price_far_above_nurture", "Price far above value / implausible: 'let me know when you're seriously considering an offer' -> nurture"],
  ["price_reality_check", "Legacy implausible-ask reply (superseded by the far-above nurture in v3)"],
  ["v3_numbers_pending", "Checklist complete, no offer-ready number: 'let me run the numbers'"],
  ["as_is_comp_anchor", "Offer path: as-is anchor (MAO-capped, quote-logged)"],
  ["price_anchor_above_max", "Offer path: comps above our max — no comp language"],
  ["v3_mf_per_door_anchor", "Multifamily offer path: per-door range from MF comps"],
  ["mf_confirm_units", "Multifamily: unit count unknown"],
  ["mf_occupancy", "Multifamily occupancy"],
  ["who_is_this", "Who/why at S1/S2 (owner wording: local investor, open to a proposal?)"],
  ["who_is_this_resume_ownership", "Who/why fallback at S1"],
  ["who_is_this_resume_price", "Who/why at S3 (resume the price question)"],
  ["who_is_this_resume_condition", "Who/why at S4 (resume the condition question)"],
  ["info_source_explanation", "Second who/why/how'd-you-get-my-number: county records answer"],
  ["v3_who_is_this_variant", "Second who/why fallback"],
  ["v3_referral_best_contact", "Non-owner / family / manager without a number: who's the best person? (once)"],
  ["already_listed", "Listed / going to market: ack then nurture"],
  ["text_only_redirect", "Call / email requests: texting is easiest"],
  ["capital_gains_creative_probe", "Capital-gains / 1031 objection: creative probe"],
  ["seller_frustration_apology", "Frustration after a misread: apology then nurture"],
  ["not_interested", "Existing lane: not interested -> 30-day nurture (follow-up row)"],
  ["future_nurture", "Existing lane: need time -> nurture ack"],
];
const prodPath = new URL("prod_template_counts.json", OUT);
const prod = existsSync(prodPath) ? JSON.parse(readFileSync(prodPath, "utf8")) : [];
const prodKey = new Map(prod.map((r) => [`${r.use_case}|${r.language}`, r]));
const safeIds = new Map();
for (const r of PROD_SAFE) {
  const k = `${r.use_case}|${r.language}`;
  safeIds.set(k, [...(safeIds.get(k) || []), r.template_id]);
}
const drafts = draftRows();
const draftKey = new Map();
for (const r of drafts) {
  const k = `${r.use_case}|${r.language}`;
  draftKey.set(k, [...(draftKey.get(k) || []), r]);
}
const csv = [["use_case", "when_it_fires", "language", "status", "template_ids", "draft_source", "prod_rows", "prod_active", "prod_active_safe"].join(",")];
const gaps = {};
const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
for (const [uc, when] of NEEDED) {
  for (const [language] of V3_LANGS) {
    const k = `${uc}|${language}`;
    const p = prodKey.get(k);
    const d = draftKey.get(k) || [];
    let status;
    if (p?.active_safe > 0) status = "active_safe";
    else if (d.some((x) => x.source === "PROPOSED_20261007030000")) status = "new_v3_proposed";
    else if (d.length) status = "draft_proposed";
    else if (p?.active > 0) status = "active_not_safe";
    else if (p?.total > 0) status = "inactive_existing";
    else status = "missing";
    gaps[status] = (gaps[status] || 0) + 1;
    const ids = p?.active_safe > 0 ? safeIds.get(k) || [] : d.map((x) => x.template_id);
    csv.push([q(uc), q(when), q(language), status, q(ids.join(" ")), q([...new Set(d.map((x) => x.source))].join(" ")), p?.total ?? 0, p?.active ?? 0, p?.active_safe ?? 0].join(","));
  }
}
writeFileSync(new URL("TEMPLATE_MATRIX.csv", OUT), csv.join("\n") + "\n");

// ── 3. EN_ES_COPY_REVIEW.md ──────────────────────────────────────────────────
const byKey = (uc, lang) =>
  PROD_SAFE.filter((r) => r.use_case === uc && r.language === lang).map((r) => ({ id: r.template_id, body: r.template_body, status: "existing active + safe" }))
    .concat(drafts.filter((r) => r.use_case === uc && r.language === lang).map((r) => ({ id: r.template_id, body: r.template_body, status: r.source === "PROPOSED_20261007030000" ? "NEW (v3, inactive)" : `draft (${r.source}, inactive)` })));
const GROUPS = [
  ["1. Connected-to-property clarifier", "connected_to_property_clarifier", [["ownership_connection_clarifier", "S1, after a bare 'No' / 'No I'm not' to the ownership question. Sent once; the next reply decides (wrong number -> suppress, family/manager -> best-contact ask, entity -> continue, silence/second No -> archive)."]]],
  ["2. Price reality check / far above value", "price_reality_check", [
    ["v3_price_far_above_nurture", "Asking price > 1.5x our value or > value + $100K, or an implausible ask ('1 million', '$5 million'). No condition question; the thread goes to the 30-day nurture."],
    ["price_reality_check", "Legacy round-6 reality check. v3 replaces it with the far-above nurture; kept for reference."],
  ]],
  ["3. Apology / frustration", "apology_frustration", [["seller_frustration_apology", "Seller frustrated after a misread ('Did you read my text?'). One apology, then nurture; never a re-ask."]]],
  ["4. Identity / explanation", "identity_explanation", [
    ["who_is_this", "First who/why/how'd-you-get-my-number at S1/S2. Then the flow resumes."],
    ["info_source_explanation", "Second who/why in the same thread (different text). A third is archived."],
    ["v3_who_is_this_variant", "Second who/why when info_source_explanation has no row in the language."],
    ["who_is_this_resume_price", "Who/why while we are at the price question (resumes it)."],
    ["who_is_this_resume_condition", "Who/why while we are at the condition question (resumes it)."],
  ]],
  ["5. Condition ask", "condition_occupancy", [
    ["price_high_condition_probe", "Price near our value, or no trusted value yet. No number talk."],
    ["ask_condition_clarifier", "Fallback condition question; multifamily condition."],
    ["v3_below_value_condition_occupancy", "Price below our value: condition + occupancy together, then the offer path."],
    ["repair_clarification", "Unclear answer to the condition question (once)."],
  ]],
  ["6. Occupancy ask", null, [["v3_occupancy_check", "Condition known, occupancy missing."]]],
  ["7. No price: 'I can run the numbers'", null, [["no_price_condition_probe", "Seller won't give a price / 'make me an offer' / 'I don't know'."], ["v3_numbers_pending", "All five checklist facts in, no offer-ready engine number yet."]]],
  ["8. Update-year follow-up (kitchen / baths / roof)", null, [["v3_update_year_follow_up", "A generic condition answer ('good shape', 'updated') with no years and no major repairs. Asked once."]]],
  ["9. Multifamily per-door anchor", null, [["v3_mf_per_door_anchor", "Multifamily, checklist complete, >= 3 MF door comps and an authoritative MAO. Range capped at MAO per door. Needs renderer support for the two placeholders before it can send."]]],
  ["10. Re-asks and referral", null, [["v3_reask_ownership", "Unreadable reply to the ownership question (once, then archive)."], ["v3_reask_interest", "Unreadable reply to the proposal question (once, then archive)."], ["v3_referral_best_contact", "Non-owner / family / manager without a phone number (once)."]]],
];
const md = [
  "# Seller Conversation Machine v3 — EN/ES copy review",
  "",
  "Every template the v3 machine can send in English and Spanish, with its template_id, status and when it fires.",
  "Nothing here is active until you approve the wording; every draft / new row is inserted inactive and not safe for auto-reply.",
  "Voice: Alex, a local investor. Short, warm, plain. Pick one line per group, or keep the current one. The alternatives for the five priority groups are not rows yet: the one you pick replaces the draft body before activation.",
  "",
];
for (const [title, altKey, items] of GROUPS) {
  md.push(`## ${title}`, "");
  for (const [uc, when] of items) {
    md.push(`### \`${uc}\``, "", `When it fires: ${when}`, "");
    md.push("| Lang | template_id | Status | Text |", "|---|---|---|---|");
    for (const lang of ["English", "Spanish"]) {
      const list = byKey(uc, lang);
      if (!list.length) md.push(`| ${(lang === "Spanish" ? "ES" : "EN")} | — | **MISSING** | — |`);
      for (const t of list) md.push(`| ${(lang === "Spanish" ? "ES" : "EN")} | \`${t.id}\` | ${t.status} | ${t.body.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
    }
    md.push("");
  }
  if (altKey && V3_COPY_ALTERNATIVES[altKey]) {
    md.push("**Alternatives (pick one, or keep the current text):**", "");
    V3_COPY_ALTERNATIVES[altKey].forEach((alt, i) => {
      md.push(`- Option ${String.fromCharCode(65 + i)} — EN: "${alt.English}"`, `  ES: "${alt.Spanish}"`);
    });
    md.push("");
  }
}
writeFileSync(new URL("EN_ES_COPY_REVIEW.md", OUT), md.join("\n"));
console.log(JSON.stringify({ migration_rows: rows.length, matrix_cells: csv.length - 1, status_counts: gaps }, null, 2));
