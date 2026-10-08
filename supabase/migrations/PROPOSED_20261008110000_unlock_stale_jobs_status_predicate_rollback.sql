-- ROLLBACK for PROPOSED_20261008110000: restores the prod body captured
-- read-only from pg_get_functiondef on 2026-10-08 (no status predicate).
create or replace function public.unlock_stale_jobs(stale_minutes integer default 10)
returns integer
language plpgsql
as $function$
declare
  unlocked_count int;
begin
  update send_queue
     set is_locked = false,
         locked_at = null,
         lock_token = null,
         queue_status = 'queued',
         updated_at = now()
   where is_locked = true
     and locked_at < now() - (stale_minutes || ' minutes')::interval;
  get diagnostics unlocked_count = row_count;
  return unlocked_count;
end;
$function$;

revoke all on function public.unlock_stale_jobs(integer) from public, anon, authenticated;
grant execute on function public.unlock_stale_jobs(integer) to service_role;
