-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST: the production 10-10 view body is back (the runner also compares the
-- schema fingerprint). Inside BEGIN … ROLLBACK. DISPOSABLE DATABASE ONLY.
\set ON_ERROR_STOP on
begin;
do $$
declare r_dead boolean; r_closed boolean; r_resolved boolean;
begin
  assert position('declined_unverified' in pg_get_viewdef('public.v_inbox_thread_state_buckets'::regclass)) = 0, 'rb: the 10-10 body restored';
  insert into public.inbox_thread_state (thread_key, disposition, latest_direction, last_intent, is_archived, is_suppressed)
  values ('+15550001017', 'declined_unverified', 'inbound', 'ownership_declined_unverified', false, false);
  select in_dead, f_closed_disposition, f_reply_resolved into r_dead, r_closed, r_resolved
    from public.v_inbox_thread_state_buckets where thread_key = '+15550001017';
  assert r_dead is not true and r_closed is not true, 'rb: production behaviour restored';
end $$;
rollback;
