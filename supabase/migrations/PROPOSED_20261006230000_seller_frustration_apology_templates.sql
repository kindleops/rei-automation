-- PROPOSED — NOT APPLIED. REQUIRES OWNER APPROVAL OF THE WORDING BEFORE APPLY.
--
-- use_case = 'seller_frustration_apology': the ONE reply to "Did you read my
-- text?" / "I already told you" / "Ya te dije" after we misread a decline
-- (+18137277602, 2026-10-06: "Yes, and nothing's for sale." got the interest
-- probe). Apology + nurture; it never re-asks.
--
-- Rows are INACTIVE and NOT safe_for_auto_reply; until activated the turn goes
-- to review. To activate after approval:
--   update public.sms_templates set is_active = true, safe_for_auto_reply = true, updated_at = now()
--    where use_case = 'seller_frustration_apology'
--      and template_id in ('lc-seller-frustration-apology-en-1','lc-seller-frustration-apology-es-1');
-- No greeting with a comma (dispatcher blank-greeting guard). No placeholders.
-- Idempotent insert by template_id.

begin;
set local lock_timeout = '5s';

insert into public.sms_templates (
  use_case, template_id, template_name, language, agent_persona, template_body,
  english_translation, variables, is_active, safe_for_auto_reply, reply_mode,
  identity_contact_mode, property_type_scope, stage_code, stage_label,
  is_first_touch, is_follow_up, fallback_rank, quarantine_state, metadata
)
select 'seller_frustration_apology', v.template_id, v.template_name, v.language, 'Alex', v.template_body,
       v.english_translation, '{}'::jsonb, false, false, 'auto_reply',
       'neutral', 'Any Residential', null, 'Frustration Apology',
       false, false, 1, 'active',
       jsonb_build_object(
         'authored_by', 'reply_quality_round7_2026_10_06',
         'approval_status', 'proposed_pending_owner_approval',
         'trigger_rule', 'seller_frustration_after_misread'
       )
from (values
  ('lc-seller-frustration-apology-en-1', 'Frustration apology (EN)', 'English',
   'Sorry about that, I''ll note it. Thanks for letting me know.', null),
  ('lc-seller-frustration-apology-es-1', 'Frustration apology (ES)', 'Spanish',
   'Disculpe, lo anoto. Gracias por avisarme.', 'Sorry about that, I''ll note it. Thanks for letting me know.')
) as v(template_id, template_name, language, template_body, english_translation)
where not exists (select 1 from public.sms_templates t where t.template_id = v.template_id);

commit;
