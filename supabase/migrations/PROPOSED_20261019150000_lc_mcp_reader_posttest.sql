-- POSTTEST for PROPOSED_20261019150000_lc_mcp_reader.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It runs in one transaction and ends in ROLLBACK. The runner proves the schema is unchanged afterwards.
--
-- Every probe runs AS lc_mcp_reader (SET LOCAL ROLE inside an exception block, so a
-- refused probe also reverts the role). It proves:
--   A. role shape: NOLOGIN (no SQL session can be opened as it), NOINHERIT, no
--      privileged attribute, a member of no role, granted to authenticator;
--   B. SELECT works on every inventory relation and returns the seeded rows (so RLS
--      does not hide them);
--   C. INSERT / UPDATE / DELETE / TRUNCATE are refused BY THE DATABASE on every inventory
--      relation AND on send_queue, sms_templates, system_control, agent.*; and so are
--      SELECT … FOR UPDATE, nextval, CREATE TABLE and CREATE SCHEMA;
--   D. no raw-SQL surface and no write-capable RPC is executable: the definer raw-SQL
--      function and definer writers are refused (42501). An invoker raw-SQL function
--      that PUBLIC can execute still cannot write or read outside the inventory. The
--      allowlisted RPCs work;
--   D2. the five operations read functions return their projection (and only it): the org's
--      newest allowlisted finding, the research / valuation snapshot, an Action Center page
--      (limit + 1, no refs beyond the conversation), the holds covering a thread (category +
--      matched scope; released holds excluded; never a key, id or reason text), the follow-up
--      health counts; out-of-bound inputs are refused with 22023. The role cannot call the
--      underlying automation_hold_for / agent functions nor read their tables directly;
--   E. the self-check function, which the migration and the server's boot check share,
--      reports ok for the applied state and a NAMED finding for each way the credential
--      could become write-capable or incomplete.
begin;

do $$
declare
  rels text[] := array['acquisition_opportunities','campaign_target_graph','campaign_targets','campaigns','census_geo_metrics','eg_buyer_index','eg_property_facts','emails','inbox_thread_state','master_owners','mi_geo_period_rollup','mi_rollup_builds','mv_map_market_sales','phones','preforeclosure_status_v2','probate_status','properties','property_acquisition_scores','prospects','sms_suppression_list'];
  -- write sentinels + the sources the operations read functions read AS THE OWNER (the role holds nothing on them)
  sentinels text[] := array['public.send_queue','public.sms_templates','public.system_control','public.message_events','agent.operator_membership','agent.run','agent.org',
                            'public.automation_holds','public.followup_intents','public.v_followup_intent_health','public.v_followup_intent_reasons',
                            'agent.finding','agent.conversation_action_state'];
  fns text[] := array['public.campaign_entity_contact_review_flags(text[])','public.entity_graph_property_records(text)','public.lc_mcp_action_center(uuid,text,boolean,uuid,integer)','public.lc_mcp_followup_intent_health()','public.lc_mcp_operator_role(uuid,uuid)','public.lc_mcp_ops_finding(uuid,text)','public.lc_mcp_ops_research_valuation_snapshot()','public.lc_mcp_reader_self_check(text[],text[],name)','public.lc_mcp_thread_hold_status(uuid)'];
  org uuid := '00000000-0000-4000-8000-0000000000a1';
  h1 jsonb; h2 jsonb; h3 jsonb; h4 jsonb; ac jsonb; ac2 jsonb; fu jsonb; rv jsonb; sup jsonb; nov jsonb;
  t text; q text; col text; k "char"; n bigint; v text; j jsonb; rep jsonb;
  fails text[] := '{}';
  probes int := 0;
  denied_kinds text[] := '{}';
begin
  -- ---------------------------------------------------------------- A. role shape
  if not exists (select 1 from pg_roles where rolname = 'lc_mcp_reader' and not rolcanlogin and not rolinherit and not rolsuper and not rolbypassrls
                   and not rolcreatedb and not rolcreaterole and not rolreplication) then fails := fails || 'A: role attributes'::text; end if;
  if exists (select 1 from pg_auth_members m where m.member = 'lc_mcp_reader'::regrole) then fails := fails || 'A: lc_mcp_reader is a member of a role'::text; end if;
  if not pg_has_role('authenticator', 'lc_mcp_reader', 'SET') then fails := fails || 'A: authenticator cannot SET ROLE lc_mcp_reader'::text; end if;
  if pg_has_role('authenticator', 'lc_mcp_reader', 'USAGE') then fails := fails || 'A: authenticator INHERITS lc_mcp_reader privileges'::text; end if;
  if not exists (select 1 from pg_db_role_setting s where s.setrole = 'lc_mcp_reader'::regrole and 'statement_timeout=5s' = any(s.setconfig)) then fails := fails || 'A: statement_timeout not set'::text; end if;

  -- ------------------------------------------------------- B. SELECT on the inventory
  foreach t in array rels loop
    begin
      execute 'set local role lc_mcp_reader';
      execute format('select count(*) from public.%I', t) into n;
      execute 'reset role';
      if n < 1 then fails := fails || format('B: %s visible rows = %s (RLS hides seeded rows?)', t, n); end if;
    exception when others then
      fails := fails || format('B: select %s failed %s', t, sqlstate);
    end;
  end loop;

  -- ------------------------------------- C. writes refused by the database (sqlstate)
  for t in select format('public.%I', x) from unnest(rels) x union all select unnest(sentinels) loop
    select relkind into k from pg_class where oid = t::regclass;
    select quote_ident(attname) into col from pg_attribute where attrelid = t::regclass and attnum > 0 and not attisdropped order by attnum limit 1;
    foreach q in array array[
      format('insert into %s default values', t),
      format('update %s set %s = %s where false', t, col, col),
      format('delete from %s where false', t),
      format('truncate %s', t)] loop
      probes := probes + 1;
      begin
        execute 'set local role lc_mcp_reader';
        execute q;
        execute 'reset role';
        fails := fails || format('C: NOT REFUSED: %s', q);
      exception
        when insufficient_privilege then null;  -- 42501: refused by privileges (the role cannot even reach the relation)
        when wrong_object_type or feature_not_supported or object_not_in_prerequisite_state then
          -- views / materialized views only: the statement is impossible before privileges are consulted
          if k in ('r', 'p') then fails := fails || format('C: %s on a table refused with %s, not by privileges', q, sqlstate);
          else denied_kinds := denied_kinds || format('%s:%s', split_part(q, ' ', 1), sqlstate); end if;
        when others then fails := fails || format('C: %s → unexpected %s', q, sqlstate);
      end;
    end loop;
  end loop;
  -- non-inventory relations are not even readable
  foreach t in array sentinels loop
    probes := probes + 1;
    begin
      execute 'set local role lc_mcp_reader';
      execute format('select count(*) from %s', t) into n;
      execute 'reset role';
      fails := fails || format('C: %s is READABLE (outside the inventory)', t);
    exception when insufficient_privilege then null; when others then fails := fails || format('C: select %s → %s', t, sqlstate);
    end;
  end loop;
  foreach q in array array[
    'select 1 from public.properties for update',
    'select nextval(''public.send_queue_id_seq'')',
    'create table public.lc_probe_table (x int)',
    'create schema lc_probe_schema',
    'create function public.lc_probe_fn() returns int language sql as ''select 1''',
    'refresh materialized view public.mv_map_market_sales'] loop
    probes := probes + 1;
    begin
      execute 'set local role lc_mcp_reader';
      execute q;
      execute 'reset role';
      fails := fails || format('C: NOT REFUSED: %s', q);
    exception when insufficient_privilege then null; when others then fails := fails || format('C: %s → %s', q, sqlstate);
    end;
  end loop;

  -- ------------------------------------- D. functions: no raw SQL, no write-capable RPC
  foreach q in array array[
    'select public.exec_sql(''delete from public.send_queue'')',                      -- definer raw SQL: no EXECUTE
    'select public.reap_stale_campaign_target_graph_refresh_runs(''1 day'')',          -- definer writer: no EXECUTE
    'select agent.sync_operator_membership(''00000000-0000-4000-8000-0000000000a1'', ''00000000-0000-4000-8000-0000000000b1'')', -- agent writer: no USAGE
    'select public.log_message_event(''x'')',                                           -- invoker writer PUBLIC can call: its INSERT is refused
    'select public.run_sql(''insert into public.send_queue (body) values (''''x'''')'')', -- invoker raw SQL: cannot write
    'select public.run_sql(''update public.system_control set value = ''''on'''''')',  -- invoker raw SQL: cannot write
    'select public.run_sql(''select count(*) from public.sms_templates'')',           -- invoker raw SQL: cannot read outside the inventory
    'select count(*) from public.automation_hold_for(''+15550100001'')',               -- the hold lookup itself: authenticated / service_role only
    'select agent.ops_research_valuation_snapshot(null)',                              -- the operations read: no USAGE on schema agent
    'select public.run_sql(''select count(*) from public.automation_holds'')'] loop     -- invoker raw SQL: the registry is not readable
    probes := probes + 1;
    begin
      execute 'set local role lc_mcp_reader';
      execute q;
      execute 'reset role';
      fails := fails || format('D: NOT REFUSED: %s', q);
    exception when insufficient_privilege then null; when others then fails := fails || format('D: %s → %s', q, sqlstate);
    end;
  end loop;
  begin
    execute 'set local role lc_mcp_reader';
    j := public.entity_graph_property_records('P1');
    select count(*) into n from public.campaign_entity_contact_review_flags(array['P1']);
    v := public.lc_mcp_operator_role('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1');
    rep := public.lc_mcp_reader_self_check(rels, fns);
    execute 'reset role';
    if jsonb_array_length(j->'mortgages') <> 1 then fails := fails || 'D: entity_graph_property_records returned no row'::text; end if;
    if n <> 1 then fails := fails || 'D: campaign_entity_contact_review_flags returned no row'::text; end if;
    if v is distinct from 'owner' then fails := fails || format('D: lc_mcp_operator_role = %s', v); end if;
    if rep->>'current_user' <> 'lc_mcp_reader' then fails := fails || format('D: self-check ran as %s', rep->>'current_user'); end if;
    if not (rep->>'ok')::boolean then fails := fails || format('D: self-check (as the role) not ok: %s', rep->>'findings'); end if;
  exception when others then fails := fails || format('D: allowlisted RPC failed %s %s', sqlstate, sqlerrm);
  end;

  -- ------------------- D2. the operations read functions: shapes, bounds, and NOTHING beyond the projection
  begin
    execute 'set local role lc_mcp_reader';
    sup := public.lc_mcp_ops_finding(org, 'supervisor.summary');
    nov := public.lc_mcp_ops_finding(org, 'valuation.refresh_batch');
    rv := public.lc_mcp_ops_research_valuation_snapshot();
    ac := public.lc_mcp_action_center(org, null, true, null, 10);
    ac2 := public.lc_mcp_action_center(org, null, false, null, 1);
    h1 := public.lc_mcp_thread_hold_status('00000000-0000-4000-8000-000000000101');
    h2 := public.lc_mcp_thread_hold_status('00000000-0000-4000-8000-000000000102');
    h3 := public.lc_mcp_thread_hold_status('00000000-0000-4000-8000-000000000103');
    h4 := public.lc_mcp_thread_hold_status('00000000-0000-4000-8000-0000000009ff');
    fu := public.lc_mcp_followup_intent_health();
    execute 'reset role';
    -- the newest supervisor.summary of THIS org (a later finding of another org is not read)
    if sup->>'job_id' is distinct from 'job_sup_1' or (sup->'value'->>'all_clear')::boolean is distinct from false then fails := fails || format('D2: ops finding = %s', sup); end if;
    if nov is not null then fails := fails || 'D2: a finding type with no row must be null (never zero)'::text; end if;
    if rv->'offers'->>'overdue_no_reply_72h' is distinct from '1' then fails := fails || format('D2: research valuation snapshot = %s', rv); end if;
    if jsonb_array_length(ac->'items') <> 1 or ac->'items'->0->>'state' <> 'needs_attention' or (ac->'items'->0->>'lost')::boolean is not true then fails := fails || format('D2: lost-only page = %s', ac->'items'); end if;
    if jsonb_array_length(ac->'summary') <> 3 then fails := fails || format('D2: action center summary = %s', ac->'summary'); end if;
    if jsonb_array_length(ac2->'items') <> 2 or (ac2->>'limit')::int <> 1 then fails := fails || 'D2: the page must carry limit + 1 rows (has_more)'::text; end if;
    if (ac->'items'->0) ?| array['evidence_refs', 'opportunity_id', 'property_ref', 'org_id', 'job_id', 'derived_from'] then fails := fails || 'D2: action center returned an id / ref beyond the conversation'::text; end if;
    if (h1->>'thread_found')::boolean is not true or jsonb_array_length(h1->'holds') <> 1
       or h1->'holds'->0->>'reason_category' <> 'ownership_attribution_unresolved' or h1->'holds'->0->>'matched_on' <> 'thread' then fails := fails || format('D2: thread 1 hold = %s', h1); end if;
    if jsonb_array_length(h2->'holds') <> 1 or h2->'holds'->0->>'matched_on' <> 'opportunity' or h2->'holds'->0->>'reason_category' <> 'operator_hold'
       or jsonb_array_length(h2->'holds'->0->'blocked_capabilities') <> 2 then fails := fails || format('D2: thread 2 (opportunity) hold = %s', h2); end if;
    if jsonb_array_length(h3->'holds') <> 0 then fails := fails || 'D2: a RELEASED hold was reported'::text; end if;
    if (h4->>'thread_found')::boolean is not false then fails := fails || 'D2: an unknown thread must be thread_found = false'::text; end if;
    if ((h1->'holds') || (h2->'holds'))::text ~ '(\+1555|Fixture Person|fixture_operator_hold|ownership_unresolved:|owner_rule_|[0-9a-f]{8}-[0-9a-f]{4}-)' then fails := fails || format('D2: a hold leaked a key / id / reason text: %s', (h1->'holds') || (h2->'holds')); end if;
    if (fu->'health'->>'planned')::int <> 2 or (fu->'health'->>'held')::int <> 1 or (fu->'health'->>'retrying')::int <> 1 or jsonb_array_length(fu->'reasons') <> 2 then fails := fails || format('D2: follow-up health = %s', fu); end if;
    if (fu->'reasons')::text ~ '\+1555' then fails := fails || 'D2: follow-up reasons leaked a thread key'::text; end if;
  exception when others then fails := fails || format('D2: operations read failed %s %s', sqlstate, sqlerrm);
  end;
  -- bounded inputs: a finding type outside the four, an unknown state, a null thread → 22023 (invalid_parameter_value)
  foreach q in array array[
    'select public.lc_mcp_ops_finding(''00000000-0000-4000-8000-0000000000a1'', ''recovery.candidate'')',
    'select public.lc_mcp_ops_finding(null, ''supervisor.summary'')',
    'select public.lc_mcp_action_center(''00000000-0000-4000-8000-0000000000a1'', ''lost'', false, null, 10)',
    'select public.lc_mcp_thread_hold_status(null)'] loop
    probes := probes + 1;
    begin
      execute 'set local role lc_mcp_reader';
      execute q;
      execute 'reset role';
      fails := fails || format('D2: NOT REFUSED: %s', q);
    exception when invalid_parameter_value then null; when others then fails := fails || format('D2: %s → %s (want 22023)', q, sqlstate);
    end;
  end loop;

  -- ------------------------------ E. the self-check names every way to break the role
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if not (rep->>'ok')::boolean then fails := fails || format('E: baseline not ok: %s', rep->>'findings'); end if;
  if rep->'select_outside_inventory' <> '[]'::jsonb then fails := fails || format('E: readable outside the inventory: %s', rep->>'select_outside_inventory'); end if;

  grant insert on public.send_queue to public;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%write_privileges:%public.send_queue%' then fails := fails || 'E: PUBLIC insert on send_queue not reported'::text; end if;
  revoke insert on public.send_queue from public;

  grant update (body) on public.sms_templates to lc_mcp_reader;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%write_privileges:%public.sms_templates%' then fails := fails || 'E: column-level UPDATE not reported'::text; end if;
  revoke update (body) on public.sms_templates from lc_mcp_reader;

  create function public.lc_probe_definer_writer() returns void language sql volatile security definer as 'delete from public.send_queue where false';
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%reachable_definer_functions:%lc_probe_definer_writer%' then fails := fails || 'E: PUBLIC-executable definer writer not reported'::text; end if;
  drop function public.lc_probe_definer_writer();

  create function public.st_estimatedextent(p_schema text, p_table text, p_column text) returns text language sql volatile security definer as 'select null::text';
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean then fails := fails || 'E: a VOLATILE st_estimatedextent was accepted by name'::text; end if;
  drop function public.st_estimatedextent(text, text, text);

  -- network egress: a real extension (dblink: its functions are PUBLIC-executable on install) and a wrapper
  create extension dblink schema public;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%reachable_egress_functions:%dblink%' then fails := fails || 'E: PUBLIC-executable dblink not reported'::text; end if;
  drop extension dblink;
  create function public.lc_probe_webhook(p_body text) returns void language plpgsql security invoker as $w$ begin perform net.http_post('https://example.invalid', p_body); end $w$;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%reachable_egress_functions:%lc_probe_webhook%' then fails := fails || 'E: invoker egress wrapper not reported'::text; end if;
  drop function public.lc_probe_webhook(text);

  -- pg_net exactly as production holds it (role audit 2026-10-16): PUBLIC USAGE on schema net, EXECUTE on
  -- net.http_get / http_post, ALL on net.http_request_queue. Both the egress functions AND the writable queue are findings.
  create schema net;
  grant usage on schema net to public;
  create table net.http_request_queue (id bigserial primary key, url text);
  grant all on net.http_request_queue to public;
  create function net.http_get(url text) returns bigint language sql volatile security invoker as $n$ select 1::bigint $n$;
  create function net.http_post(url text, body jsonb) returns bigint language sql volatile security invoker as $n$ select 1::bigint $n$;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean then fails := fails || 'E: pg_net (PUBLIC) accepted'::text; end if;
  if not (rep->>'findings') like '%reachable_egress_functions:%net.http_get%' or not (rep->>'findings') like '%net.http_post%' then fails := fails || 'E: net.http_* not reported as egress'::text; end if;
  if not (rep->>'findings') like '%write_privileges:%net.http_request_queue%' then fails := fails || 'E: PUBLIC ALL on net.http_request_queue not reported'::text; end if;
  drop schema net cascade;
  -- a wrapper around a PUBLIC side-effect function
  create function public.lc_probe_lo() returns oid language sql volatile as $w$ select lo_create(0) $w$;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%reachable_egress_functions:%lc_probe_lo%' then fails := fails || 'E: lo_create wrapper not reported'::text; end if;
  drop function public.lc_probe_lo();

  -- an owner-rights view outside the inventory that PUBLIC can read (it would read past RLS)
  create view public.lc_probe_owner_view as select to_e164 from public.send_queue;
  grant select on public.lc_probe_owner_view to public;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%exposed_select_outside_inventory:%lc_probe_owner_view%' then fails := fails || 'E: PUBLIC-readable owner-rights view not reported'::text; end if;
  drop view public.lc_probe_owner_view;

  grant authenticated to lc_mcp_reader;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%member_of:%authenticated%' then fails := fails || 'E: role membership not reported'::text; end if;
  revoke authenticated from lc_mcp_reader;

  alter role lc_mcp_reader bypassrls;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%attr_bypassrls%' then fails := fails || 'E: BYPASSRLS not reported'::text; end if;
  alter role lc_mcp_reader nobypassrls;

  alter role lc_mcp_reader login;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%attr_canlogin%' then fails := fails || 'E: LOGIN (a raw SQL session) not reported'::text; end if;
  alter role lc_mcp_reader nologin;

  grant usage on sequence public.send_queue_id_seq to lc_mcp_reader;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%sequence_privileges:%' then fails := fails || 'E: sequence USAGE not reported'::text; end if;
  revoke usage on sequence public.send_queue_id_seq from lc_mcp_reader;

  grant create on schema public to lc_mcp_reader;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%schema_create:%public%' then fails := fails || 'E: CREATE on schema not reported'::text; end if;
  revoke create on schema public from lc_mcp_reader;

  create policy lc_probe_restrict on public.properties as restrictive for select to public using (false);
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%restrictive_policy:properties%' then fails := fails || 'E: restrictive policy not reported'::text; end if;
  drop policy lc_probe_restrict on public.properties;

  -- an operations read function made VOLATILE (PostgREST would run it in a read-write transaction)
  alter function public.lc_mcp_action_center(uuid, text, boolean, uuid, integer) volatile;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%volatile_function:public.lc_mcp_action_center%' then fails := fails || 'E: a VOLATILE operations read function not reported'::text; end if;
  alter function public.lc_mcp_action_center(uuid, text, boolean, uuid, integer) stable;
  -- direct SELECT on a source the definer reads (the role must reach it ONLY through the projection)
  grant select on public.automation_holds to lc_mcp_reader;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%exposed_select_outside_inventory:%public.automation_holds%' then fails := fails || 'E: direct SELECT on automation_holds not reported'::text; end if;
  revoke select on public.automation_holds from lc_mcp_reader;

  revoke execute on function public.lc_mcp_operator_role(uuid, uuid) from lc_mcp_reader;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%no_execute:public.lc_mcp_operator_role%' then fails := fails || 'E: missing EXECUTE not reported'::text; end if;
  grant execute on function public.lc_mcp_operator_role(uuid, uuid) to lc_mcp_reader;

  -- RLS without a policy: the role silently reads ZERO rows (why the migration adds the policies)
  drop policy lc_mcp_reader_select on public.campaigns;
  begin
    execute 'set local role lc_mcp_reader';
    select count(*) into n from public.campaigns;
    execute 'reset role';
  end;
  if n <> 0 then fails := fails || 'E: expected 0 visible rows without the policy'::text; end if;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if (rep->>'ok')::boolean or not (rep->>'findings') like '%rls_without_policy:campaigns%' then fails := fails || 'E: RLS without policy not reported'::text; end if;
  create policy lc_mcp_reader_select on public.campaigns as permissive for select to lc_mcp_reader using (true);

  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if not (rep->>'ok')::boolean then fails := fails || format('E: not ok after restoring: %s', rep->>'findings'); end if;

  if array_length(fails, 1) > 0 then
    raise exception 'posttest FAILED (% problem(s)):%', array_length(fails, 1), E'\n  ' || array_to_string(fails, E'\n  ');
  end if;
  raise notice 'posttest: % write / DDL / RPC probes refused by the database; % relations readable; non-table refusals: %', probes, array_length(rels, 1), array_to_string(denied_kinds, ', ');
end $$;

rollback;
