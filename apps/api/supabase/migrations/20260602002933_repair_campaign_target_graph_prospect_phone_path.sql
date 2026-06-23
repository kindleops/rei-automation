-- Repair campaign target graph expansion order.
--
-- The refresh must not depend on phones.master_owner_id as the primary graph
-- edge. The durable path is property -> owner -> prospect -> phone, with
-- property/prospect linkage as the fallback for sparse property owner ids.

CREATE INDEX IF NOT EXISTS idx_prospects_linked_property_ids_json_gin
  ON public.prospects USING gin (linked_property_ids_json);

CREATE INDEX IF NOT EXISTS idx_phones_canonical_prospect_id
  ON public.phones (canonical_prospect_id);

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph()
RETURNS TABLE(graph_rows integer, facet_rows integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id uuid;
  v_graph_rows integer := 0;
  v_facet_rows integer := 0;
  v_rows_after_property_join integer := 0;
  v_rows_after_owner_join integer := 0;
  v_rows_after_prospect_join integer := 0;
  v_rows_after_phone_join integer := 0;
  v_rows_missing_phone integer := 0;
  v_rows_missing_prospect integer := 0;
  v_rows_with_sms_eligible_phone integer := 0;
BEGIN
  PERFORM set_config('statement_timeout', '0', true);
  PERFORM set_config('work_mem', '256MB', true);

  INSERT INTO public.campaign_target_graph_refresh_runs (status, metadata)
  VALUES (
    'started',
    jsonb_build_object(
      'source', 'refresh_campaign_target_graph',
      'graph_path', 'properties_master_owners_prospects_phones'
    )
  )
  RETURNING id INTO v_run_id;

  TRUNCATE TABLE public.campaign_target_graph;

  WITH active_queue_by_phone AS (
    SELECT
      sq.to_phone_number AS canonical_e164,
      COUNT(*)::integer AS active_queue_count
    FROM public.send_queue sq
    WHERE sq.to_phone_number IS NOT NULL
      AND lower(COALESCE(sq.queue_status, '')) IN ('queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending')
    GROUP BY sq.to_phone_number
  ),
  contact_events AS (
    SELECT
      CASE
        WHEN lower(COALESCE(me.direction, '')) LIKE 'in%' THEN me.from_phone_number
        ELSE me.to_phone_number
      END AS canonical_e164,
      MAX(CASE WHEN lower(COALESCE(me.direction, '')) LIKE 'in%' THEN COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.created_at) END) AS last_inbound_at,
      MAX(CASE WHEN lower(COALESCE(me.direction, '')) LIKE 'out%' THEN COALESCE(me.event_timestamp, me.sent_at, me.received_at, me.created_at) END) AS last_outbound_at
    FROM public.message_events me
    WHERE COALESCE(me.to_phone_number, me.from_phone_number) IS NOT NULL
    GROUP BY 1
    UNION ALL
    SELECT
      sq.to_phone_number AS canonical_e164,
      NULL::timestamptz AS last_inbound_at,
      MAX(COALESCE(sq.sent_at, sq.scheduled_for_utc, sq.scheduled_for, sq.created_at)) AS last_outbound_at
    FROM public.send_queue sq
    WHERE sq.to_phone_number IS NOT NULL
    GROUP BY sq.to_phone_number
  ),
  latest_contact_by_phone AS (
    SELECT
      canonical_e164,
      MAX(last_inbound_at) AS last_inbound_at,
      MAX(last_outbound_at) AS last_outbound_at
    FROM contact_events
    WHERE canonical_e164 IS NOT NULL
    GROUP BY canonical_e164
  ),
  suppression_by_phone AS (
    SELECT
      COALESCE(sl.phone_e164, sl.phone_number) AS canonical_e164,
      bool_or(COALESCE(sl.is_active, true)) AS is_suppressed,
      MAX(COALESCE(sl.suppressed_at, sl.created_at)) AS latest_suppressed_at,
      jsonb_agg(to_jsonb(sl) ORDER BY COALESCE(sl.suppressed_at, sl.created_at) DESC NULLS LAST) AS suppression_rows
    FROM public.sms_suppression_list sl
    WHERE COALESCE(sl.phone_e164, sl.phone_number) IS NOT NULL
    GROUP BY COALESCE(sl.phone_e164, sl.phone_number)
  ),
  sender_markets AS (
    SELECT
      tn.market AS sender_market,
      COUNT(*)::integer AS sender_count,
      MAX(tn.updated_at) AS latest_sender_update
    FROM public.textgrid_numbers tn
    WHERE NULLIF(tn.phone_number, '') IS NOT NULL
      AND NULLIF(tn.market, '') IS NOT NULL
      AND lower(COALESCE(tn.status, 'active')) NOT IN ('disabled', 'inactive', 'failed', 'blocked', 'retired')
    GROUP BY tn.market
  ),
  property_layer AS (
    SELECT p.*
    FROM public.properties p
  ),
  direct_owner_paths AS (
    SELECT
      ROW(p.*)::public.properties AS p,
      ROW(mo.*)::public.master_owners AS mo
    FROM property_layer p
    JOIN public.master_owners mo
      ON mo.master_owner_id = p.master_owner_id
  ),
  direct_prospect_paths AS (
    SELECT
      ROW(p.*)::public.properties AS p,
      ROW(mo.*)::public.master_owners AS mo,
      ROW(pr.*)::public.prospects AS pr,
      'direct_property_owner'::text AS graph_path_source
    FROM direct_owner_paths op
    CROSS JOIN LATERAL (SELECT (op.p).*) p
    CROSS JOIN LATERAL (SELECT (op.mo).*) mo
    JOIN LATERAL (
      SELECT pr.*
      FROM public.prospects pr
      WHERE (
        mo.best_prospect_id IS NOT NULL
        AND pr.prospect_id::text = mo.best_prospect_id::text
      ) OR (
        mo.best_canonical_prospect_id IS NOT NULL
        AND pr.canonical_prospect_id::text = mo.best_canonical_prospect_id::text
      ) OR (
        pr.master_owner_id = mo.master_owner_id
      )
      ORDER BY
        CASE
          WHEN mo.best_prospect_id IS NOT NULL AND pr.prospect_id::text = mo.best_prospect_id::text THEN 1
          WHEN mo.best_canonical_prospect_id IS NOT NULL AND pr.canonical_prospect_id::text = mo.best_canonical_prospect_id::text THEN 2
          WHEN COALESCE(pr.is_primary_prospect, false) THEN 3
          WHEN pr.master_owner_id = mo.master_owner_id THEN 4
          ELSE 5
        END,
        pr.rank_position NULLS LAST,
        pr.phone_score_final DESC NULLS LAST,
        pr.contact_score_final DESC NULLS LAST,
        COALESCE(pr.updated_at, pr.created_at) DESC NULLS LAST
      LIMIT 1
    ) pr ON true
  ),
  prospect_paths AS (
    SELECT * FROM direct_prospect_paths
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
      COALESCE(NULLIF(p.market, ''), NULLIF(mo.routing_market, ''), NULLIF(pr.primary_market, ''), NULLIF(ph.primary_market, '')) AS market,
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
      CASE
        WHEN latest.last_outbound_at IS NULL THEN 0
        ELSE 1
      END AS touch_count,
      CASE
        WHEN latest.last_outbound_at IS NULL THEN 1
        ELSE 2
      END AS current_touch_number,
      latest.last_outbound_at IS NULL AS never_contacted,
      jsonb_build_object(
        'property', CASE WHEN p.property_id IS NOT NULL THEN 1 ELSE 0 END,
        'master_owner', CASE WHEN mo.master_owner_id IS NOT NULL THEN 1 ELSE 0 END,
        'prospect', CASE WHEN pr.prospect_id IS NOT NULL THEN 1 ELSE 0 END,
        'phone', CASE WHEN ph.phone_id IS NOT NULL THEN 1 ELSE 0 END,
        'sender_numbers', COALESCE(sm.sender_count, 0)
      ) AS linkage_counts,
      to_jsonb(p) AS property_data,
      to_jsonb(mo) AS master_owner_data,
      to_jsonb(pr) AS prospect_data,
      to_jsonb(ph) AS phone_data,
      to_jsonb(sup.suppression_rows) AS suppression_data,
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
    FROM prospect_paths pp
    CROSS JOIN LATERAL (SELECT (pp.p).*) p
    CROSS JOIN LATERAL (SELECT (pp.mo).*) mo
    CROSS JOIN LATERAL (SELECT (pp.pr).*) pr
    LEFT JOIN LATERAL (
      SELECT linked_ph.*
      FROM (
        SELECT ph.*, 1 AS link_rank
        FROM public.phones ph
        WHERE ph.canonical_e164 IS NOT NULL
          AND (
            ph.phone_type IS NULL
            OR ph.phone_type = ''
            OR lower(ph.phone_type) IN ('mobile', 'voip', 'unknown', 'wireless', 'cell', 'cellular', 'w')
          )
          AND ph.primary_prospect_id = pr.prospect_id
        UNION ALL
        SELECT ph.*, 2 AS link_rank
        FROM public.phones ph
        WHERE ph.canonical_e164 IS NOT NULL
          AND (
            ph.phone_type IS NULL
            OR ph.phone_type = ''
            OR lower(ph.phone_type) IN ('mobile', 'voip', 'unknown', 'wireless', 'cell', 'cellular', 'w')
          )
          AND ph.canonical_prospect_id = pr.canonical_prospect_id
          AND NOT (
            ph.primary_prospect_id IS NOT NULL
            AND ph.primary_prospect_id = pr.prospect_id
          )
        UNION ALL
        SELECT ph.*, 3 AS link_rank
        FROM public.phones ph
        WHERE ph.canonical_e164 IS NOT NULL
          AND (
            ph.phone_type IS NULL
            OR ph.phone_type = ''
            OR lower(ph.phone_type) IN ('mobile', 'voip', 'unknown', 'wireless', 'cell', 'cellular', 'w')
          )
          AND ph.master_owner_id IS NOT NULL
          AND ph.master_owner_id = mo.master_owner_id
          AND NOT (
            (
              ph.primary_prospect_id IS NOT NULL
              AND ph.primary_prospect_id = pr.prospect_id
            ) OR (
              ph.canonical_prospect_id IS NOT NULL
              AND ph.canonical_prospect_id = pr.canonical_prospect_id
            )
          )
      ) linked_ph
      ORDER BY
        linked_ph.link_rank,
        COALESCE(linked_ph.is_best_phone_for_slot, false) DESC,
        COALESCE(linked_ph.is_best_phone_for_owner, false) DESC,
        linked_ph.best_phone_score DESC NULLS LAST,
        COALESCE(linked_ph.updated_at, linked_ph.created_at) DESC NULLS LAST
      LIMIT 1
    ) ph ON true
    LEFT JOIN active_queue_by_phone aq
      ON aq.canonical_e164 = ph.canonical_e164
    LEFT JOIN latest_contact_by_phone latest
      ON latest.canonical_e164 = ph.canonical_e164
    LEFT JOIN suppression_by_phone sup
      ON sup.canonical_e164 = ph.canonical_e164
    LEFT JOIN sender_markets sm
      ON sm.sender_market = COALESCE(NULLIF(p.market, ''), NULLIF(mo.routing_market, ''), NULLIF(pr.primary_market, ''), NULLIF(ph.primary_market, ''))
  )
  INSERT INTO public.campaign_target_graph (
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
      'campaign_target_graph.refresh' AS graph_source,
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
      property_id = EXCLUDED.property_id,
      property_export_id = EXCLUDED.property_export_id,
      master_owner_id = EXCLUDED.master_owner_id,
      prospect_id = EXCLUDED.prospect_id,
      canonical_prospect_id = EXCLUDED.canonical_prospect_id,
      phone_id = EXCLUDED.phone_id,
      canonical_e164 = EXCLUDED.canonical_e164,
      market = EXCLUDED.market,
      state = EXCLUDED.state,
      property_city = EXCLUDED.property_city,
      property_zip = EXCLUDED.property_zip,
      property_county_name = EXCLUDED.property_county_name,
      property_type = EXCLUDED.property_type,
      property_class = EXCLUDED.property_class,
      canonical_property_group = EXCLUDED.canonical_property_group,
      language = EXCLUDED.language,
      age_bucket = EXCLUDED.age_bucket,
      occupation_group = EXCLUDED.occupation_group,
      education_model = EXCLUDED.education_model,
      income = EXCLUDED.income,
      owner_type_guess = EXCLUDED.owner_type_guess,
      priority_tier = EXCLUDED.priority_tier,
      follow_up_cadence = EXCLUDED.follow_up_cadence,
      rehab_level = EXCLUDED.rehab_level,
      sms_eligible = EXCLUDED.sms_eligible,
      true_post_contact_suppression = EXCLUDED.true_post_contact_suppression,
      wrong_number = EXCLUDED.wrong_number,
      pending_prior_touch = EXCLUDED.pending_prior_touch,
      active_queue_item = EXCLUDED.active_queue_item,
      sender_covered = EXCLUDED.sender_covered,
      sender_market = EXCLUDED.sender_market,
      timezone = EXCLUDED.timezone,
      best_phone_score = EXCLUDED.best_phone_score,
      phone_owner = EXCLUDED.phone_owner,
      phone_activity_status = EXCLUDED.phone_activity_status,
      usage_12_months = EXCLUDED.usage_12_months,
      usage_2_months = EXCLUDED.usage_2_months,
      template_use_case = EXCLUDED.template_use_case,
      contact_window = EXCLUDED.contact_window,
      latest_contact_at = EXCLUDED.latest_contact_at,
      last_outbound_at = EXCLUDED.last_outbound_at,
      last_inbound_at = EXCLUDED.last_inbound_at,
      routing_tier = EXCLUDED.routing_tier,
      identity_alignment = EXCLUDED.identity_alignment,
      acquisition_score = EXCLUDED.acquisition_score,
      podio_tags = EXCLUDED.podio_tags,
      matching_flags = EXCLUDED.matching_flags,
      matching_flags_text = EXCLUDED.matching_flags_text,
      owner_name = EXCLUDED.owner_name,
      seller_first_name = EXCLUDED.seller_first_name,
      seller_full_name = EXCLUDED.seller_full_name,
      property_address_full = EXCLUDED.property_address_full,
      estimated_value = EXCLUDED.estimated_value,
      equity_amount = EXCLUDED.equity_amount,
      equity_percent = EXCLUDED.equity_percent,
      cash_offer = EXCLUDED.cash_offer,
      touch_count = EXCLUDED.touch_count,
      current_touch_number = EXCLUDED.current_touch_number,
      never_contacted = EXCLUDED.never_contacted,
      queue_eligible = EXCLUDED.queue_eligible,
      queue_block_reason = EXCLUDED.queue_block_reason,
      graph_source = EXCLUDED.graph_source,
      linkage_counts = EXCLUDED.linkage_counts,
      blocker_flags = EXCLUDED.blocker_flags,
      extra_data = EXCLUDED.extra_data,
      source_updated_at = EXCLUDED.source_updated_at,
      generated_at = EXCLUDED.generated_at;

  GET DIAGNOSTICS v_graph_rows = ROW_COUNT;

  SELECT COUNT(*)::integer
  INTO v_rows_after_property_join
  FROM public.properties;

  SELECT COUNT(*)::integer
  INTO v_rows_after_owner_join
  FROM public.properties p
  JOIN public.master_owners mo
    ON mo.master_owner_id = p.master_owner_id;

  v_rows_after_owner_join := GREATEST(v_rows_after_owner_join, v_graph_rows);

  SELECT COUNT(*)::integer
  INTO v_rows_after_prospect_join
  FROM public.campaign_target_graph
  WHERE prospect_id IS NOT NULL;

  SELECT COUNT(*)::integer
  INTO v_rows_after_phone_join
  FROM public.campaign_target_graph
  WHERE phone_id IS NOT NULL
    AND canonical_e164 IS NOT NULL;

  v_rows_missing_prospect := GREATEST(v_rows_after_owner_join - v_rows_after_prospect_join, 0);
  v_rows_missing_phone := GREATEST(v_rows_after_prospect_join - v_rows_after_phone_join, 0);

  SELECT COUNT(*)::integer
  INTO v_rows_with_sms_eligible_phone
  FROM public.campaign_target_graph
  WHERE sms_eligible;

  SELECT public.refresh_campaign_target_graph_facets() INTO v_facet_rows;

  UPDATE public.campaign_target_graph_refresh_runs
  SET
    status = 'completed',
    finished_at = now(),
    graph_rows = v_graph_rows,
    facet_rows = v_facet_rows,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'graph_path', 'properties_master_owners_prospects_phones',
      'phone_join_strategy', 'phones.primary_prospect_id OR phones.canonical_prospect_id OR nullable phones.master_owner_id fallback',
      'rows_after_property_join', v_rows_after_property_join,
      'rows_after_owner_join', v_rows_after_owner_join,
      'rows_after_prospect_join', v_rows_after_prospect_join,
      'rows_after_phone_join', v_rows_after_phone_join,
      'rows_missing_phone', v_rows_missing_phone,
      'rows_missing_prospect', v_rows_missing_prospect,
      'rows_with_sms_eligible_phone', v_rows_with_sms_eligible_phone
    )
  WHERE id = v_run_id;

  graph_rows := v_graph_rows;
  facet_rows := v_facet_rows;
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  UPDATE public.campaign_target_graph_refresh_runs
  SET
    status = 'failed',
    finished_at = now(),
    error_message = SQLERRM,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'graph_path', 'properties_master_owners_prospects_phones',
      'error_sqlstate', SQLSTATE
    )
  WHERE id = v_run_id;
  RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph() TO service_role;
