-- outbound-feeder-candidates-refresh.sql
-- Refreshes the outbound_feeder_candidates materialized table from canonical sources.
-- Run this before launching campaigns.
-- TRUNCATE + INSERT is idempotent — safe to re-run at any time.
--
-- Sources:
--   base:     v_sms_campaign_queue_candidates  (property + owner + phone + financials)
--   enriched: prospects LATERAL join           (matching_flags, likely_owner, person_flags_text)
--   enriched: contact_outreach_state           (touch history, suppression, dnc, is_paused)
--   enriched: properties                       (property_type, property_class)
--
-- Filters applied (mirrors v_feeder_candidates_fast):
--   sms_eligible = true
--   best_phone_e164 IS NOT NULL
--   master_owner_id IS NOT NULL
--   property_id IS NOT NULL
--   suppression_until IS NULL OR suppression_until <= now()
--   is_paused IS NULL OR is_paused = false
--   dnc IS NULL OR dnc = false

BEGIN;

TRUNCATE outbound_feeder_candidates;

INSERT INTO outbound_feeder_candidates (
  property_id,
  master_owner_id,
  primary_prospect_id,
  owner_display_name,
  prospect_display_name,
  prospect_first_name,
  matching_flags,
  likely_owner,
  likely_renting,
  linked_to_company,
  likely_linked_to_company,
  person_flags_text,
  best_phone_id,
  best_phone,
  best_phone_e164,
  phone_type,
  best_phone_score,
  sms_eligible,
  property_address_full,
  property_address_city,
  property_address_state,
  property_address_zip,
  property_address_county_name,
  market,
  timezone,
  contact_window,
  cash_offer,
  estimated_value,
  equity_amount,
  equity_percent,
  estimated_repair_cost,
  final_acquisition_score,
  property_type,
  property_class,
  canonical_property_group,
  last_sms_at,
  last_outbound_at,
  first_outbound_at,
  last_touch_at,
  touch_count,
  current_touch_number,
  suppression_until,
  dnc,
  is_paused,
  never_contacted,
  updated_at
)
SELECT
  c.property_id,
  c.master_owner_id,
  c.primary_prospect_id,
  c.owner_display_name,
  c.prospect_display_name,
  c.prospect_first_name,
  pr.matching_flags,
  pr.likely_owner,
  pr.likely_renting,
  -- linked_to_company: flag present and not a "likely" or "potentially" variant
  (
    pr.matching_flags IS NOT NULL
    AND pr.matching_flags ILIKE '%linked to company%'
    AND pr.matching_flags NOT ILIKE '%likely linked to company%'
    AND pr.matching_flags NOT ILIKE '%potentially linked%'
  ) AS linked_to_company,
  -- likely_linked_to_company
  (
    pr.matching_flags IS NOT NULL
    AND pr.matching_flags ILIKE '%likely linked to company%'
  ) AS likely_linked_to_company,
  pr.person_flags_text,
  c.best_phone_id,
  c.best_phone,
  c.best_phone_e164,
  c.phone_type,
  c.best_phone_score,
  c.sms_eligible,
  c.property_address_full,
  c.property_address_city,
  c.property_address_state,
  c.property_address_zip,
  c.property_address_county_name,
  c.market,
  c.timezone,
  c.contact_window,
  c.cash_offer,
  c.estimated_value,
  c.equity_amount,
  c.equity_percent,
  c.estimated_repair_cost,
  c.final_acquisition_score,
  props.property_type,
  props.property_class,
  CASE
    WHEN LOWER(COALESCE(props.property_type, props.property_class, '')) IN (
      'sfr', 'single family', 'single-family', 'residential', 'single_family'
    ) THEN 'sfr'
    WHEN LOWER(COALESCE(props.property_type, props.property_class, '')) = 'duplex'   THEN 'duplex'
    WHEN LOWER(COALESCE(props.property_type, props.property_class, '')) = 'triplex'  THEN 'triplex'
    WHEN LOWER(COALESCE(props.property_type, props.property_class, '')) = 'fourplex' THEN 'fourplex'
    WHEN LOWER(COALESCE(props.property_type, props.property_class, '')) LIKE '%multifamily%'
      AND LOWER(COALESCE(props.property_type, props.property_class, '')) LIKE '%small%' THEN 'small_multifamily'
    WHEN LOWER(COALESCE(props.property_type, props.property_class, '')) LIKE '%multifamily%' THEN 'multifamily_5_plus'
    WHEN LOWER(COALESCE(props.property_type, props.property_class, '')) LIKE '%retail%'
      OR  LOWER(COALESCE(props.property_type, props.property_class, '')) LIKE '%strip%'   THEN 'retail'
    WHEN LOWER(COALESCE(props.property_type, props.property_class, '')) LIKE '%office%'    THEN 'office'
    WHEN LOWER(COALESCE(props.property_type, props.property_class, '')) LIKE '%industrial%'
      OR  LOWER(COALESCE(props.property_type, props.property_class, '')) LIKE '%warehouse%' THEN 'industrial'
    WHEN LOWER(COALESCE(props.property_type, props.property_class, '')) LIKE '%storage%'   THEN 'self_storage'
    WHEN LOWER(COALESCE(props.property_type, props.property_class, '')) LIKE '%hotel%'
      OR  LOWER(COALESCE(props.property_type, props.property_class, '')) LIKE '%motel%'    THEN 'hotel_motel'
    WHEN LOWER(COALESCE(props.property_type, props.property_class, '')) LIKE '%mobile%'    THEN 'mobile_home_park'
    WHEN LOWER(COALESCE(props.property_type, props.property_class, '')) LIKE '%land%'
      OR  LOWER(COALESCE(props.property_type, props.property_class, '')) LIKE '%lot%'
      OR  LOWER(COALESCE(props.property_type, props.property_class, '')) LIKE '%parcel%'   THEN 'land'
    ELSE 'other_commercial'
  END AS canonical_property_group,
  cos.last_sms_at,
  cos.last_outbound_at,
  cos.first_outbound_at,
  cos.last_touch_at,
  COALESCE(cos.touch_count, 0)     AS touch_count,
  COALESCE(cos.touch_count, 0) + 1 AS current_touch_number,
  cos.suppression_until,
  COALESCE(cos.dnc, false)       AS dnc,
  COALESCE(cos.is_paused, false) AS is_paused,
  (cos.podio_master_owner_id IS NULL OR cos.last_sms_at IS NULL) AS never_contacted,
  NOW() AS updated_at

FROM v_sms_campaign_queue_candidates c

LEFT JOIN LATERAL (
  SELECT
    p.matching_flags,
    p.person_flags_text,
    p.likely_owner,
    p.likely_renting
  FROM prospects p
  WHERE p.master_owner_id = c.master_owner_id
  ORDER BY
    (p.matching_flags IS NOT NULL AND p.matching_flags <> '') DESC,
    p.is_primary_prospect DESC NULLS LAST,
    p.phone_score_final DESC NULLS LAST,
    p.prospect_id
  LIMIT 1
) pr ON true

LEFT JOIN contact_outreach_state cos
  ON cos.podio_master_owner_id = c.master_owner_id
  AND cos.to_phone_number = c.best_phone_e164

LEFT JOIN properties props
  ON props.property_export_id = c.property_export_id

WHERE
  c.sms_eligible = true
  AND c.best_phone_e164 IS NOT NULL
  AND c.master_owner_id IS NOT NULL
  AND c.property_id IS NOT NULL
  AND (cos.suppression_until IS NULL OR cos.suppression_until <= NOW())
  AND (cos.is_paused IS NULL OR cos.is_paused = false)
  AND (cos.dnc IS NULL OR cos.dnc = false);

-- Post-load summary
SELECT
  COUNT(*)                                                            AS loaded_count,
  COUNT(*) FILTER (WHERE never_contacted = true)                      AS never_contacted_count,
  COUNT(*) FILTER (WHERE never_contacted = false)                     AS previously_contacted_count,
  COUNT(DISTINCT market)                                              AS market_count,
  COUNT(*) FILTER (WHERE matching_flags IS NOT NULL AND matching_flags <> '') AS with_matching_flags,
  COUNT(*) FILTER (WHERE likely_owner = true)                         AS likely_owner_count,
  COUNT(*) FILTER (WHERE likely_renting = true)                       AS likely_renting_count,
  COUNT(*) FILTER (WHERE likely_renting = true AND likely_owner IS DISTINCT FROM true) AS renter_not_owner_count,
  COUNT(*) FILTER (WHERE property_type IS NOT NULL)                   AS with_property_type
FROM outbound_feeder_candidates;

COMMIT;
