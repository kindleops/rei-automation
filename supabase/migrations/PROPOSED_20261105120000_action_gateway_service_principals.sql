-- =============================================================================
-- PROPOSED_20261105120000_action_gateway_service_principals.sql
-- SERVICE PRINCIPALS with DELEGATED AGENTS, and CAMPAIGN DRAFTS through the Action Gateway.
-- STATUS: PROPOSED. NOT APPLIED. Owner approval required. Tested on disposable PostgreSQL 17 only.
-- Requires links #26 (action_gateway), #27 (the extension registry) and #28 (t34: the envelope branch of the
-- authorization guard this link extends). Rollback: PROPOSED_20261105120000_action_gateway_service_principals_rollback.sql
-- =============================================================================
--
-- WHY: agntei runs several acquisitions agents. Until now each needed its own bearer credential (one token and one
-- failure point per agent). The owner wants ONE administratively managed integration whose permissions stay
-- server-side and role-scoped. Identity in tool arguments stays refused (FORGED_CONTEXT_KEYS): the acting agent is
-- named only by the HTTP header X-LC-Acting-Agent of a request authenticated by a SERVICE credential.
--
-- WHAT IT CREATES
--   action_gateway.service_principals  one row per service credential (lcsvc_..., HMAC-SHA256 digest only, the same
--                                      pepper as the agent credentials): org, display name, accountable human sponsor,
--                                      tier ceiling, status, credential expiry (90 days at most). OWNER-WRITTEN ONLY;
--                                      the gateway role reads it only through action_gateway_service_principal(digest).
--   action_gateway.service_delegates   which EXISTING agent principals a service may act for (enabled / disabled,
--                                      who registered it, when). Owner-written only. Disabling a delegate (or the
--                                      service) takes effect on the next request: every call re-reads both.
--   agent_principals.credential_digest may now be NULL: an agent acted for only through a service needs no
--                                      credential of its own (nothing can present a NULL digest).
--   action_authorizations.via_service_id  the service a delegated authorization came through (set by the guard,
--                                      never by the caller); the acting agent is the row's agent_id, as before.
--   action_gateway.authorization_guard   #28's body exactly, plus ONE branch: the presented digest may be an active
--                                      service principal's of this org for which the intent's agent is an ENABLED
--                                      delegate; the service's tier ceiling bounds the tier as well (effective tier =
--                                      min(agent, service)); the service is recorded (via_service_id).
--   public.action_gateway_service_principal(text, text)   digest + acting agent id -> the service, the delegation
--                                      state and, ONLY when the delegation is enabled, the agent's own principal
--                                      (grants, read scopes, ceiling: the same shape as action_gateway_principal).
--   public.action_gateway_dw_campaign_draft(uuid, uuid)   the ONE lease-bound writer of create_campaign_draft (T1):
--                                      a Campaign Composer DRAFT (status 'draft') pinned to the intent's properties,
--                                      its campaign_filters row and its campaign.created event. Nothing else: no
--                                      targets, no schedule, no queue row, no send. Exactly once per intent (the
--                                      composer key derives from the intent's idempotency key). No gateway function
--                                      can launch, schedule or resume a campaign.
-- Registry rows (#27): both functions are definer functions; create_campaign_draft is a domain-write action.
-- Privileges: lc_action_gateway executes the two functions; it cannot read either new table.

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ───────────────────────────────────────────── 1. prerequisites ─────────────
do $$
declare t text; missing text[] := '{}';
begin
  if to_regprocedure('action_gateway.dw_begin(uuid,uuid,text[])') is null or to_regprocedure('action_gateway.authorization_guard()') is null then
    raise exception 'precondition: link #26 (action_gateway) is not applied';
  end if;
  if to_regclass('action_gateway.extensions') is null then raise exception 'precondition: link #27 (the extension registry) is not applied'; end if;
  if to_regprocedure('action_gateway.envelope_ref_refusal(uuid,text)') is null or to_regprocedure('action_gateway.decode_property_ref(text)') is null then
    raise exception 'precondition: link #28 (t34) is not applied';
  end if;
  if to_regclass('action_gateway.service_principals') is not null or to_regclass('action_gateway.service_delegates') is not null
     or to_regprocedure('public.action_gateway_service_principal(text,text)') is not null or to_regprocedure('public.action_gateway_dw_campaign_draft(uuid,uuid)') is not null then
    raise exception 'precondition: this link is already applied';
  end if;
  foreach t in array array['public.campaigns', 'public.campaign_filters', 'public.campaign_events', 'public.properties'] loop
    if to_regclass(t) is null then missing := missing || t; end if;
  end loop;
  foreach t in array array['name', 'status', 'objective', 'daily_cap', 'total_cap', 'auto_queue_enabled', 'auto_send_enabled', 'auto_reply_mode', 'metadata', 'created_at'] loop
    if to_regclass('public.campaigns') is not null and not exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'campaigns' and c.column_name = t) then
      missing := missing || ('public.campaigns.' || t);
    end if;
  end loop;
  if array_length(missing, 1) > 0 then raise exception 'precondition: missing %', array_to_string(missing, ', '); end if;
end $$;

-- ───────────────────────────────────────────── 2. the service principal registry ──
create table action_gateway.service_principals (
  service_id            text primary key check (service_id ~ '^svc_[a-z0-9][a-z0-9_]{2,40}$'),
  org_id                uuid not null references agent.org(org_id),
  display_name          text not null check (length(display_name) between 1 and 80 and display_name ~ '^[A-Za-z0-9 ._()-]+$'),
  sponsor_user_id       uuid not null,
  credential_digest     text not null unique check (credential_digest ~ '^[0-9a-f]{64}$'),
  credential_rotated_at timestamptz not null default now(),
  credential_expires_at timestamptz not null,
  tier_ceiling          smallint not null check (tier_ceiling between 1 and 4),
  status                text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  created_by            uuid not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  revoked_at            timestamptz,
  revoked_by            uuid,
  check (credential_expires_at > credential_rotated_at and credential_expires_at <= credential_rotated_at + interval '90 days'),
  check ((status = 'revoked') = (revoked_at is not null and revoked_by is not null))
);
comment on table action_gateway.service_principals is 'Action Gateway SERVICE principals: one administratively managed integration credential (lcsvc_..., HMAC-SHA256 digest only) acting for its registered delegate agents. Owner-written; the gateway role reads it only through action_gateway_service_principal(digest, acting agent).';

create table action_gateway.service_delegates (
  service_principal_id text not null references action_gateway.service_principals(service_id),
  agent_principal_id   text not null references action_gateway.agent_principals(agent_id),
  org_id               uuid not null references agent.org(org_id),
  enabled              boolean not null default true,
  created_by           uuid not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  disabled_at          timestamptz,
  disabled_by          uuid,
  -- the acting agent's PUBLIC Ed25519 key (raw 32 bytes, base64url): every call through the service carries the agent's
  -- signature over that exact call (X-LC-Acting-Assertion); the header naming the agent is never trusted on its own
  assertion_key        text not null check (assertion_key ~ '^[A-Za-z0-9_-]{43}$'),
  key_rotated_at       timestamptz,
  key_rotated_by       uuid,
  primary key (service_principal_id, agent_principal_id),
  check ((key_rotated_at is null) = (key_rotated_by is null)),
  check (enabled = (disabled_at is null)),
  check ((disabled_at is null) = (disabled_by is null))
);
create index service_delegates_agent_idx on action_gateway.service_delegates (agent_principal_id);
comment on table action_gateway.service_delegates is 'Action Gateway service delegates: which existing agent principals a service principal may act for. The acting agent''s OWN grants, scopes, tenant, leases and ownership rules apply; the effective tier is min(agent, service). Owner-written; disabled, never deleted.';

-- the service principal: written by an org OWNER only; sponsor a named operator; immutable identity; revocation final
create function action_gateway.service_principal_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
begin
  if tg_op = 'DELETE' then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_APPEND_ONLY: service principals are revoked, never deleted'; end if;
  if tg_op = 'UPDATE' and (new.service_id, new.org_id, new.created_by, new.created_at) is distinct from (old.service_id, old.org_id, old.created_by, old.created_at) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_IMMUTABLE: service_id / org_id / created_by are immutable';
  end if;
  if tg_op = 'UPDATE' and old.status = 'revoked' then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_REVOKED: a revoked service principal is final'; end if;
  if tg_op = 'UPDATE' and new.credential_digest is distinct from old.credential_digest and new.credential_rotated_at <= old.credential_rotated_at then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_ROTATION: a new credential needs a new credential_rotated_at';
  end if;
  if exists (select 1 from action_gateway.agent_principals a where a.credential_digest = new.credential_digest) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_CREDENTIAL_REUSED: a service credential is never an agent credential';
  end if;
  if not exists (select 1 from agent.operator_membership m where m.org_id = new.org_id and m.user_id = new.sponsor_user_id) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_SPONSOR: the sponsor must be a named operator of the org';
  end if;
  if not exists (select 1 from agent.operator_membership m where m.org_id = new.org_id and m.user_id = new.created_by and m.role = 'owner') then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_OWNER_ONLY: a service principal is created by an org owner';
  end if;
  if new.revoked_by is not null and not exists (select 1 from agent.operator_membership m where m.org_id = new.org_id and m.user_id = new.revoked_by and m.role = 'owner') then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_OWNER_ONLY: a service principal is revoked by an org owner';
  end if;
  new.updated_at := now();
  return new;
end
$fn$;
create trigger aa_service_principal_guard before insert or update or delete on action_gateway.service_principals for each row execute function action_gateway.service_principal_guard();

-- the delegate registry: owner-written; both principals in the delegate row's org; disabled, never deleted
create function action_gateway.service_delegate_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
begin
  if tg_op = 'DELETE' then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_APPEND_ONLY: a delegate is disabled, never deleted'; end if;
  if tg_op = 'UPDATE' and (new.service_principal_id, new.agent_principal_id, new.org_id, new.created_by, new.created_at)
                           is distinct from (old.service_principal_id, old.agent_principal_id, old.org_id, old.created_by, old.created_at) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_IMMUTABLE: a delegate changes only by enabling or disabling it, or an owner rotating its key';
  end if;
  if tg_op = 'UPDATE' and new.assertion_key is distinct from old.assertion_key then
    if new.key_rotated_by is null or new.key_rotated_at is null or (old.key_rotated_at is not null and new.key_rotated_at <= old.key_rotated_at)
       or not exists (select 1 from agent.operator_membership m where m.org_id = new.org_id and m.user_id = new.key_rotated_by and m.role = 'owner') then
      raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_OWNER_ONLY: a delegate key is rotated by an org owner, with a new key_rotated_at';
    end if;
  end if;
  if not exists (select 1 from action_gateway.service_principals s where s.service_id = new.service_principal_id and s.org_id = new.org_id) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_DELEGATE_ORG: the service principal is not in this org';
  end if;
  if not exists (select 1 from action_gateway.agent_principals a where a.agent_id = new.agent_principal_id and a.org_id = new.org_id) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_DELEGATE_ORG: the agent principal is not in this org';
  end if;
  if tg_op = 'INSERT' and not exists (select 1 from agent.operator_membership m where m.org_id = new.org_id and m.user_id = new.created_by and m.role = 'owner') then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_OWNER_ONLY: a delegate is registered by an org owner';
  end if;
  if new.disabled_by is not null and not exists (select 1 from agent.operator_membership m where m.org_id = new.org_id and m.user_id = new.disabled_by and m.role = 'owner') then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_OWNER_ONLY: a delegate is disabled by an org owner';
  end if;
  new.updated_at := now();
  return new;
end
$fn$;
create trigger aa_service_delegate_guard before insert or update or delete on action_gateway.service_delegates for each row execute function action_gateway.service_delegate_guard();
create trigger aa_no_truncate before truncate on action_gateway.service_principals for each statement execute function action_gateway.append_only_guard();
create trigger aa_no_truncate before truncate on action_gateway.service_delegates for each statement execute function action_gateway.append_only_guard();

-- owners administer them like the agent registry (service_role tooling or the SQL editor); the gateway role never reads them
revoke all on action_gateway.service_principals, action_gateway.service_delegates from public;
grant select, insert, update on action_gateway.service_principals, action_gateway.service_delegates to service_role;
alter table action_gateway.service_principals enable row level security;
alter table action_gateway.service_delegates enable row level security;
alter table action_gateway.service_principals force row level security;
alter table action_gateway.service_delegates force row level security;
create policy service_role_all on action_gateway.service_principals for all to service_role using (true) with check (true);
create policy service_role_all on action_gateway.service_delegates for all to service_role using (true) with check (true);

-- ───────────────────────────────────────────── 3. delegate-only agents, the authorization's service ──
-- an agent acted for only through a service needs no credential of its own (a NULL digest matches nothing)
alter table action_gateway.agent_principals alter column credential_digest drop not null;
comment on column action_gateway.agent_principals.credential_digest is 'HMAC-SHA256 digest of the agent''s own credential; NULL for an agent acted for only through a service principal (action_gateway.service_delegates).';
alter table action_gateway.action_authorizations add column via_service_id text references action_gateway.service_principals(service_id);
comment on column action_gateway.action_authorizations.via_service_id is 'The service principal a delegated authorization came through (set by authorization_guard from the verified delegation, never by the caller). NULL = the agent''s own credential.';

-- ───────────────────────────────────────────── 4. THE AUTHORIZATION GUARD, extended ──
-- #28's body exactly, plus the delegated branch (see the header). The rollback restores #28's body verbatim.
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
  s action_gateway.service_principals%rowtype;
  v_via text := null;
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
  -- OR (service principals link) the digest of an ACTIVE service principal of this org for which the intent's agent is
  -- an ENABLED delegate; the service's ceiling bounds the tier too, and the service is recorded on the row (via_service_id)
  if v_digest is null then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_CREDENTIAL_MISMATCH: the presented agent credential does not match the intent agent';
  end if;
  if p.credential_digest is null or v_digest <> p.credential_digest then
    select * into s from action_gateway.service_principals sp where sp.credential_digest = v_digest and sp.org_id = i.org_id;
    if s.service_id is null then
      raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_CREDENTIAL_MISMATCH: the presented agent credential does not match the intent agent';
    end if;
    if s.status <> 'active' or s.credential_expires_at <= now() then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_SERVICE_INACTIVE'; end if;
    if not exists (select 1 from agent.operator_membership m where m.org_id = s.org_id and m.user_id = s.sponsor_user_id) then
      raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_SERVICE_SPONSOR_NOT_MEMBER';
    end if;
    if not exists (select 1 from action_gateway.service_delegates d where d.service_principal_id = s.service_id and d.agent_principal_id = i.agent_id and d.org_id = i.org_id and d.enabled) then
      raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_DELEGATE_NOT_ENABLED: the intent agent is not an enabled delegate of the presenting service';
    end if;
    if s.tier_ceiling < i.tier then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_TIER_ABOVE_CEILING'; end if;
    v_via := s.service_id;
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
  new.via_service_id := v_via;
  return new;
end
$fn$;

-- ───────────────────────────────────────────── 5. the principal reads ──
-- the agent principal's JSON (the same shape public.action_gateway_principal returns since link #31); internal, not granted
create function action_gateway.agent_principal_json(p action_gateway.agent_principals)
returns jsonb
language sql
stable
set search_path = pg_catalog
as $fn$
  select jsonb_build_object(
    'agent_id', p.agent_id, 'org_id', p.org_id, 'display_name', p.display_name, 'sponsor_user_id', p.sponsor_user_id,
    'tier_ceiling', p.tier_ceiling, 'read_scopes', to_jsonb(p.read_scopes), 'status', p.status, 'credential_expires_at', p.credential_expires_at,
    'sponsor_is_member', exists (select 1 from agent.operator_membership m where m.org_id = p.org_id and m.user_id = p.sponsor_user_id),
    'grants', coalesce((select jsonb_agg(jsonb_build_object('grant_id', g.grant_id, 'capability', g.capability, 'grant_version', g.grant_version, 'max_tier', g.max_tier,
                                                           'scope', g.scope, 'envelope', g.envelope, 'max_uses_per_hour', g.max_uses_per_hour, 'max_uses_per_day', g.max_uses_per_day,
                                                           'max_spend_usd_per_day', g.max_spend_usd_per_day, 'valid_from', g.valid_from, 'expires_at', g.expires_at,
                                                           'suspended_reason', g.suspended_reason, 'standing_seller_facing', g.standing_seller_facing) order by g.capability, g.grant_version)
                          from action_gateway.capability_grants g where g.agent_id = p.agent_id and g.org_id = p.org_id and g.revoked_at is null and g.expires_at > now()), '[]'::jsonb))
$fn$;
revoke all on function action_gateway.agent_principal_json(action_gateway.agent_principals) from public;

-- digest (+ acting agent) -> the service, the delegation state, and the agent's principal only when the delegation is
-- enabled (no enumeration: the role cannot SELECT either registry; an unknown digest answers null)
create function public.action_gateway_service_principal(p_credential_digest text, p_acting_agent text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  v_org uuid := action_gateway.request_org();
  s action_gateway.service_principals%rowtype;
  d action_gateway.service_delegates%rowtype;
  p action_gateway.agent_principals%rowtype;
  v_status text;
  v_agent jsonb := null;
  v_key text := null;
begin
  if v_org is null or p_credential_digest is null or p_credential_digest !~ '^[0-9a-f]{64}$' then return null; end if;
  select * into s from action_gateway.service_principals x where x.credential_digest = p_credential_digest and x.org_id = v_org;
  if s.service_id is null then return null; end if;
  if p_acting_agent is null then
    v_status := 'none';
  elsif p_acting_agent !~ '^agt_[a-z0-9][a-z0-9_]{2,40}$' then
    v_status := 'unknown_agent';
  else
    select * into p from action_gateway.agent_principals a where a.agent_id = p_acting_agent and a.org_id = v_org;
    if p.agent_id is null then
      v_status := 'unknown_agent';
    else
      select * into d from action_gateway.service_delegates x where x.service_principal_id = s.service_id and x.agent_principal_id = p.agent_id and x.org_id = v_org;
      if d.service_principal_id is null then v_status := 'not_delegated';
      elsif not d.enabled then v_status := 'delegate_disabled';
      else v_status := 'ok'; v_agent := action_gateway.agent_principal_json(p); v_key := d.assertion_key;
      end if;
    end if;
  end if;
  return jsonb_build_object(
    'service', jsonb_build_object('service_id', s.service_id, 'org_id', s.org_id, 'display_name', s.display_name, 'sponsor_user_id', s.sponsor_user_id,
      'tier_ceiling', s.tier_ceiling, 'status', s.status, 'credential_expires_at', s.credential_expires_at,
      'sponsor_is_member', exists (select 1 from agent.operator_membership m where m.org_id = s.org_id and m.user_id = s.sponsor_user_id),
      'delegates', coalesce((select jsonb_agg(x.agent_principal_id order by x.agent_principal_id) from action_gateway.service_delegates x
                              where x.service_principal_id = s.service_id and x.org_id = v_org and x.enabled), '[]'::jsonb)),
    'acting_status', v_status,
    'agent', v_agent,
    'assertion_key', v_key);
end
$fn$;
comment on function public.action_gateway_service_principal(text, text) is 'Action Gateway: a service credential digest (+ the X-LC-Acting-Agent id) -> the service principal, the delegation state, and the acting agent''s own principal only when its delegation is enabled.';

-- ───────────────────────────────────────────── 6. create_campaign_draft: the ONE writer ──
-- A Campaign Composer DRAFT pinned to the intent's properties (campaign-composer#saveComposerDraft semantics; the pinned
-- clause is Entity Graph's: properties.property_id is_any_of [...]). Status 'draft' always; auto_send_enabled false and
-- auto_reply_mode 'disabled' (createCampaign's own rule); auto_queue_enabled true like every Composer draft (the feeder
-- only feeds active / activating / live_limited campaigns, so a draft is inert). No targets, schedule, queue row or send.
create function public.action_gateway_dw_campaign_draft(p_intent_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare
  b jsonb; i action_gateway.action_intents%rowtype; p jsonb; v_key text; v_id uuid; v_status text; v_ids text[]; v_filters jsonb; v_meta jsonb;
  v_created boolean := false; v_via text; v_pinned integer;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['create_campaign_draft']);
  if b ? 'refused' then return b -> 'outcome'; end if;
  i := jsonb_populate_record(null::action_gateway.action_intents, b -> 'intent');
  begin
    p := i.params;
    if coalesce(p ->> 'status', '') <> 'draft' then return action_gateway.finish_intent(i.intent_id, 'refused', 'DRAFT_ONLY', '{}'::jsonb); end if;
    select coalesce(array_agg(action_gateway.decode_property_ref(x.ref) order by x.ord), '{}'::text[]) into v_ids
      from jsonb_array_elements_text(coalesce(p -> 'property_refs', '[]'::jsonb)) with ordinality as x(ref, ord);
    v_pinned := coalesce(array_length(v_ids, 1), 0);
    if v_pinned = 0 then return action_gateway.finish_intent(i.intent_id, 'refused', 'AUDIENCE_REQUIRED', '{}'::jsonb); end if;
    if v_pinned > 200 then return action_gateway.finish_intent(i.intent_id, 'refused', 'AUDIENCE_TOO_LARGE', '{}'::jsonb); end if;
    -- exactly once per intent: a re-execution (recovery) finds the draft this intent already made
    v_key := 'gateway:' || substr(i.idempotency_key, 1, 32);
    select c.id, lower(btrim(coalesce(c.status, ''))) into v_id, v_status from public.campaigns c where c.metadata ->> 'composer_key' = v_key order by c.created_at limit 1;
    if v_id is null then
      if exists (select 1 from unnest(v_ids) x(id) where not exists (select 1 from public.properties pr where pr.property_id = x.id)) then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'PROPERTY_NOT_FOUND', jsonb_build_object('pinned_properties', v_pinned));
      end if;
      select a.via_service_id into v_via from action_gateway.action_authorizations a where a.intent_id = i.intent_id;
      v_filters := jsonb_build_object('catalog_version', 'locked_approved_campaign_fields_v1', 'filter_mode', 'grouped_source_of_truth_domains',
        'properties', jsonb_build_array(jsonb_build_object('field_key', 'properties.property_id', 'operator', 'is_any_of', 'value', to_jsonb(v_ids))));
      v_meta := jsonb_strip_nulls(jsonb_build_object(
        'composer_key', v_key, 'target_filters', v_filters, 'template_use_case', p ->> 'template_use_case', 'stage_code', p ->> 'stage_code',
        'campaign_type', 'outbound_sms', 'composer_campaign_size', p ->> 'campaign_size',
        'composer_source', jsonb_build_object('kind', 'action_gateway', 'action', 'create_campaign_draft', 'agent_id', i.agent_id, 'intent_id', i.intent_id, 'via_service_id', v_via)));
      insert into public.campaigns (name, status, objective, daily_cap, total_cap, auto_queue_enabled, auto_send_enabled, auto_reply_mode, metadata)
      values (p ->> 'name', 'draft', p ->> 'template_use_case', (p ->> 'daily_cap')::integer, case when p ->> 'campaign_size' = 'all' then null else (p ->> 'total_cap')::integer end,
              true, false, 'disabled', v_meta)
      returning id into v_id;
      insert into public.campaign_filters (campaign_id, filter_type, field, operator, value, label)
      values (v_id, 'properties', 'properties.property_id', 'is_any_of', to_jsonb(v_ids), 'property id');
      insert into public.campaign_events (campaign_id, event_type, severity, title, metadata)
      values (v_id, 'campaign.created', 'success', 'Campaign draft saved',
              jsonb_build_object('source', 'action_gateway', 'agent_id', i.agent_id, 'intent_id', i.intent_id, 'via_service_id', v_via, 'pinned_properties', v_pinned));
      v_created := true;
      v_status := 'draft';
    end if;
    return action_gateway.finish_intent(i.intent_id, 'succeeded', case when v_created then 'CAMPAIGN_DRAFT_CREATED' else 'CAMPAIGN_DRAFT_EXISTS' end,
      jsonb_build_object('campaign_id', v_id, 'status', v_status, 'created', v_created, 'pinned_properties', v_pinned,
                         'template_use_case', p ->> 'template_use_case', 'stage_code', p ->> 'stage_code', 'launch', 'human_only'));
  exception when others then
    return action_gateway.finish_intent(i.intent_id, 'failed', 'DOMAIN_WRITE_FAILED', jsonb_build_object('sqlstate', sqlstate));
  end;
end
$fn$;
comment on function public.action_gateway_dw_campaign_draft(uuid, uuid) is 'Action Gateway: the ONE lease-bound writer of create_campaign_draft. A Campaign Composer draft (status draft, pinned properties); never builds, schedules, queues, launches or sends.';

-- ───────────────────────────────────────────── 7. privileges + registration ──
revoke all on function action_gateway.service_principal_guard(), action_gateway.service_delegate_guard() from public;
revoke all on function public.action_gateway_service_principal(text, text), public.action_gateway_dw_campaign_draft(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.action_gateway_service_principal(text, text), public.action_gateway_dw_campaign_draft(uuid, uuid) to lc_action_gateway;

insert into action_gateway.extensions (kind, name, link, basis) values
  ('definer_function', 'public.action_gateway_service_principal(text,text)', 'PROPOSED_20261105120000_action_gateway_service_principals', null),
  ('definer_function', 'public.action_gateway_dw_campaign_draft(uuid,uuid)', 'PROPOSED_20261105120000_action_gateway_service_principals', null),
  ('domain_write_action', 'create_campaign_draft', 'PROPOSED_20261105120000_action_gateway_service_principals', null);

-- ───────────────────────────────────────────── 8. the apply refuses unless the role is exactly this ──
do $$
declare v jsonb;
begin
  v := action_gateway.self_check('lc_action_gateway');
  if not coalesce((v ->> 'ok')::boolean, false) then
    raise exception 'action_gateway_service_principals: self-check refused the role: %', v -> 'findings';
  end if;
  if has_table_privilege('lc_action_gateway', 'action_gateway.service_principals', 'SELECT') or has_table_privilege('lc_action_gateway', 'action_gateway.service_delegates', 'SELECT') then
    raise exception 'postcondition: the gateway role can read the service registry';
  end if;
  if pg_get_functiondef('action_gateway.authorization_guard()'::regprocedure) !~ 'envelope_ref_refusal' or pg_get_functiondef('action_gateway.authorization_guard()'::regprocedure) !~ 'DELEGATE_NOT_ENABLED' then
    raise exception 'postcondition: authorization_guard lost a branch';
  end if;
end $$;

notify pgrst, 'reload schema';
