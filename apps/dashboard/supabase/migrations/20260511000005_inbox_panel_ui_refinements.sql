-- migration: extend_inbox_threads_hydrated_dossier
-- description: Adds all necessary dossier fields to the hydrated inbox views so they flow into the UI properly.

BEGIN;

DROP VIEW IF EXISTS public.inbox_category_counts CASCADE;
DROP VIEW IF EXISTS public.inbox_command_center_v CASCADE;
DROP VIEW IF EXISTS public.inbox_threads_hydrated CASCADE;

CREATE OR REPLACE VIEW public.inbox_threads_hydrated AS
WITH base AS (
  SELECT
    nt.thread_key,
    nt.latest_message_at,
    nt.latest_direction,
    nt.latest_message_body,
    nt.market,
    nt.message_count,
    nt.inbound_count,
    nt.outbound_count,
    nt.pending_queue_count,
    nt.last_inbound_at,
    nt.last_outbound_at,
    nt.ui_intent,
    nt.priority_bucket,
    nt.status,
    nt.stage,
    nt.show_in_priority_inbox,
    nt.event_property_address,
    nt.event_seller_display_name,
    COALESCE(ts.automation_status, ts.automation_state, 'active') as automation_status,
    ts.follow_up_at,
    ts.agent_id,
    ts.persona_id,
    COALESCE(ts.is_starred, false) as is_starred, 
    COALESCE(ts.is_suppressed, false) as is_suppressed,
    COALESCE(ts.is_read, nt.is_read) as is_read,
    COALESCE(ts.is_pinned, nt.is_pinned) as is_pinned,
    COALESCE(ts.is_archived, nt.is_archived) as is_archived,
    COALESCE(ts.is_hot_lead, nt.is_hot_lead) as is_hot_lead,
    COALESCE(
      NULLIF(ts.canonical_e164, ''),
      NULLIF(ts.seller_phone, ''),
      (regexp_match(nt.thread_key, 'phone:(.+)'))[1]
    ) as best_phone,
    COALESCE(NULLIF(nt.master_owner_id, ''), NULLIF(ts.master_owner_id, '')) as final_master_owner_id,
    COALESCE(NULLIF(nt.prospect_id, ''), NULLIF(ts.prospect_id, '')) as final_prospect_id,
    COALESCE(NULLIF(nt.property_id, ''), NULLIF(ts.property_id, '')) as final_property_id
  FROM public.nexus_inbox_threads_v nt
  LEFT JOIN public.inbox_thread_state ts ON ts.thread_key = nt.thread_key
),
phone_links AS (
  SELECT DISTINCT ON (b.thread_key)
    b.thread_key,
    ph.master_owner_id as ph_master_owner_id,
    ph.primary_prospect_id as ph_prospect_id,
    ph.phone_owner as ph_phone_carrier
  FROM base b
  JOIN public.phones ph ON ph.canonical_e164 = b.best_phone
  WHERE b.best_phone IS NOT NULL AND b.best_phone != ''
  ORDER BY b.thread_key, ph.created_at DESC
),
prospect_links AS (
  SELECT DISTINCT ON (b.thread_key)
    b.thread_key,
    pr.prospect_id as pr_prospect_id,
    pr.master_owner_id as pr_master_owner_id
  FROM base b
  JOIN public.prospects pr ON pr.best_phone = b.best_phone
  WHERE b.best_phone IS NOT NULL AND b.best_phone != ''
  ORDER BY b.thread_key, pr.created_at DESC
),
resolved_ids AS (
  SELECT
    b.thread_key,
    COALESCE(
      b.final_prospect_id,
      pl.ph_prospect_id,
      prl.pr_prospect_id
    ) as resolved_prospect_id,
    COALESCE(
      b.final_master_owner_id,
      pl.ph_master_owner_id,
      prl.pr_master_owner_id
    ) as resolved_master_owner_id,
    b.final_property_id as resolved_property_id,
    pl.ph_phone_carrier as resolved_phone_carrier
  FROM base b
  LEFT JOIN phone_links pl ON pl.thread_key = b.thread_key
  LEFT JOIN prospect_links prl ON prl.thread_key = b.thread_key
),
final_resolved_ids AS (
  SELECT
    r.*,
    COALESCE(
      r.resolved_property_id,
      (
        SELECT property_id::text 
        FROM public.properties p 
        WHERE p.master_owner_id::text = r.resolved_master_owner_id 
        ORDER BY estimated_value DESC NULLS LAST 
        LIMIT 1
      )
    ) as final_resolved_property_id
  FROM resolved_ids r
)
SELECT
  b.thread_key,
  b.latest_message_at,
  b.latest_direction,
  b.latest_message_body,
  b.market,
  b.message_count,
  b.inbound_count,
  b.outbound_count,
  b.pending_queue_count,
  b.last_inbound_at,
  b.last_outbound_at,
  b.ui_intent,
  b.priority_bucket,
  b.status,
  b.stage,
  b.show_in_priority_inbox,
  b.is_archived,
  b.is_read,
  b.is_pinned,
  b.is_hot_lead,
  b.automation_status,
  b.follow_up_at,
  b.agent_id,
  b.persona_id,
  b.is_starred,
  b.is_suppressed,
  b.best_phone as seller_phone,
  b.best_phone,
  b.event_property_address,
  b.event_seller_display_name,
  -- Export the resolved IDs so downstream views/UI don't see nulls
  r.resolved_master_owner_id as master_owner_id,
  r.resolved_prospect_id as prospect_id,
  r.final_resolved_property_id as property_id,
  r.resolved_phone_carrier as phone_carrier,
  NULL::integer as sfr_count,
  NULL::integer as mf_count,
  
  -- Core fields
  p.property_address_full, 
  p.property_type, 
  p.estimated_value, 
  p.cash_offer,
  p.final_acquisition_score, 
  p.structured_motivation_score as priority_score,
  p.property_address_city as city, 
  p.property_address_state as state, 
  p.property_address_zip as zip,
  mo.best_language, 
  mo.priority_score as owner_priority_score,
  mo.display_name as owner_display_name,
  pr.full_name as prospect_full_name, 
  pr.first_name as prospect_first_name,
  
  -- PROSPECT FIELDS
  pr.canonical_prospect_id,
  pr.cnam,
  pr.gender,
  pr.marital_status,
  pr.education_model,
  pr.occupation_group,
  pr.occupation_code as occupation,
  pr.est_household_income,
  pr.net_asset_value,
  (date_part('year', CURRENT_DATE) - cast(NULLIF(substring(pr.mob, 1, 4), '') as integer)) as prospect_age,
  pr.buying_power,
  pr.likely_owner,
  pr.likely_renting,
  pr.matching_flags,
  pr.person_flags_text,
  pr.person_flags_json,
  pr.contact_score_final as prospect_contact_score,
  pr.phone_score_final as prospect_phone_score,
  pr.best_phone as prospect_best_phone,
  pr.best_email as prospect_best_email,
  pr.sms_eligible,
  pr.email_eligible,
  
  -- OWNER FIELDS
  mo.primary_owner_address,
  mo.owner_type_guess,
  mo.best_contact_window,
  mo.contactability_score,
  mo.financial_pressure_score,
  mo.urgency_score,
  mo.priority_tier as owner_priority_tier,
  mo.portfolio_total_value,
  mo.portfolio_total_equity,
  mo.portfolio_total_loan_balance,
  mo.portfolio_total_loan_payment,
  mo.portfolio_total_units,
  mo.property_count,
  mo.tax_delinquent_count,
  mo.oldest_tax_delinquent_year,
  mo.active_lien_count,
  mo.seller_tags_text,
  mo.seller_tags_json,
  mo.follow_up_cadence,
  mo.best_phone_1,
  mo.best_phone_2,
  mo.best_phone_3,
  mo.best_email_1,
  mo.best_email_2,
  mo.agent_persona,
  mo.agent_family,
  mo.joined_property_ids_json,

  -- PROPERTY FIELDS
  p.property_address_city,
  p.property_address_state,
  p.property_address_zip,
  p.property_county_name,
  p.market_region,
  p.property_class,
  p.estimated_repair_cost,
  p.estimated_repair_cost_per_sqft,
  p.deal_strength_score,
  p.equity_amount,
  p.equity_percent,
  p.total_loan_amt,
  p.total_loan_balance,
  p.total_loan_payment,
  p.tax_delinquent as property_tax_delinquent,
  p.tax_delinquent_year as property_tax_delinquent_year,
  p.tax_amt,
  p.tax_year,
  p.active_lien as property_active_lien,
  p.ownership_years,
  p.units_count,
  p.building_square_feet,
  p.total_bedrooms,
  p.total_baths,
  p.year_built,
  p.effective_year_built,
  p.lot_acreage,
  p.lot_square_feet,
  p.lot_size_depth_feet,
  p.lot_size_frontage_feet,
  p.latitude,
  p.longitude,
  p.building_condition,
  p.building_quality,
  p.rehab_level,
  p.podio_tags,
  p.property_flags_text,
  p.property_flags_json,
  p.streetview_image,
  p.satellite_image,
  p.map_image,
  p.style,
  p.stories,
  p.sum_buildings_nbr,
  p.avg_sqft_per_unit,
  p.beds_per_unit,
  p.sqft_range,
  p.construction_type,
  p.exterior_walls,
  p.floor_cover,
  p.basement,
  p.other_rooms,
  p.num_of_fireplaces,
  p.patio,
  p.porch,
  p.deck,
  p.driveway,
  p.garage,
  p.sum_garage_sqft,
  p.air_conditioning,
  p.heating_type,
  p.heating_fuel_type,
  p.interior_walls,
  p.roof_cover,
  p.roof_type,
  p.pool,
  p.sewer,
  p.water,
  p.zoning,
  p.flood_zone,
  p.legal_description,
  p.subdivision_name,
  p.school_district_name,
  p.assd_total_value,
  p.assd_land_value,
  p.assd_improvement_value,
  p.calculated_total_value,
  p.calculated_land_value,
  p.calculated_improvement_value,
  p.saleprice as sale_price,
  p.sale_date,
  p.recording_date,
  p.last_sale_doc_type,
  p.past_due_amount,
  p.ai_score,
  p.is_corporate_owner,
  p.out_of_state_owner
FROM base b
JOIN final_resolved_ids r ON r.thread_key = b.thread_key
LEFT JOIN public.properties p ON p.property_id::text = r.final_resolved_property_id
LEFT JOIN public.master_owners mo ON mo.master_owner_id::text = r.resolved_master_owner_id
LEFT JOIN public.prospects pr ON pr.prospect_id::text = r.resolved_prospect_id;

CREATE OR REPLACE VIEW public.inbox_command_center_v AS
SELECT
  h.*,
  h.ui_intent as detected_intent,
  h.stage as queue_stage,
  h.automation_status as automation_state,
  h.latest_message_at as last_message_iso,
  h.latest_message_body as preview,
  COALESCE(
    NULLIF(h.prospect_full_name, ''),
    NULLIF(h.owner_display_name, ''),
    NULLIF(h.event_seller_display_name, ''),
    NULLIF(h.seller_phone, ''),
    h.thread_key
  ) as display_name,
  COALESCE(
    NULLIF(h.property_address_full, ''),
    NULLIF(h.event_property_address, ''),
    'Unknown Property'
  ) as display_address,
  COALESCE(
    NULLIF(h.best_phone, ''),
    (regexp_match(h.thread_key, 'phone:(.+)'))[1],
    'Unknown Phone'
  ) as display_phone,
  COALESCE(h.market, 'Unknown') as display_market,
  COALESCE(h.status, 'open') as display_status,
  COALESCE(h.final_acquisition_score, h.priority_score, 0) as display_score,
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
  END as inbox_category,
  
  -- Normalized Filter Columns
  h.state as filter_state,
  h.city as filter_city,
  h.zip as filter_zip,
  h.market as filter_market,
  h.property_type as filter_property_type,
  h.owner_type_guess as filter_owner_type,
  h.best_language as filter_language,
  h.agent_persona as filter_agent_persona,
  h.owner_priority_tier as filter_priority_tier,
  h.ui_intent as filter_inbox_category,
  h.ui_intent as filter_intent,
  h.stage as filter_stage,
  h.status as filter_status,
  (h.property_id IS NOT NULL) as filter_has_property,
  (h.master_owner_id IS NOT NULL) as filter_has_owner,
  (h.prospect_id IS NOT NULL) as filter_has_prospect,
  (h.is_hot_lead OR h.show_in_priority_inbox) as filter_is_hot,
  h.is_suppressed as filter_is_dnc,
  (h.latest_direction = 'inbound') as filter_is_inbound,
  (h.latest_direction = 'outbound') as filter_is_outbound,
  COALESCE(h.final_acquisition_score, 0) as filter_min_score,
  h.property_tax_delinquent as filter_tax_delinquent,
  h.property_active_lien as filter_active_lien,
  (h.equity_percent > 40) as filter_high_equity,
  (h.owner_type_guess = 'absentee' OR h.out_of_state_owner = true) as filter_absentee_owner,
  (h.is_corporate_owner = true) as filter_corporate_owner
FROM public.inbox_threads_hydrated h;

CREATE OR REPLACE VIEW public.inbox_category_counts AS
SELECT
  inbox_category as category,
  count(*) as count
FROM public.inbox_command_center_v
GROUP BY 1;

GRANT SELECT ON public.inbox_command_center_v TO anon;
GRANT SELECT ON public.inbox_threads_hydrated TO anon;
GRANT SELECT ON public.inbox_category_counts TO anon;

COMMIT;
