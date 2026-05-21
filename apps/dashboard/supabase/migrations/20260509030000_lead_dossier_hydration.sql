-- migration: lead_dossier_hydration
-- description: Canonical hydrated view for full lead dossier and advanced filtering.

BEGIN;

DROP VIEW IF EXISTS public.inbox_operator_dossier_v CASCADE;

CREATE OR REPLACE VIEW public.inbox_operator_dossier_v AS
WITH base AS (
  -- Re-use the hydration logic from inbox_threads_hydrated but expand fields
  SELECT 
    h.*,
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
      NULLIF(h.seller_phone, ''),
      (regexp_match(h.thread_key, 'phone:(.+)'))[1],
      'Unknown Phone'
    ) as display_phone,
    COALESCE(h.market, 'Unknown') as display_market,
    COALESCE(h.status, 'open') as display_status,
    COALESCE(h.final_acquisition_score, h.priority_score, 0) as display_score
  FROM public.inbox_threads_hydrated h
),
full_context AS (
  SELECT
    b.*,
    -- Prospect Details
    pr.canonical_prospect_id,
    pr.cnam,
    pr.gender,
    pr.marital_status,
    pr.education_model,
    pr.occupation_group,
    pr.est_household_income,
    pr.net_asset_value,
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
    -- Owner Details
    mo.primary_owner_address,
    mo.owner_type_guess,
    mo.routing_market,
    mo.routing_timezone,
    mo.best_channel,
    mo.best_contact_window,
    mo.contactability_score,
    mo.financial_pressure_score,
    mo.urgency_score,
    mo.priority_tier as owner_priority_tier,
    mo.follow_up_cadence,
    mo.best_phone_1,
    mo.best_phone_2,
    mo.best_phone_3,
    mo.best_email_1,
    mo.best_email_2,
    mo.portfolio_total_value,
    mo.portfolio_total_equity,
    mo.portfolio_total_loan_balance,
    mo.portfolio_total_units,
    mo.seller_tags_text,
    mo.seller_tags_json,
    mo.agent_persona,
    mo.agent_family,
    -- Property Details
    p.property_address_city,
    p.property_address_state,
    p.property_address_zip,
    p.property_county_name,
    p.market_region,
    p.property_class,
    p.estimated_repair_cost,
    p.deal_strength_score,
    p.equity_amount,
    p.equity_percent,
    p.total_loan_balance,
    p.tax_delinquent,
    p.active_lien,
    p.ownership_years,
    p.units_count,
    p.building_square_feet,
    p.total_bedrooms,
    p.total_baths,
    p.year_built,
    p.effective_year_built,
    p.lot_acreage,
    p.latitude,
    p.longitude,
    p.building_condition,
    p.building_quality,
    p.rehab_level,
    p.seller_tags_text as podio_tags, -- properties also has tags? 
    p.streetview_image,
    p.satellite_image,
    p.map_image
  FROM base b
  LEFT JOIN public.prospects pr ON pr.prospect_id::text = b.prospect_id
  LEFT JOIN public.master_owners mo ON mo.master_owner_id::text = b.master_owner_id
  LEFT JOIN public.properties p ON p.property_id::text = b.property_id
)
SELECT
  *,
  -- Normalized Filter Columns
  property_address_state as filter_state,
  property_address_city as filter_city,
  property_address_zip as filter_zip,
  market as filter_market,
  property_type as filter_property_type,
  owner_type_guess as filter_owner_type,
  best_language as filter_language,
  agent_persona as filter_agent_persona,
  owner_priority_tier as filter_priority_tier,
  ui_intent as filter_inbox_category, -- category rollup?
  ui_intent as filter_intent,
  stage as filter_stage,
  status as filter_status,
  (property_id IS NOT NULL) as filter_has_property,
  (master_owner_id IS NOT NULL) as filter_has_owner,
  (prospect_id IS NOT NULL) as filter_has_prospect,
  (is_hot_lead OR show_in_priority_inbox) as filter_is_hot,
  is_suppressed as filter_is_dnc,
  (latest_direction = 'inbound') as filter_is_inbound,
  (latest_direction = 'outbound') as filter_is_outbound,
  COALESCE(final_acquisition_score, 0) as filter_min_score,
  tax_delinquent as filter_tax_delinquent,
  active_lien as filter_active_lien,
  (equity_percent > 40) as filter_high_equity,
  (owner_type_guess = 'absentee') as filter_absentee_owner,
  (owner_type_guess = 'corporate') as filter_corporate_owner
FROM full_context;

GRANT SELECT ON public.inbox_operator_dossier_v TO anon;

COMMIT;
