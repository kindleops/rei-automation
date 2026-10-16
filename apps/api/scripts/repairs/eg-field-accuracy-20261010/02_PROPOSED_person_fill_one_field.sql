-- PROPOSED — NOT APPLIED (owner GO required). Fills ONE person field on public.prospects from seller.owner (same
-- individual_key) ONLY where the prospect's value is empty. Never overwrites a value. One field per run:
--   node ../../../../../scripts/lib/prod-db-credentials.mjs psql-write --prod-write=<approval-ref> -v field=gender -f 02_PROPOSED_person_fill_one_field.sql
--   (explicit production-write path: LC_PROD_WRITE_DB_URL_FILE + interactive TTY confirmation)
-- field ∈ language_preference, gender, marital_status, occupation_group, education_model, est_household_income,
--         net_asset_value, buying_power, mob (from seller.owner.month_of_birth, YYYYMM only)
-- Protected-class policy (owner + counsel 2026-10-01): these are DISPLAY / TARGETING attributes only — never pricing.
-- Note: trg on prospects (if any) bumps updated_at; incremental syncs on prospects.updated_at will reprocess these rows.
\set ON_ERROR_STOP on
begin;
set local statement_timeout = '60s';
set local lock_timeout = '3s';
select set_config('fill.field', :'field', true);
do $guard$
begin
  if current_setting('fill.field') not in ('language_preference','gender','marital_status','occupation_group','education_model',
                                            'est_household_income','net_asset_value','buying_power','mob') then
    raise exception 'unknown field %', current_setting('fill.field');
  end if;
end $guard$;

create temp table _fill on commit drop as
select p.prospect_id, p.individual_key,
       case :'field' when 'mob' then o.month_of_birth else btrim((to_jsonb(o) ->> :'field')) end as new_value,
       jsonb_build_object('import_batch_id', o.import_batch_id, 'provider_updated_at', o.provider_updated_at) as source_ref
  from public.prospects p
  join seller.owner o on o.individual_key = p.individual_key
 where nullif(btrim(to_jsonb(p) ->> :'field'), '') is null
   and case :'field' when 'mob' then o.month_of_birth ~ '^\d{6}$' else nullif(btrim(to_jsonb(o) ->> :'field'), '') is not null end;

insert into archive.prospects_person_fill_20261010 (prospect_id, individual_key, field, old_value, new_value, source_ref)
select prospect_id, individual_key, :'field', null, new_value, source_ref from _fill;

-- the column name is whitelisted above; format() keeps it an identifier
do $apply$
declare n int;
begin
  execute format('update public.prospects p set %I = f.new_value from _fill f where p.prospect_id = f.prospect_id and nullif(btrim(p.%I::text), '''') is null',
                 current_setting('fill.field'), current_setting('fill.field'));
  get diagnostics n = row_count;
  raise notice 'filled % rows of %', n, current_setting('fill.field');
end $apply$;
commit;
