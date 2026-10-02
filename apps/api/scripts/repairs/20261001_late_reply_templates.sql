-- ════════════════════════════════════════════════════════════════════════════
-- New Replies 7.2 · late replies (re-engaging a seller months later)
-- ════════════════════════════════════════════════════════════════════════════
--
-- FINAL (owner decision 2026-10-02). Wording: a five-month RE-ENGAGEMENT, never
-- a fake continuation. Short, no apology-heavy opening, no company name, no
-- gendered self-description in Spanish ("un comprador" for Carmen), no
-- odd punctuation, nothing that implies their April/May message arrived today.
-- Owner example (identity): "Hey, this is Alex. I reached out a while back
-- about [address]. Just checking back in. Are you still the owner?" -> written
-- with the persona/address tokens, never a literal name.
--
-- NOT HERE ON PURPOSE:
--   * ownership confirmed + strong not-selling ("lifer"): the EXISTING
--     long-cycle row 1124 (reengagement), never an ownership re-ask;
--   * Vietnamese: no reviewed late-reply row; such threads go to review.
--
-- Every new response is an sms_templates row (send_queue.template_id =
-- sms_templates.template_id). The cleanup executor
-- (new-replies-cleanup-apply.js queueCleanupReply) sends ONLY active rows,
-- through the normal queue and the normal sender engine.
--
-- LIFECYCLE
--   PART 1  preview, read-only (run any time)
--   PART 2  upsert, rows INACTIVE (before or at the deploy; ends in ROLLBACK
--           until the operator changes it to COMMIT)
--   PART 3  activation (IN THE DEPLOY WINDOW, after the new classifier and the
--           New Replies view are live, before the cleanup replies run)
-- Idempotent: matched by template_id (no unique index on it), so
-- UPDATE-then-INSERT-WHERE-NOT-EXISTS. Re-running changes nothing.
-- Every row is safe_for_auto_reply = false and reply_mode = 'manual', so no
-- auto-reply or nurture selector can ever pick one, even when active.
-- ════════════════════════════════════════════════════════════════════════════

-- ── PART 1 · PREVIEW (read-only) ────────────────────────────────────────────
with v (template_id, use_case, stage_code, language, template_body, english_translation) as (values
  ('lc-late-identity-en-1', 'late_reply_identity', 'S1', 'English', 'Hey, this is {{agent_name}}. I reached out a while back about {{property_address}}. Just checking back in. Are you still the owner?', null),
  ('lc-late-identity-en-2', 'late_reply_identity', 'S1', 'English', 'Hey, this is {{agent_name}}, a local buyer. We haven''t met. I reached out a while back about {{property_address}}. Are you still the owner?', null),
  ('lc-late-identity-en-3', 'late_reply_identity', 'S1', 'English', 'Hey, this is {{agent_name}}, a local buyer. I reached out a while back about {{property_address}} because I''m interested in buying it. Are you still the owner?', null),
  ('lc-late-identity-es-1', 'late_reply_identity', 'S1', 'Spanish', 'Hola, soy {{agent_name}}. Le escribí hace un tiempo sobre {{property_address}}. Solo quería volver a preguntarle. ¿Sigue siendo el dueño?', 'Hi, this is {{agent_name}}. I wrote to you a while back about {{property_address}}. I just wanted to ask again. Are you still the owner?'),
  ('lc-late-identity-es-2', 'late_reply_identity', 'S1', 'Spanish', 'Hola, soy {{agent_name}}. No nos conocemos. Compro propiedades en la zona y le escribí hace un tiempo sobre {{property_address}}. ¿Sigue siendo el dueño?', 'Hi, this is {{agent_name}}. We haven''t met. I buy property in the area and wrote to you a while back about {{property_address}}. Are you still the owner?'),
  ('lc-late-identity-es-3', 'late_reply_identity', 'S1', 'Spanish', 'Hola, soy {{agent_name}}. Le escribí hace un tiempo sobre {{property_address}} porque me interesa comprarla. ¿Sigue siendo el dueño?', 'Hi, this is {{agent_name}}. I wrote to you a while back about {{property_address}} because I''m interested in buying it. Are you still the owner?'),
  ('lc-late-owner-offer-en-1', 'late_reply_owner_offer', 'S2', 'English', 'Hey, this is {{agent_name}}. I reached out a while back about {{property_address}}. I''m a local buyer and still interested. Would you be open to an offer?', null),
  ('lc-late-owner-offer-es-1', 'late_reply_owner_offer', 'S2', 'Spanish', 'Hola, soy {{agent_name}}. Le escribí hace un tiempo sobre {{property_address}}. Compro propiedades en la zona y sigo con interés. ¿Estaría abierto a una oferta?', 'Hi, this is {{agent_name}}. I wrote to you a while back about {{property_address}}. I buy property in the area and I am still interested. Would you be open to an offer?'),
  ('lc-late-wrong-language-from-es-en-1', 'late_reply_wrong_language', 'S1', 'English', 'Hey, this is {{agent_name}}. I reached out a while back about {{property_address}} in Spanish. Here it is in English. Are you still the owner?', null),
  ('lc-late-how-got-number-en-1', 'late_reply_how_got_number', 'S1', 'English', 'Hey, this is {{agent_name}}. I reached out a while back about {{property_address}}. Your number came from public property and contact records. Are you still the owner?', null),
  ('lc-late-how-got-number-es-1', 'late_reply_how_got_number', 'S1', 'Spanish', 'Hola, soy {{agent_name}}. Le escribí hace un tiempo sobre {{property_address}}. Su número viene de registros públicos de propiedad y contacto. ¿Sigue siendo el dueño?', 'Hi, this is {{agent_name}}. I wrote to you a while back about {{property_address}}. Your number comes from public property and contact records. Are you still the owner?'),
  ('lc-late-confirm-ownership-en-1', 'late_reply_confirm_ownership', 'S1', 'English', 'Hey, this is {{agent_name}}. I reached out a while back about {{property_address}}. Just to confirm, are you the owner?', null),
  ('lc-late-confirm-ownership-es-1', 'late_reply_confirm_ownership', 'S1', 'Spanish', 'Hola, soy {{agent_name}}. Le escribí hace un tiempo sobre {{property_address}}. Solo para confirmar, ¿usted es el dueño?', 'Hi, this is {{agent_name}}. I wrote to you a while back about {{property_address}}. Just to confirm, are you the owner?'),
  ('lc-late-listed-other-property-es-1', 'late_reply_listed_other_property', 'S2', 'Spanish', 'Hola, soy {{agent_name}}. Le escribí hace un tiempo sobre {{property_address}}. Me comentó que tiene otra propiedad a la venta. ¿Sigue disponible?', 'Hi, this is {{agent_name}}. I wrote to you a while back about {{property_address}}. You mentioned you have another property for sale. Is it still available?'),
  ('lc-late-listed-other-property-en-1', 'late_reply_listed_other_property', 'S2', 'English', 'Hey, this is {{agent_name}}. I reached out a while back about {{property_address}}. You mentioned another property for sale. Is it still available?', null)
)
select v.template_id, v.use_case, v.stage_code, v.language, v.template_body,
       exists (select 1 from public.sms_templates t where t.template_id = v.template_id) as already_present,
       (select count(*) from public.sms_templates t where t.use_case = v.use_case) as rows_with_this_use_case
from v
order by v.use_case, v.language, v.template_id;

-- ── PART 2 · UPSERT, INACTIVE (ends in ROLLBACK; change to COMMIT to keep) ──
begin;

create temporary table late_reply_rows on commit drop as
select * from (values
  ('lc-late-identity-en-1', 'late_reply_identity', 'S1', 'English', 'Hey, this is {{agent_name}}. I reached out a while back about {{property_address}}. Just checking back in. Are you still the owner?', null::text),
  ('lc-late-identity-en-2', 'late_reply_identity', 'S1', 'English', 'Hey, this is {{agent_name}}, a local buyer. We haven''t met. I reached out a while back about {{property_address}}. Are you still the owner?', null),
  ('lc-late-identity-en-3', 'late_reply_identity', 'S1', 'English', 'Hey, this is {{agent_name}}, a local buyer. I reached out a while back about {{property_address}} because I''m interested in buying it. Are you still the owner?', null),
  ('lc-late-identity-es-1', 'late_reply_identity', 'S1', 'Spanish', 'Hola, soy {{agent_name}}. Le escribí hace un tiempo sobre {{property_address}}. Solo quería volver a preguntarle. ¿Sigue siendo el dueño?', 'Hi, this is {{agent_name}}. I wrote to you a while back about {{property_address}}. I just wanted to ask again. Are you still the owner?'),
  ('lc-late-identity-es-2', 'late_reply_identity', 'S1', 'Spanish', 'Hola, soy {{agent_name}}. No nos conocemos. Compro propiedades en la zona y le escribí hace un tiempo sobre {{property_address}}. ¿Sigue siendo el dueño?', 'Hi, this is {{agent_name}}. We haven''t met. I buy property in the area and wrote to you a while back about {{property_address}}. Are you still the owner?'),
  ('lc-late-identity-es-3', 'late_reply_identity', 'S1', 'Spanish', 'Hola, soy {{agent_name}}. Le escribí hace un tiempo sobre {{property_address}} porque me interesa comprarla. ¿Sigue siendo el dueño?', 'Hi, this is {{agent_name}}. I wrote to you a while back about {{property_address}} because I''m interested in buying it. Are you still the owner?'),
  ('lc-late-owner-offer-en-1', 'late_reply_owner_offer', 'S2', 'English', 'Hey, this is {{agent_name}}. I reached out a while back about {{property_address}}. I''m a local buyer and still interested. Would you be open to an offer?', null),
  ('lc-late-owner-offer-es-1', 'late_reply_owner_offer', 'S2', 'Spanish', 'Hola, soy {{agent_name}}. Le escribí hace un tiempo sobre {{property_address}}. Compro propiedades en la zona y sigo con interés. ¿Estaría abierto a una oferta?', 'Hi, this is {{agent_name}}. I wrote to you a while back about {{property_address}}. I buy property in the area and I am still interested. Would you be open to an offer?'),
  ('lc-late-wrong-language-from-es-en-1', 'late_reply_wrong_language', 'S1', 'English', 'Hey, this is {{agent_name}}. I reached out a while back about {{property_address}} in Spanish. Here it is in English. Are you still the owner?', null),
  ('lc-late-how-got-number-en-1', 'late_reply_how_got_number', 'S1', 'English', 'Hey, this is {{agent_name}}. I reached out a while back about {{property_address}}. Your number came from public property and contact records. Are you still the owner?', null),
  ('lc-late-how-got-number-es-1', 'late_reply_how_got_number', 'S1', 'Spanish', 'Hola, soy {{agent_name}}. Le escribí hace un tiempo sobre {{property_address}}. Su número viene de registros públicos de propiedad y contacto. ¿Sigue siendo el dueño?', 'Hi, this is {{agent_name}}. I wrote to you a while back about {{property_address}}. Your number comes from public property and contact records. Are you still the owner?'),
  ('lc-late-confirm-ownership-en-1', 'late_reply_confirm_ownership', 'S1', 'English', 'Hey, this is {{agent_name}}. I reached out a while back about {{property_address}}. Just to confirm, are you the owner?', null),
  ('lc-late-confirm-ownership-es-1', 'late_reply_confirm_ownership', 'S1', 'Spanish', 'Hola, soy {{agent_name}}. Le escribí hace un tiempo sobre {{property_address}}. Solo para confirmar, ¿usted es el dueño?', 'Hi, this is {{agent_name}}. I wrote to you a while back about {{property_address}}. Just to confirm, are you the owner?'),
  ('lc-late-listed-other-property-es-1', 'late_reply_listed_other_property', 'S2', 'Spanish', 'Hola, soy {{agent_name}}. Le escribí hace un tiempo sobre {{property_address}}. Me comentó que tiene otra propiedad a la venta. ¿Sigue disponible?', 'Hi, this is {{agent_name}}. I wrote to you a while back about {{property_address}}. You mentioned you have another property for sale. Is it still available?'),
  ('lc-late-listed-other-property-en-1', 'late_reply_listed_other_property', 'S2', 'English', 'Hey, this is {{agent_name}}. I reached out a while back about {{property_address}}. You mentioned another property for sale. Is it still available?', null)
) as r (template_id, use_case, stage_code, language, template_body, english_translation);

-- Existing rows: refresh the wording only; never flip is_active here.
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
  safe_for_auto_reply, reply_mode, identity_contact_mode, fallback_rank,
  minimal_fallback, quarantine_state
)
select r.template_id, r.use_case, null, r.language, r.template_body, coalesce(r.english_translation, r.template_body), '[]'::jsonb,
       false, 1, r.stage_code, 'Late Reply', 'Any Residential', null,
       false, false,
       jsonb_build_object(
         'authored_by', 'new_replies_7_2_20261001',
         'source', 'classifier_cleanup_20261001',
         'owner_approved', '2026-10-02',
         'style', 'five-month re-engagement, never a fake continuation',
         'operator_or_cleanup_send_only', true
       ),
       null, array['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus'], null,
       false, 'manual', 'neutral', null,
       false, 'active'
  from late_reply_rows r
 where not exists (select 1 from public.sms_templates t where t.template_id = r.template_id);

select count(*) filter (where is_active = false) as inactive_rows,
       count(*) filter (where is_active = true) as active_rows,
       count(*) filter (where safe_for_auto_reply) as auto_reply_safe_rows,
       count(*) as total  -- expect 15
  from public.sms_templates
 where template_id like 'lc-late-%';

rollback;

-- ── PART 3 · ACTIVATE (DEPLOY WINDOW ONLY) ──────────────────────────────────
-- Run after: classifier live, view 20261001160000 live, P7, canaries, nurture.
-- begin;
-- update public.sms_templates
--    set is_active = true, updated_at = now()
--  where template_id like 'lc-late-%' and is_active = false;
-- select count(*) as active_late_rows from public.sms_templates where template_id like 'lc-late-%' and is_active;  -- expect 15
-- commit;

-- ── PART 4 · LOCKED COPY FOR THE 16 RE-QUEUED REPLIES (owner, 2026-10-02) ───
-- The runner paused the 16 replies (rc-7.1); every body above also opens
-- "Hey," / "Hola,", which the send-time blank-greeting guard refuses
-- (process-send-queue + providers/textgrid). The owner locked ONE English and
-- ONE Spanish body for all 16 (English threads and wrong-language-from-Spanish
-- threads get English). New template_ids, so the 16 rows are attributable to
-- this copy and the PART 1/2 rows keep their own history; the requeue maps
-- them (late-reply-locked-copy.js) and keeps metadata.plan_template_id.
-- {{agent_name}} = persona ({{sender}}), {{property_address}} = property
-- ({{address}}). No first-name token.
-- Idempotent: UPDATE-then-INSERT-WHERE-NOT-EXISTS by template_id, then
-- activate. Re-running changes nothing. Ends in ROLLBACK: the lead changes it
-- to COMMIT with the owner present.
begin;

create temporary table late_reply_locked_rows on commit drop as
select * from (values
  ('lc-late-checkin-en-1', 'late_reply_checkin', 'S1', 'English', 'This is {{agent_name}}. I reached out a while back about {{property_address}}. Just checking back in. Are you still the owner?', null::text),
  ('lc-late-checkin-es-1', 'late_reply_checkin', 'S1', 'Spanish', 'Soy {{agent_name}}. Me comuniqué hace un tiempo por {{property_address}}. Solo quería saber si todavía eres el propietario.', 'This is {{agent_name}}. I reached out a while back about {{property_address}}. I just wanted to know if you are still the owner.')
) as r (template_id, use_case, stage_code, language, template_body, english_translation);

update public.sms_templates t
   set template_body = r.template_body,
       english_translation = coalesce(r.english_translation, r.template_body),
       use_case = r.use_case,
       stage_code = r.stage_code,
       language = r.language,
       updated_at = now()
  from late_reply_locked_rows r
 where t.template_id = r.template_id
   and (t.template_body is distinct from r.template_body
        or t.english_translation is distinct from coalesce(r.english_translation, r.template_body)
        or t.use_case is distinct from r.use_case
        or t.stage_code is distinct from r.stage_code
        or t.language is distinct from r.language);

insert into public.sms_templates (
  template_id, use_case, agent_persona, language, template_body, english_translation, variables,
  is_active, version, stage_code, stage_label, property_type_scope, deal_strategy,
  is_first_touch, is_follow_up, metadata, template_name, allowed_property_groups, prohibited_property_groups,
  safe_for_auto_reply, reply_mode, identity_contact_mode, fallback_rank,
  minimal_fallback, quarantine_state
)
select r.template_id, r.use_case, null, r.language, r.template_body, coalesce(r.english_translation, r.template_body), '[]'::jsonb,
       false, 1, r.stage_code, 'Late Reply', 'Any Residential', null,
       false, false,
       jsonb_build_object(
         'authored_by', 'rc71_replies_requeue',
         'source', 'classifier_cleanup_20261001',
         'owner_approved', '2026-10-02',
         'owner_locked_copy', true,
         'style', 'one locked re-engagement body per language for the 16 late replies',
         'operator_or_cleanup_send_only', true
       ),
       null, array['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus'], null,
       false, 'manual', 'neutral', null,
       false, 'active'
  from late_reply_locked_rows r
 where not exists (select 1 from public.sms_templates t where t.template_id = r.template_id);

update public.sms_templates
   set is_active = true, updated_at = now()
 where template_id in ('lc-late-checkin-en-1', 'lc-late-checkin-es-1') and is_active is distinct from true;

select template_id, language, is_active, safe_for_auto_reply, reply_mode, template_body
  from public.sms_templates
 where template_id in ('lc-late-checkin-en-1', 'lc-late-checkin-es-1')
 order by template_id;  -- expect 2 rows, both active, safe_for_auto_reply = false

rollback;  -- change to COMMIT to keep (lead, owner present)
