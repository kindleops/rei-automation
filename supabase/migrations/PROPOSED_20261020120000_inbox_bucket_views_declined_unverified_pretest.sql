-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261020120000_inbox_bucket_views_declined_unverified.sql.
-- Read-only (BEGIN … ROLLBACK). DISPOSABLE DATABASE ONLY. The production state: the 10-10 view body.
\set ON_ERROR_STOP on
begin;
do $$
declare r_dead boolean; r_closed boolean; r_resolved boolean; n int;
begin
  select count(*) into n from information_schema.columns where table_schema = 'public' and table_name = 'v_inbox_thread_state_buckets';
  assert n = 140, format('pretest: the buckets view has 140 columns (got %s)', n);
  assert position('declined_unverified' in pg_get_viewdef('public.v_inbox_thread_state_buckets'::regclass)) = 0, 'pretest: not applied yet (10-10 body)';
  insert into public.inbox_thread_state (thread_key, disposition, latest_direction, last_intent, is_archived, is_suppressed)
  values ('+15550001017', 'declined_unverified', 'inbound', 'ownership_declined_unverified', false, false);
  select in_dead, f_closed_disposition, f_reply_resolved into r_dead, r_closed, r_resolved
    from public.v_inbox_thread_state_buckets where thread_key = '+15550001017';
  assert r_dead is not true and r_closed is not true and r_resolved is not true, 'pretest: the 10-10 body leaves declined_unverified open';
end $$;
rollback;
