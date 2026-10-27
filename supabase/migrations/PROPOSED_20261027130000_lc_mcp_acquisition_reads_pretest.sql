-- PRETEST for PROPOSED_20261027130000_lc_mcp_acquisition_reads.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production. Read-only; ends in ROLLBACK.
-- Asserts the prerequisites the apply relies on:
--   * lc_mcp_reader and its self-check exist (PROPOSED_20261019150000_lc_mcp_reader.sql is applied);
--   * none of the five acquisition read functions exists yet;
--   * every column the functions read statically exists (inbox_thread_state, sms_suppression_list, phones,
--     acquisition_opportunities);
--   * (NOTICE only) the optional sources and the columns read when present: followup_intents, send_queue
--     (thread_key, created_at), seller_offers (thread_key, created_at), automation_events (conversation_thread_id,
--     created_at), automation_suppressions, contact_property_resolution, automation_hold_for, agent.ops_work_item,
--     action_gateway.seller_action_receipts.
begin;
do $$
declare
  need text[] := array[
    'inbox_thread_state.id','inbox_thread_state.thread_key','inbox_thread_state.property_id','inbox_thread_state.master_owner_id',
    'sms_suppression_list.phone_e164','sms_suppression_list.is_active','sms_suppression_list.suppression_type',
    'phones.canonical_e164','acquisition_opportunities.id','acquisition_opportunities.primary_thread_key'];
  optional text[] := array['followup_intents.thread_key','followup_intents.state','followup_intents.created_at',
    'send_queue.thread_key','send_queue.created_at','seller_offers.thread_key','seller_offers.created_at',
    'automation_events.conversation_thread_id','automation_events.created_at',
    'automation_suppressions.phone_e164','automation_suppressions.conversation_thread_id','automation_suppressions.status','automation_suppressions.expires_at','automation_suppressions.created_at',
    'contact_property_resolution.property_id','contact_property_resolution.contact_phone_e164','contact_property_resolution.contact_property_role','contact_property_resolution.rejected_at'];
  c text; problems text[] := '{}'; absent text[] := '{}';
begin
  if not exists (select 1 from pg_roles where rolname = 'lc_mcp_reader') then problems := problems || 'lc_mcp_reader missing (apply the 1.0 reader migration first)'::text; end if;
  if to_regprocedure('public.lc_mcp_reader_self_check(text[],text[],name)') is null then problems := problems || 'lc_mcp_reader_self_check missing'::text; end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
               and proname in ('lc_mcp_thread_followups','lc_mcp_thread_execution_log','lc_mcp_thread_offers','lc_mcp_thread_contact_eligibility','lc_mcp_operator_tasks')) then
    problems := problems || 'an acquisition read function already exists'::text;
  end if;
  foreach c in array need loop
    if not exists (select 1 from pg_attribute where attrelid = to_regclass('public.' || split_part(c, '.', 1))
                     and attname = split_part(c, '.', 2) and attnum > 0 and not attisdropped) then
      problems := problems || ('missing column ' || c);
    end if;
  end loop;
  -- an optional table that exists must carry the columns the function reads when it is present
  foreach c in array optional loop
    if to_regclass('public.' || split_part(c, '.', 1)) is null then absent := absent || c;
    elsif not exists (select 1 from pg_attribute where attrelid = to_regclass('public.' || split_part(c, '.', 1))
                        and attname = split_part(c, '.', 2) and attnum > 0 and not attisdropped) then
      problems := problems || ('optional table present but missing column ' || c);
    end if;
  end loop;
  if array_length(problems, 1) > 0 then raise exception 'pretest: %', array_to_string(problems, '; '); end if;
  raise notice 'pretest: prerequisites present';
  raise notice 'pretest: optional sources: followup_intents=% send_queue=% seller_offers=% automation_events=% automation_suppressions=% contact_property_resolution=% automation_hold_for=% agent.ops_work_item=% action_gateway.seller_action_receipts=%',
    to_regclass('public.followup_intents') is not null, to_regclass('public.send_queue') is not null, to_regclass('public.seller_offers') is not null,
    to_regclass('public.automation_events') is not null, to_regclass('public.automation_suppressions') is not null,
    to_regclass('public.contact_property_resolution') is not null, to_regprocedure('public.automation_hold_for(text,uuid,text,uuid,text,text)') is not null,
    to_regclass('agent.ops_work_item') is not null, to_regclass('action_gateway.seller_action_receipts') is not null;
  if array_length(absent, 1) > 0 then raise notice 'pretest: optional columns absent with their table: %', array_to_string(absent, ', '); end if;
end $$;
rollback;
