-- Add denormalized filter columns used by Campaign Builder preview.
-- The refresh functions already persist full source rows into extra_data; a trigger
-- keeps these graph columns in sync without rewriting every staged refresh path.

ALTER TABLE IF EXISTS public.campaign_target_graph
  ADD COLUMN IF NOT EXISTS units_count numeric,
  ADD COLUMN IF NOT EXISTS tax_delinquent boolean,
  ADD COLUMN IF NOT EXISTS active_lien boolean,
  ADD COLUMN IF NOT EXISTS property_flags_text text,
  ADD COLUMN IF NOT EXISTS building_condition text,
  ADD COLUMN IF NOT EXISTS owner_type text,
  ADD COLUMN IF NOT EXISTS is_corporate_owner boolean,
  ADD COLUMN IF NOT EXISTS out_of_state_owner boolean,
  ADD COLUMN IF NOT EXISTS gender text,
  ADD COLUMN IF NOT EXISTS marital_status text,
  ADD COLUMN IF NOT EXISTS net_asset_value text,
  ADD COLUMN IF NOT EXISTS buying_power text,
  ADD COLUMN IF NOT EXISTS email_eligible boolean;

ALTER TABLE IF EXISTS public.campaign_target_graph_stage
  ADD COLUMN IF NOT EXISTS units_count numeric,
  ADD COLUMN IF NOT EXISTS tax_delinquent boolean,
  ADD COLUMN IF NOT EXISTS active_lien boolean,
  ADD COLUMN IF NOT EXISTS property_flags_text text,
  ADD COLUMN IF NOT EXISTS building_condition text,
  ADD COLUMN IF NOT EXISTS owner_type text,
  ADD COLUMN IF NOT EXISTS is_corporate_owner boolean,
  ADD COLUMN IF NOT EXISTS out_of_state_owner boolean,
  ADD COLUMN IF NOT EXISTS gender text,
  ADD COLUMN IF NOT EXISTS marital_status text,
  ADD COLUMN IF NOT EXISTS net_asset_value text,
  ADD COLUMN IF NOT EXISTS buying_power text,
  ADD COLUMN IF NOT EXISTS email_eligible boolean;

CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_units_count
  ON public.campaign_target_graph (units_count);
CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_tax_delinquent
  ON public.campaign_target_graph (tax_delinquent);
CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_active_lien
  ON public.campaign_target_graph (active_lien);
CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_building_condition
  ON public.campaign_target_graph (building_condition);
CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_owner_flags
  ON public.campaign_target_graph (is_corporate_owner, out_of_state_owner);

CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_stage_units_count
  ON public.campaign_target_graph_stage (units_count);
CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_stage_tax_delinquent
  ON public.campaign_target_graph_stage (tax_delinquent);
CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_stage_active_lien
  ON public.campaign_target_graph_stage (active_lien);

CREATE OR REPLACE FUNCTION public.campaign_target_graph_text_to_bool(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_value IS NULL THEN NULL
    WHEN lower(trim(p_value)) IN ('true', 't', '1', 'yes', 'y', 'on', 'active', 'delinquent', 'lien') THEN true
    WHEN lower(trim(p_value)) IN ('false', 'f', '0', 'no', 'n', 'off', 'clear', 'none') THEN false
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.campaign_target_graph_text_to_numeric(p_value text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_clean text;
BEGIN
  v_clean := NULLIF(regexp_replace(COALESCE(p_value, ''), '[^0-9.\-]+', '', 'g'), '');
  IF v_clean IS NULL OR v_clean IN ('-', '.', '-.') THEN
    RETURN NULL;
  END IF;
  RETURN v_clean::numeric;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.campaign_target_graph_apply_filter_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_property jsonb := COALESCE(NEW.extra_data->'property', '{}'::jsonb);
  v_master_owner jsonb := COALESCE(NEW.extra_data->'master_owner', '{}'::jsonb);
  v_prospect jsonb := COALESCE(NEW.extra_data->'prospect', '{}'::jsonb);
BEGIN
  NEW.units_count := COALESCE(
    NEW.units_count,
    public.campaign_target_graph_text_to_numeric(v_property->>'units_count'),
    public.campaign_target_graph_text_to_numeric(v_property->>'units'),
    public.campaign_target_graph_text_to_numeric(v_property->>'number_of_units')
  );
  NEW.tax_delinquent := COALESCE(
    NEW.tax_delinquent,
    public.campaign_target_graph_text_to_bool(v_property->>'tax_delinquent'),
    public.campaign_target_graph_text_to_bool(v_property->>'property_tax_delinquent'),
    (public.campaign_target_graph_text_to_numeric(v_property->>'tax_delinquent_year') IS NOT NULL)
  );
  NEW.active_lien := COALESCE(
    NEW.active_lien,
    public.campaign_target_graph_text_to_bool(v_property->>'active_lien'),
    public.campaign_target_graph_text_to_bool(v_property->>'property_active_lien')
  );
  NEW.property_flags_text := COALESCE(
    NULLIF(NEW.property_flags_text, ''),
    NULLIF(v_property->>'property_flags_text', ''),
    NULLIF(v_property->>'flags_text', ''),
    NULLIF(v_property->>'seller_tags_text', ''),
    NULLIF(NEW.podio_tags, '')
  );
  NEW.building_condition := COALESCE(
    NULLIF(NEW.building_condition, ''),
    NULLIF(v_property->>'building_condition', ''),
    NULLIF(v_property->>'condition', ''),
    NULLIF(v_property->>'rehab_level', ''),
    NULLIF(NEW.rehab_level, '')
  );
  NEW.owner_type := COALESCE(
    NULLIF(NEW.owner_type, ''),
    NULLIF(v_property->>'owner_type', ''),
    NULLIF(v_property->>'owner_type_guess', ''),
    NULLIF(v_master_owner->>'owner_type_guess', ''),
    NULLIF(NEW.owner_type_guess, '')
  );
  NEW.is_corporate_owner := COALESCE(
    NEW.is_corporate_owner,
    public.campaign_target_graph_text_to_bool(v_property->>'is_corporate_owner'),
    CASE
      WHEN lower(COALESCE(NEW.owner_type, NEW.owner_type_guess, '')) ~ '(llc|inc|corp|trust|company|partners|holdings)' THEN true
      ELSE NULL
    END
  );
  NEW.out_of_state_owner := COALESCE(
    NEW.out_of_state_owner,
    public.campaign_target_graph_text_to_bool(v_property->>'out_of_state_owner')
  );
  NEW.gender := COALESCE(NULLIF(NEW.gender, ''), NULLIF(v_prospect->>'gender', ''));
  NEW.marital_status := COALESCE(NULLIF(NEW.marital_status, ''), NULLIF(v_prospect->>'marital_status', ''));
  NEW.net_asset_value := COALESCE(NULLIF(NEW.net_asset_value, ''), NULLIF(v_prospect->>'net_asset_value', ''));
  NEW.buying_power := COALESCE(NULLIF(NEW.buying_power, ''), NULLIF(v_prospect->>'buying_power', ''));
  NEW.email_eligible := COALESCE(
    NEW.email_eligible,
    public.campaign_target_graph_text_to_bool(v_prospect->>'email_eligible')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_campaign_target_graph_filter_columns ON public.campaign_target_graph;
CREATE TRIGGER trg_campaign_target_graph_filter_columns
BEFORE INSERT OR UPDATE OF extra_data, units_count, tax_delinquent, active_lien, property_flags_text, building_condition, owner_type, is_corporate_owner, out_of_state_owner, gender, marital_status, net_asset_value, buying_power, email_eligible
ON public.campaign_target_graph
FOR EACH ROW
EXECUTE FUNCTION public.campaign_target_graph_apply_filter_columns();

DROP TRIGGER IF EXISTS trg_campaign_target_graph_stage_filter_columns ON public.campaign_target_graph_stage;
CREATE TRIGGER trg_campaign_target_graph_stage_filter_columns
BEFORE INSERT OR UPDATE OF extra_data, units_count, tax_delinquent, active_lien, property_flags_text, building_condition, owner_type, is_corporate_owner, out_of_state_owner, gender, marital_status, net_asset_value, buying_power, email_eligible
ON public.campaign_target_graph_stage
FOR EACH ROW
EXECUTE FUNCTION public.campaign_target_graph_apply_filter_columns();

-- Do not run a full-table trigger backfill in this migration.
-- The timed-out backfills were:
--   UPDATE public.campaign_target_graph SET extra_data = extra_data WHERE extra_data IS NOT NULL;
--   UPDATE public.campaign_target_graph_stage SET extra_data = extra_data WHERE extra_data IS NOT NULL;
-- 20260602211306_chunked_campaign_target_graph_filter_backfill.sql adds cursor-based
-- batch functions for safely populating existing graph rows.

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_facets()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  TRUNCATE TABLE public.campaign_target_graph_facets;

  WITH base_facets AS (
    SELECT
      g.graph_id,
      g.queue_eligible,
      g.sender_covered,
      g.sms_eligible,
      NOT (g.true_post_contact_suppression OR g.wrong_number) AS clean_path,
      facet.field_key,
      facet.value
    FROM public.campaign_target_graph g
    CROSS JOIN LATERAL (VALUES
      ('properties.market', g.market),
      ('properties.property_state', g.state),
      ('properties.property_address_state', g.state),
      ('properties.property_address_city', g.property_city),
      ('properties.property_zip', g.property_zip),
      ('properties.property_address_zip', g.property_zip),
      ('properties.property_county_name', g.property_county_name),
      ('properties.property_address_county_name', g.property_county_name),
      ('properties.property_type', g.property_type),
      ('properties.property_class', g.property_class),
      ('properties.units_count', g.units_count::text),
      ('properties.tax_delinquent', g.tax_delinquent::text),
      ('properties.active_lien', g.active_lien::text),
      ('properties.building_condition', g.building_condition),
      ('properties.rehab_level', g.rehab_level),
      ('properties.owner_type', g.owner_type),
      ('properties.owner_type_guess', g.owner_type_guess),
      ('properties.is_corporate_owner', g.is_corporate_owner::text),
      ('properties.out_of_state_owner', g.out_of_state_owner::text),
      ('prospects.language_preference', g.language),
      ('prospects.gender', g.gender),
      ('prospects.marital_status', g.marital_status),
      ('prospects.age_bucket', g.age_bucket),
      ('prospects.occupation_group', g.occupation_group),
      ('prospects.education_model', g.education_model),
      ('prospects.est_household_income', g.income),
      ('prospects.net_asset_value', g.net_asset_value),
      ('prospects.buying_power', g.buying_power),
      ('prospects.timezone', g.timezone),
      ('prospects.contact_window', g.contact_window),
      ('prospects.sms_eligible', g.sms_eligible::text),
      ('prospects.email_eligible', g.email_eligible::text),
      ('master_owners.owner_type_guess', g.owner_type_guess),
      ('master_owners.priority_tier', g.priority_tier),
      ('master_owners.follow_up_cadence', g.follow_up_cadence),
      ('phones.phone_owner', g.phone_owner),
      ('phones.activity_status', COALESCE(NULLIF(g.phone_activity_status, ''), CASE WHEN g.wrong_number THEN 'wrong_number' ELSE NULL END)),
      ('phones.usage_12_months', g.usage_12_months),
      ('phones.usage_2_months', g.usage_2_months),
      ('outreach.true_post_contact_suppression', g.true_post_contact_suppression::text),
      ('outreach.pending_prior_touch', g.pending_prior_touch::text),
      ('outreach.duplicate_queue_status', CASE WHEN g.active_queue_item THEN 'active_queue_item' ELSE 'clear' END),
      ('sender_coverage.routing_allowed', g.sender_covered::text),
      ('sender_coverage.routing_tier', g.routing_tier),
      ('sender_coverage.selected_textgrid_market', g.sender_market),
      ('sender_coverage.selected_textgrid_state', g.state),
      ('sender_coverage.sender_coverage_status', CASE WHEN g.sender_covered THEN 'Covered' ELSE 'No Route' END)
    ) AS facet(field_key, value)
  ),
  list_facets AS (
    SELECT
      graph_id,
      queue_eligible,
      sender_covered,
      sms_eligible,
      NOT (true_post_contact_suppression OR wrong_number) AS clean_path,
      'prospects.matching_flags' AS field_key,
      NULLIF(trim(value), '') AS value
    FROM public.campaign_target_graph
    CROSS JOIN LATERAL regexp_split_to_table(COALESCE(matching_flags_text, ''), '[,\n;|]+') AS split_value(value)
    UNION ALL
    SELECT
      graph_id,
      queue_eligible,
      sender_covered,
      sms_eligible,
      NOT (true_post_contact_suppression OR wrong_number) AS clean_path,
      'prospects.person_flags_text' AS field_key,
      NULLIF(trim(value), '') AS value
    FROM public.campaign_target_graph
    CROSS JOIN LATERAL regexp_split_to_table(COALESCE(matching_flags_text, ''), '[,\n;|]+') AS split_value(value)
    UNION ALL
    SELECT
      graph_id,
      queue_eligible,
      sender_covered,
      sms_eligible,
      NOT (true_post_contact_suppression OR wrong_number) AS clean_path,
      'properties.seller_tags_text' AS field_key,
      NULLIF(trim(value), '') AS value
    FROM public.campaign_target_graph
    CROSS JOIN LATERAL regexp_split_to_table(COALESCE(podio_tags, ''), '[,\n;|]+') AS split_value(value)
    UNION ALL
    SELECT
      graph_id,
      queue_eligible,
      sender_covered,
      sms_eligible,
      NOT (true_post_contact_suppression OR wrong_number) AS clean_path,
      'prospects.seller_tags_text' AS field_key,
      NULLIF(trim(value), '') AS value
    FROM public.campaign_target_graph
    CROSS JOIN LATERAL regexp_split_to_table(COALESCE(podio_tags, ''), '[,\n;|]+') AS split_value(value)
    UNION ALL
    SELECT
      graph_id,
      queue_eligible,
      sender_covered,
      sms_eligible,
      NOT (true_post_contact_suppression OR wrong_number) AS clean_path,
      'properties.property_flags_text' AS field_key,
      NULLIF(trim(value), '') AS value
    FROM public.campaign_target_graph
    CROSS JOIN LATERAL regexp_split_to_table(COALESCE(property_flags_text, ''), '[,\n;|]+') AS split_value(value)
  )
  INSERT INTO public.campaign_target_graph_facets (
    field_key,
    value,
    label,
    target_count,
    clean_count,
    queueable_count,
    sender_covered_count,
    sms_eligible_count,
    updated_at
  )
  SELECT
    field_key,
    value,
    value AS label,
    COUNT(*)::integer AS target_count,
    COUNT(*) FILTER (WHERE clean_path)::integer AS clean_count,
    COUNT(*) FILTER (WHERE queue_eligible)::integer AS queueable_count,
    COUNT(*) FILTER (WHERE sender_covered)::integer AS sender_covered_count,
    COUNT(*) FILTER (WHERE sms_eligible)::integer AS sms_eligible_count,
    now() AS updated_at
  FROM (
    SELECT * FROM base_facets
    UNION ALL
    SELECT * FROM list_facets
  ) facets
  WHERE NULLIF(trim(value), '') IS NOT NULL
  GROUP BY field_key, value;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.campaign_target_graph_text_to_bool(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.campaign_target_graph_text_to_numeric(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.campaign_target_graph_apply_filter_columns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_facets() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_target_graph_text_to_bool(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.campaign_target_graph_text_to_numeric(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.campaign_target_graph_apply_filter_columns() TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph_facets() TO service_role;
