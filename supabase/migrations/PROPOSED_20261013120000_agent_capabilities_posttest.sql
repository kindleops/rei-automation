-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261013120000_agent_capabilities.sql (formerly the second
-- half of its pretest). Runs AFTER the runner applied the migration on a disposable database;
-- asserts schema, grants and behaviour (insert/dedupe, membership, state graph, CAS, immutability,
-- no delete, append-only audit, PII CHECKs, role reach) inside BEGIN … ROLLBACK.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id agent_capabilities
-- Expected last notice: "pretest(agent_capabilities): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;

-- ── schema + grants ─────────────────────────────────────────────────────────
do $$
declare n int;
begin
  if exists (select 1 from pg_class c where c.oid in ('agent.approval_request'::regclass, 'agent.capability_audit'::regclass) and not (c.relrowsecurity and c.relforcerowsecurity)) then
    raise exception 'assert: RLS enabled + forced on both tables';
  end if;
  select count(*) into n from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p where has_table_privilege('agent_api', 'agent.approval_request', p);
  if n > 0 then raise exception 'assert: agent_api has no direct write on approval_request (% found)', n; end if;
  if has_table_privilege('agent_api', 'agent.capability_audit', 'UPDATE') or has_table_privilege('agent_api', 'agent.capability_audit', 'DELETE') then
    raise exception 'assert: audit is append-only for agent_api';
  end if;
  if not has_table_privilege('agent_api', 'agent.capability_audit', 'INSERT') then raise exception 'assert: agent_api appends audit'; end if;
  if has_table_privilege('anon', 'agent.approval_request', 'SELECT') or has_table_privilege('anon', 'agent.capability_audit', 'SELECT') then raise exception 'assert: anon reads nothing'; end if;
  select count(*) into n from unnest(array['INSERT','UPDATE','DELETE']) p
   where has_table_privilege('authenticated', 'agent.approval_request', p) or has_table_privilege('authenticated', 'agent.capability_audit', p);
  if n > 0 then raise exception 'assert: authenticated writes nothing'; end if;
  if has_function_privilege('authenticated', 'agent.capability_approval_insert(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'agent.capability_approval_transition(uuid, text, text[], text, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'agent.capability_approval_transition(uuid, text, text[], text, jsonb)', 'EXECUTE') then
    raise exception 'assert: anon / authenticated execute no capability function';
  end if;
  if not has_function_privilege('agent_api', 'agent.capability_approval_transition(uuid, text, text[], text, jsonb)', 'EXECUTE') then raise exception 'assert: agent_api executes the transition'; end if;
  if (select coalesce(string_agg(p.proname, ','), '') from pg_proc p where p.pronamespace = 'agent'::regnamespace and p.proname like 'capability%' and has_function_privilege('authenticated', p.oid, 'EXECUTE')) <> '' then
    raise exception 'assert: authenticated may execute no capability function';
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'agent'::regnamespace and p.prosecdef and p.proname like 'capability%' and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) then
    raise exception 'assert: every SECURITY DEFINER function pins search_path';
  end if;
  raise notice 'pretest(agent_capabilities): schema + grants OK';
end
$$;

-- ── behaviour (all writes roll back) ────────────────────────────────────────
do $$
declare
  org constant uuid := '00000000-0000-4000-8000-00000000a001';
  op constant uuid := '11111111-1111-4111-8111-111111111111';
  stranger constant uuid := '22222222-2222-4222-8222-222222222222';
  h1 constant text := encode(sha256('pretest-snapshot'::bytea), 'hex');
  h2 constant text := encode(sha256('pretest-payload'::bytea), 'hex');
  k1 constant text := encode(sha256('pretest-idem-1'::bytea), 'hex');
  k2 constant text := encode(sha256('pretest-idem-2'::bytea), 'hex');
  base jsonb;
  r jsonb; id1 text; ok boolean;
begin
  insert into agent.operator_membership (org_id, user_id, role, added_by) values (org, op, 'owner', 'pretest') on conflict do nothing;
  base := jsonb_build_object('org_id', org, 'capability_id', 'inbox.prepare_reply', 'capability_version', 1, 'tier', 'requires_explicit_approval',
    'requested_by', op, 'provenance', 'model', 'target', jsonb_build_object('thread_ref', 'thr_abcdefghijklmnopabcdefghijklmnopabcd', 'thread_hash', h1, 'recipient_mask', '•••-••47'),
    'intended_change', jsonb_build_object('action', 'send_template_reply', 'template_id', 'tpl_pretest', 'rendered_hash', h2, 'rendered_chars', 120),
    'summary', jsonb_build_array('Send 1 SMS reply to •••-••47 using sms_templates "tpl_pretest"'),
    'snapshot_hash', h1, 'payload_hash', h2, 'idempotency_key', k1, 'expires_at', now() + interval '15 minutes');

  -- insert + dedupe
  r := agent.capability_approval_insert(base || jsonb_build_object('approval_id', 'apr_' || gen_random_uuid()));
  if not (r ->> 'inserted')::boolean or (r -> 'row' ->> 'state') <> 'pending' then raise exception 'assert: insert pending (%)', r; end if;
  id1 := r -> 'row' ->> 'approval_id';
  r := agent.capability_approval_insert(base || jsonb_build_object('approval_id', 'apr_' || gen_random_uuid()));
  if (r ->> 'inserted')::boolean or (r -> 'row' ->> 'approval_id') <> id1 then raise exception 'assert: same idempotency key dedupes to the first approval'; end if;

  -- a non-member cannot request
  begin
    perform agent.capability_approval_insert(base || jsonb_build_object('approval_id', 'apr_' || gen_random_uuid(), 'requested_by', stranger, 'idempotency_key', k2));
    raise exception 'assert: non-member request must be refused';
  exception when check_violation then null;
  end;

  -- PII CHECKs: a phone or a message body is refused
  begin
    perform agent.capability_approval_insert(base || jsonb_build_object('approval_id', 'apr_' || gen_random_uuid(), 'idempotency_key', k2, 'target', jsonb_build_object('thread_key', '+12145550147')));
    raise exception 'assert: a raw phone in target must be refused';
  exception when check_violation then null;
  end;
  begin
    perform agent.capability_approval_insert(base || jsonb_build_object('approval_id', 'apr_' || gen_random_uuid(), 'idempotency_key', k2, 'intended_change', jsonb_build_object('message_body', 'hello there')));
    raise exception 'assert: a message body in intended_change must be refused';
  exception when check_violation then null;
  end;

  -- CAS: wrong from-state changes nothing
  if agent.capability_approval_transition(org, id1, array['executing'], 'executed', jsonb_build_object('executed_at', now())) is not null then raise exception 'assert: CAS from a wrong state is a no-op'; end if;
  -- cross-org: another org id finds nothing
  if agent.capability_approval_transition('00000000-0000-4000-8000-00000000ffff', id1, array['pending'], 'denied', jsonb_build_object('decided_by', op, 'decided_at', now(), 'decision', 'deny')) is not null then raise exception 'assert: a foreign org cannot transition'; end if;
  -- a non-member decider is refused
  begin
    perform agent.capability_approval_transition(org, id1, array['pending'], 'executing', jsonb_build_object('decided_by', stranger, 'decided_at', now(), 'decision', 'approve'));
    raise exception 'assert: non-member decider must be refused';
  exception when check_violation then null;
  end;
  -- disallowed patch key
  begin
    perform agent.capability_approval_transition(org, id1, array['pending'], 'executing', jsonb_build_object('target', '{}'::jsonb));
    raise exception 'assert: patch keys are limited';
  exception when check_violation then null;
  end;
  -- legal path pending → executing → executed; then nothing
  r := agent.capability_approval_transition(org, id1, array['pending'], 'executing', jsonb_build_object('decided_by', op, 'decided_at', now(), 'decision', 'approve'));
  if (r ->> 'state') <> 'executing' then raise exception 'assert: pending → executing'; end if;
  if agent.capability_approval_transition(org, id1, array['pending'], 'executing', jsonb_build_object('decided_by', op, 'decided_at', now(), 'decision', 'approve')) is not null then raise exception 'assert: a second claim finds nothing (exactly one executes)'; end if;
  r := agent.capability_approval_transition(org, id1, array['executing'], 'executed', jsonb_build_object('executed_at', now(), 'execution_result', jsonb_build_object('ok', true, 'status', 'queued')));
  if (r ->> 'state') <> 'executed' then raise exception 'assert: executing → executed'; end if;
  begin
    update agent.approval_request set state = 'pending' where approval_id = id1;
    raise exception 'assert: executed is final';
  exception when check_violation then null;
  end;
  begin
    update agent.approval_request set intended_change = '{"action":"other"}'::jsonb, state = 'failed' where approval_id = id1;
    raise exception 'assert: immutable fields';
  exception when check_violation then null;
  end;
  begin
    delete from agent.approval_request where approval_id = id1;
    raise exception 'assert: approvals are never deleted';
  exception when check_violation then null;
  end;

  -- audit append-only + PII CHECK
  insert into agent.capability_audit (org_id, capability_id, capability_version, actor, source, tier, decision, code, summary)
  values (org, 'inbox.prepare_reply', 1, op, 'model', 'requires_explicit_approval', 'approval_requested', null, '{"prepared":true}');
  begin
    update agent.capability_audit set code = 'X' where org_id = org;
    raise exception 'assert: audit is append-only';
  exception when check_violation then null;
  end;
  begin
    insert into agent.capability_audit (org_id, capability_id, actor, source, decision, summary) values (org, 'x.y', op, 'model', 'read', '{"note":"call 214 555 0147"}');
    raise exception 'assert: audit summary PII CHECK';
  exception when check_violation then null;
  end;

  -- agent_api reach: select yes, direct update no. Asserted from the privilege catalog + RLS
  -- policies (rc-8.5.15 pretest v2, folded in by rc-8.5.20) AND behaviourally via SET ROLE
  -- (disposable database only — production's applying role has no SET option on agent_api).
  if not has_table_privilege('agent_api', 'agent.approval_request', 'SELECT') then raise exception 'assert: agent_api reads approvals (catalog)'; end if;
  if not exists (select 1 from pg_policies where schemaname = 'agent' and tablename = 'approval_request' and policyname = 'agent_api_select' and 'agent_api' = any (roles) and cmd = 'SELECT') then
    raise exception 'assert: agent_api SELECT policy on approval_request';
  end if;
  if has_table_privilege('agent_api', 'agent.approval_request', 'UPDATE') or exists (select 1 from pg_policies where schemaname = 'agent' and tablename = 'approval_request' and cmd in ('UPDATE','ALL','DELETE','INSERT')) then
    raise exception 'assert: agent_api cannot update approvals directly (catalog)';
  end if;
  set local role agent_api;
  if (select count(*) from agent.approval_request where approval_id = id1) <> 1 then raise exception 'assert: agent_api reads approvals'; end if;
  ok := false;
  begin
    update agent.approval_request set state = 'failed' where approval_id = id1;
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'assert: agent_api cannot update approvals directly'; end if;
  reset role;
  raise notice 'pretest(agent_capabilities): behaviour OK';
end
$$;
do $$ begin raise notice 'pretest(agent_capabilities): ALL OK (rolled back)'; end $$;
rollback;
