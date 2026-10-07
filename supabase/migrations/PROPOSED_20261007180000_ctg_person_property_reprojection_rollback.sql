-- PROPOSED — NOT APPLIED. Rollback for PROPOSED_20261007180000_ctg_person_property_reprojection.sql.
-- Restores the definitions live on 2026-10-07 verbatim (pg_get_functiondef of
-- enrich_rows, incremental_tick and stage_commit, dumped 2026-10-07 ~10:40Z)
-- and drops the new functions. Apply as ONE transaction:
--   psql "$SUPABASE_DB_URL" -X -1 -v ON_ERROR_STOP=1 -f <this file>
-- Data written by the re-projection (prospect_id, demographics, property columns) stays:
-- it is projection, re-derived by the next enrich pass.
-- The partial index is dropped separately (see the _index file).
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.campaign_target_graph_enrich_rows(p_graph_ids text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows integer := 0;
BEGIN
  IF p_graph_ids IS NULL OR cardinality(p_graph_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_graph_ids) > 2000 THEN
    RAISE EXCEPTION 'campaign_target_graph_enrich_rows: % ids exceeds the 2000-row bound', cardinality(p_graph_ids);
  END IF;

-- The per-row projection. :ids is a text[] of graph_ids (at most a few hundred).
  WITH g AS (
    SELECT g.graph_id, g.property_id, g.seller_person_key, g.canonical_e164, g.extra_data, g.blocker_flags,
           g.wrong_number, g.sender_covered,
           CASE WHEN g.canonical_e164 ~ '^[0-9]{10}$' THEN '+1' || g.canonical_e164 END AS e164
    FROM public.campaign_target_graph g
    WHERE g.graph_id = ANY(p_graph_ids)
  ),
  phones_in AS (SELECT DISTINCT e164 FROM g WHERE e164 IS NOT NULL),
  me AS (
    SELECT CASE WHEN m.direction ILIKE 'in%' THEN m.from_phone_number ELSE m.to_phone_number END AS e164,
           max(COALESCE(m.event_timestamp, m.sent_at, m.created_at)) FILTER (WHERE m.direction ILIKE 'out%') AS last_out,
           max(COALESCE(m.event_timestamp, m.received_at, m.created_at)) FILTER (WHERE m.direction ILIKE 'in%') AS last_in,
           count(*) FILTER (WHERE m.direction ILIKE 'out%') AS outs
    FROM public.message_events m
    WHERE (m.to_phone_number IN (SELECT e164 FROM phones_in) AND m.direction ILIKE 'out%')
       OR (m.from_phone_number IN (SELECT e164 FROM phones_in) AND m.direction ILIKE 'in%')
    GROUP BY 1
  ),
  sq AS (
    SELECT CASE WHEN s.to_phone_number LIKE '+1%' THEN s.to_phone_number ELSE '+1' || s.to_phone_number END AS e164,
           max(s.sent_at) AS last_sent,
           count(*) FILTER (WHERE s.sent_at IS NOT NULL) AS sent,
           bool_or(s.sent_at IS NULL AND lower(COALESCE(s.queue_status,'')) IN
                   ('queued','scheduled','pending','ready','approved','processing','sending','retry')) AS active
    FROM public.send_queue s
    WHERE s.to_phone_number IN (SELECT e164 FROM phones_in UNION ALL SELECT substr(e164, 3) FROM phones_in)
    GROUP BY 1
  ),
  supp AS (
    SELECT x.e164 FROM (
      SELECT s.phone_e164 AS e164 FROM public.sms_suppression_list s
       WHERE s.phone_e164 IN (SELECT e164 FROM phones_in) AND COALESCE(s.is_active, true)
      UNION
      SELECT a.phone_e164 FROM public.automation_suppressions a
       WHERE a.phone_e164 IN (SELECT e164 FROM phones_in)
         AND (a.expires_at IS NULL OR a.expires_at > now())
    ) x
  ),
  src AS (
    SELECT g.*,
      o.given_name, o.full_name AS o_full_name, o.language_preference, o.gender, o.marital_status,
      o.education_model, o.occupation_group, o.est_household_income, o.net_asset_value, o.buying_power,
      o.month_of_birth, o.person_flags,
      pr.first_name AS pr_first, pr.full_name AS pr_full, pr.person_flags_text AS pr_flags,
      opt.ptype AS op_type, opt.carrier AS op_carrier,
      ph.phone_type AS ph_type, ph.phone_owner, ph.activity_status, ph.usage_12_months, ph.usage_2_months, ph.wrong_number_at,
      p.units_count, p.building_condition, p.building_quality, p.rehab_level, p.renovation_level_classification,
      p.property_flags_text, p.podio_tags, p.total_bedrooms, p.total_baths, p.building_square_feet, p.year_built,
      p.lot_square_feet, p.total_loan_balance, p.ownership_years, p.tax_delinquent_year, p.estimated_repair_cost,
      pas.aos_score, pas.decision_tier, pas.confidence AS pas_confidence, pas.transaction_probability_365,
      pas.best_strategy, pas.computed_at AS pas_computed_at,
      me.last_out, me.last_in, me.outs, sq.last_sent, sq.sent, sq.active,
      (supp.e164 IS NOT NULL) AS on_suppression
    FROM g
    LEFT JOIN seller.owner o ON o.individual_key = g.seller_person_key
    LEFT JOIN LATERAL (
      SELECT pr.first_name, pr.full_name, pr.person_flags_text FROM public.prospects pr
      WHERE pr.individual_key = g.seller_person_key
      ORDER BY pr.is_primary_prospect DESC NULLS LAST, pr.prospect_id LIMIT 1
    ) pr ON g.seller_person_key IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT CASE
               WHEN bool_or(op.phone_type IN ('W','Wireless')) AND NOT bool_or(op.phone_type IN ('L','Landline')) THEN 'W'
               WHEN bool_or(op.phone_type IN ('L','Landline')) AND NOT bool_or(op.phone_type IN ('W','Wireless')) THEN 'L'
             END AS ptype,
             max(NULLIF(op.carrier,'')) AS carrier
      FROM seller.owner_phone op
      WHERE op.individual_key = g.seller_person_key AND op.phone_value = g.canonical_e164
    ) opt ON g.seller_person_key IS NOT NULL AND g.canonical_e164 IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT ph.phone_type, ph.phone_owner, ph.activity_status, ph.usage_12_months, ph.usage_2_months, ph.wrong_number_at
      FROM public.phones ph WHERE ph.canonical_e164 = g.e164
      ORDER BY ph.best_phone_score DESC NULLS LAST LIMIT 1
    ) ph ON g.e164 IS NOT NULL
    LEFT JOIN public.properties p ON p.property_id = g.property_id
    LEFT JOIN LATERAL (
      SELECT s.* FROM public.property_acquisition_scores s
      WHERE s.property_id = g.property_id ORDER BY s.computed_at DESC NULLS LAST LIMIT 1
    ) pas ON true
    LEFT JOIN me ON me.e164 = g.e164
    LEFT JOIN sq ON sq.e164 = g.e164
    LEFT JOIN supp ON supp.e164 = g.e164
  ),
  calc AS (
    SELECT s.*,
      -- Phone type evidence, strongest first. Unknown stays NULL and is NOT SMS-capable.
      COALESCE(
        s.op_type,
        CASE WHEN s.extra_data->>'phone_type' IN ('W','Wireless') THEN 'W'
             WHEN s.extra_data->>'phone_type' IN ('L','Landline') THEN 'L' END,
        CASE WHEN s.ph_type IN ('W','Wireless','mobile') THEN 'W'
             WHEN s.ph_type IN ('L','Landline','landline') THEN 'L' END
      ) AS ptype,
      CASE WHEN s.op_type IS NOT NULL THEN 'seller.owner_phone'
           WHEN s.extra_data->>'phone_type' IN ('W','Wireless','L','Landline') THEN 'seller.property_best_contact_v1'
           WHEN s.ph_type IN ('W','Wireless','mobile','L','Landline','landline') THEN 'public.phones'
           ELSE 'unknown' END AS ptype_source,
      NULLIF(GREATEST(COALESCE(s.last_out, 'epoch'::timestamptz), COALESCE(s.last_sent, 'epoch'::timestamptz)), 'epoch'::timestamptz) AS last_outbound,
      (COALESCE(s.wrong_number, false) OR s.wrong_number_at IS NOT NULL) AS wrong,
      (s.on_suppression OR COALESCE((s.blocker_flags->>'operational_excluded')::boolean, false)) AS suppressed,
      CASE
        WHEN s.month_of_birth ~ '^(19|20)[0-9]{4}$' THEN
          date_part('year', age(current_date, make_date(left(s.month_of_birth,4)::int, LEAST(GREATEST(right(s.month_of_birth,2)::int,1),12), 1)))::int
      END AS age_years
    FROM src s
  )
  UPDATE public.campaign_target_graph t SET
    seller_first_name   = COALESCE(NULLIF(btrim(c.given_name), ''), NULLIF(btrim(c.pr_first), ''), t.seller_first_name),
    seller_full_name    = COALESCE(NULLIF(btrim(c.o_full_name), ''), NULLIF(btrim(c.pr_full), ''), t.seller_full_name),
    language            = COALESCE(NULLIF(c.language_preference, ''), t.language),
    gender              = NULLIF(c.gender, ''),
    marital_status      = NULLIF(c.marital_status, ''),
    education_model     = NULLIF(c.education_model, ''),
    occupation_group    = NULLIF(c.occupation_group, ''),
    income              = NULLIF(c.est_household_income, ''),
    net_asset_value     = NULLIF(c.net_asset_value, ''),
    buying_power        = NULLIF(c.buying_power, ''),
    age_bucket          = CASE
                            WHEN c.age_years IS NULL OR c.age_years < 18 OR c.age_years > 120 THEN NULL
                            WHEN c.age_years < 35 THEN 'Under 35'
                            WHEN c.age_years <= 44 THEN '35-44'
                            WHEN c.age_years <= 54 THEN '45-54'
                            WHEN c.age_years <= 64 THEN '55-64'
                            WHEN c.age_years <= 74 THEN '65-74'
                            ELSE '75+' END,
    matching_flags_text = COALESCE(NULLIF(array_to_string(c.person_flags, '; '), ''), NULLIF(c.pr_flags, '')),
    phone_type          = c.ptype,
    phone_type_source   = c.ptype_source,
    phone_owner         = COALESCE(NULLIF(c.op_carrier, ''), NULLIF(c.phone_owner, '')),
    phone_activity_status = NULLIF(c.activity_status, ''),
    usage_12_months     = NULLIF(c.usage_12_months, ''),
    usage_2_months      = NULLIF(c.usage_2_months, ''),
    last_outbound_at    = c.last_outbound,
    last_inbound_at     = c.last_in,
    latest_contact_at   = NULLIF(GREATEST(COALESCE(c.last_outbound, 'epoch'::timestamptz), COALESCE(c.last_in, 'epoch'::timestamptz)), 'epoch'::timestamptz),
    touch_count         = GREATEST(COALESCE(c.outs, 0), COALESCE(c.sent, 0))::integer,
    never_contacted     = (c.last_outbound IS NULL),
    pending_prior_touch = (c.last_outbound IS NOT NULL AND c.last_outbound >= now() - interval '30 days'),
    active_queue_item   = COALESCE(c.active, false),
    true_post_contact_suppression = COALESCE(c.suppressed, false),
    wrong_number        = COALESCE(c.wrong, false),
    -- Null-safe (unknown => false): an unknown phone type / flag is never eligible,
    -- and both columns are NOT NULL.
    sms_eligible        = COALESCE(c.canonical_e164 IS NOT NULL AND c.ptype = 'W' AND NOT COALESCE(c.wrong, false), false),
    queue_eligible      = COALESCE(
      c.canonical_e164 IS NOT NULL
      AND NOT COALESCE(c.wrong, false)
      AND c.ptype = 'W'
      AND NOT COALESCE(c.suppressed, false)
      AND NOT (c.last_outbound IS NOT NULL AND c.last_outbound >= now() - interval '30 days')
      AND NOT COALESCE(c.active, false)
      AND COALESCE(c.sender_covered, false)
    , false),
    -- Exclusive precedence, operator-locked order (unchanged). Unknown phone type
    -- lands in non_sms_capable with blocker_flags.phone_type_unknown = true.
    queue_block_reason  = CASE
      WHEN c.canonical_e164 IS NULL                                              THEN 'missing_phone'
      WHEN c.wrong                                                               THEN 'wrong_number'
      WHEN c.ptype IS DISTINCT FROM 'W'                                          THEN 'non_sms_capable'
      WHEN c.suppressed                                                          THEN 'suppressed'
      WHEN c.last_outbound IS NOT NULL AND c.last_outbound >= now() - interval '30 days' THEN 'pending_prior_touch'
      WHEN COALESCE(c.active, false)                                             THEN 'active_queue_item'
      WHEN NOT COALESCE(c.sender_covered, false)                                 THEN 'no_sender_coverage'
      ELSE NULL END,
    blocker_flags       = COALESCE(t.blocker_flags, '{}'::jsonb) || jsonb_build_object(
      'wrong_number', c.wrong,
      'suppressed', c.on_suppression,
      'active_queue', COALESCE(c.active, false),
      'non_sms_capable', (c.canonical_e164 IS NOT NULL AND c.ptype IS DISTINCT FROM 'W'),
      'phone_type_unknown', (c.canonical_e164 IS NOT NULL AND c.ptype IS NULL)),
    units_count         = COALESCE(c.units_count, t.units_count),
    building_condition  = NULLIF(c.building_condition, ''),
    building_quality    = NULLIF(c.building_quality, ''),
    rehab_level         = COALESCE(NULLIF(c.rehab_level, ''), NULLIF(c.renovation_level_classification, '')),
    property_flags_text = COALESCE(NULLIF(c.property_flags_text, ''), NULLIF(c.podio_tags, '')),
    beds                = c.total_bedrooms,
    baths               = c.total_baths,
    building_sqft       = c.building_square_feet,
    year_built          = c.year_built,
    lot_sqft            = c.lot_square_feet,
    total_loan_balance  = c.total_loan_balance,
    ownership_years     = c.ownership_years,
    tax_delinquent_year = c.tax_delinquent_year,
    estimated_repair_cost = c.estimated_repair_cost,
    aos_score           = c.aos_score,
    decision_tier       = c.decision_tier,
    acquisition_confidence = c.pas_confidence,
    transaction_probability_365 = c.transaction_probability_365,
    best_strategy       = c.best_strategy,
    scores_computed_at  = c.pas_computed_at,
    enriched_at         = now(),
    enrich_version      = 'ctg_enrich_v1'
  FROM calc c
  WHERE t.graph_id = c.graph_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$;

CREATE OR REPLACE FUNCTION public.campaign_target_graph_incremental_tick(p_max_rows integer DEFAULT 300)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_wm timestamptz;
  v_new_wm timestamptz;
  v_limit integer := LEAST(GREATEST(COALESCE(p_max_rows, 300), 1), 1000);
  v_ids text[];
  v_rows integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('campaign_target_graph_projection')) THEN
    RETURN jsonb_build_object('skipped', 'locked');
  END IF;
  IF NOT public.campaign_target_graph_load_ok() THEN
    UPDATE public.campaign_target_graph_sync_state SET last_run_at = now(), last_skip_reason = 'busy', updated_at = now() WHERE key = 'incremental';
    RETURN jsonb_build_object('skipped', 'busy');
  END IF;
  SELECT COALESCE(watermark, now() - interval '1 hour') INTO v_wm
  FROM public.campaign_target_graph_sync_state WHERE key = 'incremental' FOR UPDATE;

  WITH changed AS (
    SELECT CASE WHEN m.direction ILIKE 'in%' THEN m.from_phone_number ELSE m.to_phone_number END AS e164, m.created_at AS ts
      FROM public.message_events m WHERE m.created_at > v_wm
    UNION ALL
    SELECT s.to_phone_number, s.updated_at FROM public.send_queue s
     WHERE s.updated_at > v_wm AND s.to_phone_number IS NOT NULL AND s.to_phone_number <> ''
    UNION ALL
    SELECT l.phone_e164, COALESCE(l.suppressed_at, l.created_at) FROM public.sms_suppression_list l
     WHERE COALESCE(l.suppressed_at, l.created_at) > v_wm
    UNION ALL
    SELECT a.phone_e164, a.updated_at FROM public.automation_suppressions a
     WHERE a.updated_at > v_wm AND a.phone_e164 IS NOT NULL
  ),
  changed_phones AS (
    SELECT CASE WHEN e164 LIKE '+1%' THEN substr(e164, 3) ELSE e164 END AS p10, max(ts) AS ts
    FROM changed WHERE e164 IS NOT NULL GROUP BY 1
  ),
  -- 30-day prior-touch holds that have expired since the last pass.
  expired AS (
    SELECT g.graph_id, g.last_outbound_at + interval '30 days' AS ts
    FROM public.campaign_target_graph g
    WHERE g.pending_prior_touch = true AND g.last_outbound_at < now() - interval '30 days'
    LIMIT v_limit
  ),
  picked AS (
    SELECT g.graph_id, p.ts FROM changed_phones p JOIN public.campaign_target_graph g ON g.canonical_e164 = p.p10
    UNION
    SELECT graph_id, ts FROM expired
    ORDER BY 2
    LIMIT v_limit
  )
  SELECT array_agg(graph_id), max(ts) FILTER (WHERE ts <= now()) INTO v_ids, v_new_wm FROM picked;

  v_rows := public.campaign_target_graph_enrich_rows(v_ids);

  UPDATE public.campaign_target_graph_sync_state SET
    watermark = GREATEST(COALESCE(v_new_wm, v_wm), v_wm),
    last_run_at = now(), last_rows = v_rows, last_skip_reason = NULL,
    last_ms = floor(EXTRACT(epoch FROM clock_timestamp() - v_started) * 1000)::integer,
    updated_at = now()
  WHERE key = 'incremental';
  RETURN jsonb_build_object('rows', v_rows, 'watermark', GREATEST(COALESCE(v_new_wm, v_wm), v_wm));
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_stage_commit(p_run_id uuid, p_force_partial boolean DEFAULT false)
 RETURNS TABLE(run_id uuid, graph_rows integer, facet_rows integer, graph_refresh_scope text, elapsed_ms integer)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_started_at timestamptz := clock_timestamp();
  v_stage_rows integer := 0;
  v_graph_rows integer := 0;
  v_facet_rows integer := 0;
  v_elapsed_ms integer := 0;
  v_scope text := 'partial';
  v_run_metadata jsonb := '{}'::jsonb;
  v_sender_coverage record;
BEGIN
  PERFORM set_config('statement_timeout', '0', true);
  PERFORM set_config('work_mem', '128MB', true);

  SELECT COALESCE(refresh_run.metadata, '{}'::jsonb)
  INTO v_run_metadata
  FROM public.campaign_target_graph_refresh_runs refresh_run
  WHERE refresh_run.id = p_run_id
    AND refresh_run.status = 'started';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign target graph refresh run % is not active', p_run_id;
  END IF;

  SELECT COUNT(*)::integer
  INTO v_stage_rows
  FROM public.campaign_target_graph_stage;

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

  -- Guard: Refuse to commit partial graph unless forced
  IF v_scope = 'partial' AND COALESCE(p_force_partial, false) = false AND COALESCE((v_run_metadata->>'force_partial')::boolean, false) = false THEN
    UPDATE public.campaign_target_graph_refresh_runs
    SET
      status = 'failed',
      finished_at = now(),
      error_message = 'refused_partial_commit',
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'graph_refresh_scope', 'partial',
        'stage_rows', v_stage_rows,
        'guard_reason', 'Refusing to overwrite full production graph with partial data. Use p_force_partial=true or add force_partial:true to run metadata.'
      )
    WHERE id = p_run_id;

    RAISE EXCEPTION 'Refusing to commit partial campaign target graph to production for run %. Data remains in campaign_target_graph_stage.', p_run_id;
  END IF;

  TRUNCATE TABLE public.campaign_target_graph;

  INSERT INTO public.campaign_target_graph
  SELECT *
  FROM public.campaign_target_graph_stage;

  GET DIAGNOSTICS v_graph_rows = ROW_COUNT;

  SELECT *
  INTO v_sender_coverage
  FROM public.refresh_campaign_target_graph_sender_coverage(
    'refresh_campaign_target_graph_stage_commit'
  );

  SELECT public.refresh_campaign_target_graph_facets()
  INTO v_facet_rows;

  v_elapsed_ms := GREATEST(
    0,
    floor(EXTRACT(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );

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
      'fallback_enabled', true,
      'sender_route_mode', 'health_safe_exact_then_approved_state_fallback',
      'first_touch_regional_fallback_enabled', true,
      'exact_market_covered', v_sender_coverage.exact_market_covered,
      'health_safe_exact', v_sender_coverage.health_safe_exact,
      'fallback_covered', v_sender_coverage.fallback_covered,
      'sender_covered', v_sender_coverage.sender_covered,
      'expanded_deliverable', v_sender_coverage.expanded_deliverable,
      'uncovered_gap', v_sender_coverage.uncovered_gap,
      'health_blocked_sender_count', v_sender_coverage.health_blocked_sender_count,
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
$function$;

DROP FUNCTION IF EXISTS public.campaign_target_graph_reproject_batch(text, integer, text[], text);
DROP FUNCTION IF EXISTS public.campaign_target_graph_reproject_rows(text[], text[]);
DROP FUNCTION IF EXISTS public.campaign_target_graph_property_source(text[]);
DROP FUNCTION IF EXISTS public.campaign_target_graph_person_source(text[]);
DROP FUNCTION IF EXISTS public.campaign_age_bucket(integer);
DROP FUNCTION IF EXISTS public.campaign_birth_month_age(text, date);
