-- POSTTEST for PROPOSED_20261026120000_lc_mcp_conversation_intel.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production. One transaction, ends in ROLLBACK.
-- Seeds: mcp/leadcommand-mcp/migrations/test/lc_mcp_conversation_intel_emulation.sql (synthetic).
--
-- Every call runs AS lc_mcp_reader (SET LOCAL ROLE inside an exception block). It proves:
--   A. privileges: the role can EXECUTE the four functions and still cannot read message_events,
--      contact_property_resolution or the holds registry directly; PUBLIC / anon / authenticated /
--      service_role cannot EXECUTE them;
--   B. lc_mcp_lead_conversation: the lead's thread is found; messages come back newest first by the
--      row's FIRST write (created_at), not the rewritten event_timestamp; real text, direction and
--      delivery states; a row about another property is counted, never returned; the unknown-inbound
--      row (no thread key) is attributed by phone; keyset pages never overlap and cover everything;
--      no phone number, thread key or raw payload anywhere outside a message body; the history state
--      separates present / missing / empty / outside_window / no_thread; an unknown property is not
--      "on record"; suppression and hold INPUTS per thread; the thread-id path; bounds refused (22023);
--   C. lc_mcp_conversation_worklist: categories, exact totals, verification against message_events,
--      inbound evidence, keyset paging, the market filter, bounds;
--   D. lc_mcp_pipeline_counts: exact grouped counts, not_set, remainder, bounds;
--   E. lc_mcp_conversation_signals: exact counts;
--   G. suppression conflicts in both directions (seeded inside this transaction), as a worklist category and as counts;
--   F. the reader self-check passes with the extended function list and still names an unexpected definer.
begin;

do $$
declare
  fails text[] := '{}';
  c jsonb; c2 jsonb; c3 jsonb; w jsonb; p jsonb; s jsonb; rep jsonb;
  ids text[]; seen text[] := '{}'; cur_at timestamptz; cur_id text; pages int := 0; txt text;
  st text; f text; r text;
  rels text[] := array['acquisition_opportunities','campaign_target_graph','campaign_targets','campaigns','census_geo_metrics','eg_buyer_index','eg_property_facts','emails','inbox_thread_state','master_owners','mi_geo_period_rollup','mi_rollup_builds','mv_map_market_sales','phones','preforeclosure_status_v2','probate_status','properties','property_acquisition_scores','prospects','sms_suppression_list'];
  fns text[] := array['public.campaign_entity_contact_review_flags(text[])','public.entity_graph_property_records(text)','public.lc_mcp_action_center(uuid,text,boolean,uuid,integer)','public.lc_mcp_conversation_signals(integer,text)','public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)','public.lc_mcp_followup_intent_health()','public.lc_mcp_lead_conversation(text,uuid,integer,timestamp with time zone,text,integer)','public.lc_mcp_operator_role(uuid,uuid)','public.lc_mcp_ops_finding(uuid,text)','public.lc_mcp_ops_research_valuation_snapshot()','public.lc_mcp_pipeline_counts(text,text,text,integer)','public.lc_mcp_reader_self_check(text[],text[],name)','public.lc_mcp_thread_hold_status(uuid)'];
  new_fns text[] := array['public.lc_mcp_lead_conversation(text,uuid,integer,timestamptz,text,integer)','public.lc_mcp_conversation_worklist(text,integer,text,timestamptz,uuid,integer)','public.lc_mcp_pipeline_counts(text,text,text,integer)','public.lc_mcp_conversation_signals(integer,text)'];
begin
  -- ------------------------------------------------------------------ A. privileges
  foreach f in array new_fns loop
    if not has_function_privilege('lc_mcp_reader', f, 'EXECUTE') then fails := fails || ('A: lc_mcp_reader cannot execute ' || f); end if;
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, f, 'EXECUTE') then fails := fails || format('A: %s can execute %s', r, f); end if;
    end loop;
    if exists (select 1 from pg_proc x, aclexplode(coalesce(x.proacl, acldefault('f', x.proowner))) a
                where x.oid = f::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') then fails := fails || ('A: PUBLIC can execute ' || f); end if;
    if (select provolatile from pg_proc where oid = f::regprocedure) <> 's' or not (select prosecdef from pg_proc where oid = f::regprocedure)
       or (select proconfig from pg_proc where oid = f::regprocedure) is distinct from array['search_path=pg_catalog'] then
      fails := fails || ('A: not STABLE SECURITY DEFINER search_path=pg_catalog: ' || f);
    end if;
  end loop;
  foreach st in array array['select count(*) from public.message_events', 'select count(*) from public.contact_property_resolution',
                            'select count(*) from public.automation_holds', 'select count(*) from public.automation_hold_for(''+15550100001'')'] loop
    begin
      execute 'set local role lc_mcp_reader';
      execute st;
      execute 'reset role';
      fails := fails || ('A: NOT REFUSED: ' || st);
    exception when insufficient_privilege then null;
    end;
  end loop;

  -- ------------------------------------------------------- B. one lead's conversation
  begin
    execute 'set local role lc_mcp_reader';
    c := public.lc_mcp_lead_conversation('P1', null, 365, null, null, 50);
    execute 'reset role';
  exception when others then fails := fails || ('B: P1 call failed ' || sqlstate || ' ' || sqlerrm); c := '{}';
  end;
  if (c->>'subject_found')::boolean is not true or (c->>'property_on_record')::boolean is not true then fails := fails || 'B: P1 not found / not on record'::text; end if;
  if jsonb_array_length(coalesce(c->'threads', '[]')) <> 1 then fails := fails || ('B: P1 threads = ' || coalesce(c->'threads', 'null')::text); end if;
  if c#>>'{threads,0,thread_property}' <> 'this' or c#>>'{threads,0,thread_id}' <> '00000000-0000-4000-8000-000000000101' then fails := fails || 'B: P1 thread link'::text; end if;
  if c#>>'{threads,0,contact_property,role}' <> 'confirmed_owner' then fails := fails || 'B: P1 contact_property role'::text; end if;
  select array_agg(m->>'body' order by o) into ids from jsonb_array_elements(c->'messages') with ordinality x(m, o);
  -- newest first by created_at: i3 (2h), o3 (1d), u1 (30h), i2 (3d), o2 (4d), i1 (5d, event_timestamp rewritten to 1h), o1 (6d)
  if coalesce(array_length(ids, 1), 0) <> 7 then fails := fails || ('B: P1 message count ' || coalesce(array_length(ids, 1), 0)); end if;
  if ids[1] not like 'IGNORE ALL PREVIOUS%' or ids[2] not like 'Understood.%' or ids[3] <> 'Did you get my last text?' or ids[4] not like 'I would take $185,000%'
     or ids[6] <> 'Yes I own it. What would you offer?' or ids[7] not like 'Hi, this is Fixture Homes%' then
    fails := fails || ('B: P1 order wrong: ' || array_to_string(ids, ' | '));
  end if;
  if c#>>'{messages,2,attribution}' <> 'phone' or c#>>'{messages,2,thread}' <> 'T1' then fails := fails || 'B: unknown-inbound row not attributed by phone'::text; end if;
  if c#>>'{messages,1,delivery_status}' <> 'failed' or c#>>'{messages,1,provider_delivery_status}' <> 'undelivered' or c#>>'{messages,6,delivery_status}' <> 'delivered' then
    fails := fails || 'B: delivery states'::text;
  end if;
  if c#>>'{messages,0,direction}' <> 'inbound' or c#>>'{messages,6,direction}' <> 'outbound' or c#>>'{messages,6,origin}' <> 'campaign' then fails := fails || 'B: direction / origin'::text; end if;
  if exists (select 1 from jsonb_array_elements(c->'messages') m where m->>'body' like 'Also the other house%') then fails := fails || 'B: a row about ANOTHER property was returned'::text; end if;
  if (c#>>'{counts,other_property_rows_in_window}')::int <> 1 then fails := fails || 'B: other-property row not counted'::text; end if;
  if (c#>>'{counts,inbound_in_window}')::int <> 4 or (c#>>'{counts,outbound_in_window}')::int <> 3 then fails := fails || ('B: counts ' || (c->'counts')::text); end if;
  if c#>>'{history,state}' <> 'present' or (c->>'has_more')::boolean then fails := fails || 'B: P1 history / has_more'::text; end if;
  if c#>>'{threads,0,eligibility_inputs,holds,categories,0}' <> 'ownership_attribution_unresolved' then fails := fails || ('B: P1 hold inputs ' || coalesce(c#>>'{threads,0,eligibility_inputs,holds}', 'null')); end if;
  if c#>>'{threads,0,eligibility_inputs,phone_rows,0,phone_type}' <> 'wireless' then fails := fails || 'B: phone row inputs'::text; end if;
  -- nothing phone-shaped outside a message body; no raw payload, no thread key
  txt := (c - 'messages')::text || (select coalesce(string_agg((m - 'body')::text, ''), '') from jsonb_array_elements(c->'messages') m);
  if txt ~ '\+1555' or txt ~ '555-?01' or txt like '%payload%' or txt like '%thread_key%' or txt like '%provider payload%' then fails := fails || ('B: identifier leaked: ' || left(txt, 400)); end if;

  -- keyset pages of 3 cover all 7 exactly once
  cur_at := null; cur_id := null;
  loop
    pages := pages + 1;
    execute 'set local role lc_mcp_reader';
    c2 := public.lc_mcp_lead_conversation('P1', null, 365, cur_at, cur_id, 3);
    execute 'reset role';
    select seen || coalesce(array_agg(m->>'id'), '{}') into seen from jsonb_array_elements(c2->'messages') m;
    exit when not (c2->>'has_more')::boolean or pages > 5;
    cur_at := (c2->'messages'->-1->>'created_at')::timestamptz; cur_id := c2->'messages'->-1->>'id';
  end loop;
  if pages <> 3 or cardinality(seen) <> 7 or (select count(distinct x) from unnest(seen) x) <> 7 then fails := fails || format('B: paging pages=%s seen=%s', pages, cardinality(seen)); end if;

  -- P2: two threads (its own, opted out in Spanish + the P1 seller's phone on its graph); suppression inputs
  execute 'set local role lc_mcp_reader';
  c2 := public.lc_mcp_lead_conversation('P2', null, 365, null, null, 50);
  execute 'reset role';
  if jsonb_array_length(c2->'threads') <> 2 then fails := fails || ('B: P2 threads ' || (c2->'threads')::text); end if;
  select t into c3 from jsonb_array_elements(c2->'threads') t where t->>'thread_id' = '00000000-0000-4000-8000-000000000102';
  if c3 is null or (c3#>>'{eligibility_inputs,suppression_list,active_rows}')::int <> 1 or c3#>>'{eligibility_inputs,suppression_list,types,0}' <> 'opt_out'
     or c3#>>'{eligibility_inputs,latest_opt_out_at}' is null or (c3#>>'{eligibility_inputs,thread_flags,opt_out}')::boolean is not true
     or c3#>>'{eligibility_inputs,phone_rows,0,contact_status}' <> 'opted_out' then
    fails := fails || ('B: P2 suppression inputs ' || coalesce(c3::text, 'null'));
  end if;
  select t into c3 from jsonb_array_elements(c2->'threads') t where t->>'thread_id' = '00000000-0000-4000-8000-000000000101';
  if c3 is null or c3->>'thread_property' <> 'other' or c3#>>'{contact_property,role}' <> 'not_owner' then fails := fails || 'B: P2 sees the P1 seller''s thread as another property''s, role not_owner'::text; end if;
  if not exists (select 1 from jsonb_array_elements(c2->'messages') m where m->>'body' = 'ALTO' and (m->>'is_opt_out')::boolean and m->>'language' = 'es') then fails := fails || 'B: P2 opt-out message'::text; end if;
  if not exists (select 1 from jsonb_array_elements(c2->'messages') m where m->>'body' like 'Also the other house%' and m->>'attribution' = 'property') then fails := fails || 'B: P2 own row'::text; end if;

  -- history states
  foreach st in array array['P3:missing', 'P4:empty', 'P5:outside_window', 'P6:no_thread', 'NOPE:no_thread'] loop
    execute 'set local role lc_mcp_reader';
    c2 := public.lc_mcp_lead_conversation(split_part(st, ':', 1), null, 365, null, null, 10);
    execute 'reset role';
    if c2#>>'{history,state}' is distinct from split_part(st, ':', 2) then fails := fails || format('B: %s history = %s', st, c2#>>'{history,state}'); end if;
  end loop;
  execute 'set local role lc_mcp_reader';
  c2 := public.lc_mcp_lead_conversation('NOPE', null, 365, null, null, 10);
  c3 := public.lc_mcp_lead_conversation('P5', null, 1095, null, null, 10);
  execute 'reset role';
  if (c2->>'property_on_record')::boolean is not false then fails := fails || 'B: unknown property reported on record'::text; end if;
  if c3#>>'{history,state}' <> 'present' or c3#>>'{messages,0,body}' not like 'Not interested%' then fails := fails || 'B: P5 with a 1095-day window'::text; end if;

  -- the thread-id path: every row on the thread, with its property id; an unknown thread is not found
  execute 'set local role lc_mcp_reader';
  c2 := public.lc_mcp_lead_conversation(null, '00000000-0000-4000-8000-000000000101', 365, null, null, 50);
  c3 := public.lc_mcp_lead_conversation(null, '00000000-0000-4000-8000-0000000009ff', 365, null, null, 50);
  execute 'reset role';
  if jsonb_array_length(c2->'messages') <> 8 or c2#>>'{threads,0,thread_property_id}' <> 'P1'
     or not exists (select 1 from jsonb_array_elements(c2->'messages') m where m->>'property_id' = 'P2' and m->>'attribution' = 'set') then
    fails := fails || ('B: thread path ' || jsonb_array_length(c2->'messages'));
  end if;
  if (c3->>'subject_found')::boolean is not false then fails := fails || 'B: unknown thread found'::text; end if;

  -- bounds
  foreach st in array array[
      'select public.lc_mcp_lead_conversation(null, null, 30, null, null, 10)',
      'select public.lc_mcp_lead_conversation(''P1'', ''00000000-0000-4000-8000-000000000101'', 30, null, null, 10)',
      'select public.lc_mcp_lead_conversation(''P1; drop table x'', null, 30, null, null, 10)',
      'select public.lc_mcp_lead_conversation(''P1'', null, 30, null, null, 51)',
      'select public.lc_mcp_lead_conversation(''P1'', null, 1096, null, null, 10)',
      'select public.lc_mcp_lead_conversation(''P1'', null, 30, now(), null, 10)',
      'select public.lc_mcp_conversation_worklist(''everything'', 30, null, null, null, 10)',
      'select public.lc_mcp_conversation_worklist(''recent_inbound'', 30, repeat(''x'', 61), null, null, 10)',
      'select public.lc_mcp_conversation_worklist(''recent_inbound'', 30, null, null, null, 26)',
      'select public.lc_mcp_conversation_worklist(''recent_inbound'', 366, null, null, null, 10)',
      'select public.lc_mcp_conversation_worklist(''recent_inbound'', 30, null, now(), null, 10)',
      'select public.lc_mcp_pipeline_counts(''owner_name'', null, null, 10)',
      'select public.lc_mcp_pipeline_counts(''market'', null, ''Texas'', 10)',
      'select public.lc_mcp_pipeline_counts(''market'', null, null, 101)',
      'select public.lc_mcp_conversation_signals(0, null)'] loop
    begin
      execute 'set local role lc_mcp_reader';
      execute st;
      execute 'reset role';
      fails := fails || ('B/C/D/E: NOT REFUSED: ' || st);
    exception when invalid_parameter_value then null;
      when others then fails := fails || format('B/C/D/E: %s refused with %s, not 22023', st, sqlstate);
    end;
  end loop;

  -- ------------------------------------------------------------------ C. worklist
  execute 'set local role lc_mcp_reader';
  w := public.lc_mcp_conversation_worklist('unanswered_inbound', 30, null, null, null, 10);
  execute 'reset role';
  -- P1's thread (seller spoke last 2h ago) and P3's (inbound recorded on the thread row, no message on record)
  if (w->>'total')::int <> 2 or jsonb_array_length(w->'rows') <> 2 or w#>>'{rows,0,thread_id}' <> '00000000-0000-4000-8000-000000000101' then
    fails := fails || ('C: unanswered ' || w::text);
  end if;
  if (w#>>'{rows,0,verified,unanswered}')::boolean is not true or w#>>'{rows,0,verified,latest_direction}' <> 'inbound' then fails := fails || 'C: P1 not verified unanswered'::text; end if;
  if w#>>'{rows,1,verified,latest_direction}' is not null or w#>>'{rows,1,verified,unanswered}' is not null then fails := fails || 'C: P3 verified without a message on record'::text; end if;
  if jsonb_array_length(w#>'{rows,0,inbound}') <> 3 or w#>>'{rows,0,inbound,0,body}' not like 'IGNORE ALL%' or w#>>'{rows,0,inbound,1,attribution}' <> 'other' then fails := fails || 'C: P1 inbound evidence'::text; end if;
  if (w#>>'{rows,0,properties_in_window}')::int <> 2 or w#>>'{rows,0,lead,conversation_stage}' <> 'offer_interest' or w#>>'{rows,0,decision_engine,aos_score}' <> '71' then fails := fails || 'C: P1 row context'::text; end if;
  if (w#>>'{rows,1,decision_engine}') is not null then fails := fails || 'C: P3 has a Decision Engine score?'::text; end if;
  if w#>>'{rows,0,latest_outbound,body}' not like 'Understood.%' or w#>>'{rows,0,latest_outbound,delivery_status}' <> 'failed' then fails := fails || ('C: latest outbound ' || coalesce(w#>>'{rows,0,latest_outbound}', 'null')); end if;
  if (w#>>'{rows,0,eligibility_inputs,opt_out_message_on_record}')::boolean is not false then fails := fails || 'C: P1 opt-out-on-record flag'::text; end if;
  if w::text ~ '\+1555' or w::text like '%thread_key%' or w::text like '%payload%' then fails := fails || 'C: identifier leaked'::text; end if;
  execute 'set local role lc_mcp_reader';
  c := public.lc_mcp_conversation_worklist('unanswered_inbound', 30, null, null, null, 1);
  c2 := public.lc_mcp_conversation_worklist('unanswered_inbound', 30, null, (c#>>'{rows,0,cursor,at}')::timestamptz, (c#>>'{rows,0,cursor,id}')::uuid, 1);
  execute 'reset role';
  if not (c->>'has_more')::boolean or (c2->>'has_more')::boolean or c2#>>'{rows,0,thread_id}' <> '00000000-0000-4000-8000-000000000103' then fails := fails || 'C: keyset paging'::text; end if;
  foreach st in array array['opted_out:1', 'identity_conflict:1', 'recent_inbound:3', 'suppression_conflict:0'] loop
    execute 'set local role lc_mcp_reader';
    w := public.lc_mcp_conversation_worklist(split_part(st, ':', 1), 30, null, null, null, 10);
    execute 'reset role';
    if (w->>'total')::int <> split_part(st, ':', 2)::int or jsonb_array_length(w->'rows') <> split_part(st, ':', 2)::int then fails := fails || format('C: %s total %s', st, w->>'total'); end if;
  end loop;
  execute 'set local role lc_mcp_reader';
  w := public.lc_mcp_conversation_worklist('recent_inbound', 30, 'Other Metro, TX', null, null, 10);
  execute 'reset role';
  if (w->>'total')::int <> 0 then fails := fails || 'C: market filter'::text; end if;

  -- ------------------------------------------------------------------ D. pipeline counts
  execute 'set local role lc_mcp_reader';
  p := public.lc_mcp_pipeline_counts('market', null, null, 10);
  c := public.lc_mcp_pipeline_counts('conversation_stage', null, 'tx', 1);
  execute 'reset role';
  if (p->>'total')::int <> 6 or p#>>'{groups,0,value}' <> 'Fixture Metro, TX' or (p#>>'{groups,0,n}')::int <> 5 or (p#>>'{groups,1,n}')::int <> 1 then fails := fails || ('D: market ' || p::text); end if;
  if (c->>'total')::int <> 6 or (c->>'not_set')::int <> 2 or (c#>>'{groups,0,n}')::int <> 2 or (c->>'other_groups_n')::int <> 2 then fails := fails || ('D: stage ' || c::text); end if;

  -- ------------------------------------------------------------------ E. signals
  execute 'set local role lc_mcp_reader';
  s := public.lc_mcp_conversation_signals(30, null);
  execute 'reset role';
  if (s#>>'{threads,with_inbound}')::int <> 3 or (s#>>'{threads,unanswered_inbound}')::int <> 2 or (s#>>'{threads,opted_out}')::int <> 1
     or (s#>>'{threads,suppressed}')::int <> 1 or (s#>>'{threads,not_contactable}')::int <> 1 then fails := fails || ('E: threads ' || (s->'threads')::text); end if;
  if (s#>>'{messages,inbound}')::int <> 6 or (s#>>'{messages,inbound_opt_out}')::int <> 1 or (s#>>'{messages,inbound_unknown_sender}')::int <> 1
     or (s#>>'{messages,outbound}')::int <> 4 then fails := fails || ('E: messages ' || (s->'messages')::text); end if;
  if (s#>>'{identity,phones_on_several_properties}')::int <> 1 or (s#>>'{identity,threads_on_several_properties_in_window}')::int <> 1 then fails := fails || ('E: identity ' || (s->'identity')::text); end if;
  if (s#>>'{decision_engine,leads_in_conversation}')::int <> 3 or (s#>>'{decision_engine,without_decision_engine}')::int <> 2 then fails := fails || ('E: decision engine ' || (s->'decision_engine')::text); end if;

  if (s#>>'{threads,opt_out_without_active_suppression}')::int <> 0 or (s#>>'{threads,active_suppression_marked_contactable}')::int <> 0 then fails := fails || ('E: integrity ' || (s->'threads')::text); end if;

  -- ------------------------------------------------------- G. suppression conflicts (seeded here, rolled back)
  insert into public.sms_suppression_list (id, phone_e164, phone_number, is_active, suppression_type, suppression_reason)
    values ('00000000-0000-4000-8000-0000000000e3', '+15550100003', '+15550100003', true, 'manual', 'fixture conflict');
  update public.inbox_thread_state set opt_out = true where thread_key = '+15550100001';
  execute 'set local role lc_mcp_reader';
  w := public.lc_mcp_conversation_worklist('suppression_conflict', 30, null, null, null, 10);
  s := public.lc_mcp_conversation_signals(30, null);
  execute 'reset role';
  -- P3: suppressed but marked contactable; P1: flagged opted out with no active suppression row
  if (w->>'total')::int <> 2 or not (w->'rows' @> '[{"thread_id":"00000000-0000-4000-8000-000000000103"}]' and w->'rows' @> '[{"thread_id":"00000000-0000-4000-8000-000000000101"}]') then fails := fails || ('G: suppression_conflict ' || w::text); end if;
  if (s#>>'{threads,opt_out_without_active_suppression}')::int <> 1 or (s#>>'{threads,active_suppression_marked_contactable}')::int <> 1 then fails := fails || ('G: integrity ' || (s->'threads')::text); end if;

  -- ------------------------------------------------------------------ F. self-check
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if not coalesce((rep->>'ok')::boolean, false) then fails := fails || ('F: self-check ' || (rep->'findings')::text); end if;
  -- the 1.0 list (without the four) must now name them: the server refuses a database whose definer set it does not know
  rep := public.lc_mcp_reader_self_check(rels, array(select x from unnest(fns) x where x not like '%conversation%' and x not like '%pipeline_counts%'), 'lc_mcp_reader');
  if coalesce((rep->>'ok')::boolean, false) or rep::text not like '%lc_mcp_lead_conversation%' then fails := fails || ('F: the 1.0 list does not name the new definers: ' || left(rep::text, 300)); end if;

  if array_length(fails, 1) > 0 then raise exception 'posttest: % failure(s): %', array_length(fails, 1), array_to_string(fails, E'\n  '); end if;
  raise notice 'posttest: conversation intelligence ok (privileges, chronology, attribution, paging, history states, eligibility inputs, worklist, counts, signals, self-check)';
end $$;
rollback;
