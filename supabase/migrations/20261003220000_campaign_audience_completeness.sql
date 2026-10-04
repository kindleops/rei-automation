-- PROPOSED — NOT APPLIED. Campaign audience data completeness (2026-10-03).
--
-- campaign_target_graph is a DISPOSABLE TARGETING PROJECTION. properties, seller.*,
-- phones, prospects, message_events, send_queue, sms_suppression_list and
-- property_acquisition_scores stay authoritative; nothing here writes to them.
--
-- What this fixes (evidence: ~/.claude/jobs/c39b0175/tmp/audience-complete/):
--   1. 20 catalog fields were 0% filled in the graph although their sources are
--      84-100% filled (seller.owner demographics + names, owner_phone carrier,
--      properties.units_count, …). The seller_contact_bridge never projected them.
--   2. Phone format: the graph stores 10-digit numbers; message_events and
--      sms_suppression_list store +1E.164. The refresh compared them raw, so
--      last_outbound_at/latest_contact_at were 0% filled, pending_prior_touch never
--      fired and the opt-out list never reached the graph. Minneapolis today: 513
--      queue_eligible rows were texted in the last 30 days and 17 are opted out
--      (the enqueue gate still refuses them — the counts were inflated, not the sends).
--   3. Phone type: unknown was treated as wireless (COALESCE(final_type,'W')), only
--      'W' was accepted, and every entity contact was written with a NULL type.
--      Minneapolis: of 818 entity rows marked SMS-eligible, 180 are landlines by the
--      person's own owner_phone record and 8 have no record at all.
--      Unknown is now NOT SMS-capable; 'Wireless' is accepted.
--   4. building_condition was back-filled from rehab_level by the filter-column trigger.
--   5. Canonical scores (property_acquisition_scores) are projected; legacy Podio-era
--      scores are not.
--   6. Every row carries build_id/built_at (contact resolution) and enriched_at
--      (projection); coverage is measured per field into campaign_target_graph_coverage.
--
-- Load safety: enrichment is set-based over at most a few hundred graph_ids per call
-- (measured read side: 1.6-2.2 s per 500 rows). No call scans a whole source table
-- except message_events / send_queue / sms_suppression_list, which are small (14.5K /
-- 19.2K / 348 rows) and are filtered to the batch's phones first.
-- Schedules live in 20261003221000_campaign_audience_schedule.sql and are
-- applied only after the canary in the run plan.
--
-- No BEGIN/COMMIT in this file: apply it as ONE transaction with
--   psql "$SUPABASE_DB_URL" -X -1 -v ON_ERROR_STOP=1 -f <this file>
-- so the rollback-only pretest (supabase/tests/campaign_audience_completeness_test.sql)
-- can \ir it inside its own transaction.
--
-- Locks: ALTER TABLE … ADD COLUMN (no default, metadata only) takes ACCESS EXCLUSIVE on
-- campaign_target_graph and campaign_target_graph_stage until COMMIT — readers of the
-- graph (Composer, Reach, Build) wait for the few hundred ms the transaction takes.
-- lock_timeout 5s: if a long reader holds the graph, the apply fails cleanly instead of
-- queueing every reader behind it. Everything else is new objects or pg_proc rows.

SET LOCAL lock_timeout = '5s';

-- ── 1. Projection columns (graph and stage, identical order: commit is INSERT … SELECT *) ──
ALTER TABLE public.campaign_target_graph
  ADD COLUMN IF NOT EXISTS build_id uuid,
  ADD COLUMN IF NOT EXISTS built_at timestamptz,
  ADD COLUMN IF NOT EXISTS phone_type text,
  ADD COLUMN IF NOT EXISTS enriched_at timestamptz,
  ADD COLUMN IF NOT EXISTS enrich_version text,
  ADD COLUMN IF NOT EXISTS phone_type_source text,
  ADD COLUMN IF NOT EXISTS beds numeric,
  ADD COLUMN IF NOT EXISTS baths numeric,
  ADD COLUMN IF NOT EXISTS building_sqft numeric,
  ADD COLUMN IF NOT EXISTS year_built integer,
  ADD COLUMN IF NOT EXISTS lot_sqft numeric,
  ADD COLUMN IF NOT EXISTS total_loan_balance numeric,
  ADD COLUMN IF NOT EXISTS ownership_years numeric,
  ADD COLUMN IF NOT EXISTS tax_delinquent_year integer,
  ADD COLUMN IF NOT EXISTS building_quality text,
  ADD COLUMN IF NOT EXISTS estimated_repair_cost numeric,
  ADD COLUMN IF NOT EXISTS aos_score integer,
  ADD COLUMN IF NOT EXISTS decision_tier text,
  ADD COLUMN IF NOT EXISTS acquisition_confidence integer,
  ADD COLUMN IF NOT EXISTS transaction_probability_365 integer,
  ADD COLUMN IF NOT EXISTS best_strategy text,
  ADD COLUMN IF NOT EXISTS scores_computed_at timestamptz;

ALTER TABLE public.campaign_target_graph_stage
  ADD COLUMN IF NOT EXISTS build_id uuid,
  ADD COLUMN IF NOT EXISTS built_at timestamptz,
  ADD COLUMN IF NOT EXISTS phone_type text,
  ADD COLUMN IF NOT EXISTS enriched_at timestamptz,
  ADD COLUMN IF NOT EXISTS enrich_version text,
  ADD COLUMN IF NOT EXISTS phone_type_source text,
  ADD COLUMN IF NOT EXISTS beds numeric,
  ADD COLUMN IF NOT EXISTS baths numeric,
  ADD COLUMN IF NOT EXISTS building_sqft numeric,
  ADD COLUMN IF NOT EXISTS year_built integer,
  ADD COLUMN IF NOT EXISTS lot_sqft numeric,
  ADD COLUMN IF NOT EXISTS total_loan_balance numeric,
  ADD COLUMN IF NOT EXISTS ownership_years numeric,
  ADD COLUMN IF NOT EXISTS tax_delinquent_year integer,
  ADD COLUMN IF NOT EXISTS building_quality text,
  ADD COLUMN IF NOT EXISTS estimated_repair_cost numeric,
  ADD COLUMN IF NOT EXISTS aos_score integer,
  ADD COLUMN IF NOT EXISTS decision_tier text,
  ADD COLUMN IF NOT EXISTS acquisition_confidence integer,
  ADD COLUMN IF NOT EXISTS transaction_probability_365 integer,
  ADD COLUMN IF NOT EXISTS best_strategy text,
  ADD COLUMN IF NOT EXISTS scores_computed_at timestamptz;

-- Pretest: the two tables must still line up column-for-column (commit is SELECT *).
DO $$
DECLARE v_g text; v_s text;
BEGIN
  SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) INTO v_g
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'campaign_target_graph';
  SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) INTO v_s
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'campaign_target_graph_stage';
  IF v_g IS DISTINCT FROM v_s THEN
    RAISE EXCEPTION 'campaign_target_graph and _stage columns diverge; refusing';
  END IF;
END $$;

-- ── 2. Run state + coverage ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.campaign_target_graph_sync_state (
  key text PRIMARY KEY,
  cursor_text text,
  watermark timestamptz,
  cycle_started_at timestamptz,
  cycle_finished_at timestamptz,
  last_run_at timestamptz,
  last_rows integer,
  last_ms integer,
  last_skip_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.campaign_target_graph_sync_state (key, watermark)
VALUES ('incremental', now()), ('reconcile', NULL)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.campaign_target_graph_coverage (
  id bigserial PRIMARY KEY,
  measured_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,              -- 'reconcile' | 'manual'
  sample_percent numeric NOT NULL,
  sample_rows integer NOT NULL,
  graph_rows_estimate bigint,
  latest_built_at timestamptz,
  oldest_enriched_at timestamptz,
  latest_enriched_at timestamptz,
  coverage jsonb NOT NULL            -- { column: share_filled 0..1 }
);
CREATE INDEX IF NOT EXISTS campaign_target_graph_coverage_measured_idx
  ON public.campaign_target_graph_coverage (measured_at DESC);

ALTER TABLE public.campaign_target_graph_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_target_graph_coverage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.campaign_target_graph_sync_state FROM anon, authenticated;
REVOKE ALL ON public.campaign_target_graph_coverage FROM anon, authenticated;
GRANT SELECT ON public.campaign_target_graph_coverage TO service_role;

-- ── 3. Filter-column trigger: building_condition is the building's condition ──
-- Live version back-filled building_condition from rehab_level (a different field),
-- so the "Building condition" filter actually filtered rehab level on most rows.
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
  -- podio_tags carries the same ';'-joined property flag tokens (verified on a 1%
  -- sample: identical token sets), so it stays a valid fallback.
  NEW.property_flags_text := COALESCE(
    NULLIF(NEW.property_flags_text, ''),
    NULLIF(v_property->>'property_flags_text', ''),
    NULLIF(v_property->>'flags_text', ''),
    NULLIF(NEW.podio_tags, '')
  );
  NEW.building_condition := COALESCE(
    NULLIF(NEW.building_condition, ''),
    NULLIF(v_property->>'building_condition', ''),
    NULLIF(v_property->>'condition', '')
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

-- ── 4. Contact resolution (full rebuild path): phone-type + phone-format fixes ──
-- Generated from the live definition by explicit substitutions (gen.py); the diff
-- is 55 lines: unknown type is not wireless, 'Wireless' accepted, entity contacts
-- typed from owner_phone, +1E.164 for suppression/message_events/send_queue,
-- build_id/built_at/phone_type written.

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
        CASE WHEN bc.legal_phone_type IN ('W','Wireless') AND NULLIF(bc.legal_phone,'') IS NOT NULL THEN bc.legal_phone
             WHEN bc.reach_phone_type IN ('W','Wireless') AND NULLIF(bc.reach_phone,'') IS NOT NULL THEN bc.reach_phone
             WHEN NULLIF(bc.legal_phone,'') IS NOT NULL THEN bc.legal_phone
             ELSE NULLIF(bc.reach_phone,'') END AS sel_phone,
        CASE WHEN bc.legal_phone_type IN ('W','Wireless') AND NULLIF(bc.legal_phone,'') IS NOT NULL THEN 'legal'
             WHEN bc.reach_phone_type IN ('W','Wireless') AND NULLIF(bc.reach_phone,'') IS NOT NULL THEN 'reach'
             WHEN NULLIF(bc.legal_phone,'') IS NOT NULL THEN 'legal'
             ELSE 'reach' END AS sel_role,
        CASE WHEN bc.legal_phone_type IN ('W','Wireless') AND NULLIF(bc.legal_phone,'') IS NOT NULL THEN 'W'
             WHEN bc.reach_phone_type IN ('W','Wireless') AND NULLIF(bc.reach_phone,'') IS NOT NULL THEN 'W'
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
        -- Entity contact phone type: the representative's own owner_phone
        -- record for this exact number. W only on unambiguous wireless
        -- evidence, L on unambiguous landline; anything else stays NULL
        -- (unknown), and unknown is NOT SMS-capable.
        (SELECT CASE
                  WHEN bool_or(op.phone_type IN ('W','Wireless')) AND NOT bool_or(op.phone_type IN ('L','Landline')) THEN 'W'
                  WHEN bool_or(op.phone_type IN ('L','Landline')) AND NOT bool_or(op.phone_type IN ('W','Wireless')) THEN 'L'
                END
           FROM seller.owner_phone op
          WHERE op.individual_key = ec.selected_person_key
            AND op.phone_value = NULLIF(ec.selected_phone,'')),
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
      ORDER BY (op.phone_type IN ('W','Wireless')) DESC, op.slot ASC
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
        WHERE s1.phone_e164 = '+1' || r.final_phone
        UNION ALL
        SELECT s2.is_active FROM public.sms_suppression_list s2
        WHERE s2.phone_number = r.final_phone
          AND s2.phone_e164 IS DISTINCT FROM ('+1' || r.final_phone)
      ) sl
    ) sup ON r.final_phone IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::integer AS active_queue_count
      FROM public.send_queue sq
      WHERE sq.to_phone_number IN (r.final_phone, '+1' || r.final_phone)
        AND lower(COALESCE(sq.queue_status,'')) IN
            ('queued','scheduled','pending','ready','approved','processing','sending')
    ) aq ON r.final_phone IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT MAX(li) AS last_inbound_at, MAX(lo) AS last_outbound_at
      FROM (
        SELECT MAX(COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.created_at)) AS li,
               NULL::timestamptz AS lo
        FROM public.message_events me
        WHERE me.from_phone_number = '+1' || r.final_phone AND lower(COALESCE(me.direction,'')) LIKE 'in%'
        UNION ALL
        SELECT NULL::timestamptz,
               MAX(COALESCE(me.event_timestamp, me.sent_at, me.received_at, me.created_at))
        FROM public.message_events me
        WHERE me.to_phone_number = '+1' || r.final_phone AND lower(COALESCE(me.direction,'')) LIKE 'out%'
        UNION ALL
        SELECT NULL::timestamptz,
               MAX(COALESCE(sq.sent_at, sq.scheduled_for_utc, sq.scheduled_for, sq.created_at))
        FROM public.send_queue sq WHERE sq.to_phone_number IN (r.final_phone, '+1' || r.final_phone) AND sq.sent_at IS NOT NULL
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
    source_updated_at, tax_delinquent, active_lien, is_corporate_owner, out_of_state_owner,
    build_id, built_at, phone_type
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
    (f.final_phone IS NOT NULL AND COALESCE(f.final_type IN ('W','Wireless'), false) AND NOT COALESCE(f.wrong_number_flag,false)),
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
      AND COALESCE(f.final_type IN ('W','Wireless'), false)
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
      WHEN NOT COALESCE(f.final_type IN ('W','Wireless'), false)                          THEN 'non_sms_capable'
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
      'non_sms_capable', (f.final_phone IS NOT NULL AND NOT COALESCE(f.final_type IN ('W','Wireless'), false)),
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
    f.tax_delinquent, f.active_lien, f.is_corporate_owner, f.out_of_state_owner,
    p_run_id, now(), CASE WHEN f.final_type IN ('W','Wireless') THEN 'W' WHEN f.final_type IN ('L','Landline') THEN 'L' ELSE NULL END
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

-- ── 5. Projection: one set-based UPDATE over a bounded list of graph rows ─────
-- Sources (authoritative, read-only here):
--   names/demographics/person flags  seller.owner by seller_person_key (prospects fallback)
--   phone type + carrier             seller.owner_phone (person + exact number), then the
--                                    best-contact type, then public.phones; else UNKNOWN
--   phone activity/usage             public.phones by +1E.164 (vendor data, ~15% coverage)
--   outreach recency                 message_events + send_queue by +1E.164 / 10-digit
--   suppression                      sms_suppression_list + automation_suppressions (E.164)
--   property attributes              public.properties by property_id
--   canonical scores                 property_acquisition_scores (latest per property)
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

-- Keyset batch over the whole graph (nightly reconciliation).
CREATE OR REPLACE FUNCTION public.campaign_target_graph_enrich_batch(p_after_graph_id text DEFAULT NULL, p_limit integer DEFAULT 400)
 RETURNS TABLE(rows_updated integer, next_after_graph_id text, has_more boolean, elapsed_ms integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 400), 1), 1000);
  v_ids text[];
BEGIN
  SELECT array_agg(x.graph_id ORDER BY x.graph_id) INTO v_ids
  FROM (
    SELECT g.graph_id FROM public.campaign_target_graph g
    WHERE p_after_graph_id IS NULL OR g.graph_id > p_after_graph_id
    ORDER BY g.graph_id
    LIMIT v_limit
  ) x;
  rows_updated := public.campaign_target_graph_enrich_rows(v_ids);
  next_after_graph_id := v_ids[cardinality(v_ids)];
  has_more := COALESCE(cardinality(v_ids), 0) = v_limit;
  elapsed_ms := floor(EXTRACT(epoch FROM clock_timestamp() - v_started) * 1000)::integer;
  RETURN NEXT;
END;
$function$;

-- One market, keyset (the Minneapolis trial and any per-market repair).
CREATE OR REPLACE FUNCTION public.campaign_target_graph_enrich_market(p_market text, p_after_graph_id text DEFAULT NULL, p_limit integer DEFAULT 400)
 RETURNS TABLE(rows_updated integer, next_after_graph_id text, has_more boolean, elapsed_ms integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 400), 1), 1000);
  v_ids text[];
BEGIN
  IF NULLIF(btrim(p_market), '') IS NULL THEN
    RAISE EXCEPTION 'campaign_target_graph_enrich_market: market required';
  END IF;
  SELECT array_agg(x.graph_id ORDER BY x.graph_id) INTO v_ids
  FROM (
    SELECT g.graph_id FROM public.campaign_target_graph g
    WHERE g.market = p_market AND (p_after_graph_id IS NULL OR g.graph_id > p_after_graph_id)
    ORDER BY g.graph_id
    LIMIT v_limit
  ) x;
  rows_updated := public.campaign_target_graph_enrich_rows(v_ids);
  next_after_graph_id := v_ids[cardinality(v_ids)];
  has_more := COALESCE(cardinality(v_ids), 0) = v_limit;
  elapsed_ms := floor(EXTRACT(epoch FROM clock_timestamp() - v_started) * 1000)::integer;
  RETURN NEXT;
END;
$function$;

-- Load shedding shared by both jobs: skip when the database is busy or the other job holds the lock.
CREATE OR REPLACE FUNCTION public.campaign_target_graph_load_ok(p_max_active integer DEFAULT 12)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT (SELECT count(*) FROM pg_stat_activity
          WHERE state = 'active' AND backend_type = 'client backend' AND pid <> pg_backend_pid()) <= p_max_active;
$function$;

-- ── 6. Nightly reconciliation tick (pg_cron, once a minute inside the night window) ──
-- Each tick: at most p_batches × p_limit rows, one short transaction, resumes from the
-- persisted cursor. A completed cycle is not restarted until the next night.
CREATE OR REPLACE FUNCTION public.campaign_target_graph_reconcile_tick(p_batches integer DEFAULT 4, p_limit integer DEFAULT 400)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_state public.campaign_target_graph_sync_state%ROWTYPE;
  v_after text;
  v_total integer := 0;
  v_done boolean := false;
  r record;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('campaign_target_graph_projection')) THEN
    UPDATE public.campaign_target_graph_sync_state SET last_run_at = now(), last_skip_reason = 'locked', updated_at = now() WHERE key = 'reconcile';
    RETURN jsonb_build_object('skipped', 'locked');
  END IF;
  IF NOT public.campaign_target_graph_load_ok() THEN
    UPDATE public.campaign_target_graph_sync_state SET last_run_at = now(), last_skip_reason = 'busy', updated_at = now() WHERE key = 'reconcile';
    RETURN jsonb_build_object('skipped', 'busy');
  END IF;

  SELECT * INTO v_state FROM public.campaign_target_graph_sync_state WHERE key = 'reconcile' FOR UPDATE;
  -- One cycle per night: finished within the last 18 hours means done.
  IF v_state.cycle_finished_at IS NOT NULL AND v_state.cycle_finished_at > now() - interval '18 hours'
     AND v_state.cursor_text IS NULL THEN
    RETURN jsonb_build_object('skipped', 'cycle_complete');
  END IF;
  IF v_state.cursor_text IS NULL THEN
    UPDATE public.campaign_target_graph_sync_state SET cycle_started_at = now(), cycle_finished_at = NULL WHERE key = 'reconcile';
  END IF;
  v_after := v_state.cursor_text;

  FOR i IN 1..LEAST(GREATEST(COALESCE(p_batches, 4), 1), 10) LOOP
    SELECT * INTO r FROM public.campaign_target_graph_enrich_batch(v_after, p_limit);
    v_total := v_total + COALESCE(r.rows_updated, 0);
    v_after := r.next_after_graph_id;
    IF NOT r.has_more THEN v_done := true; EXIT; END IF;
  END LOOP;

  UPDATE public.campaign_target_graph_sync_state SET
    cursor_text = CASE WHEN v_done THEN NULL ELSE v_after END,
    cycle_finished_at = CASE WHEN v_done THEN now() ELSE cycle_finished_at END,
    last_run_at = now(), last_rows = v_total, last_skip_reason = NULL,
    last_ms = floor(EXTRACT(epoch FROM clock_timestamp() - v_started) * 1000)::integer,
    updated_at = now()
  WHERE key = 'reconcile';

  IF v_done THEN
    PERFORM public.campaign_target_graph_measure_coverage('reconcile', 2);
  END IF;
  RETURN jsonb_build_object('rows', v_total, 'done', v_done, 'cursor', v_after);
END;
$function$;

-- ── 7. Daytime incremental tick: only rows whose phone activity or suppression changed ──
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

-- ── 8. Coverage: share of rows with a value, per targeting column, from a block sample ──
CREATE OR REPLACE FUNCTION public.campaign_target_graph_measure_coverage(p_source text DEFAULT 'manual', p_sample_percent numeric DEFAULT 2)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pct numeric := LEAST(GREATEST(COALESCE(p_sample_percent, 2), 0.5), 10);
  v_cov jsonb;
  v_n integer;
  v_built timestamptz;
  v_old timestamptz;
  v_new timestamptz;
BEGIN
  EXECUTE format($q$
    SELECT count(*)::int, max(built_at), min(enriched_at), max(enriched_at), jsonb_build_object(
      'seller_first_name', round(avg((seller_first_name IS NOT NULL)::int), 4), 'language', round(avg((language IS NOT NULL)::int), 4),
      'gender', round(avg((gender IS NOT NULL)::int), 4), 'marital_status', round(avg((marital_status IS NOT NULL)::int), 4),
      'education_model', round(avg((education_model IS NOT NULL)::int), 4), 'occupation_group', round(avg((occupation_group IS NOT NULL)::int), 4),
      'income', round(avg((income IS NOT NULL)::int), 4), 'net_asset_value', round(avg((net_asset_value IS NOT NULL)::int), 4),
      'buying_power', round(avg((buying_power IS NOT NULL)::int), 4), 'age_bucket', round(avg((age_bucket IS NOT NULL)::int), 4),
      'matching_flags_text', round(avg((matching_flags_text IS NOT NULL)::int), 4), 'phone_type', round(avg((phone_type IS NOT NULL)::int), 4),
      'phone_owner', round(avg((phone_owner IS NOT NULL)::int), 4), 'phone_activity_status', round(avg((phone_activity_status IS NOT NULL)::int), 4),
      'usage_12_months', round(avg((usage_12_months IS NOT NULL)::int), 4), 'usage_2_months', round(avg((usage_2_months IS NOT NULL)::int), 4),
      'last_outbound_at', round(avg((last_outbound_at IS NOT NULL)::int), 4), 'latest_contact_at', round(avg((latest_contact_at IS NOT NULL)::int), 4),
      'units_count', round(avg((units_count IS NOT NULL)::int), 4), 'building_condition', round(avg((building_condition IS NOT NULL)::int), 4),
      'rehab_level', round(avg((rehab_level IS NOT NULL)::int), 4), 'property_flags_text', round(avg((property_flags_text IS NOT NULL)::int), 4),
      'podio_tags', round(avg((podio_tags IS NOT NULL)::int), 4), 'beds', round(avg((beds IS NOT NULL)::int), 4), 'baths', round(avg((baths IS NOT NULL)::int), 4),
      'building_sqft', round(avg((building_sqft IS NOT NULL)::int), 4), 'year_built', round(avg((year_built IS NOT NULL)::int), 4),
      'lot_sqft', round(avg((lot_sqft IS NOT NULL)::int), 4), 'total_loan_balance', round(avg((total_loan_balance IS NOT NULL)::int), 4),
      'ownership_years', round(avg((ownership_years IS NOT NULL)::int), 4), 'estimated_value', round(avg((estimated_value IS NOT NULL)::int), 4),
      'equity_percent', round(avg((equity_percent IS NOT NULL)::int), 4), 'aos_score', round(avg((aos_score IS NOT NULL)::int), 4),
      'decision_tier', round(avg((decision_tier IS NOT NULL)::int), 4), 'acquisition_score', round(avg((acquisition_score IS NOT NULL)::int), 4))
    FROM public.campaign_target_graph TABLESAMPLE SYSTEM (%s)$q$, v_pct)
  INTO v_n, v_built, v_old, v_new, v_cov;
  INSERT INTO public.campaign_target_graph_coverage
    (source, sample_percent, sample_rows, graph_rows_estimate, latest_built_at, oldest_enriched_at, latest_enriched_at, coverage)
  VALUES (COALESCE(p_source, 'manual'), v_pct, v_n,
          (SELECT reltuples::bigint FROM pg_class WHERE oid = 'public.campaign_target_graph'::regclass),
          v_built, v_old, v_new, v_cov);
  RETURN v_cov;
END;
$function$;

REVOKE ALL ON FUNCTION public.campaign_target_graph_enrich_rows(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.campaign_target_graph_enrich_batch(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.campaign_target_graph_enrich_market(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.campaign_target_graph_reconcile_tick(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.campaign_target_graph_incremental_tick(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.campaign_target_graph_measure_coverage(text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.campaign_target_graph_load_ok(integer) FROM PUBLIC, anon, authenticated;
