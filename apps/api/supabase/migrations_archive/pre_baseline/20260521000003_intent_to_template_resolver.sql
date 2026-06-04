CREATE OR REPLACE FUNCTION public.get_auto_reply_template_id(
  in_intent text, 
  in_language text
) RETURNS text AS $$
DECLARE
  target_use_case text;
  result_id text;
BEGIN
  -- Intent mapping
  target_use_case := CASE in_intent
    WHEN 'ownership_confirmed' THEN 'ownership_check'
    WHEN 'price_request' THEN 'seller_asking_price'
    WHEN 'info_request' THEN 'who_is_this'
    WHEN 'positive_interest' THEN 'price_works_confirm_basics'
    ELSE 'ownership_check'
  END;

  -- Select a general-purpose template for the use case (allow 'sfr')
  SELECT id INTO result_id FROM public.sms_templates 
  WHERE use_case = target_use_case 
  AND language = in_language 
  AND is_active = true 
  AND (allowed_property_groups IS NULL OR allowed_property_groups @> ARRAY['sfr'])
  ORDER BY random() 
  LIMIT 1;

  RETURN result_id;
END;
$$ LANGUAGE plpgsql;
