-- Campaign target graph: include every property in campaign audits.
--
-- Existing direct/fallback refresh phases intentionally build reachable
-- seller/phone paths. Campaign planning also needs the full property universe,
-- so this complement phase inserts one non-sendable graph row for every
-- property that did not already produce a reachable graph row.

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_property_universe_batch(
  p_run_id uuid,
  p_batch_limit integer DEFAULT 10000,
  p_batch_offset integer DEFAULT 0,
  p_state text DEFAULT NULL,
  p_market text DEFAULT NULL
)
RETURNS TABLE(
  run_id uuid,
  batch_number integer,
  batch_type text,
  batch_key text,
  batch_start text,
  batch_end text,
  source_rows integer,
  rows_inserted integer,
  stage_rows integer,
  has_more boolean,
  elapsed_ms integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_started_at timestamptz := clock_timestamp();
  v_batch_id uuid;
  v_batch_number integer;
  v_batch_type text := 'property_universe_offset';
  v_batch_key text;
  v_batch_start text;
  v_batch_end text;
  v_source_rows integer := 0;
  v_rows_inserted integer := 0;
  v_stage_rows integer := 0;
  v_has_more boolean := false;
  v_elapsed_ms integer := 0;
  v_limit integer := LEAST(GREATEST(COALESCE(p_batch_limit, 10000), 1), 50000);
  v_offset integer := GREATEST(COALESCE(p_batch_offset, 0), 0);
  v_state text := NULLIF(upper(trim(COALESCE(p_state, ''))), '');
  v_market text := NULLIF(trim(COALESCE(p_market, '')), '');
  v_run_exists boolean := false;
BEGIN
  PERFORM set_config('statement_timeout', '0', true);
  PERFORM set_config('work_mem', '128MB', true);

  SELECT EXISTS (
    SELECT 1
    FROM public.campaign_target_graph_refresh_runs r
    WHERE r.id = p_run_id
      AND r.status = 'started'
  )
  INTO v_run_exists;

  IF NOT v_run_exists THEN
    RAISE EXCEPTION 'campaign target graph refresh run % is not active', p_run_id;
  END IF;

  IF v_state IS NOT NULL THEN
    v_batch_type := 'state_property_universe_offset';
  ELSIF v_market IS NOT NULL THEN
    v_batch_type := 'market_property_universe_offset';
  END IF;

  v_batch_key := concat(
    'property_universe_offset:', v_offset,
    ':limit:', v_limit,
    CASE WHEN v_state IS NOT NULL THEN concat(':state:', v_state) ELSE '' END,
    CASE WHEN v_market IS NOT NULL THEN concat(':market:', v_market) ELSE '' END
  );

  SELECT COALESCE(MAX(b.batch_number), 0) + 1
  INTO v_batch_number
  FROM public.campaign_target_graph_refresh_batches b
  WHERE b.run_id = p_run_id;

  WITH remaining_properties AS (
    SELECT
      p.property_id,
      p.property_export_id,
      p.property_export_id AS sort_key
    FROM public.properties p
    WHERE (v_state IS NULL OR upper(COALESCE(NULLIF(p.property_state, ''), NULLIF(p.property_address_state, ''))) = v_state)
      AND (v_market IS NULL OR p.market = v_market)
      AND NOT EXISTS (
        SELECT 1
        FROM public.campaign_target_graph_stage s
        WHERE s.property_export_id = p.property_export_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.campaign_target_graph_stage s
        WHERE s.property_id = p.property_id
      )
    ORDER BY
      p.property_export_id
    LIMIT v_limit OFFSET v_offset
  )
  SELECT
    COUNT(*)::integer,
    (array_agg(sort_key ORDER BY sort_key NULLS LAST))[1],
    (array_agg(sort_key ORDER BY sort_key DESC NULLS LAST))[1]
  INTO v_source_rows, v_batch_start, v_batch_end
  FROM remaining_properties;

  INSERT INTO public.campaign_target_graph_refresh_batches (
    run_id,
    batch_number,
    batch_type,
    batch_key,
    batch_start,
    batch_end,
    status,
    metadata
  )
  VALUES (
    p_run_id,
    v_batch_number,
    v_batch_type,
    v_batch_key,
    v_batch_start,
    v_batch_end,
    'started',
    jsonb_build_object(
      'batch_limit', v_limit,
      'batch_offset', v_offset,
      'batch_state', v_state,
      'batch_market', v_market,
      'source_rows', v_source_rows,
      'graph_path', 'properties_all_unmatched_rows',
      'property_universe_enabled', true,
      'phone_required', false
    )
  )
  RETURNING id INTO v_batch_id;

  IF v_source_rows = 0 THEN
    v_elapsed_ms := GREATEST(0, floor(EXTRACT(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer);
    SELECT COUNT(*)::integer INTO v_stage_rows FROM public.campaign_target_graph_stage;

    UPDATE public.campaign_target_graph_refresh_batches
    SET
      rows_inserted = 0,
      finished_at = clock_timestamp(),
      elapsed_ms = v_elapsed_ms,
      status = 'completed',
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'has_more', false,
        'stage_rows_after_batch', v_stage_rows,
        'remaining_after_batch', 0
      )
    WHERE id = v_batch_id;

    UPDATE public.campaign_target_graph_refresh_runs
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_universe_batch_number', v_batch_number,
      'last_universe_batch_key', v_batch_key,
      'last_universe_has_more', false,
      'stage_rows', v_stage_rows,
      'property_universe_enabled', true
    )
    WHERE id = p_run_id;

    run_id := p_run_id;
    batch_number := v_batch_number;
    batch_type := v_batch_type;
    batch_key := v_batch_key;
    batch_start := v_batch_start;
    batch_end := v_batch_end;
    source_rows := v_source_rows;
    rows_inserted := 0;
    stage_rows := v_stage_rows;
    has_more := false;
    elapsed_ms := v_elapsed_ms;
    RETURN NEXT;
    RETURN;
  END IF;

  WITH property_batch AS (
    SELECT p.*
    FROM public.properties p
    WHERE (v_state IS NULL OR upper(COALESCE(NULLIF(p.property_state, ''), NULLIF(p.property_address_state, ''))) = v_state)
      AND (v_market IS NULL OR p.market = v_market)
      AND NOT EXISTS (
        SELECT 1
        FROM public.campaign_target_graph_stage s
        WHERE s.property_export_id = p.property_export_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.campaign_target_graph_stage s
        WHERE s.property_id = p.property_id
      )
    ORDER BY
      p.property_export_id
    LIMIT v_limit OFFSET v_offset
  ),
  universe_paths AS (
    SELECT
      md5(concat_ws('|',
        'property_universe',
        NULLIF(p.property_id, ''),
        NULLIF(p.property_export_id, ''),
        NULLIF(p.master_owner_id, '')
      )) AS graph_id,
      p.property_id::text AS property_id,
      p.property_export_id::text AS property_export_id,
      p.master_owner_id::text AS master_owner_id,
      NULL::text AS prospect_id,
      NULL::text AS canonical_prospect_id,
      NULL::text AS phone_id,
      NULL::text AS canonical_e164,
      NULLIF(p.market, '') AS market,
      COALESCE(NULLIF(p.property_state, ''), NULLIF(p.property_address_state, '')) AS state,
      p.property_address_city::text AS property_city,
      COALESCE(NULLIF(p.property_zip, ''), NULLIF(p.property_address_zip, '')) AS property_zip,
      COALESCE(NULLIF(p.property_county_name, ''), NULLIF(p.property_address_county_name, '')) AS property_county_name,
      p.property_type::text AS property_type,
      p.property_class::text AS property_class,
      COALESCE(
        NULLIF(to_jsonb(p)->>'canonical_property_group', ''),
        NULLIF(p.property_group, ''),
        NULLIF(p.normalized_asset_class, ''),
        NULLIF(p.asset_type_label, ''),
        NULLIF(p.property_class, ''),
        NULLIF(p.property_type, '')
      ) AS canonical_property_group,
      NULL::text AS language,
      NULL::text AS age_bucket,
      NULL::text AS occupation_group,
      NULL::text AS education_model,
      NULL::text AS income,
      COALESCE(NULLIF(p.owner_type_guess, ''), NULLIF(p.owner_type, '')) AS owner_type_guess,
      NULLIF(p.priority_tier, '') AS priority_tier,
      NULL::text AS follow_up_cadence,
      COALESCE(NULLIF(p.rehab_level, ''), NULLIF(p.renovation_level_classification, ''), NULLIF(p.building_condition, '')) AS rehab_level,
      false AS sms_eligible,
      false AS true_post_contact_suppression,
      false AS wrong_number,
      false AS pending_prior_touch,
      false AS active_queue_item,
      sm.sender_market IS NOT NULL AS sender_covered,
      sm.sender_market,
      NULL::text AS timezone,
      NULL::numeric AS best_phone_score,
      NULL::text AS phone_owner,
      NULL::text AS phone_activity_status,
      NULL::text AS usage_12_months,
      NULL::text AS usage_2_months,
      'ownership_check'::text AS template_use_case,
      NULL::text AS contact_window,
      NULL::timestamptz AS latest_contact_at,
      NULL::timestamptz AS last_outbound_at,
      NULL::timestamptz AS last_inbound_at,
      CASE WHEN sm.sender_market IS NOT NULL THEN 'exact_market_match' ELSE 'no_sender_route' END AS routing_tier,
      'property_only'::text AS identity_alignment,
      p.final_acquisition_score AS acquisition_score,
      COALESCE(NULLIF(p.seller_tags_text, ''), NULLIF(p.podio_tags, '')) AS podio_tags,
      '{}'::jsonb AS matching_flags,
      NULL::text AS matching_flags_text,
      COALESCE(NULLIF(p.owner_display_name, ''), NULLIF(p.owner_name, '')) AS owner_name,
      NULL::text AS seller_first_name,
      NULL::text AS seller_full_name,
      COALESCE(NULLIF(p.property_address_full, ''), NULLIF(p.property_address, '')) AS property_address_full,
      p.estimated_value,
      p.equity_amount,
      p.equity_percent,
      p.cash_offer,
      0::integer AS touch_count,
      1::integer AS current_touch_number,
      true AS never_contacted,
      false AS queue_eligible,
      'missing_phone'::text AS queue_block_reason,
      jsonb_build_object(
        'property', CASE WHEN p.property_id IS NOT NULL THEN 1 ELSE 0 END,
        'master_owner', CASE WHEN p.master_owner_id IS NOT NULL THEN 1 ELSE 0 END,
        'prospect', 0,
        'phone', 0,
        'sender_numbers', COALESCE(sm.sender_count, 0)
      ) AS linkage_counts,
      to_jsonb(p) AS property_data,
      COALESCE(p.updated_at, p.created_at, now()) AS source_updated_at
    FROM property_batch p
    LEFT JOIN LATERAL (
      SELECT
        tn.market AS sender_market,
        COUNT(*)::integer AS sender_count
      FROM public.textgrid_numbers tn
      WHERE tn.market = NULLIF(p.market, '')
        AND NULLIF(tn.phone_number, '') IS NOT NULL
        AND lower(COALESCE(tn.status, 'active')) NOT IN ('disabled', 'inactive', 'failed', 'blocked', 'retired')
      GROUP BY tn.market
    ) sm ON NULLIF(p.market, '') IS NOT NULL
  )
  INSERT INTO public.campaign_target_graph_stage (
    graph_id,
    property_id,
    property_export_id,
    master_owner_id,
    prospect_id,
    canonical_prospect_id,
    phone_id,
    canonical_e164,
    market,
    state,
    property_city,
    property_zip,
    property_county_name,
    property_type,
    property_class,
    canonical_property_group,
    language,
    age_bucket,
    occupation_group,
    education_model,
    income,
    owner_type_guess,
    priority_tier,
    follow_up_cadence,
    rehab_level,
    sms_eligible,
    true_post_contact_suppression,
    wrong_number,
    pending_prior_touch,
    active_queue_item,
    sender_covered,
    sender_market,
    timezone,
    best_phone_score,
    phone_owner,
    phone_activity_status,
    usage_12_months,
    usage_2_months,
    template_use_case,
    contact_window,
    latest_contact_at,
    last_outbound_at,
    last_inbound_at,
    routing_tier,
    identity_alignment,
    acquisition_score,
    podio_tags,
    matching_flags,
    matching_flags_text,
    owner_name,
    seller_first_name,
    seller_full_name,
    property_address_full,
    estimated_value,
    equity_amount,
    equity_percent,
    cash_offer,
    touch_count,
    current_touch_number,
    never_contacted,
    queue_eligible,
    queue_block_reason,
    graph_source,
    linkage_counts,
    blocker_flags,
    extra_data,
    source_updated_at,
    generated_at
  )
  SELECT
    graph_id,
    property_id,
    property_export_id,
    master_owner_id,
    prospect_id,
    canonical_prospect_id,
    phone_id,
    canonical_e164,
    market,
    state,
    property_city,
    property_zip,
    property_county_name,
    property_type,
    property_class,
    canonical_property_group,
    language,
    age_bucket,
    occupation_group,
    education_model,
    income,
    owner_type_guess,
    priority_tier,
    follow_up_cadence,
    rehab_level,
    sms_eligible,
    true_post_contact_suppression,
    wrong_number,
    pending_prior_touch,
    active_queue_item,
    sender_covered,
    sender_market,
    timezone,
    best_phone_score,
    phone_owner,
    phone_activity_status,
    usage_12_months,
    usage_2_months,
    template_use_case,
    contact_window,
    latest_contact_at,
    last_outbound_at,
    last_inbound_at,
    routing_tier,
    identity_alignment,
    acquisition_score,
    podio_tags,
    matching_flags,
    matching_flags_text,
    owner_name,
    seller_first_name,
    seller_full_name,
    property_address_full,
    estimated_value,
    equity_amount,
    equity_percent,
    cash_offer,
    touch_count,
    current_touch_number,
    never_contacted,
    queue_eligible,
    queue_block_reason,
    'campaign_target_graph.refresh.property_universe' AS graph_source,
    linkage_counts,
    jsonb_build_object(
      'sms_eligible', sms_eligible,
      'true_post_contact_suppression', true_post_contact_suppression,
      'wrong_number', wrong_number,
      'pending_prior_touch', pending_prior_touch,
      'active_queue_item', active_queue_item,
      'sender_covered', sender_covered,
      'missing_phone', true
    ) AS blocker_flags,
    jsonb_strip_nulls(jsonb_build_object(
      'property', property_data
    )) AS extra_data,
    source_updated_at,
    now() AS generated_at
  FROM universe_paths
  ON CONFLICT (graph_id) DO UPDATE SET
    graph_source = EXCLUDED.graph_source,
    generated_at = EXCLUDED.generated_at,
    source_updated_at = EXCLUDED.source_updated_at;

  GET DIAGNOSTICS v_rows_inserted = ROW_COUNT;

  SELECT COUNT(*)::integer INTO v_stage_rows FROM public.campaign_target_graph_stage;
  v_has_more := v_rows_inserted >= v_limit;

  v_elapsed_ms := GREATEST(0, floor(EXTRACT(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer);

  UPDATE public.campaign_target_graph_refresh_batches
  SET
    rows_inserted = v_rows_inserted,
    finished_at = clock_timestamp(),
    elapsed_ms = v_elapsed_ms,
    status = 'completed',
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'has_more', v_has_more,
      'stage_rows_after_batch', v_stage_rows,
      'remaining_after_batch', NULL,
      'has_more_strategy', 'full_batch_probe'
    )
  WHERE id = v_batch_id;

  UPDATE public.campaign_target_graph_refresh_runs
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'last_universe_batch_number', v_batch_number,
    'last_universe_batch_key', v_batch_key,
    'last_universe_has_more', v_has_more,
    'stage_rows', v_stage_rows,
    'property_universe_enabled', true
  )
  WHERE id = p_run_id;

  run_id := p_run_id;
  batch_number := v_batch_number;
  batch_type := v_batch_type;
  batch_key := v_batch_key;
  batch_start := v_batch_start;
  batch_end := v_batch_end;
  source_rows := v_source_rows;
  rows_inserted := v_rows_inserted;
  stage_rows := v_stage_rows;
  has_more := v_has_more;
  elapsed_ms := v_elapsed_ms;
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  v_elapsed_ms := GREATEST(0, floor(EXTRACT(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer);

  IF v_batch_id IS NOT NULL THEN
    UPDATE public.campaign_target_graph_refresh_batches
    SET
      finished_at = clock_timestamp(),
      elapsed_ms = v_elapsed_ms,
      status = 'failed',
      error_message = SQLERRM,
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('error_sqlstate', SQLSTATE)
    WHERE id = v_batch_id;
  END IF;

  UPDATE public.campaign_target_graph_refresh_runs
  SET
    status = 'failed',
    finished_at = now(),
    error_message = SQLERRM,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_failed_universe_batch_key', v_batch_key,
      'last_error_sqlstate', SQLSTATE
    )
  WHERE id = p_run_id;

  RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_property_universe_batch(uuid, integer, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph_property_universe_batch(uuid, integer, integer, text, text) TO service_role;
