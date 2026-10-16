-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- LeadCommand 8.5.20-b — NATIONWIDE ZIP ACQUISITION INTELLIGENCE + LEARNING LOOP
-- (owner directive 2026-10-15, Phase 5).
--
-- APPLY IN ONE TRANSACTION (no BEGIN/COMMIT here; the runner / psql wraps it):
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261016100000_zip_acquisition_intelligence.sql
-- Tested ONLY on a disposable PostgreSQL:
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id zip_acquisition_intelligence
--
-- WHAT IT CREATES (no existing table is altered; nothing reads these to send or price):
--   public.zip_acquisition_economics  cash-acquisition economics per ZIP × property type ×
--                                     condition band × value band × model version: sample
--                                     size, liquidity, investor share, cash share, investor
--                                     discount vs retail (+ p25/p75 band), typical exit,
--                                     confidence, window, last update. HIERARCHICAL PRIORS are
--                                     LABELLED (prior_level / prior_label / prior_geo /
--                                     own_weight). mao_precision 'local' is refused by CHECK
--                                     unless the ZIP's OWN evidence clears the bar (≥ 20
--                                     investor and ≥ 20 retail sales, confidence ≥ 0.6) — no
--                                     precise local MAO without evidence.
--   public.zip_model_build_state      the builder's per-market watermark (incremental runs).
--   public.zip_model_versions         model versions: sample size, validated outcomes,
--                                     confidence, prediction error (measured before update).
--                                     'active' requires a named approver.
--   public.acquisition_outcomes       the LEARNING LOOP: asking price, recommended / opening
--                                     offer, counters, final price, condition, buyer demand,
--                                     actual economics, closing outcome, time to close,
--                                     failure reasons. A 'validated' row needs a validator, a
--                                     closing-grade source and a trusted origin (CHECK), and is
--                                     immutable once validated (trigger).
--   public.acquisition_outcomes_training  view: ONLY validated, non-pending outcomes — the one
--                                     relation a model update may read.
-- RLS enabled + forced, NO policies ⇒ backend (service_role) only.
-- The builder job (zip-builder.js) is OFF unless ZIP_INTEL_BUILDER_ENABLED=1.
-- ════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table public.zip_acquisition_economics (
  model_version                     text not null check (model_version ~ '^[a-z0-9_.@-]{1,60}$'),
  zip5                              text not null check (zip5 ~ '^[0-9]{5}$'),
  property_type                     text not null check (property_type in ('sfr', 'mf_2_4', 'mf_5_plus', 'land_vacant_residential', 'land_development', 'commercial')),
  condition_band                    text not null check (condition_band in ('all', 'light', 'moderate', 'heavy', 'unknown')),
  value_band                        text not null check (value_band in ('all', 'lt_100k', '100k_200k', '200k_350k', '350k_600k', '600k_plus')),
  sample_size                       integer not null check (sample_size >= 0),
  investor_n                        integer not null check (investor_n >= 0),
  retail_n                          integer not null check (retail_n >= 0),
  unclassified_n                    integer not null check (unclassified_n >= 0),
  investor_ratio_n                  integer not null check (investor_ratio_n >= 0),
  retail_ratio_n                    integer not null check (retail_ratio_n >= 0),
  sales_per_month                   numeric(10,3) check (sales_per_month is null or sales_per_month >= 0),
  investor_share                    numeric(5,3) check (investor_share is null or investor_share between 0 and 1),
  cash_share                        numeric(5,3) check (cash_share is null or cash_share between 0 and 1),
  investor_discount_vs_retail       numeric(6,3) check (investor_discount_vs_retail is null or investor_discount_vs_retail between -1 and 1),
  investor_discount_vs_retail_own   numeric(6,3) check (investor_discount_vs_retail_own is null or investor_discount_vs_retail_own between -1 and 1),
  discount_p25                      numeric(6,3) check (discount_p25 is null or discount_p25 between -2 and 1),
  discount_p75                      numeric(6,3) check (discount_p75 is null or discount_p75 between -2 and 1),
  typical_exit                      text not null check (typical_exit in ('investor_cash_resale', 'investor_rental_hold', 'retail_resale', 'unknown')),
  top_investor_archetype            text check (top_investor_archetype is null or top_investor_archetype ~ '^[a-z0-9_]{1,60}$'),
  confidence                        numeric(4,3) not null check (confidence between 0 and 1),
  window_start                      date,
  window_end                        date,
  prior_level                       text not null check (prior_level in ('zip', 'county', 'metro', 'state', 'none')),
  prior_label                       text not null check (prior_label ~ '^(own_evidence_only|no_evidence_at_any_level|(shrunk_toward|prior_only):(county|metro|state))$'),
  prior_geo                         text check (prior_geo is null or length(prior_geo) <= 80),
  own_weight                        numeric(4,3) not null check (own_weight between 0 and 1),
  mao_precision                     text not null check (mao_precision in ('none', 'indicative_band', 'local')),
  build_scope                       text not null check (length(build_scope) between 1 and 80),
  validated_outcomes_n              integer not null default 0 check (validated_outcomes_n >= 0),
  last_update                       timestamptz not null,
  primary key (model_version, zip5, property_type, condition_band, value_band),
  -- a prior is never silent: the label names the level, a parent level names its geography
  constraint zip_econ_prior_labelled check (
        (prior_level = 'zip'  and prior_label = 'own_evidence_only' and own_weight = 1 and prior_geo is null)
     or (prior_level = 'none' and prior_label = 'no_evidence_at_any_level')
     or (prior_level in ('county', 'metro', 'state') and prior_label like '%:' || prior_level and prior_geo like prior_level || ':%' and own_weight < 1)),
  -- no precise local MAO guidance without the ZIP's own evidence
  constraint zip_econ_local_needs_evidence check (
        mao_precision <> 'local'
     or (prior_level = 'zip' and investor_n >= 20 and retail_n >= 20 and confidence >= 0.6)),
  constraint zip_econ_no_estimate_no_guidance check (investor_discount_vs_retail is not null or mao_precision = 'none'),
  constraint zip_econ_band_ordered check (discount_p25 is null or discount_p75 is null or discount_p25 <= discount_p75),
  constraint zip_econ_window_ordered check (window_start is null or window_end is null or window_start <= window_end)
);
create index zip_econ_lookup_idx on public.zip_acquisition_economics (zip5, property_type, condition_band, value_band, model_version);
create index zip_econ_scope_idx on public.zip_acquisition_economics (build_scope, model_version);
comment on table public.zip_acquisition_economics is 'Cash-acquisition economics per ZIP × property type × condition band × value band (8.5.20-b). Evidence from recorded sales only; priors labelled; never an offer — the Decision Engine MAO stays the authority.';

create table public.zip_model_build_state (
  market         text primary key check (market ~ '^[a-z0-9_-]{1,80}$'),
  generation     text check (generation is null or length(generation) <= 80),
  model_version  text not null check (length(model_version) between 1 and 60),
  built_at       timestamptz not null,
  rows           integer not null check (rows >= 0),
  cells          integer not null check (cells >= 0),
  updated_at     timestamptz not null default now()
);
comment on table public.zip_model_build_state is 'ZIP model builder watermark per market (8.5.20-b): a market is rebuilt only when its source generation changes.';

create table public.zip_model_versions (
  model_version          text primary key check (model_version ~ '^[a-z0-9_.@-]{1,60}$'),
  parent_version         text references public.zip_model_versions (model_version),
  built_at               timestamptz not null,
  sample_size            integer not null check (sample_size >= 0),
  validated_outcomes_n   integer not null check (validated_outcomes_n >= 0),
  confidence             numeric(5,4) not null check (confidence between 0 and 1),
  prediction_error       jsonb not null check (jsonb_typeof(prediction_error) = 'object' and prediction_error ? 'measured_on' and octet_length(prediction_error::text) <= 2000),
  refused_outcomes       jsonb not null default '{}'::jsonb check (jsonb_typeof(refused_outcomes) = 'object'),
  rules                  jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object'),
  status                 text not null default 'shadow' check (status in ('shadow', 'candidate', 'active', 'retired')),
  approved_by            text check (approved_by is null or length(approved_by) between 1 and 80),
  constraint zip_model_versions_active_approved check (status <> 'active' or approved_by is not null)
);
comment on table public.zip_model_versions is 'ZIP / learning model versions (8.5.20-b): sample size, validated outcomes, confidence and prediction error measured on validated outcomes BEFORE the update. Active only with a named approver.';

create table public.acquisition_outcomes (
  outcome_id               uuid primary key default gen_random_uuid(),
  opportunity_id           text check (opportunity_id is null or length(opportunity_id) between 1 and 80),
  property_id              text check (property_id is null or length(property_id) between 1 and 80),
  zip5                     text check (zip5 is null or zip5 ~ '^[0-9]{5}$'),
  property_type            text check (property_type is null or property_type in ('sfr', 'mf_2_4', 'mf_5_plus', 'land_vacant_residential', 'land_development', 'commercial')),
  condition_band           text not null default 'all' check (condition_band in ('all', 'light', 'moderate', 'heavy', 'unknown')),
  value_band               text not null default 'all' check (value_band in ('all', 'lt_100k', '100k_200k', '200k_350k', '350k_600k', '600k_plus')),
  asking_price             numeric(14,2) check (asking_price is null or asking_price > 0),
  recommended_offer        numeric(14,2) check (recommended_offer is null or recommended_offer > 0),
  opening_offer            numeric(14,2) check (opening_offer is null or opening_offer > 0),
  counters                 jsonb not null default '[]'::jsonb check (jsonb_typeof(counters) = 'array' and octet_length(counters::text) <= 4000),
  final_price              numeric(14,2) check (final_price is null or final_price > 0),
  retail_reference_value   numeric(14,2) check (retail_reference_value is null or retail_reference_value > 0),
  buyer_demand             text check (buyer_demand is null or buyer_demand in ('strong', 'moderate', 'weak', 'unknown')),
  actual_economics         jsonb not null default '{}'::jsonb check (jsonb_typeof(actual_economics) = 'object' and octet_length(actual_economics::text) <= 4000),
  closing_outcome          text not null check (closing_outcome in ('closed_assigned', 'closed_purchased', 'cancelled_by_seller', 'cancelled_by_us', 'lost_to_competitor', 'no_contract', 'pending')),
  time_to_close_days       integer check (time_to_close_days is null or time_to_close_days between 0 and 3650),
  failure_reasons          text[] not null default '{}' check (array_position(failure_reasons, null) is null and cardinality(failure_reasons) <= 20),
  origin                   text not null check (origin in ('closing_desk', 'operator', 'import', 'seller_chat', 'model_extracted', 'operator_note_unverified', 'web')),
  validation_status        text not null default 'unverified' check (validation_status in ('unverified', 'validated', 'rejected')),
  validation_source        text check (validation_source is null or validation_source in ('closing_case', 'settlement_statement', 'recorded_deed', 'title_company_confirmation')),
  validated_by             text check (validated_by is null or length(validated_by) between 1 and 80),
  validated_at             timestamptz,
  model_version_at_offer   text check (model_version_at_offer is null or length(model_version_at_offer) <= 60),
  idempotency_key          text not null unique check (length(idempotency_key) between 8 and 200),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint acquisition_outcomes_linked check (opportunity_id is not null or property_id is not null),
  -- ONLY a closing-grade, operator-validated, trusted-origin row is 'validated'
  constraint acquisition_outcomes_validated_is_closing_grade check (
        validation_status <> 'validated'
     or (validated_by is not null and validated_at is not null and validation_source is not null
         and origin in ('closing_desk', 'operator', 'import')
         and (closing_outcome not in ('closed_assigned', 'closed_purchased') or final_price is not null))),
  constraint acquisition_outcomes_reason_codes check (
        coalesce(array_to_string(failure_reasons, ','), '') ~ '^([a-z0-9_:.-]{1,60}(,[a-z0-9_:.-]{1,60})*)?$')
);
create index acquisition_outcomes_zip_idx on public.acquisition_outcomes (zip5, property_type, validation_status);
create index acquisition_outcomes_opp_idx on public.acquisition_outcomes (opportunity_id) where opportunity_id is not null;
comment on table public.acquisition_outcomes is 'Learning loop (8.5.20-b): per-deal outcomes. Only validated (closing-grade source, named validator, trusted origin) rows train a model — see acquisition_outcomes_training. Chat claims are recorded, never trained on.';

create or replace function public.acquisition_outcomes_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    if old.validation_status = 'validated' then
      raise exception 'acquisition_outcomes: a validated outcome is immutable (DELETE refused)' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.validation_status = 'validated' then
    raise exception 'acquisition_outcomes: a validated outcome is immutable (UPDATE refused)' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger acquisition_outcomes_guard before update or delete on public.acquisition_outcomes
  for each row execute function public.acquisition_outcomes_guard();

create view public.acquisition_outcomes_training
with (security_invoker = true) as
  select outcome_id, opportunity_id, property_id, zip5, property_type, condition_band, value_band,
         asking_price, recommended_offer, opening_offer, counters, final_price, retail_reference_value,
         buyer_demand, actual_economics, closing_outcome, time_to_close_days, failure_reasons,
         validation_source, validated_at, model_version_at_offer
    from public.acquisition_outcomes
   where validation_status = 'validated'
     and closing_outcome <> 'pending';
comment on view public.acquisition_outcomes_training is 'The ONLY relation a model update may read (8.5.20-b): validated, closing-grade, non-pending outcomes.';

alter table public.zip_acquisition_economics enable row level security;
alter table public.zip_acquisition_economics force row level security;
alter table public.zip_model_build_state enable row level security;
alter table public.zip_model_build_state force row level security;
alter table public.zip_model_versions enable row level security;
alter table public.zip_model_versions force row level security;
alter table public.acquisition_outcomes enable row level security;
alter table public.acquisition_outcomes force row level security;
revoke all on public.zip_acquisition_economics, public.zip_model_build_state, public.zip_model_versions, public.acquisition_outcomes, public.acquisition_outcomes_training
  from public, anon, authenticated, service_role;
grant select, insert, delete on public.zip_acquisition_economics to service_role;
grant select, insert, update on public.zip_model_build_state to service_role;
grant select, insert, update on public.zip_model_versions to service_role;
grant select, insert, update on public.acquisition_outcomes to service_role;
grant select on public.acquisition_outcomes_training to service_role;
revoke all on function public.acquisition_outcomes_guard() from public, anon, authenticated;
