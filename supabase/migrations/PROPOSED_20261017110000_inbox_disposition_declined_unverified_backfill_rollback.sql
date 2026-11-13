-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261017110000_inbox_disposition_declined_unverified_backfill.sql.
-- Restores every backed-up disposition exactly, then drops the backup. REFUSES when a backed-up row was
-- re-dispositioned since (a later writer owns it now).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
declare n int;
begin
  if to_regclass('public.disposition_backfill_20261017') is null then raise exception 'rollback precondition: the backfill is not applied'; end if;
  select count(*) into n from public.disposition_backfill_20261017 b join public.inbox_thread_state s on s.id = b.thread_state_id
   where s.disposition is distinct from 'declined_unverified';
  if n > 0 then raise exception 'rollback precondition: % backfilled row(s) were re-dispositioned since; review them first', n; end if;
end $$;
update public.inbox_thread_state s set disposition = b.prior_disposition
  from public.disposition_backfill_20261017 b where b.thread_state_id = s.id;
drop table public.disposition_backfill_20261017;
commit;
