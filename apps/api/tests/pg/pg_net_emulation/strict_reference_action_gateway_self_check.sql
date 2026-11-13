-- DISPOSABLE TEST FIXTURE (apps/api/tests/critical/action-gateway-pg-net-posture-pg.test.mjs), never production.
-- The Action Gateway privilege self-check (action_gateway.self_check, #26) EXACTLY as it was before the Supabase pg_net platform exception (commit 9361a4a0),
-- renamed *_strict_reference. The posture test runs it next to the current function and asserts that, whenever
-- the exception does NOT apply (wrong owner / grantor / ACL / a non-extension object / no pg_net at all), the
-- current function reports EXACTLY the same findings: the exception never weakens the strict rule silently.
-- Body copied verbatim (only the function name differs); see docs/SUPABASE-PG-NET-POSTURE.md.

create or replace function action_gateway.self_check_strict_reference(p_role name default 'lc_action_gateway')
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $fn$
declare
  r oid;
  read_rels text[] := action_gateway.read_inventory();
  agent_read text[] := array['approval_request','operator_membership','ops_work_item'];
  gw_read text[] := array['action_intents','action_authorizations','action_outcomes','action_audit_events'];
  -- lc-action-inventory:definer-functions (reachable SECURITY DEFINER functions the role may execute)
  definer_allow text[] := array['public.action_gateway_principal(text)','public.action_gateway_reply_policy()','public.action_gateway_dw_thread_hold_set(uuid,uuid)',
    'public.action_gateway_dw_operator_task(uuid,uuid)','public.action_gateway_dw_runtime_enqueue(uuid,uuid)',
    'agent.capability_approval_insert(jsonb)','agent.ops_pipeline_facts(uuid,integer)',
    'action_gateway.grant_admit(uuid,uuid,text)','action_gateway.grant_note_failure(uuid,text)','action_gateway.grant_execution_refusal(uuid)'];
  -- lc-action-inventory:entry-points (SECURITY INVOKER)
  entry text[] := array['public.action_gateway_controls()','public.action_gateway_intent_open(jsonb)','public.action_gateway_intent_get(uuid)',
    'public.action_gateway_refuse(uuid,text,jsonb)','public.action_gateway_expire(uuid,text)','public.action_gateway_await_approval(uuid,text)',
    'public.action_gateway_authorize(uuid,text,jsonb)','public.action_gateway_claim(uuid,text,integer)','public.action_gateway_complete(uuid,uuid,text,text,jsonb)',
    'public.action_gateway_mark_unknown(uuid,text)','public.action_gateway_recoverable(integer)','public.action_gateway_audit_append(jsonb)',
    'public.action_gateway_approval_request(jsonb)','public.action_gateway_approval_get(text)','public.action_gateway_pipeline_facts(uuid,integer)',
    'public.action_gateway_work_item_get(uuid)','public.action_gateway_self_check()'];
  -- the ONLY writes: insert the bookkeeping rows, update the intent lifecycle columns
  write_allow jsonb := jsonb_build_object(
    'action_gateway.action_intents', jsonb_build_array('INSERT', 'UPDATE'),
    'action_gateway.action_authorizations', jsonb_build_array('INSERT'),
    'action_gateway.action_outcomes', jsonb_build_array('INSERT'),
    'action_gateway.action_audit_events', jsonb_build_array('INSERT'));
  privs text[] := array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] || case when current_setting('server_version_num')::int >= 170000 then array['MAINTAIN'] else array[]::text[] end;
  findings text[] := '{}';
  rep jsonb;
  x record;
  v_has text[];
  v_allowed jsonb;
begin
  select oid into r from pg_roles where rolname = p_role;
  if r is null then return jsonb_build_object('version', 1, 'role', p_role, 'exists', false, 'ok', false, 'findings', jsonb_build_array('role_missing')); end if;

  select jsonb_build_object('superuser', rolsuper, 'bypassrls', rolbypassrls, 'createrole', rolcreaterole, 'createdb', rolcreatedb,
                            'replication', rolreplication, 'canlogin', rolcanlogin, 'inherit', rolinherit) into rep from pg_roles where oid = r;
  rep := jsonb_build_object('version', 1, 'role', p_role, 'exists', true, 'current_user', current_user::text, 'attributes', rep);
  if (rep #>> '{attributes,superuser}')::boolean then findings := findings || 'attr_superuser'::text; end if;
  if (rep #>> '{attributes,bypassrls}')::boolean then findings := findings || 'attr_bypassrls'::text; end if;
  if (rep #>> '{attributes,createrole}')::boolean then findings := findings || 'attr_createrole'::text; end if;
  if (rep #>> '{attributes,createdb}')::boolean then findings := findings || 'attr_createdb'::text; end if;
  if (rep #>> '{attributes,replication}')::boolean then findings := findings || 'attr_replication'::text; end if;
  if (rep #>> '{attributes,canlogin}')::boolean then findings := findings || 'attr_canlogin'::text; end if;
  for x in select g.rolname from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r loop
    findings := findings || ('member_of:' || x.rolname);
  end loop;

  -- write privileges anywhere the role can reach (table or column level), against the allowlist
  for x in
    select n.nspname, c.relname, c.oid, format('%I.%I', n.nspname, c.relname) q
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
       and has_schema_privilege(r, n.oid, 'USAGE')
  loop
    select coalesce(array_agg(pv), '{}') into v_has from unnest(privs) pv
     where has_table_privilege(r, x.oid, pv) or (pv in ('INSERT', 'UPDATE', 'REFERENCES') and has_any_column_privilege(r, x.oid, pv));
    if array_length(v_has, 1) > 0 then
      v_allowed := coalesce(write_allow -> x.q, '[]'::jsonb);
      if exists (select 1 from unnest(v_has) h where not (v_allowed ? h)) then
        findings := findings || ('write_privilege:' || x.q || ':' || array_to_string(v_has, '+'));
      end if;
    end if;
  end loop;
  -- INSERT on the bookkeeping tables and UPDATE on the intent must be present
  if not has_table_privilege(r, 'action_gateway.action_intents', 'INSERT') then findings := findings || 'missing_insert:action_intents'::text; end if;
  if not has_any_column_privilege(r, 'action_gateway.action_intents', 'UPDATE') then findings := findings || 'missing_update:action_intents'::text; end if;
  if has_column_privilege(r, 'action_gateway.action_intents', 'params', 'UPDATE') or has_column_privilege(r, 'action_gateway.action_intents', 'agent_id', 'UPDATE')
     or has_column_privilege(r, 'action_gateway.action_intents', 'org_id', 'UPDATE') then findings := findings || 'intent_request_columns_updatable'::text; end if;
  for x in select unnest(array['action_authorizations', 'action_outcomes', 'action_audit_events']) t loop
    if not has_table_privilege(r, format('action_gateway.%I', x.t), 'INSERT') then findings := findings || ('missing_insert:' || x.t); end if;
  end loop;

  for x in
    select format('%I.%I', n.nspname, c.relname) q from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'S' and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
       and has_schema_privilege(r, n.oid, 'USAGE') and case when c.relkind = 'S' then has_sequence_privilege(r, c.oid, 'USAGE,UPDATE') else false end
  loop findings := findings || ('sequence_privilege:' || x.q); end loop;
  for x in select n.nspname from pg_namespace n where n.nspname !~ '^pg_(toast|temp)' and has_schema_privilege(r, n.oid, 'CREATE') loop
    findings := findings || ('schema_create:' || x.nspname);
  end loop;
  if has_database_privilege(r, current_database(), 'CREATE') then findings := findings || 'database_create'::text; end if;

  -- reachable SECURITY DEFINER functions outside the allowlist (trigger functions are not callable)
  for x in
    select p.oid::regprocedure::text s from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prosecdef and p.prokind in ('f', 'p')
       and p.prorettype not in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
       and n.nspname not in ('pg_catalog', 'information_schema')
       and has_schema_privilege(r, n.oid, 'USAGE') and case when p.prosecdef then has_function_privilege(r, p.oid, 'EXECUTE') else false end
       and not (p.oid::regprocedure::text = any (definer_allow))
       and not (p.proname = 'st_estimatedextent' and p.provolatile in ('s', 'i'))
  loop findings := findings || ('reachable_definer_function:' || x.s); end loop;
  -- network egress the role can reach (same rule as lc_mcp_reader_self_check): extensions, schema net,
  -- untrusted languages, and sql / plpgsql wrappers calling them or a PUBLIC side-effect function
  for x in
    select p.oid::regprocedure::text s from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
     where p.prokind in ('f', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
       and has_schema_privilege(r, n.oid, 'USAGE') and has_function_privilege(r, p.oid, 'EXECUTE')
       and (exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
                     where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.refclassid = 'pg_catalog.pg_extension'::regclass
                       and d.deptype = 'e' and e.extname in ('pg_net', 'http', 'dblink', 'postgres_fdw'))
            or n.nspname = 'net'
            or p.proname ~* '^(http|http_[a-z_]+|dblink[a-z_]*)$'
            or (not l.lanpltrusted and l.lanname not in ('c', 'internal'))
            or (l.lanname in ('sql', 'plpgsql') and p.prosrc ~* '\m(net\.http_[a-z_]+|http_(get|post|put|patch|delete|head|request)|dblink[a-z_]*|lo_(create|creat|from_bytea|put|import|export|unlink)|lowrite|pg_notify|pg_logical_emit_message)\s*\('))
  loop findings := findings || ('reachable_egress_function:' || x.s); end loop;
  -- bounded transitive reachability: indirect / dynamic-SQL / trigger / event-trigger / cron / membership / view egress paths the per-function grep misses (HARD findings)
  findings := findings || public.lc_reachable_egress_indirect(r);

  -- SELECT: exactly the inventory in the PostgREST-exposed schemas, a named set in agent, the gateway's own tables
  for x in
    select n.nspname, c.relname, format('%I.%I', n.nspname, c.relname) q from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
       and has_schema_privilege(r, n.oid, 'USAGE') and case when c.relkind in ('r', 'p', 'v', 'm', 'f') then has_table_privilege(r, c.oid, 'SELECT') or has_any_column_privilege(r, c.oid, 'SELECT') else false end
  loop
    if not ((x.nspname = 'public' and x.relname = any (read_rels)) or (x.nspname = 'agent' and x.relname = any (agent_read))
            or (x.nspname = 'action_gateway' and x.relname = any (gw_read))
            or (x.nspname = 'public' and x.relname in ('spatial_ref_sys', 'geometry_columns', 'geography_columns', 'raster_columns', 'raster_overviews'))) then
      findings := findings || ('select_outside_inventory:' || x.q);
    end if;
  end loop;
  for x in select unnest(read_rels) t loop
    if to_regclass(format('public.%I', x.t)) is null then findings := findings || ('relation_missing:' || x.t);
    elsif not (has_table_privilege(r, format('public.%I', x.t), 'SELECT') or has_any_column_privilege(r, format('public.%I', x.t), 'SELECT')) then findings := findings || ('no_select:' || x.t);
    elsif (select c.relrowsecurity from pg_class c where c.oid = to_regclass(format('public.%I', x.t)))
          and not exists (select 1 from pg_policy pp where pp.polrelid = to_regclass(format('public.%I', x.t)) and pp.polpermissive and pp.polcmd in ('r', '*') and r = any (pp.polroles)) then
      findings := findings || ('rls_without_policy:' || x.t);
    end if;
  end loop;
  if has_table_privilege(r, 'action_gateway.agent_principals', 'SELECT') or has_table_privilege(r, 'action_gateway.capability_grants', 'SELECT') then
    findings := findings || 'principal_registry_readable'::text;
  end if;
  for x in select unnest(entry || definer_allow) s loop
    if to_regprocedure(x.s) is null then findings := findings || ('function_missing:' || x.s);
    elsif not has_function_privilege(r, to_regprocedure(x.s), 'EXECUTE') then findings := findings || ('no_execute:' || x.s);
    end if;
  end loop;
  for x in select unnest(entry) s loop
    if (select p.prosecdef from pg_proc p where p.oid = to_regprocedure(x.s)) then findings := findings || ('entry_point_is_definer:' || x.s); end if;
  end loop;
  return rep || jsonb_build_object('findings', to_jsonb(findings), 'ok', coalesce(array_length(findings, 1), 0) = 0, 'generated_at', clock_timestamp());
end
$fn$;
