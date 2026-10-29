-- =============================================================================
-- PROPOSED_20261029100000_action_gateway_agent_message.sql — AGENT-INITIATED conversation messages, link #32
-- STATUS: PROPOSED. Nothing is applied or activated by this file existing. Born OFF: queue_agent_message answers
-- capability_unavailable until (a) the AI-reply certification gate is on (system_control ai_conversation_send_enabled
-- = 'true' + an enabled ai_conversation_send_policy listing the purpose as a category and the recipient in its scope —
-- the switch the owner turns on only after the blind evaluation) AND (b) this action's own switch
-- ai_agent_message_enabled = 'true' + an enabled ai_agent_message_policy; and no grant carries the standing flag for
-- it until an owner mints one. Tested on disposable PostgreSQL 17 only
-- (tests/critical/action-gateway-agent-message-pg.test.mjs; scripts/db/run-migration-test.mjs --id action_gateway_agent_message).
-- Applies after #26 → #27 → #28 → (#29) → #31 and PROPOSED_20261029090000_ai_generated_outbound (the ledger kind).
-- =============================================================================
-- Owner request: agents send messages on their own initiative — a first touch to a lead with no conversation (a
-- campaign target), a re-engagement of a quiet thread, a follow-up — composed by LeadCommand's canonical AI writer
-- (the agent supplies a brief, never the words), with a governed template only as the explicit fallback.
--   1. queue_agent_message (capability conversation.queue_agent_message, T3) joins every list of handed-off T3
--      seller actions: the receipts action CHECK (widened; restored verbatim by the rollback from
--      action_gateway.agent_message_restore), t34_handoff_kind (the ONE executor kind), t34_hold_capabilities
--      (ai_action, auto_reply, campaign, follow_up, outbound_send), t34_capability_refusal (the activation below),
--      dw_handoff's action array and the extension registry.
--   2. The activation, action_gateway.agent_message_refusal(): both emergency stops (R2 agent.runtime_limits and
--      queue_emergency_stop_at), the AI-reply certification gate (kill switch + enabled policy), this action's switch
--      and policy (ai_agent_message_policy: max_per_day_global default 200, max_per_lead_per_day default 1,
--      reengage_min_quiet_hours default 72, fallback_templates per purpose). One normalizer, born OFF.
--   3. Standing authority (#31 widened, never loosened): exactly two (action, capability) pairs may carry
--      standing_seller_facing — the certified reply and the agent message — at tier 3 with a recorded basis; the
--      authorization's `standing` stays DERIVED by #31's trigger and is re-verified at the handoff and in the worker.
--      Optional per-grant agent_message_lead_day_cap (1..3) overrides the policy's per-lead daily cap for that grant.
--   4. Lead ownership: action_gateway.lead_assignments (one live owner principal per lead, leased). assign_lead /
--      release_lead are standing T2 actions (reversible, internal) of one domain write; the handoff of an agent
--      message refuses NOT_LEAD_OWNER unless the sending agent holds the live assignment, and serializes per lead
--      (advisory lock; a second open agent message to the same seller is refused LEAD_SEND_IN_FLIGHT).
--   5. Daily caps as RESERVATIONS in public.idempotency_ledger (scopes agent_message_lead_day and
--      agent_message_global_day, distinct from the reply's), taken by LeadCommand's worker before the queue row.
--   6. A durable, cursor-ordered event outbox for agents (action_gateway.lead_events: inbound_message,
--      lead_state_changed, delivery_changed, opt_out; idempotent event ids, never a phone or message text), written by
--      LeadCommand (lc_lead_event_append; the receipt writer appends delivery changes itself) and read by the gateway
--      (action_gateway_events_since, settled rows only).
-- Every existing gate stays: holds, suppression / STOP, wrong number / not owner, the opener rule, the recipient
-- window, the pre-send eligibility engine, the validators, the grant caps, both emergency stops, idempotency.
-- Rollback: PROPOSED_20261029100000_action_gateway_agent_message_rollback.sql (refuses while a live standing
-- agent-message grant, an open agent-message intent / receipt, or any agent-message receipt exists).

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ───────────────────────────────────────────── 0. preconditions ──
do $$
declare t text; missing text[] := '{}';
begin
  if to_regprocedure('action_gateway.dw_begin(uuid,uuid,text[])') is null then raise exception 'precondition: link #26 (action_gateway) is not applied'; end if;
  if to_regclass('action_gateway.extensions') is null then raise exception 'precondition: link #27 (the extension registry) is not applied'; end if;
  if to_regclass('action_gateway.seller_action_receipts') is null or to_regprocedure('action_gateway.t34_handoff_kind(text)') is null then raise exception 'precondition: link #28 (T3 / T4) is not applied'; end if;
  if to_regprocedure('action_gateway.standing_reply_refusal(uuid,uuid)') is null
     or not exists (select 1 from pg_attribute where attrelid = 'action_gateway.capability_grants'::regclass and attname = 'standing_seller_facing' and not attisdropped) then
    raise exception 'precondition: link #31 (standing seller-facing reply) is not applied';
  end if;
  if not exists (select 1 from pg_attribute where attrelid = 'public.ai_generated_messages'::regclass and attname = 'record_kind' and not attisdropped) then
    raise exception 'precondition: PROPOSED_20261029090000_ai_generated_outbound (the ledger''s agent_outbound kind) is not applied';
  end if;
  if to_regclass('action_gateway.agent_message_restore') is not null or exists (select 1 from action_gateway.extensions where link = 'PROPOSED_20261029100000_action_gateway_agent_message') then
    raise exception 'precondition: this link is already applied';
  end if;
  foreach t in array array['public.idempotency_ledger', 'public.campaign_targets', 'public.sms_templates', 'public.ownership_template_rotation_control',
      'public.inbox_thread_state', 'public.sms_suppression_list', 'public.system_control', 'agent.runtime_limits', 'agent.ops_work_item'] loop
    if to_regclass(t) is null then missing := missing || t; end if;
  end loop;
  if array_length(missing, 1) > 0 then raise exception 'precondition: missing relation(s): %', array_to_string(missing, ', '); end if;
  if (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'action_gateway.capability_grants'::regclass and c.conname = 'capability_grants_standing_seller_facing_chk') !~ 'conversation.queue_reply' then
    raise exception 'precondition: capability_grants_standing_seller_facing_chk is not #31''s';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'action_gateway.seller_action_receipts'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''queue_authorized_reply''%') then
    raise exception 'precondition: the receipts action CHECK is not where link #28 put it';
  end if;
end $$;

-- ───────────────────────────────────────────── 1. the receipts' action set (widened; restored by the rollback) ──
create table action_gateway.agent_message_restore (key text primary key, value text not null);
alter table action_gateway.agent_message_restore enable row level security;
revoke all on action_gateway.agent_message_restore from public, anon, authenticated, service_role;
do $$
declare c record; v_list text;
begin
  select conname, pg_get_constraintdef(oid) as def into c from pg_constraint
   where conrelid = 'action_gateway.seller_action_receipts'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''queue_authorized_reply''%' limit 1;
  insert into action_gateway.agent_message_restore (key, value) values ('receipts_action_check_name', c.conname), ('receipts_action_check_def', c.def);
  -- the actions the CHECK lists today (#28's three, #29's two when that link is applied) plus this one
  select string_agg(quote_literal(a), ', ' order by a) into v_list
    from (select distinct (regexp_matches(c.def, '''([a-z_]+)''', 'g'))[1] a union select 'queue_agent_message') s;
  execute format('alter table action_gateway.seller_action_receipts drop constraint %I', c.conname);
  execute format('alter table action_gateway.seller_action_receipts add constraint %I check (action in (%s))', c.conname, v_list);
end $$;

-- ───────────────────────────────────────────── 2. the activation (born OFF) ──
-- THE normalizer of system_control ai_agent_message_policy (absent / malformed ⇒ disabled). Bounds: global 0..5000 per
-- UTC day (default 200), per lead 0..5 per UTC day (default 1), quiet 1..2160 h (default 72), at most 50 fallback
-- template ids per purpose.
create function action_gateway.agent_message_policy()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare v text; j jsonb; a jsonb; p text; ids jsonb; out_t jsonb := '{}'::jsonb;
begin
  select value into v from public.system_control where key = 'ai_agent_message_policy';
  begin
    j := v::jsonb;
    if j is null or jsonb_typeof(j) <> 'object' then j := null; end if;
    a := case when j is not null and jsonb_typeof(j -> 'fallback_templates') = 'object' then j -> 'fallback_templates' else '{}'::jsonb end;
    foreach p in array array['first_touch', 'reengage', 'followup'] loop
      select coalesce(jsonb_agg(x order by x), '[]'::jsonb) into ids
        from (select distinct x from jsonb_array_elements_text(case when jsonb_typeof(a -> p) = 'array' then a -> p else '[]'::jsonb end) x
               where x ~ '^[A-Za-z0-9_.:-]{1,64}$' limit 50) s;
      out_t := out_t || jsonb_build_object(p, ids);
    end loop;
    return jsonb_build_object(
      'enabled', j is not null and coalesce(j ->> 'enabled', '') = 'true',
      'max_per_day_global', least(greatest(coalesce((j ->> 'max_per_day_global')::int, 200), 0), 5000),
      'max_per_lead_per_day', least(greatest(coalesce((j ->> 'max_per_lead_per_day')::int, 1), 0), 5),
      'reengage_min_quiet_hours', least(greatest(coalesce((j ->> 'reengage_min_quiet_hours')::int, 72), 1), 2160),
      'fallback_templates', out_t,
      'policy_version', left(coalesce(nullif(j ->> 'policy_version', ''), 'v1'), 40));
  exception when others then
    return jsonb_build_object('enabled', false, 'max_per_day_global', 0, 'max_per_lead_per_day', 0, 'reengage_min_quiet_hours', 72,
                              'fallback_templates', jsonb_build_object('first_touch', '[]'::jsonb, 'reengage', '[]'::jsonb, 'followup', '[]'::jsonb),
                              'policy_version', 'malformed');
  end;
end
$fn$;

-- null = an agent message may be requested / handed off / executed / dispatched NOW; else the code
create function action_gateway.agent_message_refusal()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare v_stop text; v_switch text; v_ai_policy text; v_ai_enabled boolean;
begin
  if exists (select 1 from agent.runtime_limits l where coalesce((to_jsonb(l) ->> 'emergency_stop')::boolean, false)) then return 'EMERGENCY_STOP_ACTIVE'; end if;
  select lower(btrim(coalesce(value, ''))) into v_stop from public.system_control where key = 'queue_emergency_stop_at';
  if coalesce(v_stop, '') not in ('', '0', 'false', 'off', 'none', 'null', 'cleared', 'clear') then return 'EMERGENCY_STOP_ACTIVE'; end if;
  -- the AI-reply certification gate (the owner turns it on only after the blind evaluation): AI-written words need it
  select lower(btrim(coalesce(value, ''))) into v_switch from public.system_control where key = 'ai_conversation_send_enabled';
  if coalesce(v_switch, '') <> 'true' then return 'AI_SEND_KILL_SWITCH_OFF'; end if;
  select value into v_ai_policy from public.system_control where key = 'ai_conversation_send_policy';
  begin v_ai_enabled := coalesce((v_ai_policy::jsonb ->> 'enabled')::boolean, false); exception when others then v_ai_enabled := false; end;
  if not v_ai_enabled then return 'AI_SEND_POLICY_DISABLED'; end if;
  -- this action's own switch and policy
  select lower(btrim(coalesce(value, ''))) into v_switch from public.system_control where key = 'ai_agent_message_enabled';
  if coalesce(v_switch, '') <> 'true' then return 'AGENT_MESSAGE_KILL_SWITCH_OFF'; end if;
  if not coalesce((action_gateway.agent_message_policy() ->> 'enabled')::boolean, false) then return 'AGENT_MESSAGE_POLICY_DISABLED'; end if;
  return null;
end
$fn$;

-- the recipient of a lead-addressed intent's params: the thread (thread_id) or the campaign target (campaign_target_id;
-- its number in E.164) plus the thread of that number when one exists; lead_ref = the sealed ref of the number.
create function action_gateway.agent_message_lead(p_params jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare t record; ct jsonb; v_phone text; v_digits text; v_thread uuid; v_tid uuid; v_tphone text;
begin
  if coalesce(p_params ->> 'thread_id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_tid := (p_params ->> 'thread_id')::uuid; end if;
  if coalesce(p_params ->> 'campaign_target_id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select to_jsonb(x) into ct from public.campaign_targets x where x.id::text = p_params ->> 'campaign_target_id';
    if ct is null then return null; end if;
    v_digits := regexp_replace(coalesce(ct ->> 'to_phone_number', ct ->> 'canonical_e164', ''), '\D', '', 'g');
    v_tphone := case when length(v_digits) = 10 then '+1' || v_digits when length(v_digits) = 11 and left(v_digits, 1) = '1' then '+' || v_digits else nullif(ct ->> 'to_phone_number', '') end;
  end if;
  if v_tid is not null then
    select s.id, s.thread_key, s.property_id, to_jsonb(s) ->> 'master_owner_id' as master_owner_id, to_jsonb(s) ->> 'prospect_id' as prospect_id into t
      from public.inbox_thread_state s where s.id = v_tid;
    if t.id is null then return null; end if;
    -- a target named with a thread must be the same person × number
    if ct is not null and v_tphone is distinct from t.thread_key then return jsonb_build_object('mismatch', true); end if;
    return jsonb_build_object('phone', t.thread_key, 'lead_ref', action_gateway.thread_ref_of(t.thread_key), 'thread_id', t.id, 'property_id', coalesce(t.property_id, ct ->> 'property_id'),
                              'master_owner_id', coalesce(t.master_owner_id, ct ->> 'master_owner_id'), 'prospect_id', coalesce(t.prospect_id, ct ->> 'prospect_id'),
                              'campaign_target_id', ct ->> 'id', 'campaign_id', ct ->> 'campaign_id');
  end if;
  if ct is null or v_tphone is null then return null; end if;
  v_phone := v_tphone;
  select s.id into v_thread from public.inbox_thread_state s where s.thread_key = v_phone order by s.id limit 1;
  return jsonb_build_object('phone', v_phone, 'lead_ref', action_gateway.thread_ref_of(v_phone), 'thread_id', v_thread, 'property_id', ct ->> 'property_id',
                            'master_owner_id', ct ->> 'master_owner_id', 'prospect_id', ct ->> 'prospect_id', 'campaign_target_id', ct ->> 'id', 'campaign_id', ct ->> 'campaign_id');
end
$fn$;

-- today's reservations (UTC day): the lead's and the global count
create function action_gateway.agent_message_usage(p_lead_ref text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select jsonb_build_object(
    'day', to_char((clock_timestamp() at time zone 'utc')::date, 'YYYY-MM-DD'),
    'lead_today', case when p_lead_ref is null then null else (select count(*) from public.idempotency_ledger l where l.scope = 'agent_message_lead_day' and l.status in ('processing', 'completed')
                         and l.key like p_lead_ref || ':' || to_char((clock_timestamp() at time zone 'utc')::date, 'YYYY-MM-DD') || ':%') end,
    'global_today', (select count(*) from public.idempotency_ledger l where l.scope = 'agent_message_global_day' and l.status in ('processing', 'completed')
                       and l.key like to_char((clock_timestamp() at time zone 'utc')::date, 'YYYY-MM-DD') || ':%'))
$fn$;

-- ───────────────────────────────────────────── 3. lead ownership ──
create table action_gateway.lead_assignments (
  assignment_id      uuid primary key default gen_random_uuid(),
  org_id             uuid not null references agent.org (org_id),
  lead_ref           text not null check (lead_ref ~ '^thr_[a-p]{12}$'),
  agent_id           text not null references action_gateway.agent_principals (agent_id),
  intent_id          uuid not null references action_gateway.action_intents (intent_id),
  thread_id          uuid,
  campaign_target_id uuid,
  assigned_at        timestamptz not null default clock_timestamp(),
  lease_until        timestamptz not null,
  released_at        timestamptz,
  release_reason     text check (release_reason is null or release_reason ~ '^[a-z_]{3,40}$'),
  check (lease_until > assigned_at and lease_until <= assigned_at + interval '8 days'),
  check ((released_at is null) = (release_reason is null))
);
create unique index lead_assignments_one_open on action_gateway.lead_assignments (org_id, lead_ref) where released_at is null;
comment on table action_gateway.lead_assignments is 'Action Gateway lead ownership (link #32): one live owner principal per lead (sealed recipient ref), leased. Written only by public.action_gateway_dw_lead_assignment under an authorized intent; an agent message from any other principal is refused NOT_LEAD_OWNER.';
alter table action_gateway.lead_assignments enable row level security;
revoke all on action_gateway.lead_assignments from public, anon, authenticated, service_role;

-- the live owner of a lead (released_at null, lease not expired), or null
create function action_gateway.lead_owner(p_org uuid, p_lead_ref text)
returns text language sql stable security definer set search_path = pg_catalog
as $fn$ select a.agent_id from action_gateway.lead_assignments a where a.org_id = p_org and a.lead_ref = p_lead_ref and a.released_at is null and a.lease_until > clock_timestamp() limit 1 $fn$;

create function public.action_gateway_dw_lead_assignment(p_intent_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare b jsonb; i action_gateway.action_intents%rowtype; v_auth action_gateway.action_authorizations%rowtype; v_lead jsonb; v_ref text; v_owner text; v_until timestamptz; v_hours int;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['assign_lead', 'release_lead']);
  if b ? 'refused' then return b -> 'outcome'; end if;
  i := jsonb_populate_record(null::action_gateway.action_intents, b -> 'intent');
  begin
    select * into v_auth from action_gateway.action_authorizations where intent_id = i.intent_id;
    if v_auth.authorization_id is null or (v_auth.grant_id is null and v_auth.approval_id is null) then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'STANDING_GRANT_OR_APPROVAL_REQUIRED', '{}'::jsonb);
    end if;
    v_lead := action_gateway.agent_message_lead(i.params);
    if v_lead is null or v_lead ? 'mismatch' or nullif(v_lead ->> 'lead_ref', '') is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'LEAD_NOT_FOUND', '{}'::jsonb); end if;
    v_ref := v_lead ->> 'lead_ref';
    perform pg_advisory_xact_lock(hashtext('lead_assignment:' || i.org_id::text || ':' || v_ref));
    v_owner := action_gateway.lead_owner(i.org_id, v_ref);
    if i.action = 'assign_lead' then
      if v_owner is not null and v_owner <> i.agent_id then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'LEAD_OWNED_BY_ANOTHER_AGENT', jsonb_build_object('lead_ref', v_ref, 'owner_agent_id', v_owner));
      end if;
      v_hours := least(greatest(coalesce((i.params ->> 'lease_hours')::int, 24), 1), 168);
      v_until := clock_timestamp() + make_interval(hours => v_hours);
      -- an expired lease (or this agent's own live one) is closed; then ONE open row for the new lease
      update action_gateway.lead_assignments set released_at = clock_timestamp(), release_reason = case when agent_id = i.agent_id and lease_until > clock_timestamp() then 'renewed' else 'lease_expired' end
       where org_id = i.org_id and lead_ref = v_ref and released_at is null;
      insert into action_gateway.lead_assignments (org_id, lead_ref, agent_id, intent_id, thread_id, campaign_target_id, lease_until)
      values (i.org_id, v_ref, i.agent_id, i.intent_id, nullif(v_lead ->> 'thread_id', '')::uuid, nullif(v_lead ->> 'campaign_target_id', '')::uuid, v_until);
      return action_gateway.finish_intent(i.intent_id, 'succeeded', 'LEAD_ASSIGNED', jsonb_build_object('lead_ref', v_ref, 'owner_agent_id', i.agent_id, 'lease_until', v_until, 'renewed', v_owner = i.agent_id));
    end if;
    if v_owner is distinct from i.agent_id then return action_gateway.finish_intent(i.intent_id, 'refused', 'NOT_LEAD_OWNER', jsonb_build_object('lead_ref', v_ref)); end if;
    update action_gateway.lead_assignments set released_at = clock_timestamp(), release_reason = 'released_by_owner' where org_id = i.org_id and lead_ref = v_ref and released_at is null;
    return action_gateway.finish_intent(i.intent_id, 'succeeded', 'LEAD_RELEASED', jsonb_build_object('lead_ref', v_ref));
  exception when others then
    return action_gateway.finish_intent(i.intent_id, 'failed', 'DOMAIN_WRITE_FAILED', jsonb_build_object('sqlstate', sqlstate));
  end;
end
$fn$;

-- the gateway's read of a lead's ownership (tenant claim required); never a phone
create function public.action_gateway_lead_assignment_get(p_campaign_target_id uuid, p_thread_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare v_lead jsonb; a action_gateway.lead_assignments%rowtype;
begin
  if action_gateway.request_org() is null then return null; end if;
  v_lead := action_gateway.agent_message_lead(jsonb_strip_nulls(jsonb_build_object('campaign_target_id', p_campaign_target_id, 'thread_id', p_thread_id)));
  if v_lead is null or v_lead ? 'mismatch' then return jsonb_build_object('found', false); end if;
  select * into a from action_gateway.lead_assignments x where x.org_id = action_gateway.request_org() and x.lead_ref = v_lead ->> 'lead_ref' order by x.assigned_at desc limit 1;
  return jsonb_build_object('found', true, 'lead_ref', v_lead ->> 'lead_ref', 'thread_id', v_lead ->> 'thread_id', 'campaign_target_id', v_lead ->> 'campaign_target_id',
                            'owner_agent_id', action_gateway.lead_owner(action_gateway.request_org(), v_lead ->> 'lead_ref'),
                            'last_assignment', case when a.assignment_id is null then null else jsonb_build_object('agent_id', a.agent_id, 'assigned_at', a.assigned_at, 'lease_until', a.lease_until,
                                                                                                                      'released_at', a.released_at, 'release_reason', a.release_reason) end,
                            'read_at', clock_timestamp());
end
$fn$;

-- ───────────────────────────────────────────── 4. the T3 lists (#28's helpers, + queue_agent_message) ──
create or replace function action_gateway.t34_handoff_kind(p_action text)
returns text language sql immutable parallel safe set search_path = pg_catalog
-- ONE LeadCommand-side executor kind for every handed-off gateway action (the worker dispatches by the intent's action)
as $fn$ select case when p_action in ('queue_authorized_reply', 'execute_authorized_offer', 'record_seller_counteroffer', 'queue_agent_message') then 'action_gateway.execute' else null end $fn$;

create or replace function action_gateway.t34_hold_capabilities(p_action text)
returns text[] language sql immutable parallel safe set search_path = pg_catalog
as $fn$ select case p_action
  when 'queue_authorized_reply' then array['ai_action','auto_reply','outbound_send']
  when 'execute_authorized_offer' then array['ai_action','auto_reply','offer_write','outbound_send']
  when 'record_seller_counteroffer' then array['offer_write']
  -- an agent-initiated message: an AI action, an automated message, a campaign / follow-up touch, an outbound send
  when 'queue_agent_message' then array['ai_action','auto_reply','campaign','follow_up','outbound_send']
  else array['ai_action','auto_reply','offer_write','outbound_send','offer_acceptance','stage_advance'] end::text[] $fn$;

create or replace function action_gateway.t34_capability_refusal(p_action text)
returns text
language plpgsql
stable
set search_path = pg_catalog
as $fn$
declare v_stop text; v_switch text; v_policy text; v_enabled boolean; v_code text;
begin
  if p_action = 'record_seller_counteroffer' then return null; end if;
  -- an agent message: both emergency stops, the AI-reply certification gate, its own switch and policy
  if p_action = 'queue_agent_message' then
    v_code := action_gateway.agent_message_refusal();
    return case when v_code is null then null when v_code = 'EMERGENCY_STOP_ACTIVE' then 'EMERGENCY_STOP_ACTIVE' else 'CAPABILITY_UNAVAILABLE' end;
  end if;
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

-- ───────────────────────────────────────────── 5. standing authority (#31, the second pair) ──
alter table action_gateway.capability_grants
  add column agent_message_lead_day_cap smallint,
  drop constraint capability_grants_standing_seller_facing_chk,
  add constraint capability_grants_standing_seller_facing_chk check (
    (not standing_seller_facing and standing_basis is null)
    or (standing_seller_facing and capability in ('conversation.queue_reply', 'conversation.queue_agent_message') and max_tier = 3
        and standing_basis is not null and standing_basis ~ '^[A-Za-z0-9 _.:/#()-]{12,200}$')),
  add constraint capability_grants_agent_message_lead_day_cap_chk check (
    agent_message_lead_day_cap is null or (capability = 'conversation.queue_agent_message' and agent_message_lead_day_cap between 1 and 3));

alter table action_gateway.action_authorizations
  drop constraint action_authorizations_standing_chk,
  add constraint action_authorizations_standing_chk check (
    not standing or (tier = 3 and capability in ('conversation.queue_reply', 'conversation.queue_agent_message') and approval_id is null and envelope_ref is null and not approval_required));

-- null when the grant is a live standing seller-facing grant of the intent's own agent for the intent's (action,
-- capability) pair — the certified reply or the agent message; otherwise the reason. Used when authorizing (#31's
-- trigger), at the handoff and when LeadCommand's worker loads the job.
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
  if i.intent_id is null or i.tier <> 3
     or not ((i.action = 'queue_authorized_reply' and i.capability = 'conversation.queue_reply') or (i.action = 'queue_agent_message' and i.capability = 'conversation.queue_agent_message')) then
    return 'STANDING_NOT_FOR_ACTION';
  end if;
  select * into g from action_gateway.capability_grants where grant_id = p_grant_id;
  if g.grant_id is null or not g.standing_seller_facing or g.capability <> i.capability or g.max_tier <> 3
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
  -- Agntei 5.4: …except the certified seller reply and (link #32) the agent-initiated message, each under an
  -- owner-minted STANDING seller-facing grant for exactly its capability (their own gates still apply)
  if i.tier >= 3 and not p_has_approval
     and not (i.tier = 3 and g.standing_seller_facing and g.capability = i.capability
              and ((i.action = 'queue_authorized_reply' and g.capability = 'conversation.queue_reply') or (i.action = 'queue_agent_message' and g.capability = 'conversation.queue_agent_message'))) then
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

-- ───────────────────────────────────────────── 6. the handoff (#31's body + the agent-message lead) ──
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
  v_lead jsonb; v_mo text;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['queue_authorized_reply', 'execute_authorized_offer', 'record_seller_counteroffer', 'queue_agent_message']);
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
    -- Agntei 5.4 / link #32: …or, for the certified seller reply and the agent message only, a STANDING authorization
    -- whose flagged grant is still live (re-verified NOW: a grant revoked, suspended or expired since refuses here)
    elsif v_auth.approval_id is null
          and not (v_auth.standing and action_gateway.standing_reply_refusal(v_auth.grant_id, i.intent_id) is null) then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'APPROVAL_REQUIRED', '{}'::jsonb);
    end if;
    v_code := action_gateway.t34_capability_refusal(i.action);
    if v_code is not null then return action_gateway.finish_intent(i.intent_id, 'refused', v_code, jsonb_build_object('stage', 'execution')); end if;
    if i.action = 'queue_agent_message' then
      -- the lead: its thread, or (a first touch) its campaign target and number; no thread is required
      v_lead := action_gateway.agent_message_lead(i.params);
      if v_lead is null or v_lead ? 'mismatch' or nullif(v_lead ->> 'phone', '') is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'LEAD_NOT_FOUND', '{}'::jsonb); end if;
      v_tk := v_lead ->> 'phone';
      v_thread := nullif(v_lead ->> 'thread_id', '')::uuid;
      v_pid := nullif(v_lead ->> 'property_id', '');
      v_mo := nullif(v_lead ->> 'master_owner_id', '');
      -- ONE sender per lead at a time: the lead's owner principal, serialized per lead
      perform pg_advisory_xact_lock(hashtext('agent_message:' || i.org_id::text || ':' || (v_lead ->> 'lead_ref')));
      if action_gateway.lead_owner(i.org_id, v_lead ->> 'lead_ref') is distinct from i.agent_id then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'NOT_LEAD_OWNER', jsonb_build_object('stage', 'execution'));
      end if;
      if exists (select 1 from action_gateway.seller_action_receipts r join action_gateway.action_intents x on x.intent_id = r.intent_id
                  where r.action = 'queue_agent_message' and r.state in ('requested', 'executing') and r.intent_id <> i.intent_id and r.org_id = i.org_id
                    and action_gateway.agent_message_lead(x.params) ->> 'lead_ref' = v_lead ->> 'lead_ref') then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'LEAD_SEND_IN_FLIGHT', jsonb_build_object('stage', 'execution'));
      end if;
      if v_thread is not null then perform 1 from public.inbox_thread_state t where t.id = v_thread for share; end if;
    else
      v_thread := (i.params ->> 'thread_id')::uuid;
      select t.thread_key, t.property_id into v_tk, v_pid from public.inbox_thread_state t where t.id = v_thread for share;
      if v_tk is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'THREAD_NOT_FOUND', '{}'::jsonb); end if;
      v_pid := coalesce(action_gateway.decode_property_ref(i.params ->> 'property_ref'), v_pid);
    end if;
    -- THE hold registry: any active hold on the thread / property (/ owner) for a capability this action exercises
    if exists (select 1 from public.automation_hold_for(v_tk, v_thread, v_pid, null, v_mo, null) h
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

-- the property id as agents see it on the feed: agent.payload_is_clean admits a property id only in the encoded letter
-- form pid_<digits as g..p> (decoded by action_gateway.decode_property_ref); a non-numeric id has no encoded form and is
-- left out (null)
create function action_gateway.property_ref_of(p_property_id text)
returns text language sql immutable parallel safe set search_path = pg_catalog
as $fn$ select case when btrim(coalesce(p_property_id, '')) ~ '^pid_[g-p]{1,20}$' then btrim(p_property_id)
                    when btrim(coalesce(p_property_id, '')) ~ '^[0-9]{1,20}$' then 'pid_' || translate(btrim(p_property_id), '0123456789', 'ghijklmnop') end $fn$;

-- the campaign target of a recipient number (and property, when known): the newest target of that number, a target of
-- the same property first. Index-friendly: the number in its three stored spellings.
create function action_gateway.campaign_target_of(p_phone text, p_property_id text)
returns uuid language sql stable security definer set search_path = pg_catalog
as $fn$
  select x.id from public.campaign_targets x
   where nullif(btrim(coalesce(p_phone, '')), '') is not null
     and x.to_phone_number in (p_phone, right(regexp_replace(p_phone, '\D', '', 'g'), 10), '1' || right(regexp_replace(p_phone, '\D', '', 'g'), 10))
   order by (x.property_id is not distinct from p_property_id) desc, (to_jsonb(x) ->> 'created_at') desc nulls last, x.id
   limit 1
$fn$;

-- the ids an agent links a lead by, added to every event's payload when LeadCommand knows them: property_id (encoded,
-- see property_ref_of; a raw id a writer passed is encoded or dropped) and campaign_target_id. Ids only, never contact data.
create function action_gateway.lead_event_ids(p_payload jsonb, p_thread_id uuid, p_phone text, p_property_id text default null, p_campaign_target_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog
as $fn$
declare v jsonb := coalesce(p_payload, '{}'::jsonb); v_prop text; v_ct uuid := p_campaign_target_id;
begin
  v_prop := action_gateway.decode_property_ref(coalesce(nullif(p_property_id, ''), nullif(v ->> 'property_id', '')));
  if v_prop is null and p_thread_id is not null then select s.property_id into v_prop from public.inbox_thread_state s where s.id = p_thread_id; end if;
  if v_ct is null and coalesce(v ->> 'campaign_target_id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_ct := (v ->> 'campaign_target_id')::uuid; end if;
  if v_ct is null then v_ct := action_gateway.campaign_target_of(p_phone, v_prop); end if;
  -- a thread a first touch created knows no property yet: its campaign target does
  if v_prop is null and v_ct is not null then select x.property_id into v_prop from public.campaign_targets x where x.id = v_ct; end if;
  v := v - 'property_id' - 'campaign_target_id';
  if action_gateway.property_ref_of(v_prop) is not null then v := v || jsonb_build_object('property_id', action_gateway.property_ref_of(v_prop)); end if;
  if v_ct is not null then v := v || jsonb_build_object('campaign_target_id', v_ct); end if;
  return v;
end
$fn$;

-- ───────────────────────────────────────────── 7. the event outbox (agents' wake-up feed) ──
create table action_gateway.lead_events (
  cursor       bigint generated always as identity primary key,
  event_id     text not null unique check (event_id ~ '^[a-z_]{3,30}:[A-Za-z0-9_.:-]{1,160}$'),
  kind         text not null check (kind in ('inbound_message', 'lead_state_changed', 'delivery_changed', 'opt_out')),
  thread_id    uuid,
  thread_ref   text check (thread_ref is null or thread_ref ~ '^thr_[a-p]{12}$'),
  intent_id    uuid,
  payload      jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 4000 and agent.payload_is_clean(payload)),
  occurred_at  timestamptz not null,
  created_at   timestamptz not null default clock_timestamp()
);
comment on table action_gateway.lead_events is 'Agent wake-up feed (link #32): an append-only, cursor-ordered outbox of lead events (inbound_message, lead_state_changed, delivery_changed, opt_out). Idempotent event ids; never a phone number or message text (thread ids, sealed refs, codes). Written by LeadCommand (lc_lead_event_append, the receipt writer); read by the gateway (action_gateway_events_since).';
create function action_gateway.lead_events_append_only() returns trigger language plpgsql set search_path = pg_catalog as $fn$
begin raise exception 'lead_events is append-only' using errcode = '55000'; end $fn$;
create trigger lead_events_append_only before update or delete on action_gateway.lead_events for each row execute function action_gateway.lead_events_append_only();
create trigger lead_events_no_truncate before truncate on action_gateway.lead_events for each statement execute function action_gateway.lead_events_append_only();
alter table action_gateway.lead_events enable row level security;
revoke all on action_gateway.lead_events from public, anon, authenticated, service_role;

-- LeadCommand's writer (service_role): idempotent per event id (a webhook retry appends nothing); the thread key is
-- sealed here and never stored
create function public.lc_lead_event_append(p_kind text, p_event_key text, p_thread_key text, p_thread_id uuid, p_payload jsonb, p_occurred_at timestamptz default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare v_cursor bigint; v_tid uuid := p_thread_id;
begin
  if v_tid is null and nullif(btrim(coalesce(p_thread_key, '')), '') is not null then
    select s.id into v_tid from public.inbox_thread_state s where s.thread_key = p_thread_key order by s.id limit 1;
  end if;
  insert into action_gateway.lead_events (event_id, kind, thread_id, thread_ref, payload, occurred_at)
  values (p_kind || ':' || p_event_key, p_kind, v_tid, case when nullif(btrim(coalesce(p_thread_key, '')), '') is null then null else action_gateway.thread_ref_of(p_thread_key) end,
          action_gateway.lead_event_ids(p_payload, v_tid, nullif(btrim(coalesce(p_thread_key, '')), '')), coalesce(p_occurred_at, clock_timestamp()))
  on conflict (event_id) do nothing
  returning cursor into v_cursor;
  return jsonb_build_object('ok', true, 'appended', v_cursor is not null, 'cursor', v_cursor);
end
$fn$;

-- The gateway's read: events after the cursor, in cursor order, SETTLED rows only (older than one second, so a
-- concurrent writer's lower cursor is never skipped); next_cursor = the last returned (or the input). At least once.
create function public.action_gateway_events_since(p_cursor bigint, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  with ev as (
    select e.* from action_gateway.lead_events e
     where e.cursor > greatest(coalesce(p_cursor, 0), 0) and e.created_at < clock_timestamp() - interval '1 second'
     order by e.cursor limit greatest(1, least(coalesce(p_limit, 100), 500)))
  select case when action_gateway.request_org() is null then null else jsonb_build_object(
    'events', coalesce((select jsonb_agg(jsonb_build_object('cursor', ev.cursor, 'event_id', ev.event_id, 'kind', ev.kind, 'thread_id', ev.thread_id, 'thread_ref', ev.thread_ref,
                                                            'intent_id', ev.intent_id, 'payload', ev.payload, 'occurred_at', ev.occurred_at) order by ev.cursor) from ev), '[]'::jsonb),
    'next_cursor', coalesce((select max(ev.cursor) from ev), greatest(coalesce(p_cursor, 0), 0)),
    'read_at', clock_timestamp()) end
$fn$;

-- ───────────────────────────────────────────── 8. the receipt writer (#28's body; the agent message's item + delivery events) ──
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
  v_lead jsonb;
begin
  select * into r from action_gateway.seller_action_receipts where intent_id = p_intent_id for update;
  if r.intent_id is null then return jsonb_build_object('ok', false, 'reason', 'receipt_not_found'); end if;
  if p_job_id is distinct from r.job_id then return jsonb_build_object('ok', false, 'reason', 'job_mismatch'); end if;
  if r.state = p_state and r.state <> 'executing' then return jsonb_build_object('ok', true, 'replayed', true, 'state', r.state, 'work_item_id', r.work_item_id); end if;
  if not action_gateway.receipt_transition_ok(r.state, p_state) then return jsonb_build_object('ok', false, 'reason', 'illegal_transition', 'state', r.state); end if;
  v_item := r.work_item_id;
  select * into i from action_gateway.action_intents where intent_id = r.intent_id;
  if p_state in ('held', 'failed', 'outcome_unknown', 'refused') then
    v_sev := case when p_state = 'outcome_unknown' then 'critical' when p_state = 'refused' then 'info' else 'warning' end;
    insert into agent.ops_work_item (org_id, scope, kind, dedupe_key, severity, escalated, title, subject_type, subject_id, detail, priority, source_job_id)
    values (r.org_id, 'agent', 'escalation', 'agent:seller_action:' || r.intent_id::text, v_sev, p_state <> 'refused',
            case r.action when 'queue_authorized_reply' then 'Agent-requested seller reply was not sent: an operator decides'
                          when 'execute_authorized_offer' then 'Agent-requested offer was not sent: an operator decides'
                          when 'queue_agent_message' then 'Agent-initiated message was not sent: an operator decides'
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
  -- link #32: what happened to a message an agent asked for is an event on the agents' feed (never the text)
  if p_state in ('enqueued', 'sent', 'held', 'refused', 'deferred', 'failed', 'outcome_unknown') and r.action in ('queue_authorized_reply', 'queue_agent_message') then
    v_lead := action_gateway.agent_message_lead(i.params);
    insert into action_gateway.lead_events (event_id, kind, thread_id, thread_ref, intent_id, payload, occurred_at)
    values ('delivery_changed:' || r.intent_id::text || ':' || p_state, 'delivery_changed',
            coalesce(nullif(v_lead ->> 'thread_id', '')::uuid, nullif(i.params ->> 'thread_id', '')::uuid), v_lead ->> 'lead_ref', r.intent_id,
            action_gateway.lead_event_ids(jsonb_build_object('action', r.action, 'receipt_state', p_state, 'code', r.code, 'queue_row_id', r.queue_row_id, 'agent_id', i.agent_id,
                                                              'purpose', i.params ->> 'purpose'),
                                          coalesce(nullif(v_lead ->> 'thread_id', '')::uuid, nullif(i.params ->> 'thread_id', '')::uuid), v_lead ->> 'phone', v_lead ->> 'property_id',
                                          nullif(coalesce(v_lead ->> 'campaign_target_id', i.params ->> 'campaign_target_id'), '')::uuid), clock_timestamp())
    on conflict (event_id) do nothing;
  end if;
  return jsonb_build_object('ok', true, 'replayed', false, 'state', r.state, 'work_item_id', r.work_item_id);
end
$fn$;

-- ───────────────────────────────────────────── 9. the daily caps (idempotency_ledger reservations) ──
-- ONE per-lead slot (scope agent_message_lead_day, key <lead ref>:<UTC day>:<n>, n ≤ the grant's
-- agent_message_lead_day_cap or the policy's max_per_lead_per_day) and ONE global slot (scope agent_message_global_day,
-- key <UTC day>:<n>, n ≤ max_per_day_global), taken together under one transaction-scoped advisory lock. Idempotent per
-- intent (the claim token IS the intent id: a retried job finds its own slots). A released slot (failed) is reusable.
create function public.lc_agent_message_reserve(p_intent_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare
  i action_gateway.action_intents%rowtype; g action_gateway.capability_grants%rowtype; v_pol jsonb; v_lead jsonb; v_ref text; v_day text;
  v_lead_cap int; v_global_cap int; n int; v_key text; v_lead_slot int; v_global_slot int; v_meta jsonb; v_hit text;
begin
  select * into i from action_gateway.action_intents where intent_id = p_intent_id;
  if i.intent_id is null or i.action <> 'queue_agent_message' then return jsonb_build_object('ok', false, 'code', 'INTENT_NOT_AGENT_MESSAGE'); end if;
  v_day := to_char((clock_timestamp() at time zone 'utc')::date, 'YYYY-MM-DD');
  perform pg_advisory_xact_lock(hashtext('lc_agent_message_caps'));
  -- this intent's own live slots (a retry after a crash): never a second pair
  select split_part(l.key, ':', 3) into v_hit from public.idempotency_ledger l where l.scope = 'agent_message_lead_day' and l.claim_token = p_intent_id and l.status in ('processing', 'completed') limit 1;
  if v_hit is not null then
    select split_part(l.key, ':', 2) into v_key from public.idempotency_ledger l where l.scope = 'agent_message_global_day' and l.claim_token = p_intent_id and l.status in ('processing', 'completed') limit 1;
    if v_key is not null then return jsonb_build_object('ok', true, 'replayed', true, 'lead_slot', v_hit::int, 'global_slot', v_key::int, 'day', v_day); end if;
  end if;
  v_pol := action_gateway.agent_message_policy();
  select g0.* into g from action_gateway.action_authorizations a join action_gateway.capability_grants g0 on g0.grant_id = a.grant_id where a.intent_id = i.intent_id;
  v_lead_cap := coalesce(g.agent_message_lead_day_cap, (v_pol ->> 'max_per_lead_per_day')::int, 0);
  v_global_cap := coalesce((v_pol ->> 'max_per_day_global')::int, 0);
  v_lead := action_gateway.agent_message_lead(i.params);
  if v_lead is null or v_lead ? 'mismatch' or nullif(v_lead ->> 'lead_ref', '') is null then return jsonb_build_object('ok', false, 'code', 'LEAD_NOT_FOUND'); end if;
  v_ref := v_lead ->> 'lead_ref';
  v_meta := jsonb_build_object('intent_id', i.intent_id, 'agent_id', i.agent_id, 'engine', 'action_gateway_agent_message');
  for n in 1 .. greatest(v_lead_cap, 0) loop
    v_key := v_ref || ':' || v_day || ':' || n;
    insert into public.idempotency_ledger (scope, key, claim_token, status, summary, metadata)
    values ('agent_message_lead_day', v_key, p_intent_id, 'processing', 'agent_message_lead_day', v_meta)
    on conflict (scope, key) do update set claim_token = excluded.claim_token, status = 'processing', summary = excluded.summary, metadata = excluded.metadata,
                                           started_at = now(), failed_at = null, last_error = null, updated_at = now()
      where public.idempotency_ledger.status = 'failed'
    returning n into v_lead_slot;
    exit when v_lead_slot is not null;
  end loop;
  if v_lead_slot is null then return jsonb_build_object('ok', false, 'code', 'DAILY_LEAD_CAP_REACHED', 'cap', v_lead_cap, 'day', v_day); end if;
  for n in 1 .. greatest(v_global_cap, 0) loop
    v_key := v_day || ':' || n;
    insert into public.idempotency_ledger (scope, key, claim_token, status, summary, metadata)
    values ('agent_message_global_day', v_key, p_intent_id, 'processing', 'agent_message_global_slot', v_meta)
    on conflict (scope, key) do update set claim_token = excluded.claim_token, status = 'processing', summary = excluded.summary, metadata = excluded.metadata,
                                           started_at = now(), failed_at = null, last_error = null, updated_at = now()
      where public.idempotency_ledger.status = 'failed'
    returning n into v_global_slot;
    exit when v_global_slot is not null;
  end loop;
  if v_global_slot is null then
    update public.idempotency_ledger set status = 'failed', failed_at = now(), last_error = 'global_daily_cap', updated_at = now()
     where scope = 'agent_message_lead_day' and claim_token = p_intent_id and status = 'processing';
    return jsonb_build_object('ok', false, 'code', 'DAILY_GLOBAL_CAP_REACHED', 'cap', v_global_cap, 'day', v_day);
  end if;
  return jsonb_build_object('ok', true, 'replayed', false, 'lead_slot', v_lead_slot, 'global_slot', v_global_slot, 'day', v_day, 'lead_cap', v_lead_cap, 'global_cap', v_global_cap);
end
$fn$;

-- completed (a queue row exists: the slots are spent) or released (nothing was queued: the slots are free again)
create function public.lc_agent_message_settle(p_intent_id uuid, p_outcome text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare n int;
begin
  if p_outcome = 'completed' then
    update public.idempotency_ledger set status = 'completed', completed_at = now(), updated_at = now()
     where scope in ('agent_message_lead_day', 'agent_message_global_day') and claim_token = p_intent_id and status = 'processing';
  elsif p_outcome = 'released' then
    update public.idempotency_ledger set status = 'failed', failed_at = now(), last_error = 'released_nothing_queued', updated_at = now()
     where scope in ('agent_message_lead_day', 'agent_message_global_day') and claim_token = p_intent_id and status = 'processing';
  else
    return jsonb_build_object('ok', false, 'reason', 'outcome_invalid');
  end if;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'rows', n);
end
$fn$;

-- ───────────────────────────────────────────── 10. reads ──
-- The gateway role (tenant claim required): the activation, the normalized policy, the lead behind a campaign target
-- and / or a thread (the target row's routing / identity / suppression states and the recipient are for the policy's own
-- reads, never returned to an agent), its live owner and today's cap usage.
create function public.action_gateway_agent_message_state(p_campaign_target_id uuid, p_thread_id uuid, p_grant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare v_code text; v_lead jsonb; ct jsonb;
begin
  if action_gateway.request_org() is null then return null; end if;
  v_code := action_gateway.agent_message_refusal();
  if p_campaign_target_id is not null or p_thread_id is not null then
    v_lead := action_gateway.agent_message_lead(jsonb_strip_nulls(jsonb_build_object('campaign_target_id', p_campaign_target_id, 'thread_id', p_thread_id)));
    if p_campaign_target_id is not null then
      select jsonb_build_object('id', x ->> 'id', 'campaign_id', x ->> 'campaign_id', 'property_id', x ->> 'property_id', 'master_owner_id', x ->> 'master_owner_id',
                                'prospect_id', x ->> 'prospect_id', 'phone_id', x ->> 'phone_id', 'market', x ->> 'market', 'language', x ->> 'language',
                                'timezone', x ->> 'timezone', 'state', x ->> 'state', 'property_address', x ->> 'property_address', 'touch_number', x ->> 'touch_number',
                                'target_status', x ->> 'target_status', 'routing_status', x ->> 'routing_status', 'identity_status', x ->> 'identity_status',
                                'suppression_status', x ->> 'suppression_status', 'seller_first_name', x #>> '{metadata,candidate_snapshot,seller_first_name}')
        into ct from (select to_jsonb(t) x from public.campaign_targets t where t.id::text = p_campaign_target_id::text) s;
    end if;
  end if;
  return jsonb_build_object('available', v_code is null, 'code', v_code, 'policy', action_gateway.agent_message_policy(),
                            'lead', v_lead, 'target', ct, 'owner_agent_id', case when v_lead ? 'lead_ref' then action_gateway.lead_owner(action_gateway.request_org(), v_lead ->> 'lead_ref') end,
                            'grant_lead_day_cap', (select g.agent_message_lead_day_cap from action_gateway.capability_grants g where g.grant_id = p_grant_id and g.org_id = action_gateway.request_org()),
                            'usage', action_gateway.agent_message_usage(v_lead ->> 'lead_ref'), 'read_at', clock_timestamp());
end
$fn$;

-- The governed fallback templates the policy names (each with the purposes it may serve and its rotation-governance row).
-- Template copy is LeadCommand's governed text with merge fields ({{seller_first_name}}, {{agent_name}}, …).
create function public.action_gateway_message_templates()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  with pol as (select action_gateway.agent_message_policy() p),
  allowed as (select x.purpose, x.template_id from pol, lateral (
      select 'first_touch' purpose, jsonb_array_elements_text(pol.p -> 'fallback_templates' -> 'first_touch') template_id
      union all select 'reengage', jsonb_array_elements_text(pol.p -> 'fallback_templates' -> 'reengage')
      union all select 'followup', jsonb_array_elements_text(pol.p -> 'fallback_templates' -> 'followup')) x)
  select case when action_gateway.request_org() is null then null else coalesce((
    select jsonb_agg(jsonb_build_object(
             'template_id', t.j ->> 'template_id', 'template_name', t.j ->> 'template_name', 'use_case', t.j ->> 'use_case', 'language', t.j ->> 'language',
             'stage_code', t.j ->> 'stage_code', 'is_active', (t.j ->> 'is_active')::boolean, 'template_body', t.j ->> 'template_body',
             'purposes', (select jsonb_agg(a.purpose order by a.purpose) from allowed a where a.template_id = t.j ->> 'template_id'),
             'governance', (select jsonb_build_object('rotation_status', to_jsonb(g) ->> 'rotation_status', 'language', to_jsonb(g) ->> 'language',
                                                      'daily_cap', to_jsonb(g) -> 'daily_cap', 'last_40d_total_sent', to_jsonb(g) -> 'last_40d_total_sent',
                                                      'traffic_weight', to_jsonb(g) -> 'traffic_weight', 'block_reason', to_jsonb(g) ->> 'block_reason')
                              from public.ownership_template_rotation_control g where g.template_id::text = t.j ->> 'template_id' limit 1))
           order by t.j ->> 'template_id')
      from (select to_jsonb(s) j from public.sms_templates s where s.template_id::text in (select template_id from allowed)) t), '[]'::jsonb) end
$fn$;

-- LeadCommand's worker and the queue runner (service_role): the activation and the lead (+ its owner and usage)
create function public.lc_agent_message_activation()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select jsonb_build_object('available', action_gateway.agent_message_refusal() is null, 'code', action_gateway.agent_message_refusal(),
                            'policy', action_gateway.agent_message_policy(), 'read_at', clock_timestamp())
$fn$;
create function public.lc_agent_message_lead(p_intent_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare i action_gateway.action_intents%rowtype; v_lead jsonb;
begin
  select * into i from action_gateway.action_intents where intent_id = p_intent_id;
  if i.intent_id is null or i.action <> 'queue_agent_message' then return null; end if;
  v_lead := action_gateway.agent_message_lead(i.params);
  if v_lead is null or v_lead ? 'mismatch' then return null; end if;
  return v_lead || jsonb_build_object('owner_agent_id', action_gateway.lead_owner(i.org_id, v_lead ->> 'lead_ref'), 'agent_id', i.agent_id,
                                      'usage', action_gateway.agent_message_usage(v_lead ->> 'lead_ref'));
end
$fn$;

-- ───────────────────────────────────────────── 10b. the agents' lead pool (leads.read_pool, T1) ──
-- The ADDRESSABLE leads of one market for the gateway's pool read (agent_lead_pool): every campaign target of the market
-- (with the thread of its number when one exists) and every thread of the market whose number has no target there.
-- Keyset-paged by row_key ('ct:<target id>' / 'th:<thread id>'). The number and the target's readiness travel to the
-- gateway process only, which judges eligibility with the send path's OWN guards and returns ids and codes (never a
-- number, a name or a message).
create function public.action_gateway_agent_lead_pool(p_market text, p_limit integer, p_after text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare v_lim integer := greatest(1, least(coalesce(p_limit, 50), 100)); v_rows jsonb;
begin
  if action_gateway.request_org() is null or nullif(btrim(coalesce(p_market, '')), '') is null then return null; end if;
  with tg as (
    select x.id, x.property_id, x.market, x.prospect_id, x.master_owner_id, x.target_status, x.routing_status, x.identity_status, x.suppression_status,
           case when length(regexp_replace(coalesce(x.to_phone_number, x.canonical_e164, ''), '\D', '', 'g')) = 10 then '+1' || regexp_replace(coalesce(x.to_phone_number, x.canonical_e164, ''), '\D', '', 'g')
                when length(regexp_replace(coalesce(x.to_phone_number, x.canonical_e164, ''), '\D', '', 'g')) = 11 and left(regexp_replace(coalesce(x.to_phone_number, x.canonical_e164, ''), '\D', '', 'g'), 1) = '1'
                  then '+' || regexp_replace(coalesce(x.to_phone_number, x.canonical_e164, ''), '\D', '', 'g') end as phone
      from public.campaign_targets x where lower(btrim(coalesce(x.market, ''))) = lower(btrim(p_market))),
  rows_ as (
    select 'ct:' || tg.id::text as row_key, tg.property_id, tg.id as campaign_target_id, s.id as thread_id, tg.market, tg.phone, tg.prospect_id, tg.master_owner_id,
           jsonb_build_object('target_status', tg.target_status, 'routing_status', tg.routing_status, 'identity_status', tg.identity_status, 'suppression_status', tg.suppression_status) as target
      from tg left join lateral (select s.id from public.inbox_thread_state s where s.thread_key = tg.phone order by s.id limit 1) s on true
     where tg.phone is not null
    union all
    select 'th:' || s.id::text, s.property_id, null::uuid, s.id, to_jsonb(s) ->> 'market', s.thread_key, to_jsonb(s) ->> 'prospect_id', to_jsonb(s) ->> 'master_owner_id', null::jsonb
      from public.inbox_thread_state s
     where lower(btrim(coalesce(to_jsonb(s) ->> 'market', ''))) = lower(btrim(p_market))
       and not exists (select 1 from tg where tg.phone = s.thread_key))
  select coalesce(jsonb_agg(to_jsonb(r) order by r.row_key), '[]'::jsonb) into v_rows
    from (select * from rows_ where row_key > coalesce(p_after, '') order by row_key limit v_lim + 1) r;
  return jsonb_build_object('rows', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_rows) with ordinality t(e, n) where n <= v_lim) z),
                            'has_more', jsonb_array_length(v_rows) > v_lim);
end
$fn$;

-- ───────────────────────────────────────────── 11. the registry rows (#27) ──
insert into action_gateway.extensions (kind, name, link, basis) values
  ('definer_function', 'public.action_gateway_agent_message_state(uuid,uuid,uuid)', 'PROPOSED_20261029100000_action_gateway_agent_message', null),
  ('definer_function', 'public.action_gateway_message_templates()', 'PROPOSED_20261029100000_action_gateway_agent_message', null),
  ('definer_function', 'public.action_gateway_dw_lead_assignment(uuid,uuid)', 'PROPOSED_20261029100000_action_gateway_agent_message', null),
  ('definer_function', 'public.action_gateway_lead_assignment_get(uuid,uuid)', 'PROPOSED_20261029100000_action_gateway_agent_message', null),
  ('definer_function', 'public.action_gateway_events_since(bigint,integer)', 'PROPOSED_20261029100000_action_gateway_agent_message', null),
  ('definer_function', 'public.action_gateway_agent_lead_pool(text,integer,text)', 'PROPOSED_20261029100000_action_gateway_agent_message', null),
  ('standing_t2_action', 'assign_lead', 'PROPOSED_20261029100000_action_gateway_agent_message', 'reversible'),
  ('standing_t2_action', 'release_lead', 'PROPOSED_20261029100000_action_gateway_agent_message', 'reversible'),
  ('domain_write_action', 'queue_agent_message', 'PROPOSED_20261029100000_action_gateway_agent_message', null),
  ('domain_write_action', 'assign_lead', 'PROPOSED_20261029100000_action_gateway_agent_message', null),
  ('domain_write_action', 'release_lead', 'PROPOSED_20261029100000_action_gateway_agent_message', null);

-- ───────────────────────────────────────────── 12. privileges ──
do $$
declare f text;
begin
  foreach f in array array['action_gateway.agent_message_policy()', 'action_gateway.agent_message_refusal()', 'action_gateway.agent_message_lead(jsonb)', 'action_gateway.agent_message_usage(text)',
      'action_gateway.lead_owner(uuid,text)', 'action_gateway.lead_events_append_only()',
      'public.action_gateway_dw_lead_assignment(uuid,uuid)', 'public.action_gateway_lead_assignment_get(uuid,uuid)', 'public.lc_lead_event_append(text,text,text,uuid,jsonb,timestamp with time zone)',
      'public.action_gateway_events_since(bigint,integer)', 'public.lc_agent_message_reserve(uuid)', 'public.lc_agent_message_settle(uuid,text)',
      'public.action_gateway_agent_message_state(uuid,uuid,uuid)', 'public.action_gateway_message_templates()', 'public.lc_agent_message_activation()', 'public.lc_agent_message_lead(uuid)',
      'public.action_gateway_agent_lead_pool(text,integer,text)', 'action_gateway.property_ref_of(text)', 'action_gateway.campaign_target_of(text,text)',
      'action_gateway.lead_event_ids(jsonb,uuid,text,text,uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
-- the receipt writer was re-created: its #28 privileges (LeadCommand's worker only)
revoke all on function public.lc_seller_action_receipt_record(uuid, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.lc_seller_action_receipt_record(uuid, text, text, text, jsonb, text) to service_role;
grant execute on function public.action_gateway_agent_message_state(uuid, uuid, uuid), public.action_gateway_message_templates(), public.action_gateway_dw_lead_assignment(uuid, uuid),
  public.action_gateway_lead_assignment_get(uuid, uuid), public.action_gateway_events_since(bigint, integer), public.action_gateway_agent_lead_pool(text, integer, text) to lc_action_gateway;
grant execute on function public.lc_agent_message_reserve(uuid), public.lc_agent_message_settle(uuid, text), public.lc_agent_message_activation(), public.lc_agent_message_lead(uuid),
  public.lc_lead_event_append(text, text, text, uuid, jsonb, timestamp with time zone) to service_role;

-- ───────────────────────────────────────────── 13. the apply refuses unless the composed role check is ok ──
do $$
declare v jsonb;
begin
  v := action_gateway.self_check('lc_action_gateway');
  if not coalesce((v ->> 'ok')::boolean, false) then raise exception 'action_gateway_agent_message: self-check refused the role: %', v -> 'findings'; end if;
  if action_gateway.t34_handoff_kind('queue_agent_message') is distinct from 'action_gateway.execute' then raise exception 'postcondition: the handoff kind'; end if;
  if 'queue_agent_message' = any (action_gateway.standing_t2_actions()) or not (action_gateway.standing_t2_actions() @> array['assign_lead', 'release_lead']) then raise exception 'postcondition: the standing T2 rows'; end if;
  if action_gateway.agent_message_refusal() is null and not exists (select 1 from public.system_control where key = 'ai_agent_message_enabled') then raise exception 'postcondition: born OFF'; end if;
  if has_function_privilege('lc_action_gateway', 'public.lc_agent_message_reserve(uuid)', 'EXECUTE') or has_function_privilege('lc_action_gateway', 'public.lc_lead_event_append(text,text,text,uuid,jsonb,timestamp with time zone)', 'EXECUTE') then
    raise exception 'postcondition: the gateway role reaches a LeadCommand-side function';
  end if;
end $$;

notify pgrst, 'reload schema';
