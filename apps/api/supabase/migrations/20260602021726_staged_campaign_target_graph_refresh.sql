-- Staged/batched campaign target graph refresh.
--
-- The direct core path is intentionally narrow:
-- properties -> master_owners -> prospects -> best phone.
-- Missing-owner JSON fallback stays outside this direct refresh path.

CREATE TABLE IF NOT EXISTS public.campaign_target_graph_stage
(LIKE public.campaign_target_graph INCLUDING ALL);

CREATE TABLE IF NOT EXISTS public.campaign_target_graph_refresh_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.campaign_target_graph_refresh_runs(id) ON DELETE CASCADE,
  batch_number integer NOT NULL,
  batch_type text NOT NULL,
  batch_key text NOT NULL,
  batch_start text,
  batch_end text,
  rows_inserted integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  elapsed_ms integer,
  status text NOT NULL DEFAULT 'started',
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT campaign_target_graph_refresh_batches_status_check
    CHECK (status IN ('started', 'completed', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_target_graph_stage_graph_id
  ON public.campaign_target_graph_stage (graph_id);
CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_stage_property_id
  ON public.campaign_target_graph_stage (property_id);
CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_stage_market
  ON public.campaign_target_graph_stage (market);
CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_stage_state
  ON public.campaign_target_graph_stage (state);
CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_stage_property_type
  ON public.campaign_target_graph_stage (property_type);
CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_stage_queue_eligibility
  ON public.campaign_target_graph_stage (queue_eligible, sender_covered, sms_eligible, active_queue_item);
CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_stage_generated_at
  ON public.campaign_target_graph_stage (generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_refresh_batches_run
  ON public.campaign_target_graph_refresh_batches (run_id, batch_number);
CREATE INDEX IF NOT EXISTS idx_campaign_target_graph_refresh_batches_status
  ON public.campaign_target_graph_refresh_batches (status, started_at DESC);

ALTER TABLE public.campaign_target_graph_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_target_graph_refresh_batches ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'campaign_target_graph_stage'
      AND policyname = 'campaign_target_graph_stage_service_role_all'
  ) THEN
    CREATE POLICY campaign_target_graph_stage_service_role_all
      ON public.campaign_target_graph_stage
      FOR ALL TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'campaign_target_graph_refresh_batches'
      AND policyname = 'campaign_target_graph_refresh_batches_service_role_all'
  ) THEN
    CREATE POLICY campaign_target_graph_refresh_batches_service_role_all
      ON public.campaign_target_graph_refresh_batches
      FOR ALL TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END
$$;

REVOKE ALL ON public.campaign_target_graph_stage FROM anon, authenticated;
REVOKE ALL ON public.campaign_target_graph_refresh_batches FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.campaign_target_graph_stage TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_target_graph_refresh_batches TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_stage_start()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id uuid;
BEGIN
  TRUNCATE TABLE public.campaign_target_graph_stage;

  INSERT INTO public.campaign_target_graph_refresh_runs (status, metadata)
  VALUES (
    'started',
    jsonb_build_object(
      'source', 'refresh_campaign_target_graph_stage_start',
      'refresh_strategy', 'staged_property_offset_batches',
      'graph_path', 'properties_master_owners_prospects_phones',
      'graph_refresh_scope', 'partial',
      'fallback_enabled', false,
      'direct_core_only', true
    )
  )
  RETURNING id INTO v_run_id;

  RETURN v_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_stage_batch(
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
  v_batch_type text := 'property_offset';
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
    v_batch_type := 'state_property_offset';
  ELSIF v_market IS NOT NULL THEN
    v_batch_type := 'market_property_offset';
  END IF;

  v_batch_key := concat(
    'property_offset:', v_offset,
    ':limit:', v_limit,
    CASE WHEN v_state IS NOT NULL THEN concat(':state:', v_state) ELSE '' END,
    CASE WHEN v_market IS NOT NULL THEN concat(':market:', v_market) ELSE '' END
  );

  SELECT COALESCE(MAX(b.batch_number), 0) + 1
  INTO v_batch_number
  FROM public.campaign_target_graph_refresh_batches b
  WHERE b.run_id = p_run_id;

  WITH batch_keys AS (
    SELECT
      COALESCE(NULLIF(p.property_id, ''), NULLIF(p.property_export_id, '')) AS sort_key
    FROM public.properties p
    WHERE NULLIF(p.master_owner_id, '') IS NOT NULL
      AND (v_state IS NULL OR upper(COALESCE(NULLIF(p.property_state, ''), NULLIF(p.property_address_state, ''))) = v_state)
      AND (v_market IS NULL OR p.market = v_market)
    ORDER BY
      COALESCE(NULLIF(p.property_id, ''), NULLIF(p.property_export_id, '')) NULLS LAST,
      p.property_export_id NULLS LAST
    LIMIT v_limit OFFSET v_offset
  )
  SELECT
    COUNT(*)::integer,
    (array_agg(sort_key ORDER BY sort_key NULLS LAST))[1],
    (array_agg(sort_key ORDER BY sort_key DESC NULLS LAST))[1]
  INTO v_source_rows, v_batch_start, v_batch_end
  FROM batch_keys;

  SELECT EXISTS (
    SELECT 1
    FROM public.properties p
    WHERE NULLIF(p.master_owner_id, '') IS NOT NULL
      AND (v_state IS NULL OR upper(COALESCE(NULLIF(p.property_state, ''), NULLIF(p.property_address_state, ''))) = v_state)
      AND (v_market IS NULL OR p.market = v_market)
    ORDER BY
      COALESCE(NULLIF(p.property_id, ''), NULLIF(p.property_export_id, '')) NULLS LAST,
      p.property_export_id NULLS LAST
    LIMIT 1 OFFSET (v_offset + v_limit)
  )
  INTO v_has_more;

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
      'graph_path', 'properties_master_owners_prospects_phones',
      'phone_join_strategy', 'primary_prospect_id_then_canonical_prospect_id_then_master_owner_id'
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
        'stage_rows_after_batch', v_stage_rows
      )
    WHERE id = v_batch_id;

    UPDATE public.campaign_target_graph_refresh_runs
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_batch_number', v_batch_number,
      'last_batch_key', v_batch_key,
      'last_has_more', false,
      'completed_all_batches', true,
      'stage_rows', v_stage_rows
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
    WHERE NULLIF(p.master_owner_id, '') IS NOT NULL
      AND (v_state IS NULL OR upper(COALESCE(NULLIF(p.property_state, ''), NULLIF(p.property_address_state, ''))) = v_state)
      AND (v_market IS NULL OR p.market = v_market)
    ORDER BY
      COALESCE(NULLIF(p.property_id, ''), NULLIF(p.property_export_id, '')) NULLS LAST,
      p.property_export_id NULLS LAST
    LIMIT v_limit OFFSET v_offset
  ),
  owner_paths AS (
    SELECT
      ROW(p.*)::public.properties AS p,
      ROW(mo.*)::public.master_owners AS mo
    FROM property_batch p
    JOIN public.master_owners mo
      ON mo.master_owner_id = p.master_owner_id
  ),
  prospect_paths AS (
    SELECT
      op.p,
      op.mo,
      pr.pr_row AS pr,
      pr.link_rank AS prospect_link_rank
    FROM owner_paths op
    CROSS JOIN LATERAL (SELECT (op.mo).*) mo
    JOIN LATERAL (
      SELECT candidate.pr_row, candidate.link_rank
      FROM (
        SELECT ROW(pr.*)::public.prospects AS pr_row, 1 AS link_rank
        FROM public.prospects pr
        WHERE mo.best_prospect_id IS NOT NULL
          AND pr.prospect_id = mo.best_prospect_id
        UNION ALL
        SELECT ROW(pr.*)::public.prospects AS pr_row, 2 AS link_rank
        FROM public.prospects pr
        WHERE mo.best_canonical_prospect_id IS NOT NULL
          AND pr.canonical_prospect_id = mo.best_canonical_prospect_id
        UNION ALL
        SELECT ROW(pr.*)::public.prospects AS pr_row, 3 AS link_rank
        FROM public.prospects pr
        WHERE pr.master_owner_id = mo.master_owner_id
      ) candidate
      ORDER BY
        candidate.link_rank,
        COALESCE((candidate.pr_row).is_primary_prospect, false) DESC,
        (candidate.pr_row).rank_position NULLS LAST,
        (candidate.pr_row).phone_score_final DESC NULLS LAST,
        (candidate.pr_row).contact_score_final DESC NULLS LAST,
        COALESCE((candidate.pr_row).updated_at, (candidate.pr_row).created_at) DESC NULLS LAST
      LIMIT 1
    ) pr ON true
  ),
  target_paths AS (
    SELECT
      md5(concat_ws('|',
        NULLIF(p.property_id, ''),
        NULLIF(p.property_export_id, ''),
        NULLIF(COALESCE(mo.master_owner_id, p.master_owner_id), ''),
        NULLIF(COALESCE(pr.prospect_id::text, ph.primary_prospect_id::text, ph.canonical_prospect_id::text), ''),
        NULLIF(ph.phone_id::text, ''),
        NULLIF(ph.canonical_e164, '')
      )) AS graph_id,
      p.property_id::text AS property_id,
      p.property_export_id::text AS property_export_id,
      COALESCE(mo.master_owner_id, p.master_owner_id)::text AS master_owner_id,
      COALESCE(pr.prospect_id::text, ph.primary_prospect_id::text, ph.canonical_prospect_id::text) AS prospect_id,
      COALESCE(pr.canonical_prospect_id::text, ph.canonical_prospect_id::text) AS canonical_prospect_id,
      ph.phone_id::text AS phone_id,
      ph.canonical_e164::text AS canonical_e164,
      graph_market.market AS market,
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
      COALESCE(NULLIF(pr.language_preference, ''), NULLIF(mo.best_language, ''), NULLIF(ph.linked_languages_text, '')) AS language,
      public.campaign_age_bucket_from_mob(pr.mob::text) AS age_bucket,
      pr.occupation_group::text AS occupation_group,
      pr.education_model::text AS education_model,
      pr.est_household_income::text AS income,
      COALESCE(NULLIF(mo.owner_type_guess, ''), NULLIF(pr.owner_type_guess, ''), NULLIF(p.owner_type_guess, ''), NULLIF(p.owner_type, '')) AS owner_type_guess,
      COALESCE(NULLIF(mo.priority_tier, ''), NULLIF(pr.priority_tier, ''), NULLIF(p.priority_tier, '')) AS priority_tier,
      mo.follow_up_cadence::text AS follow_up_cadence,
      COALESCE(NULLIF(p.rehab_level, ''), NULLIF(p.renovation_level_classification, ''), NULLIF(p.building_condition, '')) AS rehab_level,
      (
        ph.canonical_e164 IS NOT NULL
        AND COALESCE(ph.phone_contact_status, '') IS DISTINCT FROM 'wrong_number'
      ) AS sms_eligible,
      COALESCE(sup.is_suppressed, false) AS true_post_contact_suppression,
      (
        COALESCE(ph.phone_contact_status, '') = 'wrong_number'
        OR ph.wrong_number_at IS NOT NULL
      ) AS wrong_number,
      (
        latest.last_outbound_at IS NOT NULL
        AND latest.last_outbound_at >= now() - interval '30 days'
      ) AS pending_prior_touch,
      COALESCE(aq.active_queue_count, 0) > 0 AS active_queue_item,
      sm.sender_market IS NOT NULL AS sender_covered,
      sm.sender_market,
      COALESCE(NULLIF(ph.timezone, ''), NULLIF(pr.timezone, ''), NULLIF(mo.routing_timezone, '')) AS timezone,
      ph.best_phone_score,
      ph.phone_owner,
      ph.activity_status AS phone_activity_status,
      ph.usage_12_months::text AS usage_12_months,
      ph.usage_2_months::text AS usage_2_months,
      'ownership_check'::text AS template_use_case,
      COALESCE(NULLIF(ph.contact_window, ''), NULLIF(pr.contact_window, ''), NULLIF(mo.best_contact_window, '')) AS contact_window,
      NULLIF(GREATEST(
        COALESCE(latest.last_outbound_at, 'epoch'::timestamptz),
        COALESCE(latest.last_inbound_at, 'epoch'::timestamptz)
      ), 'epoch'::timestamptz) AS latest_contact_at,
      latest.last_outbound_at,
      latest.last_inbound_at,
      CASE WHEN sm.sender_market IS NOT NULL THEN 'exact_market_match' ELSE 'no_sender_route' END AS routing_tier,
      CASE
        WHEN COALESCE(pr.likely_owner, false) THEN 'verified'
        WHEN COALESCE(pr.likely_renting, false) THEN 'renter_risk'
        WHEN pr.prospect_id IS NOT NULL THEN 'probable'
        ELSE 'unknown'
      END AS identity_alignment,
      COALESCE(p.final_acquisition_score, mo.priority_score, pr.master_owner_priority_score) AS acquisition_score,
      COALESCE(NULLIF(p.seller_tags_text, ''), NULLIF(p.podio_tags, ''), NULLIF(mo.seller_tags_text, ''), NULLIF(pr.seller_tags_text, '')) AS podio_tags,
      jsonb_strip_nulls(jsonb_build_object(
        'matching_flags', pr.matching_flags,
        'person_flags_text', pr.person_flags_text,
        'person_flags_json', pr.person_flags_json
      )) AS matching_flags,
      COALESCE(NULLIF(pr.matching_flags, ''), NULLIF(pr.person_flags_text, '')) AS matching_flags_text,
      COALESCE(NULLIF(mo.display_name, ''), NULLIF(pr.owner_display_name, ''), NULLIF(p.owner_display_name, ''), NULLIF(p.owner_name, '')) AS owner_name,
      COALESCE(NULLIF(pr.first_name, ''), NULLIF(ph.phone_first_name, ''), split_part(NULLIF(COALESCE(pr.full_name, ph.phone_full_name, mo.display_name), ''), ' ', 1)) AS seller_first_name,
      COALESCE(NULLIF(pr.full_name, ''), NULLIF(ph.phone_full_name, ''), NULLIF(ph.primary_display_name, ''), NULLIF(mo.display_name, '')) AS seller_full_name,
      COALESCE(NULLIF(p.property_address_full, ''), NULLIF(p.property_address, '')) AS property_address_full,
      p.estimated_value,
      p.equity_amount,
      p.equity_percent,
      p.cash_offer,
      CASE WHEN latest.last_outbound_at IS NULL THEN 0 ELSE 1 END AS touch_count,
      CASE WHEN latest.last_outbound_at IS NULL THEN 1 ELSE 2 END AS current_touch_number,
      latest.last_outbound_at IS NULL AS never_contacted,
      jsonb_build_object(
        'property', CASE WHEN p.property_id IS NOT NULL THEN 1 ELSE 0 END,
        'master_owner', CASE WHEN mo.master_owner_id IS NOT NULL THEN 1 ELSE 0 END,
        'prospect', CASE WHEN pr.prospect_id IS NOT NULL THEN 1 ELSE 0 END,
        'phone', CASE WHEN ph.phone_id IS NOT NULL THEN 1 ELSE 0 END,
        'sender_numbers', COALESCE(sm.sender_count, 0),
        'prospect_link_rank', prospect_paths.prospect_link_rank,
        'phone_link_rank', ph.link_rank
      ) AS linkage_counts,
      to_jsonb(p) AS property_data,
      to_jsonb(mo) AS master_owner_data,
      to_jsonb(pr) AS prospect_data,
      to_jsonb(ph) AS phone_data,
      sup.suppression_rows AS suppression_data,
      GREATEST(
        COALESCE(p.updated_at, p.created_at, 'epoch'::timestamptz),
        COALESCE(mo.updated_at, mo.created_at, 'epoch'::timestamptz),
        COALESCE(pr.updated_at, pr.created_at, 'epoch'::timestamptz),
        COALESCE(ph.updated_at, ph.created_at, 'epoch'::timestamptz),
        COALESCE(latest.last_outbound_at, 'epoch'::timestamptz),
        COALESCE(latest.last_inbound_at, 'epoch'::timestamptz),
        COALESCE(sm.latest_sender_update, 'epoch'::timestamptz),
        COALESCE(sup.latest_suppressed_at, 'epoch'::timestamptz)
      ) AS source_updated_at
    FROM prospect_paths
    CROSS JOIN LATERAL (SELECT (prospect_paths.p).*) p
    CROSS JOIN LATERAL (SELECT (prospect_paths.mo).*) mo
    CROSS JOIN LATERAL (SELECT (prospect_paths.pr).*) pr
    CROSS JOIN LATERAL (
      SELECT COALESCE(NULLIF(p.market, ''), NULLIF(mo.routing_market, ''), NULLIF(pr.primary_market, '')) AS market
    ) graph_market
    LEFT JOIN LATERAL (
      SELECT linked_ph.*
      FROM (
        SELECT ph.*, 1 AS link_rank
        FROM public.phones ph
        WHERE ph.canonical_e164 IS NOT NULL
          AND (
            ph.phone_type IS NULL
            OR ph.phone_type = ''
            OR lower(ph.phone_type) IN ('w', 'wireless', 'mobile', 'voip', 'unknown')
          )
          AND ph.primary_prospect_id = pr.prospect_id
        UNION ALL
        SELECT ph.*, 2 AS link_rank
        FROM public.phones ph
        WHERE ph.canonical_e164 IS NOT NULL
          AND (
            ph.phone_type IS NULL
            OR ph.phone_type = ''
            OR lower(ph.phone_type) IN ('w', 'wireless', 'mobile', 'voip', 'unknown')
          )
          AND ph.canonical_prospect_id = pr.canonical_prospect_id
        UNION ALL
        SELECT ph.*, 3 AS link_rank
        FROM public.phones ph
        WHERE ph.canonical_e164 IS NOT NULL
          AND (
            ph.phone_type IS NULL
            OR ph.phone_type = ''
            OR lower(ph.phone_type) IN ('w', 'wireless', 'mobile', 'voip', 'unknown')
          )
          AND ph.master_owner_id = mo.master_owner_id
      ) linked_ph
      ORDER BY
        linked_ph.link_rank,
        COALESCE(linked_ph.is_best_phone_for_slot, false) DESC,
        COALESCE(linked_ph.is_best_phone_for_owner, false) DESC,
        linked_ph.best_phone_score DESC NULLS LAST,
        COALESCE(linked_ph.updated_at, linked_ph.created_at) DESC NULLS LAST
      LIMIT 1
    ) ph ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::integer AS active_queue_count
      FROM public.send_queue sq
      WHERE sq.to_phone_number = ph.canonical_e164
        AND lower(COALESCE(sq.queue_status, '')) IN ('queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending')
    ) aq ON ph.canonical_e164 IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT
        MAX(last_inbound_at) AS last_inbound_at,
        MAX(last_outbound_at) AS last_outbound_at
      FROM (
        SELECT
          MAX(COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.created_at)) AS last_inbound_at,
          NULL::timestamptz AS last_outbound_at
        FROM public.message_events me
        WHERE me.from_phone_number = ph.canonical_e164
          AND lower(COALESCE(me.direction, '')) LIKE 'in%'
        UNION ALL
        SELECT
          NULL::timestamptz AS last_inbound_at,
          MAX(COALESCE(me.event_timestamp, me.sent_at, me.received_at, me.created_at)) AS last_outbound_at
        FROM public.message_events me
        WHERE me.to_phone_number = ph.canonical_e164
          AND lower(COALESCE(me.direction, '')) LIKE 'out%'
        UNION ALL
        SELECT
          NULL::timestamptz AS last_inbound_at,
          MAX(COALESCE(sq.sent_at, sq.scheduled_for_utc, sq.scheduled_for, sq.created_at)) AS last_outbound_at
        FROM public.send_queue sq
        WHERE sq.to_phone_number = ph.canonical_e164
      ) contact_events
    ) latest ON ph.canonical_e164 IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT
        bool_or(COALESCE(sl.is_active, true)) AS is_suppressed,
        MAX(COALESCE(sl.suppressed_at, sl.created_at)) AS latest_suppressed_at,
        jsonb_agg(to_jsonb(sl) ORDER BY COALESCE(sl.suppressed_at, sl.created_at) DESC NULLS LAST) AS suppression_rows
      FROM (
        SELECT sl.*
        FROM public.sms_suppression_list sl
        WHERE sl.phone_e164 = ph.canonical_e164
        UNION ALL
        SELECT sl.*
        FROM public.sms_suppression_list sl
        WHERE sl.phone_number = ph.canonical_e164
          AND sl.phone_e164 IS DISTINCT FROM ph.canonical_e164
      ) sl
    ) sup ON ph.canonical_e164 IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT
        tn.market AS sender_market,
        COUNT(*)::integer AS sender_count,
        MAX(tn.updated_at) AS latest_sender_update
      FROM public.textgrid_numbers tn
      WHERE tn.market = COALESCE(graph_market.market, ph.primary_market)
        AND NULLIF(tn.phone_number, '') IS NOT NULL
        AND lower(COALESCE(tn.status, 'active')) NOT IN ('disabled', 'inactive', 'failed', 'blocked', 'retired')
      GROUP BY tn.market
    ) sm ON COALESCE(graph_market.market, ph.primary_market) IS NOT NULL
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
    (
      sms_eligible
      AND NOT true_post_contact_suppression
      AND NOT wrong_number
      AND NOT pending_prior_touch
      AND NOT active_queue_item
      AND sender_covered
    ) AS queue_eligible,
    CASE
      WHEN NOT sms_eligible THEN 'sms_ineligible'
      WHEN true_post_contact_suppression THEN 'suppressed'
      WHEN wrong_number THEN 'wrong_number'
      WHEN pending_prior_touch THEN 'pending_prior_touch'
      WHEN active_queue_item THEN 'active_queue_item'
      WHEN NOT sender_covered THEN 'no_sender_coverage'
      ELSE NULL
    END AS queue_block_reason,
    'campaign_target_graph.refresh.direct_staged' AS graph_source,
    linkage_counts,
    jsonb_build_object(
      'sms_eligible', sms_eligible,
      'true_post_contact_suppression', true_post_contact_suppression,
      'wrong_number', wrong_number,
      'pending_prior_touch', pending_prior_touch,
      'active_queue_item', active_queue_item,
      'sender_covered', sender_covered
    ) AS blocker_flags,
    jsonb_strip_nulls(jsonb_build_object(
      'property', property_data,
      'master_owner', master_owner_data,
      'prospect', prospect_data,
      'phone', phone_data,
      'suppression', suppression_data
    )) AS extra_data,
    NULLIF(source_updated_at, 'epoch'::timestamptz) AS source_updated_at,
    now() AS generated_at
  FROM target_paths
  WHERE phone_id IS NOT NULL
    AND canonical_e164 IS NOT NULL
  ON CONFLICT (graph_id) DO UPDATE SET
    graph_source = EXCLUDED.graph_source,
    generated_at = EXCLUDED.generated_at,
    source_updated_at = EXCLUDED.source_updated_at;

  GET DIAGNOSTICS v_rows_inserted = ROW_COUNT;

  SELECT COUNT(*)::integer INTO v_stage_rows FROM public.campaign_target_graph_stage;
  v_elapsed_ms := GREATEST(0, floor(EXTRACT(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer);

  UPDATE public.campaign_target_graph_refresh_batches
  SET
    rows_inserted = v_rows_inserted,
    finished_at = clock_timestamp(),
    elapsed_ms = v_elapsed_ms,
    status = 'completed',
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'has_more', v_has_more,
      'stage_rows_after_batch', v_stage_rows
    )
  WHERE id = v_batch_id;

  UPDATE public.campaign_target_graph_refresh_runs
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'last_batch_number', v_batch_number,
    'last_batch_key', v_batch_key,
    'last_has_more', v_has_more,
    'completed_all_batches', NOT v_has_more,
    'stage_rows', v_stage_rows,
    'graph_refresh_scope', CASE WHEN v_has_more THEN 'partial' ELSE 'full' END
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
      'last_failed_batch_key', v_batch_key,
      'last_error_sqlstate', SQLSTATE
    )
  WHERE id = p_run_id;

  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_fallback_batch(
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
  v_batch_type text := 'missing_owner_json_property_offset';
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

  v_batch_key := concat(
    'fallback_property_offset:', v_offset,
    ':limit:', v_limit,
    CASE WHEN v_state IS NOT NULL THEN concat(':state:', v_state) ELSE '' END,
    CASE WHEN v_market IS NOT NULL THEN concat(':market:', v_market) ELSE '' END
  );

  SELECT COALESCE(MAX(b.batch_number), 0) + 1
  INTO v_batch_number
  FROM public.campaign_target_graph_refresh_batches b
  WHERE b.run_id = p_run_id;

  WITH batch_keys AS (
    SELECT
      COALESCE(NULLIF(p.property_id, ''), NULLIF(p.property_export_id, '')) AS sort_key
    FROM public.properties p
    WHERE (v_state IS NULL OR upper(COALESCE(NULLIF(p.property_state, ''), NULLIF(p.property_address_state, ''))) = v_state)
      AND (v_market IS NULL OR p.market = v_market)
      AND NOT EXISTS (
        SELECT 1
        FROM public.campaign_target_graph_stage s
        WHERE s.property_id = p.property_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.campaign_target_graph_stage s
        WHERE s.property_export_id = p.property_export_id
      )
    ORDER BY
      COALESCE(NULLIF(p.property_id, ''), NULLIF(p.property_export_id, '')) NULLS LAST,
      p.property_export_id NULLS LAST
    LIMIT v_limit OFFSET v_offset
  )
  SELECT
    COUNT(*)::integer,
    (array_agg(sort_key ORDER BY sort_key NULLS LAST))[1],
    (array_agg(sort_key ORDER BY sort_key DESC NULLS LAST))[1]
  INTO v_source_rows, v_batch_start, v_batch_end
  FROM batch_keys;

  SELECT EXISTS (
    SELECT 1
    FROM public.properties p
    WHERE (v_state IS NULL OR upper(COALESCE(NULLIF(p.property_state, ''), NULLIF(p.property_address_state, ''))) = v_state)
      AND (v_market IS NULL OR p.market = v_market)
      AND NOT EXISTS (
        SELECT 1
        FROM public.campaign_target_graph_stage s
        WHERE s.property_id = p.property_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.campaign_target_graph_stage s
        WHERE s.property_export_id = p.property_export_id
      )
    ORDER BY
      COALESCE(NULLIF(p.property_id, ''), NULLIF(p.property_export_id, '')) NULLS LAST,
      p.property_export_id NULLS LAST
    LIMIT 1 OFFSET (v_offset + v_limit)
  )
  INTO v_has_more;

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
      'graph_path', 'properties_prospects_json_phones',
      'fallback_enabled', true,
      'direct_core_only', false
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
        'stage_rows_after_batch', v_stage_rows
      )
    WHERE id = v_batch_id;

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
        WHERE s.property_id = p.property_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.campaign_target_graph_stage s
        WHERE s.property_export_id = p.property_export_id
      )
    ORDER BY
      COALESCE(NULLIF(p.property_id, ''), NULLIF(p.property_export_id, '')) NULLS LAST,
      p.property_export_id NULLS LAST
    LIMIT v_limit OFFSET v_offset
  ),
  prospect_paths AS (
    SELECT
      ROW(p.*)::public.properties AS p,
      pr.pr_row AS pr,
      pr.link_rank AS prospect_link_rank
    FROM property_batch p
    JOIN LATERAL (
      SELECT candidate.pr_row, candidate.link_rank
      FROM (
        SELECT ROW(pr.*)::public.prospects AS pr_row, 1 AS link_rank
        FROM public.prospects pr
        WHERE NULLIF(p.property_id, '') IS NOT NULL
          AND pr.linked_property_ids_json ? p.property_id
        UNION ALL
        SELECT ROW(pr.*)::public.prospects AS pr_row, 2 AS link_rank
        FROM public.prospects pr
        WHERE NULLIF(p.property_export_id, '') IS NOT NULL
          AND pr.linked_property_ids_json ? p.property_export_id
      ) candidate
      ORDER BY
        candidate.link_rank,
        COALESCE((candidate.pr_row).likely_owner, false) DESC,
        COALESCE((candidate.pr_row).is_primary_prospect, false) DESC,
        (candidate.pr_row).rank_position NULLS LAST,
        (candidate.pr_row).phone_score_final DESC NULLS LAST,
        (candidate.pr_row).contact_score_final DESC NULLS LAST,
        COALESCE((candidate.pr_row).updated_at, (candidate.pr_row).created_at) DESC NULLS LAST
      LIMIT 1
    ) pr ON true
  ),
  target_paths AS (
    SELECT
      md5(concat_ws('|',
        NULLIF(p.property_id, ''),
        NULLIF(p.property_export_id, ''),
        NULLIF(COALESCE(pr.master_owner_id, p.master_owner_id), ''),
        NULLIF(COALESCE(pr.prospect_id::text, ph.primary_prospect_id::text, ph.canonical_prospect_id::text), ''),
        NULLIF(ph.phone_id::text, ''),
        NULLIF(ph.canonical_e164, '')
      )) AS graph_id,
      p.property_id::text AS property_id,
      p.property_export_id::text AS property_export_id,
      COALESCE(pr.master_owner_id, p.master_owner_id)::text AS master_owner_id,
      COALESCE(pr.prospect_id::text, ph.primary_prospect_id::text, ph.canonical_prospect_id::text) AS prospect_id,
      COALESCE(pr.canonical_prospect_id::text, ph.canonical_prospect_id::text) AS canonical_prospect_id,
      ph.phone_id::text AS phone_id,
      ph.canonical_e164::text AS canonical_e164,
      graph_market.market AS market,
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
      COALESCE(NULLIF(pr.language_preference, ''), NULLIF(ph.linked_languages_text, '')) AS language,
      public.campaign_age_bucket_from_mob(pr.mob::text) AS age_bucket,
      pr.occupation_group::text AS occupation_group,
      pr.education_model::text AS education_model,
      pr.est_household_income::text AS income,
      COALESCE(NULLIF(pr.owner_type_guess, ''), NULLIF(p.owner_type_guess, ''), NULLIF(p.owner_type, '')) AS owner_type_guess,
      COALESCE(NULLIF(pr.priority_tier, ''), NULLIF(p.priority_tier, '')) AS priority_tier,
      NULL::text AS follow_up_cadence,
      COALESCE(NULLIF(p.rehab_level, ''), NULLIF(p.renovation_level_classification, ''), NULLIF(p.building_condition, '')) AS rehab_level,
      (
        ph.canonical_e164 IS NOT NULL
        AND COALESCE(ph.phone_contact_status, '') IS DISTINCT FROM 'wrong_number'
      ) AS sms_eligible,
      COALESCE(sup.is_suppressed, false) AS true_post_contact_suppression,
      (
        COALESCE(ph.phone_contact_status, '') = 'wrong_number'
        OR ph.wrong_number_at IS NOT NULL
      ) AS wrong_number,
      (
        latest.last_outbound_at IS NOT NULL
        AND latest.last_outbound_at >= now() - interval '30 days'
      ) AS pending_prior_touch,
      COALESCE(aq.active_queue_count, 0) > 0 AS active_queue_item,
      sm.sender_market IS NOT NULL AS sender_covered,
      sm.sender_market,
      COALESCE(NULLIF(ph.timezone, ''), NULLIF(pr.timezone, '')) AS timezone,
      ph.best_phone_score,
      ph.phone_owner,
      ph.activity_status AS phone_activity_status,
      ph.usage_12_months::text AS usage_12_months,
      ph.usage_2_months::text AS usage_2_months,
      'ownership_check'::text AS template_use_case,
      COALESCE(NULLIF(ph.contact_window, ''), NULLIF(pr.contact_window, '')) AS contact_window,
      NULLIF(GREATEST(
        COALESCE(latest.last_outbound_at, 'epoch'::timestamptz),
        COALESCE(latest.last_inbound_at, 'epoch'::timestamptz)
      ), 'epoch'::timestamptz) AS latest_contact_at,
      latest.last_outbound_at,
      latest.last_inbound_at,
      CASE WHEN sm.sender_market IS NOT NULL THEN 'exact_market_match' ELSE 'no_sender_route' END AS routing_tier,
      CASE
        WHEN COALESCE(pr.likely_owner, false) THEN 'verified'
        WHEN COALESCE(pr.likely_renting, false) THEN 'renter_risk'
        WHEN pr.prospect_id IS NOT NULL THEN 'probable_json_fallback'
        ELSE 'unknown'
      END AS identity_alignment,
      COALESCE(p.final_acquisition_score, pr.master_owner_priority_score) AS acquisition_score,
      COALESCE(NULLIF(p.seller_tags_text, ''), NULLIF(p.podio_tags, ''), NULLIF(pr.seller_tags_text, '')) AS podio_tags,
      jsonb_strip_nulls(jsonb_build_object(
        'matching_flags', pr.matching_flags,
        'person_flags_text', pr.person_flags_text,
        'person_flags_json', pr.person_flags_json
      )) AS matching_flags,
      COALESCE(NULLIF(pr.matching_flags, ''), NULLIF(pr.person_flags_text, '')) AS matching_flags_text,
      COALESCE(NULLIF(pr.owner_display_name, ''), NULLIF(p.owner_display_name, ''), NULLIF(p.owner_name, '')) AS owner_name,
      COALESCE(NULLIF(pr.first_name, ''), NULLIF(ph.phone_first_name, ''), split_part(NULLIF(COALESCE(pr.full_name, ph.phone_full_name, pr.owner_display_name), ''), ' ', 1)) AS seller_first_name,
      COALESCE(NULLIF(pr.full_name, ''), NULLIF(ph.phone_full_name, ''), NULLIF(ph.primary_display_name, ''), NULLIF(pr.owner_display_name, '')) AS seller_full_name,
      COALESCE(NULLIF(p.property_address_full, ''), NULLIF(p.property_address, '')) AS property_address_full,
      p.estimated_value,
      p.equity_amount,
      p.equity_percent,
      p.cash_offer,
      CASE WHEN latest.last_outbound_at IS NULL THEN 0 ELSE 1 END AS touch_count,
      CASE WHEN latest.last_outbound_at IS NULL THEN 1 ELSE 2 END AS current_touch_number,
      latest.last_outbound_at IS NULL AS never_contacted,
      jsonb_build_object(
        'property', CASE WHEN p.property_id IS NOT NULL THEN 1 ELSE 0 END,
        'master_owner', 0,
        'prospect', CASE WHEN pr.prospect_id IS NOT NULL THEN 1 ELSE 0 END,
        'phone', CASE WHEN ph.phone_id IS NOT NULL THEN 1 ELSE 0 END,
        'sender_numbers', COALESCE(sm.sender_count, 0),
        'prospect_link_rank', prospect_paths.prospect_link_rank,
        'phone_link_rank', ph.link_rank
      ) AS linkage_counts,
      to_jsonb(p) AS property_data,
      to_jsonb(pr) AS prospect_data,
      to_jsonb(ph) AS phone_data,
      sup.suppression_rows AS suppression_data,
      GREATEST(
        COALESCE(p.updated_at, p.created_at, 'epoch'::timestamptz),
        COALESCE(pr.updated_at, pr.created_at, 'epoch'::timestamptz),
        COALESCE(ph.updated_at, ph.created_at, 'epoch'::timestamptz),
        COALESCE(latest.last_outbound_at, 'epoch'::timestamptz),
        COALESCE(latest.last_inbound_at, 'epoch'::timestamptz),
        COALESCE(sm.latest_sender_update, 'epoch'::timestamptz),
        COALESCE(sup.latest_suppressed_at, 'epoch'::timestamptz)
      ) AS source_updated_at
    FROM prospect_paths
    CROSS JOIN LATERAL (SELECT (prospect_paths.p).*) p
    CROSS JOIN LATERAL (SELECT (prospect_paths.pr).*) pr
    CROSS JOIN LATERAL (
      SELECT COALESCE(NULLIF(p.market, ''), NULLIF(pr.primary_market, '')) AS market
    ) graph_market
    LEFT JOIN LATERAL (
      SELECT linked_ph.*
      FROM (
        SELECT ph.*, 1 AS link_rank
        FROM public.phones ph
        WHERE ph.canonical_e164 IS NOT NULL
          AND (
            ph.phone_type IS NULL
            OR ph.phone_type = ''
            OR lower(ph.phone_type) IN ('w', 'wireless', 'mobile', 'voip', 'unknown')
          )
          AND ph.primary_prospect_id = pr.prospect_id
        UNION ALL
        SELECT ph.*, 2 AS link_rank
        FROM public.phones ph
        WHERE ph.canonical_e164 IS NOT NULL
          AND (
            ph.phone_type IS NULL
            OR ph.phone_type = ''
            OR lower(ph.phone_type) IN ('w', 'wireless', 'mobile', 'voip', 'unknown')
          )
          AND ph.canonical_prospect_id = pr.canonical_prospect_id
        UNION ALL
        SELECT ph.*, 3 AS link_rank
        FROM public.phones ph
        WHERE ph.canonical_e164 IS NOT NULL
          AND (
            ph.phone_type IS NULL
            OR ph.phone_type = ''
            OR lower(ph.phone_type) IN ('w', 'wireless', 'mobile', 'voip', 'unknown')
          )
          AND ph.master_owner_id = COALESCE(pr.master_owner_id, p.master_owner_id)
      ) linked_ph
      ORDER BY
        linked_ph.link_rank,
        COALESCE(linked_ph.is_best_phone_for_slot, false) DESC,
        COALESCE(linked_ph.is_best_phone_for_owner, false) DESC,
        linked_ph.best_phone_score DESC NULLS LAST,
        COALESCE(linked_ph.updated_at, linked_ph.created_at) DESC NULLS LAST
      LIMIT 1
    ) ph ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::integer AS active_queue_count
      FROM public.send_queue sq
      WHERE sq.to_phone_number = ph.canonical_e164
        AND lower(COALESCE(sq.queue_status, '')) IN ('queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending')
    ) aq ON ph.canonical_e164 IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT
        MAX(last_inbound_at) AS last_inbound_at,
        MAX(last_outbound_at) AS last_outbound_at
      FROM (
        SELECT
          MAX(COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.created_at)) AS last_inbound_at,
          NULL::timestamptz AS last_outbound_at
        FROM public.message_events me
        WHERE me.from_phone_number = ph.canonical_e164
          AND lower(COALESCE(me.direction, '')) LIKE 'in%'
        UNION ALL
        SELECT
          NULL::timestamptz AS last_inbound_at,
          MAX(COALESCE(me.event_timestamp, me.sent_at, me.received_at, me.created_at)) AS last_outbound_at
        FROM public.message_events me
        WHERE me.to_phone_number = ph.canonical_e164
          AND lower(COALESCE(me.direction, '')) LIKE 'out%'
        UNION ALL
        SELECT
          NULL::timestamptz AS last_inbound_at,
          MAX(COALESCE(sq.sent_at, sq.scheduled_for_utc, sq.scheduled_for, sq.created_at)) AS last_outbound_at
        FROM public.send_queue sq
        WHERE sq.to_phone_number = ph.canonical_e164
      ) contact_events
    ) latest ON ph.canonical_e164 IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT
        bool_or(COALESCE(sl.is_active, true)) AS is_suppressed,
        MAX(COALESCE(sl.suppressed_at, sl.created_at)) AS latest_suppressed_at,
        jsonb_agg(to_jsonb(sl) ORDER BY COALESCE(sl.suppressed_at, sl.created_at) DESC NULLS LAST) AS suppression_rows
      FROM (
        SELECT sl.*
        FROM public.sms_suppression_list sl
        WHERE sl.phone_e164 = ph.canonical_e164
        UNION ALL
        SELECT sl.*
        FROM public.sms_suppression_list sl
        WHERE sl.phone_number = ph.canonical_e164
          AND sl.phone_e164 IS DISTINCT FROM ph.canonical_e164
      ) sl
    ) sup ON ph.canonical_e164 IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT
        tn.market AS sender_market,
        COUNT(*)::integer AS sender_count,
        MAX(tn.updated_at) AS latest_sender_update
      FROM public.textgrid_numbers tn
      WHERE tn.market = COALESCE(graph_market.market, ph.primary_market)
        AND NULLIF(tn.phone_number, '') IS NOT NULL
        AND lower(COALESCE(tn.status, 'active')) NOT IN ('disabled', 'inactive', 'failed', 'blocked', 'retired')
      GROUP BY tn.market
    ) sm ON COALESCE(graph_market.market, ph.primary_market) IS NOT NULL
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
    (
      sms_eligible
      AND NOT true_post_contact_suppression
      AND NOT wrong_number
      AND NOT pending_prior_touch
      AND NOT active_queue_item
      AND sender_covered
    ) AS queue_eligible,
    CASE
      WHEN NOT sms_eligible THEN 'sms_ineligible'
      WHEN true_post_contact_suppression THEN 'suppressed'
      WHEN wrong_number THEN 'wrong_number'
      WHEN pending_prior_touch THEN 'pending_prior_touch'
      WHEN active_queue_item THEN 'active_queue_item'
      WHEN NOT sender_covered THEN 'no_sender_coverage'
      ELSE NULL
    END AS queue_block_reason,
    'campaign_target_graph.refresh.missing_owner_json_fallback' AS graph_source,
    linkage_counts,
    jsonb_build_object(
      'sms_eligible', sms_eligible,
      'true_post_contact_suppression', true_post_contact_suppression,
      'wrong_number', wrong_number,
      'pending_prior_touch', pending_prior_touch,
      'active_queue_item', active_queue_item,
      'sender_covered', sender_covered
    ) AS blocker_flags,
    jsonb_strip_nulls(jsonb_build_object(
      'property', property_data,
      'prospect', prospect_data,
      'phone', phone_data,
      'suppression', suppression_data
    )) AS extra_data,
    NULLIF(source_updated_at, 'epoch'::timestamptz) AS source_updated_at,
    now() AS generated_at
  FROM target_paths
  WHERE phone_id IS NOT NULL
    AND canonical_e164 IS NOT NULL
  ON CONFLICT (graph_id) DO UPDATE SET
    graph_source = EXCLUDED.graph_source,
    generated_at = EXCLUDED.generated_at,
    source_updated_at = EXCLUDED.source_updated_at;

  GET DIAGNOSTICS v_rows_inserted = ROW_COUNT;

  SELECT COUNT(*)::integer INTO v_stage_rows FROM public.campaign_target_graph_stage;
  v_elapsed_ms := GREATEST(0, floor(EXTRACT(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer);

  UPDATE public.campaign_target_graph_refresh_batches
  SET
    rows_inserted = v_rows_inserted,
    finished_at = clock_timestamp(),
    elapsed_ms = v_elapsed_ms,
    status = 'completed',
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'has_more', v_has_more,
      'stage_rows_after_batch', v_stage_rows
    )
  WHERE id = v_batch_id;

  UPDATE public.campaign_target_graph_refresh_runs
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'last_fallback_batch_number', v_batch_number,
    'last_fallback_batch_key', v_batch_key,
    'last_fallback_has_more', v_has_more,
    'stage_rows', v_stage_rows,
    'fallback_enabled', true
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
      'last_failed_fallback_batch_key', v_batch_key,
      'last_error_sqlstate', SQLSTATE
    )
  WHERE id = p_run_id;

  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_stage_commit(p_run_id uuid)
RETURNS TABLE(
  run_id uuid,
  graph_rows integer,
  facet_rows integer,
  graph_refresh_scope text,
  elapsed_ms integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_started_at timestamptz := clock_timestamp();
  v_stage_rows integer := 0;
  v_graph_rows integer := 0;
  v_facet_rows integer := 0;
  v_elapsed_ms integer := 0;
  v_scope text := 'partial';
  v_run_metadata jsonb := '{}'::jsonb;
BEGIN
  PERFORM set_config('statement_timeout', '0', true);
  PERFORM set_config('work_mem', '128MB', true);

  SELECT COALESCE(r.metadata, '{}'::jsonb)
  INTO v_run_metadata
  FROM public.campaign_target_graph_refresh_runs r
  WHERE r.id = p_run_id
    AND r.status = 'started';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign target graph refresh run % is not active', p_run_id;
  END IF;

  SELECT COUNT(*)::integer INTO v_stage_rows FROM public.campaign_target_graph_stage;

  IF v_stage_rows <= 0 THEN
    UPDATE public.campaign_target_graph_refresh_runs
    SET
      status = 'failed',
      finished_at = now(),
      graph_rows = 0,
      facet_rows = 0,
      error_message = 'campaign_target_graph_stage_empty',
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'graph_refresh_scope', 'empty',
        'stage_rows', 0
      )
    WHERE id = p_run_id;

    RAISE EXCEPTION 'campaign_target_graph_stage is empty for run %', p_run_id;
  END IF;

  v_scope := CASE
    WHEN COALESCE(v_run_metadata->>'completed_all_batches', 'false') = 'true' THEN 'full'
    ELSE 'partial'
  END;

  TRUNCATE TABLE public.campaign_target_graph;

  INSERT INTO public.campaign_target_graph
  SELECT *
  FROM public.campaign_target_graph_stage;

  GET DIAGNOSTICS v_graph_rows = ROW_COUNT;

  SELECT public.refresh_campaign_target_graph_facets() INTO v_facet_rows;

  v_elapsed_ms := GREATEST(0, floor(EXTRACT(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer);

  UPDATE public.campaign_target_graph_refresh_runs
  SET
    status = 'completed',
    finished_at = now(),
    graph_rows = v_graph_rows,
    facet_rows = v_facet_rows,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'source', 'refresh_campaign_target_graph_stage_commit',
      'stage_rows', v_stage_rows,
      'graph_rows', v_graph_rows,
      'facet_rows', v_facet_rows,
      'graph_refresh_scope', v_scope,
      'fallback_enabled', false,
      'elapsed_ms_commit', v_elapsed_ms
    )
  WHERE id = p_run_id;

  run_id := p_run_id;
  graph_rows := v_graph_rows;
  facet_rows := v_facet_rows;
  graph_refresh_scope := v_scope;
  elapsed_ms := v_elapsed_ms;
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  UPDATE public.campaign_target_graph_refresh_runs
  SET
    status = 'failed',
    finished_at = now(),
    error_message = SQLERRM,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'source', 'refresh_campaign_target_graph_stage_commit',
      'error_sqlstate', SQLSTATE
    )
  WHERE id = p_run_id;
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_staged(
  p_batch_limit integer DEFAULT 10000,
  p_max_batches integer DEFAULT NULL
)
RETURNS TABLE(
  run_id uuid,
  batches_completed integer,
  stage_rows integer,
  graph_rows integer,
  facet_rows integer,
  graph_refresh_scope text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id uuid;
  v_limit integer := LEAST(GREATEST(COALESCE(p_batch_limit, 10000), 1), 50000);
  v_offset integer := 0;
  v_batches_completed integer := 0;
  v_source_rows integer := 0;
  v_stage_rows integer := 0;
  v_has_more boolean := true;
  v_commit record;
BEGIN
  v_run_id := public.refresh_campaign_target_graph_stage_start();

  LOOP
    EXIT WHEN p_max_batches IS NOT NULL AND v_batches_completed >= p_max_batches;

    SELECT b.source_rows, b.stage_rows, b.has_more
    INTO v_source_rows, v_stage_rows, v_has_more
    FROM public.refresh_campaign_target_graph_stage_batch(v_run_id, v_limit, v_offset) b;

    v_batches_completed := v_batches_completed + 1;
    EXIT WHEN v_source_rows = 0 OR NOT v_has_more;

    v_offset := v_offset + v_limit;
  END LOOP;

  UPDATE public.campaign_target_graph_refresh_runs
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'completed_all_batches',
    CASE
      WHEN v_source_rows = 0 OR NOT v_has_more THEN true
      ELSE false
    END,
    'graph_refresh_scope',
    CASE
      WHEN v_source_rows = 0 OR NOT v_has_more THEN 'full'
      ELSE 'partial'
    END
  )
  WHERE id = v_run_id;

  SELECT *
  INTO v_commit
  FROM public.refresh_campaign_target_graph_stage_commit(v_run_id);

  run_id := v_run_id;
  batches_completed := v_batches_completed;
  stage_rows := v_stage_rows;
  graph_rows := v_commit.graph_rows;
  facet_rows := v_commit.facet_rows;
  graph_refresh_scope := v_commit.graph_refresh_scope;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph()
RETURNS TABLE(graph_rows integer, facet_rows integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result record;
BEGIN
  SELECT *
  INTO v_result
  FROM public.refresh_campaign_target_graph_staged(10000, NULL);

  graph_rows := v_result.graph_rows;
  facet_rows := v_result.facet_rows;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_stage_start() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_stage_batch(uuid, integer, integer, text, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_fallback_batch(uuid, integer, integer, text, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_stage_commit(uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_staged(integer, integer) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph() FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph_stage_start() TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph_stage_batch(uuid, integer, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph_fallback_batch(uuid, integer, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph_stage_commit(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph_staged(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph() TO service_role;
