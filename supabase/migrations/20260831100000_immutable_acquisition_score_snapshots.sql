-- ─── Immutable ADE snapshot lineage ─────────────────────────────────────────
--
-- WHY (proven defect, 2026-08-31): persistAcquisitionScore() upserts
-- public.property_acquisition_scores with onConflict:'property_id', so there is
-- exactly ONE mutable row per property and every ADE run rewrites it in place.
-- Row 51f6cd21-0b94-4925-a3a1-e51665a6b5c4 held recommended_cash_offer
-- $10,969,000 on 2026-08-03 and $5,479,900 on 2026-08-31 -- same id, different
-- money. seller_offers.ade_snapshot_id is bound to that id
-- (negotiation-state.js: `ade_snapshot_id || ade_snapshot.id`), so a sent or
-- accepted monetary offer could silently have its own provenance rewritten by
-- tomorrow's scoring run.
--
-- An accepted or sent monetary offer must bind to evidence that cannot change.
-- property_acquisition_scores REMAINS the convenient latest-state projection and
-- is deliberately not dropped or altered.

create table if not exists public.acquisition_score_snapshots (
  snapshot_id                   uuid primary key default gen_random_uuid(),
  property_id                   text        not null,
  computed_at                   timestamptz not null,

  -- engine / policy provenance
  engine_name                   text,
  engine_version                text,
  policy_version                text,

  -- subject inputs and anchors actually used
  subject_inputs                jsonb,

  -- comp lineage
  raw_candidate_count           integer,
  eligible_comp_count           integer,
  selected_comp_count           integer,
  rejected_comp_count           integer,
  outlier_method                text,
  selected_comps                jsonb,
  rejected_comps                jsonb,

  -- valuation result
  valuation_low                 numeric,
  valuation_mid                 numeric,
  valuation_high                numeric,
  valuation_confidence          numeric,
  comp_count                    integer,

  -- authority verdicts
  decision_tier                 text,
  confidence                    numeric,
  buyer_ceiling_authoritative   boolean,
  buyer_ceiling_reasons         jsonb,
  buyer_ceiling_sample          jsonb,

  -- monetary ceiling lineage
  valuation_based_ceiling       numeric,
  behavior_based_ceiling        numeric,
  effective_authorized_ceiling  numeric,
  recommended_cash_offer        numeric,
  minimum_acceptable_offer      numeric,

  -- full evidence payload for audit
  evidence                      jsonb,

  -- the mutable projection row this run also wrote (provenance only)
  projection_score_id           uuid,

  created_at                    timestamptz not null default now()
);

create index if not exists acquisition_score_snapshots_property_computed_idx
  on public.acquisition_score_snapshots (property_id, computed_at desc);

-- ── APPEND-ONLY ENFORCEMENT ────────────────────────────────────────────────
-- Immutability is enforced in the database, not by convention, so no future
-- code path (or manual session) can rewrite monetary provenance.

create or replace function public.acquisition_score_snapshots_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception
    'acquisition_score_snapshots is append-only: % on snapshot_id % is not permitted',
    tg_op, coalesce(old.snapshot_id::text, '(unknown)')
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists acquisition_score_snapshots_no_update on public.acquisition_score_snapshots;
create trigger acquisition_score_snapshots_no_update
  before update on public.acquisition_score_snapshots
  for each row execute function public.acquisition_score_snapshots_immutable();

drop trigger if exists acquisition_score_snapshots_no_delete on public.acquisition_score_snapshots;
create trigger acquisition_score_snapshots_no_delete
  before delete on public.acquisition_score_snapshots
  for each row execute function public.acquisition_score_snapshots_immutable();

comment on table public.acquisition_score_snapshots is
  'Append-only ADE run lineage. Enforced immutable by trigger. seller_offers.ade_snapshot_id binds here, NOT to the mutable property_acquisition_scores projection.';
