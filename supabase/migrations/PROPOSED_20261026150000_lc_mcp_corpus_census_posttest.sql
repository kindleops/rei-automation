-- POSTTEST for PROPOSED_20261026150000_lc_mcp_corpus_census.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production. One transaction, ends in ROLLBACK.
-- Seeds: the 1.1 emulation (mcp/leadcommand-mcp/migrations/test/lc_mcp_conversation_intel_emulation.sql) plus
-- mcp/leadcommand-mcp/migrations/test/lc_mcp_corpus_census_emulation.sql (synthetic; see its header for the corpus).
--
-- Every call runs AS lc_mcp_reader (SET LOCAL ROLE inside an exception block). It proves:
--   A. privileges: the role can EXECUTE the two functions; PUBLIC / anon / authenticated / service_role cannot;
--      both are STABLE SECURITY DEFINER search_path=pg_catalog; the role still cannot read message_events directly;
--   B. lc_mcp_corpus_census: exact populations per source, coverage over the lead corpus, evidence, duplicates,
--      contact state, pipeline health and Decision Engine coverage — every number against the seeded corpus;
--      the market filter; absent columns named; bounds refused (22023);
--   C. lc_mcp_lead_screen: keyset pages cover every lead exactly once in property_id order, has_more is truthful,
--      each row carries labels / evidence / thread state / engine presence as seeded, no phone number, thread key,
--      name or address anywhere in the output; bounds refused (22023);
--   D. the reader self-check passes with the extended function list.
begin;

do $$
declare
  fails text[] := '{}';
  c jsonb; m jsonb; s jsonb; s2 jsonb; rep jsonb; r jsonb; txt text;
  f text; rl text; ids text[] := '{}'; pages int := 0; cur text := null;
  fn_list text[] := array['public.lc_mcp_corpus_census(text)','public.lc_mcp_lead_screen(text,integer,text,text)'];
  rels text[] := array['acquisition_opportunities','campaign_target_graph','campaign_targets','campaigns','census_geo_metrics','eg_buyer_index','eg_property_facts','emails','inbox_thread_state','master_owners','mi_geo_period_rollup','mi_rollup_builds','mv_map_market_sales','phones','preforeclosure_status_v2','probate_status','properties','property_acquisition_scores','prospects','sms_suppression_list'];
  fns text[] := array['public.campaign_entity_contact_review_flags(text[])','public.entity_graph_property_records(text)','public.lc_mcp_action_center(uuid,text,boolean,uuid,integer)','public.lc_mcp_conversation_signals(integer,text)','public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)','public.lc_mcp_corpus_census(text)','public.lc_mcp_followup_intent_health()','public.lc_mcp_lead_conversation(text,uuid,integer,timestamp with time zone,text,integer)','public.lc_mcp_lead_screen(text,integer,text,text)','public.lc_mcp_operator_role(uuid,uuid)','public.lc_mcp_ops_finding(uuid,text)','public.lc_mcp_ops_research_valuation_snapshot()','public.lc_mcp_pipeline_counts(text,text,text,integer)','public.lc_mcp_reader_self_check(text[],text[],name)','public.lc_mcp_thread_hold_status(uuid)'];
begin
  -- ------------------------------------------------------------------ A. privileges
  foreach f in array fn_list loop
    if not has_function_privilege('lc_mcp_reader', f, 'EXECUTE') then fails := fails || ('A: lc_mcp_reader cannot execute ' || f); end if;
    foreach rl in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(rl, f, 'EXECUTE') then fails := fails || format('A: %s can execute %s', rl, f); end if;
    end loop;
    if exists (select 1 from pg_proc x, aclexplode(coalesce(x.proacl, acldefault('f', x.proowner))) a
                where x.oid = f::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') then fails := fails || ('A: PUBLIC can execute ' || f); end if;
    if (select provolatile from pg_proc where oid = f::regprocedure) <> 's' or not (select prosecdef from pg_proc where oid = f::regprocedure)
       or (select proconfig from pg_proc where oid = f::regprocedure) is distinct from array['search_path=pg_catalog'] then
      fails := fails || ('A: not STABLE SECURITY DEFINER search_path=pg_catalog: ' || f);
    end if;
  end loop;
  begin
    execute 'set local role lc_mcp_reader';
    execute 'select count(*) from public.message_events';
    execute 'reset role';
    fails := fails || 'A: NOT REFUSED: direct read of message_events'::text;
  exception when insufficient_privilege then null;
  end;

  -- ------------------------------------------------------------------ B. the census
  begin
    execute 'set local role lc_mcp_reader';
    c := public.lc_mcp_corpus_census(null);
    m := public.lc_mcp_corpus_census('Fixture Metro, TX');
    execute 'reset role';
  exception when others then fails := fails || ('B: census call failed ' || sqlstate || ' ' || sqlerrm); c := '{}'; m := '{}';
  end;
  if c->>'lead_key' <> 'eg_property_facts.property_id' then fails := fails || 'B: lead_key'::text; end if;
  -- sources
  if (c#>>'{sources,eg_property_facts}')::int <> 6 then fails := fails || ('B: facts ' || coalesce(c#>>'{sources,eg_property_facts}', 'null')); end if;
  if (c#>>'{sources,properties}')::int <> 5 then fails := fails || ('B: properties ' || coalesce(c#>>'{sources,properties}', 'null')); end if;
  if (c#>>'{sources,campaign_target_graph,rows}')::int <> 5 or (c#>>'{sources,campaign_target_graph,properties}')::int <> 4 or (c#>>'{sources,campaign_target_graph,phones}')::int <> 4 then fails := fails || ('B: graph ' || (c#>'{sources,campaign_target_graph}')::text); end if;
  if (c#>>'{sources,campaign_targets,properties}')::int <> 1 then fails := fails || ('B: campaign_targets ' || (c#>'{sources,campaign_targets}')::text); end if;
  if (c#>>'{sources,inbox_thread_state,threads}')::int <> 5 or (c#>>'{sources,inbox_thread_state,with_inbound}')::int <> 4 or (c#>>'{sources,inbox_thread_state,with_outbound}')::int <> 2 then fails := fails || ('B: threads ' || (c#>'{sources,inbox_thread_state}')::text); end if;
  if (c#>>'{sources,message_events,rows}')::int <> 11 or (c#>>'{sources,message_events,inbound}')::int <> 7 or (c#>>'{sources,message_events,outbound}')::int <> 4 or (c#>>'{sources,message_events,inbound_unknown_sender}')::int <> 1 then fails := fails || ('B: messages ' || (c#>'{sources,message_events}')::text); end if;
  if (c#>>'{sources,acquisition_opportunities,rows}')::int <> 2 or (c#>>'{sources,acquisition_opportunities,open}')::int <> 1 or (c#>>'{sources,acquisition_opportunities,stale_open_60d}')::int <> 0 then fails := fails || ('B: opportunities ' || (c#>'{sources,acquisition_opportunities}')::text); end if;
  if (c#>>'{sources,property_acquisition_scores,rows}')::int <> 1 or (c#>>'{sources,property_acquisition_scores,fresh_30d}')::int <> 1 then fails := fails || ('B: scores ' || (c#>'{sources,property_acquisition_scores}')::text); end if;
  if (c#>>'{sources,sms_suppression_list,active}')::int <> 2 or (c#>>'{sources,phones}')::int <> 2 or (c#>>'{sources,master_owners}')::int <> 1 then fails := fails || ('B: org-wide sources ' || (c->'sources')::text); end if;
  -- coverage
  if (c#>>'{coverage,leads}')::int <> 6 or (c#>>'{coverage,with_property_row}')::int <> 4 or (c#>>'{coverage,with_phone_on_graph}')::int <> 4 or (c#>>'{coverage,with_sms_eligible_phone}')::int <> 4
     or (c#>>'{coverage,in_campaign_targets}')::int <> 1 or (c#>>'{coverage,with_thread}')::int <> 5 or (c#>>'{coverage,with_inbound}')::int <> 4
     or (c#>>'{coverage,with_decision_engine}')::int <> 1 or (c#>>'{coverage,with_fresh_decision_engine}')::int <> 1 or (c#>>'{coverage,conversation_stage_set}')::int <> 4
     or (c#>>'{coverage,pipeline_stage_set}')::int <> 5 or (c#>>'{coverage,deal_linked}')::int <> 1 or (c#>>'{coverage,last_contact_set}')::int <> 4 or (c#>>'{coverage,contacted_90d}')::int <> 4
     or (c#>>'{coverage,estimated_value_set}')::int <> 5 or (c#>>'{coverage,equity_known}')::int <> 5 then
    fails := fails || ('B: coverage ' || (c->'coverage')::text);
  end if;
  -- evidence
  if (c#>>'{evidence,distress_signals}')::int <> 5 or (c#>>'{evidence,distress_signals_2plus}')::int <> 3 or (c#>>'{evidence,tax_delinquent}')::int <> 2 or (c#>>'{evidence,active_lien}')::int <> 0
     or (c#>>'{evidence,probate}')::int <> 1 or (c#>>'{evidence,preforeclosure}')::int <> 1 or (c#>>'{evidence,equity_30pct_plus}')::int <> 4 or (c#>>'{evidence,owner_several_properties}')::int <> 1
     or (c#>>'{evidence,out_of_state_owner}')::int <> 1 or (c#>>'{evidence,signals_never_contacted}')::int <> 2 then
    fails := fails || ('B: evidence ' || (c->'evidence')::text);
  end if;
  -- duplicates
  if (c#>>'{duplicates,phones_on_several_properties}')::int <> 1 or (c#>>'{duplicates,properties_sharing_address,groups}')::int <> 1 or (c#>>'{duplicates,properties_sharing_address,properties}')::int <> 2
     or (c#>>'{duplicates,owners_with_several_properties,owners}')::int <> 1 or (c#>>'{duplicates,owners_with_several_properties,properties}')::int <> 2
     or (c#>>'{duplicates,properties_with_several_threads}')::int <> 0 or (c#>>'{duplicates,facts_without_property_row}')::int <> 2 or (c#>>'{duplicates,properties_without_facts_row}')::int <> 1 then
    fails := fails || ('B: duplicates ' || (c->'duplicates')::text);
  end if;
  -- contact
  if (c#>>'{contact,threads_opted_out}')::int <> 1 or (c#>>'{contact,threads_wrong_number}')::int <> 0 or (c#>>'{contact,threads_suppressed}')::int <> 1
     or (c#>>'{contact,threads_unanswered_inbound}')::int <> 3 or (c#>>'{contact,threads_unanswered_over_7d}')::int <> 1 then
    fails := fails || ('B: contact ' || (c->'contact')::text);
  end if;
  -- pipeline health + decision engine
  if (c#>>'{pipeline_health,needs_review_unresolved_14d}')::int <> 1 or (c#>>'{pipeline_health,interest_label_no_contact_30d}')::int <> 1 or (c#>>'{pipeline_health,deal_linked_no_contact_60d}')::int <> 0
     or (c#>>'{pipeline_health,pipeline_without_conversation_stage}')::int <> 1 or (c#>>'{pipeline_health,sms_opted_out_label_without_thread_opt_out}')::int <> 0
     or (c#>>'{pipeline_health,contactable_phone_never_contacted}')::int <> 1 then
    fails := fails || ('B: pipeline health ' || (c->'pipeline_health')::text);
  end if;
  if (c#>>'{decision_engine,leads_in_conversation}')::int <> 4 or (c#>>'{decision_engine,without_decision_engine}')::int <> 3 or (c#>>'{decision_engine,decision_engine_older_than_30d}')::int <> 0 then
    fails := fails || ('B: decision engine ' || (c->'decision_engine')::text);
  end if;
  -- columns: the emulation lacks lien_count / rec_has_mechanics_lien etc. only through to_jsonb; the wanted list here is fully present except what the emulation never added
  if not (c->'columns_present') ? 'distress_signal_count' or not (c->'columns_present') ? 'conversation_stage' then fails := fails || ('B: columns_present ' || (c->'columns_present')::text); end if;
  -- the market filter: P6 (Other Metro) drops out
  if (m#>>'{coverage,leads}')::int <> 5 or (m#>>'{sources,properties}')::int <> 4 or (m#>>'{evidence,out_of_state_owner}')::int <> 0 or (m#>>'{sources,inbox_thread_state,threads}')::int <> 5 then
    fails := fails || ('B: market filter ' || (m->'coverage')::text || (m->'sources')::text);
  end if;
  -- bounds
  begin
    execute 'set local role lc_mcp_reader';
    c := public.lc_mcp_corpus_census(repeat('x', 61));
    execute 'reset role';
    fails := fails || 'B: a 61-char market was not refused'::text;
  exception when invalid_parameter_value then execute 'reset role';
  end;

  -- ------------------------------------------------------------------ C. the lead screen
  loop
    pages := pages + 1;
    execute 'set local role lc_mcp_reader';
    s := public.lc_mcp_lead_screen(cur, 3, null, null);
    execute 'reset role';
    select ids || coalesce(array_agg(x->>'property_id'), '{}') into ids from jsonb_array_elements(s->'rows') x;
    if pages = 1 and ((s->>'has_more')::boolean is not true or jsonb_array_length(s->'rows') <> 3) then fails := fails || ('C: first page ' || s::text); end if;
    exit when not (s->>'has_more')::boolean or pages > 5;
    cur := s->'rows'->-1->>'property_id';
  end loop;
  if pages <> 2 or ids <> array['P1','P2','P3','P4','P5','P6'] then fails := fails || format('C: paging pages=%s ids=%s', pages, array_to_string(ids, ',')); end if;
  execute 'set local role lc_mcp_reader';
  s := public.lc_mcp_lead_screen(null, 10, null, null);
  s2 := public.lc_mcp_lead_screen(null, 10, 'Fixture Metro, TX', 'tx');
  execute 'reset role';
  if (s->>'has_more')::boolean then fails := fails || 'C: has_more on the last page'::text; end if;
  if jsonb_array_length(s2->'rows') <> 5 then fails := fails || ('C: market/state filter rows ' || jsonb_array_length(s2->'rows')); end if;
  select x into r from jsonb_array_elements(s->'rows') x where x->>'property_id' = 'P1';
  if (r#>>'{distress,signal_count}')::numeric <> 3 or (r#>>'{distress,tax_delinquent}')::boolean is not true or (r#>>'{threads,unanswered}')::boolean is not true
     or (r#>>'{decision_engine,present}')::boolean is not true or (r#>>'{contact,phones_on_graph}')::int <> 1 or (r#>>'{contact,sms_eligible_phones}')::int <> 1
     or (r#>>'{pipeline,deal_linked}')::boolean is not true or r#>>'{conversation,stage}' <> 'offer_interest' or r#>>'{outreach,campaign_targets}' <> '1' or r#>>'{last_contact,direction}' <> 'inbound' then
    fails := fails || ('C: P1 row ' || coalesce(r::text, 'null'));
  end if;
  select x into r from jsonb_array_elements(s->'rows') x where x->>'property_id' = 'P2';
  if (r#>>'{threads,opted_out}')::boolean is not true or (r#>>'{threads,suppressed}')::boolean is not true or r#>>'{threads,contactability}' <> 'opted_out' or (r#>>'{contact,phones_on_graph}')::int <> 2 then
    fails := fails || ('C: P2 row ' || coalesce(r::text, 'null'));
  end if;
  select x into r from jsonb_array_elements(s->'rows') x where x->>'property_id' = 'P5';
  if r#>>'{last_contact,at}' is not null or (r#>>'{contact,sms_eligible_phones}')::int <> 1 or (r#>>'{distress,preforeclosure}')::boolean is not true or (r#>>'{threads,unanswered}')::boolean is not true
     or (r#>>'{decision_engine,present}')::boolean is not false or r#>>'{conversation,stage}' is not null or r#>>'{pipeline,stage}' <> 'offer_interest' then
    fails := fails || ('C: P5 row ' || coalesce(r::text, 'null'));
  end if;
  select x into r from jsonb_array_elements(s->'rows') x where x->>'property_id' = 'P4';
  if (r#>>'{owner,property_count}')::numeric <> 2 or (r#>>'{distress,probate}')::boolean is not true or r#>>'{conversation,status}' <> 'needs_review' or r#>>'{estimated_value}' is not null then
    fails := fails || ('C: P4 row ' || coalesce(r::text, 'null'));
  end if;
  txt := s::text || c::text;
  if txt ~ '\+1555' or txt ~ '555-?01' or txt like '%Fixture St%' or txt like '%Fixture Owner%' or txt like '%Fixture Person%' or txt like '%thread_key%' or txt like '%canonical_e164%' then
    fails := fails || ('C: identifier leaked: ' || left(txt, 300));
  end if;
  begin
    execute 'set local role lc_mcp_reader';
    s := public.lc_mcp_lead_screen(null, 501, null, null);
    execute 'reset role';
    fails := fails || 'C: limit 501 not refused'::text;
  exception when invalid_parameter_value then execute 'reset role';
  end;
  begin
    execute 'set local role lc_mcp_reader';
    s := public.lc_mcp_lead_screen('P1; drop table x', 10, null, null);
    execute 'reset role';
    fails := fails || 'C: a cursor with punctuation not refused'::text;
  exception when invalid_parameter_value then execute 'reset role';
  end;

  -- ------------------------------------------------------------------ D. self-check
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if not coalesce((rep->>'ok')::boolean, false) then fails := fails || ('D: self-check ' || (rep->'findings')::text); end if;

  if array_length(fails, 1) > 0 then raise exception 'posttest: %', array_to_string(fails, E'\n  '); end if;
  raise notice 'posttest: A privileges, B census, C screen, D self-check — all pass';
end $$;
rollback;
