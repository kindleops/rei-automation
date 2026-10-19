-- POSTTEST of the OPTIONAL lc_mcp_reader link (#25) on the FULL rc-8.5.21 release chain.
-- DISPOSABLE DATABASE ONLY: run by scripts/db/run-migration-test.mjs (rc_8_5_21_release_chain),
-- never against production. One transaction, ends in ROLLBACK.
--
-- The standalone entry (lc_mcp_reader) proves the role on an emulation. THIS proves it on the REAL
-- chain objects: the five operations read functions are plpgsql, so they bind to their sources
-- only when called. Each one is called here AS lc_mcp_reader, against the real holds registry,
-- follow-up lifecycle, operations action center and research / valuation snapshot:
--   * the role's privilege report is ok on the whole rc-8.5.21 schema (no definer, egress, write
--     or exposed-read finding from any other chain migration);
--   * a hold set on a thread (the real automation_holds + automation_hold_for + audit trigger) is
--     reported by category and matched scope only; an unknown thread is thread_found = false;
--   * the action center, finding and follow-up reads answer with their empty-state projections;
--   * the role still cannot read the sources directly.
begin;

do $$
declare
  rels text[] := array['acquisition_opportunities','campaign_target_graph','campaign_targets','campaigns','census_geo_metrics','eg_buyer_index','eg_property_facts','emails','inbox_thread_state','master_owners','mi_geo_period_rollup','mi_rollup_builds','mv_map_market_sales','phones','preforeclosure_status_v2','probate_status','properties','property_acquisition_scores','prospects','sms_suppression_list'];
  fns text[] := array['public.campaign_entity_contact_review_flags(text[])','public.entity_graph_property_records(text)','public.lc_mcp_action_center(uuid,text,boolean,uuid,integer)','public.lc_mcp_followup_intent_health()','public.lc_mcp_operator_role(uuid,uuid)','public.lc_mcp_ops_finding(uuid,text)','public.lc_mcp_ops_research_valuation_snapshot()','public.lc_mcp_reader_self_check(text[],text[],name)','public.lc_mcp_thread_hold_status(uuid)'];
  org uuid := '00000000-0000-4000-8000-0000000000a1';
  tid uuid := '00000000-0000-4000-8000-00000000c0a1';
  rep jsonb; h jsonb; h0 jsonb; ac jsonb; f jsonb; rv jsonb; fu jsonb;
  fails text[] := '{}';
  q text;
begin
  -- a thread and an ambiguous-property ownership hold on it, through the REAL registry (audit trigger fires)
  insert into public.inbox_thread_state (id, thread_key, property_id, master_owner_id) values (tid, '+15550199001', 'P_CHAIN_1', 'O_CHAIN_1');
  insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref)
  values ('ownership_unresolved:+15550199001', 'operator_hold', '+15550199001', 'ownership_denial_property_unresolved', 'system:ownership_attribution', 'owner_rule_2026-10-17:ambiguous_property_thread_hold');

  begin
    execute 'set local role lc_mcp_reader';
    rep := public.lc_mcp_reader_self_check(rels, fns);
    h := public.lc_mcp_thread_hold_status(tid);
    h0 := public.lc_mcp_thread_hold_status('00000000-0000-4000-8000-00000000c0ff');
    ac := public.lc_mcp_action_center(org, null, true, null, 10);
    f := public.lc_mcp_ops_finding(org, 'supervisor.summary');
    rv := public.lc_mcp_ops_research_valuation_snapshot();
    fu := public.lc_mcp_followup_intent_health();
    execute 'reset role';
  exception when others then
    fails := fails || format('an operations read failed on the real chain objects: %s %s', sqlstate, sqlerrm);
  end;
  if array_length(fails, 1) is null then
    if rep->>'current_user' <> 'lc_mcp_reader' or not (rep->>'ok')::boolean then fails := fails || format('privilege report on the full chain: %s', rep->>'findings'); end if;
    if jsonb_array_length(h->'holds') <> 1 or h->'holds'->0->>'reason_category' <> 'ownership_attribution_unresolved' or h->'holds'->0->>'matched_on' <> 'thread' then fails := fails || format('thread hold = %s', h); end if;
    if (h->'holds')::text ~ '(\+1555|ownership_unresolved:|owner_rule_)' then fails := fails || 'the hold projection leaked a key / reason'::text; end if;
    if (h0->>'thread_found')::boolean is not false then fails := fails || 'unknown thread must be thread_found = false'::text; end if;
    if ac->'items' <> '[]'::jsonb or ac->'summary' <> '[]'::jsonb then fails := fails || format('action center (born empty) = %s', ac); end if;
    if f is not null then fails := fails || 'no finding yet: must be null, never a zero summary'::text; end if;
    if not (rv ? 'offers' and rv ? 'valuation' and rv ? 'negotiations') then fails := fails || format('research / valuation snapshot = %s', rv); end if;
    if (fu->'health'->>'scheduled_executable')::int <> 0 or fu->'reasons' <> '[]'::jsonb then fails := fails || format('follow-up health (born empty) = %s', fu); end if;
  end if;

  -- the sources stay unreadable to the role directly
  foreach q in array array[
    'select count(*) from public.automation_holds',
    'select count(*) from public.followup_intents',
    'select count(*) from public.v_followup_intent_health',
    'select count(*) from agent.conversation_action_state',
    'select count(*) from agent.finding',
    'select count(*) from public.automation_hold_for(''+15550199001'')'] loop
    begin
      execute 'set local role lc_mcp_reader';
      execute q;
      execute 'reset role';
      fails := fails || format('NOT REFUSED: %s', q);
    exception when insufficient_privilege then null; when others then fails := fails || format('%s → %s', q, sqlstate);
    end;
  end loop;

  if array_length(fails, 1) > 0 then
    raise exception 'lc_mcp_reader chain posttest FAILED (% problem(s)):%', array_length(fails, 1), E'\n  ' || array_to_string(fails, E'\n  ');
  end if;
  raise notice 'lc_mcp_reader chain posttest: privilege report ok on the full rc-8.5.21 schema; 5 operations reads bound to the real sources';
end $$;

rollback;
