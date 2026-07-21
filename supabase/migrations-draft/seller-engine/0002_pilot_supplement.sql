-- ============================================================================
-- SELLER ENGINE — pilot supplement (DRAFT — DO NOT APPLY TO PRODUCTION)
-- Phase 4 migration-validation finding: the staging mappers emit
-- property_valuation_tax_snapshots (one row per property per batch), but 0001
-- omitted the table. Valuation/tax state is batch-versioned evidence and must
-- not be flattened onto properties. Recorded in SELLER_PILOT_EXECUTION_REPORT.
-- ============================================================================
set search_path to seller_engine;

create table if not exists property_valuation_tax_snapshots (
  id text primary key,
  property_id text not null references properties(id),
  as_of timestamptz,                      -- scraped_at of the source row
  estimated_value numeric,
  estimated_equity numeric,
  equity_percent numeric,
  equity_percent_state text,              -- five-state (sentinel-cleaned)
  tax_amount numeric,
  tax_delinquent boolean,
  tax_delinquent_year integer,
  import_batch_id text references import_batches(id)
);
create index if not exists pvts_property_idx on property_valuation_tax_snapshots(property_id);

-- pilot-only load bookkeeping (kept in the seller_engine schema so the pilot
-- database is self-describing; harmless if never promoted)
create table if not exists pilot_load_rejects (
  id bigint generated always as identity primary key,
  target_table text not null,
  column_name text not null,
  reject_count integer not null,
  sample_values text[] not null default '{}',
  import_batch_id text not null references import_batches(id),
  recorded_at timestamptz not null default now()
);
