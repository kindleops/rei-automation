-- ════════════════════════════════════════════════════════════════════════════
-- New Replies 7.2 · emoji confirmation questions as sms_templates rows
-- ════════════════════════════════════════════════════════════════════════════
--
-- WRITTEN, NOT APPLIED. The lead applies this after the owner signs off on the
-- wording. Every new response must be an sms_templates row so War Room /
-- Analytics can attribute the send (send_queue.template_id =
-- sms_templates.template_id); none of this copy lives in code or in the local
-- template registry.
--
-- Selected by the 7.2 path: an emoji-only LIKELY yes / LIKELY no to a known
-- question (classify.js automation_decision.reply_kind = 'clarification')
-- -> apply-inbound-automation-decision.js resolveSafeFallbackClarifierDispatch
-- -> required_template_use_case = one of the three use cases below
-- -> selectSafeAutoReplyTemplate reads sms_templates (is_active,
--    safe_for_auto_reply, language) and stamps the row's template_id.
-- A language with no row fails closed to Needs Review (no free text, no
-- local-registry fallback). The stage never moves on a clarification.
--
-- SAFE BEFORE DEPLOY, twice over:
--   1. every row is inserted is_active = false;
--   2. the use cases are new keys (emoji_confirm_*) that no production code
--      selects today.
-- Activating = `update sms_templates set is_active = true where template_id
-- like 'lc-emoji-confirm-%'` after the code is live.
--
-- Idempotent: rows are matched by template_id (sms_templates has no unique
-- index on it, so this is UPDATE-then-INSERT-WHERE-NOT-EXISTS, not ON CONFLICT).
-- ════════════════════════════════════════════════════════════════════════════

-- ── PART 1 · PREVIEW (read-only) ────────────────────────────────────────────
with v (template_id, use_case, stage_code, language, template_body, english_translation, owner_base) as (values
  ('lc-emoji-confirm-ownership-en-1',      'emoji_confirm_ownership',      'S1', 'English', 'Thanks for the response. Just to confirm, you''re the owner, correct?', null, true),
  ('lc-emoji-confirm-ownership-en-2',      'emoji_confirm_ownership',      'S1', 'English', 'Thanks for getting back to me. You''re the owner of the property, right?', null, false),
  ('lc-emoji-confirm-ownership-en-3',      'emoji_confirm_ownership',      'S1', 'English', 'Appreciate it. Do you still own the property?', null, false),
  ('lc-emoji-confirm-offer-interest-en-1', 'emoji_confirm_offer_interest', 'S2', 'English', 'Thanks. Just to confirm, you''d be open to hearing an offer?', null, true),
  ('lc-emoji-confirm-offer-interest-en-2', 'emoji_confirm_offer_interest', 'S2', 'English', 'Great, thanks. So you''d be open to hearing an offer on the property?', null, false),
  ('lc-emoji-confirm-offer-interest-en-3', 'emoji_confirm_offer_interest', 'S2', 'English', 'Appreciate it. Would you be open to hearing an offer on it?', null, false),
  ('lc-emoji-confirm-not-interested-en-1', 'emoji_confirm_not_interested', 'S2', 'English', 'No problem. Just to confirm, you''re not interested in an offer right now?', null, true),
  ('lc-emoji-confirm-not-interested-en-2', 'emoji_confirm_not_interested', 'S2', 'English', 'Understood. So you''d rather not hear an offer right now, correct?', null, false),
  ('lc-emoji-confirm-not-interested-en-3', 'emoji_confirm_not_interested', 'S2', 'English', 'No worries. You''re not looking to sell right now, is that right?', null, false),
  ('lc-emoji-confirm-ownership-es-1',      'emoji_confirm_ownership',      'S1', 'Spanish', 'Gracias por responder. Solo para confirmar, ¿usted es el dueño de la propiedad?', 'Thanks for responding. Just to confirm, are you the owner of the property?', true),
  ('lc-emoji-confirm-offer-interest-es-1', 'emoji_confirm_offer_interest', 'S2', 'Spanish', 'Gracias. Solo para confirmar, ¿estaría abierto a escuchar una oferta?', 'Thanks. Just to confirm, would you be open to hearing an offer?', true),
  ('lc-emoji-confirm-not-interested-es-1', 'emoji_confirm_not_interested', 'S2', 'Spanish', 'No hay problema. Solo para confirmar, ¿no le interesa una oferta por ahora?', 'No problem. Just to confirm, you are not interested in an offer for now?', true)
)
select v.template_id, v.use_case, v.stage_code, v.language, v.template_body,
       exists (select 1 from public.sms_templates t where t.template_id = v.template_id) as already_present,
       (select count(*) from public.sms_templates t where t.use_case = v.use_case) as rows_with_this_use_case
from v
order by v.use_case, v.language, v.template_id;

-- ── PART 2 · UPSERT (owner sign-off required; ends in ROLLBACK) ─────────────
-- Run as one transaction. Change the final ROLLBACK to COMMIT only after the
-- printed counts match PART 1.
begin;

create temporary table emoji_confirm_rows on commit drop as
select * from (values
  ('lc-emoji-confirm-ownership-en-1',      'emoji_confirm_ownership',      'S1', 'English', 'Thanks for the response. Just to confirm, you''re the owner, correct?', null::text, true),
  ('lc-emoji-confirm-ownership-en-2',      'emoji_confirm_ownership',      'S1', 'English', 'Thanks for getting back to me. You''re the owner of the property, right?', null, false),
  ('lc-emoji-confirm-ownership-en-3',      'emoji_confirm_ownership',      'S1', 'English', 'Appreciate it. Do you still own the property?', null, false),
  ('lc-emoji-confirm-offer-interest-en-1', 'emoji_confirm_offer_interest', 'S2', 'English', 'Thanks. Just to confirm, you''d be open to hearing an offer?', null, true),
  ('lc-emoji-confirm-offer-interest-en-2', 'emoji_confirm_offer_interest', 'S2', 'English', 'Great, thanks. So you''d be open to hearing an offer on the property?', null, false),
  ('lc-emoji-confirm-offer-interest-en-3', 'emoji_confirm_offer_interest', 'S2', 'English', 'Appreciate it. Would you be open to hearing an offer on it?', null, false),
  ('lc-emoji-confirm-not-interested-en-1', 'emoji_confirm_not_interested', 'S2', 'English', 'No problem. Just to confirm, you''re not interested in an offer right now?', null, true),
  ('lc-emoji-confirm-not-interested-en-2', 'emoji_confirm_not_interested', 'S2', 'English', 'Understood. So you''d rather not hear an offer right now, correct?', null, false),
  ('lc-emoji-confirm-not-interested-en-3', 'emoji_confirm_not_interested', 'S2', 'English', 'No worries. You''re not looking to sell right now, is that right?', null, false),
  ('lc-emoji-confirm-ownership-es-1',      'emoji_confirm_ownership',      'S1', 'Spanish', 'Gracias por responder. Solo para confirmar, ¿usted es el dueño de la propiedad?', 'Thanks for responding. Just to confirm, are you the owner of the property?', true),
  ('lc-emoji-confirm-offer-interest-es-1', 'emoji_confirm_offer_interest', 'S2', 'Spanish', 'Gracias. Solo para confirmar, ¿estaría abierto a escuchar una oferta?', 'Thanks. Just to confirm, would you be open to hearing an offer?', true),
  ('lc-emoji-confirm-not-interested-es-1', 'emoji_confirm_not_interested', 'S2', 'Spanish', 'No hay problema. Solo para confirmar, ¿no le interesa una oferta por ahora?', 'No problem. Just to confirm, you are not interested in an offer for now?', true)
) as r (template_id, use_case, stage_code, language, template_body, english_translation, owner_base);

-- Existing rows: refresh the wording, never flip is_active from here.
update public.sms_templates t
   set template_body = r.template_body,
       english_translation = coalesce(r.english_translation, r.template_body),
       use_case = r.use_case,
       stage_code = r.stage_code,
       language = r.language,
       updated_at = now()
  from emoji_confirm_rows r
 where t.template_id = r.template_id;

insert into public.sms_templates (
  template_id, use_case, agent_persona, language, template_body, english_translation, variables,
  is_active, version, stage_code, stage_label, property_type_scope, deal_strategy,
  is_first_touch, is_follow_up, metadata, template_name, allowed_property_groups, prohibited_property_groups,
  safe_for_auto_reply, reply_mode, identity_contact_mode, fallback_rank,
  minimal_fallback, quarantine_state
)
select r.template_id, r.use_case, null, r.language, r.template_body, coalesce(r.english_translation, r.template_body), '[]'::jsonb,
       false, 1, r.stage_code, 'Emoji Confirmation', 'Any Residential', null,
       false, false,
       jsonb_build_object(
         'authored_by', 'new_replies_7_2_20261001',
         'source', 'classifier_cleanup_20261001',
         'owner_base_copy', r.owner_base,
         'requires_owner_signoff', true,
         'purpose', 'one confirmation question after an emoji-only likely answer; same stage, never a fact'
       ),
       null, array['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus'], null,
       true, 'auto', 'neutral', null,
       false, 'active'
  from emoji_confirm_rows r
 where not exists (select 1 from public.sms_templates t where t.template_id = r.template_id);

select count(*) filter (where is_active = false) as inactive_rows,
       count(*) filter (where is_active = true) as active_rows,
       count(*) as total
  from public.sms_templates
 where template_id like 'lc-emoji-confirm-%';

rollback;
