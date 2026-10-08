-- Owner-approved 2026-10-07: S1 ownership-check "angle" split test.
-- 6 angles × EN/ES = 12 new sms_templates rows + rotation-control rows
-- ('testing', 40/day, weight 1.0). Each row has its own template_id, so KPIs
-- join on template_id.
-- Angles: investor (02), local buyer (04), buy-houses (05), as-is (07),
--         rental buyer (09), apartments 5+ (11).
-- Rollback: delete these template_ids from both tables (see the bottom of this file).
BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE _new(tid text, lang text, persona text, scope text, groups text[], vgk_scope text, body text, en text) ON COMMIT DROP;
INSERT INTO _new VALUES
 ('lc-s1-angle-investor-en-02','English','Investor Direct','Any Residential','{sfr,duplex,triplex,fourplex,small_multifamily}','Any Residential',
  'Hey {{seller_first_name}}, {{agent_name}} here. I''m an investor here in {{city}}. Are you still the owner of {{property_address}}?', NULL),
 ('lc-s1-angle-buyer-en-04','English','Buyer / Local Buyer','Any Residential','{sfr,duplex,triplex,fourplex,small_multifamily}','Any Residential',
  'Hi {{seller_first_name}}, this is {{agent_name}}. I''m a local buyer looking at homes in {{city}}. Do you still own {{property_address}}?', NULL),
 ('lc-s1-angle-buyhouses-en-05','English','Buyer / Local Buyer','Any Residential','{sfr,duplex,triplex,fourplex,small_multifamily}','Any Residential',
  'Hey {{seller_first_name}}, {{agent_name}} here. I buy houses in {{city}} and came across {{property_address}}. Are you still the owner?', NULL),
 ('lc-s1-angle-asis-en-07','English','Investor Direct','Any Residential','{sfr,duplex,triplex,fourplex,small_multifamily}','Any Residential',
  'Hi {{seller_first_name}}, this is {{agent_name}}. I buy homes as-is in {{city}}, no repairs needed. Do you still own {{property_address}}?', NULL),
 ('lc-s1-angle-rental-en-09','English','Investor Direct','Any Residential','{sfr,duplex,triplex,fourplex,small_multifamily}','Any Residential',
  'Hi {{seller_first_name}}, this is {{agent_name}}. I buy rental properties in {{city}}. Do you still own {{property_address}}?', NULL),
 ('lc-s1-angle-apartments-en-11','English','Investor Direct','5+ Units','{multifamily_5_plus}','5+ Units',
  'Hi {{seller_first_name}}, this is {{agent_name}}. I''m an investor buying apartment buildings in {{city}}. Do you still own {{property_address}}?', NULL),
 ('lc-s1-angle-investor-es-02','Spanish','Investor Direct','Any Residential','{sfr,duplex,triplex,fourplex,small_multifamily}','Any Residential',
  'Hola {{seller_first_name}}, soy {{agent_name}}, inversionista aquí en {{city}}. ¿Sigue siendo el dueño de {{property_address}}?',
  'Hi {{seller_first_name}}, I''m {{agent_name}}, an investor here in {{city}}. Are you still the owner of {{property_address}}?'),
 ('lc-s1-angle-buyer-es-04','Spanish','Buyer / Local Buyer','Any Residential','{sfr,duplex,triplex,fourplex,small_multifamily}','Any Residential',
  'Hola {{seller_first_name}}, soy {{agent_name}}. Soy comprador local buscando casas en {{city}}. ¿Todavía es dueño de {{property_address}}?',
  'Hi {{seller_first_name}}, I''m {{agent_name}}. I''m a local buyer looking for homes in {{city}}. Do you still own {{property_address}}?'),
 ('lc-s1-angle-buyhouses-es-05','Spanish','Buyer / Local Buyer','Any Residential','{sfr,duplex,triplex,fourplex,small_multifamily}','Any Residential',
  'Hola {{seller_first_name}}, {{agent_name}} aquí. Compro casas en {{city}} y vi {{property_address}}. ¿Sigue siendo el dueño?',
  'Hi {{seller_first_name}}, {{agent_name}} here. I buy houses in {{city}} and saw {{property_address}}. Are you still the owner?'),
 ('lc-s1-angle-asis-es-07','Spanish','Investor Direct','Any Residential','{sfr,duplex,triplex,fourplex,small_multifamily}','Any Residential',
  'Hola {{seller_first_name}}, soy {{agent_name}}. Compro casas en {{city}} tal como están, sin reparaciones. ¿Todavía es dueño de {{property_address}}?',
  'Hi {{seller_first_name}}, I''m {{agent_name}}. I buy homes as-is in {{city}}, no repairs. Do you still own {{property_address}}?'),
 ('lc-s1-angle-rental-es-09','Spanish','Investor Direct','Any Residential','{sfr,duplex,triplex,fourplex,small_multifamily}','Any Residential',
  'Hola {{seller_first_name}}, soy {{agent_name}}. Compro propiedades de renta en {{city}}. ¿Sigue siendo el dueño de {{property_address}}?',
  'Hi {{seller_first_name}}, I''m {{agent_name}}. I buy rental properties in {{city}}. Are you still the owner of {{property_address}}?'),
 ('lc-s1-angle-apartments-es-11','Spanish','Investor Direct','5+ Units','{multifamily_5_plus}','5+ Units',
  'Hola {{seller_first_name}}, soy {{agent_name}}. Soy inversionista comprando edificios de apartamentos en {{city}}. ¿Todavía es dueño de {{property_address}}?',
  'Hi {{seller_first_name}}, I''m {{agent_name}}. I''m an investor buying apartment buildings in {{city}}. Do you still own {{property_address}}?');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.sms_templates s JOIN _new n ON n.tid = s.template_id::text) THEN
    RAISE EXCEPTION 'one or more template_ids already exist';
  END IF;
END $$;

INSERT INTO public.sms_templates
  (use_case, agent_persona, language, template_body, variables, is_active, version, template_id, stage_code, stage_label,
   property_type_scope, deal_strategy, is_first_touch, is_follow_up, english_translation, metadata, template_name,
   allowed_property_groups, safe_for_auto_reply, reply_mode, identity_contact_mode, minimal_fallback, quarantine_state)
SELECT 'ownership_check', n.persona, n.lang, n.body, '{}'::jsonb, true, 1, n.tid, 'S1', 'Ownership Confirmation',
       n.scope, 'Cash', true, false, coalesce(n.en, n.body),
       jsonb_build_object('split_test','s1_angle_20261007','angle', split_part(n.tid,'-',4),'approved_by','owner 2026-10-07'),
       'ownership_check_S1_'||n.lang||'_'||n.tid, n.groups, false, 'manual', 'owner_safe',
       false, 'active'
FROM _new n;

INSERT INTO public.ownership_template_rotation_control
  (template_id, rotation_status, language, asset_scope, traffic_weight, daily_cap, required_safe_variables, notes, created_at, updated_at)
SELECT n.tid, 'testing', n.lang, 'all', 1.0, 40, '{seller_first_name,property_address,agent_name,city}',
       'S1 angle split test 2026-10-07 (owner-approved)', now(), now()
FROM _new n
ON CONFLICT DO NOTHING;

SELECT s.template_id, s.language, s.property_type_scope, c.rotation_status, c.daily_cap, length(s.template_body) chars
  FROM public.sms_templates s JOIN public.ownership_template_rotation_control c ON c.template_id::text = s.template_id::text
 WHERE s.template_id::text LIKE 'lc-s1-angle-%' ORDER BY 1;
COMMIT;

-- ROLLBACK (manual):
-- DELETE FROM public.ownership_template_rotation_control WHERE template_id LIKE 'lc-s1-angle-%';
-- DELETE FROM public.sms_templates WHERE template_id LIKE 'lc-s1-angle-%';
