-- PROPOSED (not applied) — 2026-10-07, composer filter audit.
--
-- WHY: every Composer value picker reads campaign_target_graph_facets, a
-- snapshot rebuilt only by refresh_campaign_target_graph_stage_commit. The
-- 10:18Z snapshot has NO rows for 25 of the 47 option fields the facet
-- function lists (building_condition, language, gender, marital_status,
-- age_bucket, income, net_asset_value, buying_power, occupation_group,
-- education_model, email_eligible, follow_up_cadence, phone_owner,
-- usage_12/2_months, units_count, matching flags ...), because those columns
-- were filled by campaign_target_graph_enrich_rows AFTER the snapshot. The
-- picker then said "No values found" for a field that is 100 % filled in
-- public.properties.
--
-- WHAT: one exact GROUP BY over the live audience column, for one field at a
-- time (176k rows, ~0.1-0.4 s, well under the 8 s PostgREST role timeout).
-- Returns the same shape as a facet row so the API needs no other change.
-- Returns NULL for a field it does not know -> the API falls back to the
-- snapshot and says so. The API already calls it (campaign-field-catalog.js
-- queryExactGraphFieldValues) and flips over automatically once this exists.
--
-- Read-only, SECURITY INVOKER, STABLE. No table, no index, no data change.

CREATE OR REPLACE FUNCTION public.campaign_audience_field_values(
  p_field_key text,
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 250
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
SET statement_timeout TO '7s'
AS $function$
DECLARE
  v_expr text;
  v_list boolean := false;
  v_sql text;
  v_out jsonb;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 250), 1), 2000);
BEGIN
  -- field_key -> audience column. Same keys as refresh_campaign_target_graph_facets
  -- (and GRAPH_FACET_FIELD_ALIASES in the API). Identifiers are fixed literals.
  v_expr := CASE p_field_key
    WHEN 'properties.market' THEN 'market'
    WHEN 'properties.property_state' THEN 'state'
    WHEN 'properties.property_address_state' THEN 'state'
    WHEN 'properties.property_address_city' THEN 'property_city'
    WHEN 'properties.property_zip' THEN 'property_zip'
    WHEN 'properties.property_address_zip' THEN 'property_zip'
    WHEN 'properties.property_county_name' THEN 'property_county_name'
    WHEN 'properties.property_address_county_name' THEN 'property_county_name'
    WHEN 'properties.property_type' THEN 'property_type'
    WHEN 'properties.property_class' THEN 'property_class'
    WHEN 'properties.tax_delinquent' THEN 'tax_delinquent::text'
    WHEN 'properties.active_lien' THEN 'active_lien::text'
    WHEN 'properties.building_condition' THEN 'building_condition'
    WHEN 'properties.building_quality' THEN 'building_quality'
    WHEN 'properties.rehab_level' THEN 'rehab_level'
    WHEN 'properties.decision_tier' THEN 'decision_tier'
    WHEN 'properties.best_strategy' THEN 'best_strategy'
    WHEN 'properties.owner_type' THEN 'owner_type'
    WHEN 'properties.owner_type_guess' THEN 'owner_type_guess'
    WHEN 'master_owners.owner_type_guess' THEN 'owner_type_guess'
    WHEN 'properties.is_corporate_owner' THEN 'is_corporate_owner::text'
    WHEN 'properties.out_of_state_owner' THEN 'out_of_state_owner::text'
    WHEN 'prospects.language_preference' THEN 'language'
    WHEN 'prospects.gender' THEN 'gender'
    WHEN 'prospects.marital_status' THEN 'marital_status'
    WHEN 'prospects.age_bucket' THEN 'age_bucket'
    WHEN 'prospects.occupation_group' THEN 'occupation_group'
    WHEN 'prospects.education_model' THEN 'education_model'
    WHEN 'prospects.est_household_income' THEN 'income'
    WHEN 'prospects.net_asset_value' THEN 'net_asset_value'
    WHEN 'prospects.buying_power' THEN 'buying_power'
    WHEN 'prospects.timezone' THEN 'timezone'
    WHEN 'prospects.contact_window' THEN 'contact_window'
    WHEN 'prospects.sms_eligible' THEN 'sms_eligible::text'
    WHEN 'prospects.email_eligible' THEN 'email_eligible::text'
    WHEN 'master_owners.priority_tier' THEN 'priority_tier'
    WHEN 'master_owners.follow_up_cadence' THEN 'follow_up_cadence'
    WHEN 'phones.phone_type' THEN 'phone_type'
    WHEN 'phones.phone_owner' THEN 'phone_owner'
    WHEN 'phones.activity_status' THEN $e$COALESCE(NULLIF(phone_activity_status, ''), CASE WHEN wrong_number THEN 'wrong_number' END)$e$
    WHEN 'phones.usage_12_months' THEN 'usage_12_months'
    WHEN 'phones.usage_2_months' THEN 'usage_2_months'
    WHEN 'outreach.true_post_contact_suppression' THEN 'true_post_contact_suppression::text'
    WHEN 'outreach.pending_prior_touch' THEN 'pending_prior_touch::text'
    WHEN 'outreach.duplicate_queue_status' THEN $e$CASE WHEN active_queue_item THEN 'active_queue_item' ELSE 'clear' END$e$
    WHEN 'sender_coverage.routing_allowed' THEN 'sender_covered::text'
    WHEN 'sender_coverage.routing_tier' THEN 'routing_tier'
    WHEN 'sender_coverage.selected_textgrid_market' THEN 'sender_market'
    WHEN 'sender_coverage.sender_coverage_status' THEN $e$CASE WHEN sender_covered THEN 'Covered' ELSE 'No Route' END$e$
    ELSE NULL
  END;

  -- ';'-joined token lists: one count per TOKEN, split exactly the way the
  -- audience filter matches them (listTokenPattern: ';' separators, trimmed).
  IF v_expr IS NULL THEN
    v_expr := CASE p_field_key
      WHEN 'properties.property_flags_text' THEN 'property_flags_text'
      WHEN 'properties.seller_tags_text' THEN 'property_flags_text'
      WHEN 'prospects.matching_flags' THEN 'matching_flags_text'
      WHEN 'prospects.person_flags_text' THEN 'matching_flags_text'
      ELSE NULL
    END;
    v_list := v_expr IS NOT NULL;
  END IF;

  IF v_expr IS NULL THEN
    RETURN NULL;
  END IF;

  v_sql := format($q$
    WITH v AS (
      SELECT %s AS value, queue_eligible, sender_covered, sms_eligible,
             NOT (COALESCE(true_post_contact_suppression, false) OR COALESCE(wrong_number, false)) AS clean_path
      FROM public.campaign_target_graph g
      %s
    )
    SELECT COALESCE(jsonb_agg(r ORDER BY r.target_count DESC, r.label), '[]'::jsonb)
    FROM (
      SELECT value, value AS label,
             count(*)::int AS target_count,
             count(*) FILTER (WHERE clean_path)::int AS clean_count,
             count(*) FILTER (WHERE queue_eligible)::int AS queueable_count,
             count(*) FILTER (WHERE sender_covered)::int AS sender_covered_count,
             count(*) FILTER (WHERE sms_eligible)::int AS sms_eligible_count
      FROM v
      WHERE NULLIF(btrim(value), '') IS NOT NULL
        AND ($1 IS NULL OR value ILIKE '%%' || $1 || '%%')
      GROUP BY value
      ORDER BY count(*) DESC, value
      LIMIT $2
    ) r
  $q$,
    CASE WHEN v_list THEN 'btrim(t.token)' ELSE v_expr END,
    CASE WHEN v_list THEN format('CROSS JOIN LATERAL regexp_split_to_table(g.%I, '';'') AS t(token) WHERE g.%I IS NOT NULL', v_expr, v_expr) ELSE '' END
  );

  EXECUTE v_sql INTO v_out USING NULLIF(btrim(p_search), ''), v_limit;
  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.campaign_audience_field_values(text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.campaign_audience_field_values(text, text, integer) TO authenticated, service_role;

-- Verify (read-only):
--   SELECT jsonb_array_length(public.campaign_audience_field_values('properties.building_condition'));  -- 8
--   SELECT public.campaign_audience_field_values('properties.property_flags_text', 'vacant');         -- Vacant Home 7814
-- Rollback: DROP FUNCTION public.campaign_audience_field_values(text, text, integer);
