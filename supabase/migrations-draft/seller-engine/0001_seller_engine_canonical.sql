-- ============================================================================
-- SELLER ENGINE — canonical structures (DRAFT — DO NOT APPLY)
-- Phase 3 draft implementing SELLER_CANONICAL_SCHEMA_V1 + locked deltas:
--   OD-2  multi-state ownership classifications (child table, not one column)
--   OD-9  dormant columns present (officers, NOD/NOS, email ranks 4-5)
--   OD-12 aggregates as checksums (loan_checksums), 4 explicit fallbacks
--   OD-18/OD-20 table moves; P2-1 outcome labels; P2-2 comp snapshots;
--   P2-4 corpus manifests; P2-6 jurisdictional process tables.
-- Conventions: text ids from deterministic hashing (see lib/hash.mjs);
-- zips/fips/apn/phones as TEXT (leading-zero law); raw JSON always retained.
-- All tables live in schema seller_engine to stay disjoint from platform tables.
-- ============================================================================
create schema if not exists seller_engine;
set search_path to seller_engine;

-- ---------- ingestion & lineage ----------
create table import_batches (
  id text primary key,
  vendor text not null default 'dealmachine',
  file_set text not null,             -- properties|liens|companies|contact_info|prospects
  source_path text not null,
  corpus_id text,                     -- fk corpus_manifests, set on corpus membership
  run_ids text[] not null default '{}',
  list_id text,
  scraped_at_min timestamptz,
  scraped_at_max timestamptz,
  provider_last_updated_max timestamptz,   -- OD-8
  file_sha256 text not null,
  row_count integer not null,
  schema_fingerprint text not null,   -- sha of sorted header list
  loaded_at timestamptz not null default now()
);

create table source_records (
  id text primary key,
  import_batch_id text not null references import_batches(id),
  source_table text not null,
  source_row_number integer not null,
  property_data_id text,
  payload jsonb not null,             -- full raw row: excluded fields live here
  payload_sha256 text not null,
  scraped_at timestamptz,
  unique (import_batch_id, source_row_number)
);

-- ---------- corpus manifests (P2-4) ----------
create table corpus_manifests (
  id text primary key,
  name text not null,                       -- e.g. corpus_v1, vendor_schema_drift_qa_corpus
  status text not null check (status in ('proposed','approved','frozen')),
  created_at timestamptz not null default now(),
  approved_by text,
  notes text
);
create table corpus_members (
  corpus_id text not null references corpus_manifests(id),
  file_path text not null,
  file_sha256 text not null,
  file_set text not null,
  row_count integer not null,
  schema_fingerprint text not null,
  completion_evidence jsonb not null,       -- checkpoint counts, markers
  primary key (corpus_id, file_sha256)
);

-- ---------- property core ----------
create table properties (
  id text primary key,                      -- deterministic from vendor property_id
  vendor_property_id text not null unique,
  apn_parcel_id text,
  fips text,
  situs_address_full text,
  situs_city text, situs_state text, situs_zip text, situs_county text,
  latitude double precision, longitude double precision,
  asset_class text,                          -- from property_use_standardized routing
  property_use_standardized text,
  property_use_raw text,
  year_built integer,
  effective_year_built integer,
  building_square_feet numeric,
  lot_square_feet numeric,
  units_count integer,
  condition_raw text, condition_state text,  -- five-state
  quality_raw text,
  raw jsonb not null,
  first_seen_batch text references import_batches(id),
  last_seen_batch text references import_batches(id)
);

create table property_ownerships (
  id text primary key,
  property_id text not null references properties(id),
  owner_slot smallint not null default 1,
  owner_name_raw text,
  owner_hash text,
  mailing_address_full text, mailing_state text, mailing_zip text,
  vesting_raw text,
  occupancy_raw text,                        -- owner_location / owner_status raw
  effective_batch text references import_batches(id),
  raw jsonb not null
);

-- OD-2: multi-state classifications — one row per classification per evidence source
create table ownership_classifications (
  id text primary key,
  ownership_id text not null references property_ownerships(id),
  classification text not null,              -- individual|corporate|trust|bank|estate|institutional|...
  evidence_source text not null,             -- corp_owner|is_corporate_owner|owner_status|vesting|company_link|probate_doc
  confidence text not null check (confidence in ('exact','high','medium','low')),
  effective_at timestamptz not null,
  import_batch_id text references import_batches(id)
);

-- ---------- people, links, contacts ----------
create table people (
  id text primary key,
  individual_key text,
  identity_tier text not null check (identity_tier in ('key','household_name','name_address','link_scoped')),
  full_name text, given_name text, surname text, generational_suffix text,
  household_id text,
  raw jsonb not null
);

create table property_person_links (
  id text primary key,
  property_id text not null references properties(id),
  person_id text not null references people(id),
  matching_type text,
  matching_flags text[] not null default '{}',    -- authoritative tokens (OD-13)
  likely_owner_scalar boolean,                    -- validation only
  is_matching_property_as_owner boolean,
  renter_flag boolean not null default false,     -- hard outreach gate
  link_tier text not null check (link_tier in ('exact','high','medium','low','none')),
  scalar_corroborated boolean not null default false,  -- F-111 (batch-liveness gated)
  import_batch_id text references import_batches(id),
  raw jsonb not null
);

create table contact_phones (
  id text primary key,
  person_id text references people(id),
  link_id text references property_person_links(id),
  phone_e164 text,
  phone_raw text not null,
  rank smallint,
  line_type text,                 -- wireless|landline|voip|paging|unknown
  carrier_raw text,
  do_not_call boolean, never_call boolean,
  rnd_listed boolean not null default false,
  litigator_flag boolean not null default false,
  import_batch_id text references import_batches(id)
);

create table contact_emails (
  id text primary key,
  person_id text references people(id),
  link_id text references property_person_links(id),
  email_normalized text,
  email_raw text not null,
  rank smallint,                  -- 1..5; ranks 4-5 dormant (OD-9)
  blocked boolean,
  linkage_score numeric,
  verification_raw text,          -- OD-20: rank-1 verification attaches here
  verification_code text,
  last_seen_date date,
  import_batch_id text references import_batches(id)
);

-- ---------- companies (officers dormant, OD-9) ----------
create table companies (
  id text primary key,
  jurisdiction_code text,
  company_number text,            -- TEXT; '0' = missing sentinel
  company_name text,
  status_raw text,
  existence_norm text, standing_norm text,
  incorporation_date date, dissolution_date date,
  raw jsonb not null
);
create table company_officers (   -- DORMANT: no source data yet; activation monitored
  id text primary key,
  company_id text not null references companies(id),
  officer_index integer,
  name text, position_raw text, officer_group text,
  import_batch_id text references import_batches(id)
);
create table property_company_links (
  id text primary key,
  property_id text not null references properties(id),
  company_id text not null references companies(id),
  matched_party text,
  matching_type_code text,        -- opaque '21' pending vendor answer (OD-3)
  raw jsonb not null
);

-- ---------- debt, transactions, liens, foreclosure ----------
create table property_loans (
  id text primary key,
  property_id text not null references properties(id),
  slot_class text not null check (slot_class in ('current_recorded','concurrent','previous')),
  slot_ordinal smallint not null,
  lien_position smallint,
  original_loan_amount numeric,
  estimated_balance numeric, estimated_balance_state text,
  estimated_interest_rate numeric, interest_rate_state text,
  term_months integer, term_state text,
  recording_date date, due_date date,
  loan_type_raw text, loan_type_group text,
  financing_type_raw text,
  lender_name text,
  blanket_loan_flag boolean not null default false,   -- T-05 guard
  raw jsonb not null,
  import_batch_id text references import_batches(id)
);
create table loan_checksums (      -- OD-12: vendor aggregates as checksums/fallbacks
  property_id text primary key references properties(id),
  total_loan_amount numeric, total_loan_balance numeric, total_loan_payment numeric,
  num_of_mortgages integer,        -- FALLBACK (vendor openness knowledge)
  total_open_lien_nbr integer,     -- FALLBACK
  owner_has_multiple_properties boolean,  -- FALLBACK
  conflict_flags text[] not null default '{}',
  import_batch_id text references import_batches(id)
);

create table property_transactions (
  id text primary key,
  property_id text not null references properties(id),
  vendor_transaction_id text,
  event_role text check (event_role in ('current','previous')),
  sale_date date, contract_date date,
  sale_price numeric,
  price_qualifier_raw text,
  price_qualifier_class text,      -- valuation|valuation_caution|distress_context|evidence_only|unusable|unknown
  document_type_raw text, document_type_group text,
  buyer_names text[], seller_names text[],
  raw jsonb not null,
  import_batch_id text references import_batches(id)
);

create table property_liens (
  id text primary key,
  property_id text not null references properties(id),
  doc_number text, recording_date date, filing_date date,
  lien_type_raw text,
  doc_category_code text, doc_type_raw text,
  base_type text, action_modifier text,   -- compositional parse
  lifecycle_class text not null,          -- creation|litigation|judgment|modification|assignment|continuation|release|foreclosure_related|probate_life_event|ucc_context|neutral|ambiguous
  amount_due numeric, previous_amount_due numeric,
  county text, state text,
  date_of_death date, date_of_divorce date,
  -- dormant NOD/NOS & detail columns (OD-9): populated when vendor exports them
  nod_nos_doc_type text, nod_nos_recording_date date, nod_nos_default_amount numeric,
  unpaid_balance numeric, amount_of_default numeric, judgment_grand_total numeric,
  raw jsonb not null,
  import_batch_id text references import_batches(id)
);
create table lien_lifecycle_events (      -- episode state machine (IX-03)
  id text primary key,
  episode_id text not null,
  property_id text not null references properties(id),
  lien_id text not null references property_liens(id),
  event_kind text not null check (event_kind in
    ('open','amend','assign','continue','partial_release','close_release','close_satisfaction','close_termination','review_unmatched_release')),
  event_date date,
  created_at timestamptz not null default now()
);
create table lien_parties (
  id text primary key,
  lien_id text not null references property_liens(id),
  party_ordinal smallint not null,
  name_ordinal smallint not null,
  full_name text,
  role_raw text,
  owner_side boolean,
  matched_person_id text references people(id),
  raw jsonb not null
);

create table property_foreclosure_events (
  id text primary key,
  property_id text not null references properties(id),
  foreclosure_id text,
  stage text,                     -- lis_pendens|nod|nos_nts|auction_scheduled|reo|resolved
  document_type_raw text,
  default_date date, auction_date date, recording_date date,
  unpaid_balance numeric, auction_minimum_bid numeric,
  raw jsonb not null,
  import_batch_id text references import_batches(id)
);

-- ---------- snapshots (immutable) ----------
create table market_feature_snapshots (   -- P2-2 immutable interface (see SNAPSHOT_INTERFACE.md)
  id text primary key,
  subject_property_id text references properties(id),
  as_of timestamptz not null,
  asset_class text not null, asset_subtype text,
  cohort_rung smallint not null, cohort_key text not null, cohort_n integer not null,
  selected_comp_ids text[] not null default '{}',
  comp_eligibility jsonb not null default '{}'::jsonb,
  comp_exclusions jsonb not null default '{}'::jsonb,
  weighted_comp_score numeric,
  valuation_low numeric, valuation_high numeric, valuation_confidence numeric,
  sale_velocity numeric, inventory_absorption numeric,
  buyer_velocity numeric, buyer_demand_confidence numeric,
  warnings text[] not null default '{}',
  source_engine text not null,           -- e.g. comp_intelligence_v4@<sha>
  created_at timestamptz not null default now()
);

create table seller_feature_snapshots (
  id text primary key,
  property_id text not null references properties(id),
  person_id text references people(id),
  as_of timestamptz not null,
  engine_version_id text not null,
  features jsonb not null,               -- [{feature_id,value,value_state,confidence,evidence,as_of,formula_version,missing,explanation}]
  inputs_max_observed_at timestamptz,    -- T-10 proof
  created_at timestamptz not null default now()
);
create table seller_score_snapshots (
  id text primary key,
  feature_snapshot_id text not null references seller_feature_snapshots(id),
  engine_version_id text not null,
  family text not null,                  -- 19 families + execution_priority
  score numeric,
  score_state text not null,             -- scored|blocked|insufficient
  confidence numeric,
  created_at timestamptz not null default now()
);
create table seller_score_explanations (
  id text primary key,
  score_snapshot_id text not null references seller_score_snapshots(id),
  direction text not null check (direction in ('positive','negative','gate','blocked')),
  component text not null,
  contribution numeric,
  evidence jsonb not null default '{}'::jsonb
);
create table seller_engine_versions (
  id text primary key,
  name text not null,                    -- seller_engine_deterministic_v1 | seller_engine_v12_baseline
  semver text not null,
  config_sha256 text not null,
  weight_class text not null check (weight_class in ('provisional_domain_weight','reconstructed_legacy','calibrated')),
  notes text,
  created_at timestamptz not null default now()
);

-- ---------- outcomes (P2-1) ----------
create table outcome_labels (
  id text primary key,
  property_id text not null references properties(id),
  person_id text references people(id),
  family text not null check (family in ('verified_sale','seller_intent','investor_conversion','economic_outcome')),
  label_key text not null,               -- e.g. sale_90d, positive_response, offer_accepted, realized_spread
  as_of timestamptz not null,
  horizon_days integer,
  state text not null check (state in ('positive','negative','censored','excluded')),
  value numeric,                          -- economics family
  event_ts timestamptz,
  event_source text,
  exclusion_reason text,                  -- non-arms-length, corrective deed, ...
  join_confidence text,
  created_at timestamptz not null default now()
);

-- ---------- jurisdiction (P2-6), domains, queues ----------
create table jurisdiction_process (
  fips text not null default '',   -- '' = state-level row; county rows carry FIPS
  state text not null,
  process_kind text not null check (process_kind in ('foreclosure','auction','redemption','tax_sale')),
  judicial boolean,
  typical_days_min integer, typical_days_max integer,
  statute_ref text,
  populated boolean not null default false,     -- absence degrades confidence, never invents
  primary key (state, process_kind, fips)
);
create table domain_values (
  id text primary key,
  domain_key text not null,
  raw_value text not null,
  raw_label text,
  normalized_value text, normalized_group text,
  ordinal_rank numeric, interaction_flags text[] not null default '{}',
  version integer not null default 1,
  status text not null default 'active',
  valid_from timestamptz not null default now(), valid_to timestamptz
);
create table unmapped_domain_values (
  id text primary key,
  domain_key text not null,
  raw_value text not null,
  first_seen_batch text references import_batches(id),
  occurrence_count integer not null default 1,
  status text not null default 'pending',
  unique (domain_key, raw_value)
);
create table entity_merges (
  id text primary key,
  entity_type text not null,
  winner_id text not null, loser_id text not null,
  evidence jsonb not null,
  merged_at timestamptz not null default now(),
  unmerged_at timestamptz
);
