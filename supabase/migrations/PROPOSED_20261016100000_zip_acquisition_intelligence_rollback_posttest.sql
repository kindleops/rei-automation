-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261016100000_zip_acquisition_intelligence_rollback.sql.
-- DISPOSABLE DATABASE ONLY. Read-only.
\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public.zip_acquisition_economics') is not null or to_regclass('public.zip_model_build_state') is not null
     or to_regclass('public.zip_model_versions') is not null or to_regclass('public.acquisition_outcomes') is not null
     or to_regclass('public.acquisition_outcomes_training') is not null
     or to_regprocedure('public.acquisition_outcomes_guard()') is not null then
    raise exception 'rollback posttest(zip_acquisition_intelligence): an object survived the rollback';
  end if;
  raise notice 'rollback posttest(zip_acquisition_intelligence): clean';
end
$$;
