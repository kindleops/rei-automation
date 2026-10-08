-- PROPOSED (P1, 2026-10-08) — NOT APPLIED. Owner approval required.
--
-- public.unlock_stale_jobs(stale_minutes) set queue_status='queued' on ANY
-- stale locked send_queue row, with no status predicate (nurture-reconcile
-- REPORT §E). No caller in the repo, no cron, service_role only — a latent
-- release path for held / cancelled / blocked / suppressed rows.
--
-- New contract:
--   * only rows in queue_status 'processing' whose lock is actually stale;
--   * never a row with any send evidence (sent_at, provider_message_id,
--     textgrid_message_id, metadata.provider_request_started_at): lease
--     expiry does not prove the provider never got the request, and
--     re-queueing such a row can send a seller a second SMS;
--   * never held / cancelled / blocked* / suppressed / paused* / expired /
--     terminal rows (excluded by the status predicate itself);
--   * never a row carrying metadata.dispatch_hold.
-- Same signature, return type and grants (service_role only).
create or replace function public.unlock_stale_jobs(stale_minutes integer default 10)
returns integer
language plpgsql
as $function$
declare
  unlocked_count int;
begin
  update public.send_queue
     set is_locked = false,
         locked_at = null,
         lock_token = null,
         queue_status = 'queued',
         updated_at = now()
   where is_locked = true
     and queue_status = 'processing'
     and locked_at < now() - (stale_minutes || ' minutes')::interval
     and sent_at is null
     and nullif(trim(coalesce(provider_message_id, '')), '') is null
     and nullif(trim(coalesce(textgrid_message_id, '')), '') is null
     and (metadata is null or (
           not (metadata ? 'provider_request_started_at')
       and not (metadata ? 'dispatch_hold')
     ));
  get diagnostics unlocked_count = row_count;
  return unlocked_count;
end;
$function$;

revoke all on function public.unlock_stale_jobs(integer) from public, anon, authenticated;
grant execute on function public.unlock_stale_jobs(integer) to service_role;
