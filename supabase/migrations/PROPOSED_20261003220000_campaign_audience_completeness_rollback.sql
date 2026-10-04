-- ROLLBACK for PROPOSED_20261003220000_campaign_audience_completeness.sql and
-- PROPOSED_20261003221000_campaign_audience_schedule.sql.
--
-- Data note: the graph is a disposable projection. Rolling back the code restores the
-- old functions; values already projected into existing columns (names, demographics,
-- recency, eligibility) stay until the next full refresh rebuilds the graph with the
-- old bridge (refresh_campaign_target_graph_staged). Nothing authoritative was written.

--
-- If the schedule was enabled, FIRST run
--   PROPOSED_20261003221000_campaign_audience_schedule_rollback.sql
-- (unschedules the jobs, drops the concurrent index; cannot run in a transaction).
-- This file has no BEGIN/COMMIT: apply it with  psql -X -1 -v ON_ERROR_STOP=1 -f …
-- Locks: DROP COLUMN takes ACCESS EXCLUSIVE on the graph and stage (metadata only).

SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.campaign_target_graph_incremental_tick(integer);
DROP FUNCTION IF EXISTS public.campaign_target_graph_reconcile_tick(integer, integer);
DROP FUNCTION IF EXISTS public.campaign_target_graph_enrich_batch(text, integer);
DROP FUNCTION IF EXISTS public.campaign_target_graph_enrich_market(text, text, integer);
DROP FUNCTION IF EXISTS public.campaign_target_graph_enrich_rows(text[]);
DROP FUNCTION IF EXISTS public.campaign_target_graph_measure_coverage(text, numeric);
DROP FUNCTION IF EXISTS public.campaign_target_graph_load_ok(integer);
DROP TABLE IF EXISTS public.campaign_target_graph_coverage;
DROP TABLE IF EXISTS public.campaign_target_graph_sync_state;

-- Live definitions captured 2026-10-03 (pg_get_functiondef), restored verbatim.
CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_seller_batch(p_run_id uuid, p_batch_limit integer DEFAULT 10000, p_batch_offset integer DEFAULT 0)
 RETURNS TABLE(run_id uuid, batch_number integer, batch_type text, batch_key text, batch_start text, batch_end text, source_rows integer, rows_inserted integer, stage_rows integer, has_more boolean, elapsed_ms integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started_at timestamptz := clock_timestamp();
  v_batch_id uuid;
  v_batch_number integer;
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
  v_run_exists boolean := false;
BEGIN
  PERFORM set_config('statement_timeout', '0', true);
  PERFORM set_config('work_mem', '256MB', true);

  SELECT EXISTS (
    SELECT 1 FROM public.campaign_target_graph_refresh_runs r
    WHERE r.id = p_run_id AND r.status = 'started'
  ) INTO v_run_exists;

  IF NOT v_run_exists THEN
    RAISE EXCEPTION 'campaign target graph refresh run % is not active', p_run_id;
  END IF;

  v_batch_key := concat('seller_contact_offset:', v_offset, ':limit:', v_limit);

  SELECT COALESCE(MAX(b.batch_number), 0) + 1 INTO v_batch_number
  FROM public.campaign_target_graph_refresh_batches b WHERE b.run_id = p_run_id;

  -- Source is public.properties ordered stably. The set does NOT shrink as rows
  -- are staged, so the caller MUST advance the offset (see runner).
  WITH property_batch AS (
    SELECT p.*
    FROM public.properties p
    ORDER BY p.property_id
    LIMIT v_limit OFFSET v_offset
  ),
  -- ---- Canonical contact resolution: seller model, disjoint union -------------
  resolved AS (
    SELECT
      p.*,
      c.sel_phone, c.sel_role, c.sel_type, c.sel_lane,
      c.owner_resolution_status, c.role_confidence,
      c.vendor_dnc, c.wrong_number_flag, c.operational_flag,
      c.sel_master_owner_id, c.contact_version, c.as_of_date,
      -- Canonical person key (lane B supplies it directly; lane A resolves it
      -- from property_owner_resolution_v1 below) and the entity review flag.
      c.sel_person_key, c.sel_requires_review, c.sel_exclusion_reasons,
      ident.individual_key, ident.res_master_owner_id
    FROM property_batch p
    LEFT JOIN LATERAL (
      -- Lane A: individually-resolved owners.
      SELECT
        -- Campaign policy: prefer an SMS-capable (wireless) number while keeping
        -- the seller model's legal/reach semantics as provenance.
        CASE WHEN bc.legal_phone_type = 'W' AND NULLIF(bc.legal_phone,'') IS NOT NULL THEN bc.legal_phone
             WHEN bc.reach_phone_type = 'W' AND NULLIF(bc.reach_phone,'') IS NOT NULL THEN bc.reach_phone
             WHEN NULLIF(bc.legal_phone,'') IS NOT NULL THEN bc.legal_phone
             ELSE NULLIF(bc.reach_phone,'') END AS sel_phone,
        CASE WHEN bc.legal_phone_type = 'W' AND NULLIF(bc.legal_phone,'') IS NOT NULL THEN 'legal'
             WHEN bc.reach_phone_type = 'W' AND NULLIF(bc.reach_phone,'') IS NOT NULL THEN 'reach'
             WHEN NULLIF(bc.legal_phone,'') IS NOT NULL THEN 'legal'
             ELSE 'reach' END AS sel_role,
        CASE WHEN bc.legal_phone_type = 'W' AND NULLIF(bc.legal_phone,'') IS NOT NULL THEN 'W'
             WHEN bc.reach_phone_type = 'W' AND NULLIF(bc.reach_phone,'') IS NOT NULL THEN 'W'
             WHEN NULLIF(bc.legal_phone,'') IS NOT NULL THEN bc.legal_phone_type
             ELSE bc.reach_phone_type END AS sel_type,
        'best_contact'::text AS sel_lane,
        bc.owner_resolution_status,
        NULL::text AS role_confidence,
        (bc.excluded_vendor_dnc > 0) AS vendor_dnc,
        (bc.excluded_wrong_number > 0) AS wrong_number_flag,
        (bc.excluded_operational > 0) AS operational_flag,
        NULL::text AS sel_master_owner_id,
        bc.contact_version, bc.as_of_date,
        -- Lane A carries no identity key of its own; it is resolved below from
        -- property_owner_resolution_v1, which is the canonical person resolver.
        NULL::text AS sel_person_key,
        NULL::boolean AS sel_requires_review,
        NULL::text[] AS sel_exclusion_reasons,
        -- Raw candidates, kept so an encrypted primary pick can fall back to the
        -- other role before we give up on the property entirely.
        NULLIF(bc.legal_phone,'') AS raw_legal_phone,
        NULLIF(bc.reach_phone,'') AS raw_reach_phone
      FROM seller.property_best_contact_v1 bc
      WHERE bc.property_id = p.property_id
      UNION ALL
      -- Lane B: entity-owned. ENT_NO_COMPLIANT_CHANNEL is an operational block.
      SELECT
        NULLIF(ec.selected_phone,''),
        COALESCE(NULLIF(ec.contact_role,''), 'entity'),
        NULL::text,
        'entity_contact'::text,
        'entity_owned'::text,
        ec.role_confidence::text,
        false,
        false,
        ('ENT_NO_COMPLIANT_CHANNEL' = ANY(ec.exclusion_reasons)),
        ec.selected_master_owner_id,
        NULL::text, ec.as_of_date,
        ec.selected_person_key,
        ec.requires_review,
        ec.exclusion_reasons,
        NULLIF(ec.selected_phone,''),
        NULL::text
      FROM seller.property_entity_contact_v1 ec
      WHERE ec.property_id = p.property_id
      LIMIT 1
    ) c ON true
    -- Canonical person identity. seller.* owns WHO; campaign owns WHETHER.
    -- prospect_id / phone_id do not exist anywhere in the seller schema, so they
    -- stay NULL provenance rather than being manufactured from the stale
    -- public.phones export (which covers only 37.7% of the modern corpus).
    LEFT JOIN LATERAL (
      SELECT r.individual_key, r.master_owner_id AS res_master_owner_id
      FROM seller.property_owner_resolution_v1 r
      WHERE r.property_id = p.property_id
      LIMIT 1
    ) ident ON true
  ),
  -- ---- Destination phone validation + re-resolution ---------------------------
  -- seller.owner_phone.is_encrypted is authoritative: 627,568 of 1,375,740 rows
  -- hold an `IV:ciphertext` payload, and the materialized contact snapshot
  -- selects phone_value without honouring the flag. Those payloads reached
  -- canonical_e164 and 13% of them salvaged into a syntactically valid E.164.
  --
  -- A pick that is not exactly ten digits is never trusted. We re-resolve to the
  -- owner's best PLAINTEXT phone before abandoning the property, and only fall
  -- through to missing_phone when the person genuinely has no usable number.
  contact AS (
    SELECT
      r.*,
      COALESCE(r.sel_person_key, r.individual_key) AS person_key,
      recov.phone_value AS recovered_phone,
      recov.phone_type  AS recovered_type,
      CASE
        WHEN r.sel_phone ~ '^[0-9]{10}$' THEN r.sel_phone
        ELSE recov.phone_value
      END AS final_phone,
      CASE
        WHEN r.sel_phone ~ '^[0-9]{10}$' THEN r.sel_type
        ELSE recov.phone_type
      END AS final_type,
      (r.sel_phone IS NOT NULL AND r.sel_phone !~ '^[0-9]{10}$') AS phone_was_unusable
    FROM resolved r
    LEFT JOIN LATERAL (
      SELECT op.phone_value, op.phone_type
      FROM seller.owner_phone op
      WHERE (r.sel_phone IS NULL OR r.sel_phone !~ '^[0-9]{10}$')
        AND op.individual_key = COALESCE(r.sel_person_key, r.individual_key)
        AND op.is_encrypted = false
        AND op.phone_value ~ '^[0-9]{10}$'
      -- Wireless first (SMS-capable), then lowest slot = highest confidence.
      ORDER BY (op.phone_type = 'W') DESC, op.slot ASC
      LIMIT 1
    ) recov ON true
  ),
  -- ---- Campaign-side operational state (unchanged logic, keyed on the
  --      canonically-resolved phone rather than public.phones) -----------------
  flagged AS (
    SELECT
      r.*,
      COALESCE(sup.is_suppressed, false) AS supp_flag,
      COALESCE(aq.active_queue_count, 0) > 0 AS active_q,
      latest.last_inbound_at, latest.last_outbound_at,
      sm.sender_market, sm.route_type AS routing_tier, sm.sender_covered AS route_covered,
      sm.safe_sender_count
    FROM contact r
    LEFT JOIN LATERAL (
      -- UNION ALL, not `phone_e164 = x OR phone_number = x`. There is an index on
      -- phone_e164 but NONE on phone_number, so the OR form degrades to a seq scan
      -- of the suppression list for every property. The original pipeline split it
      -- for exactly this reason.
      SELECT bool_or(COALESCE(sl.is_active, true)) AS is_suppressed
      FROM (
        SELECT s1.is_active FROM public.sms_suppression_list s1
        WHERE s1.phone_e164 = r.final_phone
        UNION ALL
        SELECT s2.is_active FROM public.sms_suppression_list s2
        WHERE s2.phone_number = r.final_phone
          AND s2.phone_e164 IS DISTINCT FROM r.final_phone
      ) sl
    ) sup ON r.final_phone IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::integer AS active_queue_count
      FROM public.send_queue sq
      WHERE sq.to_phone_number = r.final_phone
        AND lower(COALESCE(sq.queue_status,'')) IN
            ('queued','scheduled','pending','ready','approved','processing','sending')
    ) aq ON r.final_phone IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT MAX(li) AS last_inbound_at, MAX(lo) AS last_outbound_at
      FROM (
        SELECT MAX(COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.created_at)) AS li,
               NULL::timestamptz AS lo
        FROM public.message_events me
        WHERE me.from_phone_number = r.final_phone AND lower(COALESCE(me.direction,'')) LIKE 'in%'
        UNION ALL
        SELECT NULL::timestamptz,
               MAX(COALESCE(me.event_timestamp, me.sent_at, me.received_at, me.created_at))
        FROM public.message_events me
        WHERE me.to_phone_number = r.final_phone AND lower(COALESCE(me.direction,'')) LIKE 'out%'
        UNION ALL
        SELECT NULL::timestamptz,
               MAX(COALESCE(sq.sent_at, sq.scheduled_for_utc, sq.scheduled_for, sq.created_at))
        FROM public.send_queue sq WHERE sq.to_phone_number = r.final_phone
      ) ev
    ) latest ON r.final_phone IS NOT NULL
    -- Sender routing: call the SHARED authority, do not re-derive it. This is the
    -- same function refresh_campaign_target_graph_sender_coverage() uses after
    -- commit, so that post-commit pass becomes idempotent over what we write here
    -- and the staged graph equals the committed graph.
    --
    -- It implements approved CROSS-STATE routing (AZ -> Los Angeles CA,
    -- IL -> Minneapolis MN, PA -> Miami FL, ...). Every target market has eligible
    -- live senders -- verified 2026-08-24: 165,215 covered rows, zero routed to a
    -- market without one. An earlier version of this bridge checked only exact
    -- market + same state, which is why staged and live disagreed by ~41k.
    CROSS JOIN LATERAL public.resolve_campaign_safe_sender_route(
      r.market,
      upper(NULLIF(r.property_address_state, ''))
    ) sm
  )
  INSERT INTO public.campaign_target_graph_stage (
    graph_id, property_id, property_export_id, master_owner_id, prospect_id, phone_id,
    seller_person_key,
    canonical_e164, market, state, property_city, property_zip, property_county_name,
    property_type, property_class, canonical_property_group, owner_type_guess, priority_tier,
    rehab_level, sms_eligible, true_post_contact_suppression, wrong_number,
    pending_prior_touch, active_queue_item, sender_covered, sender_market, timezone,
    template_use_case, contact_window, latest_contact_at, last_outbound_at, last_inbound_at,
    routing_tier, identity_alignment, acquisition_score, podio_tags, matching_flags,
    owner_name, property_address_full, estimated_value, equity_amount, equity_percent,
    cash_offer, touch_count, current_touch_number, never_contacted, queue_eligible,
    queue_block_reason, graph_source, linkage_counts, blocker_flags, extra_data,
    source_updated_at, tax_delinquent, active_lien, is_corporate_owner, out_of_state_owner
  )
  SELECT
    md5(concat_ws('|','seller_contact', f.property_id, f.final_phone)),
    f.property_id, f.property_export_id,
    -- master_owner_id is carried when the canonical source has it (22% of the
    -- corpus) but is NOT a readiness requirement.
    COALESCE(f.sel_master_owner_id, f.res_master_owner_id, f.master_owner_id),
    -- prospect_id / phone_id: nullable legacy provenance. The seller schema has
    -- no such keys, and manufacturing them from public.phones would cap the
    -- modern corpus at 37.7%. Readiness no longer depends on them.
    NULL, NULL,
    f.person_key,
    f.final_phone,
    NULLIF(f.market,''), upper(NULLIF(f.property_address_state,'')),
    f.property_address_city, NULLIF(f.property_address_zip,''), NULLIF(f.property_address_county_name,''),
    f.property_type, f.property_class,
    COALESCE(NULLIF(f.property_group,''), NULLIF(f.normalized_asset_class,''), NULLIF(f.property_class,''), NULLIF(f.property_type,'')),
    COALESCE(NULLIF(f.owner_type_guess,''), NULLIF(f.owner_type,'')),
    NULLIF(f.priority_tier,''),
    COALESCE(NULLIF(f.rehab_level,''), NULLIF(f.renovation_level_classification,''), NULLIF(f.building_condition,'')),
    -- SMS-eligible: a resolved phone that is SMS-capable and not a known wrong number.
    -- Vendor DNC deliberately does NOT participate.
    (f.final_phone IS NOT NULL AND COALESCE(f.final_type,'W') = 'W' AND NOT COALESCE(f.wrong_number_flag,false)),
    (COALESCE(f.supp_flag,false) OR COALESCE(f.operational_flag,false)), COALESCE(f.wrong_number_flag,false),
    (f.last_outbound_at IS NOT NULL AND f.last_outbound_at >= now() - interval '30 days'),
    f.active_q,
    COALESCE(f.route_covered,false), f.sender_market,
    -- Timezone from canonical property geography. Required by campaign target
    -- readiness (hasTimezone) and by contact-window enforcement, and previously
    -- written as a literal NULL, which blocked every row with missing_timezone.
    -- Standard US state -> IANA zone; no campaign-specific timezone system.
    CASE upper(NULLIF(f.property_address_state,''))
      WHEN 'CT' THEN 'America/New_York'    WHEN 'DE' THEN 'America/New_York'
      WHEN 'DC' THEN 'America/New_York'    WHEN 'FL' THEN 'America/New_York'
      WHEN 'GA' THEN 'America/New_York'    WHEN 'ME' THEN 'America/New_York'
      WHEN 'MD' THEN 'America/New_York'    WHEN 'MA' THEN 'America/New_York'
      WHEN 'MI' THEN 'America/New_York'    WHEN 'NH' THEN 'America/New_York'
      WHEN 'NJ' THEN 'America/New_York'    WHEN 'NY' THEN 'America/New_York'
      WHEN 'NC' THEN 'America/New_York'    WHEN 'OH' THEN 'America/New_York'
      WHEN 'PA' THEN 'America/New_York'    WHEN 'RI' THEN 'America/New_York'
      WHEN 'SC' THEN 'America/New_York'    WHEN 'VT' THEN 'America/New_York'
      WHEN 'VA' THEN 'America/New_York'    WHEN 'WV' THEN 'America/New_York'
      WHEN 'IN' THEN 'America/Indiana/Indianapolis'
      WHEN 'AL' THEN 'America/Chicago'     WHEN 'AR' THEN 'America/Chicago'
      WHEN 'IL' THEN 'America/Chicago'     WHEN 'IA' THEN 'America/Chicago'
      WHEN 'KS' THEN 'America/Chicago'     WHEN 'KY' THEN 'America/Chicago'
      WHEN 'LA' THEN 'America/Chicago'     WHEN 'MN' THEN 'America/Chicago'
      WHEN 'MS' THEN 'America/Chicago'     WHEN 'MO' THEN 'America/Chicago'
      WHEN 'NE' THEN 'America/Chicago'     WHEN 'ND' THEN 'America/Chicago'
      WHEN 'OK' THEN 'America/Chicago'     WHEN 'SD' THEN 'America/Chicago'
      WHEN 'TN' THEN 'America/Chicago'     WHEN 'TX' THEN 'America/Chicago'
      WHEN 'WI' THEN 'America/Chicago'
      WHEN 'AZ' THEN 'America/Phoenix'
      WHEN 'CO' THEN 'America/Denver'      WHEN 'ID' THEN 'America/Denver'
      WHEN 'MT' THEN 'America/Denver'      WHEN 'NM' THEN 'America/Denver'
      WHEN 'UT' THEN 'America/Denver'      WHEN 'WY' THEN 'America/Denver'
      WHEN 'CA' THEN 'America/Los_Angeles' WHEN 'NV' THEN 'America/Los_Angeles'
      WHEN 'OR' THEN 'America/Los_Angeles' WHEN 'WA' THEN 'America/Los_Angeles'
      WHEN 'AK' THEN 'America/Anchorage'   WHEN 'HI' THEN 'Pacific/Honolulu'
      ELSE NULL
    END,
    'ownership_check',
    -- Descriptive label only. Enforcement is system_control
    -- queue_contact_window_start/end evaluated in the row's timezone.
    (SELECT concat(public.queue_system_control_text('queue_contact_window_start'),
                   '-',
                   public.queue_system_control_text('queue_contact_window_end'))),
    NULLIF(GREATEST(COALESCE(f.last_outbound_at,'epoch'::timestamptz), COALESCE(f.last_inbound_at,'epoch'::timestamptz)),'epoch'::timestamptz),
    f.last_outbound_at, f.last_inbound_at,
    COALESCE(f.routing_tier,'no_sender_route'),
    -- Canonical identity adapter.
    --
    -- This column is consumed by isIdentityEligibleForLiveOutbound and by the
    -- `likely_owner_required` targeting filter, both of which speak the POLICY
    -- vocabulary (verified/probable/entity_company_linked/...). The bridge used
    -- to emit the SELLER vocabulary (confirmed/high_confidence/entity_owned/...),
    -- which shares not one value with it, so every row fell through to
    -- identity_unknown_policy and was ineligible.
    --
    -- Operator-locked mapping (2026-08-26):
    --   confirmed / high_confidence / medium_confidence -> eligible
    --   entity_owned -> eligible ONLY with a resolved person key and no review
    --                   or conflict flag
    --   ambiguous -> unknown (blocked), conflicting -> mismatch (hard block)
    CASE
      -- Entity lane: a resolved human identity with a valid phone tied to the
      -- property-owning entity is outbound-eligible. Operator decision
      -- (2026-08-26): lack of independently corroborated officer/title status
      -- (ENT_ROLE_UNCORROBORATED, role_confidence 0.3, requires_review=true) is
      -- PROVENANCE, not a Campaign hard block — it was excluding 19,346 LLC and
      -- corporate-owned properties that we can in fact reach. The flags are
      -- preserved verbatim in extra_data so this cohort stays segmentable and
      -- auditable. Only a genuinely unresolved entity linkage blocks.
      WHEN f.sel_lane = 'entity_contact' THEN
        CASE
          WHEN f.person_key IS NOT NULL THEN 'entity_company_linked'
          ELSE 'unknown'
        END
      WHEN f.owner_resolution_status = 'confirmed'                       THEN 'verified'
      WHEN f.owner_resolution_status = 'high_confidence'                 THEN 'probable'
      WHEN f.owner_resolution_status = 'medium_confidence'               THEN 'probable'
      WHEN f.owner_resolution_status = 'ambiguous'                       THEN 'unknown'
      WHEN f.owner_resolution_status = 'conflicting_existing_assignment' THEN 'mismatch'
      ELSE 'unknown'
    END,
    f.final_acquisition_score,
    COALESCE(NULLIF(f.seller_tags_text,''), NULLIF(f.podio_tags,'')),
    '{}'::jsonb,
    COALESCE(NULLIF(f.owner_display_name,''), NULLIF(f.owner_name,'')),
    COALESCE(NULLIF(f.property_address_full,''), NULLIF(f.property_address,'')),
    f.estimated_value, f.equity_amount, f.equity_percent, f.cash_offer,
    CASE WHEN f.last_outbound_at IS NULL THEN 0 ELSE 1 END,
    1,
    f.last_outbound_at IS NULL,
    -- queue_eligible: survives the full precedence chain
    (
      f.final_phone IS NOT NULL
      AND NOT COALESCE(f.wrong_number_flag,false)
      AND COALESCE(f.final_type,'W') = 'W'
      AND NOT COALESCE(f.supp_flag,false)
      AND NOT COALESCE(f.operational_flag,false)
      AND NOT (f.last_outbound_at IS NOT NULL AND f.last_outbound_at >= now() - interval '30 days')
      AND NOT COALESCE(f.active_q,false)
      AND COALESCE(f.route_covered,false)
    ),
    -- Exclusive precedence. Order is operator-locked; do not reorder.
    CASE
      WHEN f.final_phone IS NULL                                      THEN 'missing_phone'
      WHEN COALESCE(f.wrong_number_flag,false)                      THEN 'wrong_number'
      WHEN COALESCE(f.final_type,'W') <> 'W'                          THEN 'non_sms_capable'
      WHEN COALESCE(f.supp_flag,false) OR COALESCE(f.operational_flag,false) THEN 'suppressed'
      WHEN f.last_outbound_at IS NOT NULL
           AND f.last_outbound_at >= now() - interval '30 days'      THEN 'pending_prior_touch'
      WHEN COALESCE(f.active_q,false)                               THEN 'active_queue_item'
      WHEN NOT COALESCE(f.route_covered,false)                      THEN 'no_sender_coverage'
      ELSE NULL
    END,
    'campaign_target_graph.refresh.seller_contact_bridge',
    jsonb_build_object('property',1,'contact_lane', f.sel_lane,
                       'phone', CASE WHEN f.final_phone IS NOT NULL THEN 1 ELSE 0 END,
                       'sender_numbers', COALESCE(f.safe_sender_count,0)),
    -- Diagnostic flags retained separately from the exclusive reason, so an
    -- overlapping condition is never lost just because another one won precedence.
    jsonb_strip_nulls(jsonb_build_object(
      'vendor_dnc', COALESCE(f.vendor_dnc,false),
      'wrong_number', COALESCE(f.wrong_number_flag,false),
      'operational_excluded', COALESCE(f.operational_flag,false),
      'suppressed', COALESCE(f.supp_flag,false),
      'active_queue', COALESCE(f.active_q,false),
      'non_sms_capable', (f.final_phone IS NOT NULL AND COALESCE(f.final_type,'W') <> 'W'),
      'source_phone_unusable', COALESCE(f.phone_was_unusable,false)
    )),
    jsonb_strip_nulls(jsonb_build_object(
      'contact_lane', f.sel_lane,
      'phone_role', f.sel_role,
      'phone_type', f.sel_type,
      'owner_resolution_status', f.owner_resolution_status,
      'seller_person_key', f.person_key,
      'phone_reresolved', f.phone_was_unusable,
      'entity_requires_review', f.sel_requires_review,
      'entity_exclusion_reasons', to_jsonb(f.sel_exclusion_reasons),
      'role_confidence', f.role_confidence,
      'contact_version', f.contact_version,
      'as_of_date', f.as_of_date,
      'source', 'seller.property_best_contact_v1|property_entity_contact_v1'
    )),
    COALESCE(f.updated_at, f.created_at, now()),
    f.tax_delinquent, f.active_lien, f.is_corporate_owner, f.out_of_state_owner
  FROM flagged f
  ON CONFLICT (graph_id) DO NOTHING;

  GET DIAGNOSTICS v_rows_inserted = ROW_COUNT;

  SELECT COUNT(*)::integer INTO v_source_rows FROM (
    SELECT 1 FROM public.properties ORDER BY property_id LIMIT v_limit OFFSET v_offset
  ) s;
  SELECT COUNT(*)::integer INTO v_stage_rows FROM public.campaign_target_graph_stage;
  SELECT EXISTS (
    SELECT 1 FROM public.properties ORDER BY property_id LIMIT 1 OFFSET (v_offset + v_limit)
  ) INTO v_has_more;

  v_elapsed_ms := GREATEST(0, floor(EXTRACT(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer);

  INSERT INTO public.campaign_target_graph_refresh_batches (
    run_id, batch_number, batch_type, batch_key, status, rows_inserted,
    finished_at, elapsed_ms, metadata
  ) VALUES (
    p_run_id, v_batch_number, 'seller_contact_offset', v_batch_key, 'completed', v_rows_inserted,
    clock_timestamp(), v_elapsed_ms,
    jsonb_build_object('batch_limit', v_limit, 'batch_offset', v_offset,
                       'source_rows', v_source_rows, 'has_more', v_has_more,
                       'graph_path', 'seller_contact_bridge')
  ) RETURNING id INTO v_batch_id;

  run_id := p_run_id;
  batch_number := v_batch_number;
  batch_type := 'seller_contact_offset';
  batch_key := v_batch_key;
  batch_start := NULL;
  batch_end := NULL;
  source_rows := v_source_rows;
  rows_inserted := v_rows_inserted;
  stage_rows := v_stage_rows;
  has_more := v_has_more;
  elapsed_ms := v_elapsed_ms;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.campaign_target_graph_apply_filter_columns()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;


-- Columns last: the old seller batch no longer writes build_id/built_at/phone_type.
ALTER TABLE public.campaign_target_graph
  DROP COLUMN IF EXISTS build_id, DROP COLUMN IF EXISTS built_at, DROP COLUMN IF EXISTS phone_type,
  DROP COLUMN IF EXISTS enriched_at, DROP COLUMN IF EXISTS enrich_version, DROP COLUMN IF EXISTS phone_type_source,
  DROP COLUMN IF EXISTS beds, DROP COLUMN IF EXISTS baths, DROP COLUMN IF EXISTS building_sqft,
  DROP COLUMN IF EXISTS year_built, DROP COLUMN IF EXISTS lot_sqft, DROP COLUMN IF EXISTS total_loan_balance,
  DROP COLUMN IF EXISTS ownership_years, DROP COLUMN IF EXISTS tax_delinquent_year, DROP COLUMN IF EXISTS building_quality,
  DROP COLUMN IF EXISTS estimated_repair_cost, DROP COLUMN IF EXISTS aos_score, DROP COLUMN IF EXISTS decision_tier,
  DROP COLUMN IF EXISTS acquisition_confidence, DROP COLUMN IF EXISTS transaction_probability_365,
  DROP COLUMN IF EXISTS best_strategy, DROP COLUMN IF EXISTS scores_computed_at;
ALTER TABLE public.campaign_target_graph_stage
  DROP COLUMN IF EXISTS build_id, DROP COLUMN IF EXISTS built_at, DROP COLUMN IF EXISTS phone_type,
  DROP COLUMN IF EXISTS enriched_at, DROP COLUMN IF EXISTS enrich_version, DROP COLUMN IF EXISTS phone_type_source,
  DROP COLUMN IF EXISTS beds, DROP COLUMN IF EXISTS baths, DROP COLUMN IF EXISTS building_sqft,
  DROP COLUMN IF EXISTS year_built, DROP COLUMN IF EXISTS lot_sqft, DROP COLUMN IF EXISTS total_loan_balance,
  DROP COLUMN IF EXISTS ownership_years, DROP COLUMN IF EXISTS tax_delinquent_year, DROP COLUMN IF EXISTS building_quality,
  DROP COLUMN IF EXISTS estimated_repair_cost, DROP COLUMN IF EXISTS aos_score, DROP COLUMN IF EXISTS decision_tier,
  DROP COLUMN IF EXISTS acquisition_confidence, DROP COLUMN IF EXISTS transaction_probability_365,
  DROP COLUMN IF EXISTS best_strategy, DROP COLUMN IF EXISTS scores_computed_at;
