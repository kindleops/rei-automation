-- =============================================================================
-- ROLLBACK of PROPOSED_20261105120000_action_gateway_service_principals.sql
-- STATUS: PROPOSED. Run only with the owner's approval, like the apply. Tested on disposable PostgreSQL 17 only.
-- =============================================================================
-- REFUSES (nothing is dropped) while:
--   * any create_campaign_draft intent is pending (received / awaiting_approval / authorized / executing);
--   * any authorization came through a service (action_authorizations.via_service_id is evidence in an immutable
--     ledger): after use, switch the integration off instead (revoke the service principal, disable its delegates);
--   * any agent principal has no credential of its own (a delegate-only agent): mint it a credential first.
-- Then deletes this link's registry rows, drops the two functions, restores #28's action_gateway.authorization_guard body
-- verbatim, drops the via column, restores NOT NULL on agent_principals.credential_digest and drops both registries.
-- Campaign drafts already created stay (business rows; archive them from Campaign Command).

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
begin
  if to_regclass('action_gateway.service_principals') is null then raise exception 'rollback precondition: the service principals link is not applied'; end if;
  if exists (select 1 from action_gateway.action_intents where action = 'create_campaign_draft' and state in ('received', 'awaiting_approval', 'authorized', 'executing')) then
    raise exception 'rollback precondition: create_campaign_draft intents are still pending; drain them first';
  end if;
  if exists (select 1 from action_gateway.action_authorizations where via_service_id is not null) then
    raise exception 'rollback precondition: delegated authorizations exist (immutable ledger evidence); revoke the service principal and disable its delegates instead';
  end if;
  if exists (select 1 from action_gateway.agent_principals where credential_digest is null) then
    raise exception 'rollback precondition: delegate-only agent principals (no credential of their own) exist; mint them credentials first';
  end if;
end $$;

delete from action_gateway.extensions where link = 'PROPOSED_20261105120000_action_gateway_service_principals';

drop function public.action_gateway_dw_campaign_draft(uuid, uuid);
drop function public.action_gateway_service_principal(text, text);
drop function action_gateway.agent_principal_json(action_gateway.agent_principals);

-- #28's authorization guard, verbatim
create or replace function action_gateway.authorization_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  i action_gateway.action_intents%rowtype;
  p action_gateway.agent_principals%rowtype;
  g action_gateway.capability_grants%rowtype;
  a agent.approval_request%rowtype;
  v_code text;
  v_envelope_ok boolean := false;
  v_digest text := nullif(current_setting('action_gateway.presented_digest', true), '');
begin
  if tg_op <> 'INSERT' then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_APPEND_ONLY: authorizations are immutable'; end if;
  select * into i from action_gateway.action_intents where intent_id = new.intent_id for update;
  if i.intent_id is null or i.org_id <> new.org_id or i.agent_id <> new.agent_id or i.capability <> new.capability or i.tier <> new.tier then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_AUTHZ_MISMATCH: the authorization does not match its intent';
  end if;
  if new.envelope_ref is not null then
    if new.approval_id is not null then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_ENVELOPE_WITH_APPROVAL: an envelope ref and an approval are never combined'; end if;
    v_code := action_gateway.envelope_ref_refusal(i.intent_id, new.envelope_ref);
    if v_code is not null then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_' || v_code; end if;
    v_envelope_ok := true;
  end if;
  if i.state not in ('received', 'awaiting_approval') then
    raise exception using errcode = 'P0001', message = format('ACTION_GATEWAY_AUTHZ_STATE: a %s intent cannot be authorized', i.state);
  end if;
  select * into p from action_gateway.agent_principals where agent_id = i.agent_id;
  if p.agent_id is null or p.org_id <> i.org_id or p.status <> 'active' or p.credential_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_PRINCIPAL_INACTIVE';
  end if;
  -- the gateway must present the agent's own credential digest (set by action_gateway_authorize, transaction-local)
  if v_digest is null or v_digest <> p.credential_digest then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_CREDENTIAL_MISMATCH: the presented agent credential does not match the intent agent';
  end if;
  if not exists (select 1 from agent.operator_membership m where m.org_id = p.org_id and m.user_id = p.sponsor_user_id) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_SPONSOR_NOT_MEMBER';
  end if;
  if p.tier_ceiling < i.tier then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_TIER_ABOVE_CEILING'; end if;
  -- the STANDING GRANT: locked for the rest of the transaction, so concurrent uses serialize on its caps
  select * into g from action_gateway.capability_grants where grant_id = new.grant_id for update;
  v_code := action_gateway.grant_refusal(g, i, new.approval_id is not null or v_envelope_ok);
  if v_code is not null then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_' || case when v_code = 'GRANT_INVALID' then 'GRANT_INVALID: no active grant covers this capability and tier' else v_code end;
  end if;
  v_code := action_gateway.control_refusal(i.capability, i.tier);
  if v_code is not null then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_' || v_code; end if;
  if new.approval_required and new.approval_id is null then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_APPROVAL_REQUIRED'; end if;
  if new.approval_id is not null then
    -- a HUMAN decision recorded through the existing operator approval path, bound to THIS intent,
    -- these parameters and this agent, not yet expired; single use is the unique approval_id
    select * into a from agent.approval_request where approval_id = new.approval_id;
    if a.approval_id is null or a.org_id <> i.org_id or a.capability_id <> 'agent_actions.authorize_action' or a.capability_version <> 1
       or a.state <> 'executed' or a.decision <> 'approve' or a.decided_by is null
       or not exists (select 1 from agent.operator_membership m where m.org_id = a.org_id and m.user_id = a.decided_by)
       or (a.target ->> 'intent_id') is distinct from i.intent_id::text
       or (a.intended_change ->> 'intent_id') is distinct from i.intent_id::text
       or (a.intended_change ->> 'params_hash') is distinct from i.params_hash
       or (a.intended_change ->> 'agent_id') is distinct from i.agent_id
       or (a.intended_change ->> 'action') is distinct from i.action
       or i.approval_id is distinct from a.approval_id then
      raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_APPROVAL_INVALID: no executed human approval binds this intent and its parameters';
    end if;
    if coalesce((a.intended_change ->> 'grant_expires_at')::timestamptz, '-infinity'::timestamptz) <= now() then
      raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_APPROVAL_EXPIRED';
    end if;
    new.approved_by := a.decided_by;
  else
    new.approved_by := null;
  end if;
  new.sponsor_user_id := p.sponsor_user_id;
  new.spend_usd := coalesce(case when jsonb_typeof(i.params -> 'budget_usd') = 'number' then (i.params ->> 'budget_usd')::numeric end, 0);
  new.decided_at := clock_timestamp();
  return new;
end
$fn$;

alter table action_gateway.action_authorizations drop column via_service_id;
alter table action_gateway.agent_principals alter column credential_digest set not null;
comment on column action_gateway.agent_principals.credential_digest is null;

drop table action_gateway.service_delegates;
drop table action_gateway.service_principals;
drop function action_gateway.service_delegate_guard();
drop function action_gateway.service_principal_guard();

do $$
begin
  if not coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false) then
    raise exception 'postcondition: the self-check is not ok: %', action_gateway.self_check('lc_action_gateway') -> 'findings';
  end if;
  if pg_get_functiondef('action_gateway.authorization_guard()'::regprocedure) ~ 'DELEGATE_NOT_ENABLED' then raise exception 'postcondition: the delegated branch is still present'; end if;
end $$;

notify pgrst, 'reload schema';
