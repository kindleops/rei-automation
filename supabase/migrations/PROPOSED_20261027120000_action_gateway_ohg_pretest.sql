-- PRETEST for PROPOSED_20261027120000_action_gateway_ohg.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It is read-only and ends in ROLLBACK. The runner proves it leaves no trace.
-- Asserts the prerequisites the apply relies on:
--   * links #26, #27 (the extension registry) and #28 (the receipts + the ONE executor kind handoff) are applied and
--     this link is not;
--   * the LeadCommand tables the domain write and the reads join exist with the columns they read;
--   * the hold registry read and the runtime enqueue the handoff calls exist.
begin;
do $$
declare t text; problems text[] := '{}';
begin
  if to_regnamespace('action_gateway') is null or to_regprocedure('action_gateway.dw_begin(uuid,uuid,text[])') is null then problems := problems || 'link #26 (action_gateway) is not applied'::text; end if;
  if to_regclass('action_gateway.extensions') is null or to_regprocedure('action_gateway.standing_t2_actions()') is null then problems := problems || 'link #27 (action_gateway_t2: the extension registry) is not applied'::text; end if;
  if to_regclass('action_gateway.seller_action_receipts') is null or to_regprocedure('public.lc_seller_action_load(uuid)') is null then problems := problems || 'link #28 (action_gateway_t34: receipts) is not applied'::text; end if;
  if to_regclass('action_gateway.lead_annotations') is not null or to_regclass('action_gateway.ohg_restore') is not null then problems := problems || 'this link is already applied'::text; end if;
  foreach t in array array['public.inbox_thread_state', 'public.message_events', 'public.send_queue', 'public.automation_holds', 'agent.org', 'agent.runtime_limits'] loop
    if to_regclass(t) is null then problems := problems || ('missing ' || t); end if;
  end loop;
  foreach t in array array['queue_status', 'scheduled_for', 'sent_at', 'delivered_at', 'failed_reason', 'provider_message_id'] loop
    if to_regclass('public.send_queue') is not null and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'send_queue' and column_name = t) then
      problems := problems || ('missing column public.send_queue.' || t);
    end if;
  end loop;
  foreach t in array array['id', 'thread_key', 'direction', 'message_body'] loop
    if to_regclass('public.message_events') is not null and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'message_events' and column_name = t) then
      problems := problems || ('missing column public.message_events.' || t);
    end if;
  end loop;
  if to_regprocedure('public.automation_hold_for(text,uuid,text,uuid,text,text)') is null then problems := problems || 'missing public.automation_hold_for'::text; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'agent' and p.proname = 'runtime_enqueue') then problems := problems || 'missing agent.runtime_enqueue'::text; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'action_gateway.seller_action_receipts'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''queue_authorized_reply''%') then
    problems := problems || 'the receipts action CHECK is not where link #28 put it'::text;
  end if;
  if array_length(problems, 1) > 0 then raise exception 'pretest: %', array_to_string(problems, '; '); end if;
  raise notice 'pretest: prerequisites present (#26, #27, #28, LeadCommand tables, the hold read, the runtime enqueue)';
end $$;
rollback;
