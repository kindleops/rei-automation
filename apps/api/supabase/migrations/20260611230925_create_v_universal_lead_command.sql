-- Canonical universal backend command/read model and physical launch cache.
--
-- Operational grain:
--   one row per property + resolved master owner + prospect + contact channel.
--
-- A contact channel is one linked phone or one linked email. Property and owner
-- facts intentionally repeat when an owner/prospect has multiple channels.
--
-- Source ownership:
--   properties             owns property facts.
--   campaign_target_graph  stabilizes property-to-owner routing when the
--                          property row has a missing/stale master_owner_id.
--                          Its selected prospect/phone does not define grain.
--   master_owners          owns canonical owner/portfolio facts.
--   prospects              owns person/contact identity.
--   phones / emails        own channels and explicit prospect linkage.
--   inbox_thread_state     owns mutable current thread controls.
--   deal_thread_state      owns persisted universal thread classification.
--   message_events         owns immutable message history. Only the latest
--                          event summary is projected here.
--   send_queue             owns queue execution state.
--   campaigns /
--   campaign_targets       own campaign and target execution state.
--   workflows /
--   workflow_runs /
--   workflow_steps         own workflow execution state.
--   thread_ai_state        owns current AI conversation/deal analysis.
--
-- Full message history must continue to be loaded separately from
-- message_events by thread_key / conversation_thread_id.
--
-- This migration intentionally adds no indexes to existing source tables.
-- The live catalog already owns the required identity/filter indexes, including
-- campaign_target_graph(property_export_id). Any future source-table index must
-- be justified by a post-cache EXPLAIN and built concurrently in a dedicated,
-- out-of-transaction migration. The cache indexes below are built while the
-- new cache is empty, so they do not block production writers.

CREATE OR REPLACE VIEW public.v_universal_lead_command
WITH (security_invoker = true) AS
WITH
property_owner_keys AS NOT MATERIALIZED (
  SELECT
    g.property_export_id,
    g.property_id,
    g.master_owner_id AS resolved_master_owner_id,
    'campaign_target_graph.master_owner_id'::text AS owner_resolution_source
  FROM public.campaign_target_graph g
  WHERE g.master_owner_id IS NOT NULL

  UNION ALL

  SELECT
    p.property_export_id,
    p.property_id,
    p.master_owner_id AS resolved_master_owner_id,
    'properties.master_owner_id'::text AS owner_resolution_source
  FROM public.campaign_target_graph g
  JOIN public.properties p
    ON p.property_export_id = g.property_export_id
  WHERE g.master_owner_id IS NULL
    AND p.master_owner_id IS NOT NULL
),
contact_grain_keys AS (
  SELECT
    pok.property_export_id,
    pok.property_id,
    pok.resolved_master_owner_id,
    pok.owner_resolution_source,
    pr.prospect_id,
    ph.phone_id,
    NULL::text AS email_id,
    'phone'::text AS contact_channel_type,
    ph.canonical_e164 AS contact_channel_value
  FROM property_owner_keys pok
  JOIN public.prospects pr
    ON pr.master_owner_id = pok.resolved_master_owner_id
  JOIN public.phones ph
    ON ph.master_owner_id = pr.master_owner_id
   AND ph.linked_prospect_ids_json ? pr.prospect_id
   AND NULLIF(ph.canonical_e164, '') IS NOT NULL

  UNION ALL

  SELECT
    pok.property_export_id,
    pok.property_id,
    pok.resolved_master_owner_id,
    pok.owner_resolution_source,
    pr.prospect_id,
    NULL::text AS phone_id,
    em.email_id,
    'email'::text AS contact_channel_type,
    em.email_normalized AS contact_channel_value
  FROM property_owner_keys pok
  JOIN public.prospects pr
    ON pr.master_owner_id = pok.resolved_master_owner_id
  JOIN public.emails em
    ON em.master_owner_id = pr.master_owner_id
   AND em.linked_prospect_ids_json ? pr.prospect_id
   AND NULLIF(em.email_normalized, '') IS NOT NULL
),
contact_grain AS (
  SELECT
    cgk.property_export_id AS key_property_export_id,
    cgk.property_id AS key_property_id,
    cgk.resolved_master_owner_id,
    cgk.prospect_id AS key_prospect_id,
    cgk.phone_id AS key_phone_id,
    cgk.email_id AS key_email_id,
    cgk.owner_resolution_source,
    cgk.contact_channel_type,
    cgk.contact_channel_value,
    p,
    g,
    mo,
    pr,
    ph,
    em
  FROM contact_grain_keys cgk
  JOIN public.properties p
    ON p.property_export_id = cgk.property_export_id
  LEFT JOIN public.campaign_target_graph g
    ON g.property_export_id = cgk.property_export_id
  JOIN public.master_owners mo
    ON mo.master_owner_id = cgk.resolved_master_owner_id
  JOIN public.prospects pr
    ON pr.prospect_id = cgk.prospect_id
  LEFT JOIN public.phones ph
    ON ph.phone_id = cgk.phone_id
  LEFT JOIN public.emails em
    ON em.email_id = cgk.email_id
),
thread_rows AS (
  SELECT
    its.*,
    COALESCE(
      NULLIF(its.canonical_e164, ''),
      NULLIF(its.seller_phone, '')
    ) AS contact_e164,
    COALESCE(its.latest_message_at, its.updated_at, its.created_at) AS rank_at
  FROM public.inbox_thread_state its
),
thread_by_property_phone AS (
  SELECT DISTINCT ON (tr.property_id, tr.contact_e164)
    tr.property_id,
    tr.contact_e164,
    tr.id
  FROM thread_rows tr
  WHERE tr.property_id IS NOT NULL AND tr.contact_e164 IS NOT NULL
  ORDER BY tr.property_id, tr.contact_e164, tr.rank_at DESC NULLS LAST, tr.id DESC
),
thread_by_prospect_phone AS (
  SELECT DISTINCT ON (tr.prospect_id, tr.contact_e164)
    tr.prospect_id,
    tr.contact_e164,
    tr.id
  FROM thread_rows tr
  WHERE tr.prospect_id IS NOT NULL AND tr.contact_e164 IS NOT NULL
  ORDER BY tr.prospect_id, tr.contact_e164, tr.rank_at DESC NULLS LAST, tr.id DESC
),
thread_by_owner_phone AS (
  SELECT DISTINCT ON (tr.master_owner_id, tr.contact_e164)
    tr.master_owner_id,
    tr.contact_e164,
    tr.id
  FROM thread_rows tr
  WHERE tr.master_owner_id IS NOT NULL AND tr.contact_e164 IS NOT NULL
  ORDER BY tr.master_owner_id, tr.contact_e164, tr.rank_at DESC NULLS LAST, tr.id DESC
),
latest_message_by_thread AS (
  SELECT DISTINCT ON (me.thread_key)
    me.thread_key,
    me.id
  FROM public.message_events me
  WHERE me.thread_key IS NOT NULL
  ORDER BY
    me.thread_key,
    COALESCE(
      me.event_timestamp,
      me.received_at,
      me.sent_at,
      me.delivered_at,
      me.created_at
    ) DESC NULLS LAST,
    me.created_at DESC NULLS LAST,
    me.id DESC
),
queue_by_thread AS (
  SELECT DISTINCT ON (sq.thread_key) sq.thread_key, sq.id
  FROM public.send_queue sq
  WHERE sq.thread_key IS NOT NULL
  ORDER BY sq.thread_key, COALESCE(sq.updated_at, sq.created_at) DESC NULLS LAST, sq.id DESC
),
queue_by_property_phone AS (
  SELECT DISTINCT ON (sq.property_id, sq.to_phone_number)
    sq.property_id, sq.to_phone_number, sq.id
  FROM public.send_queue sq
  WHERE sq.property_id IS NOT NULL AND sq.to_phone_number IS NOT NULL
  ORDER BY
    sq.property_id,
    sq.to_phone_number,
    COALESCE(sq.updated_at, sq.created_at) DESC NULLS LAST,
    sq.id DESC
),
queue_by_owner_phone AS (
  SELECT DISTINCT ON (sq.master_owner_id, sq.to_phone_number)
    sq.master_owner_id, sq.to_phone_number, sq.id
  FROM public.send_queue sq
  WHERE sq.master_owner_id IS NOT NULL AND sq.to_phone_number IS NOT NULL
  ORDER BY
    sq.master_owner_id,
    sq.to_phone_number,
    COALESCE(sq.updated_at, sq.created_at) DESC NULLS LAST,
    sq.id DESC
),
target_by_property_phone AS (
  SELECT DISTINCT ON (ct.property_id, ct.to_phone_number)
    ct.property_id, ct.to_phone_number, ct.id
  FROM public.campaign_targets ct
  WHERE ct.property_id IS NOT NULL AND ct.to_phone_number IS NOT NULL
  ORDER BY
    ct.property_id,
    ct.to_phone_number,
    COALESCE(ct.updated_at, ct.created_at) DESC NULLS LAST,
    ct.id DESC
),
target_by_owner_phone AS (
  SELECT DISTINCT ON (ct.master_owner_id, ct.to_phone_number)
    ct.master_owner_id, ct.to_phone_number, ct.id
  FROM public.campaign_targets ct
  WHERE ct.master_owner_id IS NOT NULL AND ct.to_phone_number IS NOT NULL
  ORDER BY
    ct.master_owner_id,
    ct.to_phone_number,
    COALESCE(ct.updated_at, ct.created_at) DESC NULLS LAST,
    ct.id DESC
),
workflow_by_thread AS (
  SELECT DISTINCT ON (wr.conversation_thread_id)
    wr.conversation_thread_id, wr.id
  FROM public.workflow_runs wr
  WHERE wr.conversation_thread_id IS NOT NULL
  ORDER BY
    wr.conversation_thread_id,
    COALESCE(wr.updated_at, wr.created_at) DESC NULLS LAST,
    wr.id DESC
),
workflow_by_identity AS (
  SELECT DISTINCT ON (wr.property_id, wr.master_owner_id, wr.prospect_id)
    wr.property_id, wr.master_owner_id, wr.prospect_id, wr.id
  FROM public.workflow_runs wr
  WHERE wr.property_id IS NOT NULL
    AND wr.master_owner_id IS NOT NULL
    AND wr.prospect_id IS NOT NULL
  ORDER BY
    wr.property_id,
    wr.master_owner_id,
    wr.prospect_id,
    COALESCE(wr.updated_at, wr.created_at) DESC NULLS LAST,
    wr.id DESC
),
active_sms_suppression AS (
  SELECT DISTINCT ON (ssl.phone_e164) ssl.phone_e164, ssl.id
  FROM public.sms_suppression_list ssl
  WHERE ssl.is_active = true AND ssl.phone_e164 IS NOT NULL
  ORDER BY
    ssl.phone_e164,
    COALESCE(ssl.suppressed_at, ssl.created_at) DESC NULLS LAST,
    ssl.id DESC
),
outreach_by_owner_phone AS (
  SELECT DISTINCT ON (cos.podio_master_owner_id, cos.canonical_e164)
    cos.podio_master_owner_id, cos.canonical_e164, cos.id
  FROM public.contact_outreach_state cos
  WHERE cos.podio_master_owner_id IS NOT NULL AND cos.canonical_e164 IS NOT NULL
  ORDER BY
    cos.podio_master_owner_id,
    cos.canonical_e164,
    COALESCE(cos.updated_at, cos.created_at) DESC NULLS LAST,
    cos.id DESC
),
contact_threads_by_property_owner AS (
  SELECT
    its.property_id,
    its.master_owner_id,
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'thread_key', its.thread_key,
        'conversation_thread_id', its.thread_key,
        'prospect_id', its.prospect_id,
        'canonical_e164', COALESCE(
          NULLIF(its.canonical_e164, ''),
          NULLIF(its.seller_phone, '')
        ),
        'status', its.status,
        'stage', its.stage,
        'latest_message_at', its.latest_message_at,
        'latest_direction', its.latest_direction,
        'message_count', its.message_count,
        'is_archived', its.is_archived,
        'is_suppressed', its.is_suppressed
      ))
      ORDER BY COALESCE(its.latest_message_at, its.updated_at) DESC NULLS LAST, its.id DESC
    ) AS threads
  FROM public.inbox_thread_state its
  WHERE its.property_id IS NOT NULL AND its.master_owner_id IS NOT NULL
  GROUP BY its.property_id, its.master_owner_id
),
operational_joined AS (
  SELECT
    cg.*,
    its,
    me,
    dts,
    tas,
    sq,
    ct,
    c,
    wr,
    w,
    ws,
    ssl,
    cos,
    COALESCE(cts.threads, '[]'::jsonb) AS contact_threads
  FROM contact_grain cg
  LEFT JOIN thread_by_property_phone tpp
    ON cg.contact_channel_type = 'phone'
   AND tpp.property_id = (cg.p).property_id
   AND tpp.contact_e164 = cg.contact_channel_value
  LEFT JOIN thread_by_prospect_phone tpr
    ON cg.contact_channel_type = 'phone'
   AND tpp.id IS NULL
   AND tpr.prospect_id = (cg.pr).prospect_id
   AND tpr.contact_e164 = cg.contact_channel_value
  LEFT JOIN thread_by_owner_phone top
    ON cg.contact_channel_type = 'phone'
   AND tpp.id IS NULL
   AND tpr.id IS NULL
   AND top.master_owner_id = cg.resolved_master_owner_id
   AND top.contact_e164 = cg.contact_channel_value
  LEFT JOIN public.inbox_thread_state its
    ON its.id = COALESCE(tpp.id, tpr.id, top.id)
  LEFT JOIN latest_message_by_thread lmb
    ON lmb.thread_key = its.thread_key
  LEFT JOIN public.message_events me
    ON me.id = COALESCE(its.latest_message_event_id, lmb.id)
  LEFT JOIN public.deal_thread_state dts
    ON dts.thread_key = its.thread_key
  LEFT JOIN public.thread_ai_state tas
    ON tas.thread_key = its.thread_key
  LEFT JOIN queue_by_thread qbt
    ON qbt.thread_key = its.thread_key
  LEFT JOIN queue_by_property_phone qbpp
    ON cg.contact_channel_type = 'phone'
   AND qbt.id IS NULL
   AND qbpp.property_id = (cg.p).property_id
   AND qbpp.to_phone_number = cg.contact_channel_value
  LEFT JOIN queue_by_owner_phone qbop
    ON cg.contact_channel_type = 'phone'
   AND qbt.id IS NULL
   AND qbpp.id IS NULL
   AND qbop.master_owner_id = cg.resolved_master_owner_id
   AND qbop.to_phone_number = cg.contact_channel_value
  LEFT JOIN public.send_queue sq
    ON sq.id = COALESCE(qbt.id, qbpp.id, qbop.id)
  LEFT JOIN target_by_property_phone tbpp
    ON cg.contact_channel_type = 'phone'
   AND tbpp.property_id = (cg.p).property_id
   AND tbpp.to_phone_number = cg.contact_channel_value
  LEFT JOIN target_by_owner_phone tbop
    ON cg.contact_channel_type = 'phone'
   AND tbpp.id IS NULL
   AND tbop.master_owner_id = cg.resolved_master_owner_id
   AND tbop.to_phone_number = cg.contact_channel_value
  LEFT JOIN public.campaign_targets ct
    ON ct.id = COALESCE(sq.campaign_target_id, tbpp.id, tbop.id)
  LEFT JOIN public.campaigns c
    ON c.id = COALESCE(sq.campaign_id, ct.campaign_id)
  LEFT JOIN workflow_by_thread wbt
    ON wbt.conversation_thread_id = its.thread_key
  LEFT JOIN workflow_by_identity wbi
    ON wbt.id IS NULL
   AND wbi.property_id = (cg.p).property_id
   AND wbi.master_owner_id = cg.resolved_master_owner_id
   AND wbi.prospect_id = (cg.pr).prospect_id
  LEFT JOIN public.workflow_runs wr
    ON wr.id = COALESCE(wbt.id, wbi.id)
  LEFT JOIN public.workflows w
    ON w.id = wr.workflow_id
  LEFT JOIN public.workflow_steps ws
    ON ws.id = wr.current_step_id
  LEFT JOIN active_sms_suppression ass
    ON cg.contact_channel_type = 'phone'
   AND ass.phone_e164 = cg.contact_channel_value
  LEFT JOIN public.sms_suppression_list ssl
    ON ssl.id = ass.id
  LEFT JOIN outreach_by_owner_phone obop
    ON cg.contact_channel_type = 'phone'
   AND obop.podio_master_owner_id = cg.resolved_master_owner_id
   AND obop.canonical_e164 = cg.contact_channel_value
  LEFT JOIN public.contact_outreach_state cos
    ON cos.id = obop.id
  LEFT JOIN contact_threads_by_property_owner cts
    ON cts.property_id = (cg.p).property_id
   AND cts.master_owner_id = cg.resolved_master_owner_id
),
resolved AS (
  SELECT
    oj.*,
    COALESCE(
      (oj.me).event_timestamp,
      (oj.me).received_at,
      (oj.me).sent_at,
      (oj.me).delivered_at,
      (oj.me).created_at,
      (oj.its).latest_message_at
    ) AS resolved_latest_message_at,
    COALESCE((oj.me).message_body, (oj.its).latest_message_body) AS resolved_latest_message_body,
    COALESCE((oj.me).direction, (oj.its).latest_direction) AS resolved_latest_direction,
    COALESCE(
      NULLIF((oj.dts).reply_intent, ''),
      NULLIF((oj.me).detected_intent, ''),
      NULLIF((oj.its).last_intent, ''),
      NULLIF((oj.me).metadata->>'intent', ''),
      NULLIF((oj.its).metadata->>'reply_intent', '')
    ) AS resolved_reply_intent,
    COALESCE(
      (oj.dts).universal_status,
      (oj.its).status
    ) AS resolved_universal_status,
    COALESCE(
      (oj.dts).universal_stage,
      (oj.its).stage,
      (oj.sq).pipeline_stage,
      (oj.sq).current_stage
    ) AS resolved_universal_stage,
    COALESCE(
      (oj.dts).lead_temperature,
      (oj.tas).deal_temperature,
      CASE
        WHEN COALESCE((oj.its).is_hot_lead, false) THEN 'hot'
        WHEN (oj.its).last_inbound_at IS NOT NULL THEN 'warm'
        ELSE 'cold'
      END
    ) AS resolved_lead_temperature,
    COALESCE(
      (oj.dts).inbox_bucket,
      CASE
        WHEN COALESCE((oj.its).is_suppressed, false)
          OR (oj.ssl).phone_e164 IS NOT NULL
          OR COALESCE((oj.cos).dnc, false)
          THEN 'suppressed'
        WHEN COALESCE((oj.its).is_archived, false) THEN 'archived'
        WHEN COALESCE((oj.its).is_pinned, false)
          OR COALESCE((oj.its).is_starred, false)
          THEN 'priority'
        WHEN lower(COALESCE((oj.its).latest_direction, '')) LIKE 'in%'
          THEN 'new_replies'
        ELSE 'cold'
      END
    ) AS resolved_inbox_bucket
  FROM operational_joined oj
),
finalized AS (
  SELECT
    r.*,
    concat_ws(
      '|',
      r.key_property_export_id,
      r.resolved_master_owner_id,
      r.key_prospect_id,
      r.contact_channel_type,
      r.contact_channel_value
    ) AS resolved_grain_key,
    (
      r.resolved_reply_intent = 'ownership_confirmed'
      OR (r.me).metadata->>'intent' = 'ownership_confirmed'
      OR (r.its).metadata->>'reply_intent' = 'ownership_confirmed'
    ) AS resolved_ownership_confirmed,
    (
      r.contact_channel_type = 'phone'
      AND (
        (r.ph).wrong_number_at IS NOT NULL
        OR lower(COALESCE((r.ph).phone_contact_status, '')) = 'wrong_number'
      )
    ) AS resolved_wrong_number,
    (
      r.contact_channel_type = 'phone'
      AND (r.ssl).phone_e164 IS NOT NULL
      AND (r.ssl).suppression_type = 'opt_out'
    ) AS resolved_opt_out,
    (
      r.contact_channel_type = 'phone'
      AND (
        COALESCE((r.cos).dnc, false)
        OR (r.ssl).phone_e164 IS NOT NULL
      )
    ) AS resolved_do_not_contact,
    COALESCE(
      NULLIF((r.its).next_action, ''),
      NULLIF((r.tas).next_best_action, ''),
      CASE
        WHEN COALESCE((r.its).is_suppressed, false)
          OR (r.ssl).phone_e164 IS NOT NULL
          OR COALESCE((r.cos).dnc, false)
          THEN 'none'
        WHEN (r.its).follow_up_at IS NOT NULL THEN 'follow_up'
        WHEN lower(COALESCE(r.resolved_latest_direction, '')) LIKE 'in%'
          THEN 'respond'
        WHEN r.contact_channel_type = 'phone' THEN 'start_outreach'
        ELSE 'review_email_outreach'
      END
    ) AS resolved_next_action
  FROM resolved r
)
SELECT
  md5(f.resolved_grain_key) AS command_id,
  f.resolved_grain_key AS grain_key,

  -- Stable identity and linkage.
  f.key_property_export_id AS property_export_id,
  f.key_property_id AS property_id,
  f.resolved_master_owner_id AS master_owner_id,
  f.key_prospect_id AS prospect_id,
  (f.pr).canonical_prospect_id,
  (f.pr).master_key,
  (f.mo).owner_cluster_key,
  (f.mo).household_key,
  f.contact_channel_type,
  f.contact_channel_value,
  f.key_phone_id AS phone_id,
  f.key_email_id AS email_id,
  (f.its).thread_key,
  (f.its).thread_key AS conversation_thread_id,
  (f.ct).id AS campaign_target_id,
  (f.sq).id AS queue_id,
  COALESCE((f.me).id, (f.its).latest_message_event_id) AS latest_message_event_id,
  f.owner_resolution_source,

  -- Explicit contact resolution contract.
  f.key_prospect_id AS resolved_prospect_id,
  (f.pr).full_name AS resolved_prospect_name,
  f.key_phone_id AS resolved_phone_id,
  f.key_email_id AS resolved_email_id,
  CASE
    WHEN f.contact_channel_type = 'phone'
      THEN 'phones.linked_prospect_ids_json'
    ELSE 'emails.linked_prospect_ids_json'
  END AS resolution_source,
  1.00::numeric AS resolution_confidence,

  -- Prospect facts.
  (f.pr).full_name,
  (f.pr).first_name,
  (f.pr).language_preference AS language,
  (f.pr).gender,
  (f.pr).marital_status,
  (f.pr).education_model,
  (f.pr).occupation_group,
  (f.pr).occupation_code,
  (f.pr).est_household_income AS estimated_household_income,
  (f.pr).net_asset_value,
  (f.pr).buying_power,
  (f.pr).mob,
  NULL::text AS birth_year_month,
  NULL::integer AS calculated_age,
  (f.pr).matching_flags,
  (f.pr).person_flags_text,
  (f.pr).best_phone,
  (f.pr).best_email,
  (f.pr).contact_window,
  (f.pr).timezone,

  -- Property facts.
  (f.p).property_address_full,
  (f.p).market,
  (f.p).property_type,
  (f.p).estimated_value,
  (f.p).equity_amount,
  (f.p).equity_percent,
  (f.p).total_loan_balance,
  (f.p).total_loan_payment,
  (f.p).tax_amt AS tax_amount,
  (f.p).sale_date,
  (f.p).sale_price,
  (f.p).units_count,
  (f.p).tax_delinquent,
  (f.p).tax_delinquent_year,
  (f.p).active_lien,
  (f.p).ownership_years,
  (f.p).last_sale_doc_type,
  (f.p).apn_parcel_id,
  (f.p).property_address,
  (f.p).property_address_city,
  (f.p).property_address_county_name,
  (f.p).property_address_state,
  (f.p).property_address_zip,
  (f.p).property_class,
  NULL::numeric AS total_loan_amount,
  (f.p).tax_year,
  (f.p).building_square_feet,
  (f.p).document_type,
  (f.p).recording_date,
  (f.p).default_date,
  (f.p).year_built,
  (f.p).effective_year_built,
  (f.p).total_baths,
  (f.p).total_bedrooms,
  (f.p).lot_acreage,
  (f.p).lot_square_feet,
  (f.p).latitude,
  (f.p).longitude,
  (f.p).air_conditioning,
  (f.p).basement,
  (f.p).building_condition,
  (f.p).building_quality,
  (f.p).construction_type,
  (f.p).exterior_walls,
  (f.p).floor_cover,
  (f.p).garage,
  (f.p).heating_fuel_type,
  (f.p).heating_type,
  (f.p).interior_walls,
  (f.p).pool,
  (f.p).porch,
  (f.p).patio,
  (f.p).deck,
  (f.p).driveway,
  (f.p).roof_cover,
  (f.p).roof_type,
  (f.p).sewer,
  (f.p).water,
  (f.p).zoning,
  (f.p).legal_description,
  (f.p).school_district_name,
  (f.p).subdivision_name,
  (f.p).flood_zone,
  (f.p).hoa1_name AS hoa_one_name,
  (f.p).hoa1_type AS hoa_one_type,
  (f.p).hoa_fee_amount,
  (f.p).property_flags_text,
  (f.p).search_profile_hash,
  (f.p).sqft_range AS square_foot_range,
  (f.p).avg_sqft_per_unit AS average_square_foot_per_unit,
  (f.p).beds_per_unit,
  (f.p).rehab_level,
  (f.p).structured_motivation_score,
  (f.p).deal_strength_score,
  (f.p).tag_distress_score,
  (f.p).final_acquisition_score,
  NULL::integer AS assessment_year,
  (f.p).calculated_improvement_value,
  (f.p).calculated_land_value,
  (f.p).calculated_total_value,
  (f.p).num_of_fireplaces AS number_of_fireplaces,
  (f.p).past_due_amount,
  (f.p).stories,
  (f.p).style,
  (f.p).topography,
  (f.p).sum_buildings_nbr AS sum_buildings,
  (f.p).sum_commercial_units,
  (f.p).sum_garage_sqft AS sum_garage_square_feet,
  (f.p).estimated_repair_cost,
  (f.p).other_rooms,

  -- Master owner facts.
  (f.mo).display_name,
  (f.mo).primary_owner_address,
  (f.mo).owner_type_guess,
  (f.mo).owner_location_text AS owner_location,
  (f.mo).best_channel,
  (f.mo).best_language,
  (f.mo).financial_pressure_score,
  (f.mo).urgency_score,
  (f.mo).priority_score,
  (f.mo).priority_tier,
  (f.mo).best_phone_1,
  (f.mo).best_phone_2,
  (f.mo).best_phone_3,
  (f.mo).best_email_1,
  (f.mo).best_email_2,
  (f.mo).portfolio_total_value,
  (f.mo).portfolio_total_equity,
  (f.mo).portfolio_total_loan_balance,
  (f.mo).portfolio_total_loan_payment,
  (f.mo).portfolio_total_tax_amount,
  (f.mo).portfolio_total_units,
  (f.mo).property_count,
  (f.mo).tax_delinquent_count,
  (f.mo).oldest_tax_delinquent_year,
  (f.mo).active_lien_count,

  -- Phone/contact facts. Email rows have NULL phone fields.
  (f.ph).phone AS phone_number,
  (f.ph).phone_raw,
  (f.ph).canonical_e164,
  (f.ph).phone_owner,
  (f.ph).activity_status AS phone_activity_status,
  (f.ph).usage_12_months,
  (f.ph).usage_2_months,
  (f.ph).sort_rank AS phone_rank,
  NULL::boolean AS phone_confirmed,
  (f.ph).phone_contact_status AS phone_status,
  CASE
    WHEN f.contact_channel_type = 'phone' THEN f.resolved_wrong_number
    ELSE NULL
  END AS wrong_number,
  CASE
    WHEN f.contact_channel_type = 'phone' THEN f.resolved_opt_out
    ELSE NULL
  END AS opt_out,
  CASE
    WHEN f.contact_channel_type = 'phone' THEN f.resolved_do_not_contact
    ELSE NULL
  END AS do_not_contact,

  -- Email facts. Phone rows have NULL email fields.
  (f.em).email,
  (f.em).email_linkage_score_raw,
  (f.em).email_score_final,
  (f.em).email_rank,
  NULL::boolean AS email_confirmed,
  NULL::text AS email_status,

  -- Thread/inbox state.
  f.resolved_inbox_bucket AS inbox_bucket,
  f.resolved_universal_status AS universal_status,
  f.resolved_universal_stage AS universal_stage,
  f.resolved_lead_temperature AS lead_temperature,
  f.resolved_reply_intent AS reply_intent,
  f.resolved_ownership_confirmed AS ownership_confirmed,
  COALESCE((f.its).is_pinned, false) AS is_pinned,
  COALESCE((f.its).is_starred, false) AS is_starred,
  COALESCE((f.its).is_archived, false) AS is_archived,
  (
    COALESCE((f.its).is_suppressed, false)
    OR f.resolved_do_not_contact
  ) AS is_suppressed,
  (f.its).last_outbound_at,
  (f.its).last_inbound_at,
  f.resolved_latest_message_body AS latest_message_body,
  f.resolved_latest_message_at AS latest_message_at,
  COALESCE((f.its).message_count, 0) AS message_count,
  COALESCE((f.its).inbound_count, 0) AS inbound_count,
  COALESCE((f.its).outbound_count, 0) AS outbound_count,
  COALESCE((f.dts).unread_count, 0) AS unread_count,
  f.resolved_next_action AS next_action,
  (f.its).follow_up_at AS next_follow_up_at,

  -- Campaign/queue state.
  (f.c).id AS campaign_id,
  COALESCE((f.c).name, (f.ct).campaign_name) AS campaign_name,
  (f.c).status AS campaign_status,
  (f.ct).target_status,
  (f.sq).queue_status,
  (f.sq).scheduled_for,
  (f.sq).from_phone_number AS sender_phone,
  (f.sq).template_id,
  (f.me).message_variant,
  (f.sq).created_at AS last_queued_at,
  (f.sq).sent_at AS last_sent_at,
  (f.sq).delivered_at AS last_delivered_at,
  CASE
    WHEN (f.sq).queue_status IN ('failed', 'failed_transport')
      THEN (f.sq).updated_at
    ELSE NULL
  END AS last_failed_at,
  COALESCE(
    NULLIF((f.sq).failed_reason, ''),
    NULLIF((f.sq).blocked_reason, ''),
    NULLIF((f.sq).guard_reason, '')
  ) AS latest_failure_reason,

  -- Workflow/automation state.
  (f.wr).workflow_id AS assigned_workflow_id,
  (f.w).name AS assigned_workflow_name,
  COALESCE((f.ws).label, (f.ws).step_key) AS workflow_step,
  (f.wr).status AS workflow_status,
  (f.me).auto_reply_status,
  CASE
    WHEN (f.w).workflow_type = 'follow_up' THEN (f.wr).status
    ELSE NULL
  END AS follow_up_sequence_status,
  (f.tas).current_stage AS ai_conversation_state,
  (f.tas).ai_summary,
  (f.tas).next_best_action AS ai_next_action,
  COALESCE((f.tas).last_ai_analysis_at, (f.tas).updated_at) AS ai_last_updated_at,

  -- Offer/deal state. Missing source fields remain explicitly NULL.
  NULL::text AS offer_status,
  (f.tas).asking_price AS seller_asking_price,
  (f.tas).last_offer AS offer_price,
  NULL::text AS contract_status,
  NULL::text AS closing_status,
  NULL::text AS deal_status,
  (f.sq).pipeline_stage,

  -- Compact entity/read-model groups.
  jsonb_strip_nulls(jsonb_build_object(
    'property_export_id', (f.p).property_export_id,
    'property_id', (f.p).property_id,
    'address_full', (f.p).property_address_full,
    'market', (f.p).market,
    'property_type', (f.p).property_type,
    'estimated_value', (f.p).estimated_value,
    'equity_amount', (f.p).equity_amount,
    'latitude', (f.p).latitude,
    'longitude', (f.p).longitude
  )) AS property_entity,
  jsonb_strip_nulls(jsonb_build_object(
    'master_owner_id', (f.mo).master_owner_id,
    'master_key', (f.mo).master_key,
    'owner_cluster_key', (f.mo).owner_cluster_key,
    'household_key', (f.mo).household_key,
    'display_name', (f.mo).display_name,
    'priority_score', (f.mo).priority_score,
    'priority_tier', (f.mo).priority_tier
  )) AS master_owner_entity,
  jsonb_strip_nulls(jsonb_build_object(
    'prospect_id', (f.pr).prospect_id,
    'canonical_prospect_id', (f.pr).canonical_prospect_id,
    'full_name', (f.pr).full_name,
    'first_name', (f.pr).first_name,
    'language', (f.pr).language_preference,
    'rank_position', (f.pr).rank_position
  )) AS prospect_entity,
  CASE
    WHEN f.contact_channel_type = 'phone' THEN
      jsonb_strip_nulls(jsonb_build_object(
        'phone_id', (f.ph).phone_id,
        'phone_number', (f.ph).phone,
        'canonical_e164', (f.ph).canonical_e164,
        'phone_owner', (f.ph).phone_owner,
        'activity_status', (f.ph).activity_status,
        'phone_rank', (f.ph).sort_rank,
        'wrong_number', f.resolved_wrong_number,
        'opt_out', f.resolved_opt_out,
        'do_not_contact', f.resolved_do_not_contact
      ))
    ELSE '{}'::jsonb
  END AS phone_entity,
  CASE
    WHEN f.contact_channel_type = 'email' THEN
      jsonb_strip_nulls(jsonb_build_object(
        'email_id', (f.em).email_id,
        'email', (f.em).email,
        'email_linkage_score_raw', (f.em).email_linkage_score_raw,
        'email_score_final', (f.em).email_score_final,
        'email_rank', (f.em).email_rank
      ))
    ELSE '{}'::jsonb
  END AS email_entity,
  jsonb_strip_nulls(jsonb_build_object(
    'thread_key', (f.its).thread_key,
    'conversation_thread_id', (f.its).thread_key,
    'status', (f.its).status,
    'stage', (f.its).stage,
    'inbox_bucket', f.resolved_inbox_bucket,
    'universal_status', f.resolved_universal_status,
    'universal_stage', f.resolved_universal_stage,
    'lead_temperature', f.resolved_lead_temperature,
    'reply_intent', f.resolved_reply_intent,
    'message_count', (f.its).message_count,
    'unread_count', (f.dts).unread_count
  )) AS thread_entity,
  jsonb_strip_nulls(jsonb_build_object(
    'latest_message_event_id', COALESCE((f.me).id, (f.its).latest_message_event_id),
    'latest_message_at', f.resolved_latest_message_at,
    'latest_message_body', f.resolved_latest_message_body,
    'direction', f.resolved_latest_direction,
    'event_type', COALESCE((f.me).event_type, (f.its).latest_event_type),
    'delivery_status', COALESCE(
      (f.me).delivery_status,
      (f.its).latest_delivery_status
    )
  )) AS message_summary,
  jsonb_strip_nulls(jsonb_build_object(
    'queue_id', (f.sq).id,
    'queue_status', (f.sq).queue_status,
    'scheduled_for', (f.sq).scheduled_for,
    'last_queued_at', (f.sq).created_at,
    'last_sent_at', (f.sq).sent_at,
    'last_delivered_at', (f.sq).delivered_at,
    'failure_reason', COALESCE(
      NULLIF((f.sq).failed_reason, ''),
      NULLIF((f.sq).blocked_reason, ''),
      NULLIF((f.sq).guard_reason, '')
    )
  )) AS queue_summary,
  jsonb_strip_nulls(jsonb_build_object(
    'campaign_id', (f.c).id,
    'campaign_name', COALESCE((f.c).name, (f.ct).campaign_name),
    'campaign_status', (f.c).status,
    'campaign_target_id', (f.ct).id,
    'target_status', (f.ct).target_status,
    'graph_id', (f.g).graph_id,
    'graph_source', (f.g).graph_source,
    'graph_generated_at', (f.g).generated_at
  )) AS campaign_summary,
  jsonb_strip_nulls(jsonb_build_object(
    'pipeline_stage', (f.sq).pipeline_stage,
    'seller_asking_price', (f.tas).asking_price,
    'offer_price', (f.tas).last_offer,
    'estimated_value', (f.p).estimated_value,
    'final_acquisition_score', (f.p).final_acquisition_score,
    'deal_strength_score', (f.p).deal_strength_score
  )) AS pipeline_summary,
  jsonb_strip_nulls(jsonb_build_object(
    'universal_status', f.resolved_universal_status,
    'universal_stage', f.resolved_universal_stage,
    'lead_temperature', f.resolved_lead_temperature,
    'inbox_bucket', f.resolved_inbox_bucket,
    'priority_score', (f.mo).priority_score,
    'is_pinned', COALESCE((f.its).is_pinned, false),
    'is_starred', COALESCE((f.its).is_starred, false),
    'is_archived', COALESCE((f.its).is_archived, false),
    'is_suppressed', (
      COALESCE((f.its).is_suppressed, false)
      OR f.resolved_do_not_contact
    ),
    'next_action', f.resolved_next_action,
    'next_follow_up_at', (f.its).follow_up_at
  )) AS universal_state,
  jsonb_build_object(
    'thread_count', jsonb_array_length(f.contact_threads),
    'threads', f.contact_threads
  ) AS contact_threads,
  jsonb_array_length(f.contact_threads) AS contact_thread_count,

  GREATEST(
    COALESCE((f.p).updated_at, (f.p).created_at, 'epoch'::timestamptz),
    COALESCE((f.mo).updated_at, (f.mo).created_at, 'epoch'::timestamptz),
    COALESCE((f.pr).updated_at, (f.pr).created_at, 'epoch'::timestamptz),
    COALESCE((f.ph).updated_at, (f.ph).created_at, 'epoch'::timestamptz),
    COALESCE((f.em).updated_at, (f.em).created_at, 'epoch'::timestamptz),
    COALESCE((f.its).updated_at, (f.its).created_at, 'epoch'::timestamptz),
    COALESCE((f.sq).updated_at, (f.sq).created_at, 'epoch'::timestamptz),
    COALESCE((f.ct).updated_at, (f.ct).created_at, 'epoch'::timestamptz),
    COALESCE((f.wr).updated_at, (f.wr).created_at, 'epoch'::timestamptz),
    COALESCE((f.tas).updated_at, (f.tas).created_at, 'epoch'::timestamptz),
    COALESCE(f.resolved_latest_message_at, 'epoch'::timestamptz)
  ) AS command_updated_at
FROM finalized f;

COMMENT ON VIEW public.v_universal_lead_command IS
  'Canonical operational read model at property + master owner + prospect + phone/email channel grain. Full message history remains in message_events.';

COMMENT ON COLUMN public.v_universal_lead_command.grain_key IS
  'Unique property_export_id + master_owner_id + prospect_id + contact_channel_type + contact_channel_value identity.';
COMMENT ON COLUMN public.v_universal_lead_command.owner_resolution_source IS
  'Property-to-owner provenance. campaign_target_graph is preferred when available because it repairs missing/stale property owner links.';
COMMENT ON COLUMN public.v_universal_lead_command.resolution_source IS
  'Explicit phone/email linked_prospect_ids_json path used to establish the prospect/channel row.';
COMMENT ON COLUMN public.v_universal_lead_command.resolution_confidence IS
  'Deterministic linkage confidence. 1.00 means owner and explicit channel-to-prospect linkage both validated.';
COMMENT ON COLUMN public.v_universal_lead_command.birth_year_month IS
  'Missing source field. prospects.mob exists, but no birth_year_month column was found.';
COMMENT ON COLUMN public.v_universal_lead_command.calculated_age IS
  'Missing source field. No reliable birth year exists in the audited source schema.';
COMMENT ON COLUMN public.v_universal_lead_command.total_loan_amount IS
  'Missing source field. total_loan_balance exists and is exposed separately.';
COMMENT ON COLUMN public.v_universal_lead_command.assessment_year IS
  'Missing source field. tax_year exists and is exposed separately.';
COMMENT ON COLUMN public.v_universal_lead_command.phone_confirmed IS
  'Missing source field. No confirmation boolean exists on phones.';
COMMENT ON COLUMN public.v_universal_lead_command.email_confirmed IS
  'Missing source field. No confirmation boolean exists on emails.';
COMMENT ON COLUMN public.v_universal_lead_command.email_status IS
  'Missing source field. email_eligible is not treated as an email status.';
COMMENT ON COLUMN public.v_universal_lead_command.offer_status IS
  'Missing source field.';
COMMENT ON COLUMN public.v_universal_lead_command.contract_status IS
  'Missing source field.';
COMMENT ON COLUMN public.v_universal_lead_command.closing_status IS
  'Missing source field.';
COMMENT ON COLUMN public.v_universal_lead_command.deal_status IS
  'Missing source field.';
COMMENT ON COLUMN public.v_universal_lead_command.message_summary IS
  'Latest message only. Full immutable message history must be queried from message_events by thread_key.';
COMMENT ON COLUMN public.v_universal_lead_command.contact_threads IS
  'Thread navigation/current-state summaries only; contains no message history.';

REVOKE ALL ON public.v_universal_lead_command FROM anon, authenticated;
GRANT SELECT ON public.v_universal_lead_command TO service_role;

-- Physical launch read model.
--
-- The view above is the canonical SQL definition and provenance contract.
-- Production/dashboard list and filter reads must use this cache after API
-- migration. The migration deliberately creates an empty cache; run the
-- refresh function as a separately monitored operation after migration apply.
CREATE TABLE public.universal_lead_command_cache AS
SELECT *
FROM public.v_universal_lead_command
WITH NO DATA;

ALTER TABLE public.universal_lead_command_cache
  ALTER COLUMN grain_key SET NOT NULL;

ALTER TABLE public.universal_lead_command_cache
  ADD CONSTRAINT universal_lead_command_cache_pkey
  PRIMARY KEY (grain_key);

CREATE INDEX idx_universal_lead_command_cache_property_id
  ON public.universal_lead_command_cache (property_id);

CREATE INDEX idx_universal_lead_command_cache_property_export_id
  ON public.universal_lead_command_cache (property_export_id);

CREATE INDEX idx_universal_lead_command_cache_master_owner_id
  ON public.universal_lead_command_cache (master_owner_id);

CREATE INDEX idx_universal_lead_command_cache_prospect_id
  ON public.universal_lead_command_cache (prospect_id);

CREATE INDEX idx_universal_lead_command_cache_contact_channel
  ON public.universal_lead_command_cache (
    contact_channel_value,
    contact_channel_type
  );

CREATE INDEX idx_universal_lead_command_cache_market_inbox
  ON public.universal_lead_command_cache (
    market,
    inbox_bucket,
    latest_message_at DESC
  );

CREATE INDEX idx_universal_lead_command_cache_campaign_target
  ON public.universal_lead_command_cache (
    campaign_id,
    target_status,
    command_updated_at DESC
  );

CREATE INDEX idx_universal_lead_command_cache_queue
  ON public.universal_lead_command_cache (
    queue_status,
    scheduled_for
  );

CREATE INDEX idx_universal_lead_command_cache_follow_up
  ON public.universal_lead_command_cache (next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL;

ALTER TABLE public.universal_lead_command_cache ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.universal_lead_command_cache IS
  'Physical fast read model populated from v_universal_lead_command. API list/filter reads use this table after route migration.';
COMMENT ON COLUMN public.universal_lead_command_cache.grain_key IS
  'Primary key matching the canonical property + owner + prospect + channel grain.';

REVOKE ALL ON public.universal_lead_command_cache
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.universal_lead_command_cache
  TO service_role;

-- Atomic cache refresh.
--
-- With no scope arguments this stages the full canonical view, validates its
-- grain, then replaces the cache contents in one transaction. Existing readers
-- continue to see the prior committed cache until the refresh commits.
--
-- Supplying any scope argument performs a targeted replacement. Callers should
-- prefer the narrowest stable identity:
--   campaign_target_graph/properties -> property_export_id
--   prospects                        -> master_owner_id and/or prospect_id
--   phones/emails                    -> master_owner_id/prospect_id/channel
--   inbox/message/workflow           -> thread_key
--   send_queue/campaign_targets      -> thread_key, property, owner, or channel
--
-- When an identity changes, pass both old and new identities, or pass the
-- containing property_export_id/master_owner_id, so stale cache rows are also
-- removed.
CREATE OR REPLACE FUNCTION public.refresh_universal_lead_command_cache(
  p_grain_keys text[] DEFAULT NULL,
  p_property_export_ids text[] DEFAULT NULL,
  p_property_ids text[] DEFAULT NULL,
  p_master_owner_ids text[] DEFAULT NULL,
  p_prospect_ids text[] DEFAULT NULL,
  p_thread_keys text[] DEFAULT NULL,
  p_contact_channel_values text[] DEFAULT NULL
)
RETURNS TABLE (
  refresh_mode text,
  staged_rows bigint,
  deleted_rows bigint,
  inserted_rows bigint,
  cache_rows bigint,
  started_at timestamptz,
  finished_at timestamptz,
  elapsed_ms numeric
)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_full_refresh boolean;
  v_distinct_grains bigint;
  v_scope_predicates text[] := ARRAY[]::text[];
  v_scope_predicate text;
  v_property_ids text[] := COALESCE(p_property_ids, ARRAY[]::text[]);
  v_master_owner_ids text[] := COALESCE(
    p_master_owner_ids,
    ARRAY[]::text[]
  );
  v_prospect_ids text[] := COALESCE(p_prospect_ids, ARRAY[]::text[]);
  v_contact_channel_values text[] := COALESCE(
    p_contact_channel_values,
    ARRAY[]::text[]
  );
  v_thread_property_ids text[];
  v_thread_master_owner_ids text[];
  v_thread_prospect_ids text[];
  v_thread_contact_values text[];
BEGIN
  started_at := clock_timestamp();
  v_full_refresh :=
    p_grain_keys IS NULL
    AND p_property_export_ids IS NULL
    AND p_property_ids IS NULL
    AND p_master_owner_ids IS NULL
    AND p_prospect_ids IS NULL
    AND p_thread_keys IS NULL
    AND p_contact_channel_values IS NULL;

  refresh_mode := CASE WHEN v_full_refresh THEN 'full' ELSE 'incremental' END;

  -- thread_key is joined late in the canonical view. Resolve it to early-grain
  -- identities first so thread/message/workflow refreshes remain indexable.
  IF COALESCE(cardinality(p_thread_keys), 0) > 0 THEN
    SELECT
      array_agg(DISTINCT identity_rows.property_id)
        FILTER (WHERE identity_rows.property_id IS NOT NULL),
      array_agg(DISTINCT identity_rows.master_owner_id)
        FILTER (
          WHERE identity_rows.property_id IS NULL
            AND identity_rows.prospect_id IS NULL
            AND identity_rows.master_owner_id IS NOT NULL
        ),
      array_agg(DISTINCT identity_rows.prospect_id)
        FILTER (
          WHERE identity_rows.property_id IS NULL
            AND identity_rows.prospect_id IS NOT NULL
        ),
      array_agg(DISTINCT identity_rows.contact_channel_value)
        FILTER (
          WHERE identity_rows.property_id IS NULL
            AND identity_rows.prospect_id IS NULL
            AND identity_rows.master_owner_id IS NULL
            AND identity_rows.contact_channel_value IS NOT NULL
        )
    INTO
      v_thread_property_ids,
      v_thread_master_owner_ids,
      v_thread_prospect_ids,
      v_thread_contact_values
    FROM (
      SELECT
        its.property_id,
        its.master_owner_id,
        its.prospect_id,
        COALESCE(
          NULLIF(its.canonical_e164, ''),
          NULLIF(its.seller_phone, '')
        ) AS contact_channel_value
      FROM public.inbox_thread_state its
      WHERE its.thread_key = ANY(p_thread_keys)

      UNION ALL

      SELECT
        cache.property_id,
        cache.master_owner_id,
        cache.prospect_id,
        cache.contact_channel_value
      FROM public.universal_lead_command_cache cache
      WHERE cache.thread_key = ANY(p_thread_keys)
    ) identity_rows;

    SELECT COALESCE(array_agg(DISTINCT value), ARRAY[]::text[])
    INTO v_property_ids
    FROM unnest(
      v_property_ids
      || COALESCE(v_thread_property_ids, ARRAY[]::text[])
    ) value;

    SELECT COALESCE(array_agg(DISTINCT value), ARRAY[]::text[])
    INTO v_master_owner_ids
    FROM unnest(
      v_master_owner_ids
      || COALESCE(v_thread_master_owner_ids, ARRAY[]::text[])
    ) value;

    SELECT COALESCE(array_agg(DISTINCT value), ARRAY[]::text[])
    INTO v_prospect_ids
    FROM unnest(
      v_prospect_ids
      || COALESCE(v_thread_prospect_ids, ARRAY[]::text[])
    ) value;

    SELECT COALESCE(array_agg(DISTINCT value), ARRAY[]::text[])
    INTO v_contact_channel_values
    FROM unnest(
      v_contact_channel_values
      || COALESCE(v_thread_contact_values, ARRAY[]::text[])
    ) value;
  END IF;

  IF v_full_refresh THEN
    v_scope_predicate := 'true';
  ELSE
    IF COALESCE(cardinality(p_grain_keys), 0) > 0 THEN
      v_scope_predicates := array_append(
        v_scope_predicates,
        'grain_key = any($1)'
      );
    END IF;
    IF COALESCE(cardinality(p_property_export_ids), 0) > 0 THEN
      v_scope_predicates := array_append(
        v_scope_predicates,
        'property_export_id = any($2)'
      );
    END IF;
    IF COALESCE(cardinality(v_property_ids), 0) > 0 THEN
      v_scope_predicates := array_append(
        v_scope_predicates,
        'property_id = any($3)'
      );
    END IF;
    IF COALESCE(cardinality(v_master_owner_ids), 0) > 0 THEN
      v_scope_predicates := array_append(
        v_scope_predicates,
        'master_owner_id = any($4)'
      );
    END IF;
    IF COALESCE(cardinality(v_prospect_ids), 0) > 0 THEN
      v_scope_predicates := array_append(
        v_scope_predicates,
        'prospect_id = any($5)'
      );
    END IF;
    IF COALESCE(cardinality(v_contact_channel_values), 0) > 0 THEN
      v_scope_predicates := array_append(
        v_scope_predicates,
        'contact_channel_value = any($7)'
      );
    END IF;

    v_scope_predicate := COALESCE(
      NULLIF(array_to_string(v_scope_predicates, ' OR '), ''),
      'false'
    );
  END IF;

  -- Serialize cache writers without blocking cache readers.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('public.universal_lead_command_cache.refresh', 0)
  );

  DROP TABLE IF EXISTS pg_temp.universal_lead_command_cache_stage;

  EXECUTE format(
    'CREATE TEMP TABLE universal_lead_command_cache_stage
       ON COMMIT DROP
       AS
       SELECT *
       FROM public.v_universal_lead_command
       WHERE %s',
    v_scope_predicate
  )
  USING
    p_grain_keys,
    p_property_export_ids,
    v_property_ids,
    v_master_owner_ids,
    v_prospect_ids,
    NULL::text[],
    v_contact_channel_values;

  SELECT count(*), count(DISTINCT grain_key)
  INTO staged_rows, v_distinct_grains
  FROM pg_temp.universal_lead_command_cache_stage;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.universal_lead_command_cache_stage
    WHERE grain_key IS NULL
  ) THEN
    RAISE EXCEPTION
      'universal lead cache refresh aborted: staged grain_key is null';
  END IF;

  IF staged_rows <> v_distinct_grains THEN
    RAISE EXCEPTION
      'universal lead cache refresh aborted: % rows but % distinct grains',
      staged_rows,
      v_distinct_grains;
  END IF;

  CREATE UNIQUE INDEX universal_lead_command_cache_stage_grain_key_idx
    ON pg_temp.universal_lead_command_cache_stage (grain_key);

  EXECUTE format(
    'DELETE FROM public.universal_lead_command_cache WHERE %s',
    v_scope_predicate
  )
  USING
    p_grain_keys,
    p_property_export_ids,
    v_property_ids,
    v_master_owner_ids,
    v_prospect_ids,
    NULL::text[],
    v_contact_channel_values;

  GET DIAGNOSTICS deleted_rows = ROW_COUNT;

  INSERT INTO public.universal_lead_command_cache
  SELECT *
  FROM pg_temp.universal_lead_command_cache_stage;

  GET DIAGNOSTICS inserted_rows = ROW_COUNT;

  SELECT count(*)
  INTO cache_rows
  FROM public.universal_lead_command_cache;

  finished_at := clock_timestamp();
  elapsed_ms := round(
    (extract(epoch FROM (finished_at - started_at)) * 1000)::numeric,
    3
  );

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.refresh_universal_lead_command_cache(
  text[],
  text[],
  text[],
  text[],
  text[],
  text[],
  text[]
) IS
  'Atomically full-refreshes or scope-refreshes universal_lead_command_cache from the canonical view. Full refresh rewrites the cache and must be monitored.';

REVOKE ALL ON FUNCTION public.refresh_universal_lead_command_cache(
  text[],
  text[],
  text[],
  text[],
  text[],
  text[],
  text[]
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.refresh_universal_lead_command_cache(
  text[],
  text[],
  text[],
  text[],
  text[],
  text[],
  text[]
) TO service_role;

-- Intentionally no automatic refresh here. Populate in a separately monitored
-- operation after migration approval:
--
--   SET statement_timeout = 0;
--   SELECT * FROM public.refresh_universal_lead_command_cache();
--
-- Launch validation queries are maintained in
-- docs/backend/v_universal_lead_command_plan.md.
