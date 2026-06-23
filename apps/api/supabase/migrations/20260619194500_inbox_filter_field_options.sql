-- Inbox advanced filter option aggregation across the full hydrated universe.
-- Removes the PostgREST 1,000-row scan cap by grouping inside Postgres.

BEGIN;

DROP VIEW IF EXISTS public.inbox_hydrated_scoped CASCADE;

CREATE OR REPLACE VIEW public.inbox_hydrated_scoped AS
SELECT
  h.*,
  CASE
    WHEN h.is_hot_lead THEN 'hot_leads'
    WHEN h.show_in_priority_inbox AND h.ui_intent IN ('potential_interest', 'asking_price_provided') THEN 'hot_leads'
    WHEN h.ui_intent IN ('opt_out', 'wrong_number', 'hostile_or_legal') OR h.status = 'suppressed' OR h.is_suppressed THEN 'dnc_opt_out'
    WHEN h.automation_status = 'running' OR h.automation_status = 'autonomous' THEN 'automated'
    WHEN h.latest_direction = 'inbound' AND (h.stage = 'needs_response' OR NOT h.is_read) THEN 'new_inbound'
    WHEN h.pending_queue_count > 0 THEN 'outbound_active'
    WHEN h.latest_direction = 'outbound' AND h.stage IN ('sent_waiting', 'waiting') THEN 'outbound_active'
    WHEN h.show_in_priority_inbox AND h.ui_intent = 'unclear' THEN 'needs_review'
    WHEN h.stage = 'needs_review' THEN 'needs_review'
    ELSE 'cold_no_response'
  END AS inbox_category
FROM public.inbox_threads_hydrated h;

GRANT SELECT ON public.inbox_hydrated_scoped TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION public.inbox_filter_allowed_column(p_column text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_column = ANY (ARRAY[
    'thread_key','market','city','state','zip','property_type','property_class','owner_type_guess',
    'stage','status','ui_intent','latest_direction','best_language','building_condition','priority_bucket',
    'est_household_income','net_asset_value','occupation_group','gender','marital_status','education_model',
    'occupation','owner_priority_tier','phone_carrier','property_county_name','market_region','units_count',
    'total_bedrooms','total_baths','building_square_feet','year_built','effective_year_built','estimated_value',
    'equity_percent','equity_amount','total_loan_balance','total_loan_amt','total_loan_payment','tax_amt',
    'past_due_amount','estimated_repair_cost','ai_score','final_acquisition_score','deal_strength_score',
    'priority_score','ownership_years','prospect_age','buying_power','contactability_score',
    'financial_pressure_score','urgency_score','owner_priority_score','portfolio_total_value',
    'portfolio_total_equity','portfolio_total_loan_balance','portfolio_total_units','property_count',
    'message_count','inbound_count','outbound_count','pending_queue_count','cash_offer','assd_total_value',
    'calculated_total_value','sale_price','lot_square_feet','lot_acreage','latest_message_at','last_inbound_at',
    'last_outbound_at','sale_date','follow_up_at','owner_display_name','best_phone','seller_phone',
    'property_address_full','event_property_address','is_read','is_starred','is_pinned','is_archived',
    'is_suppressed','property_tax_delinquent','property_active_lien','is_corporate_owner','out_of_state_owner',
    'likely_owner','likely_renting','sms_eligible','email_eligible','prospect_best_email','property_flags_text',
    'property_flags_json','person_flags_text','person_flags_json','inbox_category'
  ]);
$$;

CREATE OR REPLACE FUNCTION public.inbox_filter_apply_conditions(p_conditions jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  cond jsonb;
  op text;
  col text;
  cols text[];
  val text;
  vals text[];
  clause text := 'TRUE';
  ilike_parts text[];
  flag_parts text[];
  c text;
  v text;
BEGIN
  IF p_conditions IS NULL OR jsonb_typeof(p_conditions) <> 'array' THEN
    RETURN clause;
  END IF;

  FOR cond IN SELECT value FROM jsonb_array_elements(p_conditions) LOOP
    op := cond->>'op';
    col := cond->>'column';

    IF op = 'inbox_category_eq' THEN
      val := cond->>'value';
      IF val IS NOT NULL AND val <> '' THEN
        clause := clause || format(' AND inbox_category = %L', val);
      END IF;
      CONTINUE;
    END IF;

    IF op IN ('eq','gte','lte','gt','ilike','is','not_is','not_ilike') THEN
      IF NOT public.inbox_filter_allowed_column(col) THEN
        RAISE EXCEPTION 'inbox_filter_invalid_column:%', col;
      END IF;
      val := cond->>'value';
      IF op = 'eq' THEN
        clause := clause || format(' AND %I = %L', col, val);
      ELSIF op = 'gte' THEN
        clause := clause || format(' AND %I >= %L', col, val);
      ELSIF op = 'lte' THEN
        clause := clause || format(' AND %I <= %L', col, val);
      ELSIF op = 'gt' THEN
        clause := clause || format(' AND %I > %L', col, val);
      ELSIF op = 'ilike' THEN
        clause := clause || format(' AND %I ILIKE %L', col, '%' || val || '%');
      ELSIF op = 'is' THEN
        clause := clause || format(' AND %I IS NULL', col);
      ELSIF op = 'not_is' THEN
        clause := clause || format(' AND %I IS NOT NULL', col);
      ELSIF op = 'not_ilike' THEN
        clause := clause || format(' AND %I NOT ILIKE %L', col, '%' || val || '%');
      END IF;
      CONTINUE;
    END IF;

    IF op = 'or_ilike' THEN
      cols := ARRAY(SELECT jsonb_array_elements_text(cond->'columns'));
      val := cond->>'value';
      ilike_parts := ARRAY[]::text[];
      FOREACH c IN ARRAY cols LOOP
        IF public.inbox_filter_allowed_column(c) THEN
          ilike_parts := array_append(ilike_parts, format('%I ILIKE %L', c, '%' || val || '%'));
        END IF;
      END LOOP;
      IF array_length(ilike_parts, 1) IS NOT NULL THEN
        clause := clause || ' AND (' || array_to_string(ilike_parts, ' OR ') || ')';
      END IF;
      CONTINUE;
    END IF;

    IF op IN ('flag_any','flag_all','flag_exclude') THEN
      cols := ARRAY(SELECT jsonb_array_elements_text(cond->'columns'));
      vals := ARRAY(SELECT jsonb_array_elements_text(cond->'values'));
      flag_parts := ARRAY[]::text[];
      FOREACH v IN ARRAY vals LOOP
        FOREACH c IN ARRAY cols LOOP
          IF public.inbox_filter_allowed_column(c) THEN
            flag_parts := array_append(flag_parts, format('%I ILIKE %L', c, '%' || v || '%'));
          END IF;
        END LOOP;
      END LOOP;
      IF array_length(flag_parts, 1) IS NOT NULL THEN
        IF op = 'flag_all' THEN
          FOREACH v IN ARRAY vals LOOP
            clause := clause || ' AND (' || array_to_string(
              ARRAY(
                SELECT format('%I ILIKE %L', c, '%' || v || '%')
                FROM unnest(cols) AS c
                WHERE public.inbox_filter_allowed_column(c)
              ),
              ' OR '
            ) || ')';
          END LOOP;
        ELSIF op = 'flag_any' THEN
          clause := clause || ' AND (' || array_to_string(flag_parts, ' OR ') || ')';
        ELSE
          FOREACH v IN ARRAY vals LOOP
            FOREACH c IN ARRAY cols LOOP
              IF public.inbox_filter_allowed_column(c) THEN
                clause := clause || format(' AND %I NOT ILIKE %L', c, '%' || v || '%');
              END IF;
            END LOOP;
          END LOOP;
        END IF;
      END IF;
    END IF;
  END LOOP;

  RETURN clause;
END;
$$;

CREATE OR REPLACE FUNCTION public.inbox_filter_field_options(
  p_field_kind text,
  p_column_name text DEFAULT NULL,
  p_conditions jsonb DEFAULT '[]'::jsonb,
  p_search text DEFAULT NULL,
  p_preserve_values text[] DEFAULT ARRAY[]::text[]
)
RETURNS TABLE(value text, label text, count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  where_sql text;
  search_sql text := '';
  query text;
BEGIN
  where_sql := public.inbox_filter_apply_conditions(p_conditions);

  IF p_search IS NOT NULL AND btrim(p_search) <> '' THEN
    search_sql := format(' AND value ILIKE %L', '%' || btrim(p_search) || '%');
  END IF;

  IF p_field_kind = 'property_flags' THEN
    query := format($SQL$
      WITH scoped AS (
        SELECT thread_key, property_flags_json, property_flags_text
        FROM public.inbox_hydrated_scoped
        WHERE %s
      ),
      exploded AS (
        SELECT s.thread_key, btrim(flag_txt) AS value
        FROM scoped s
        CROSS JOIN LATERAL (
          SELECT jsonb_array_elements_text(
            CASE
              WHEN s.property_flags_json IS NOT NULL
                AND s.property_flags_json <> '[]'::jsonb
                AND jsonb_typeof(s.property_flags_json) = 'array'
              THEN s.property_flags_json
              ELSE to_jsonb(regexp_split_to_array(COALESCE(s.property_flags_text, ''), '[,|;]+'))
            END
          ) AS flag_txt
        ) f
        WHERE btrim(flag_txt) <> ''
      ),
      grouped AS (
        SELECT value, COUNT(DISTINCT thread_key)::bigint AS count
        FROM exploded
        GROUP BY value
      )
      SELECT g.value, g.value AS label, g.count
      FROM grouped g
      WHERE TRUE %s
      UNION
      SELECT pv, pv, 0::bigint
      FROM unnest($1::text[]) AS pv
      WHERE pv IS NOT NULL AND btrim(pv) <> ''
        AND NOT EXISTS (SELECT 1 FROM grouped g WHERE g.value = pv)
      ORDER BY count DESC, label ASC
    $SQL$, where_sql, search_sql);
    RETURN QUERY EXECUTE query USING p_preserve_values;
    RETURN;
  END IF;

  IF p_field_kind = 'person_flags' THEN
    query := format($SQL$
      WITH scoped AS (
        SELECT thread_key, person_flags_json, person_flags_text
        FROM public.inbox_hydrated_scoped
        WHERE %s
      ),
      exploded AS (
        SELECT s.thread_key, btrim(flag_txt) AS value
        FROM scoped s
        CROSS JOIN LATERAL (
          SELECT jsonb_array_elements_text(
            CASE
              WHEN s.person_flags_json IS NOT NULL
                AND s.person_flags_json <> '[]'::jsonb
                AND jsonb_typeof(s.person_flags_json) = 'array'
              THEN s.person_flags_json
              ELSE to_jsonb(regexp_split_to_array(COALESCE(s.person_flags_text, ''), '[,|;]+'))
            END
          ) AS flag_txt
        ) f
        WHERE btrim(flag_txt) <> ''
      ),
      grouped AS (
        SELECT value, COUNT(DISTINCT thread_key)::bigint AS count
        FROM exploded
        GROUP BY value
      )
      SELECT g.value, g.value AS label, g.count
      FROM grouped g
      WHERE TRUE %s
      UNION
      SELECT pv, pv, 0::bigint
      FROM unnest($1::text[]) AS pv
      WHERE pv IS NOT NULL AND btrim(pv) <> ''
        AND NOT EXISTS (SELECT 1 FROM grouped g WHERE g.value = pv)
      ORDER BY count DESC, label ASC
    $SQL$, where_sql, search_sql);
    RETURN QUERY EXECUTE query USING p_preserve_values;
    RETURN;
  END IF;

  IF p_field_kind <> 'column' OR NOT public.inbox_filter_allowed_column(p_column_name) THEN
    RAISE EXCEPTION 'inbox_filter_invalid_field:%:%', p_field_kind, p_column_name;
  END IF;

  query := format($SQL$
    WITH scoped AS (
      SELECT thread_key, %I AS value
      FROM public.inbox_hydrated_scoped
      WHERE %s
        AND %I IS NOT NULL
        AND btrim(%I::text) <> ''
    ),
    grouped AS (
      SELECT value::text AS value, COUNT(DISTINCT thread_key)::bigint AS count
      FROM scoped
      GROUP BY value
    )
    SELECT g.value, g.value AS label, g.count
    FROM grouped g
    WHERE TRUE %s
    UNION
    SELECT pv, pv, 0::bigint
    FROM unnest($1::text[]) AS pv
    WHERE pv IS NOT NULL AND btrim(pv) <> ''
      AND NOT EXISTS (SELECT 1 FROM grouped g WHERE g.value = pv)
    ORDER BY count DESC, label ASC
  $SQL$, p_column_name, where_sql, p_column_name, p_column_name, search_sql);

  RETURN QUERY EXECUTE query USING p_preserve_values;
END;
$$;

CREATE OR REPLACE FUNCTION public.inbox_filter_match_count(
  p_conditions jsonb DEFAULT '[]'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  where_sql text;
  result bigint;
BEGIN
  where_sql := public.inbox_filter_apply_conditions(p_conditions);
  EXECUTE format(
    'SELECT COUNT(DISTINCT thread_key)::bigint FROM public.inbox_hydrated_scoped WHERE %s',
    where_sql
  ) INTO result;
  RETURN COALESCE(result, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.inbox_filter_field_options(text, text, jsonb, text, text[]) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.inbox_filter_match_count(jsonb) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.inbox_filter_apply_conditions(jsonb) TO authenticated, anon, service_role;

COMMIT;