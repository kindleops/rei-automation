-- PROPOSED — NOT APPLIED. OWNER DECISION: which EXISTING rows become auto-reply safe.
--
-- Seller Autopilot S1–S4 v2. On 2026-10-06 only English (50) and Spanish (35)
-- had any active + safe_for_auto_reply rows (Portuguese 2, the other 13
-- languages 0), so every non-EN/ES auto-reply fails closed to
-- language_template_missing. The rows below already exist and are active, but
-- are safe_for_auto_reply = false AND reply_mode = 'manual' (the selector skips
-- manual rows), so BOTH flags must change.
--
-- One row per (use_case, language), chosen to match the approved English
-- auto-reply row's meaning and to carry no {{placeholder}}. NATIVE REVIEW
-- REQUIRED before approval — several of these legacy rows are romanised and
-- some contain mixed-script artefacts (e.g. Hebrew 400013 "tihiye פתוח le
-- proposal", Japanese 400010 "sono bun件", Mandarin 400007 keeps the English
-- word "proposal"; Mandarin 540801 has a double comma and is NOT proposed).
--
-- Apply only the lines the owner approves. Rollback = the same statements with
-- safe_for_auto_reply = false, reply_mode = 'manual'.

begin;
set local lock_timeout = '5s';

-- S2 interest question ("Thanks for confirming. Just curious, would you be open to a proposal…")
update public.sms_templates set safe_for_auto_reply = true, reply_mode = 'auto', updated_at = now()
 where is_active and use_case = 'consider_selling'
   and template_id in ('400003','400004','400005','400006','400007','400008','400009','400010','400011','400012','400013','400014','400015','400016');

-- S3 price question ("Did you have a price in mind?")
update public.sms_templates set safe_for_auto_reply = true, reply_mode = 'auto', updated_at = now()
 where is_active and use_case = 'seller_asking_price'
   and template_id in ('840003','840004','840005','840006','840007','840008','840009','840010','840011','840012','840013','840014','840015','840016');

-- S3→S4 accept path ("That may work on our end / could be in range. Is it vacant or occupied?")
update public.sms_templates set safe_for_auto_reply = true, reply_mode = 'auto', updated_at = now()
 where is_active and use_case = 'price_works_confirm_basics'
   and template_id in ('540001','540101','540206','540306','540406','540506','540606','540706','540806');

-- S3→S4 price-above-range condition probe ("Got it. Is the property updated, or does it need work?")
update public.sms_templates set safe_for_auto_reply = true, reply_mode = 'auto', updated_at = now()
 where is_active and use_case = 'price_high_condition_probe'
   and template_id in ('550202','550302','550402','550502','550602','550702','550802');

commit;

-- POSTCHECK (read-only):
--   select use_case, language, template_id, safe_for_auto_reply, reply_mode from public.sms_templates
--    where template_id in ('400003', '…') order by 1, 2;
