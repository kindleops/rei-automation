-- lc-fixture: setup
-- DISPOSABLE DATABASE ONLY. Setup for the Action Gateway T3 / T4 link
-- (supabase/migrations/PROPOSED_20261020110000_action_gateway_t34.sql) and its PG tests: the production
-- columns of the public tables the seller-facing / financial family reads or writes that the disposable chain
-- fixtures do not already carry (prod-shaped subsets; column names as read / written by
-- seller-flow/seller-offer-authority.js, opportunity-economics/economics-service.js, property-research/offer-plan.js,
-- negotiation/negotiation-composer.js, queue/process-send-queue.js and the canonical loaders), plus the
-- production uniqueness of public.seller_offers (apps/api/supabase/migrations/20260830000000_seller_offer_authority.sql).
-- Composable with the chain fixtures: create-if-not-exists, then add-column-if-not-exists.
-- Applied by scripts/db/run-migration-test.mjs as setup; never against Supabase.
create extension if not exists pgcrypto;

create table if not exists public.acquisition_opportunities (id uuid primary key default gen_random_uuid());
alter table public.acquisition_opportunities add column if not exists primary_property_id text, add column if not exists primary_thread_key text,
  add column if not exists acquisition_stage text, add column if not exists opportunity_status text, add column if not exists automation_state text,
  add column if not exists metadata jsonb, add column if not exists active_offer_id text, add column if not exists accepted_offer_id text,
  add column if not exists current_offer numeric, add column if not exists market text, add column if not exists next_action text,
  add column if not exists updated_at timestamptz;

create table if not exists public.seller_offers (id uuid primary key default gen_random_uuid(), offer_id text unique);
alter table public.seller_offers add column if not exists opportunity_id uuid, add column if not exists property_id text, add column if not exists thread_key text,
  add column if not exists master_owner_id text, add column if not exists offer_version integer, add column if not exists offer_type text,
  add column if not exists direction text default 'outbound', add column if not exists purchase_price numeric, add column if not exists closing_date date,
  add column if not exists closing_term text, add column if not exists closing_window_days integer, add column if not exists emd_amount numeric,
  add column if not exists emd_term text, add column if not exists emd_due_business_days integer, add column if not exists emd_due_date date,
  add column if not exists policy_version text, add column if not exists ade_snapshot_id text, add column if not exists recommended_offer numeric,
  add column if not exists authorized_ceiling numeric, add column if not exists valuation_mid numeric, add column if not exists strategy text,
  add column if not exists status text default 'active', add column if not exists created_at timestamptz default now(), add column if not exists sent_at timestamptz,
  add column if not exists superseded_at timestamptz, add column if not exists superseded_by_offer_id text, add column if not exists accepted_at timestamptz,
  add column if not exists acceptance_event_id text, add column if not exists accepted_price numeric, add column if not exists send_queue_row_id text,
  add column if not exists source_message_event_id text, add column if not exists terms_hash text, add column if not exists metadata jsonb default '{}'::jsonb,
  add column if not exists updated_at timestamptz default now();
create unique index if not exists uq_seller_offers_version on public.seller_offers (opportunity_id, offer_version) where opportunity_id is not null;
create unique index if not exists uq_seller_offers_one_active on public.seller_offers (opportunity_id) where status = 'active' and opportunity_id is not null;

create table if not exists public.properties (property_id text primary key);
alter table public.properties add column if not exists property_type text, add column if not exists units_count integer, add column if not exists estimated_value numeric,
  add column if not exists arv_estimate numeric, add column if not exists asset_type text, add column if not exists asset_subtype text, add column if not exists property_use text,
  add column if not exists land_use text, add column if not exists county_land_use_code text, add column if not exists zoning text, add column if not exists is_land boolean,
  add column if not exists is_vacant_land boolean, add column if not exists is_raw_land boolean, add column if not exists is_development_land boolean,
  add column if not exists is_infill_lot boolean, add column if not exists lot_acreage numeric, add column if not exists multifamily_units integer,
  add column if not exists commercial_property_type text, add column if not exists beds numeric, add column if not exists baths numeric,
  add column if not exists sqft numeric, add column if not exists building_sqft numeric, add column if not exists year_built integer, add column if not exists lot_sqft numeric,
  add column if not exists condition text, add column if not exists property_condition text, add column if not exists market text,
  -- the economics read (opportunity-economics/economics-service.js ECONOMICS_PROPERTY_FIELDS)
  add column if not exists assd_total_value numeric, add column if not exists market_status_value text, add column if not exists property_class text,
  add column if not exists normalized_asset_class text, add column if not exists asset_class text, add column if not exists building_square_feet numeric,
  add column if not exists total_bedrooms numeric, add column if not exists total_baths numeric, add column if not exists lot_square_feet numeric,
  add column if not exists rehab_level text, add column if not exists total_loan_amt numeric, add column if not exists total_loan_payment numeric,
  add column if not exists active_lien boolean, add column if not exists tax_delinquent boolean, add column if not exists latitude numeric, add column if not exists longitude numeric;

create table if not exists public.property_acquisition_scores (id uuid primary key default gen_random_uuid(), property_id text);
alter table public.property_acquisition_scores add column if not exists computed_at timestamptz, add column if not exists created_at timestamptz default now(),
  add column if not exists decision_tier text, add column if not exists valuation_mid numeric, add column if not exists valuation_low numeric, add column if not exists valuation_high numeric,
  add column if not exists valuation_confidence numeric, add column if not exists comp_count integer, add column if not exists investor_ceiling_mid numeric,
  add column if not exists investor_ceiling_high numeric, add column if not exists recommended_cash_offer numeric, add column if not exists minimum_acceptable_offer numeric,
  add column if not exists estimated_repairs numeric, add column if not exists buyer_demand_score integer, add column if not exists liquidity_score integer,
  add column if not exists evidence jsonb;

create table if not exists public.sms_templates (id uuid primary key default gen_random_uuid());
alter table public.sms_templates add column if not exists template_id text, add column if not exists use_case text, add column if not exists language text,
  add column if not exists is_active boolean, add column if not exists safe_for_auto_reply boolean, add column if not exists template_body text,
  add column if not exists stage_code text, add column if not exists reply_mode text, add column if not exists quarantine_state text default 'active';

create table if not exists public.textgrid_numbers (id uuid primary key default gen_random_uuid());
alter table public.textgrid_numbers add column if not exists phone_number text, add column if not exists status text, add column if not exists market text,
  add column if not exists health_state text, add column if not exists daily_limit integer default 800, add column if not exists messages_sent_today integer default 0;
