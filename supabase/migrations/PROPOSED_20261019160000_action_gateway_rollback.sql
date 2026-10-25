-- =============================================================================
-- ROLLBACK of PROPOSED_20261019160000_action_gateway.sql
-- STATUS: PROPOSED. Run only with the owner's approval, like the apply.
-- Tested on disposable PostgreSQL 17 only: the runner proves that apply → rollback restores the
-- pre-apply catalog fingerprint exactly (ACLs, policies, functions, constraints, roles).
-- =============================================================================
-- REFUSES (nothing is dropped) while:
--   * any action intent is still pending (received / awaiting_approval / authorized / executing):
--     drain it first (it finishes, or an operator refuses it), the audit trail is the record;
--   * any agent-scope operator task exists in agent.ops_work_item (an operator resolves / exports it
--     first: the rollback never deletes operator items, and the restored CHECK would refuse them).
-- Then drops EXACTLY what the apply created:
--   * the policies lc_action_gateway_select on the read inventory, public.system_control and the three
--     agent tables, and the role's grants on them, on schema agent and on the five existing functions;
--   * every public.action_gateway_* function; schema action_gateway (its tables, triggers, functions);
--   * the original agent.ops_work_item scope / kind CHECKs (as left by #24);
--   * the membership lc_action_gateway → authenticator, then role lc_action_gateway.
-- No business row is touched: public.automation_holds rows set by the gateway STAY (they are holds;
-- releasing them is an operator decision in the hold registry).
--
-- KILL SWITCH without a rollback: `revoke lc_action_gateway from authenticator;` (PostgREST can no
-- longer switch to the role) and/or delete system_control.action_gateway_enabled (every action refused).

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
begin
  if to_regnamespace('action_gateway') is null then raise exception 'rollback precondition: action_gateway is not applied'; end if;
  if exists (select 1 from action_gateway.action_intents where state in ('received', 'awaiting_approval', 'authorized', 'executing')) then
    raise exception 'rollback precondition: % action intent(s) are still pending; drain them first',
      (select count(*) from action_gateway.action_intents where state in ('received', 'awaiting_approval', 'authorized', 'executing'));
  end if;
  if exists (select 1 from agent.ops_work_item where scope = 'agent' or kind = 'agent_task') then
    raise exception 'rollback precondition: agent-scope operator tasks exist in agent.ops_work_item; an operator resolves / exports them first';
  end if;
end $$;

do $$
declare t text; role_exists boolean := exists (select 1 from pg_roles where rolname = 'lc_action_gateway');
begin
  foreach t in array action_gateway.read_inventory() loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;
    if exists (select 1 from pg_policy where polrelid = to_regclass(format('public.%I', t)) and polname = 'lc_action_gateway_select') then
      execute format('drop policy lc_action_gateway_select on public.%I', t);
    end if;
    if role_exists then execute format('revoke all on public.%I from lc_action_gateway', t); end if;
  end loop;
  foreach t in array array['approval_request', 'operator_membership', 'ops_work_item'] loop
    if exists (select 1 from pg_policy where polrelid = to_regclass(format('agent.%I', t)) and polname = 'lc_action_gateway_select') then
      execute format('drop policy lc_action_gateway_select on agent.%I', t);
    end if;
    if role_exists then execute format('revoke all on agent.%I from lc_action_gateway', t); end if;
  end loop;
  if role_exists then
    revoke all on function agent.capability_approval_insert(jsonb), agent.ops_pipeline_facts(uuid, integer), agent.payload_is_clean(jsonb),
      agent.payload_violation(jsonb, text), agent.payload_string_violation(text, text, integer), agent.payload_norm_key(text), agent.payload_b64_decode(text),
      public.automation_hold_for(text, uuid, text, uuid, text, text) from lc_action_gateway;
    revoke usage on schema agent from lc_action_gateway;
  end if;
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text sig from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'action\_gateway\_%' loop
    execute format('drop function %s', f.sig);
  end loop;
end $$;

-- G1: these two egress functions are a SYNCED, byte-identical block shared with lc_mcp_reader (the read-only
-- Reader). When the Reader is applied first (its documented order), #26 only re-creates them unchanged and adds
-- EXECUTE for lc_action_gateway. Dropping them here deleted functions the Reader's self-check needs (it re-checks
-- periodically and fails closed: every Reader call would be refused). Found by phase_a0_gateway_from_production_state.
-- With the Reader present: keep them, revoke only the gateway's EXECUTE.
do $$
begin
  if to_regprocedure('public.lc_mcp_reader_self_check(text[],text[],name)') is not null then
    if exists (select 1 from pg_roles where rolname = 'lc_action_gateway') then
      revoke all on function public.lc_reachable_egress_indirect(oid) from lc_action_gateway;
      revoke all on function public.lc_egress_platform_allowlists() from lc_action_gateway;
    end if;
  else
    drop function if exists public.lc_reachable_egress_indirect(oid);
    drop function if exists public.lc_egress_platform_allowlists();
  end if;
end $$;

drop schema action_gateway cascade;

alter table agent.ops_work_item drop constraint ops_work_item_scope_check;
alter table agent.ops_work_item add constraint ops_work_item_scope_check check (scope in ('recovery', 'action_center', 'pipeline', 'supervisor', 'conversation'));
alter table agent.ops_work_item drop constraint ops_work_item_kind_check;
alter table agent.ops_work_item add constraint ops_work_item_kind_check check (kind in ('recovery_research', 'recovery_followup', 'recovery_review', 'lost_conversation', 'pipeline_mismatch', 'remediation', 'escalation'));

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'lc_action_gateway') then
    if exists (select 1 from pg_roles where rolname = 'authenticator') then revoke lc_action_gateway from authenticator; end if;
    drop role lc_action_gateway;
  end if;
end $$;

notify pgrst, 'reload schema';
