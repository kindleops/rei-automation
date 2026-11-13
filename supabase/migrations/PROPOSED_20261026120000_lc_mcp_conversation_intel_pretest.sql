-- PRETEST for PROPOSED_20261026120000_lc_mcp_conversation_intel.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production. Read-only; ends in ROLLBACK.
-- Asserts the prerequisites the apply relies on:
--   * lc_mcp_reader and its self-check exist (the 1.0 reader migration is applied);
--   * none of the four functions exists yet;
--   * every column the functions read statically exists (message_events, inbox_thread_state,
--     sms_suppression_list, phones, eg_property_facts, property_acquisition_scores, campaign_target_graph);
--   * (NOTICE only) the optional sources: contact_property_resolution, automation_hold_for.
begin;
do $$
declare
  need text[] := array[
    'message_events.id','message_events.thread_key','message_events.property_id','message_events.from_phone_number','message_events.direction',
    'message_events.created_at','message_events.is_opt_out','message_events.detected_intent',
    'inbox_thread_state.id','inbox_thread_state.thread_key','inbox_thread_state.property_id','inbox_thread_state.master_owner_id',
    'inbox_thread_state.last_inbound_at','inbox_thread_state.last_outbound_at',
    'sms_suppression_list.phone_e164','sms_suppression_list.phone_number','sms_suppression_list.is_active','sms_suppression_list.suppression_type',
    'phones.canonical_e164','eg_property_facts.property_id','eg_property_facts.market','property_acquisition_scores.property_id',
    'campaign_target_graph.property_id','campaign_target_graph.canonical_e164','properties.property_id'];
  c text; problems text[] := '{}';
begin
  if not exists (select 1 from pg_roles where rolname = 'lc_mcp_reader') then problems := problems || 'lc_mcp_reader missing (apply the 1.0 reader migration first)'::text; end if;
  if to_regprocedure('public.lc_mcp_reader_self_check(text[],text[],name)') is null then problems := problems || 'lc_mcp_reader_self_check missing'::text; end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
               and proname in ('lc_mcp_lead_conversation','lc_mcp_conversation_worklist','lc_mcp_pipeline_counts','lc_mcp_conversation_signals')) then
    problems := problems || 'a conversation intelligence function already exists'::text;
  end if;
  foreach c in array need loop
    if not exists (select 1 from pg_attribute where attrelid = to_regclass('public.' || split_part(c, '.', 1))
                     and attname = split_part(c, '.', 2) and attnum > 0 and not attisdropped) then
      problems := problems || ('missing column ' || c);
    end if;
  end loop;
  if array_length(problems, 1) > 0 then raise exception 'pretest: %', array_to_string(problems, '; '); end if;
  raise notice 'pretest: prerequisites present';
  raise notice 'pretest: optional sources: contact_property_resolution=% automation_hold_for=%',
    to_regclass('public.contact_property_resolution') is not null,
    to_regprocedure('public.automation_hold_for(text,uuid,text,uuid,text,text)') is not null;
end $$;
rollback;
