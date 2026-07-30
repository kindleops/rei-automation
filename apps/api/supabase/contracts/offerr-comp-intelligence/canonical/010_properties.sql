-- =====================================================================
-- OFFERR COMP-INTELLIGENCE CANONICAL CONTRACT — public.properties (subject table)
-- =====================================================================
-- PARITY CLASS : COMPATIBLE RECONSTRUCTION (column subset, exact types)
-- PROVENANCE   : pg_catalog / information_schema column contract of production public.properties
-- RECOVERED    : 2026-07-30 (read-only pg_catalog inspection, project lcppdrmrdfblstpcbgpf)
-- SCHEMA VERSION: offerr-comp-intelligence/1.0.0
--
-- Production public.properties carries 343 columns. This contract materialises
-- the 117 columns the Offerr evaluation path actually reads:
--   * PROPERTY_RESOLUTION_SELECT  (offerr-property-resolution.js)
--   * SUBJECT_SELECT              (acquisitionDecisionEngine.js loadSubjectProperty)
--   * property_export_id          (production PRIMARY KEY)
-- Types, nullability and defaults are byte-faithful to production.
--
-- DOCUMENTED DEVIATIONS FROM PRODUCTION:
--   1. The 226 unread columns are omitted.
--   2. properties_master_owner_id_fkey -> master_owners is omitted (that table is
--      outside the Offerr comp surface; the column itself is preserved).
--   3. properties_upsert_key_key UNIQUE(upsert_key) is omitted with the column.
--
-- This file is applied by apps/api/scripts/offerr/offerr-staging-bootstrap.sql
-- via \ir. It is NOT part of the ordinary supabase/migrations chain: these
-- objects already exist in production and must never be re-created there.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.properties (
  property_export_id               text NOT NULL,
  property_id                      text NOT NULL,
  property_address_full            text,
  property_address                 text,
  property_address_city            text,
  property_address_state           text,
  property_address_zip             text,
  property_type                    text,
  market                           text,
  master_owner_id                  text,
  property_address_county_name     text,
  latitude                         numeric,
  longitude                        numeric,
  asset_type                       text,
  asset_class                      text,
  asset_subtype                    text,
  normalized_asset_class           text,
  normalized_asset_subclass        text,
  property_class                   text,
  building_class                   text,
  property_subtype                 text,
  commercial_property_type         text,
  commercial_subtype               text,
  total_bedrooms                   numeric,
  total_baths                      numeric,
  building_square_feet             numeric,
  units_count                      integer,
  avg_sqft_per_unit                numeric,
  sqft_per_unit                    numeric,
  beds_per_unit                    numeric,
  year_built                       integer,
  effective_year_built             integer,
  lot_square_feet                  numeric,
  subdivision_name                 text,
  school_district_name             text,
  zoning                           text,
  flood_zone                       text,
  hoa1_name                        text,
  geographic_features              text,
  property_flags_text              text,
  property_flags_json              jsonb,
  building_condition               text,
  building_quality                 text,
  construction_type                text,
  exterior_walls                   text,
  interior_walls                   text,
  floor_cover                      text,
  roof_cover                       text,
  roof_type                        text,
  estimated_repair_cost            numeric,
  estimated_repair_cost_per_sqft   numeric,
  rehab_level                      text,
  renovation_level_classification  text,
  air_conditioning                 text,
  heating_type                     text,
  heating_fuel_type                text,
  sewer                            text,
  water                            text,
  basement                         text,
  garage                           text,
  sum_garage_sqft                  numeric,
  pool                             text,
  porch                            text,
  patio                            text,
  deck                             text,
  driveway                         text,
  stories                          numeric,
  style                            text,
  sum_buildings_nbr                numeric,
  sum_commercial_units             numeric,
  commercial_units                 numeric,
  estimated_value                  numeric,
  calculated_total_value           numeric,
  assd_total_value                 numeric,
  mls_current_listing_price        numeric,
  mls_market_status                text,
  mls_sold_date                    date,
  mls_sold_price                   numeric,
  sale_date                        text,
  sale_price                       numeric,
  equity_amount                    numeric,
  equity_percent                   numeric,
  total_loan_balance               numeric,
  total_loan_amt                   numeric,
  total_loan_payment               numeric,
  tax_amt                          numeric,
  ownership_years                  numeric,
  out_of_state_owner               boolean,
  owner_location                   text,
  owner_type                       text,
  owner_type_guess                 text,
  is_corporate_owner               boolean,
  tax_delinquent                   boolean,
  tax_delinquent_year              integer,
  past_due_amount                  numeric,
  active_lien                      boolean,
  lien_type                        text,
  foreclosure_status               text,
  foreclosure_stage                text,
  preforeclosure_status            text,
  preforeclosure_stage             text,
  default_date                     date,
  is_foreclosure                   boolean,
  is_preforeclosure                boolean,
  is_pre_foreclosure               boolean,
  is_hot_preforeclosure            boolean,
  is_hot_pre_foreclosure           boolean,
  seller_tags_text                 text,
  seller_tags_json                 jsonb DEFAULT '[]'::jsonb NOT NULL,
  podio_tags                       text,
  structured_motivation_score      numeric,
  tag_distress_score               numeric,
  deal_strength_score              numeric,
  final_acquisition_score          numeric,
  rent_estimate                    numeric,
  monthly_rent                     numeric,
  market_status_label              text,
  CONSTRAINT properties_pkey PRIMARY KEY (property_export_id)
);

-- Production index set, restricted to the indexes the Offerr path depends on.
-- uq_properties_property_id is the one the resolver and loadSubjectProperty rely
-- on: property_id is NOT the primary key in production, property_export_id is.
CREATE UNIQUE INDEX IF NOT EXISTS uq_properties_property_id
  ON public.properties USING btree (property_id) WHERE (property_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_properties_property_id
  ON public.properties USING btree (property_id);
CREATE INDEX IF NOT EXISTS idx_properties_property_address_full
  ON public.properties USING btree (property_address_full);
CREATE INDEX IF NOT EXISTS idx_properties_latitude_longitude
  ON public.properties USING btree (latitude, longitude);
