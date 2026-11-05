-- POSTTEST of the rollback of PROPOSED_20261027130000_lc_mcp_acquisition_reads.sql. DISPOSABLE DATABASE
-- ONLY. Read-only; ends in ROLLBACK. Proves the five functions are gone and the 1.0 reader (plus whichever
-- optional 1.1 / 1.2 reads are applied) is intact.
begin;
do $$
declare
  problems text[] := '{}'; rep jsonb; f text;
  fns text[] := array['public.campaign_entity_contact_review_flags(text[])','public.entity_graph_property_records(text)','public.lc_mcp_action_center(uuid,text,boolean,uuid,integer)','public.lc_mcp_followup_intent_health()','public.lc_mcp_operator_role(uuid,uuid)','public.lc_mcp_ops_finding(uuid,text)','public.lc_mcp_ops_research_valuation_snapshot()','public.lc_mcp_reader_self_check(text[],text[],name)','public.lc_mcp_thread_hold_status(uuid)'];
  optional_fns text[] := array['public.lc_mcp_conversation_signals(integer,text)','public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)','public.lc_mcp_corpus_census(text)','public.lc_mcp_lead_conversation(text,uuid,integer,timestamp with time zone,text,integer)','public.lc_mcp_lead_screen(text,integer,text,text)','public.lc_mcp_pipeline_counts(text,text,text,integer)'];
begin
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
               and proname in ('lc_mcp_thread_followups','lc_mcp_thread_execution_log','lc_mcp_thread_offers','lc_mcp_thread_contact_eligibility','lc_mcp_operator_tasks')) then
    problems := problems || 'an acquisition read function remains'::text;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'lc_mcp_reader') then problems := problems || 'the rollback dropped lc_mcp_reader'::text; end if;
  if to_regprocedure('public.lc_mcp_thread_hold_status(uuid)') is null or to_regprocedure('public.lc_mcp_reader_self_check(text[],text[],name)') is null then
    problems := problems || 'the rollback dropped a 1.0 reader function'::text;
  end if;
  foreach f in array optional_fns loop
    if to_regprocedure(f) is not null then fns := fns || f; end if;
  end loop;
  rep := public.lc_mcp_reader_self_check(
    array['acquisition_opportunities','campaign_target_graph','campaign_targets','campaigns','census_geo_metrics','eg_buyer_index','eg_property_facts','emails','inbox_thread_state','master_owners','mi_geo_period_rollup','mi_rollup_builds','mv_map_market_sales','phones','preforeclosure_status_v2','probate_status','properties','property_acquisition_scores','prospects','sms_suppression_list'],
    fns, 'lc_mcp_reader');
  if not coalesce((rep->>'ok')::boolean, false) then problems := problems || ('the reader self-check no longer passes: ' || (rep->'findings')::text); end if;
  if array_length(problems, 1) > 0 then raise exception 'rollback posttest: %', array_to_string(problems, '; '); end if;
  raise notice 'rollback posttest: only the five acquisition functions are gone; the reader self-check passes';
end $$;
rollback;
