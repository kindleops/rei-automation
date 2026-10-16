-- PROPOSED ONLY — PRETEST for PROPOSED_20261016140000_operations_action_center.sql (8.5.20 part C). Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id operations_action_center
-- Expected last notice: "pretest(operations_action_center): prerequisites OK".
\set ON_ERROR_STOP on

do $$
declare t text;
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'agent' and table_name = 'research_job' and column_name = 'runtime_managed') then
    raise exception 'pretest(operations_action_center): the R2 runtime (PROPOSED_20261012140000_intel_runtime) must be applied first';
  end if;
  if to_regprocedure('agent.runtime_leased(text, uuid)') is null or to_regprocedure('agent.payload_is_clean(jsonb)') is null then
    raise exception 'pretest(operations_action_center): agent.runtime_leased / agent.payload_is_clean missing';
  end if;
  if to_regclass('agent.approval_request') is null then
    raise exception 'pretest(operations_action_center): the capability plane (PROPOSED_20261013120000_agent_capabilities) must be applied first';
  end if;
  if to_regclass('agent.research_job_requested_recent_idx') is null then
    raise exception 'pretest(operations_action_center): PROPOSED_20261014120000_persistent_missions must be applied first';
  end if;
  foreach t in array array['inbox_thread_state', 'message_events', 'send_queue', 'sms_suppression_list', 'acquisition_opportunities',
                           'acquisition_opportunity_history', 'seller_offers', 'closing_cases', 'seller_followup_state',
                           'property_acquisition_scores', 'campaigns', 'textgrid_numbers'] loop
    if to_regclass('public.' || t) is null then raise exception 'pretest(operations_action_center): public.% is missing', t; end if;
  end loop;
  if to_regclass('agent.conversation_action_state') is not null or to_regclass('agent.ops_work_item') is not null then
    raise exception 'pretest(operations_action_center): already applied';
  end if;
  raise notice 'pretest(operations_action_center): prerequisites OK';
end
$$;
