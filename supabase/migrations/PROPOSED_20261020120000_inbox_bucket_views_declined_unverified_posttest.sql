-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261020120000_inbox_bucket_views_declined_unverified.sql.
-- Inside BEGIN … ROLLBACK. DISPOSABLE DATABASE ONLY.
\set ON_ERROR_STOP on
begin;
do $$
declare r_dead boolean; r_closed boolean; r_resolved boolean; n int; c int;
begin
  select count(*) into n from information_schema.columns where table_schema = 'public' and table_name = 'v_inbox_thread_state_buckets';
  assert n = 140, format('the column list is unchanged (140, got %s)', n);
  select count(*) into c from information_schema.columns where table_schema = 'public' and table_name = 'v_inbox_bucket_counts';
  assert c = 21, format('the counts view keeps its 21 columns (got %s)', c);
  insert into public.inbox_thread_state (thread_key, disposition, latest_direction, last_intent, is_archived, is_suppressed)
  values ('+15550001017', 'declined_unverified', 'inbound', 'ownership_declined_unverified', false, false);
  select in_dead, f_closed_disposition, f_reply_resolved into r_dead, r_closed, r_resolved
    from public.v_inbox_thread_state_buckets where thread_key = '+15550001017';
  assert r_dead and r_closed and r_resolved, 'declined_unverified closes the thread (dead), never an open reply';
  -- not_interested still the follow-up lane, sold still dead
  insert into public.inbox_thread_state (thread_key, disposition, latest_direction, is_archived, is_suppressed) values ('+15550001018', 'not_interested', 'inbound', false, false), ('+15550001019', 'sold', 'inbound', false, false);
  assert (select in_dead from public.v_inbox_thread_state_buckets where thread_key = '+15550001018') is not true, 'not_interested is never dead';
  assert (select in_dead from public.v_inbox_thread_state_buckets where thread_key = '+15550001019'), 'sold stays dead';
  assert (select dead from public.v_inbox_bucket_counts) >= 2, 'the counts view reads the new mapping';
  raise notice 'posttest(inbox_bucket_views_declined_unverified): ALL OK (rolled back)';
end $$;
rollback;
