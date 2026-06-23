-- =============================================================================
-- Acquisition Engine V3 — Item 5C: canonical income intelligence schema
-- GENERATED ARTIFACT — DO NOT APPLY IN THIS PASS.
--
-- This file lives under migrations/planned/ and is intentionally OUTSIDE the
-- `supabase db push` apply path (which reads only top-level migrations/*.sql).
-- It is additive-only and does NOT alter existing migration history. Promote it
-- to a real, timestamped top-level migration in a later, explicitly-approved
-- pass after migration-history reconciliation.
--
-- Design: a normalized header + child field-provenance records + source-record
-- lineage + conflict log (avoids a giant flat table). The fully-resolved
-- canonical snapshot is also stored as JSONB for fast read, while every scalar's
-- provenance is queryable via property_income_snapshot_fields.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Snapshot header (one row per property + as_of + source_version)
-- ---------------------------------------------------------------------------
create table if not exists public.property_income_snapshots (
  snapshot_id        uuid primary key default gen_random_uuid(),
  property_id        text not null,
  canonical_asset_lane text,
  as_of              timestamptz not null default now(),
  source_version     text not null,
  engine_version     text not null,
  snapshot_version   integer not null default 1,
  -- Fully-resolved, provenance-bearing snapshot (the engine contract shape).
  snapshot_json      jsonb not null,
  -- De-normalized, indexed performance scalars (nullable = UNKNOWN, never 0).
  occupancy_rate         numeric,
  actual_noi             numeric,
  stabilized_noi         numeric,
  implied_cap_rate       numeric,
  loan_balance           numeric,
  -- Completeness + conflict summary.
  completeness_json      jsonb not null default '{}'::jsonb,
  has_material_conflict  boolean not null default false,
  -- Lifecycle: shadow snapshots never authorize anything by themselves.
  is_shadow              boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Idempotency: one current snapshot per property/as_of/source_version.
  constraint property_income_snapshots_idem unique (property_id, as_of, source_version)
);

create index if not exists idx_pis_property on public.property_income_snapshots (property_id);
create index if not exists idx_pis_lane on public.property_income_snapshots (canonical_asset_lane);
create index if not exists idx_pis_asof on public.property_income_snapshots (as_of desc);
create index if not exists idx_pis_material_conflict on public.property_income_snapshots (has_material_conflict) where has_material_conflict;

-- ---------------------------------------------------------------------------
-- 2. Field-level provenance (one row per resolved scalar field)
-- ---------------------------------------------------------------------------
create table if not exists public.property_income_snapshot_fields (
  field_row_id     uuid primary key default gen_random_uuid(),
  snapshot_id      uuid not null references public.property_income_snapshots (snapshot_id) on delete cascade,
  field_name       text not null,
  value_numeric    numeric,
  value_text       text,
  basis            text not null,             -- EVIDENCE_BASIS enum value
  source           text,
  source_record_id text,
  observed_at      timestamptz,
  effective_date   timestamptz,
  confidence       integer not null default 0,
  extraction_method text,
  validation_status text not null default 'UNVALIDATED',
  conflict_status  text not null default 'NONE',
  created_at       timestamptz not null default now(),
  constraint pisf_unique_field unique (snapshot_id, field_name),
  constraint pisf_basis_chk check (basis in (
    'MANUAL_OVERRIDE','VERIFIED_DOCUMENT','ACTUAL','OWNER_REPORTED','LISTING_REPORTED',
    'PROVIDER_REPORTED','COMPARABLE_DERIVED','MARKET_MODELED','SYSTEM_INFERRED','UNKNOWN'
  )),
  constraint pisf_conflict_chk check (conflict_status in ('NONE','MINOR','MATERIAL'))
);

create index if not exists idx_pisf_snapshot on public.property_income_snapshot_fields (snapshot_id);
create index if not exists idx_pisf_field on public.property_income_snapshot_fields (field_name);
create index if not exists idx_pisf_conflict on public.property_income_snapshot_fields (conflict_status) where conflict_status <> 'NONE';

-- ---------------------------------------------------------------------------
-- 3. Source-record lineage (every raw record considered for a snapshot)
-- ---------------------------------------------------------------------------
create table if not exists public.property_income_source_records (
  source_row_id    uuid primary key default gen_random_uuid(),
  snapshot_id      uuid not null references public.property_income_snapshots (snapshot_id) on delete cascade,
  source_table     text not null,
  source_record_id text,
  basis            text not null,
  observed_at      timestamptz,
  payload          jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists idx_pisr_snapshot on public.property_income_source_records (snapshot_id);
create index if not exists idx_pisr_source on public.property_income_source_records (source_table, source_record_id);

-- ---------------------------------------------------------------------------
-- 4. Conflict log (one row per detected field conflict)
-- ---------------------------------------------------------------------------
create table if not exists public.property_income_conflicts (
  conflict_id      uuid primary key default gen_random_uuid(),
  snapshot_id      uuid not null references public.property_income_snapshots (snapshot_id) on delete cascade,
  field_name       text not null,
  severity         text not null,
  variance         numeric,
  selected_value   text,
  selected_basis   text,
  candidates       jsonb not null default '[]'::jsonb,
  reason           text,
  requires_review  boolean not null default false,
  resolved         boolean not null default false,
  created_at       timestamptz not null default now(),
  constraint pic_severity_chk check (severity in ('MINOR','MATERIAL'))
);

create index if not exists idx_pic_snapshot on public.property_income_conflicts (snapshot_id);
create index if not exists idx_pic_review on public.property_income_conflicts (requires_review) where requires_review;

-- ---------------------------------------------------------------------------
-- 5. Row-level security (service-role only; no anon access to financial data)
-- ---------------------------------------------------------------------------
alter table public.property_income_snapshots        enable row level security;
alter table public.property_income_snapshot_fields  enable row level security;
alter table public.property_income_source_records   enable row level security;
alter table public.property_income_conflicts         enable row level security;

-- Service role bypasses RLS; define explicit policies so authenticated readers
-- can be granted later without opening writes. Default: deny all to anon.
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'property_income_snapshots' and policyname = 'pis_service_all') then
    create policy pis_service_all on public.property_income_snapshots
      for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'property_income_snapshot_fields' and policyname = 'pisf_service_all') then
    create policy pisf_service_all on public.property_income_snapshot_fields
      for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'property_income_source_records' and policyname = 'pisr_service_all') then
    create policy pisr_service_all on public.property_income_source_records
      for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'property_income_conflicts' and policyname = 'pic_service_all') then
    create policy pic_service_all on public.property_income_conflicts
      for all to service_role using (true) with check (true);
  end if;
end $$;

-- updated_at touch trigger for the header table.
create or replace function public.tg_property_income_snapshots_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_pis_touch on public.property_income_snapshots;
create trigger trg_pis_touch before update on public.property_income_snapshots
  for each row execute function public.tg_property_income_snapshots_touch();

commit;
