-- =============================================================================
-- LeadCommand ACTION GATEWAY, Tier-2 tool family: the T2 domain writers and the
-- composable extension registry of the gateway's reviewed lists.
-- STATUS: PROPOSED. NOT APPLIED. Owner approval required; applied on its own.
-- OPTIONAL link #27 of the rc-8.5.21 chain, AFTER link #26 (action_gateway).
-- Test (disposable PostgreSQL 17 ONLY, never production):
--   node scripts/db/run-migration-test.mjs --pg-bin <pg17 bin dir> --id action_gateway_t2
-- Rollback: PROPOSED_20261020100000_action_gateway_t2_rollback.sql (drops exactly what this creates and
--   restores #26's three function bodies; REFUSES while a T2 intent is still pending).
-- Design: docs/ACTION-MCP.md §8 (Tier-2 tools)
-- =============================================================================
--
-- WHAT IT CREATES (everything is born OFF: no grant, no principal, no control key changes)
--   action_gateway.extensions            THE COMPOSABLE EXTENSION REGISTRY. Phase 1 hard-codes three
--                                        reviewed lists inside function bodies: the self-check's definer /
--                                        entry-point allowlists, standing_t2_actions() and the domain-write
--                                        actions action_gateway_complete() refuses. A later link REGISTERS
--                                        rows here instead of editing those bodies, so two links (this one and
--                                        the T3 / T4 link built in parallel) compose: each inserts its own rows
--                                        (primary key kind × name; `link` names the migration) and the three
--                                        functions read the union. The functions are replaced ONCE with the
--                                        registry-reading bodies below (byte-identical in every link that
--                                        adopts the registry); a link's rollback deletes only its own rows and
--                                        restores #26's bodies only when the registry is empty again.
--   action_gateway.extension_names(kind) the one (definer, STABLE) read of the registry
--   five lease-bound SECURITY DEFINER domain writes (parameters come FROM the authorized intent, never
--   from the caller; the write and its outcome commit in ONE transaction, exactly like #26's):
--     action_gateway_dw_deal_action        create_deal_action: agent.ops_work_item (scope agent, kind
--                                          agent_task) bound to ONE opportunity, with its action kind
--     action_gateway_dw_followup_schedule  schedule_followup: public.followup_intent_plan (THE lifecycle
--                                          writer) after re-checking the hold registry (R7: the hold is
--                                          now checked AT PLAN) and the thread's suppression in the same
--                                          transaction; the intent key is the lifecycle's own fi1. key
--     action_gateway_dw_followup_cancel    cancel_followup: the lifecycle's cancel path
--                                          (followup_intent_close_for_thread, or the same statements for
--                                          one intent by id), unsent rows cancelled in the same transaction
--     action_gateway_dw_campaign_pause     pause_campaign: public.campaign_transition_status(…, 'paused')
--                                          (THE advisory-locked, edge-validated lifecycle writer)
--     action_gateway_dw_human_request      the five REQUEST actions (update_lead_stage,
--                                          update_lead_disposition, request_thread_hold_release,
--                                          request_campaign_resume, adjust_campaign_plan): files ONE
--                                          agent.approval_request of the action's FIXED capability for a
--                                          HUMAN (the existing decide path). Every authority field of the
--                                          request is verified against the intent's params and the domain
--                                          rows; the gateway never executes the change itself.
--   one definer read: action_gateway_followup_intents (the live follow-up intents of ONE thread, codes /
--   ids / timestamps only, no thread key) for cancel_followup's resolution.
--
-- STANDING T2 (action_gateway.standing_t2_actions() = 'set_thread_hold' ∪ the registry):
--   reversible:   pause_campaign, cancel_followup, schedule_followup, create_deal_action
--   request_only: the five request actions above (their own effect is ONE pending human decision; the
--                 irreversible change happens only on that per-use human approval)
--
-- HARD REFUSALS IN THE DATABASE (defence in depth under the JS policies):
--   the Hartford hold (owner_hold_20261016:hartford; Hartford is CLOSED LOST, never revived) and every
--   permanent_exclusion (Maxwell) can never be the subject of a release request; no stage request to a
--   contract / closing stage; no disposition outside the agent allowlist; a held or suppressed thread is
--   never given a follow-up plan.
--
-- WHAT MAKES THE APPLY ABORT (atomically): #26 missing; the follow-up lifecycle (#… 20261017120000)
--   or public.campaign_transition_status missing; a T2 object already present; ANY finding of the
--   (registry-aware) self-check.

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ───────────────────────────────────────────── 1. prerequisites ─────────────
do $$
declare t text; missing text[] := '{}';
begin
  if to_regnamespace('action_gateway') is null or to_regprocedure('action_gateway.self_check(name)') is null
     or to_regprocedure('action_gateway.dw_begin(uuid,uuid,text[])') is null or to_regprocedure('action_gateway.standing_t2_actions()') is null then
    raise exception 'action_gateway_t2: link #26 (PROPOSED_20261019160000_action_gateway.sql) must be applied first';
  end if;
  foreach t in array array['public.followup_intent_plan(jsonb)','public.followup_intent_close_for_thread(jsonb)',
      'public.followup_intent_cancel_row(uuid,text,text,boolean)','public.followup_intent_project(text)',
      'public.campaign_transition_status(uuid,text,text,timestamp with time zone)','public.automation_hold_for(text,uuid,text,uuid,text,text)'] loop
    if to_regprocedure(t) is null then missing := missing || t; end if;
  end loop;
  if to_regclass('public.followup_intents') is null then missing := missing || 'public.followup_intents'::text; end if;
  if array_length(missing, 1) > 0 then raise exception 'action_gateway_t2: missing prerequisite(s): %', array_to_string(missing, ', '); end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
              and p.proname in ('action_gateway_dw_deal_action', 'action_gateway_dw_followup_schedule', 'action_gateway_dw_followup_cancel',
                                'action_gateway_dw_campaign_pause', 'action_gateway_dw_human_request', 'action_gateway_followup_intents')) then
    raise exception 'action_gateway_t2: a T2 function already exists (already applied?)';
  end if;
  if to_regclass('action_gateway.extensions') is not null then
    execute 'select count(*) from action_gateway.extensions where link = $1' into t using 'PROPOSED_20261020100000_action_gateway_t2';
    if t <> '0' then raise exception 'action_gateway_t2: this link is already registered'; end if;
  end if;
end $$;

-- ───────────────────────────────────────────── 2. the extension registry ────
-- create-if-not-exists: the FIRST link that adopts the registry creates it; a later one reuses it
create table if not exists action_gateway.extensions (
  kind          text not null check (kind in ('definer_function', 'entry_point', 'standing_t2_action', 'domain_write_action')),
  name          text not null check (length(name) between 3 and 200 and name ~ '^[a-z][A-Za-z0-9_.(), ]+$'),
  link          text not null check (link ~ '^[A-Za-z0-9_.-]{3,120}$'),
  basis         text check (basis is null or basis in ('reversible', 'request_only')),
  registered_at timestamptz not null default now(),
  primary key (kind, name),
  check ((kind = 'standing_t2_action') = (basis is not null))
);
comment on table action_gateway.extensions is 'Action Gateway extension registry: the reviewed lists (self-check definer / entry-point allowlists, standing T2 actions, domain-write actions) that later links EXTEND by row, so independent links compose. Read only through action_gateway.extension_names(kind).';
alter table action_gateway.extensions enable row level security;
revoke all on action_gateway.extensions from public, anon, authenticated, service_role;

create or replace function action_gateway.extension_names(p_kind text)
returns text[]
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select coalesce(array_agg(e.name order by e.name), '{}'::text[]) from action_gateway.extensions e where e.kind = p_kind
$fn$;
comment on function action_gateway.extension_names(text) is 'Action Gateway: the registered names of one extension kind (the union every reviewed list reads).';
revoke all on function action_gateway.extension_names(text) from public, anon, authenticated, service_role;
grant execute on function action_gateway.extension_names(text) to lc_action_gateway;

-- the T2 actions a standing grant may authorize without a per-use approval: set_thread_hold (#26) ∪ the
-- registered ones (each carries its basis: reversible, or request_only = its effect is a human decision)
create or replace function action_gateway.standing_t2_actions()
returns text[] language sql stable parallel safe set search_path = pg_catalog
as $fn$ select array['set_thread_hold']::text[] || action_gateway.extension_names('standing_t2_action') $fn$;

-- ───────────────────────────────────────────── 3. the registry-aware bodies ──
create or replace function action_gateway.self_check(p_role name default 'lc_action_gateway')
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
    'action_gateway.grant_admit(uuid,uuid,text)','action_gateway.grant_note_failure(uuid,text)','action_gateway.grant_execution_refusal(uuid)',
    'action_gateway.extension_names(text)'] || action_gateway.extension_names('definer_function');
  -- lc-action-inventory:entry-points (SECURITY INVOKER)
  entry text[] := array['public.action_gateway_controls()','public.action_gateway_intent_open(jsonb)','public.action_gateway_intent_get(uuid)',
    'public.action_gateway_refuse(uuid,text,jsonb)','public.action_gateway_expire(uuid,text)','public.action_gateway_await_approval(uuid,text)',
    'public.action_gateway_authorize(uuid,text,jsonb)','public.action_gateway_claim(uuid,text,integer)','public.action_gateway_complete(uuid,uuid,text,text,jsonb)',
    'public.action_gateway_mark_unknown(uuid,text)','public.action_gateway_recoverable(integer)','public.action_gateway_audit_append(jsonb)',
    'public.action_gateway_approval_request(jsonb)','public.action_gateway_approval_get(text)','public.action_gateway_pipeline_facts(uuid,integer)',
    'public.action_gateway_work_item_get(uuid)','public.action_gateway_self_check()'] || action_gateway.extension_names('entry_point');
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
  pe jsonb;
  exc_rel oid[];
  exc_fn oid[];
begin
  select oid into r from pg_roles where rolname = p_role;
  if r is null then return jsonb_build_object('version', 1, 'role', p_role, 'exists', false, 'ok', false, 'findings', jsonb_build_array('role_missing'), 'platform_exceptions', '[]'::jsonb); end if;
  -- the pinned Supabase pg_net platform exception: its objects are excepted ONLY when every condition and
  -- compensating control holds (action_gateway.platform_egress_exceptions); otherwise they count as before
  pe := action_gateway.platform_egress_exceptions(r);
  exc_rel := array(select (jsonb_array_elements_text(pe -> 'excepted_relations'))::oid);
  exc_fn := array(select (jsonb_array_elements_text(pe -> 'excepted_functions'))::oid);

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
       and has_schema_privilege(r, n.oid, 'USAGE') and not (c.oid = any (exc_rel))
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
       and has_schema_privilege(r, n.oid, 'USAGE') and not (c.oid = any (exc_rel)) and case when c.relkind = 'S' then has_sequence_privilege(r, c.oid, 'USAGE,UPDATE') else false end
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
  -- untrusted languages, and sql / plpgsql wrappers calling them or a PUBLIC side-effect function.
  -- Only the members of an APPLIED platform exception are skipped; every other function (a wrapper in
  -- public calling net.* included) is judged exactly as before.
  for x in
    select p.oid::regprocedure::text s from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
     where p.prokind in ('f', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
       and has_schema_privilege(r, n.oid, 'USAGE') and has_function_privilege(r, p.oid, 'EXECUTE') and not (p.oid = any (exc_fn))
       and (exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
                     where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.refclassid = 'pg_catalog.pg_extension'::regclass
                       and d.deptype = 'e' and e.extname in ('pg_net', 'http', 'dblink', 'postgres_fdw'))
            or n.nspname = 'net'
            or p.proname ~* '^(http|http_[a-z_]+|dblink[a-z_]*)$'
            or (not l.lanpltrusted and l.lanname not in ('c', 'internal'))
            or (l.lanname in ('sql', 'plpgsql') and p.prosrc ~* '\m(net\.http_[a-z_]+|http_(get|post|put|patch|delete|head|request)|dblink[a-z_]*|lo_(create|creat|from_bytea|put|import|export|unlink)|lowrite|pg_notify|pg_logical_emit_message)\s*\('))
  loop findings := findings || ('reachable_egress_function:' || x.s); end loop;

  -- SELECT: exactly the inventory in the PostgREST-exposed schemas, a named set in agent, the gateway's own tables
  for x in
    select n.nspname, c.relname, format('%I.%I', n.nspname, c.relname) q from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
       and has_schema_privilege(r, n.oid, 'USAGE') and not (c.oid = any (exc_rel)) and case when c.relkind in ('r', 'p', 'v', 'm', 'f') then has_table_privilege(r, c.oid, 'SELECT') or has_any_column_privilege(r, c.oid, 'SELECT') else false end
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
  -- the compensating controls of an applied platform exception (each a hard finding)
  findings := findings || array(select jsonb_array_elements_text(pe -> 'findings'));
  -- platform_exceptions: what was excepted (fingerprint version, objects, ACL, controls), reported apart from findings
  return rep || jsonb_build_object('findings', to_jsonb(findings), 'ok', coalesce(array_length(findings, 1), 0) = 0,
                                   'platform_exceptions', pe -> 'platform_exceptions', 'generated_at', clock_timestamp());
end
$fn$;

create or replace function public.action_gateway_complete(p_intent_id uuid, p_lease_token uuid, p_status text, p_code text, p_result jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $fn$
declare i action_gateway.action_intents%rowtype; v_code text;
begin
  select * into i from action_gateway.action_intents where intent_id = p_intent_id and org_id = action_gateway.request_org() for update;
  if i.intent_id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if i.state <> 'executing' or i.lease_token is distinct from p_lease_token then return jsonb_build_object('ok', false, 'reason', 'lease_lost', 'intent', action_gateway.intent_json(i)); end if;
  if i.action = any (array['set_thread_hold', 'create_operator_task', 'update_operator_task', 'create_research_job', 'request_property_valuation']::text[]
                    || action_gateway.extension_names('domain_write_action')) then
    return jsonb_build_object('ok', false, 'reason', 'domain_write_action');
  end if;
  if p_status not in ('succeeded', 'failed', 'refused') then return jsonb_build_object('ok', false, 'reason', 'status_invalid'); end if;
  -- the emergency stop / a grant revoked or suspended while the read-only service ran: the result is withheld
  v_code := coalesce(action_gateway.control_refusal(i.capability, i.tier), action_gateway.grant_execution_refusal(i.intent_id));
  if v_code is not null and p_status = 'succeeded' then
    return action_gateway.finish_intent(i.intent_id, 'refused', v_code, jsonb_build_object('stage', 'completion', 'withheld', true));
  end if;
  return action_gateway.finish_intent(i.intent_id, p_status, p_code, coalesce(p_result, '{}'::jsonb));
end
$fn$;

-- ───────────────────────────────────────────── 4. T2 reads + domain writes ──
-- Hard-coded identities the gateway never revives / never offers for release (owner decisions):
--   Hartford: CLOSED LOST, never revive (thread 596a9368…, property 225438557, opportunity 9b690ce3…,
--             hold owner_hold_20261016:hartford); Maxwell: permanent exclusion (owner handles it).
create or replace function action_gateway.t2_never_revive(p_thread_id uuid, p_property_id text, p_opportunity_id uuid, p_hold_key text default null)
returns text
language sql
immutable
set search_path = pg_catalog
as $fn$
  select case
    when p_hold_key in ('owner_hold_20261016:hartford') or p_thread_id = '596a9368-6ef8-40f8-97cb-fcc46e6672d3'::uuid
      or p_property_id = '225438557' or p_opportunity_id = '9b690ce3-ff88-400b-b56e-69e9bd0055b0'::uuid then 'CLOSED_LOST_NEVER_REVIVE'
    when p_hold_key in ('owner_handled_20261014:maxwell') or p_thread_id = '58d05df2-561d-4c9e-9226-ab3de105d773'::uuid
      or p_property_id = '251027062' or p_opportunity_id = '47da7121-c39d-425a-b608-046750e35027'::uuid then 'PERMANENT_EXCLUSION'
    else null end
$fn$;

-- the live follow-up intents of ONE thread (cancel_followup resolves against it). No thread key, no row_spec:
-- ids, kind, state, due, writer, whether a property is attached. Definer: public.followup_intents is
-- service-role only and stays so.
create or replace function public.action_gateway_followup_intents(p_thread_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object('followup_intent_id', f.id, 'kind', f.kind, 'state', f.state, 'due_at', f.due_at, 'writer', f.writer,
                                               'has_property', f.property_id is not null, 'created_at', f.created_at) order by f.due_at, f.id), '[]'::jsonb)
    from public.inbox_thread_state t
    join public.followup_intents f on f.thread_key = t.thread_key
   where t.id = p_thread_id and f.state in ('planned', 'materializing', 'ready', 'held', 'dispatched')
$fn$;

-- create_deal_action (T2, reversible): ONE operator / deal task bound to an opportunity, in the Action Center
-- (agent.ops_work_item scope agent, kind agent_task, subject opportunity). Humans resolve / dismiss it.
create or replace function public.action_gateway_dw_deal_action(p_intent_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare b jsonb; i action_gateway.action_intents%rowtype; v_opp uuid; v_id uuid; v_stage text; v_status text;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['create_deal_action']);
  if b ? 'refused' then return b -> 'outcome'; end if;
  i := jsonb_populate_record(null::action_gateway.action_intents, b -> 'intent');
  begin
    v_opp := (i.params ->> 'opportunity_id')::uuid;
    select o.acquisition_stage, o.opportunity_status into v_stage, v_status from public.acquisition_opportunities o where o.id = v_opp for share;
    if not found then return action_gateway.finish_intent(i.intent_id, 'failed', 'OPPORTUNITY_NOT_FOUND', '{}'::jsonb); end if;
    insert into agent.ops_work_item (org_id, scope, kind, dedupe_key, severity, escalated, title, subject_type, subject_id, detail, priority, due_at, source_job_id)
    values (i.org_id, 'agent', 'agent_task', 'agent:deal:' || i.intent_id::text, coalesce(i.params ->> 'severity', 'info'), false, i.params ->> 'title',
            'opportunity', v_opp::text,
            jsonb_build_object('source', 'action_gateway', 'agent_id', i.agent_id, 'intent_id', i.intent_id, 'deal_action', i.params ->> 'action_kind',
                               'opportunity_stage', v_stage, 'notes', coalesce(i.params -> 'notes', '[]'::jsonb)),
            coalesce((i.params ->> 'priority')::int, 0), (i.params ->> 'due_at')::timestamptz, 'action_intent:' || i.intent_id::text)
    on conflict (org_id, dedupe_key) do nothing
    returning work_item_id into v_id;
    if v_id is null then select work_item_id into v_id from agent.ops_work_item where org_id = i.org_id and dedupe_key = 'agent:deal:' || i.intent_id::text; end if;
    return action_gateway.finish_intent(i.intent_id, 'succeeded', 'DEAL_ACTION_CREATED',
                                        jsonb_build_object('work_item_id', v_id, 'opportunity_id', v_opp, 'action_kind', i.params ->> 'action_kind'));
  exception when others then
    return action_gateway.finish_intent(i.intent_id, 'failed', 'DOMAIN_WRITE_FAILED', jsonb_build_object('sqlstate', sqlstate));
  end;
end
$fn$;

-- schedule_followup (T2, reversible): THE lifecycle writer (followup_intent_plan). Born under the lifecycle's
-- own switch: planning records the intent; only system_control.followup_execution_mode = 'live' ever
-- materializes it (the materializer re-checks every guard again at due time).
create or replace function public.action_gateway_dw_followup_schedule(p_intent_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare
  b jsonb; i action_gateway.action_intents%rowtype; t record; v_hold uuid; v_key text; r jsonb; v_kind text; v_due timestamptz; v_never text;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['schedule_followup']);
  if b ? 'refused' then return b -> 'outcome'; end if;
  i := jsonb_populate_record(null::action_gateway.action_intents, b -> 'intent');
  begin
    select s.id, s.thread_key, s.property_id, s.master_owner_id, s.prospect_id, s.is_suppressed, lower(coalesce(s.contactability_status, '')) contactability
      into t from public.inbox_thread_state s where s.id = (i.params ->> 'thread_id')::uuid for share;
    if t.id is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'THREAD_NOT_FOUND', '{}'::jsonb); end if;
    v_never := action_gateway.t2_never_revive(t.id, t.property_id, null);
    if v_never is not null then return action_gateway.finish_intent(i.intent_id, 'refused', v_never, jsonb_build_object('stage', 'domain_write')); end if;
    -- R7: the hold registry AT PLAN (the same lookup every writer uses), in the write's own transaction
    select h.id into v_hold from public.automation_hold_for(t.thread_key, t.id, t.property_id, null, t.master_owner_id, 'follow_up') h limit 1;
    if v_hold is not null then return action_gateway.finish_intent(i.intent_id, 'refused', 'AUTOMATION_HOLD', jsonb_build_object('stage', 'domain_write', 'hold_id', v_hold)); end if;
    if coalesce(t.is_suppressed, false) or t.contactability in ('opted_out', 'do_not_text', 'do_not_contact', 'dnc') then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'CONTACT_NOT_PERMITTED', jsonb_build_object('stage', 'domain_write'));
    end if;
    v_kind := i.params ->> 'kind';
    v_due := (i.params ->> 'due_at')::timestamptz;
    if v_kind not in ('seller_requested_callback', 'not_interested_nurture') then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'FOLLOWUP_KIND_NOT_ALLOWED', '{}'::jsonb);
    end if;
    if v_due < now() + interval '10 minutes' or v_due > now() + interval '120 days' then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'DUE_AT_OUT_OF_BOUNDS', '{}'::jsonb);
    end if;
    -- the lifecycle's own key (followUpIntentKey with cause = this intent): a replay collapses onto it
    v_key := 'fi1.' || left(encode(sha256(convert_to('followup-lifecycle.v1|' || t.thread_key || '|' || coalesce(t.property_id, '') || '|' || v_kind
                                                    || '|cause:action_intent:' || i.intent_id::text, 'UTF8')), 'hex'), 40);
    r := public.followup_intent_plan(jsonb_build_object(
      'intent_key', v_key, 'thread_key', t.thread_key, 'property_id', t.property_id, 'master_owner_id', t.master_owner_id, 'prospect_id', t.prospect_id,
      'kind', v_kind, 'intent', i.params ->> 'intent', 'use_case', i.params ->> 'use_case', 'due_at', v_due, 'writer', 'action_gateway',
      'actor', 'agent:' || i.agent_id, 'state', 'planned',
      'row_spec', jsonb_build_object('thread_key', t.thread_key, 'to_phone_number', t.thread_key, 'property_id', t.property_id, 'master_owner_id', t.master_owner_id,
                                     'prospect_id', t.prospect_id, 'use_case_template', i.params ->> 'use_case', 'type', 'followup', 'message_type', 'follow_up',
                                     'metadata', jsonb_build_object('source', 'action_gateway', 'action_intent_id', i.intent_id, 'agent_id', i.agent_id,
                                                                    'messaging_category', 'scheduled_followup', 'reason_code', i.params ->> 'reason_code',
                                                                    'deferred_message_resolution', true))));
    if coalesce((r ->> 'ok')::boolean, false) is not true then
      return action_gateway.finish_intent(i.intent_id, 'failed', 'FOLLOWUP_PLAN_REFUSED', '{}'::jsonb);
    end if;
    return action_gateway.finish_intent(i.intent_id, 'succeeded', case when coalesce((r ->> 'replay')::boolean, false) then 'FOLLOWUP_ALREADY_PLANNED' else 'FOLLOWUP_PLANNED' end,
                                        jsonb_build_object('followup_intent_id', r -> 'intent' ->> 'id', 'state', r -> 'intent' ->> 'state', 'kind', v_kind,
                                                           'due_at', r -> 'intent' ->> 'due_at', 'superseded', coalesce((r ->> 'superseded')::int, 0),
                                                           'execution', 'follows system_control.followup_execution_mode'));
  exception when others then
    return action_gateway.finish_intent(i.intent_id, 'failed', 'DOMAIN_WRITE_FAILED', jsonb_build_object('sqlstate', sqlstate));
  end;
end
$fn$;

-- cancel_followup (T2, reversible, risk-lowering): the lifecycle's cancel path. By id: the same statements
-- followup_intent_close_for_thread runs for one intent (state, its unsent row, the projection, under the
-- thread's lifecycle lock); else every live intent of the thread (optionally one kind). Allowed under a hold.
create or replace function public.action_gateway_dw_followup_cancel(p_intent_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare
  b jsonb; i action_gateway.action_intents%rowtype; v_tk text; v_reason text; v_fid uuid; f record; r jsonb; n integer := 0; rows_n integer := 0;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['cancel_followup']);
  if b ? 'refused' then return b -> 'outcome'; end if;
  i := jsonb_populate_record(null::action_gateway.action_intents, b -> 'intent');
  begin
    select s.thread_key into v_tk from public.inbox_thread_state s where s.id = (i.params ->> 'thread_id')::uuid;
    if v_tk is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'THREAD_NOT_FOUND', '{}'::jsonb); end if;
    v_reason := 'agent_cancel:' || coalesce(i.params ->> 'reason_code', 'other');
    v_fid := nullif(i.params ->> 'followup_intent_id', '')::uuid;
    if v_fid is not null then
      perform set_config('lc.followup_actor', 'agent:' || i.agent_id, true);
      perform pg_advisory_xact_lock(hashtextextended('followup_intent:' || v_tk, 0));
      select id, state, send_queue_id into f from public.followup_intents where id = v_fid and thread_key = v_tk for update;
      if f.id is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'FOLLOWUP_NOT_FOUND', '{}'::jsonb); end if;
      if f.state in ('planned', 'materializing', 'ready', 'held') then
        update public.followup_intents set state = 'cancelled', reason = v_reason, lease_token = null, lease_until = null, next_action = 'none' where id = f.id;
        rows_n := public.followup_intent_cancel_row(f.send_queue_id, v_reason, 'agent:' || i.agent_id);
        n := 1;
        perform public.followup_intent_project(v_tk);
      end if;
    else
      r := public.followup_intent_close_for_thread(jsonb_build_object('thread_key', v_tk, 'state', 'cancelled', 'reason', v_reason, 'actor', 'agent:' || i.agent_id,
                                                                     'kinds', case when i.params ? 'kind' then jsonb_build_array(i.params ->> 'kind') else null end));
      n := coalesce((r ->> 'closed')::int, 0);
      rows_n := coalesce((r ->> 'rows_cancelled')::int, 0);
    end if;
    return action_gateway.finish_intent(i.intent_id, 'succeeded', case when n > 0 then 'FOLLOWUP_CANCELLED' else 'NOTHING_LIVE_TO_CANCEL' end,
                                        jsonb_build_object('cancelled', n, 'rows_cancelled', rows_n, 'followup_intent_id', v_fid));
  exception when others then
    return action_gateway.finish_intent(i.intent_id, 'failed', 'DOMAIN_WRITE_FAILED', jsonb_build_object('sqlstate', sqlstate));
  end;
end
$fn$;

-- pause_campaign (T2, reversible safety action): THE lifecycle writer, immediately. Dispatch defers a paused
-- campaign's rows (queue/campaign-execution-authority); resuming is a human approval (request_campaign_resume).
create or replace function public.action_gateway_dw_campaign_pause(p_intent_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare b jsonb; i action_gateway.action_intents%rowtype; v_id uuid; v_from text; v_norm text;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['pause_campaign']);
  if b ? 'refused' then return b -> 'outcome'; end if;
  i := jsonb_populate_record(null::action_gateway.action_intents, b -> 'intent');
  begin
    v_id := (i.params ->> 'campaign_id')::uuid;
    select lower(btrim(coalesce(c.status, ''))) into v_from from public.campaigns c where c.id = v_id;
    if not found then return action_gateway.finish_intent(i.intent_id, 'failed', 'CAMPAIGN_NOT_FOUND', '{}'::jsonb); end if;
    v_norm := case v_from when 'live_limited' then 'active' when 'started' then 'activating' when 'live_scheduled' then 'scheduled' else v_from end;
    if v_norm = 'paused' then
      return action_gateway.finish_intent(i.intent_id, 'succeeded', 'ALREADY_PAUSED', jsonb_build_object('campaign_id', v_id, 'from_status', v_from, 'to_status', 'paused'));
    end if;
    if v_norm not in ('queued', 'scheduled', 'activating', 'active', 'failed') then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'CAMPAIGN_NOT_PAUSABLE', jsonb_build_object('campaign_id', v_id, 'from_status', v_from));
    end if;
    perform 1 from public.campaign_transition_status(v_id, 'paused', 'agent_pause:' || i.agent_id || ':' || coalesce(i.params ->> 'reason_code', 'other'), null);
    return action_gateway.finish_intent(i.intent_id, 'succeeded', 'CAMPAIGN_PAUSED', jsonb_build_object('campaign_id', v_id, 'from_status', v_from, 'to_status', 'paused'));
  exception when others then
    return action_gateway.finish_intent(i.intent_id, 'failed', 'DOMAIN_WRITE_FAILED', jsonb_build_object('sqlstate', sqlstate));
  end;
end
$fn$;

-- THE five REQUEST actions: ONE agent.approval_request of the action's FIXED capability for a HUMAN to decide
-- through the existing decide path (the plane's executeApproved runs the EXISTING service as that human).
-- p_request carries what only the JS capability code can compute (the drift snapshot hash, the payload hash,
-- the capability's own idempotency key, the summary); every AUTHORITY field (capability, target, intended
-- change) is verified here against the intent's params and the domain rows. A wrong hash can only make the
-- approval undecidable (the decide path refuses drift / a hash mismatch), never widen it.
create or replace function public.action_gateway_dw_human_request(p_intent_id uuid, p_lease_token uuid, p_request jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare
  b jsonb; i action_gateway.action_intents%rowtype; p jsonb; ic jsonb; base jsonb; v_cap text; v_display text[]; v_sponsor uuid; v_hex text; v_apr text;
  v_target jsonb; v_secs integer; r jsonb; t record; h record; c record; o record; k text; v jsonb; v_never text;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['update_lead_stage', 'update_lead_disposition', 'request_thread_hold_release', 'request_campaign_resume', 'adjust_campaign_plan']);
  if b ? 'refused' then return b -> 'outcome'; end if;
  i := jsonb_populate_record(null::action_gateway.action_intents, b -> 'intent');
  v_sponsor := (b ->> 'sponsor_user_id')::uuid;
  begin
    p := i.params;
    ic := coalesce(p_request -> 'intended_change', '{}'::jsonb);
    case i.action
      when 'update_lead_stage' then
        v_cap := 'pipeline.propose_stage_change'; v_display := array['from_stage'];
        v_target := jsonb_build_object('opportunity_id', p ->> 'opportunity_id');
        base := jsonb_build_object('action', 'stage_change', 'opportunity_id', p ->> 'opportunity_id', 'to_stage', p ->> 'to_stage', 'reason', p ->> 'reason', 'source', p ->> 'source');
        if lower(p ->> 'to_stage') in ('formal_contract', 'contract_to_close', 'disposition', 'under_contract', 'prepared_to_close', 'closed', 'closed_won', 'closed_lost') then
          return action_gateway.finish_intent(i.intent_id, 'refused', 'CONTRACT_OR_CLOSING_STAGE_REFUSED', '{}'::jsonb);
        end if;
        select id, primary_property_id into o from public.acquisition_opportunities where id = (p ->> 'opportunity_id')::uuid;
        if o.id is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'OPPORTUNITY_NOT_FOUND', '{}'::jsonb); end if;
        v_never := action_gateway.t2_never_revive(null, o.primary_property_id, o.id);
      when 'update_lead_disposition' then
        v_cap := 'inbox.prepare_disposition_change'; v_display := array['from_disposition'];
        v_target := jsonb_build_object('thread_id', p ->> 'thread_id');
        base := jsonb_build_object('action', 'disposition_change', 'thread_id', p ->> 'thread_id', 'to_disposition', p ->> 'to_disposition', 'reason', p ->> 'reason', 'source', p ->> 'source');
        if (p ->> 'to_disposition') not in ('interested', 'not_interested', 'referred', 'no_response', 'unqualified', 'duplicate', 'sold', 'declined_unverified') then
          return action_gateway.finish_intent(i.intent_id, 'refused', 'DISPOSITION_NOT_ALLOWED', '{}'::jsonb);
        end if;
        select id, property_id into t from public.inbox_thread_state where id = (p ->> 'thread_id')::uuid;
        if t.id is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'THREAD_NOT_FOUND', '{}'::jsonb); end if;
        v_never := action_gateway.t2_never_revive(t.id, t.property_id, null);
      when 'request_thread_hold_release' then
        v_cap := 'holds.prepare_release_approval'; v_display := array['hold_type'];
        v_target := jsonb_build_object('hold_id', p ->> 'hold_id');
        base := jsonb_build_object('action', 'hold_release', 'hold_id', p ->> 'hold_id', 'thread_id', p ->> 'thread_id', 'reason_code', p ->> 'reason_code', 'source', p ->> 'source')
                || case when p ? 'note' then jsonb_build_object('note', p ->> 'note') else '{}'::jsonb end;
        select s.id, s.thread_key, s.property_id into t from public.inbox_thread_state s where s.id = (p ->> 'thread_id')::uuid;
        if t.id is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'THREAD_NOT_FOUND', '{}'::jsonb); end if;
        select x.id, x.hold_key, x.hold_type, x.thread_key, x.inbox_thread_id, x.property_id, x.opportunity_id, x.released_at into h
          from public.automation_holds x where x.id = (p ->> 'hold_id')::uuid;
        if h.id is null or h.released_at is not null then return action_gateway.finish_intent(i.intent_id, 'refused', 'HOLD_NOT_ACTIVE', '{}'::jsonb); end if;
        if not (h.inbox_thread_id = t.id or h.thread_key = t.thread_key) then return action_gateway.finish_intent(i.intent_id, 'refused', 'HOLD_NOT_ON_THREAD', '{}'::jsonb); end if;
        if h.hold_type = 'permanent_exclusion' then return action_gateway.finish_intent(i.intent_id, 'refused', 'PERMANENT_EXCLUSION', '{}'::jsonb); end if;
        v_never := action_gateway.t2_never_revive(coalesce(h.inbox_thread_id, t.id), coalesce(h.property_id, t.property_id), h.opportunity_id, h.hold_key);
      when 'request_campaign_resume' then
        v_cap := 'campaigns.prepare_resume_approval'; v_display := array['from_status'];
        v_target := jsonb_build_object('campaign_id', p ->> 'campaign_id');
        base := jsonb_build_object('action', 'resume', 'campaign_id', p ->> 'campaign_id', 'reason', p ->> 'reason', 'source', p ->> 'source');
        select id, lower(btrim(coalesce(status, ''))) status into c from public.campaigns where id = (p ->> 'campaign_id')::uuid;
        if c.id is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'CAMPAIGN_NOT_FOUND', '{}'::jsonb); end if;
        if c.status <> 'paused' then return action_gateway.finish_intent(i.intent_id, 'refused', 'CAMPAIGN_NOT_PAUSED', jsonb_build_object('from_status', c.status)); end if;
      when 'adjust_campaign_plan' then
        v_cap := 'campaigns.prepare_plan_adjustment_approval'; v_display := array['from_status', 'before'];
        v_target := jsonb_build_object('campaign_id', p ->> 'campaign_id');
        base := jsonb_build_object('action', 'plan_adjustment', 'campaign_id', p ->> 'campaign_id', 'changes', p -> 'changes', 'reason', p ->> 'reason', 'source', p ->> 'source');
        select id, lower(btrim(coalesce(status, ''))) status into c from public.campaigns where id = (p ->> 'campaign_id')::uuid;
        if c.id is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'CAMPAIGN_NOT_FOUND', '{}'::jsonb); end if;
        if c.status in ('archived', 'completed') then return action_gateway.finish_intent(i.intent_id, 'refused', 'CAMPAIGN_CLOSED', '{}'::jsonb); end if;
        if jsonb_typeof(p -> 'changes') <> 'object' or p -> 'changes' = '{}'::jsonb then return action_gateway.finish_intent(i.intent_id, 'refused', 'NOTHING_TO_ADJUST', '{}'::jsonb); end if;
        -- bounded: caps, pacing and the texting window ONLY (never audience, market, filters, eligibility, live flags)
        for k, v in select * from jsonb_each(p -> 'changes') loop
          if k in ('daily_cap', 'total_cap', 'market_cap', 'per_sender_cap', 'batch_max') then
            if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) or (v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 100000 then
              return action_gateway.finish_intent(i.intent_id, 'refused', 'ADJUSTMENT_OUT_OF_BOUNDS', jsonb_build_object('field', k));
            end if;
          elsif k = 'send_interval_seconds' then
            if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric < 15 or (v #>> '{}')::numeric > 3600 then
              return action_gateway.finish_intent(i.intent_id, 'refused', 'ADJUSTMENT_OUT_OF_BOUNDS', jsonb_build_object('field', k));
            end if;
          elsif k in ('contact_window_start', 'contact_window_end') then
            if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^([01][0-9]|2[0-1]):[0-5][0-9]$' or (v #>> '{}') < '08:00' or (v #>> '{}') > '21:00' then
              return action_gateway.finish_intent(i.intent_id, 'refused', 'WINDOW_OUTSIDE_POLICY', jsonb_build_object('field', k));
            end if;
          else
            return action_gateway.finish_intent(i.intent_id, 'refused', 'ADJUSTMENT_FIELD_NOT_ALLOWED', jsonb_build_object('field', k));
          end if;
        end loop;
      else
        return action_gateway.finish_intent(i.intent_id, 'refused', 'WRONG_EXECUTOR', '{}'::jsonb);
    end case;
    if v_never is not null then return action_gateway.finish_intent(i.intent_id, 'refused', v_never, jsonb_build_object('stage', 'domain_write')); end if;
    -- the request the JS built must be exactly this capability, target and change (display keys excepted)
    if p_request ->> 'capability_id' is distinct from v_cap or (p_request ->> 'capability_version') is distinct from '1'
       or coalesce(p_request -> 'target', 'null'::jsonb) <> v_target
       or (ic - v_display) <> base then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'REQUEST_DOES_NOT_MATCH_INTENT', jsonb_build_object('capability_id', v_cap));
    end if;
    if coalesce(p_request ->> 'snapshot_hash', '') !~ '^[0-9a-f]{64}$' or coalesce(p_request ->> 'payload_hash', '') !~ '^[0-9a-f]{64}$'
       or coalesce(p_request ->> 'idempotency_key', '') !~ '^[0-9a-f]{64}$' or jsonb_typeof(coalesce(p_request -> 'summary', '[]'::jsonb)) <> 'array' then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'REQUEST_MALFORMED', '{}'::jsonb);
    end if;
    v_hex := md5('action_gateway_request:' || i.intent_id::text);
    v_apr := 'apr_' || substr(v_hex, 1, 8) || '-' || substr(v_hex, 9, 4) || '-' || substr(v_hex, 13, 4) || '-' || substr(v_hex, 17, 4) || '-' || substr(v_hex, 21, 12);
    v_secs := least(greatest(coalesce((p_request ->> 'ttl_seconds')::int, 1800), 60), 86400 - 60);
    r := agent.capability_approval_insert(jsonb_build_object(
      'approval_id', v_apr, 'org_id', i.org_id, 'capability_id', v_cap, 'capability_version', 1, 'tier', 'requires_explicit_approval',
      'requested_by', v_sponsor, 'provenance', 'model', 'target', v_target, 'intended_change', ic,
      'summary', coalesce(p_request -> 'summary', '[]'::jsonb), 'snapshot_hash', p_request ->> 'snapshot_hash', 'payload_hash', p_request ->> 'payload_hash',
      'idempotency_key', p_request ->> 'idempotency_key', 'expires_at', now() + make_interval(secs => v_secs), 'created_at', now()));
    if not coalesce((r ->> 'inserted')::boolean, false) and coalesce(r -> 'row' ->> 'state', '') <> 'pending' then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'IDENTICAL_REQUEST_ALREADY_DECIDED',
                                          jsonb_build_object('approval_id', r -> 'row' ->> 'approval_id', 'approval_state', r -> 'row' ->> 'state'));
    end if;
    return action_gateway.finish_intent(i.intent_id, 'succeeded', 'HUMAN_APPROVAL_REQUESTED',
                                        jsonb_build_object('approval_id', r -> 'row' ->> 'approval_id', 'capability_id', v_cap, 'deduped', not coalesce((r ->> 'inserted')::boolean, false),
                                                           'expires_at', r -> 'row' ->> 'expires_at', 'decided_by', 'a named operator (agents never decide)'));
  exception when others then
    return action_gateway.finish_intent(i.intent_id, 'failed', 'DOMAIN_WRITE_FAILED', jsonb_build_object('sqlstate', sqlstate));
  end;
end
$fn$;

-- ───────────────────────────────────────────── 5. privileges + registration ──
do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'public' and p.proname in ('action_gateway_dw_deal_action', 'action_gateway_dw_followup_schedule', 'action_gateway_dw_followup_cancel',
                                                          'action_gateway_dw_campaign_pause', 'action_gateway_dw_human_request', 'action_gateway_followup_intents'))
               or (n.nspname = 'action_gateway' and p.proname = 't2_never_revive') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
end $$;
grant execute on function public.action_gateway_dw_deal_action(uuid, uuid), public.action_gateway_dw_followup_schedule(uuid, uuid),
  public.action_gateway_dw_followup_cancel(uuid, uuid), public.action_gateway_dw_campaign_pause(uuid, uuid),
  public.action_gateway_dw_human_request(uuid, uuid, jsonb), public.action_gateway_followup_intents(uuid) to lc_action_gateway;

insert into action_gateway.extensions (kind, name, link, basis) values
  ('definer_function', 'public.action_gateway_dw_deal_action(uuid,uuid)', 'PROPOSED_20261020100000_action_gateway_t2', null),
  ('definer_function', 'public.action_gateway_dw_followup_schedule(uuid,uuid)', 'PROPOSED_20261020100000_action_gateway_t2', null),
  ('definer_function', 'public.action_gateway_dw_followup_cancel(uuid,uuid)', 'PROPOSED_20261020100000_action_gateway_t2', null),
  ('definer_function', 'public.action_gateway_dw_campaign_pause(uuid,uuid)', 'PROPOSED_20261020100000_action_gateway_t2', null),
  ('definer_function', 'public.action_gateway_dw_human_request(uuid,uuid,jsonb)', 'PROPOSED_20261020100000_action_gateway_t2', null),
  ('definer_function', 'public.action_gateway_followup_intents(uuid)', 'PROPOSED_20261020100000_action_gateway_t2', null),
  ('domain_write_action', 'create_deal_action', 'PROPOSED_20261020100000_action_gateway_t2', null),
  ('domain_write_action', 'schedule_followup', 'PROPOSED_20261020100000_action_gateway_t2', null),
  ('domain_write_action', 'cancel_followup', 'PROPOSED_20261020100000_action_gateway_t2', null),
  ('domain_write_action', 'pause_campaign', 'PROPOSED_20261020100000_action_gateway_t2', null),
  ('domain_write_action', 'update_lead_stage', 'PROPOSED_20261020100000_action_gateway_t2', null),
  ('domain_write_action', 'update_lead_disposition', 'PROPOSED_20261020100000_action_gateway_t2', null),
  ('domain_write_action', 'request_thread_hold_release', 'PROPOSED_20261020100000_action_gateway_t2', null),
  ('domain_write_action', 'request_campaign_resume', 'PROPOSED_20261020100000_action_gateway_t2', null),
  ('domain_write_action', 'adjust_campaign_plan', 'PROPOSED_20261020100000_action_gateway_t2', null),
  ('standing_t2_action', 'pause_campaign', 'PROPOSED_20261020100000_action_gateway_t2', 'reversible'),
  ('standing_t2_action', 'cancel_followup', 'PROPOSED_20261020100000_action_gateway_t2', 'reversible'),
  ('standing_t2_action', 'schedule_followup', 'PROPOSED_20261020100000_action_gateway_t2', 'reversible'),
  ('standing_t2_action', 'create_deal_action', 'PROPOSED_20261020100000_action_gateway_t2', 'reversible'),
  ('standing_t2_action', 'update_lead_stage', 'PROPOSED_20261020100000_action_gateway_t2', 'request_only'),
  ('standing_t2_action', 'update_lead_disposition', 'PROPOSED_20261020100000_action_gateway_t2', 'request_only'),
  ('standing_t2_action', 'request_thread_hold_release', 'PROPOSED_20261020100000_action_gateway_t2', 'request_only'),
  ('standing_t2_action', 'request_campaign_resume', 'PROPOSED_20261020100000_action_gateway_t2', 'request_only'),
  ('standing_t2_action', 'adjust_campaign_plan', 'PROPOSED_20261020100000_action_gateway_t2', 'request_only');

-- ───────────────────────────────────────────── 6. the apply refuses unless the role is exactly this ──
do $$
declare v jsonb;
begin
  v := action_gateway.self_check('lc_action_gateway');
  if not coalesce((v ->> 'ok')::boolean, false) then
    raise exception 'action_gateway_t2: self-check refused the role: %', v -> 'findings';
  end if;
  if not ('pause_campaign' = any (action_gateway.standing_t2_actions())) or not ('set_thread_hold' = any (action_gateway.standing_t2_actions())) then
    raise exception 'postcondition: standing_t2_actions() does not read the registry';
  end if;
end $$;

notify pgrst, 'reload schema';
