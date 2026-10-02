-- =============================================================================
-- New Replies view rollback test - run AFTER
--   supabase/rollbacks/20261001160000_new_replies_genuine_engagement_ROLLBACK.sql
-- (or, to rehearse: apply the migration, then the rollback, then this file).
--
-- Read-only checks inside one transaction that ends in ROLLBACK. Every check
-- RAISEs on failure; the script prints NOTICE 'PASS ...' and 'ALL PASS'.
-- =============================================================================

begin;
set local statement_timeout = '60s';

do $$
declare
  n_cols int;
  tail text;
  diffs bigint;
  nr bigint;
  counts_nr bigint;
begin
  -- Shape: the pre-7.2 125 columns plus the four inert 7.2 stubs, in order.
  select count(*) into n_cols from information_schema.columns
   where table_schema = 'public' and table_name = 'v_inbox_thread_state_buckets';
  if n_cols <> 129 then raise exception 'FAIL: expected 129 columns, found %', n_cols; end if;
  select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) into tail
    from information_schema.columns
   where table_schema = 'public' and table_name = 'v_inbox_thread_state_buckets' and ordinal_position > 125;
  if tail <> 'f_last_intent:text,f_reply_resolved:boolean,f_nonengagement_latest:boolean,f_closed_disposition:boolean' then
    raise exception 'FAIL: stub columns are %', tail;
  end if;
  raise notice 'PASS shape (129 columns, 4 stubs last)';

  -- The stubs are inert.
  if exists (select 1 from public.v_inbox_thread_state_buckets
              where f_reply_resolved or f_nonengagement_latest or f_closed_disposition or f_last_intent <> '') then
    raise exception 'FAIL: a 7.2 stub column carries a value';
  end if;
  raise notice 'PASS stubs inert';

  -- in_new_replies is the pre-7.2 predicate again, on every row.
  select count(*) into diffs from public.v_inbox_thread_state_buckets
   where in_new_replies is distinct from (
         f_actionable
     and (f_bucket <> all (array['priority','needs_review','waiting','cold','follow_up']))
     and not f_needs_review
     and f_direction = 'inbound'
     and coalesce(last_inbound_at, latest_message_at) is not null
     and (last_outbound_at is null or coalesce(last_inbound_at, latest_message_at) >= last_outbound_at));
  if diffs <> 0 then raise exception 'FAIL: % rows differ from the pre-7.2 New Replies predicate', diffs; end if;
  -- ... and in_dead / f_terminal no longer read sold / unqualified.
  select count(*) into diffs from public.v_inbox_thread_state_buckets
   where in_dead is distinct from (not f_archived and (f_bucket = 'dead' or f_wrong_number_contact))
      or f_terminal is distinct from ((f_bucket = any (array['dead','suppressed'])) or f_wrong_number_contact or f_suppressed_contact);
  if diffs <> 0 then raise exception 'FAIL: % rows differ on in_dead / f_terminal', diffs; end if;
  raise notice 'PASS pre-7.2 predicates restored';

  -- The dependants still read it: Command Rail / Inbox parity.
  select count(*) into nr from public.v_inbox_thread_state_buckets where in_new_replies;
  select new_replies into counts_nr from public.v_inbox_bucket_counts limit 1;
  if nr is distinct from counts_nr then raise exception 'FAIL: view % vs v_inbox_bucket_counts %', nr, counts_nr; end if;
  perform 1 from public.v_inbox_zero_counts limit 1;
  raise notice 'PASS dependants (v_inbox_bucket_counts parity %, v_inbox_zero_counts readable)', nr;

  raise notice 'ALL PASS';
end $$;

rollback;
