-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- LeadCommand 8.5.21 — RECONTACT GUARD, graph side (investigator guard spec (c), 2026-10-16).
--
-- The campaign target graph had NO reply-based exclusion: a contact who replied "No" / "never
-- have" to an ownership check more than 30 days ago became queue_eligible for a fresh S1 opener
-- again (campaign 55400439 re-targeted e767ad0d on 2026-10-06). The property-scoped store
-- already exists: public.contact_property_resolution (written by the inbound waterfall). This
-- migration makes every graph writer read it through ONE helper:
--
--   public.campaign_target_graph_reply_block(property_id, phone) → NULL | 'suppressed' | 'prior_reply_not_owner'
--
-- and redefines the five functions that compute queue_eligible / queue_block_reason:
--   refresh_campaign_target_graph_seller_batch     (precedence + queue_eligible + blocker flag)
--   refresh_campaign_target_graph_fallback_batch   (same)
--   refresh_campaign_target_graph_stage_batch      (same)
--   refresh_campaign_target_graph_sender_coverage  (post-commit recompute — without this the
--                                                   batch verdict is overwritten on every refresh)
--   campaign_target_graph_enrich_rows              (per-row recompute — same reason)
--
-- Precedence (operator-locked order, one branch inserted after 'suppressed'):
--   missing_phone > wrong_number > non_sms_capable > suppressed > [reply_block] >
--   pending_prior_touch > active_queue_item > no_sender_coverage > ready
-- Each body is the live production definition (pg_get_functiondef, read-only, 2026-10-16) with
-- only the marked 8.5.21 lines added. A denial is PERSON x PROPERTY: other contacts on the same
-- property and the same phone on other properties stay eligible. A channel-compliance opt-out
-- is contact-wide.
--
-- APPLY IN ONE TRANSACTION (no BEGIN/COMMIT here):
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261016160000_campaign_graph_prior_reply_not_owner.sql
-- Rollback: PROPOSED_20261016160000_campaign_graph_prior_reply_not_owner_rollback.sql (restores the five live bodies verbatim, drops the helper + index)
-- Test: DISPOSABLE DATABASE ONLY —
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id campaign_graph_prior_reply_not_owner
-- ════════════════════════════════════════════════════════════════════════════

-- The ONE graph-side reading of contact_property_resolution. NULL = no recorded reply blocks a
-- fresh opener. 'suppressed' = a channel-compliance opt-out recorded for this phone on ANY property
-- (opt-out is contact-wide). 'prior_reply_not_owner' = this phone denied ownership of THIS property
-- (not_owner / former_owner / referral_source, rejected_at set). Phone formats: 10-digit graph
-- phones and E.164 both match. Plain SQL, STABLE, no SET clause, so the planner can inline it.
create or replace function public.campaign_target_graph_reply_block(p_property_id text, p_phone text)
returns text
language sql
stable
as $fn$
  select case
    when nullif(p_phone, '') is null then null
    when exists (
      select 1 from public.contact_property_resolution c
       where c.contact_phone_e164 in ('+1' || right(regexp_replace(p_phone, '\D', '', 'g'), 10),
                                      right(regexp_replace(p_phone, '\D', '', 'g'), 10))
         and (c.suppression_scope = 'channel_compliance' or c.contact_property_role = 'suppressed')
    ) then 'suppressed'
    when nullif(p_property_id, '') is not null and exists (
      select 1 from public.contact_property_resolution c
       where c.property_id = p_property_id
         and c.contact_phone_e164 in ('+1' || right(regexp_replace(p_phone, '\D', '', 'g'), 10),
                                      right(regexp_replace(p_phone, '\D', '', 'g'), 10))
         and c.rejected_at is not null
         and coalesce(c.suppression_scope, 'contact_property_pair') = 'contact_property_pair'
         and c.contact_property_role in ('not_owner', 'former_owner', 'referral_source')
    ) then 'prior_reply_not_owner'
    else null
  end
$fn$;

revoke all on function public.campaign_target_graph_reply_block(text, text) from public, anon, authenticated;
grant execute on function public.campaign_target_graph_reply_block(text, text) to service_role;

-- phone-wide channel-compliance lookups need a phone-leading index (the pair key leads with property_id)
create index if not exists contact_property_resolution_phone_idx
  on public.contact_property_resolution (contact_phone_e164);

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
      -- 8.5.21: a recorded reply on contact_property_resolution (property x phone denial, or a
      -- channel-compliance opt-out on any property) blocks a fresh opener.
      public.campaign_target_graph_reply_block(r.property_id::text, r.final_phone) AS reply_block,
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
      AND f.reply_block IS NULL
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
      WHEN f.reply_block IS NOT NULL                                THEN f.reply_block
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
      'prior_reply_not_owner', COALESCE(f.reply_block = 'prior_reply_not_owner', false),
      'contact_channel_suppressed', COALESCE(f.reply_block = 'suppressed', false),
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

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_fallback_batch(p_run_id uuid, p_batch_limit integer DEFAULT 10000, p_batch_offset integer DEFAULT 0, p_state text DEFAULT NULL::text, p_market text DEFAULT NULL::text)
 RETURNS TABLE(run_id uuid, batch_number integer, batch_type text, batch_key text, batch_start text, batch_end text, source_rows integer, rows_inserted integer, stage_rows integer, has_more boolean, elapsed_ms integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- 8.5.21: recorded reply on contact_property_resolution (see campaign_target_graph_reply_block)
      public.campaign_target_graph_reply_block(p.property_id::text, ph.canonical_e164::text) AS reply_block,
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
      AND reply_block IS NULL
      AND NOT wrong_number
      AND NOT pending_prior_touch
      AND NOT active_queue_item
      AND sender_covered
    ) AS queue_eligible,
    CASE
      WHEN NOT sms_eligible THEN 'sms_ineligible'
      WHEN true_post_contact_suppression THEN 'suppressed'
      WHEN reply_block IS NOT NULL THEN reply_block
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
      'prior_reply_not_owner', COALESCE(reply_block = 'prior_reply_not_owner', false),
      'contact_channel_suppressed', COALESCE(reply_block = 'suppressed', false),
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
$function$;

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_stage_batch(p_run_id uuid, p_batch_limit integer DEFAULT 10000, p_batch_offset integer DEFAULT 0, p_state text DEFAULT NULL::text, p_market text DEFAULT NULL::text)
 RETURNS TABLE(run_id uuid, batch_number integer, batch_type text, batch_key text, batch_start text, batch_end text, source_rows integer, rows_inserted integer, stage_rows integer, has_more boolean, elapsed_ms integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- 8.5.21: recorded reply on contact_property_resolution (see campaign_target_graph_reply_block)
      public.campaign_target_graph_reply_block(p.property_id::text, ph.canonical_e164::text) AS reply_block,
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
      SELECT NULLIF(p.market, '') AS market
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
      AND reply_block IS NULL
      AND NOT wrong_number
      AND NOT pending_prior_touch
      AND NOT active_queue_item
      AND sender_covered
    ) AS queue_eligible,
    CASE
      WHEN NOT sms_eligible THEN 'sms_ineligible'
      WHEN true_post_contact_suppression THEN 'suppressed'
      WHEN reply_block IS NOT NULL THEN reply_block
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
      'prior_reply_not_owner', COALESCE(reply_block = 'prior_reply_not_owner', false),
      'contact_channel_suppressed', COALESCE(reply_block = 'suppressed', false),
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
$function$;

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_sender_coverage(p_source text DEFAULT 'campaign_target_graph_sender_coverage_refresh'::text)
 RETURNS TABLE(graph_rows integer, clean_targets integer, exact_market_covered integer, health_safe_exact integer, fallback_covered integer, sender_covered integer, expanded_deliverable integer, uncovered_gap integer, health_blocked_sender_count integer)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated_rows integer := 0;
BEGIN
  PERFORM set_config('statement_timeout', '0', true);
  PERFORM set_config('work_mem', '128MB', true);

  WITH resolved AS (
    SELECT
      graph.graph_id,
      route.*
    FROM public.campaign_target_graph graph
    CROSS JOIN LATERAL public.resolve_campaign_safe_sender_route(
      graph.market,
      graph.state
    ) route
  )
  UPDATE public.campaign_target_graph graph
  SET
    sender_covered = resolved.sender_covered,
    sender_market = resolved.sender_market,
    routing_tier = resolved.route_type,
    queue_eligible = (
      graph.sms_eligible
      AND NOT graph.true_post_contact_suppression
      AND public.campaign_target_graph_reply_block(graph.property_id, graph.canonical_e164) IS NULL
      AND NOT graph.wrong_number
      AND NOT graph.pending_prior_touch
      AND NOT graph.active_queue_item
      AND resolved.sender_covered
    ),
    -- Operator-locked exclusive precedence (2026-08-24). canonical_e164 is tested
    -- FIRST because sms_eligible is false for BOTH a landline and a missing phone;
    -- conflating them is what produced the old 'sms_ineligible' bucket of 42,740
    -- rows that were really phoneless.
    --   missing_phone > wrong_number > non_sms_capable > suppressed
    --     > pending_prior_touch > active_queue_item > no_sender_coverage > ready
    -- vendor DNC is metadata and never appears here.
    queue_block_reason = CASE
      WHEN graph.canonical_e164 IS NULL        THEN 'missing_phone'
      WHEN graph.wrong_number                  THEN 'wrong_number'
      WHEN NOT graph.sms_eligible              THEN 'non_sms_capable'
      WHEN graph.true_post_contact_suppression THEN 'suppressed'
      -- 8.5.21: a recorded reply on contact_property_resolution survives every recompute
      WHEN public.campaign_target_graph_reply_block(graph.property_id, graph.canonical_e164) IS NOT NULL THEN public.campaign_target_graph_reply_block(graph.property_id, graph.canonical_e164)
      WHEN graph.pending_prior_touch           THEN 'pending_prior_touch'
      WHEN graph.active_queue_item             THEN 'active_queue_item'
      WHEN NOT resolved.sender_covered         THEN 'no_sender_coverage'
      ELSE NULL
    END,
    linkage_counts = COALESCE(graph.linkage_counts, '{}'::jsonb) || jsonb_build_object(
      'sender_numbers', resolved.safe_sender_count
    ),
    blocker_flags = COALESCE(graph.blocker_flags, '{}'::jsonb) || jsonb_build_object(
      'sender_covered', resolved.sender_covered,
      'exact_market_covered', resolved.exact_market_covered,
      'health_safe_exact', resolved.health_safe_exact,
      'fallback_covered', resolved.fallback_covered,
      'health_blocked_sender_count', resolved.health_blocked_sender_count
    ),
    extra_data = COALESCE(graph.extra_data, '{}'::jsonb) || jsonb_build_object(
      'sender_route',
      jsonb_strip_nulls(jsonb_build_object(
        'source', COALESCE(NULLIF(p_source, ''), 'campaign_target_graph_sender_coverage_refresh'),
        'sender_id', resolved.sender_id,
        'sender_phone_number', resolved.sender_phone_number,
        'sender_market', resolved.sender_market,
        'route_type', resolved.route_type,
        'routing_rule_name', resolved.routing_rule_name,
        'exact_market_covered', resolved.exact_market_covered,
        'health_safe_exact', resolved.health_safe_exact,
        'fallback_covered', resolved.fallback_covered,
        'safe_sender_count', resolved.safe_sender_count,
        'health_blocked_sender_count', resolved.health_blocked_sender_count
      ))
    )
  FROM resolved
  WHERE resolved.graph_id = graph.graph_id;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

  RETURN QUERY
  SELECT
    v_updated_rows,
    COUNT(*) FILTER (
      WHERE graph.sms_eligible
        AND NOT graph.true_post_contact_suppression
        AND NOT graph.wrong_number
    )::integer,
    COUNT(*) FILTER (
      WHERE graph.sms_eligible
        AND NOT graph.true_post_contact_suppression
        AND NOT graph.wrong_number
        AND COALESCE((graph.blocker_flags->>'exact_market_covered')::boolean, false)
    )::integer,
    COUNT(*) FILTER (
      WHERE graph.sms_eligible
        AND NOT graph.true_post_contact_suppression
        AND NOT graph.wrong_number
        AND COALESCE((graph.blocker_flags->>'health_safe_exact')::boolean, false)
    )::integer,
    COUNT(*) FILTER (
      WHERE graph.sms_eligible
        AND NOT graph.true_post_contact_suppression
        AND NOT graph.wrong_number
        AND COALESCE((graph.blocker_flags->>'fallback_covered')::boolean, false)
    )::integer,
    COUNT(*) FILTER (
      WHERE graph.sms_eligible
        AND NOT graph.true_post_contact_suppression
        AND NOT graph.wrong_number
        AND graph.sender_covered
    )::integer,
    COUNT(*) FILTER (WHERE graph.queue_eligible)::integer,
    COUNT(*) FILTER (
      WHERE graph.sms_eligible
        AND NOT graph.true_post_contact_suppression
        AND NOT graph.wrong_number
        AND NOT graph.sender_covered
    )::integer,
    COALESCE(
      MAX((graph.blocker_flags->>'health_blocked_sender_count')::integer),
      0
    )::integer
  FROM public.campaign_target_graph graph;
END;
$function$;

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
      AND public.campaign_target_graph_reply_block(t.property_id, c.canonical_e164) IS NULL
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
      WHEN public.campaign_target_graph_reply_block(t.property_id, c.canonical_e164) IS NOT NULL THEN public.campaign_target_graph_reply_block(t.property_id, c.canonical_e164)
      WHEN c.last_outbound IS NOT NULL AND c.last_outbound >= now() - interval '30 days' THEN 'pending_prior_touch'
      WHEN COALESCE(c.active, false)                                             THEN 'active_queue_item'
      WHEN NOT COALESCE(c.sender_covered, false)                                 THEN 'no_sender_coverage'
      ELSE NULL END,
    blocker_flags       = COALESCE(t.blocker_flags, '{}'::jsonb) || jsonb_build_object(
      'wrong_number', c.wrong,
      'suppressed', c.on_suppression,
      'prior_reply_not_owner', COALESCE(public.campaign_target_graph_reply_block(t.property_id, c.canonical_e164) = 'prior_reply_not_owner', false),
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
