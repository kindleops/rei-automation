-- ════════════════════════════════════════════════════════════════════════════
-- New Replies 7.2 · late replies (answering a seller after a long gap)
-- ════════════════════════════════════════════════════════════════════════════
--
-- WRITTEN, NOT APPLIED. Owner sign-off on the wording first.
--
-- Why: 27 active-deal sellers wrote back in late April / early May 2026 and
-- were never answered (active-unanswered-27 review, 2026-10-01). Answering
-- them five months later with the normal same-day copy reads wrong, so every
-- line here opens by owning the delay. Owner rule: every new response is an
-- sms_templates row (send_queue.template_id = sms_templates.template_id), never
-- copy in code or in the local template registry.
--
-- How they are used: an OPERATOR send from the Inbox (send-now stamps the
-- selected template_id / template_source on the queue row). Nothing selects
-- them automatically:
--   1. every row is inserted is_active = false;
--   2. every row is safe_for_auto_reply = false and reply_mode = 'manual', so
--      no auto-reply / nurture selector (both require safe_for_auto_reply) can
--      pick one even after activation;
--   3. the use cases are new keys (late_reply_*) that no production code reads.
-- Activate after sign-off:
--   update public.sms_templates set is_active = true where template_id like 'lc-late-%';
--
-- Placeholders: {{agent_name}} = the persona that signed the FIRST message on
-- that thread (same name, same number), {{property_address}} = street address.
-- No seller name on purpose (several of these replies go to someone who may
-- not be the person we greeted).
--
-- Idempotent: rows matched by template_id (no unique index on it), so this is
-- UPDATE-then-INSERT-WHERE-NOT-EXISTS, not ON CONFLICT.
-- ════════════════════════════════════════════════════════════════════════════

-- ── PART 1 · PREVIEW (read-only) ────────────────────────────────────────────
with v (template_id, use_case, stage_code, language, template_body, english_translation) as (values
  ('lc-late-identity-en-1',               'late_reply_identity',               'S1', 'English', 'Sorry for the slow reply. I''m {{agent_name}}, a local buyer. I reached out about {{property_address}}. Are you still the owner?', null),
  ('lc-late-identity-en-2',               'late_reply_identity',               'S1', 'English', 'Sorry for the late reply. We haven''t met. I''m {{agent_name}}, a local buyer reaching out about {{property_address}}. Do you still own it?', null),
  ('lc-late-identity-en-3',               'late_reply_identity',               'S1', 'English', 'Sorry for the slow reply. I''m a local buyer and I''m interested in {{property_address}}. Are you still the owner?', null),
  ('lc-late-identity-es-1',               'late_reply_identity',               'S1', 'Spanish', 'Disculpe la demora en responder. Soy {{agent_name}}, un comprador local. Le escribí por {{property_address}}. ¿Sigue siendo el dueño?', 'Sorry for the delay in replying. I''m {{agent_name}}, a local buyer. I wrote to you about {{property_address}}. Are you still the owner?'),
  ('lc-late-identity-es-2',               'late_reply_identity',               'S1', 'Spanish', 'Disculpe la demora. No nos conocemos. Soy {{agent_name}}, un comprador local interesado en {{property_address}}. ¿Sigue siendo el dueño?', 'Sorry for the delay. We haven''t met. I''m {{agent_name}}, a local buyer interested in {{property_address}}. Are you still the owner?'),
  ('lc-late-identity-es-3',               'late_reply_identity',               'S1', 'Spanish', 'Disculpe la demora en responder. Soy un comprador local y me interesa {{property_address}}. ¿Sigue siendo el dueño?', 'Sorry for the delay in replying. I''m a local buyer and I''m interested in {{property_address}}. Are you still the owner?'),
  ('lc-late-owner-offer-en-1',            'late_reply_owner_offer',            'S2', 'English', 'Sorry for the slow reply. I''m a local buyer interested in {{property_address}}. Would you be open to an offer on it?', null),
  ('lc-late-owner-offer-en-2',            'late_reply_owner_offer',            'S2', 'English', 'Sorry for the late reply. I buy property in the area and {{property_address}} caught my eye. Would you consider an offer?', null),
  ('lc-late-owner-offer-es-1',            'late_reply_owner_offer',            'S2', 'Spanish', 'Disculpe la demora en responder. Soy un comprador local interesado en {{property_address}}. ¿Estaría abierto a una oferta?', 'Sorry for the delay in replying. I''m a local buyer interested in {{property_address}}. Would you be open to an offer?'),
  ('lc-late-wrong-language-en-1',         'late_reply_wrong_language',         'S1', 'English', 'Sorry about that, and sorry for the slow reply. I''m {{agent_name}}, a local buyer. Are you still the owner of {{property_address}}?', null),
  ('lc-late-wrong-language-en-2',         'late_reply_wrong_language',         'S1', 'English', 'Sorry for the confusion and the slow reply. I''m {{agent_name}}, a local buyer reaching out about {{property_address}}. Do you still own it?', null),
  ('lc-late-how-got-number-en-1',         'late_reply_how_got_number',         'S1', 'English', 'Sorry for the slow reply. Fair question. Your number came from public records and contact data tied to {{property_address}}. I''m a local buyer. Are you still the owner?', null),
  ('lc-late-how-got-number-es-1',         'late_reply_how_got_number',         'S1', 'Spanish', 'Disculpe la demora. Es una pregunta justa. Su número salió en registros públicos y datos de contacto de {{property_address}}. Soy un comprador local. ¿Sigue siendo el dueño?', 'Sorry for the delay. Fair question. Your number came up in public records and contact data for {{property_address}}. I''m a local buyer. Are you still the owner?'),
  ('lc-late-confirm-ownership-en-1',      'late_reply_confirm_ownership',      'S1', 'English', 'Sorry for the slow reply, and thank you. Are you the owner of {{property_address}}?', null),
  ('lc-late-confirm-ownership-es-1',      'late_reply_confirm_ownership',      'S1', 'Spanish', 'Disculpe la demora, y gracias. ¿Usted es el dueño de {{property_address}}?', 'Sorry for the delay, and thank you. Are you the owner of {{property_address}}?'),
  ('lc-late-listed-other-property-es-1',  'late_reply_listed_other_property',  'S2', 'Spanish', 'Disculpe la demora en responder. Soy {{agent_name}}, un comprador local. Gracias por avisarme que está en el mercado. ¿La otra propiedad que tiene a la venta sigue disponible?', 'Sorry for the delay in replying. I''m {{agent_name}}, a local buyer. Thanks for letting me know it''s on the market. Is the other property you have for sale still available?'),
  ('lc-late-listed-other-property-en-1',  'late_reply_listed_other_property',  'S2', 'English', 'Sorry for the slow reply. I''m {{agent_name}}, a local buyer. Thanks for letting me know it''s listed. Is the other property you have for sale still available?', null)
)
select v.template_id, v.use_case, v.stage_code, v.language, v.template_body,
       exists (select 1 from public.sms_templates t where t.template_id = v.template_id) as already_present,
       (select count(*) from public.sms_templates t where t.use_case = v.use_case) as rows_with_this_use_case
from v
order by v.use_case, v.language, v.template_id;

-- ── PART 2 · UPSERT (owner sign-off required; ends in ROLLBACK) ─────────────
-- Run as one transaction. Change the final ROLLBACK to COMMIT only after the
-- printed counts match PART 1 (17 rows, all inactive).
begin;

create temporary table late_reply_rows on commit drop as
select * from (values
  ('lc-late-identity-en-1',               'late_reply_identity',               'S1', 'English', 'Sorry for the slow reply. I''m {{agent_name}}, a local buyer. I reached out about {{property_address}}. Are you still the owner?', null::text),
  ('lc-late-identity-en-2',               'late_reply_identity',               'S1', 'English', 'Sorry for the late reply. We haven''t met. I''m {{agent_name}}, a local buyer reaching out about {{property_address}}. Do you still own it?', null),
  ('lc-late-identity-en-3',               'late_reply_identity',               'S1', 'English', 'Sorry for the slow reply. I''m a local buyer and I''m interested in {{property_address}}. Are you still the owner?', null),
  ('lc-late-identity-es-1',               'late_reply_identity',               'S1', 'Spanish', 'Disculpe la demora en responder. Soy {{agent_name}}, un comprador local. Le escribí por {{property_address}}. ¿Sigue siendo el dueño?', 'Sorry for the delay in replying. I''m {{agent_name}}, a local buyer. I wrote to you about {{property_address}}. Are you still the owner?'),
  ('lc-late-identity-es-2',               'late_reply_identity',               'S1', 'Spanish', 'Disculpe la demora. No nos conocemos. Soy {{agent_name}}, un comprador local interesado en {{property_address}}. ¿Sigue siendo el dueño?', 'Sorry for the delay. We haven''t met. I''m {{agent_name}}, a local buyer interested in {{property_address}}. Are you still the owner?'),
  ('lc-late-identity-es-3',               'late_reply_identity',               'S1', 'Spanish', 'Disculpe la demora en responder. Soy un comprador local y me interesa {{property_address}}. ¿Sigue siendo el dueño?', 'Sorry for the delay in replying. I''m a local buyer and I''m interested in {{property_address}}. Are you still the owner?'),
  ('lc-late-owner-offer-en-1',            'late_reply_owner_offer',            'S2', 'English', 'Sorry for the slow reply. I''m a local buyer interested in {{property_address}}. Would you be open to an offer on it?', null),
  ('lc-late-owner-offer-en-2',            'late_reply_owner_offer',            'S2', 'English', 'Sorry for the late reply. I buy property in the area and {{property_address}} caught my eye. Would you consider an offer?', null),
  ('lc-late-owner-offer-es-1',            'late_reply_owner_offer',            'S2', 'Spanish', 'Disculpe la demora en responder. Soy un comprador local interesado en {{property_address}}. ¿Estaría abierto a una oferta?', 'Sorry for the delay in replying. I''m a local buyer interested in {{property_address}}. Would you be open to an offer?'),
  ('lc-late-wrong-language-en-1',         'late_reply_wrong_language',         'S1', 'English', 'Sorry about that, and sorry for the slow reply. I''m {{agent_name}}, a local buyer. Are you still the owner of {{property_address}}?', null),
  ('lc-late-wrong-language-en-2',         'late_reply_wrong_language',         'S1', 'English', 'Sorry for the confusion and the slow reply. I''m {{agent_name}}, a local buyer reaching out about {{property_address}}. Do you still own it?', null),
  ('lc-late-how-got-number-en-1',         'late_reply_how_got_number',         'S1', 'English', 'Sorry for the slow reply. Fair question. Your number came from public records and contact data tied to {{property_address}}. I''m a local buyer. Are you still the owner?', null),
  ('lc-late-how-got-number-es-1',         'late_reply_how_got_number',         'S1', 'Spanish', 'Disculpe la demora. Es una pregunta justa. Su número salió en registros públicos y datos de contacto de {{property_address}}. Soy un comprador local. ¿Sigue siendo el dueño?', 'Sorry for the delay. Fair question. Your number came up in public records and contact data for {{property_address}}. I''m a local buyer. Are you still the owner?'),
  ('lc-late-confirm-ownership-en-1',      'late_reply_confirm_ownership',      'S1', 'English', 'Sorry for the slow reply, and thank you. Are you the owner of {{property_address}}?', null),
  ('lc-late-confirm-ownership-es-1',      'late_reply_confirm_ownership',      'S1', 'Spanish', 'Disculpe la demora, y gracias. ¿Usted es el dueño de {{property_address}}?', 'Sorry for the delay, and thank you. Are you the owner of {{property_address}}?'),
  ('lc-late-listed-other-property-es-1',  'late_reply_listed_other_property',  'S2', 'Spanish', 'Disculpe la demora en responder. Soy {{agent_name}}, un comprador local. Gracias por avisarme que está en el mercado. ¿La otra propiedad que tiene a la venta sigue disponible?', 'Sorry for the delay in replying. I''m {{agent_name}}, a local buyer. Thanks for letting me know it''s on the market. Is the other property you have for sale still available?'),
  ('lc-late-listed-other-property-en-1',  'late_reply_listed_other_property',  'S2', 'English', 'Sorry for the slow reply. I''m {{agent_name}}, a local buyer. Thanks for letting me know it''s listed. Is the other property you have for sale still available?', null)
) as r (template_id, use_case, stage_code, language, template_body, english_translation);

-- Existing rows: refresh the wording, never flip is_active from here.
update public.sms_templates t
   set template_body = r.template_body,
       english_translation = coalesce(r.english_translation, r.template_body),
       use_case = r.use_case,
       stage_code = r.stage_code,
       language = r.language,
       updated_at = now()
  from late_reply_rows r
 where t.template_id = r.template_id;

insert into public.sms_templates (
  template_id, use_case, agent_persona, language, template_body, english_translation, variables,
  is_active, version, stage_code, stage_label, property_type_scope, deal_strategy,
  is_first_touch, is_follow_up, metadata, template_name, allowed_property_groups, prohibited_property_groups,
  safe_for_auto_reply, reply_mode, identity_contact_mode, variant_group_key, fallback_rank,
  minimal_fallback, quarantine_state
)
select r.template_id, r.use_case, null, r.language, r.template_body, coalesce(r.english_translation, r.template_body), '[]'::jsonb,
       false, 1, r.stage_code, 'Late Reply', 'Any Residential', null,
       false, false,
       jsonb_build_object(
         'authored_by', 'new_replies_7_2_20261001',
         'source', 'active_unanswered_27_20261001',
         'requires_owner_signoff', true,
         'operator_send_only', true,
         'purpose', 'answer a seller whose reply went unanswered for weeks or months: own the delay, then ask the open question again'
       ),
       null, array['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus'], null,
       false, 'manual', 'neutral', r.stage_code || '|' || r.use_case || '|' || r.language || '|Any Residential', null,
       false, 'active'
  from late_reply_rows r
 where not exists (select 1 from public.sms_templates t where t.template_id = r.template_id);

select count(*) filter (where is_active = false) as inactive_rows,
       count(*) filter (where is_active = true) as active_rows,
       count(*) filter (where safe_for_auto_reply) as auto_reply_safe_rows,
       count(*) as total
  from public.sms_templates
 where template_id like 'lc-late-%';

rollback;
