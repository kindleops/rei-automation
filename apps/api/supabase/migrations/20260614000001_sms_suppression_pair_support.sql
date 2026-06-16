ALTER TABLE public.sms_suppression_list ADD COLUMN IF NOT EXISTS sender_phone_e164 text;

ALTER TABLE public.sms_suppression_list DROP CONSTRAINT IF EXISTS sms_suppression_list_phone_e164_key;

-- We use NULLS NOT DISTINCT so that a global suppression (where sender_phone_e164 is NULL) 
-- is still unique per phone_e164, but pair-level suppressions can coexist for different sender_phone_e164.
ALTER TABLE public.sms_suppression_list 
  ADD CONSTRAINT sms_suppression_list_phone_and_sender_key 
  UNIQUE NULLS NOT DISTINCT (phone_e164, sender_phone_e164);
