-- G1: after the Phase A0 chain (#0 … #26), the Reader's own privilege self-check is still clean.
-- #26 replaces public.lc_egress_platform_allowlists() / lc_reachable_egress_indirect(), which lc_mcp_reader's
-- self-check (and a running Reader's boot / periodic re-check) depend on. Called with the Reader's exact inventory
-- (mcp/leadcommand-mcp/src/data/inventory.mjs RELATION_NAMES / RPC_SIGNATURES). census_geo_metrics is the Reader's
-- OPTIONAL relation (OPTIONAL_RELATIONS); this fixture lacks it: a finding about it alone is
-- tolerated, any other finding fails.
\set ON_ERROR_STOP on
do $$
declare
  rep jsonb;
  other jsonb;
begin
  rep := public.lc_mcp_reader_self_check(
    array['acquisition_opportunities','campaign_target_graph','campaign_targets','campaigns','census_geo_metrics','eg_buyer_index','eg_property_facts','emails','inbox_thread_state','master_owners','mi_geo_period_rollup','mi_rollup_builds','mv_map_market_sales','phones','preforeclosure_status_v2','probate_status','properties','property_acquisition_scores','prospects','sms_suppression_list'],
    array['public.campaign_entity_contact_review_flags(text[])','public.entity_graph_property_records(text)','public.lc_mcp_action_center(uuid,text,boolean,uuid,integer)','public.lc_mcp_followup_intent_health()','public.lc_mcp_operator_role(uuid,uuid)','public.lc_mcp_ops_finding(uuid,text)','public.lc_mcp_ops_research_valuation_snapshot()','public.lc_mcp_reader_self_check(text[],text[],name)','public.lc_mcp_thread_hold_status(uuid)'],
    'lc_mcp_reader');
  select coalesce(jsonb_agg(f), '[]'::jsonb) into other from jsonb_array_elements(coalesce(rep -> 'findings', '[]'::jsonb)) f where f::text !~ 'census_geo_metrics';
  if not coalesce((rep ->> 'ok')::boolean, false) and jsonb_array_length(other) > 0 then
    raise exception 'phase_a0_reader_selfcheck_verify: the Reader self-check has findings after #26: %', other;
  end if;
  if jsonb_array_length(coalesce(rep -> 'reachable_egress_functions', '[]'::jsonb)) > 0 then
    raise exception 'phase_a0_reader_selfcheck_verify: egress reachable: %', rep -> 'reachable_egress_functions';
  end if;
  raise notice 'phase_a0_reader_selfcheck_verify: Reader self-check ok after the A0 chain (ok=%, findings=%)', rep ->> 'ok', coalesce(rep -> 'findings', '[]'::jsonb);
end $$;
