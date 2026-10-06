// Regenerates supabase/migrations/PROPOSED_20261006090000_seller_autopilot_v2_templates{,_rollback}.sql
// and the owner approval list from seller-autopilot-v2-templates.proposed.mjs. No DB access.
import { writeFileSync } from "node:fs";
import { proposedTemplateRows, NATIVE_REVIEW_LANGUAGES } from "./seller-autopilot-v2-templates.proposed.mjs";
const q = (s) => (s == null ? "null" : `'${String(s).replace(/'/g, "''")}'`);
const rows = proposedTemplateRows();
const gsm = /^[A-Za-z0-9 @£$¥èéùìòÇØøÅå_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\n\r{}\\\[\]~^|€]*$/;
const values = rows.map((r) => `  (${[q(r.use_case), q(r.template_id), q(`${r.use_case} — ${r.language} (seller autopilot v2)`), q(r.language), q(r.template_body), q(r.english_translation), q(r.stage_code), q(r.stage_label), q(r.kind), r.native_review ? "true" : "false"].join(", ")})`).join(",\n");
const header = `-- PROPOSED — NOT APPLIED. REQUIRES OWNER APPROVAL OF THE WORDING BEFORE APPLY.
--
-- Seller Autopilot S1–S4 v2 (owner brief 2026-10-06): ${rows.length} sms_templates rows.
--   * 7 NEW use cases × 16 languages: no_price_condition_probe, as_is_comp_anchor,
--     as_is_offer_anchor (MAO-capped, makes no comp claim), capital_gains_creative_probe,
--     who_is_this_resume_ownership / _price / _condition.
--   * existing use cases with NO usable row in a language: price_works_confirm_basics (7),
--     price_high_condition_probe (7), who_is_this (14 — the 7 existing non-EN/ES rows are
--     statement-only, {{property_address}}-dependent, manual, and mistranslated).
--
-- SAFE TO APPLY EARLY: every row is INACTIVE (is_active = false) AND
-- safe_for_auto_reply = false. The auto-reply selector reads only
-- is_active AND safe_for_auto_reply rows, and only the SELLER_AUTOPILOT_V2
-- layer (env flag, default OFF) names these use cases. Nothing can send from
-- this migration alone.
--
-- After the owner approves wording (and a native speaker reviews rows flagged
-- metadata.native_review = true), activate per row:
--   update public.sms_templates set is_active = true, safe_for_auto_reply = true, updated_at = now()
--    where template_id in (...approved ids...);
--
-- {{offer_price}} is the only placeholder. It renders ONLY from the
-- authoritative, MAO-capped v2 amount (resolveAuthorizedOfferAmount re-checks
-- the ceiling) and the anchor rows are persisted as the active offer version
-- before the send (MONETARY_OFFER_USE_CASES).
--
-- Idempotent: inserts only template_ids that do not exist yet (sms_templates
-- has no unique constraint on template_id, so ON CONFLICT cannot be used).

begin;
set local lock_timeout = '5s';

insert into public.sms_templates (
  use_case, template_id, template_name, language, agent_persona, template_body,
  english_translation, variables, is_active, safe_for_auto_reply, reply_mode,
  identity_contact_mode, property_type_scope, stage_code, stage_label,
  is_first_touch, is_follow_up, fallback_rank, quarantine_state, metadata
)
select v.use_case, v.template_id, v.template_name, v.language, 'Alex', v.template_body,
       v.english_translation,
       case when v.template_body like '%{{offer_price}}%' then '{"offer_price": "authorized_offer"}'::jsonb else '{}'::jsonb end,
       false, false, 'auto',
       'neutral', 'Residential', v.stage_code, v.stage_label,
       false, false, 1, 'active',
       jsonb_build_object(
         'authored_by', 'seller_autopilot_v2_2026_10_06',
         'approval_status', 'proposed_pending_owner_approval',
         'proposal_kind', v.kind,
         'native_review', v.native_review,
         'flag', 'SELLER_AUTOPILOT_V2'
       )
from (values
${values}
) as v(use_case, template_id, template_name, language, template_body, english_translation, stage_code, stage_label, kind, native_review)
where not exists (
  select 1 from public.sms_templates t where t.template_id = v.template_id
);

commit;

-- POSTCHECK (read-only):
--   select use_case, count(*), count(*) filter (where is_active) active, count(*) filter (where safe_for_auto_reply) safe
--     from public.sms_templates where metadata->>'authored_by' = 'seller_autopilot_v2_2026_10_06' group by 1 order by 1;
--   -- expect ${rows.length} rows total, 0 active, 0 safe
`;
const base = "/Users/ryankindle/rei-automation/supabase/migrations/PROPOSED_20261006090000_seller_autopilot_v2_templates";
writeFileSync(`${base}.sql`, header);
writeFileSync(`${base}_rollback.sql`, `-- ROLLBACK for PROPOSED_20261006090000_seller_autopilot_v2_templates.sql
-- Deletes ONLY the rows that migration inserted, and only while they are still
-- inactive (an approved/activated row is never deleted by this rollback).
begin;
set local lock_timeout = '5s';
delete from public.sms_templates
 where metadata->>'authored_by' = 'seller_autopilot_v2_2026_10_06'
   and is_active = false;
commit;
`);
// approval list
const lines = ["template_id\tuse_case\tlanguage\tchars\tencoding\tnative_review\tkind\tbody\tenglish"];
for (const r of rows) {
  const enc = gsm.test(r.template_body) ? "GSM-7" : "UCS-2";
  lines.push([r.template_id, r.use_case, r.language, [...r.template_body].length, enc, r.native_review ? "YES" : "", r.kind, r.template_body, r.english_translation || ""].join("\t"));
}
writeFileSync("/Users/ryankindle/.claude/jobs/c39b0175/tmp/autopilot-v2/TEMPLATES_FOR_APPROVAL.tsv", lines.join("\n") + "\n");
console.log(rows.length, "rows;", rows.filter((r) => r.native_review).length, "native review");
