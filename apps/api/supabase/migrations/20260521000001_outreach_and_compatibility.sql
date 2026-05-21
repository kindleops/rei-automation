-- Phase A: Hardening Outreach State & Phase B: Template Compatibility

-- 1. Add missing columns to contact_outreach_state
ALTER TABLE public.contact_outreach_state 
ADD COLUMN IF NOT EXISTS first_outbound_at timestamptz,
ADD COLUMN IF NOT EXISTS last_touch_at timestamptz,
ADD COLUMN IF NOT EXISTS touch_count integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_queue_id uuid,
ADD COLUMN IF NOT EXISTS last_message_event_id uuid,
ADD COLUMN IF NOT EXISTS last_template_id text,
ADD COLUMN IF NOT EXISTS last_agent_id text,
ADD COLUMN IF NOT EXISTS last_market text,
ADD COLUMN IF NOT EXISTS last_property_address text,
ADD COLUMN IF NOT EXISTS last_property_type text,
ADD COLUMN IF NOT EXISTS suppression_until timestamptz,
ADD COLUMN IF NOT EXISTS suppression_reason text,
ADD COLUMN IF NOT EXISTS canonical_e164 text,
ADD COLUMN IF NOT EXISTS channel text DEFAULT 'sms';

-- 2. Ensure granular unique constraints for suppression logic
-- Drop existing broad owner-level constraint if it exists (which blocks multiple phones per owner)
ALTER TABLE public.contact_outreach_state DROP CONSTRAINT IF EXISTS contact_outreach_state_podio_master_owner_id_key;

-- Drop index to replace with named constraint
DROP INDEX IF EXISTS public.uq_contact_outreach_state_owner_phone;

-- Create phone-level unique constraint for suppression
ALTER TABLE public.contact_outreach_state 
ADD CONSTRAINT uq_contact_outreach_state_owner_phone 
UNIQUE (podio_master_owner_id, to_phone_number);

-- 3. Add compatibility columns to sms_templates
ALTER TABLE public.sms_templates
ADD COLUMN IF NOT EXISTS allowed_property_groups text[],
ADD COLUMN IF NOT EXISTS prohibited_property_groups text[],
ADD COLUMN IF NOT EXISTS property_phrase_type text;

-- 3. Create helper for property grouping if not exists
CREATE OR REPLACE FUNCTION public.get_canonical_property_group(property_type text)
RETURNS text AS $$
DECLARE
  pt text := lower(COALESCE(property_type, ''));
BEGIN
  IF pt IN ('single family', 'sfr', 'residential', 'single-family') THEN RETURN 'sfr';
  ELSIF pt IN ('duplex') THEN RETURN 'duplex';
  ELSIF pt IN ('triplex') THEN RETURN 'triplex';
  ELSIF pt IN ('fourplex') THEN RETURN 'fourplex';
  ELSIF pt ILIKE '%multifamily%' AND pt ILIKE '%small%' THEN RETURN 'small_multifamily';
  ELSIF pt ILIKE '%multifamily%' THEN RETURN 'multifamily_5_plus';
  ELSIF pt ILIKE '%retail%' OR pt ILIKE '%strip%' THEN RETURN 'retail';
  ELSIF pt ILIKE '%office%' THEN RETURN 'office';
  ELSIF pt ILIKE '%industrial%' OR pt ILIKE '%warehouse%' THEN RETURN 'industrial';
  ELSIF pt ILIKE '%storage%' THEN RETURN 'self_storage';
  ELSIF pt ILIKE '%hotel%' OR pt ILIKE '%motel%' THEN RETURN 'hotel_motel';
  ELSIF pt ILIKE '%mobile home%' THEN RETURN 'mobile_home_park';
  ELSIF pt ILIKE '%land%' OR pt ILIKE '%lot%' OR pt ILIKE '%parcel%' THEN RETURN 'land';
  ELSE RETURN 'other_commercial';
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 4. Initial template group seeding (broad defaults)
UPDATE public.sms_templates
SET allowed_property_groups = ARRAY['sfr', 'duplex', 'triplex', 'fourplex', 'small_multifamily']
WHERE allowed_property_groups IS NULL;

-- 5. Strict update for known problematic templates (Example: Duplex specific)
UPDATE public.sms_templates
SET allowed_property_groups = ARRAY['duplex'],
    property_phrase_type = 'duplex'
WHERE template_body ILIKE '%duplex%' OR template_name ILIKE '%duplex%';

UPDATE public.sms_templates
SET allowed_property_groups = ARRAY['triplex'],
    property_phrase_type = 'triplex'
WHERE template_body ILIKE '%triplex%' OR template_name ILIKE '%triplex%';
