-- =====================================================================
-- OFFERR COMP-INTELLIGENCE CANONICAL CONTRACT — public.v_recent_sold_comps (comp view)
-- =====================================================================
-- PARITY CLASS : EXACT PRODUCTION DEFINITION (verbatim pg_get_viewdef)
-- PROVENANCE   : pg_get_viewdef(oid, true) on production public.v_recent_sold_comps
-- RECOVERED    : 2026-07-30 (read-only pg_catalog inspection, project lcppdrmrdfblstpcbgpf)
-- SCHEMA VERSION: offerr-comp-intelligence/1.0.0
--
-- THE MISSING LINK. get_comp_candidates_for_subject does NOT read
-- buyer_comp_raw_v2 directly -- it reads THIS VIEW, which is a projection over
-- buyer_comp_raw_v2 filtered to `import_status IS DISTINCT FROM 'rejected'`.
-- Because the view passes `id` straight through, comp_id returned by the RPC is
-- exactly buyer_comp_raw_v2.id, which is what makes the loader's
-- `.in('id', compIds)` identity join correct.
--
-- Two derived columns carry real gating semantics:
--   is_usable_comp  -- the ONLY validity filter the RPC applies to a candidate.
--                      Requires: a coalesced sale price, a sale_date, latitude,
--                      longitude, property_address_full and property_address_zip
--                      to all be NON-NULL. It does NOT reject zero/negative
--                      prices and does NOT reject future sale dates.
--   computed_ppsf   -- coalesced sale price / building_square_feet, else ppsf.
--
-- Reproduced verbatim. Do not "improve" it here: divergence from production is
-- exactly what this contract exists to prevent.
--
-- This file is applied by apps/api/scripts/offerr/offerr-staging-bootstrap.sql
-- via \ir. It is NOT part of the ordinary supabase/migrations chain: these
-- objects already exist in production and must never be re-created there.
-- =====================================================================

CREATE OR REPLACE VIEW public.v_recent_sold_comps AS
SELECT id,
    batch_id,
    source_record_id,
    source_deal_id,
    property_id,
    normalized_asset_class,
    comp_search_profile_hash,
    renovation_level_classification,
    sqft_range,
    sqft_per_unit,
    beds_per_unit,
    year_built_bucket,
    purchase_info,
    ppbd,
    ppu,
    ppsf,
    price_off_value,
    percent_off,
    potential_spread,
    arv_estimate,
    arv_ppsf,
    comp_confidence_score,
    deal_grade,
    target_margin_percent,
    property_address_full,
    property_address,
    property_address_city,
    property_address_state,
    property_address_zip,
    property_address_county_name,
    latitude,
    longitude,
    sale_date,
    COALESCE(sale_price, saleprice, mls_sold_price) AS sale_price,
    mls_sold_date,
    mls_sold_price,
    estimated_value,
    estimated_repair_cost,
    estimated_repair_cost_per_sqft,
    equity_amount,
    equity_percent,
    total_bedrooms,
    total_baths,
    building_square_feet,
    lot_square_feet,
    lot_acreage,
    units_count,
    year_built,
    effective_year_built,
    construction_type,
    building_condition,
    property_type,
    property_class,
    streetview_image,
    satellite_image,
    property_flags_json,
    property_flags_text,
    created_at,
    updated_at,
        CASE
            WHEN mls_sold_price IS NOT NULL THEN 'MLS Sold'::text
            WHEN sale_price IS NOT NULL OR saleprice IS NOT NULL THEN 'Public Record Sold'::text
            ELSE 'Off-Market Sold'::text
        END AS sale_source,
        CASE
            WHEN COALESCE(sale_price, saleprice, mls_sold_price) IS NOT NULL AND NULLIF(building_square_feet, 0::numeric) IS NOT NULL THEN round(COALESCE(sale_price, saleprice, mls_sold_price) / NULLIF(building_square_feet, 0::numeric), 2)
            ELSE ppsf
        END AS computed_ppsf,
        CASE
            WHEN sale_date >= (CURRENT_DATE - '6 mons'::interval) THEN true
            ELSE false
        END AS is_recent_6_months,
        CASE
            WHEN COALESCE(sale_price, saleprice, mls_sold_price) IS NOT NULL AND sale_date IS NOT NULL AND latitude IS NOT NULL AND longitude IS NOT NULL AND property_address_full IS NOT NULL AND property_address_zip IS NOT NULL THEN true
            ELSE false
        END AS is_usable_comp
   FROM buyer_comp_raw_v2
  WHERE import_status IS DISTINCT FROM 'rejected'::text;
