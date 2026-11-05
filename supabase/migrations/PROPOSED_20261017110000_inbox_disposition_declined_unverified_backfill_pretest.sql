-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST: not applied; the cohort is the 2 synthetic declined threads of the seed. DISPOSABLE DATABASE ONLY.
do $$ begin
  assert to_regclass('public.disposition_backfill_20261017') is null, 'pretest: not applied';
  assert (select count(*) from public.inbox_thread_state where disposition = 'declined_unverified') = 0, 'pretest: no declined_unverified yet';
end $$;
