-- =====================================================================
-- OFFERR COMP-INTELLIGENCE CANONICAL CONTRACT — public.buyer_entities_v2 (buyer buy-box enrichment)
-- =====================================================================
-- PARITY CLASS : EXACT PRODUCTION COLUMN CONTRACT (all 49 columns)
-- PROVENANCE   : pg_catalog / information_schema column, constraint and index contract
-- RECOVERED    : 2026-07-30 (read-only pg_catalog inspection, project lcppdrmrdfblstpcbgpf)
-- SCHEMA VERSION: offerr-comp-intelligence/1.0.0
--
-- compCandidateLoader.js treats this source as OPTIONAL: a failure here is
-- swallowed and enrichment is skipped. It is reproduced in full so the
-- enrichment branch executes for real in staging instead of being skipped.
--
-- This file is applied by apps/api/scripts/offerr/offerr-staging-bootstrap.sql
-- via \ir. It is NOT part of the ordinary supabase/migrations chain: these
-- objects already exist in production and must never be re-created there.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.buyer_entities_v2 (
  id                             uuid DEFAULT gen_random_uuid() NOT NULL,
  buyer_key                      text NOT NULL,
  buyer_name                     text NOT NULL,
  normalized_buyer_name          text,
  buyer_type                     text DEFAULT 'unknown'::text,
  is_corporate_buyer             boolean DEFAULT false,
  is_repeat_buyer                boolean DEFAULT false,
  mailing_address_full           text,
  mailing_address_line_1         text,
  mailing_address_line_2         text,
  mailing_city                   text,
  mailing_state                  text,
  mailing_zip                    text,
  owner_1_name                   text,
  owner_2_name                   text,
  first_purchase_date            date,
  last_purchase_date             date,
  purchase_count                 integer DEFAULT 0 NOT NULL,
  purchase_count_180d            integer DEFAULT 0 NOT NULL,
  purchase_count_365d            integer DEFAULT 0 NOT NULL,
  markets_active                 text[] DEFAULT '{}'::text[] NOT NULL,
  counties_active                text[] DEFAULT '{}'::text[] NOT NULL,
  zips_active                    text[] DEFAULT '{}'::text[] NOT NULL,
  preferred_asset_classes        text[] DEFAULT '{}'::text[] NOT NULL,
  preferred_price_min            numeric,
  preferred_price_max            numeric,
  avg_purchase_price             numeric,
  median_purchase_price          numeric,
  avg_ppsf                       numeric,
  avg_units                      numeric,
  avg_repair_estimate            numeric,
  avg_equity_percent             numeric,
  investor_score                 numeric,
  velocity_score                 numeric,
  corporate_buyer_score          numeric,
  dispo_priority_score           numeric,
  contact_enrichment_status      text DEFAULT 'not_started'::text NOT NULL,
  raw_profile                    jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at                     timestamptz DEFAULT now() NOT NULL,
  updated_at                     timestamptz DEFAULT now() NOT NULL,
  dominant_comp_search_profiles  text[] DEFAULT '{}'::text[] NOT NULL,
  preferred_sqft_ranges          text[] DEFAULT '{}'::text[] NOT NULL,
  preferred_year_built_buckets   text[] DEFAULT '{}'::text[] NOT NULL,
  preferred_renovation_levels    text[] DEFAULT '{}'::text[] NOT NULL,
  avg_target_margin_percent      numeric,
  avg_percent_off                numeric,
  avg_potential_spread           numeric,
  avg_ppbd                       numeric,
  avg_ppu                        numeric,
  CONSTRAINT buyer_entities_v2_pkey PRIMARY KEY (id),
  CONSTRAINT buyer_entities_v2_buyer_key_key UNIQUE (buyer_key),
  CONSTRAINT buyer_entities_v2_buyer_type_check CHECK (buyer_type = ANY (ARRAY['individual'::text, 'corporate'::text, 'trust'::text, 'institutional'::text, 'unknown'::text])),
  CONSTRAINT buyer_entities_v2_contact_enrichment_status_check CHECK (contact_enrichment_status = ANY (ARRAY['not_started'::text, 'queued'::text, 'in_progress'::text, 'completed'::text, 'failed'::text, 'do_not_contact'::text]))
);

CREATE INDEX IF NOT EXISTS idx_bev2_normalized_name
  ON public.buyer_entities_v2 USING btree (normalized_buyer_name);
CREATE INDEX IF NOT EXISTS idx_bev2_buyer_key
  ON public.buyer_entities_v2 USING btree (buyer_key);
