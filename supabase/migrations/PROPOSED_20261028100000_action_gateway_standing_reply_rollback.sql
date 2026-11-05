-- =============================================================================
-- PROPOSED_20261028100000_action_gateway_standing_reply_rollback.sql — undo the standing seller-reply link
-- Refuses while any grant carries standing_seller_facing (an owner revokes those grants first); restores the
-- #26 bodies of action_gateway.grant_refusal and public.action_gateway_principal and #28's of
-- public.action_gateway_dw_handoff and public.lc_seller_action_load; drops the standing authority (trigger, function,
-- the authorization flag unless standing authorizations exist as history) and the two grant columns.
-- =============================================================================
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
begin
  if not exists (select 1 from pg_attribute where attrelid = 'action_gateway.capability_grants'::regclass and attname = 'standing_seller_facing' and not attisdropped) then raise exception 'precondition: the standing seller-reply link is not applied'; end if;
  if exists (select 1 from action_gateway.capability_grants where standing_seller_facing and revoked_at is null) then raise exception 'refused: a live grant carries standing_seller_facing; revoke it first'; end if;
end $$;

create or replace function action_gateway.grant_refusal(g action_gateway.capability_grants, i action_gateway.action_intents, p_has_approval boolean)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare v_spend numeric := coalesce(case when jsonb_typeof(i.params -> 'budget_usd') = 'number' then (i.params ->> 'budget_usd')::numeric end, 0);
begin
  if g.grant_id is null or g.org_id <> i.org_id or g.agent_id <> i.agent_id or g.capability <> i.capability or g.max_tier < i.tier then return 'GRANT_INVALID'; end if;
  if g.revoked_at is not null then return 'GRANT_REVOKED'; end if;
  if g.suspended_at is not null then return 'GRANT_SUSPENDED'; end if;
  if g.valid_from > now() then return 'GRANT_NOT_YET_VALID'; end if;
  if g.expires_at <= now() then return 'GRANT_EXPIRED'; end if;
  -- a standing grant alone never authorizes seller-facing / financial actions, nor an irreversible T2 action
  if i.tier >= 3 and not p_has_approval then return 'TIER_REQUIRES_APPROVAL'; end if;
  if i.tier = 2 and not p_has_approval and not (i.action = any (action_gateway.standing_t2_actions())) then return 'T2_ACTION_NOT_REVERSIBLE'; end if;
  if action_gateway.grant_scope_refusal(g.scope, i.resource_type, i.resource_id) is not null then return 'RESOURCE_OUT_OF_GRANT_SCOPE'; end if;
  if not p_has_approval and action_gateway.grant_envelope_refusal(g.envelope, i.params) is not null then return 'ARGUMENT_OUTSIDE_ENVELOPE'; end if;
  if (select count(*) from action_gateway.action_authorizations a where a.grant_id = g.grant_id and a.decided_at > clock_timestamp() - interval '1 hour') >= g.max_uses_per_hour then return 'GRANT_EXHAUSTED_HOURLY'; end if;
  if (select count(*) from action_gateway.action_authorizations a where a.grant_id = g.grant_id and a.decided_at > clock_timestamp() - interval '1 day') >= g.max_uses_per_day then return 'GRANT_EXHAUSTED_DAILY'; end if;
  if v_spend > 0 and coalesce((select sum(a.spend_usd) from action_gateway.action_authorizations a where a.grant_id = g.grant_id and a.decided_at > clock_timestamp() - interval '1 day'), 0) + v_spend > g.max_spend_usd_per_day then
    return 'GRANT_SPEND_CAP';
  end if;
  return null;
end
$fn$;

create or replace function public.action_gateway_principal(p_credential_digest text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select jsonb_build_object(
    'agent_id', p.agent_id, 'org_id', p.org_id, 'display_name', p.display_name, 'sponsor_user_id', p.sponsor_user_id,
    'tier_ceiling', p.tier_ceiling, 'read_scopes', to_jsonb(p.read_scopes), 'status', p.status, 'credential_expires_at', p.credential_expires_at,
    'sponsor_is_member', exists (select 1 from agent.operator_membership m where m.org_id = p.org_id and m.user_id = p.sponsor_user_id),
    'grants', coalesce((select jsonb_agg(jsonb_build_object('grant_id', g.grant_id, 'capability', g.capability, 'grant_version', g.grant_version, 'max_tier', g.max_tier,
                                                           'scope', g.scope, 'envelope', g.envelope, 'max_uses_per_hour', g.max_uses_per_hour, 'max_uses_per_day', g.max_uses_per_day,
                                                           'max_spend_usd_per_day', g.max_spend_usd_per_day, 'valid_from', g.valid_from, 'expires_at', g.expires_at,
                                                           'suspended_reason', g.suspended_reason) order by g.capability, g.grant_version)
                          from action_gateway.capability_grants g where g.agent_id = p.agent_id and g.org_id = p.org_id and g.revoked_at is null and g.expires_at > now()), '[]'::jsonb))
    from action_gateway.agent_principals p
   where p_credential_digest ~ '^[0-9a-f]{64}$' and p.credential_digest = p_credential_digest and p.org_id = action_gateway.request_org()
$fn$;

-- #28's bodies of the handoff and the worker's load (no standing authority anywhere after this)
create or replace function public.action_gateway_dw_handoff(p_intent_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare
  b jsonb; i action_gateway.action_intents%rowtype; v_thread uuid; v_tk text; v_pid text; v_kind text; v_code text;
  v_use jsonb := null; v_sa uuid := null; v_amount numeric; r jsonb; v_sponsor text; v_auth action_gateway.action_authorizations%rowtype;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['queue_authorized_reply', 'execute_authorized_offer', 'record_seller_counteroffer']);
  if b ? 'refused' then return b -> 'outcome'; end if;
  i := jsonb_populate_record(null::action_gateway.action_intents, b -> 'intent');
  v_sponsor := b ->> 'sponsor_user_id';
  begin
    v_kind := action_gateway.t34_handoff_kind(i.action);
    select * into v_auth from action_gateway.action_authorizations where intent_id = i.intent_id;
    -- per-use authority: T3 / counters = a human approval; offers = the verified envelope ref (re-verified NOW)
    if i.action = 'execute_authorized_offer' then
      if v_auth.envelope_ref is null then return action_gateway.finish_intent(i.intent_id, 'refused', 'ENVELOPE_REQUIRED', '{}'::jsonb); end if;
      v_code := action_gateway.envelope_ref_refusal(i.intent_id, v_auth.envelope_ref);
      if v_code is not null then return action_gateway.finish_intent(i.intent_id, 'refused', v_code, jsonb_build_object('stage', 'execution')); end if;
    elsif v_auth.approval_id is null then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'APPROVAL_REQUIRED', '{}'::jsonb);
    end if;
    v_code := action_gateway.t34_capability_refusal(i.action);
    if v_code is not null then return action_gateway.finish_intent(i.intent_id, 'refused', v_code, jsonb_build_object('stage', 'execution')); end if;
    v_thread := (i.params ->> 'thread_id')::uuid;
    select t.thread_key, t.property_id into v_tk, v_pid from public.inbox_thread_state t where t.id = v_thread for share;
    if v_tk is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'THREAD_NOT_FOUND', '{}'::jsonb); end if;
    v_pid := coalesce(action_gateway.decode_property_ref(i.params ->> 'property_ref'), v_pid);
    -- THE hold registry: any active hold on the thread / property for a capability this action exercises
    if exists (select 1 from public.automation_hold_for(v_tk, v_thread, v_pid, null, null, null) h
                where coalesce(cardinality(h.blocked_capabilities), 0) = 0 or h.blocked_capabilities && action_gateway.t34_hold_capabilities(i.action)) then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'AUTOMATION_HOLD', jsonb_build_object('stage', 'execution'));
    end if;
    -- the destination's suppression (any language: the suppression list is the outcome of every STOP classifier)
    if i.action <> 'record_seller_counteroffer' and exists (select 1 from public.sms_suppression_list s where s.phone_e164 = v_tk and s.is_active is distinct from false) then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'CONTACT_SUPPRESSED', jsonb_build_object('stage', 'execution'));
    end if;
    if i.action = 'execute_authorized_offer' then
      v_sa := (i.params ->> 'send_permit_id')::uuid;
      v_amount := (i.params ->> 'amount')::numeric;
      v_use := public.negotiation_send_authorization_consume(v_sa, 'gw:' || i.intent_id::text, v_amount);
      if not coalesce((v_use ->> 'ok')::boolean, false) then
        return action_gateway.finish_intent(i.intent_id, 'refused', upper(regexp_replace(coalesce(v_use ->> 'reason', 'send_budget_refused'), '[^A-Za-z0-9_]', '_', 'g')), jsonb_build_object('stage', 'send_budget'));
      end if;
    end if;
    r := agent.runtime_enqueue(v_kind, encode(sha256(convert_to('action_gateway:' || i.intent_id::text, 'UTF8')), 'hex'),
                               jsonb_build_object('action_intent_id', i.intent_id, 'requested_via', 'action_gateway'), v_sponsor, 40, 3, 0, false, null);
    -- a refused enqueue RAISES: the block's savepoint rolls the budget use back with it (never consumed for nothing)
    if coalesce((r ->> 'ok')::boolean, false) is not true then
      raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_HANDOFF_ENQUEUE_REFUSED: ' || coalesce(r ->> 'reason', 'unknown');
    end if;
    insert into action_gateway.seller_action_receipts (intent_id, org_id, action, runtime_kind, job_id, state, send_authorization_id, use_no)
    values (i.intent_id, i.org_id, i.action, v_kind, r ->> 'job_id', 'requested', v_sa, (v_use ->> 'use_no')::int)
    on conflict (intent_id) do nothing;
    return action_gateway.finish_intent(i.intent_id, 'succeeded', 'HANDOFF_QUEUED',
                                        jsonb_build_object('job_id', r ->> 'job_id', 'runtime_kind', v_kind, 'deduped', coalesce((r ->> 'deduped')::boolean, false),
                                                           'use_no', (v_use ->> 'use_no')::int, 'receipt', 'requested'));
  exception when others then
    return action_gateway.finish_intent(i.intent_id, 'failed', case when sqlerrm like 'ACTION_GATEWAY_HANDOFF_ENQUEUE_REFUSED%' then 'ENQUEUE_REFUSED' else 'DOMAIN_WRITE_FAILED' end,
                                        jsonb_build_object('sqlstate', sqlstate));
  end;
end
$fn$;

create or replace function public.lc_seller_action_load(p_intent_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select jsonb_build_object(
    'intent', action_gateway.intent_json(i) || jsonb_build_object('org_id', i.org_id),
    'authorization', (select jsonb_build_object('authorization_id', a.authorization_id, 'approval_id', a.approval_id, 'approved_by', a.approved_by, 'envelope_ref', a.envelope_ref,
                                                'sponsor_user_id', a.sponsor_user_id, 'tier', a.tier, 'decided_at', a.decided_at)
                        from action_gateway.action_authorizations a where a.intent_id = i.intent_id),
    'outcome', (select jsonb_build_object('status', o.status, 'code', o.code, 'result', o.result) from action_gateway.action_outcomes o where o.intent_id = i.intent_id),
    'receipt', (select to_jsonb(r) from action_gateway.seller_action_receipts r where r.intent_id = i.intent_id))
    from action_gateway.action_intents i where i.intent_id = p_intent_id
$fn$;

-- the authorization's standing flag: no new standing authorization is possible from here on; #26's per-use
-- authority check returns (NOT VALID when standing authorizations exist: they stay as history, the check binds every
-- new row; otherwise validated and the column dropped)
drop trigger ab_standing_authority on action_gateway.action_authorizations;
drop function action_gateway.standing_authority();
alter table action_gateway.action_authorizations
  drop constraint action_authorizations_per_use_authority_chk,
  add constraint action_authorizations_check1 check (tier <= 2 or approval_id is not null or envelope_ref is not null) not valid;
do $$
begin
  if not exists (select 1 from action_gateway.action_authorizations where standing) then
    alter table action_gateway.action_authorizations validate constraint action_authorizations_check1;
    alter table action_gateway.action_authorizations drop constraint action_authorizations_standing_chk, drop column standing;
  end if;
end $$;
drop function action_gateway.standing_reply_refusal(uuid, uuid);

alter table action_gateway.capability_grants drop constraint capability_grants_standing_seller_facing_chk;
alter table action_gateway.capability_grants drop column standing_basis, drop column standing_seller_facing;
