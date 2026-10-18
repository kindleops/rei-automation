-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST: every disposition is back exactly; the backup is gone. Read-only.
do $$ begin
  assert to_regclass('public.disposition_backfill_20261017') is null, 'rb: backup dropped';
  assert not exists (select 1 from public.inbox_thread_state s join public.lc_mt_dispo_before b on b.id = s.id where s.disposition is distinct from b.disposition), 'rb: dispositions restored exactly';
  assert (select md5(string_agg(md5((to_jsonb(s) - 'disposition' - 'updated_at')::text), ',' order by s.id)) from public.inbox_thread_state s)
       = (select thread_inputs_md5 from public.lc_mt_dispo_snapshot), 'rb: thread inputs unchanged';
end $$;
