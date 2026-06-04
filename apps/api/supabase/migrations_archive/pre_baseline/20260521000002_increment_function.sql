CREATE OR REPLACE FUNCTION public.increment_outreach_touch_count(owner_id text, phone text)
RETURNS void AS $$
BEGIN
    UPDATE public.contact_outreach_state
    SET touch_count = COALESCE(touch_count, 0) + 1
    WHERE podio_master_owner_id = owner_id
    AND to_phone_number = phone;
END;
$$ LANGUAGE plpgsql;
