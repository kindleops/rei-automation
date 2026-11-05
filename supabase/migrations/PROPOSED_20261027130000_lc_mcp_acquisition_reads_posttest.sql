-- POSTTEST for PROPOSED_20261027130000_lc_mcp_acquisition_reads.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production. One transaction, ends in ROLLBACK.
-- Seeds: mcp/leadcommand-mcp/migrations/test/lc_mcp_acquisition_reads_emulation.sql (synthetic; thread 107 =
-- +13125550161 on P9, thread 101 = held, thread 102 = opted out).
--
-- Every call runs AS lc_mcp_reader (SET LOCAL ROLE inside an exception block). It proves:
--   A. privileges: the role can EXECUTE the five functions and still cannot read followup_intents, send_queue,
--      seller_offers, automation_events, automation_suppressions or agent.ops_work_item directly; PUBLIC / anon /
--      authenticated / service_role cannot EXECUTE them; each is STABLE SECURITY DEFINER search_path=pg_catalog
--      with no dynamic SQL in its body;
--   B. thread followups: rows newest first, states, materialized flag, counts by state; nothing phone-shaped;
--   C. execution log: queue rows newest first with states / timing / origin, the failed reason and queue key with
--      their digit runs withheld, no body, no number; events without payload; the limit; bounds (22023); the
--      receipt join once action_gateway.seller_action_receipts exists (created HERE, rolled back); automation_events
--      reported absent once dropped (HERE, rolled back);
--   D. offers: both offers newest first with direction / type / price / ceiling / status, the opportunity with its
--      stage and a next action whose digit run is withheld; no dedupe key, no number;
--   E. eligibility: 107 eligible with no blocking reason; 101 blocked by the ownership hold (ai_action); 102 blocked
--      by its flags, the suppression list and the active automation suppression; the unknown thread not found; the
--      rule text; nothing phone-shaped;
--   F. operator tasks: three open / acknowledged newest first, the resolved one absent, the title's digit run
--      withheld, no detail, counts; bounds; the source reported absent once agent.ops_work_item is dropped (HERE);
--   G. the reader self-check passes with the extended list, and the 1.0 list names the five as unexpected definers.
begin;

do $$
declare
  fails text[] := '{}';
  c jsonb; c2 jsonb; txt text; st text; f text; r text;
  rels text[] := array['acquisition_opportunities','campaign_target_graph','campaign_targets','campaigns','census_geo_metrics','eg_buyer_index','eg_property_facts','emails','inbox_thread_state','master_owners','mi_geo_period_rollup','mi_rollup_builds','mv_map_market_sales','phones','preforeclosure_status_v2','probate_status','properties','property_acquisition_scores','prospects','sms_suppression_list'];
  base_fns text[] := array['public.campaign_entity_contact_review_flags(text[])','public.entity_graph_property_records(text)','public.lc_mcp_action_center(uuid,text,boolean,uuid,integer)','public.lc_mcp_followup_intent_health()','public.lc_mcp_operator_role(uuid,uuid)','public.lc_mcp_ops_finding(uuid,text)','public.lc_mcp_ops_research_valuation_snapshot()','public.lc_mcp_reader_self_check(text[],text[],name)','public.lc_mcp_thread_hold_status(uuid)'];
  new_fns text[] := array['public.lc_mcp_thread_followups(uuid)','public.lc_mcp_thread_execution_log(uuid,integer)','public.lc_mcp_thread_offers(uuid)','public.lc_mcp_thread_contact_eligibility(uuid)','public.lc_mcp_operator_tasks(integer)'];
  optional_fns text[] := array['public.lc_mcp_conversation_signals(integer,text)','public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)','public.lc_mcp_corpus_census(text)','public.lc_mcp_lead_conversation(text,uuid,integer,timestamp with time zone,text,integer)','public.lc_mcp_lead_screen(text,integer,text,text)','public.lc_mcp_pipeline_counts(text,text,text,integer)'];
  fns text[];
  rep jsonb;
  t107 uuid := '00000000-0000-4000-8000-000000000107';
  t101 uuid := '00000000-0000-4000-8000-000000000101';
  t102 uuid := '00000000-0000-4000-8000-000000000102';
  tnone uuid := '00000000-0000-4000-8000-0000000009ff';
begin
  -- ------------------------------------------------------------------ A. privileges
  foreach f in array new_fns loop
    if not has_function_privilege('lc_mcp_reader', f, 'EXECUTE') then fails := fails || ('A: lc_mcp_reader cannot run ' || f); end if;
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, f, 'EXECUTE') then fails := fails || format('A: %s can run %s', r, f); end if;
    end loop;
    if exists (select 1 from pg_proc x, aclexplode(coalesce(x.proacl, acldefault('f', x.proowner))) a
                where x.oid = f::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') then fails := fails || ('A: PUBLIC can run ' || f); end if;
    if (select provolatile from pg_proc where oid = f::regprocedure) <> 's' or not (select prosecdef from pg_proc where oid = f::regprocedure)
       or (select proconfig from pg_proc where oid = f::regprocedure) is distinct from array['search_path=pg_catalog'] then
      fails := fails || ('A: not STABLE SECURITY DEFINER search_path=pg_catalog: ' || f);
    end if;
    if (select regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') from pg_proc where oid = f::regprocedure) ~* ('\m' || 'execute' || '[[:space:]]') then
      fails := fails || ('A: dynamic SQL in the body of ' || f);
    end if;
  end loop;
  foreach st in array array['select count(*) from public.followup_intents', 'select count(*) from public.send_queue', 'select count(*) from public.seller_offers',
                            'select count(*) from public.automation_events', 'select count(*) from public.automation_suppressions', 'select count(*) from agent.ops_work_item'] loop
    begin
      execute 'set local role lc_mcp_reader';
      execute st;
      execute 'reset role';
      fails := fails || ('A: NOT REFUSED: ' || st);
    exception when insufficient_privilege then null;
    end;
  end loop;

  -- ------------------------------------------------------------------ B. followups
  begin
    execute 'set local role lc_mcp_reader';
    c := public.lc_mcp_thread_followups(t107);
    c2 := public.lc_mcp_thread_followups(tnone);
    execute 'reset role';
  exception when others then fails := fails || ('B: call failed ' || sqlstate || ' ' || sqlerrm); c := '{}'; c2 := '{}';
  end;
  if (c->>'thread_found')::boolean is not true or c->>'property_id' <> 'P9' or (c->>'returned')::int <> 3 or (c->>'total')::int <> 3 or (c->>'has_more')::boolean then fails := fails || ('B: shape ' || left(c::text, 300)); end if;
  if c#>>'{rows,0,state}' <> 'planned' or c#>>'{rows,1,state}' <> 'cancelled' or c#>>'{rows,2,state}' <> 'delivered' then fails := fails || ('B: order ' || (c->'rows')::text); end if;
  if c#>>'{rows,0,kind}' <> 'offer_silence' or c#>>'{rows,0,next_action}' <> 'await_counter' or (c#>>'{rows,0,this_property}')::boolean is not true then fails := fails || 'B: planned row'::text; end if;
  if (c#>>'{rows,2,materialized}')::boolean is not true or (c#>>'{rows,0,materialized}')::boolean is not false or c#>>'{rows,2,outcome}' <> 'delivered' then fails := fails || 'B: materialized flags'::text; end if;
  if c#>>'{rows,1,reason_code}' <> 'superseded_by_offer' then fails := fails || 'B: reason code'::text; end if;
  if (c#>>'{counts_by_state,planned}')::int <> 1 or (c#>>'{counts_by_state,delivered}')::int <> 1 or (c#>>'{counts_by_state,cancelled}')::int <> 1 then fails := fails || ('B: counts ' || (c->'counts_by_state')::text); end if;
  if (c#>>'{sources,followup_intents}')::boolean is not true then fails := fails || 'B: source flag'::text; end if;
  if (c2->>'thread_found')::boolean is not false then fails := fails || 'B: unknown thread found'::text; end if;
  txt := c::text;
  if txt like '%5550161%' or txt like '%intent_key%' or txt like '%thread_key%' or txt like '%send_queue_key%' or txt like '%row_spec%' then fails := fails || ('B: identifier leaked: ' || left(txt, 300)); end if;
  execute 'set local role lc_mcp_reader';
  c := public.lc_mcp_thread_followups(t101);
  execute 'reset role';
  -- (the two 1.0 seeds share a created_at: the order between them is by id, so only their presence is asserted)
  if (c->>'returned')::int <> 2 or not (c->'rows' @> '[{"kind":"offer_silence","state":"delivered"}]' and c->'rows' @> '[{"kind":"s2_silence","state":"planned"}]') then fails := fails || ('B: P1 thread rows ' || (c->'rows')::text); end if;

  -- ------------------------------------------------------------------ C. execution log
  begin
    execute 'set local role lc_mcp_reader';
    c := public.lc_mcp_thread_execution_log(t107, 10);
    c2 := public.lc_mcp_thread_execution_log(t107, 1);
    execute 'reset role';
  exception when others then fails := fails || ('C: call failed ' || sqlstate || ' ' || sqlerrm); c := '{}'; c2 := '{}';
  end;
  if (c->>'thread_found')::boolean is not true or (c->>'queue_returned')::int <> 3 or (c->>'events_returned')::int <> 2 then fails := fails || ('C: shape ' || left(c::text, 300)); end if;
  if c#>>'{queue_rows,0,id}' <> '9003' or c#>>'{queue_rows,1,id}' <> '9002' or c#>>'{queue_rows,2,id}' <> '9001' then fails := fails || ('C: queue order ' || (c->'queue_rows')::text); end if;
  if c#>>'{queue_rows,0,queue_status}' <> 'queued' or c#>>'{queue_rows,0,message_origin}' <> 'ai_generated' or c#>>'{queue_rows,0,use_case_template}' <> 'offer_follow_up' then fails := fails || 'C: queued row'::text; end if;
  if c#>>'{queue_rows,1,queue_status}' <> 'failed' or c#>>'{queue_rows,1,failed_reason}' <> 'provider rejected destination +[digits withheld] (30007)' then fails := fails || ('C: failed reason ' || coalesce(c#>>'{queue_rows,1,failed_reason}', 'null')); end if;
  if c#>>'{queue_rows,2,queue_key}' <> 'fx:+[digits withheld]:1' or c#>>'{queue_rows,2,delivered_at}' is null or c#>>'{queue_rows,2,agent_name}' <> 'Fixture Agent' or (c#>>'{queue_rows,2,touch_number}')::int <> 1 then fails := fails || ('C: sent row ' || (c#>'{queue_rows,2}')::text); end if;
  if c#>'{queue_rows,0,receipt}' is distinct from 'null'::jsonb or (c#>>'{sources,seller_action_receipts}')::boolean is not false then fails := fails || 'C: receipts reported present without the table'::text; end if;
  if c#>>'{events,0,event_type}' <> 'seller_replied' or c#>>'{events,1,event_type}' <> 'follow_up_due' or c#>>'{events,1,error_code}' <> 'PROVIDER_REJECTED' or c#>>'{events,0,source}' <> 'webhook' then fails := fails || ('C: events ' || (c->'events')::text); end if;
  if (c2->>'queue_returned')::int <> 1 or (c2->>'events_returned')::int <> 1 or c2#>>'{queue_rows,0,id}' <> '9003' then fails := fails || 'C: limit'::text; end if;
  txt := c::text;
  if txt like '%5550161%' or txt like '%message_body%' or txt like '%to_phone_number%' or txt like '%payload%' or txt like '%Fixture Homes%' or txt like '%175k%' then fails := fails || ('C: body / number leaked: ' || left(txt, 400)); end if;
  foreach st in array array['select public.lc_mcp_thread_execution_log(''00000000-0000-4000-8000-000000000107'', 0)',
                            'select public.lc_mcp_thread_execution_log(''00000000-0000-4000-8000-000000000107'', 101)',
                            'select public.lc_mcp_thread_execution_log(null, 10)',
                            'select public.lc_mcp_thread_followups(null)', 'select public.lc_mcp_thread_offers(null)',
                            'select public.lc_mcp_thread_contact_eligibility(null)',
                            'select public.lc_mcp_operator_tasks(0)', 'select public.lc_mcp_operator_tasks(101)'] loop
    begin
      execute 'set local role lc_mcp_reader';
      execute st;
      execute 'reset role';
      fails := fails || ('C/F: NOT REFUSED: ' || st);
    exception when invalid_parameter_value then null;
      when others then fails := fails || format('C/F: %s refused with %s, not 22023', st, sqlstate);
    end;
  end loop;
  -- the receipt join, once the optional link #28 table exists (created here, discarded with this transaction)
  create schema action_gateway;
  create table action_gateway.seller_action_receipts (intent_id uuid primary key, org_id uuid not null, action text not null, state text not null, code text, queue_row_id text, updated_at timestamptz not null default now());
  insert into action_gateway.seller_action_receipts values
    ('00000000-0000-4000-8000-000000000c01', '00000000-0000-4000-8000-0000000000a1', 'queue_authorized_reply', 'executing', null, '9002', now() - interval '2 days'),
    ('00000000-0000-4000-8000-000000000c02', '00000000-0000-4000-8000-0000000000a1', 'queue_authorized_reply', 'failed', 'PROVIDER_REJECTED', '9002', now() - interval '47 hours'),
    ('00000000-0000-4000-8000-000000000c03', '00000000-0000-4000-8000-0000000000a1', 'execute_authorized_offer', 'enqueued', null, '9003', now() - interval '1 hour');
  execute 'set local role lc_mcp_reader';
  c := public.lc_mcp_thread_execution_log(t107, 10);
  execute 'reset role';
  if (c#>>'{sources,seller_action_receipts}')::boolean is not true or c#>>'{queue_rows,1,receipt,state}' <> 'failed' or c#>>'{queue_rows,1,receipt,code}' <> 'PROVIDER_REJECTED'
     or c#>>'{queue_rows,0,receipt,state}' <> 'enqueued' or c#>'{queue_rows,2,receipt}' is distinct from 'null'::jsonb then
    fails := fails || ('C: receipt join ' || (c->'queue_rows')::text);
  end if;
  if c::text like '%intent_id%' or c::text like '%org_id%' then fails := fails || 'C: receipt ids leaked'::text; end if;
  -- a database without automation_events: reported absent, never a failure
  drop table public.automation_events cascade;
  execute 'set local role lc_mcp_reader';
  c := public.lc_mcp_thread_execution_log(t107, 10);
  execute 'reset role';
  if (c#>>'{sources,automation_events}')::boolean is not false or (c->>'events_returned')::int <> 0 or (c->>'queue_returned')::int <> 3 then fails := fails || 'C: automation_events absence'::text; end if;

  -- ------------------------------------------------------------------ D. offers
  begin
    execute 'set local role lc_mcp_reader';
    c := public.lc_mcp_thread_offers(t107);
    c2 := public.lc_mcp_thread_offers(tnone);
    execute 'reset role';
  exception when others then fails := fails || ('D: call failed ' || sqlstate || ' ' || sqlerrm); c := '{}'; c2 := '{}';
  end;
  if (c->>'thread_found')::boolean is not true or (c->>'offers_returned')::int <> 2 or (c->>'offers_total')::int <> 2 or (c->>'opportunities_returned')::int <> 1 then fails := fails || ('D: shape ' || left(c::text, 300)); end if;
  if c#>>'{offers,0,offer_id}' <> 'OFF-9-2' or c#>>'{offers,0,direction}' <> 'inbound' or c#>>'{offers,0,offer_type}' <> 'counter' or (c#>>'{offers,0,purchase_price}')::numeric <> 175000 or c#>>'{offers,0,status}' <> 'active' then fails := fails || ('D: counter ' || (c#>'{offers,0}')::text); end if;
  if c#>>'{offers,1,offer_id}' <> 'OFF-9-1' or c#>>'{offers,1,direction}' <> 'outbound' or (c#>>'{offers,1,authorized_ceiling}')::numeric <> 160000 or c#>>'{offers,1,status}' <> 'superseded' or (c#>>'{offers,1,send_bound}')::boolean is not true then fails := fails || ('D: offer ' || (c#>'{offers,1}')::text); end if;
  if c#>>'{opportunities,0,id}' <> '00000000-0000-4000-8000-000000000209' or c#>>'{opportunities,0,acquisition_stage}' <> 'negotiation' or c#>>'{opportunities,0,opportunity_status}' <> 'open'
     or c#>>'{opportunities,0,next_action}' <> 'Review the 175000 counter from +[digits withheld]' or (c#>>'{opportunities,0,asking_price}')::numeric <> 185000 then
    fails := fails || ('D: opportunity ' || (c->'opportunities')::text);
  end if;
  if (c2->>'thread_found')::boolean is not false then fails := fails || 'D: unknown thread found'::text; end if;
  txt := c::text;
  if txt like '%5550161%' or txt like '%dedupe_key%' or txt like '%thread_key%' or txt like '%OFF-1-1%' then fails := fails || ('D: leaked: ' || left(txt, 300)); end if;

  -- ------------------------------------------------------------------ E. eligibility
  begin
    execute 'set local role lc_mcp_reader';
    c := public.lc_mcp_thread_contact_eligibility(t107);
    execute 'reset role';
  exception when others then fails := fails || ('E: call failed ' || sqlstate || ' ' || sqlerrm); c := '{}';
  end;
  if (c->>'thread_found')::boolean is not true or (c->>'eligible_for_outreach')::boolean is not true or jsonb_array_length(c->'blocking_reasons') <> 0 then fails := fails || ('E: 107 ' || left(c::text, 400)); end if;
  if (c#>>'{suppression_list,active}')::int <> 0 or (c#>>'{automation_suppressions,active}')::int <> 0 or (c#>>'{holds,active}')::int <> 0 or c#>>'{contact_property,role}' <> 'confirmed_owner'
     or c#>>'{phone_rows,0,contact_status}' <> 'active' or (c#>>'{thread_flags,has_thread_key}')::boolean is not true or c->>'rule' not like 'eligible = %' then
    fails := fails || ('E: 107 inputs ' || left(c::text, 400));
  end if;
  if (c#>>'{sources,automation_suppressions}')::boolean is not true or (c#>>'{sources,automation_hold_for}')::boolean is not true or (c#>>'{sources,contact_property_resolution}')::boolean is not true then fails := fails || 'E: sources'::text; end if;
  execute 'set local role lc_mcp_reader';
  c := public.lc_mcp_thread_contact_eligibility(t101);
  c2 := public.lc_mcp_thread_contact_eligibility(t102);
  execute 'reset role';
  if (c->>'eligible_for_outreach')::boolean is not false or not (c->'blocking_reasons' @> '["hold_blocks_ai_action"]') or jsonb_array_length(c->'blocking_reasons') <> 1
     or (c#>>'{holds,active}')::int <> 1 or c#>>'{holds,rows,0,reason_category}' <> 'ownership_attribution_unresolved' or c#>>'{holds,rows,0,matched_on}' <> 'thread' then
    fails := fails || ('E: 101 ' || left(c::text, 400));
  end if;
  if (c2->>'eligible_for_outreach')::boolean is not false
     or not (c2->'blocking_reasons' @> '["thread_suppressed","thread_opt_out","contactability_opted_out","suppression_list_active","automation_suppression_active"]')
     or (c2#>>'{suppression_list,active}')::int <> 1 or c2#>>'{suppression_list,rows,0,type}' <> 'opt_out'
     or (c2#>>'{automation_suppressions,active}')::int <> 1 or c2#>>'{automation_suppressions,rows,0,type}' <> 'opt_out' then
    fails := fails || ('E: 102 ' || left(c2::text, 500));
  end if;
  execute 'set local role lc_mcp_reader';
  c := public.lc_mcp_thread_contact_eligibility(tnone);
  execute 'reset role';
  if (c->>'thread_found')::boolean is not false then fails := fails || 'E: unknown thread found'::text; end if;
  txt := c2::text || (public.lc_mcp_thread_contact_eligibility(t107))::text || (public.lc_mcp_thread_contact_eligibility(t101))::text;
  if txt like '%5550161%' or txt ~ '\+1555' or txt like '%hold_key%' or txt like '%ownership_denial%' or txt like '%"thread_key"%' then fails := fails || ('E: leaked: ' || left(txt, 400)); end if;

  -- ------------------------------------------------------------------ F. operator tasks
  begin
    execute 'set local role lc_mcp_reader';
    c := public.lc_mcp_operator_tasks(10);
    c2 := public.lc_mcp_operator_tasks(2);
    execute 'reset role';
  exception when others then fails := fails || ('F: call failed ' || sqlstate || ' ' || sqlerrm); c := '{}'; c2 := '{}';
  end;
  if (c->>'returned')::int <> 3 or (c->>'has_more')::boolean or (c#>>'{counts,open}')::int <> 2 or (c#>>'{counts,acknowledged}')::int <> 1 or (c#>>'{counts,critical}')::int <> 1 or (c#>>'{counts,escalated}')::int <> 1 then fails := fails || ('F: shape ' || left(c::text, 400)); end if;
  if c#>>'{rows,0,kind}' <> 'lost_conversation' or c#>>'{rows,1,kind}' <> 'escalation' or c#>>'{rows,2,kind}' <> 'pipeline_mismatch' then fails := fails || ('F: order ' || (c->'rows')::text); end if;
  if c#>>'{rows,0,title}' <> 'Seller replied and nobody answered (+[digits withheld])' or c#>>'{rows,0,subject_id}' <> '00000000-0000-4000-8000-000000000107' or c#>>'{rows,0,severity}' <> 'warning' then fails := fails || ('F: title ' || (c#>'{rows,0}')::text); end if;
  if c#>>'{rows,1,state}' <> 'acknowledged' or c#>>'{rows,1,acknowledged_at}' is null or (c#>>'{rows,1,escalated}')::boolean is not true then fails := fails || 'F: acknowledged row'::text; end if;
  if (c2->>'returned')::int <> 2 or (c2->>'has_more')::boolean is not true then fails := fails || 'F: limit'::text; end if;
  txt := c::text;
  if txt like '%5550161%' or txt like '%detail%' or txt like '%call back%' or txt like '%Recovery candidate%' or txt like '%dedupe%' then fails := fails || ('F: leaked: ' || left(txt, 400)); end if;

  -- ------------------------------------------------------------------ G. self-check
  fns := base_fns || new_fns;
  foreach f in array optional_fns loop
    if to_regprocedure(f) is not null then fns := fns || f; end if;
  end loop;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if not coalesce((rep->>'ok')::boolean, false) then fails := fails || ('G: self-check ' || (rep->'findings')::text); end if;
  -- the list WITHOUT the five must name them: the server refuses a database whose definer set it does not know
  rep := public.lc_mcp_reader_self_check(rels, array(select x from unnest(fns) x where not (x = any (new_fns))), 'lc_mcp_reader');
  if coalesce((rep->>'ok')::boolean, false) or rep::text not like '%lc_mcp_thread_followups%' or rep::text not like '%lc_mcp_operator_tasks%' then
    fails := fails || ('G: the shorter list does not name the new definers: ' || left(rep::text, 300));
  end if;

  -- a database without agent.ops_work_item: reported absent, never a failure (dropped here, discarded with this transaction)
  drop table agent.ops_work_item;
  execute 'set local role lc_mcp_reader';
  c := public.lc_mcp_operator_tasks(10);
  execute 'reset role';
  if (c#>>'{sources,ops_work_item}')::boolean is not false or (c->>'returned')::int <> 0 or c->'counts' is distinct from 'null'::jsonb then fails := fails || ('F: ops_work_item absence ' || c::text); end if;

  if array_length(fails, 1) > 0 then raise exception 'posttest: % failure(s): %', array_length(fails, 1), array_to_string(fails, E'\n  '); end if;
  raise notice 'posttest: acquisition reads ok (privileges, followups, execution log + receipts, offers, eligibility, operator tasks, optional sources, self-check)';
end $$;
rollback;
