-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST: DISPOSITION ONLY. Every eligibility input is byte-identical to the seed
-- snapshot (lc_mt_dispo_snapshot, taken by the seed fixture before apply) except disposition on the
-- cohort; the only derived difference is the cohort's bucket (follow_up → dead: the intended no-nurture
-- outcome). Read-only. DISPOSABLE DATABASE ONLY.
do $$ begin
  assert (select count(*) from public.disposition_backfill_20261017) = 2, 'exactly the 2 evidence-backed cohort threads';
  assert (select count(*) from public.inbox_thread_state where disposition = 'declined_unverified') = 2, 'cohort rewritten';
  -- eligibility inputs identical (everything but disposition / updated_at)
  assert (select md5(string_agg(md5((to_jsonb(s) - 'disposition' - 'updated_at')::text), ',' order by s.id)) from public.inbox_thread_state s)
       = (select thread_inputs_md5 from public.lc_mt_dispo_snapshot), 'thread eligibility inputs unchanged';
  assert (select md5(coalesce(string_agg(md5(to_jsonb(x)::text), ',' order by x.id), '')) from public.sms_suppression_list x) = (select suppression_md5 from public.lc_mt_dispo_snapshot), 'suppression unchanged';
  assert (select md5(coalesce(string_agg(md5(to_jsonb(x)::text), ',' order by x.id), '')) from public.contact_property_resolution x) = (select cpr_md5 from public.lc_mt_dispo_snapshot), 'contact_property_resolution unchanged';
  -- dispositions changed ONLY on the cohort, and only not_interested → declined_unverified
  assert not exists (select 1 from public.inbox_thread_state s join public.lc_mt_dispo_before b on b.id = s.id
                      where s.disposition is distinct from b.disposition
                        and not (b.disposition = 'not_interested' and s.disposition = 'declined_unverified' and b.cohort)), 'only cohort dispositions changed';
  -- the derived bucket (view CASE) changes ONLY cohort follow_up → dead
  assert not exists (select 1 from public.v_inbox_thread_state_buckets v join public.lc_mt_dispo_before b on b.id = v.id
                      where v.f_bucket is distinct from b.f_bucket and not (b.cohort and b.f_bucket = 'follow_up' and v.f_bucket = 'dead')), 'derived bucket changes only cohort follow_up → dead';
  assert (select count(*) from public.v_inbox_thread_state_buckets v join public.lc_mt_dispo_before b on b.id = v.id where b.cohort and v.f_bucket = 'dead') = 2, 'cohort now Dead (no nurture lane)';
end $$;
