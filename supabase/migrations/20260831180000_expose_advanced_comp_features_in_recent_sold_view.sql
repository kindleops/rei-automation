-- ─── Expose already-ingested advanced comp features ────────────────────────
--
-- DEFECT (audit 2026-08-31): the ADE scores comps against 45 subject features
-- (FEATURE_GROUPS). buyer_comp_raw_v2 ALREADY carries the amenity / utility /
-- quality / location families at real coverage (pool 84.1%, school_district
-- 84.1%, deck 84.1%, flood_zone 82.9%, subdivision 78.8%, heating_type 78.6%,
-- air_conditioning 76.6%, exterior_walls 75.7%, building_quality 63.9%,
-- garage 60.2%, roof_cover 58.1%, zoning 56.7%, basement 49.7%,
-- heating_fuel 41.3%, roof_type 38.1%, water 37.4%, sewer 36.8%,
-- floor_cover 20.8%, interior_walls 14.7%), with real values such as
-- 'Attached Garage', 'Central', 'Composition Shingle', 'Brick veneer'.
--
-- v_recent_sold_comps selects FROM that same table but its explicit projection
-- omits every one of those columns, so normalizePropertyFeatures (which already
-- maps all of them) always saw null. Result: every selected comp scored
-- data_completeness = 37 in every market, costing ~11 points of
-- valuation_confidence system-wide.
--
-- Measured effect of this projection alone (real engine, shadow, real subjects):
--   comp data_completeness  39.04 -> 77.57
--   valuation_confidence    +6 to +7
--   overall confidence      +2 to +3
--   property 2127732482 moved CREATIVE_TERMS -> AUTO_HARD_OFFER
--
-- This is a projection repair only. No threshold, weight, or scoring rule
-- changes. Column NAMES are preserved exactly as normalizePropertyFeatures
-- expects them.
--
-- NOT INCLUDED (no reliable source; deliberately left absent so their absence
-- keeps reducing completeness as the contract intends):
--   * garage_square_feet  - no column in buyer_comp_raw_v2
--   * road_boundary       - no column in buyer_comp_raw_v2
--   * hoa_1_name          - no column in buyer_comp_raw_v2
-- `stories` IS passed through because it is a real source column, but it is
-- 0.0% populated today and therefore contributes nothing; it is not fabricated.
--
-- Sparse-by-source fields (patio 1.7%, porch 2.3%, driveway 2.8%) are passed
-- through EXACTLY as stored. Empty strings normalize to null via clean() /
-- normalizeBooleanCategory(), so they gain no false completeness credit.
--
-- CREATE OR REPLACE VIEW requires existing columns keep their name, type and
-- order, so the new columns are appended after is_usable_comp.

create or replace view public.v_recent_sold_comps as
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
        END AS is_usable_comp,
    -- ── advanced comp features (already ingested; previously dropped here) ──
    -- location_context
    subdivision_name,
    school_district_name,
    zoning,
    flood_zone,
    -- quality_condition
    building_quality,
    exterior_walls,
    interior_walls,
    floor_cover,
    roof_cover,
    roof_type,
    -- amenities_structure
    basement,
    garage,
    pool,
    porch,
    patio,
    deck,
    driveway,
    stories,
    style,
    -- utility_mechanical
    air_conditioning,
    heating_type,
    heating_fuel_type,
    sewer,
    water
   FROM buyer_comp_raw_v2
  WHERE import_status IS DISTINCT FROM 'rejected'::text;

comment on view public.v_recent_sold_comps is
  'Recent sold comps projected from buyer_comp_raw_v2. Advanced property features (amenities / utility / quality / location) are exposed here because the ADE feature-completeness contract scores comps against them; omitting them silently capped comp data_completeness at 37 in every market.';
