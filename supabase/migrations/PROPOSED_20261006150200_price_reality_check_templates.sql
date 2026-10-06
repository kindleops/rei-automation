-- PROPOSED — NOT APPLIED. REQUIRES OWNER APPROVAL OF THE WORDING BEFORE APPLY.
--
-- use_case = 'price_reality_check': the ONE light reply to an implausible ask
-- (classification intent asking_price_implausible, price-plausibility.js), e.g.
-- "1 million dollars" on a $182K house (+17276319579, 2026-10-06). It keeps the
-- door open without treating the number as a real ask.
--
-- SAFE TO APPLY EARLY: every row is INACTIVE and NOT safe_for_auto_reply, so
-- nothing sends from this migration alone. Until a row is activated, an
-- implausible ask routes to human review (no_safe_template) -- never to the
-- condition probe and never silence. After the owner approves the wording:
--
--   update public.sms_templates
--      set is_active = true, safe_for_auto_reply = true, updated_at = now()
--    where use_case = 'price_reality_check'
--      and template_id in ('lc-price-reality-check-en-1','lc-price-reality-check-en-2',
--                          'lc-price-reality-check-es-1','lc-price-reality-check-es-2');
--
-- The other languages are drafted in the catalog's romanised style and carry
-- metadata.needs_native_review = true (owner rule: no non-EN/ES copy goes live
-- without native review). Two EN/ES variants exist so the repeat-intent guard
-- has a rephrase for a seller who repeats the joke.
--
-- COPY RULES: no "Hey,"/"Hola," greeting with a comma (dispatcher blank-greeting
-- guard); <= 160 GSM-7 for English. Variant 2 uses {{property_address}}; the
-- reply path hydrates it and falls back to variant 1 when it is missing.
-- Idempotent insert by template_id (no unique constraint on template_id).

begin;
set local lock_timeout = '5s';

insert into public.sms_templates (
  use_case, template_id, template_name, language, agent_persona, template_body,
  english_translation, variables, is_active, safe_for_auto_reply, reply_mode,
  identity_contact_mode, property_type_scope, stage_code, stage_label,
  is_first_touch, is_follow_up, fallback_rank, quarantine_state, metadata
)
select 'price_reality_check', v.template_id, v.template_name, v.language, 'Alex', v.template_body,
       v.english_translation, '{}'::jsonb, false, false, 'auto_reply',
       'neutral', 'Any Residential', null, 'Price Reality Check',
       false, false, v.fallback_rank, 'active',
       jsonb_build_object(
         'authored_by', 'implausible_price_2026_10_06',
         'approval_status', 'proposed_pending_owner_approval',
         'needs_native_review', v.language not in ('English', 'Spanish'),
         'trigger_intent', 'asking_price_implausible'
       )
from (values
  ('lc-price-reality-check-en-1', 'Price reality check 1 (EN)', 'English', 1,
   'Ha, I wish! Realistically, if the number made sense, is selling something you''d consider?', null),
  ('lc-price-reality-check-en-2', 'Price reality check 2 (EN)', 'English', 2,
   'Fair enough! If we could land on a realistic number for {{property_address}}, would you be open to selling?', null),
  ('lc-price-reality-check-es-1', 'Price reality check 1 (ES)', 'Spanish', 1,
   '¡Ja, ojalá! Siendo realistas, si el número tuviera sentido, ¿consideraría vender?',
   'Ha, I wish! Realistically, if the number made sense, would you consider selling?'),
  ('lc-price-reality-check-es-2', 'Price reality check 2 (ES)', 'Spanish', 2,
   '¡Entiendo! Si llegáramos a un número realista por {{property_address}}, ¿estaría abierto a vender?',
   'Understood! If we could reach a realistic number for {{property_address}}, would you be open to selling?'),
  ('lc-price-reality-check-pt-1', 'Price reality check 1 (PT)', 'Portuguese', 1,
   'Haha, quem dera! Falando serio, se o numero fizesse sentido, voce consideraria vender?', 'Ha, I wish! Seriously, if the number made sense, would you consider selling?'),
  ('lc-price-reality-check-it-1', 'Price reality check 1 (IT)', 'Italian', 1,
   'Ah, magari! Realisticamente, se il numero avesse senso, considereresti di vendere?', 'Ha, I wish! Realistically, if the number made sense, would you consider selling?'),
  ('lc-price-reality-check-fr-1', 'Price reality check 1 (FR)', 'French', 1,
   'Ha, si seulement! Plus serieusement, si le chiffre etait raisonnable, envisageriez-vous de vendre?', 'Ha, if only! More seriously, if the number were reasonable, would you consider selling?'),
  ('lc-price-reality-check-de-1', 'Price reality check 1 (DE)', 'German', 1,
   'Haha, schoen waere es! Realistisch gesehen: wenn die Zahl passt, wuerden Sie einen Verkauf in Betracht ziehen?', 'Ha, that would be nice! Realistically, if the number fits, would you consider selling?'),
  ('lc-price-reality-check-pl-1', 'Price reality check 1 (PL)', 'Polish', 1,
   'Haha, chcialbym! A realnie, gdyby liczba miala sens, rozwazylbys sprzedaz?', 'Ha, I wish! Realistically, if the number made sense, would you consider selling?'),
  ('lc-price-reality-check-vi-1', 'Price reality check 1 (VI)', 'Vietnamese', 1,
   'Haha, uoc gi! Noi thuc te, neu con so hop ly, ban co can nhac ban khong?', 'Ha, I wish! Realistically, if the number is reasonable, would you consider selling?'),
  ('lc-price-reality-check-zh-1', 'Price reality check 1 (ZH)', 'Mandarin', 1,
   'Haha, dangran xiwang ruci! Shuo zhen de, ruguo jiage heli, nin hui kaolv chushou ma?', 'Ha, I wish! Seriously, if the price is reasonable, would you consider selling?'),
  ('lc-price-reality-check-ja-1', 'Price reality check 1 (JA)', 'Japanese', 1,
   'Haha, sou dattara ii desu ne! Genjitsuteki ni, kakaku ga au nara, baikyaku o kentou shimasu ka?', 'Ha, that would be nice! Realistically, if the price works, would you consider selling?'),
  ('lc-price-reality-check-ko-1', 'Price reality check 1 (KO)', 'Korean', 1,
   'Haha, geureomyeon joketneyo! Hyeonsiljeogeuro, gagyeogi majeumyeon pal saenggak isseusinayo?', 'Ha, that would be nice! Realistically, if the price fits, would you think about selling?'),
  ('lc-price-reality-check-ru-1', 'Price reality check 1 (RU)', 'Russian', 1,
   'Ha, khotel by ya! A esli realno, pri razumnoy tsene vy by rassmotreli prodazhu?', 'Ha, I wish! Realistically, at a reasonable price would you consider selling?'),
  ('lc-price-reality-check-he-1', 'Price reality check 1 (HE)', 'Hebrew', 1,
   'Ha, halevai! Be''ofen metsiuti, im hamispar yihye hegioni, tishkol limkor?', 'Ha, I wish! Realistically, if the number is reasonable, would you consider selling?'),
  ('lc-price-reality-check-ar-1', 'Price reality check 1 (AR)', 'Arabic', 1,
   'Ha, yareit! Bi waqiiya, idha kan al raqam maqool, hal tufakkir fi al bay?', 'Ha, I wish! Realistically, if the number is reasonable, would you think about selling?'),
  ('lc-price-reality-check-hi-1', 'Price reality check 1 (HI)', 'Indian (Hindi or Other)', 1,
   'Haha, kaash! Sach mein, agar daam sahi ho, to kya aap bechne par vichar karenge?', 'Ha, I wish! Really, if the price is right, would you consider selling?'),
  ('lc-price-reality-check-el-1', 'Price reality check 1 (EL)', 'Greek', 1,
   'Xa, makari! Realistika, an i timi itan logiki, tha to skeftosoun na poulisete?', 'Ha, I wish! Realistically, if the price were reasonable, would you consider selling?')
) as v(template_id, template_name, language, fallback_rank, template_body, english_translation)
where not exists (
  select 1 from public.sms_templates t where t.template_id = v.template_id
);

commit;

-- POSTCHECK (read-only):
--   select language, template_id, is_active, safe_for_auto_reply
--     from public.sms_templates where use_case = 'price_reality_check' order by language, fallback_rank;
