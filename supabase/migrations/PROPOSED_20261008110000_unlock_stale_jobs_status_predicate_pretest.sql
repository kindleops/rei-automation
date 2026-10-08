-- PRETEST for PROPOSED_20261008110000 (run inside a transaction that is
-- ROLLED BACK; touches only rows it inserts). Expect every assertion to pass.
begin;
\i supabase/migrations/PROPOSED_20261008110000_unlock_stale_jobs_status_predicate.sql
do $t$
declare n int; s text;
begin
  insert into public.send_queue (id, queue_key, queue_status, is_locked, locked_at, to_phone_number, message_body, metadata)
  values
    ('00000000-0000-4000-8000-0000000000a1', 'pretest:a1', 'processing', true, now() - interval '1 hour', '+15550000001', 'x', '{}'::jsonb),
    ('00000000-0000-4000-8000-0000000000a2', 'pretest:a2', 'held',       true, now() - interval '1 hour', '+15550000002', 'x', '{}'::jsonb),
    ('00000000-0000-4000-8000-0000000000a3', 'pretest:a3', 'cancelled',  true, now() - interval '1 hour', '+15550000003', 'x', '{}'::jsonb),
    ('00000000-0000-4000-8000-0000000000a4', 'pretest:a4', 'processing', true, now() - interval '1 hour', '+15550000004', 'x', '{"provider_request_started_at":"2026-10-08T00:00:00Z"}'::jsonb),
    ('00000000-0000-4000-8000-0000000000a5', 'pretest:a5', 'processing', true, now() - interval '1 minute', '+15550000005', 'x', '{}'::jsonb);
  perform public.unlock_stale_jobs(10);
  select queue_status into s from public.send_queue where id = '00000000-0000-4000-8000-0000000000a1'; if s <> 'queued' then raise exception 'a1 stale processing should re-queue, got %', s; end if;
  select queue_status into s from public.send_queue where id = '00000000-0000-4000-8000-0000000000a2'; if s <> 'held' then raise exception 'a2 held must stay held, got %', s; end if;
  select queue_status into s from public.send_queue where id = '00000000-0000-4000-8000-0000000000a3'; if s <> 'cancelled' then raise exception 'a3 cancelled must stay, got %', s; end if;
  select queue_status into s from public.send_queue where id = '00000000-0000-4000-8000-0000000000a4'; if s <> 'processing' then raise exception 'a4 provider-started must stay, got %', s; end if;
  select queue_status into s from public.send_queue where id = '00000000-0000-4000-8000-0000000000a5'; if s <> 'processing' then raise exception 'a5 fresh lock must stay, got %', s; end if;
  raise notice 'unlock_stale_jobs pretest: PASS';
end $t$;
rollback;
