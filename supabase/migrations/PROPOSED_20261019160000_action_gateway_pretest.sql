-- PRETEST for PROPOSED_20261019160000_action_gateway.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It is read-only and ends in ROLLBACK. The runner proves it leaves no trace (same
-- catalog fingerprint, same row counts).
-- Asserts the prerequisites the apply relies on:
--   * PostgREST's authenticator role exists; schema action_gateway does not;
--   * lc_action_gateway is absent, or NOLOGIN NOINHERIT with no privileged attribute;
--   * the R2 runtime, the capability approvals, operations (+ #24 conversation scope), the P0 hold
--     registry and every read-inventory relation exist;
--   * public.system_control has row level security enabled;
--   * (NOTICE only) whether PUBLIC can reach pg_net (schema net) and whether it LOOKS like Supabase's
--     platform-managed pg_net (schema owner supabase_admin, extension pg_net present): only then can the
--     apply's self-check apply the pinned platform exception (docs/SUPABASE-PG-NET-POSTURE.md); any other
--     shape refuses the apply.
begin;
do $$
declare
  rels text[] := array['acquisition_opportunities','automation_holds','automation_suppressions','campaigns','contact_property_resolution',
                       'inbox_thread_state','message_events','phones','properties','prospects','seller_offers',
                       'send_queue','sms_suppression_list','system_control','conversation_ai_reply_policy'];
  t text; problems text[] := '{}';
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then problems := problems || 'authenticator missing'::text; end if;
  if to_regnamespace('action_gateway') is not null then problems := problems || 'schema action_gateway already exists'::text; end if;
  if exists (select 1 from pg_roles where rolname = 'lc_action_gateway' and (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) then
    problems := problems || 'lc_action_gateway exists with privileged attributes'::text;
  end if;
  foreach t in array array['agent.org','agent.operator_membership','agent.approval_request','agent.research_job','agent.ops_work_item','agent.runtime_limits'] loop
    if to_regclass(t) is null then problems := problems || ('missing ' || t); end if;
  end loop;
  foreach t in array rels loop
    if to_regclass(format('public.%I', t)) is null then problems := problems || ('missing relation public.' || t); end if;
  end loop;
  foreach t in array array['agent.payload_is_clean(jsonb)','agent.capability_approval_insert(jsonb)',
      'agent.runtime_enqueue(text,text,jsonb,text,integer,integer,numeric,boolean,timestamp with time zone)',
      'agent.ops_pipeline_facts(uuid,integer)','agent.ops_scope_of_kind(text)','public.automation_hold_for(text,uuid,text,uuid,text,text)'] loop
    if to_regprocedure(t) is null then problems := problems || ('missing function ' || t); end if;
  end loop;
  if to_regprocedure('agent.ops_scope_of_kind(text)') is not null and agent.ops_scope_of_kind('conversation.turn') is distinct from 'conversation' then
    problems := problems || 'conversation_turn_operator_items (#24) not applied'::text;
  end if;
  if to_regclass('public.system_control') is not null and not (select relrowsecurity from pg_class where oid = 'public.system_control'::regclass) then
    problems := problems || 'public.system_control has no row level security'::text;
  end if;
  if array_length(problems, 1) > 0 then raise exception 'pretest: %', array_to_string(problems, '; '); end if;
  raise notice 'pretest: prerequisites present; pg_net reachable by PUBLIC = %; supabase-managed shape (owner supabase_admin + extension pg_net) = %',
    to_regnamespace('net') is not null and has_schema_privilege('public', 'net', 'USAGE'),
    to_regnamespace('net') is not null and exists (select 1 from pg_extension where extname = 'pg_net')
      and (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'net') = 'supabase_admin';
end $$;
rollback;
