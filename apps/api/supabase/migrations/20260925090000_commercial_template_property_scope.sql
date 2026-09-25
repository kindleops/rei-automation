-- ════════════════════════════════════════════════════════════════════════════
-- Commercial templates declare the properties they are written for.
--
-- The six commercial first-touch templates (self-storage, retail, other
-- commercial) had allowed_property_groups = NULL, which every group-aware
-- path reads as "allowed everywhere". On 2026-09-25 campaign df0671fa queued
-- 15 of them to single-family and apartment owners ("are you still the owner
-- of the self-storage facility at …"); 27 earlier mismatched sends delivered.
--
-- The application now enforces asset compatibility at selection and at
-- dispatch (template-asset-compatibility.js). This makes the template data
-- say the same thing, so SQL-side pickers and any path that reads the group
-- columns agree with it. Idempotent.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE public.sms_templates
SET allowed_property_groups = ARRAY['self_storage'],
    prohibited_property_groups = ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus','land']
WHERE property_type_scope = 'Self-Storage';

UPDATE public.sms_templates
SET allowed_property_groups = ARRAY['retail'],
    prohibited_property_groups = ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus','land']
WHERE property_type_scope = 'Strip Center / Retail';

UPDATE public.sms_templates
SET allowed_property_groups = ARRAY['self_storage','retail','office','industrial','hotel_motel','mobile_home_park','other_commercial'],
    prohibited_property_groups = ARRAY['sfr','duplex','triplex','fourplex','small_multifamily','multifamily_5_plus','land']
WHERE property_type_scope = 'Commercial (Other)';
