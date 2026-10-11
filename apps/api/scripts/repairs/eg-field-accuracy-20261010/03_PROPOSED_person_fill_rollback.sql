-- PROPOSED rollback for 02: restores the empty value ONLY where the prospect still holds what the fill wrote.
--   psql "$DATABASE_URL" -v field=gender -f 03_PROPOSED_person_fill_rollback.sql
\set ON_ERROR_STOP on
begin;
set local statement_timeout = '60s';
set local lock_timeout = '3s';
select set_config('fill.field', :'field', true);
do $rb$
declare n int;
begin
  if current_setting('fill.field') not in ('language_preference','gender','marital_status','occupation_group','education_model',
                                            'est_household_income','net_asset_value','buying_power','mob') then
    raise exception 'unknown field %', current_setting('fill.field');
  end if;
  execute format('update public.prospects p set %I = l.old_value from archive.prospects_person_fill_20261010 l
                   where l.field = %L and l.rolled_back_at is null and p.prospect_id = l.prospect_id and p.%I::text = l.new_value',
                 current_setting('fill.field'), current_setting('fill.field'), current_setting('fill.field'));
  get diagnostics n = row_count;
  update archive.prospects_person_fill_20261010 set rolled_back_at = now() where field = current_setting('fill.field') and rolled_back_at is null;
  raise notice 'restored % rows of %', n, current_setting('fill.field');
end $rb$;
commit;
