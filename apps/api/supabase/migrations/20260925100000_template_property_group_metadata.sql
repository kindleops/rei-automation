-- ════════════════════════════════════════════════════════════════════════════
-- Template property-group metadata says what the template scope says.
--
-- Every residential-family template carried the same default allowed list,
-- ['sfr','duplex','triplex','fourplex','small_multifamily'], regardless of
-- scope. Two consequences (inventory 2026-09-25, 8,780 active templates):
--   * 1,015 "5+ Units" and ~1,540 Duplex/Triplex/Fourplex templates listed
--     'sfr' — unit/building copy declared eligible for a house;
--   * no template listed 'multifamily_5_plus', so an 11+ unit building had
--     ~100 eligible templates instead of ~7,200 once scope is enforced.
--
-- The application enforces scope ∩ allowed list (template-asset-compatibility
-- .js, metadata first, words only narrow). This aligns the data with the
-- scopes so every reader of these columns agrees. Idempotent; scope-keyed,
-- no template ids.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE public.sms_templates
SET allowed_property_groups = ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus']
WHERE property_type_scope IN ('Any Residential','Residential','Corporate / Institutional','Probate / Trust',
                              'Follow-Up','Heavy Negotiation','Landlord / Multifamily')
  AND allowed_property_groups IS DISTINCT FROM ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus'];

UPDATE public.sms_templates
SET allowed_property_groups = ARRAY['small_multifamily','multifamily_5_plus']
WHERE property_type_scope = '5+ Units'
  AND allowed_property_groups IS DISTINCT FROM ARRAY['small_multifamily','multifamily_5_plus'];

UPDATE public.sms_templates SET allowed_property_groups = ARRAY['duplex']
WHERE property_type_scope = 'Duplex' AND allowed_property_groups IS DISTINCT FROM ARRAY['duplex'];

UPDATE public.sms_templates SET allowed_property_groups = ARRAY['triplex']
WHERE property_type_scope = 'Triplex' AND allowed_property_groups IS DISTINCT FROM ARRAY['triplex'];

UPDATE public.sms_templates SET allowed_property_groups = ARRAY['fourplex']
WHERE property_type_scope = 'Fourplex' AND allowed_property_groups IS DISTINCT FROM ARRAY['fourplex'];
