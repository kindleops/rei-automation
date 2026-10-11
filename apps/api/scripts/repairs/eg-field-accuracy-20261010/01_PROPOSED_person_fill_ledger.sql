-- PROPOSED — NOT APPLIED (owner GO required). Backup / provenance ledger for the person-field fill.
create schema if not exists archive;
create table if not exists archive.prospects_person_fill_20261010 (
  id            bigserial primary key,
  prospect_id   text not null,
  individual_key text not null,
  field         text not null,
  old_value     text,          -- the backup (always empty by construction: only empty values are filled)
  new_value     text not null,
  source        text not null default 'seller.owner',
  source_ref    jsonb not null default '{}'::jsonb,   -- seller.owner.import_batch_id / provider_updated_at
  applied_at    timestamptz not null default now(),
  rolled_back_at timestamptz
);
create index if not exists prospects_person_fill_20261010_pid on archive.prospects_person_fill_20261010 (prospect_id, field);
revoke all on archive.prospects_person_fill_20261010 from anon, authenticated;
