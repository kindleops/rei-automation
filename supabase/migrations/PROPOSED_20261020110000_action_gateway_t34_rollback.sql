-- =============================================================================
-- ROLLBACK of PROPOSED_20261020110000_action_gateway_t34.sql
-- STATUS: PROPOSED. Run only with the owner's approval, like the apply.
-- Tested on disposable PostgreSQL 17 only: the runner proves apply → rollback restores the pre-apply catalog
-- fingerprint exactly (#26's self-check and authorization guard included).
-- =============================================================================
-- REFUSES (nothing is dropped) while:
--   * any T3 / T4 intent is pending (received / awaiting_approval / authorized / executing);
--   * any receipt is still open (requested / executing / enqueued): LeadCommand's worker / an operator finishes it;
--   * any durable send-budget use exists (it is the evidence of a priced send; export it first).
-- Then drops exactly what the apply created, restores #26's action_gateway.authorization_guard body verbatim and
-- renames action_gateway.self_check_pre_t34 back to action_gateway.self_check. Business rows (seller_offers,
-- negotiation_envelopes granted through submit_offer_for_approval, send_queue rows, operator work items) STAY.

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
begin
  if to_regclass('action_gateway.seller_action_receipts') is null then raise exception 'rollback precondition: the t34 link is not applied'; end if;
  if exists (select 1 from action_gateway.action_intents where action in ('queue_authorized_reply', 'submit_offer_for_approval', 'execute_authorized_offer', 'record_seller_counteroffer')
              and state in ('received', 'awaiting_approval', 'authorized', 'executing')) then
    raise exception 'rollback precondition: T3 / T4 intents are still pending; drain them first';
  end if;
  if exists (select 1 from action_gateway.seller_action_receipts where state in ('requested', 'executing', 'enqueued')) then
    raise exception 'rollback precondition: seller-action receipts are still open; finish them first';
  end if;
  if exists (select 1 from public.negotiation_send_authorization_uses) then
    raise exception 'rollback precondition: durable send-budget uses exist (evidence of priced sends); export them first';
  end if;
end $$;

drop policy if exists lc_action_gateway_select_t34 on public.system_control;
drop trigger seller_offers_ceiling_guard on public.seller_offers;
drop function public.seller_offers_ceiling_guard();

-- #26's authorization guard, verbatim
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
  v_digest text := nullif(current_setting('action_gateway.presented_digest', true), '');
begin
  if tg_op <> 'INSERT' then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_APPEND_ONLY: authorizations are immutable'; end if;
  if new.envelope_ref is not null then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_ENVELOPE_AUTHORIZATION_NOT_IMPLEMENTED: T3 / T4 envelope authorization is not available in phase 1';
  end if;
  select * into i from action_gateway.action_intents where intent_id = new.intent_id for update;
  if i.intent_id is null or i.org_id <> new.org_id or i.agent_id <> new.agent_id or i.capability <> new.capability or i.tier <> new.tier then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_AUTHZ_MISMATCH: the authorization does not match its intent';
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
  v_code := action_gateway.grant_refusal(g, i, new.approval_id is not null);
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


drop function action_gateway.self_check(name);
alter function action_gateway.self_check_pre_t34(name) rename to self_check;
drop function action_gateway.t34_self_check_allow();

drop function public.action_gateway_dw_handoff(uuid, uuid);
drop function public.action_gateway_dw_offer_envelope(uuid, uuid);
drop function public.action_gateway_offer_authority(text);
drop function public.action_gateway_negotiation_state(uuid, text);
drop function public.action_gateway_receipt_get(uuid);
drop function public.action_gateway_authorize_envelope(uuid, text, jsonb);
drop function action_gateway.envelope_ref_refusal(uuid, text);
drop function public.lc_seller_action_open_receipts(integer);
drop function public.lc_seller_action_load(uuid);
drop function public.lc_seller_action_receipt_record(uuid, text, text, text, jsonb, text);
drop table action_gateway.seller_action_receipts;
drop function action_gateway.receipt_guard();
drop function action_gateway.receipt_transition_ok(text, text);
drop function public.negotiation_send_authorization_consume(uuid, text, numeric);
drop table public.negotiation_send_authorization_uses;
drop function action_gateway.t34_capability_refusal(text);
drop function action_gateway.t34_hold_capabilities(text);
drop function action_gateway.envelope_actions();
drop function action_gateway.t34_handoff_kind(text);
drop function action_gateway.thread_ref_of(text);
drop function action_gateway.scope_key_of(text, text);
drop function action_gateway.decode_property_ref(text);

do $$
begin
  if not coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false) then
    raise exception 'rollback postcondition: #26 self-check is not ok: %', action_gateway.self_check('lc_action_gateway') -> 'findings';
  end if;
end $$;

notify pgrst, 'reload schema';
