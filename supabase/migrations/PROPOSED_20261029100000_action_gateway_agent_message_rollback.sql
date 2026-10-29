-- =============================================================================
-- ROLLBACK of PROPOSED_20261029100000_action_gateway_agent_message.sql
-- STATUS: PROPOSED. Run only with the owner's approval, like the apply.
-- REFUSES (nothing is dropped) while:
--   * a live grant carries standing_seller_facing for conversation.queue_agent_message (an owner revokes it first);
--   * an agent-message / lead-assignment intent is pending, or an agent-message receipt is open;
--   * any agent-message receipt exists at all (the widened CHECK cannot be narrowed under them: export them first).
-- Then: #31's standing CHECKs and bodies (standing_reply_refusal, grant_refusal, dw_handoff), #28's helpers and receipt
-- writer, #28's receipts action CHECK (verbatim from action_gateway.agent_message_restore), and drops what the apply
-- created (lead assignments, the event outbox WITH its rows, the reads, the reservation functions, the registry rows).
-- The idempotency_ledger reservation rows (scopes agent_message_*) stay: they expire with the ledger's retention.
-- =============================================================================
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
declare c_name text; c_def text;
begin
  if to_regclass('action_gateway.agent_message_restore') is null then raise exception 'rollback precondition: the agent-message link is not applied'; end if;
  if exists (select 1 from action_gateway.capability_grants where standing_seller_facing and capability = 'conversation.queue_agent_message' and revoked_at is null) then
    raise exception 'refused: a live grant carries standing_seller_facing for conversation.queue_agent_message; revoke it first';
  end if;
  if exists (select 1 from action_gateway.action_intents where action in ('queue_agent_message', 'assign_lead', 'release_lead') and state in ('received', 'awaiting_approval', 'authorized', 'executing')) then
    raise exception 'rollback precondition: agent-message intents are still pending; drain them first';
  end if;
  if exists (select 1 from action_gateway.seller_action_receipts where action = 'queue_agent_message') then
    raise exception 'rollback precondition: agent-message receipts exist (evidence); export and delete them first';
  end if;
  select value into c_name from action_gateway.agent_message_restore where key = 'receipts_action_check_name';
  select value into c_def from action_gateway.agent_message_restore where key = 'receipts_action_check_def';
  if c_name is null or c_def is null then raise exception 'rollback precondition: the restore rows are missing'; end if;
  execute format('alter table action_gateway.seller_action_receipts drop constraint %I', c_name);
  execute format('alter table action_gateway.seller_action_receipts add constraint %I %s', c_name, c_def);
end $$;

-- #31's standing CHECKs (the agent-message standing authorizations that exist stay as history: NOT VALID then)
alter table action_gateway.capability_grants
  drop constraint capability_grants_agent_message_lead_day_cap_chk,
  drop constraint capability_grants_standing_seller_facing_chk,
  add constraint capability_grants_standing_seller_facing_chk check (
    (not standing_seller_facing and standing_basis is null)
    or (standing_seller_facing and capability = 'conversation.queue_reply' and max_tier = 3
        and standing_basis is not null and standing_basis ~ '^[A-Za-z0-9 _.:/#()-]{12,200}$')) not valid;
alter table action_gateway.capability_grants drop column agent_message_lead_day_cap;
alter table action_gateway.action_authorizations
  drop constraint action_authorizations_standing_chk,
  add constraint action_authorizations_standing_chk check (
    not standing or (tier = 3 and capability = 'conversation.queue_reply' and approval_id is null and envelope_ref is null and not approval_required)) not valid;
do $$
begin
  if not exists (select 1 from action_gateway.capability_grants where standing_seller_facing and capability <> 'conversation.queue_reply') then
    alter table action_gateway.capability_grants validate constraint capability_grants_standing_seller_facing_chk;
  end if;
  if not exists (select 1 from action_gateway.action_authorizations where standing and capability <> 'conversation.queue_reply') then
    alter table action_gateway.action_authorizations validate constraint action_authorizations_standing_chk;
  end if;
end $$;

-- #31's bodies
create or replace function action_gateway.standing_reply_refusal(p_grant_id uuid, p_intent_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare g action_gateway.capability_grants%rowtype; i action_gateway.action_intents%rowtype;
begin
  select * into i from action_gateway.action_intents where intent_id = p_intent_id;
  if i.intent_id is null or i.action <> 'queue_authorized_reply' or i.tier <> 3 or i.capability <> 'conversation.queue_reply' then return 'STANDING_NOT_FOR_ACTION'; end if;
  select * into g from action_gateway.capability_grants where grant_id = p_grant_id;
  if g.grant_id is null or not g.standing_seller_facing or g.capability <> 'conversation.queue_reply' or g.max_tier <> 3
     or g.org_id <> i.org_id or g.agent_id <> i.agent_id then return 'STANDING_GRANT_INVALID'; end if;
  if g.revoked_at is not null or g.suspended_at is not null or g.valid_from > now() or g.expires_at <= now() then return 'STANDING_GRANT_INACTIVE'; end if;
  return null;
end
$fn$;

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
  -- Agntei 5.4: …except the ONE certified seller reply under an owner-minted STANDING seller-facing grant (the
  -- reply path's own gates — the AI send kill switch and policy, R3, the validator, every dispatch guard — still apply)
  if i.tier >= 3 and not p_has_approval
     and not (i.tier = 3 and i.action = 'queue_authorized_reply' and g.standing_seller_facing and g.capability = 'conversation.queue_reply') then
    return 'TIER_REQUIRES_APPROVAL';
  end if;
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
    -- Agntei 5.4: …or, for the certified seller reply only, a STANDING authorization whose flagged grant is still live
    -- (re-verified NOW: a grant revoked, suspended or expired since the authorization refuses here)
    elsif v_auth.approval_id is null
          and not (v_auth.standing and action_gateway.standing_reply_refusal(v_auth.grant_id, i.intent_id) is null) then
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

-- #28's helpers and receipt writer
create or replace function action_gateway.t34_handoff_kind(p_action text)
returns text language sql immutable parallel safe set search_path = pg_catalog
-- ONE LeadCommand-side executor kind for every handed-off gateway action (shared with the T2 executor pattern;
-- the worker dispatches by the intent's action): never a second kind per tool
as $fn$ select case when p_action in ('queue_authorized_reply', 'execute_authorized_offer', 'record_seller_counteroffer') then 'action_gateway.execute' else null end $fn$;

create or replace function action_gateway.t34_hold_capabilities(p_action text)
returns text[] language sql immutable parallel safe set search_path = pg_catalog
as $fn$ select case p_action
  when 'queue_authorized_reply' then array['ai_action','auto_reply','outbound_send']
  when 'execute_authorized_offer' then array['ai_action','auto_reply','offer_write','outbound_send']
  when 'record_seller_counteroffer' then array['offer_write']
  else array['ai_action','auto_reply','offer_write','outbound_send','offer_acceptance','stage_advance'] end::text[] $fn$;

create or replace function action_gateway.t34_capability_refusal(p_action text)
returns text
language plpgsql
stable
set search_path = pg_catalog
as $fn$
declare v_stop text; v_switch text; v_policy text; v_enabled boolean;
begin
  if p_action = 'record_seller_counteroffer' then return null; end if;
  select lower(btrim(coalesce(value, ''))) into v_stop from public.system_control where key = 'queue_emergency_stop_at';
  if coalesce(v_stop, '') not in ('', '0', 'false', 'off', 'none', 'null', 'cleared', 'clear') then return 'EMERGENCY_STOP_ACTIVE'; end if;
  if p_action = 'queue_authorized_reply' then
    select lower(btrim(coalesce(value, ''))) into v_switch from public.system_control where key = 'ai_conversation_send_enabled';
    if coalesce(v_switch, '') <> 'true' then return 'CAPABILITY_UNAVAILABLE'; end if;
    select value into v_policy from public.system_control where key = 'ai_conversation_send_policy';
    begin
      v_enabled := coalesce((v_policy::jsonb ->> 'enabled')::boolean, false);
    exception when others then v_enabled := false;
    end;
    if not v_enabled then return 'CAPABILITY_UNAVAILABLE'; end if;
    return null;
  end if;
  if p_action = 'execute_authorized_offer' then
    select lower(btrim(coalesce(value, ''))) into v_switch from public.system_control where key = 'negotiation_send_enabled';
    if coalesce(v_switch, '') <> 'true' then return 'CAPABILITY_UNAVAILABLE'; end if;
    return null;
  end if;
  return 'CAPABILITY_UNAVAILABLE';
end
$fn$;

create or replace function public.lc_seller_action_receipt_record(p_intent_id uuid, p_job_id text, p_state text, p_code text, p_detail jsonb default '{}'::jsonb, p_queue_row_id text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare
  r action_gateway.seller_action_receipts%rowtype;
  i action_gateway.action_intents%rowtype;
  v_item uuid;
  v_sev text;
begin
  select * into r from action_gateway.seller_action_receipts where intent_id = p_intent_id for update;
  if r.intent_id is null then return jsonb_build_object('ok', false, 'reason', 'receipt_not_found'); end if;
  if p_job_id is distinct from r.job_id then return jsonb_build_object('ok', false, 'reason', 'job_mismatch'); end if;
  if r.state = p_state and r.state <> 'executing' then return jsonb_build_object('ok', true, 'replayed', true, 'state', r.state, 'work_item_id', r.work_item_id); end if;
  if not action_gateway.receipt_transition_ok(r.state, p_state) then return jsonb_build_object('ok', false, 'reason', 'illegal_transition', 'state', r.state); end if;
  v_item := r.work_item_id;
  if p_state in ('held', 'failed', 'outcome_unknown', 'refused') then
    select * into i from action_gateway.action_intents where intent_id = r.intent_id;
    v_sev := case when p_state = 'outcome_unknown' then 'critical' when p_state = 'refused' then 'info' else 'warning' end;
    insert into agent.ops_work_item (org_id, scope, kind, dedupe_key, severity, escalated, title, subject_type, subject_id, detail, priority, source_job_id)
    values (r.org_id, 'agent', 'escalation', 'agent:seller_action:' || r.intent_id::text, v_sev, p_state <> 'refused',
            case r.action when 'queue_authorized_reply' then 'Agent-requested seller reply was not sent: an operator decides'
                          when 'execute_authorized_offer' then 'Agent-requested offer was not sent: an operator decides'
                          else 'Agent-recorded seller counter needs an operator' end,
            case when i.resource_type = 'thread' then 'conversation' else 'system' end,
            case when i.resource_type = 'thread' then i.resource_id else 'action_gateway' end,
            jsonb_build_object('source', 'action_gateway', 'intent_id', r.intent_id, 'agent_id', i.agent_id, 'action', r.action, 'receipt_state', p_state, 'code', nullif(left(coalesce(p_code, ''), 80), ''),
                               'queue_row_id', coalesce(nullif(p_queue_row_id, ''), r.queue_row_id), 'release', 'nothing is retried automatically; an operator decides'),
            case when p_state = 'outcome_unknown' then 900 when p_state = 'refused' then 100 else 600 end, 'action_intent:' || r.intent_id::text)
    on conflict (org_id, dedupe_key) do update set last_seen_at = clock_timestamp(), seen_count = agent.ops_work_item.seen_count + 1,
      severity = excluded.severity, escalated = agent.ops_work_item.escalated or excluded.escalated, detail = excluded.detail, updated_at = clock_timestamp()
    returning work_item_id into v_item;
  end if;
  update action_gateway.seller_action_receipts
     set state = p_state, code = nullif(left(coalesce(p_code, ''), 80), ''), detail = coalesce(p_detail, '{}'::jsonb),
         queue_row_id = coalesce(nullif(p_queue_row_id, ''), queue_row_id), work_item_id = v_item, attempts = attempts + case when p_state = 'executing' then 1 else 0 end
   where intent_id = r.intent_id returning * into r;
  perform action_gateway.audit(r.org_id, 'receipt_' || p_state, null, r.intent_id, r.action, null, null, r.code, null,
                               jsonb_build_object('job_id', r.job_id, 'state', p_state));
  return jsonb_build_object('ok', true, 'replayed', false, 'state', r.state, 'work_item_id', r.work_item_id);
end
$fn$;
revoke all on function public.lc_seller_action_receipt_record(uuid, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.lc_seller_action_receipt_record(uuid, text, text, text, jsonb, text) to service_role;

delete from action_gateway.extensions where link = 'PROPOSED_20261029100000_action_gateway_agent_message';

drop function public.action_gateway_agent_lead_pool(text, integer, text);
drop function public.lc_agent_message_lead(uuid);
drop function public.lc_agent_message_activation();
drop function public.action_gateway_message_templates();
drop function public.action_gateway_agent_message_state(uuid, uuid, uuid);
drop function public.lc_agent_message_settle(uuid, text);
drop function public.lc_agent_message_reserve(uuid);
drop function public.action_gateway_events_since(bigint, integer);
drop function public.lc_lead_event_append(text, text, text, uuid, jsonb, timestamp with time zone);
drop function action_gateway.lead_event_ids(jsonb, uuid, text, text, uuid);
drop function action_gateway.campaign_target_of(text, text);
drop function action_gateway.property_ref_of(text);
drop table action_gateway.lead_events;
drop function action_gateway.lead_events_append_only();
drop function public.action_gateway_lead_assignment_get(uuid, uuid);
drop function public.action_gateway_dw_lead_assignment(uuid, uuid);
drop function action_gateway.lead_owner(uuid, text);
drop table action_gateway.lead_assignments;
drop function action_gateway.agent_message_usage(text);
drop function action_gateway.agent_message_lead(jsonb);
drop function action_gateway.agent_message_refusal();
drop function action_gateway.agent_message_policy();
drop table action_gateway.agent_message_restore;

do $$
begin
  if not coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false) then
    raise exception 'rollback postcondition: the self-check is not ok: %', action_gateway.self_check('lc_action_gateway') -> 'findings';
  end if;
end $$;

notify pgrst, 'reload schema';
