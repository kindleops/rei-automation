-- =============================================================================
-- LeadCommand ACTION GATEWAY, phase 1: the durable action schema and the scoped
-- execution role lc_action_gateway.
-- STATUS: PROPOSED. NOT APPLIED. Owner approval required; applied on its own.
-- OPTIONAL link #26 of the rc-8.5.21 chain, AFTER the read-only MCP link #25.
-- Test (disposable PostgreSQL 17 ONLY, never production):
--   node scripts/db/run-migration-test.mjs --pg-bin <pg17 bin dir> --id action_gateway
-- Rollback: PROPOSED_20261019160000_action_gateway_rollback.sql (drops exactly what this
--   creates; REFUSES while any action intent is still pending).
-- Design: docs/ACTION-MCP.md
-- =============================================================================
--
-- Owner directive 2026-10-19: "AGNTEI THINKS, COORDINATES AND ACTS. LEADCOMMAND ENFORCES
-- AUTHORITY AND EXECUTES." Every agent mutation flows through ONE execution service
-- (apps/api/src/lib/domain/action-gateway). This file is that service's durable half.
--
-- WHAT IT CREATES (schema action_gateway; everything is born OFF)
--   agent_principals       the agent identity registry: agent id, org, accountable human
--                          sponsor (a named operator), HMAC digest of the agent credential,
--                          tier ceiling, read scopes, status, credential expiry. OWNER-WRITTEN
--                          ONLY: the gateway role cannot read or write it directly.
--   capability_grants      which capability an agent holds, up to which tier, until when;
--                          granted and revoked by an org OWNER. Owner-written only.
--   action_intents         one durable intent per (org, idempotency key): agent, action,
--                          resource, validated params + their hash, state, attempts, the
--                          execution lease. Unique idempotency key; at most ONE executing
--                          intent per resource.
--   action_authorizations  immutable: who (agent + sponsor), which grant, which tier, which
--                          policy (id + version), which approval record (single use: unique).
--                          A SECURITY DEFINER trigger re-verifies every fact before the row
--                          exists: the presented agent credential digest, the principal, the
--                          grant, the tier ceiling, the global / tier / capability kill
--                          switches and, when one is required, a human approval record.
--   action_outcomes        immutable: the one final outcome of an intent.
--   action_audit_events    append-only trail of every decision (refusals included).
-- The intent state machine, immutability and append-only rules are DB triggers, so a code
-- path that skips the JS gateway is still refused at the row.
--
-- ROLE lc_action_gateway: NOLOGIN NOINHERIT, no SUPERUSER / CREATEDB / CREATEROLE /
--   REPLICATION / BYPASSRLS, member of no role, granted to authenticator (PostgREST switches
--   to it from a JWT the OWNER mints: { role: "lc_action_gateway", lc_org: <org uuid> }).
--   The JWT's lc_org claim is the tenant: every RLS policy below reads it.
--   It can:
--     * EXECUTE the gateway's own SECURITY INVOKER entry points public.action_gateway_*;
--     * INSERT intents / authorizations / outcomes / audit events and UPDATE the intent
--       lifecycle columns (state, attempt, lease, approval link, result code), org-scoped;
--     * EXECUTE four SECURITY DEFINER functions, each bound to a live execution lease of a
--       DB-authorized intent and each reading its parameters FROM the intent (never from
--       the caller): action_gateway_dw_thread_hold_set (public.automation_holds, SET only),
--       action_gateway_dw_operator_task (agent.ops_work_item scope 'agent'),
--       action_gateway_dw_runtime_enqueue (agent.runtime_enqueue, two read-only research
--       kinds) and action_gateway_principal (credential digest → principal; no enumeration);
--     * EXECUTE the existing agent.capability_approval_insert (through the invoker wrapper,
--       which only files approvals for this gateway's own intents) and agent.ops_pipeline_facts
--       (the report-only reconciliation read), and public.action_gateway_reply_policy (the ONE AI reply
--       policy row the draft gate reads; the table itself stays service-role only);
--     * SELECT the read inventory below (drafting, the conversation-context read, resource
--       resolution) and a KEY-ALLOWLISTED view of public.system_control (RLS policy).
--   It can NOT: write any public.* or agent.* table directly, read agent_principals /
--   capability_grants, release a hold, write system_control, reach any network-egress
--   function outside the pinned Supabase pg_net platform exception (docs/SUPABASE-PG-NET-POSTURE.md).
--   The self-check at the end refuses the apply otherwise.
--
-- CONTROLS (public.system_control; absent ⇒ OFF):
--   action_gateway_enabled              'true' or every action is refused (GLOBAL EMERGENCY STOP)
--   action_gateway_tiers                comma list of enabled tiers (T1,T2,T3,T4); absent ⇒ none
--   action_gateway_killed_capabilities  comma list of capabilities killed
-- The JS gateway reads them per call; the authorization trigger and every domain-write
-- function re-read them, so an emergency stop also refuses an intent already authorized.
--
-- ALSO (agent.ops_work_item, PROPOSED_20261016140000 + #24): scope 'agent' and kind 'agent_task'
--   are added to the two CHECKs (agent-created operator tasks appear in the Action Center
--   with every existing operator decision path). The rollback REFUSES while any agent-scope
--   item exists, and restores both CHECKs exactly.
--
-- WHAT MAKES THE APPLY ABORT (atomically): a missing prerequisite (the R2 runtime, the
--   capability approvals, operations + #24, the P0 hold registry, the read inventory,
--   authenticator); public.system_control without RLS (the key allowlist would be void);
--   schema action_gateway already present; lc_action_gateway existing with any privileged
--   attribute; and ANY finding of action_gateway.self_check('lc_action_gateway'), including a
--   reachable network-egress function. PRODUCTION: PUBLIC can reach pg_net in schema net and, per
--   Supabase, that is platform-managed (owner supabase_admin; a per-project revoke is unsupported and
--   removing the PUBLIC table grants breaks pg_net / pg_cron). The self-check therefore carries ONE
--   pinned platform exception (action_gateway.platform_egress_exceptions, fingerprint
--   supabase_pg_net_default_acl.v1): the net objects are excepted only when every net object is owned
--   by supabase_admin and a member of extension pg_net, every ACL entry comes from supabase_admin and
--   lies inside the documented default fingerprint, AND the compensating controls hold (role NOLOGIN /
--   NOINHERIT / no BYPASSRLS / no membership; net, extensions, cron absent from authenticator's
--   pgrst.db_schemas; the role's search_path set below without them; CREATE nowhere; the egress rule as
--   strict as before for every other function). The Action MCP boot adds the live PostgREST / GraphQL
--   exposure probe. Any deviation: the same findings as without the exception, and the apply refuses.
--   The report lists the exception apart from the findings (platform_exceptions). Design + owner
--   verification: docs/SUPABASE-PG-NET-POSTURE.md.
-- LOCKS: ALTER TABLE agent.ops_work_item (constraint swap) and CREATE POLICY on each read
--   inventory table take brief ACCESS EXCLUSIVE locks; lock_timeout 5s fails the apply whole.

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ───────────────────────────────────────────── 1. prerequisites + role ──────
do $$
declare
  t text; missing text[] := '{}';
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    raise exception 'action_gateway: role authenticator (PostgREST) is missing; this is not a Supabase database';
  end if;
  if to_regnamespace('action_gateway') is not null then
    raise exception 'action_gateway: schema action_gateway already exists (already applied?)';
  end if;
  foreach t in array array['agent.org','agent.operator_membership','agent.approval_request','agent.research_job','agent.ops_work_item','agent.runtime_limits','public.conversation_ai_reply_policy'] loop
    if to_regclass(t) is null then missing := missing || t; end if;
  end loop;
  foreach t in array array['agent.payload_is_clean(jsonb)','agent.capability_approval_insert(jsonb)',
      'agent.runtime_enqueue(text,text,jsonb,text,integer,integer,numeric,boolean,timestamp with time zone)',
      'agent.ops_pipeline_facts(uuid,integer)','agent.ops_scope_of_kind(text)','agent.runtime_is_named_operator(text)',
      'public.automation_hold_for(text,uuid,text,uuid,text,text)'] loop
    if to_regprocedure(t) is null then missing := missing || t; end if;
  end loop;
  if array_length(missing, 1) > 0 then raise exception 'action_gateway: missing prerequisite(s): %', array_to_string(missing, ', '); end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inbox_thread_state' and column_name = 'id' and data_type = 'uuid')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inbox_thread_state' and column_name = 'thread_key') then
    raise exception 'action_gateway: public.inbox_thread_state needs id uuid + thread_key (the thread reference is its id)';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and column_name = 'market' and table_name in ('inbox_thread_state', 'properties', 'acquisition_opportunities')) <> 3 then
    raise exception 'action_gateway: the market columns of inbox_thread_state / properties / acquisition_opportunities (standing-grant scope facts) are missing';
  end if;
  if agent.ops_scope_of_kind('conversation.turn') is distinct from 'conversation' then
    raise exception 'action_gateway: PROPOSED_20261017122000_conversation_turn_operator_items (#24) must be applied first';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'agent.ops_work_item'::regclass and conname = 'ops_work_item_scope_check')
     or not exists (select 1 from pg_constraint where conrelid = 'agent.ops_work_item'::regclass and conname = 'ops_work_item_kind_check') then
    raise exception 'action_gateway: agent.ops_work_item scope / kind CHECKs missing';
  end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.system_control'::regclass) then
    raise exception 'action_gateway: public.system_control has no row level security; the key allowlist policy would expose every key. Enable RLS first (production: operator lockdown 20261003130000)';
  end if;
  if exists (select 1 from pg_roles where rolname = 'lc_action_gateway'
              and (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) then
    raise exception 'action_gateway: role lc_action_gateway already exists with privileged attributes; refusing to reuse it';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'lc_action_gateway') then
    -- defaults: NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    create role lc_action_gateway nologin noinherit;
  end if;
end $$;

comment on role lc_action_gateway is 'LeadCommand Action Gateway: PostgREST-only (JWT role claim + lc_org), executes ONLY the gateway entry points. See supabase/migrations/PROPOSED_20261019160000_action_gateway.sql';
alter role lc_action_gateway set statement_timeout = '10s';
-- compensating control (d) of the Supabase pg_net platform exception (docs/SUPABASE-PG-NET-POSTURE.md): the role's
-- own search_path never names net / extensions / cron, so pg_graphql (which reflects the schemas on the role's
-- search_path) never reflects them; the self-check verifies this setting
alter role lc_action_gateway set search_path = public;
grant lc_action_gateway to authenticator;

create schema action_gateway;
comment on schema action_gateway is 'LeadCommand Action Gateway (phase 1): agent principals, capability grants, action intents, authorizations, outcomes, audit. PROPOSED_20261019160000_action_gateway.sql';
revoke all on schema action_gateway from public;

-- THE read inventory (public relations the role may SELECT): one definition, used by the precondition,
-- the grants and the self-check. Code-derived: the canonical conversation loaders (drafting and the
-- conversation-context read) and the gateway's resource resolution. A test pins the list.
create function action_gateway.read_inventory()
returns text[]
language sql
immutable
parallel safe
set search_path = pg_catalog
as $fn$
  -- lc-action-inventory:relations
  select array['acquisition_opportunities','automation_holds','automation_suppressions','campaigns','contact_property_resolution',
               'inbox_thread_state','message_events','phones','properties','prospects','seller_offers',
               'send_queue','sms_suppression_list','system_control']::text[]
$fn$;

do $$
declare t text; missing text[] := '{}';
begin
  foreach t in array action_gateway.read_inventory() loop
    if to_regclass(format('public.%I', t)) is null then missing := missing || ('public.' || t); end if;
  end loop;
  if array_length(missing, 1) > 0 then raise exception 'action_gateway: missing read-inventory relation(s): %', array_to_string(missing, ', '); end if;
end $$;

-- ───────────────────────────────────────────── 2. helpers ───────────────────
-- the tenant: the lc_org claim of the PostgREST JWT (or the per-claim GUC); null ⇒ nothing is visible
create function action_gateway.request_org()
returns uuid
language sql
stable
set search_path = pg_catalog
as $fn$
  select case when v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v::uuid end
    from (select lower(coalesce(nullif(current_setting('request.jwt.claim.lc_org', true), ''),
                                case when coalesce(current_setting('request.jwt.claims', true), '') ~ '^\s*\{'
                                     then current_setting('request.jwt.claims', true)::jsonb ->> 'lc_org' end, '')) v) s
$fn$;
comment on function action_gateway.request_org() is 'Action Gateway tenant: the lc_org claim of the request JWT. Every RLS policy of the gateway tables reads it.';

create function action_gateway.tier_label(p smallint)
returns text language sql immutable parallel safe set search_path = pg_catalog
as $fn$ select 'T' || p::text $fn$;

-- the kill switches: null = allowed; else the refusal code. Absent keys are OFF (born OFF).
create function action_gateway.control_refusal(p_capability text, p_tier smallint)
returns text
language sql
stable
set search_path = pg_catalog
as $fn$
  select case
    when coalesce((select lower(btrim(value)) from public.system_control where key = 'action_gateway_enabled'), '') <> 'true' then 'ACTION_GATEWAY_STOPPED'
    when not (('T' || p_tier::text) = any (string_to_array(regexp_replace(upper(coalesce((select value from public.system_control where key = 'action_gateway_tiers'), '')), '\s', '', 'g'), ','))) then 'TIER_DISABLED'
    when p_capability = any (string_to_array(regexp_replace(lower(coalesce((select value from public.system_control where key = 'action_gateway_killed_capabilities'), '')), '\s', '', 'g'), ',')) then 'CAPABILITY_KILLED'
    else null end
$fn$;
comment on function action_gateway.control_refusal(text, smallint) is 'Action Gateway kill switches (system_control, absent = OFF): action_gateway_enabled, action_gateway_tiers, action_gateway_killed_capabilities.';

create function action_gateway.intent_transition_ok(p_from text, p_to text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $fn$
  -- mirrored by INTENT_TRANSITIONS in apps/api/src/lib/domain/action-gateway/constants.js
  select coalesce(case p_from
    when 'received'          then p_to in ('awaiting_approval', 'authorized', 'refused')
    when 'awaiting_approval' then p_to in ('authorized', 'refused', 'expired')
    when 'authorized'        then p_to in ('executing', 'refused')
    when 'executing'         then p_to in ('succeeded', 'failed', 'refused', 'outcome_unknown')
    else false end, false)
$fn$;

create function action_gateway.is_terminal(p_state text)
returns boolean language sql immutable parallel safe set search_path = pg_catalog
as $fn$ select p_state in ('succeeded', 'failed', 'refused', 'expired', 'outcome_unknown') $fn$;

-- ───────────────────────────────────────────── 3. tables ────────────────────
create table action_gateway.agent_principals (
  agent_id              text primary key check (agent_id ~ '^agt_[a-z0-9][a-z0-9_]{2,40}$'),
  org_id                uuid not null references agent.org(org_id),
  display_name          text not null check (length(display_name) between 1 and 80 and display_name ~ '^[A-Za-z0-9 ._()-]+$'),
  sponsor_user_id       uuid not null,
  credential_digest     text not null unique check (credential_digest ~ '^[0-9a-f]{64}$'),
  credential_rotated_at timestamptz not null default now(),
  credential_expires_at timestamptz not null,
  tier_ceiling          smallint not null check (tier_ceiling between 1 and 4),
  read_scopes           text[] not null default '{}'::text[] check (read_scopes <@ array['conversation_context.read']::text[]),
  status                text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  created_by            uuid not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  revoked_at            timestamptz,
  revoked_by            uuid,
  check (credential_expires_at > credential_rotated_at and credential_expires_at <= credential_rotated_at + interval '90 days'),
  check ((status = 'revoked') = (revoked_at is not null and revoked_by is not null))
);
comment on table action_gateway.agent_principals is 'Action Gateway agent identity registry. One row per agent credential (HMAC-SHA256 digest only). Owner-written; the gateway role reads it only through action_gateway_principal(digest).';

-- STANDING GRANTS (owner addition 2026-10-19: "reusable, bounded agent authority so approved internal operations
-- can run autonomously without repetitive human approval"): an operator-approved, VERSIONED grant per agent ×
-- capability × scope. Bounds: a resource scope (the org; markets; campaigns; resource types), use caps per hour
-- and per day, a daily spend cap, an allowed-argument envelope, a validity window, revocation. Every use is
-- checked against it in the database (the grant row is locked per authorization, so concurrent uses cannot race
-- past a cap) and recorded (action_authorizations.grant_id + spend_usd; action_gateway.grant_events). Anomalies
-- (cap hits, failures per hour) SUSPEND it automatically; only an owner reinstates. A standing grant alone
-- authorizes T1, and T2 only for the reversible actions listed in action_gateway.standing_t2_actions(); T3 / T4
-- ALWAYS need their own production activation plus a per-use approval / envelope as well.
create table action_gateway.capability_grants (
  grant_id              uuid primary key default gen_random_uuid(),
  org_id                uuid not null references agent.org(org_id),
  agent_id              text not null references action_gateway.agent_principals(agent_id),
  capability            text not null check (capability ~ '^[a-z][a-z_]{1,30}\.[a-z][a-z0-9_]{1,40}$'),
  grant_version         integer not null default 1 check (grant_version between 1 and 10000),
  supersedes_grant_id   uuid references action_gateway.capability_grants(grant_id),
  max_tier              smallint not null check (max_tier between 1 and 4),
  -- {markets: [text], campaign_ids: [uuid], resource_types: [text]}; an absent key = no restriction on that axis
  scope                 jsonb not null default '{}'::jsonb check (jsonb_typeof(scope) = 'object' and (scope - array['markets', 'campaign_ids', 'resource_types']) = '{}'::jsonb
                          and octet_length(scope::text) <= 2000 and agent.payload_is_clean(scope)),
  scope_key             text generated always as (md5(scope::text)) stored,
  -- {max: {param: number}, allow: {param: [values]}} over the intent's stored params; outside ⇒ per-use approval
  envelope              jsonb not null default '{}'::jsonb check (jsonb_typeof(envelope) = 'object' and (envelope - array['max', 'allow']) = '{}'::jsonb
                          and octet_length(envelope::text) <= 2000 and agent.payload_is_clean(envelope)),
  max_uses_per_hour     integer not null default 30 check (max_uses_per_hour between 1 and 10000),
  max_uses_per_day      integer not null default 200 check (max_uses_per_day between 1 and 100000),
  max_spend_usd_per_day numeric(10,2) not null default 0 check (max_spend_usd_per_day between 0 and 100),
  max_failures_per_hour integer not null default 5 check (max_failures_per_hour between 1 and 1000),
  max_cap_hits_per_hour integer not null default 5 check (max_cap_hits_per_hour between 1 and 1000),
  granted_by            uuid not null,
  granted_at            timestamptz not null default now(),
  valid_from            timestamptz not null default now(),
  expires_at            timestamptz not null,
  suspended_at          timestamptz,
  suspended_reason      text check (suspended_reason is null or suspended_reason ~ '^[A-Z][A-Z0-9_]{2,60}$'),
  revoked_at            timestamptz,
  revoked_by            uuid,
  check (expires_at > valid_from and expires_at <= granted_at + interval '366 days'),
  check (max_uses_per_hour <= max_uses_per_day),
  check ((suspended_at is null) = (suspended_reason is null)),
  check ((revoked_at is null) = (revoked_by is null))
);
create unique index capability_grants_one_active on action_gateway.capability_grants (org_id, agent_id, capability, scope_key) where revoked_at is null;
comment on table action_gateway.capability_grants is 'Action Gateway STANDING GRANTS: an org owner grants an agent one capability × scope, versioned, bounded (scope, hourly / daily use caps, daily spend cap, argument envelope, validity window), revocable; auto-suspended on anomaly. Owner-written.';

-- the T2 actions a standing grant may authorize without a per-use approval: REVERSIBLE ones only (a reviewed list)
create function action_gateway.standing_t2_actions()
returns text[] language sql immutable parallel safe set search_path = pg_catalog
as $fn$ select array['set_thread_hold']::text[] $fn$;

-- the grant's own trail: cap hits, failures, suspensions (uses are the authorizations themselves)
create table action_gateway.grant_events (
  event_id   bigint generated always as identity primary key,
  org_id     uuid not null references agent.org(org_id),
  grant_id   uuid not null references action_gateway.capability_grants(grant_id),
  at         timestamptz not null default clock_timestamp(),
  event_type text not null check (event_type in ('cap_hit', 'failure', 'suspended')),
  code       text check (code is null or code ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  intent_id  uuid
);
create index grant_events_grant_at_idx on action_gateway.grant_events (grant_id, event_type, at desc);
comment on table action_gateway.grant_events is 'Standing-grant trail (append-only): cap hits, failed uses, automatic suspensions.';

create table action_gateway.action_intents (
  intent_id       uuid primary key default gen_random_uuid(),
  org_id          uuid not null references agent.org(org_id),
  agent_id        text not null references action_gateway.agent_principals(agent_id),
  action          text not null check (action ~ '^[a-z][a-z0-9_]{2,60}$'),
  capability      text not null check (capability ~ '^[a-z][a-z_]{1,30}\.[a-z][a-z0-9_]{1,40}$'),
  tier            smallint not null check (tier between 1 and 4),
  resource_type   text not null check (resource_type in ('thread', 'property', 'opportunity', 'campaign', 'work_item', 'system')),
  resource_id     text not null check (resource_id ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  client_key      text not null check (client_key ~ '^[A-Za-z0-9_.:-]{8,80}$'),
  idempotency_key text not null check (idempotency_key ~ '^[0-9a-f]{64}$'),
  params          jsonb not null check (jsonb_typeof(params) = 'object' and octet_length(params::text) <= 8000 and agent.payload_is_clean(params)),
  params_hash     text not null check (params_hash ~ '^[0-9a-f]{64}$'),
  correlation_id  uuid not null,
  recovery        text not null check (recovery in ('reexecute', 'report_unknown')),
  max_attempts    integer not null default 3 check (max_attempts between 1 and 10),
  state           text not null default 'received' check (state in ('received', 'awaiting_approval', 'authorized', 'executing', 'succeeded', 'failed', 'refused', 'expired', 'outcome_unknown')),
  approval_id     text check (approval_id is null or approval_id ~ '^apr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  attempt         integer not null default 0 check (attempt between 0 and 10),
  lease_owner     text check (lease_owner is null or lease_owner ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  lease_token     uuid,
  lease_until     timestamptz,
  result_code     text check (result_code is null or result_code ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  created_at      timestamptz not null default clock_timestamp(),
  updated_at      timestamptz not null default clock_timestamp(),
  finished_at     timestamptz,
  unique (org_id, idempotency_key),
  check ((state = 'executing') = (lease_token is not null and lease_until is not null and lease_owner is not null)),
  check ((state in ('succeeded', 'failed', 'refused', 'expired', 'outcome_unknown')) = (finished_at is not null)),
  check (state <> 'awaiting_approval' or approval_id is not null)
);
-- at most ONE executing mutation per resource (concurrent agents on the same lead serialize here)
create unique index action_intents_one_executing_per_resource on action_gateway.action_intents (org_id, resource_type, resource_id)
  where state = 'executing' and resource_type <> 'system';
create index action_intents_open_idx on action_gateway.action_intents (org_id, state, updated_at) where state in ('received', 'awaiting_approval', 'authorized', 'executing');
create index action_intents_agent_idx on action_gateway.action_intents (org_id, agent_id, created_at desc);
comment on table action_gateway.action_intents is 'Action Gateway intents: one per (org, idempotency key = agent + action + resource + client key). State machine, immutability and the execution lease are trigger-enforced.';

create table action_gateway.action_authorizations (
  authorization_id  uuid primary key default gen_random_uuid(),
  intent_id         uuid not null unique references action_gateway.action_intents(intent_id),
  org_id            uuid not null references agent.org(org_id),
  agent_id          text not null references action_gateway.agent_principals(agent_id),
  sponsor_user_id   uuid,
  capability        text not null,
  tier              smallint not null check (tier between 1 and 4),
  grant_id          uuid not null references action_gateway.capability_grants(grant_id),
  policy_id         text not null check (policy_id ~ '^[a-z][a-z0-9_.-]{2,80}$'),
  policy_version    text not null check (policy_version ~ '^[a-z0-9][a-z0-9_.-]{0,40}$'),
  approval_required boolean not null default false,
  -- the spend this use takes from the grant's daily spend cap (the intent's own budget_usd; set by the trigger)
  spend_usd         numeric(10,2) not null default 0 check (spend_usd >= 0),
  -- T3 / T4: the operator-authorized envelope / send authorization this use is bound to (NOT accepted in phase 1)
  envelope_ref      text check (envelope_ref is null or envelope_ref ~ '^[a-z][a-z0-9_]{1,30}:[A-Za-z0-9_.:-]{1,80}$'),
  approval_id       text unique check (approval_id is null or approval_id ~ '^apr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  approved_by       uuid,
  evidence          jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 4000 and agent.payload_is_clean(evidence)),
  decided_at        timestamptz not null default clock_timestamp(),
  check (not approval_required or approval_id is not null),
  check (tier <= 2 or approval_id is not null or envelope_ref is not null),
  check ((approval_id is null) = (approved_by is null))
);
comment on table action_gateway.action_authorizations is 'Action Gateway authorizations (immutable): who, which grant / capability / tier, which policy version, which human approval (single use: approval_id is unique). Verified by a definer trigger before the row exists.';

create table action_gateway.action_outcomes (
  outcome_id  uuid primary key default gen_random_uuid(),
  intent_id   uuid not null unique references action_gateway.action_intents(intent_id),
  org_id      uuid not null references agent.org(org_id),
  attempt     integer not null check (attempt between 0 and 10),
  status      text not null check (status in ('succeeded', 'failed', 'refused', 'expired', 'outcome_unknown')),
  code        text not null check (code ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  result      jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 8000 and agent.payload_is_clean(result)),
  recorded_at timestamptz not null default clock_timestamp()
);
comment on table action_gateway.action_outcomes is 'Action Gateway outcomes (immutable): the ONE final outcome of an intent. Ids, codes, counts and hashes only (agent.payload_is_clean).';

create table action_gateway.action_audit_events (
  event_id       bigint generated always as identity primary key,
  org_id         uuid not null references agent.org(org_id),
  at             timestamptz not null default clock_timestamp(),
  event_type     text not null check (event_type ~ '^[a-z][a-z_]{2,40}$'),
  agent_id       text check (agent_id is null or agent_id ~ '^agt_[a-z0-9][a-z0-9_]{2,40}$'),
  intent_id      uuid,
  action         text check (action is null or action ~ '^[a-z][a-z0-9_]{2,60}$'),
  capability     text check (capability is null or length(capability) <= 80),
  tier           smallint check (tier is null or tier between 0 and 4),
  code           text check (code is null or code ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  correlation_id uuid,
  detail         jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 4000 and agent.payload_is_clean(detail))
);
create index action_audit_events_intent_idx on action_gateway.action_audit_events (intent_id, event_id) where intent_id is not null;
create index action_audit_events_org_at_idx on action_gateway.action_audit_events (org_id, at desc);
comment on table action_gateway.action_audit_events is 'Action Gateway audit trail (append-only): every call decision, refusals included. Codes and ids only.';

-- ───────────────────────────────────────────── 4. integrity triggers ────────
create function action_gateway.append_only_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $fn$
begin
  raise exception using errcode = 'P0001', message = format('ACTION_GATEWAY_APPEND_ONLY: %s on action_gateway.%s is refused', tg_op, tg_table_name);
end
$fn$;
create trigger aa_append_only before update or delete on action_gateway.action_outcomes for each row execute function action_gateway.append_only_guard();
create trigger aa_no_truncate before truncate on action_gateway.action_outcomes for each statement execute function action_gateway.append_only_guard();
create trigger aa_append_only before update or delete on action_gateway.action_audit_events for each row execute function action_gateway.append_only_guard();
create trigger aa_no_truncate before truncate on action_gateway.action_audit_events for each statement execute function action_gateway.append_only_guard();
create trigger aa_no_truncate before truncate on action_gateway.action_authorizations for each statement execute function action_gateway.append_only_guard();
create trigger aa_no_truncate before truncate on action_gateway.action_intents for each statement execute function action_gateway.append_only_guard();

-- principals / grants: written by an org OWNER only; sponsor must be a member; immutable identity
create function action_gateway.principal_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
begin
  if tg_op = 'DELETE' then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_APPEND_ONLY: principals are revoked, never deleted'; end if;
  if tg_op = 'UPDATE' and (new.agent_id, new.org_id, new.created_by, new.created_at) is distinct from (old.agent_id, old.org_id, old.created_by, old.created_at) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_IMMUTABLE: agent_id / org_id / created_by are immutable';
  end if;
  if tg_op = 'UPDATE' and old.status = 'revoked' then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_REVOKED: a revoked principal is final'; end if;
  if tg_op = 'UPDATE' and new.credential_digest is distinct from old.credential_digest and new.credential_rotated_at <= old.credential_rotated_at then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_ROTATION: a new credential needs a new credential_rotated_at';
  end if;
  if not exists (select 1 from agent.operator_membership m where m.org_id = new.org_id and m.user_id = new.sponsor_user_id) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_SPONSOR: the sponsor must be a named operator of the org';
  end if;
  if not exists (select 1 from agent.operator_membership m where m.org_id = new.org_id and m.user_id = new.created_by and m.role = 'owner') then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_OWNER_ONLY: a principal is created by an org owner';
  end if;
  if new.revoked_by is not null and not exists (select 1 from agent.operator_membership m where m.org_id = new.org_id and m.user_id = new.revoked_by) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_OWNER_ONLY: revoked_by must be a member';
  end if;
  new.updated_at := now();
  return new;
end
$fn$;
create trigger aa_principal_guard before insert or update or delete on action_gateway.agent_principals for each row execute function action_gateway.principal_guard();

create function action_gateway.grant_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
begin
  if tg_op = 'DELETE' then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_APPEND_ONLY: grants are revoked, never deleted'; end if;
  if tg_op = 'UPDATE' then
    if old.revoked_at is not null then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_REVOKED: a revoked grant is final'; end if;
    -- scope_key is a STORED generated column: not yet computed in a BEFORE trigger (it follows scope, compared here)
    if (to_jsonb(new) - array['revoked_at', 'revoked_by', 'suspended_at', 'suspended_reason', 'scope_key']) is distinct from (to_jsonb(old) - array['revoked_at', 'revoked_by', 'suspended_at', 'suspended_reason', 'scope_key']) then
      raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_IMMUTABLE: a grant changes only by revocation or suspension; a new version is a new grant (supersedes_grant_id)';
    end if;
    if new.revoked_at is not null and (new.revoked_by is null or not exists (select 1 from agent.operator_membership m where m.org_id = new.org_id and m.user_id = new.revoked_by)) then
      raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_OWNER_ONLY: revoked_by must be a member';
    end if;
    return new;
  end if;
  if not exists (select 1 from action_gateway.agent_principals p where p.agent_id = new.agent_id and p.org_id = new.org_id) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_CROSS_ORG: the grant org must be the principal org';
  end if;
  if not exists (select 1 from agent.operator_membership m where m.org_id = new.org_id and m.user_id = new.granted_by and m.role = 'owner') then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_OWNER_ONLY: a capability is granted by an org owner';
  end if;
  if new.supersedes_grant_id is not null and not exists (select 1 from action_gateway.capability_grants g where g.grant_id = new.supersedes_grant_id
       and g.org_id = new.org_id and g.agent_id = new.agent_id and g.capability = new.capability and g.revoked_at is not null and g.grant_version < new.grant_version) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_VERSION: a new version supersedes a REVOKED, lower version of the same agent and capability';
  end if;
  new.suspended_at := null;
  new.suspended_reason := null;
  return new;
end
$fn$;
create trigger aa_grant_guard before insert or update or delete on action_gateway.capability_grants for each row execute function action_gateway.grant_guard();
create trigger aa_append_only before update or delete on action_gateway.grant_events for each row execute function action_gateway.append_only_guard();
create trigger aa_no_truncate before truncate on action_gateway.grant_events for each statement execute function action_gateway.append_only_guard();

-- the scope facts of a resource (market / campaign), read from the authoritative domain rows
create function action_gateway.resource_scope_facts(p_type text, p_id text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select case p_type
    when 'thread' then (select jsonb_build_object('market', t.market) from public.inbox_thread_state t where t.id::text = p_id)
    when 'property' then (select jsonb_build_object('market', p.market) from public.properties p where p.property_id = p_id)
    when 'opportunity' then (select jsonb_build_object('market', coalesce(o.market, (select p.market from public.properties p where p.property_id = o.primary_property_id))) from public.acquisition_opportunities o where o.id::text = p_id)
    when 'campaign' then jsonb_build_object('campaign_id', p_id)
    else '{}'::jsonb end
$fn$;

-- null = the grant's scope covers the resource; else the refusal code
create function action_gateway.grant_scope_refusal(p_scope jsonb, p_type text, p_id text)
returns text
language plpgsql
stable
set search_path = pg_catalog
as $fn$
declare f jsonb;
begin
  if p_scope ? 'resource_types' and not (p_scope -> 'resource_types' ? p_type) then return 'RESOURCE_OUT_OF_GRANT_SCOPE'; end if;
  if p_scope ? 'campaign_ids' and not (p_type = 'campaign' and p_scope -> 'campaign_ids' ? lower(p_id)) then return 'RESOURCE_OUT_OF_GRANT_SCOPE'; end if;
  if p_scope ? 'markets' then
    f := coalesce(action_gateway.resource_scope_facts(p_type, p_id), '{}'::jsonb);
    if f ->> 'market' is null or not exists (select 1 from jsonb_array_elements_text(p_scope -> 'markets') m where lower(m) = lower(f ->> 'market')) then return 'RESOURCE_OUT_OF_GRANT_SCOPE'; end if;
  end if;
  return null;
end
$fn$;

-- null = the params are inside the grant's argument envelope; else the refusal code
create function action_gateway.grant_envelope_refusal(p_envelope jsonb, p_params jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $fn$
declare k text; v jsonb;
begin
  for k, v in select * from jsonb_each(coalesce(p_envelope -> 'max', '{}'::jsonb)) loop
    if p_params ? k and (jsonb_typeof(p_params -> k) <> 'number' or (p_params ->> k)::numeric > (v #>> '{}')::numeric) then return 'ARGUMENT_OUTSIDE_ENVELOPE'; end if;
  end loop;
  for k, v in select * from jsonb_each(coalesce(p_envelope -> 'allow', '{}'::jsonb)) loop
    if p_params ? k and not (v @> jsonb_build_array(p_params -> k)) then return 'ARGUMENT_OUTSIDE_ENVELOPE'; end if;
  end loop;
  return null;
end
$fn$;

-- the whole standing-grant verdict for one authorization (the caller holds the grant row lock): null or a code
create function action_gateway.grant_refusal(g action_gateway.capability_grants, i action_gateway.action_intents, p_has_approval boolean)
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

-- suspend a grant (anomaly): idempotent; recorded in grant_events
create function action_gateway.grant_suspend(p_grant_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
begin
  update action_gateway.capability_grants set suspended_at = clock_timestamp(), suspended_reason = p_reason where grant_id = p_grant_id and suspended_at is null and revoked_at is null;
  if found then
    insert into action_gateway.grant_events (org_id, grant_id, event_type, code) select org_id, grant_id, 'suspended', p_reason from action_gateway.capability_grants where grant_id = p_grant_id;
  end if;
end
$fn$;

-- ADMISSION (called by action_gateway_authorize BEFORE the authorization insert, same transaction): locks the grant
-- row (concurrent uses serialize here), returns the verdict, and RECORDS a cap hit (auto-suspending at the
-- threshold) — a recorded refusal, not an exception, so the trail commits.
create function action_gateway.grant_admit(p_grant_id uuid, p_intent_id uuid, p_approval_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare g action_gateway.capability_grants%rowtype; i action_gateway.action_intents%rowtype; v_code text;
begin
  select * into i from action_gateway.action_intents where intent_id = p_intent_id and org_id = action_gateway.request_org();
  if i.intent_id is null then return jsonb_build_object('ok', false, 'code', 'INTENT_NOT_FOUND'); end if;
  select * into g from action_gateway.capability_grants where grant_id = p_grant_id for update;
  v_code := action_gateway.grant_refusal(g, i, p_approval_id is not null);
  if v_code is null then return jsonb_build_object('ok', true); end if;
  if v_code in ('GRANT_EXHAUSTED_HOURLY', 'GRANT_EXHAUSTED_DAILY', 'GRANT_SPEND_CAP') then
    insert into action_gateway.grant_events (org_id, grant_id, event_type, code, intent_id) values (g.org_id, g.grant_id, 'cap_hit', v_code, i.intent_id);
    if (select count(*) from action_gateway.grant_events e where e.grant_id = g.grant_id and e.event_type = 'cap_hit' and e.at > clock_timestamp() - interval '1 hour') >= g.max_cap_hits_per_hour then
      perform action_gateway.grant_suspend(g.grant_id, 'ANOMALY_CAP_HITS');
    end if;
  end if;
  return jsonb_build_object('ok', false, 'code', v_code);
end
$fn$;

-- a failed / unknown outcome counts against the grant; at the threshold the grant is suspended (error-rate anomaly)
create function action_gateway.grant_note_failure(p_intent_id uuid, p_code text)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare g action_gateway.capability_grants%rowtype;
begin
  select c.* into g from action_gateway.action_authorizations a join action_gateway.capability_grants c on c.grant_id = a.grant_id where a.intent_id = p_intent_id;
  if g.grant_id is null then return; end if;
  insert into action_gateway.grant_events (org_id, grant_id, event_type, code, intent_id) values (g.org_id, g.grant_id, 'failure', p_code, p_intent_id);
  if (select count(*) from action_gateway.grant_events e where e.grant_id = g.grant_id and e.event_type = 'failure' and e.at > clock_timestamp() - interval '1 hour') >= g.max_failures_per_hour then
    perform action_gateway.grant_suspend(g.grant_id, 'ANOMALY_ERROR_RATE');
  end if;
end
$fn$;

-- intents: born received; immutable request; legal transitions; executing ⇔ a live, incremented lease;
-- authorized ⇒ a verified authorization row; terminal ⇒ its outcome row
create function action_gateway.intent_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $fn$
begin
  if tg_op = 'DELETE' then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_APPEND_ONLY: intents are never deleted'; end if;
  if tg_op = 'INSERT' then
    if new.state <> 'received' or new.attempt <> 0 or new.lease_token is not null or new.approval_id is not null or new.finished_at is not null or new.result_code is not null then
      raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_INTENT_BIRTH: an intent is born received, unleased and unapproved';
    end if;
    new.created_at := clock_timestamp();
    new.updated_at := new.created_at;
    return new;
  end if;
  if (new.intent_id, new.org_id, new.agent_id, new.action, new.capability, new.tier, new.resource_type, new.resource_id, new.client_key,
      new.idempotency_key, new.params, new.params_hash, new.correlation_id, new.recovery, new.max_attempts, new.created_at)
     is distinct from
     (old.intent_id, old.org_id, old.agent_id, old.action, old.capability, old.tier, old.resource_type, old.resource_id, old.client_key,
      old.idempotency_key, old.params, old.params_hash, old.correlation_id, old.recovery, old.max_attempts, old.created_at) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_IMMUTABLE: the intent request is immutable';
  end if;
  if old.approval_id is not null and new.approval_id is distinct from old.approval_id then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_IMMUTABLE: the approval link is immutable once set';
  end if;
  if new.state is distinct from old.state then
    if not action_gateway.intent_transition_ok(old.state, new.state) then
      raise exception using errcode = 'P0001', message = format('ACTION_GATEWAY_ILLEGAL_TRANSITION: %s -> %s', old.state, new.state);
    end if;
  elsif not (old.state = 'executing' and new.lease_token is distinct from old.lease_token) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_NO_OP: an intent update must change state or re-claim an expired lease';
  end if;
  if new.state = 'authorized' and not exists (select 1 from action_gateway.action_authorizations a where a.intent_id = new.intent_id) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_UNAUTHORIZED: authorized needs a verified authorization record';
  end if;
  if new.state = 'executing' then
    if new.attempt <> old.attempt + 1 then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_ATTEMPT: a claim increments the attempt'; end if;
    if new.attempt > new.max_attempts then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_ATTEMPTS_EXHAUSTED'; end if;
    if old.state = 'executing' and old.lease_until > clock_timestamp() then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_LEASE_LIVE: the lease is still held'; end if;
    if old.state = 'executing' and old.recovery <> 'reexecute' then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_NOT_REEXECUTABLE'; end if;
  else
    new.lease_token := null;
    new.lease_owner := null;
    new.lease_until := null;
  end if;
  if action_gateway.is_terminal(new.state) then
    if not exists (select 1 from action_gateway.action_outcomes o where o.intent_id = new.intent_id and o.status = new.state) then
      raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_OUTCOME_REQUIRED: a terminal intent needs its recorded outcome';
    end if;
    new.finished_at := clock_timestamp();
  end if;
  new.updated_at := clock_timestamp();
  return new;
end
$fn$;
create trigger aa_intent_guard before insert or update or delete on action_gateway.action_intents for each row execute function action_gateway.intent_guard();

create function action_gateway.outcome_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $fn$
declare v_state text;
begin
  select i.state into v_state from action_gateway.action_intents i where i.intent_id = new.intent_id and i.org_id = new.org_id;
  if v_state is null then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_OUTCOME: unknown intent'; end if;
  if action_gateway.is_terminal(v_state) then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_OUTCOME: the intent already has its outcome'; end if;
  if not action_gateway.intent_transition_ok(v_state, new.status) then
    raise exception using errcode = 'P0001', message = format('ACTION_GATEWAY_OUTCOME: %s is not a legal outcome of a %s intent', new.status, v_state);
  end if;
  new.recorded_at := clock_timestamp();
  return new;
end
$fn$;
create trigger aa_outcome_guard before insert on action_gateway.action_outcomes for each row execute function action_gateway.outcome_guard();

-- the authorization record exists only when every fact is true NOW (definer: membership + the approval record)
create function action_gateway.authorization_guard()
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
create trigger aa_authorization_guard before insert or update or delete on action_gateway.action_authorizations for each row execute function action_gateway.authorization_guard();

-- ───────────────────────────────────────────── 5. agent tasks in the Action Center ──
alter table agent.ops_work_item drop constraint ops_work_item_scope_check;
alter table agent.ops_work_item add constraint ops_work_item_scope_check check (scope in ('recovery', 'action_center', 'pipeline', 'supervisor', 'conversation', 'agent'));
alter table agent.ops_work_item drop constraint ops_work_item_kind_check;
alter table agent.ops_work_item add constraint ops_work_item_kind_check check (kind in ('recovery_research', 'recovery_followup', 'recovery_review', 'lost_conversation', 'pipeline_mismatch', 'remediation', 'escalation', 'agent_task'));

-- ───────────────────────────────────────────── 6. internal helpers (not granted) ──
create function action_gateway.intent_json(i action_gateway.action_intents)
returns jsonb language sql stable set search_path = pg_catalog
as $fn$
  select case when i.intent_id is null then null else jsonb_build_object(
    'intent_id', i.intent_id, 'agent_id', i.agent_id, 'action', i.action, 'capability', i.capability, 'tier', i.tier,
    'resource_type', i.resource_type, 'resource_id', i.resource_id, 'params', i.params, 'params_hash', i.params_hash, 'state', i.state,
    'approval_id', i.approval_id, 'attempt', i.attempt, 'max_attempts', i.max_attempts, 'recovery', i.recovery,
    'lease_until', i.lease_until, 'result_code', i.result_code, 'correlation_id', i.correlation_id,
    'created_at', i.created_at, 'updated_at', i.updated_at, 'finished_at', i.finished_at) end
$fn$;

create function action_gateway.audit(p_org uuid, p_type text, p_agent text, p_intent uuid, p_action text, p_capability text, p_tier smallint, p_code text, p_correlation uuid, p_detail jsonb)
returns void language sql volatile set search_path = pg_catalog
as $fn$
  insert into action_gateway.action_audit_events (org_id, event_type, agent_id, intent_id, action, capability, tier, code, correlation_id, detail)
  values (p_org, p_type, p_agent, p_intent, p_action, p_capability, p_tier, p_code, p_correlation, coalesce(p_detail, '{}'::jsonb))
$fn$;

-- finish an intent: outcome row, terminal state, audit (same transaction)
create function action_gateway.finish_intent(p_intent_id uuid, p_status text, p_code text, p_result jsonb)
returns jsonb language plpgsql volatile set search_path = pg_catalog
as $fn$
declare i action_gateway.action_intents%rowtype;
begin
  select * into i from action_gateway.action_intents where intent_id = p_intent_id for update;
  insert into action_gateway.action_outcomes (intent_id, org_id, attempt, status, code, result)
  values (i.intent_id, i.org_id, i.attempt, p_status, p_code, coalesce(p_result, '{}'::jsonb));
  update action_gateway.action_intents set state = p_status, result_code = p_code where intent_id = i.intent_id returning * into i;
  perform action_gateway.audit(i.org_id, 'intent_' || p_status, i.agent_id, i.intent_id, i.action, i.capability, i.tier, p_code, i.correlation_id,
                               jsonb_build_object('attempt', i.attempt));
  if p_status in ('failed', 'outcome_unknown') then perform action_gateway.grant_note_failure(i.intent_id, p_code); end if;
  return jsonb_build_object('ok', true, 'status', p_status, 'code', p_code, 'result', coalesce(p_result, '{}'::jsonb), 'intent', action_gateway.intent_json(i));
end
$fn$;

-- the grant AT EXECUTION TIME: a revocation / suspension / expiry between authorization and execution refuses it
create function action_gateway.grant_execution_refusal(p_intent_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select case when g.grant_id is null then 'GRANT_INVALID' when g.revoked_at is not null then 'GRANT_REVOKED' when g.suspended_at is not null then 'GRANT_SUSPENDED'
              when g.expires_at <= now() then 'GRANT_EXPIRED' else null end
    from action_gateway.action_authorizations a left join action_gateway.capability_grants g on g.grant_id = a.grant_id
   where a.intent_id = p_intent_id
$fn$;

-- the domain-write prologue: the caller holds the LIVE lease of an AUTHORIZED, EXECUTING intent of
-- one of p_actions, in the request org; the principal and grant are still valid and no kill switch is
-- engaged. A lease violation raises (no state change); a revoked grant / stop / inactive principal
-- finishes the intent as refused (returned as { refused: code }).
create function action_gateway.dw_begin(p_intent_id uuid, p_lease_token uuid, p_actions text[])
returns jsonb language plpgsql volatile set search_path = pg_catalog
as $fn$
declare i action_gateway.action_intents%rowtype; p action_gateway.agent_principals%rowtype; v_code text;
begin
  select * into i from action_gateway.action_intents where intent_id = p_intent_id for update;
  if i.intent_id is null or i.org_id is distinct from action_gateway.request_org() then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_INTENT_NOT_FOUND';
  end if;
  if i.state <> 'executing' or i.lease_token is distinct from p_lease_token or i.lease_until <= clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_LEASE_LOST';
  end if;
  if not (i.action = any (p_actions)) then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_WRONG_EXECUTOR'; end if;
  if not exists (select 1 from action_gateway.action_authorizations a where a.intent_id = i.intent_id) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_UNAUTHORIZED';
  end if;
  select * into p from action_gateway.agent_principals where agent_id = i.agent_id;
  v_code := action_gateway.control_refusal(i.capability, i.tier);
  if v_code is null and (p.status <> 'active' or p.credential_expires_at <= now()) then v_code := 'PRINCIPAL_INACTIVE'; end if;
  if v_code is null then v_code := action_gateway.grant_execution_refusal(i.intent_id); end if;
  if v_code is not null then
    return jsonb_build_object('refused', v_code, 'outcome', action_gateway.finish_intent(i.intent_id, 'refused', v_code, jsonb_build_object('stage', 'execution')));
  end if;
  return jsonb_build_object('intent', to_jsonb(i), 'sponsor_user_id', p.sponsor_user_id);
end
$fn$;

-- ───────────────────────────────────────────── 7. entry points (SECURITY INVOKER) ──
create function public.action_gateway_controls()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $fn$
  select jsonb_build_object(
    'enabled', coalesce((select lower(btrim(value)) from public.system_control where key = 'action_gateway_enabled'), '') = 'true',
    'tiers', coalesce((select value from public.system_control where key = 'action_gateway_tiers'), ''),
    'killed_capabilities', coalesce((select value from public.system_control where key = 'action_gateway_killed_capabilities'), ''),
    'org', action_gateway.request_org(),
    'read_at', clock_timestamp())
$fn$;

create function public.action_gateway_intent_open(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $fn$
declare v action_gateway.action_intents%rowtype; v_ins boolean := false; v_org uuid := action_gateway.request_org();
begin
  if v_org is null then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_NO_TENANT'; end if;
  insert into action_gateway.action_intents (org_id, agent_id, action, capability, tier, resource_type, resource_id, client_key, idempotency_key,
                                             params, params_hash, correlation_id, recovery, max_attempts)
  values (v_org, p ->> 'agent_id', p ->> 'action', p ->> 'capability', (p ->> 'tier')::smallint, p ->> 'resource_type', p ->> 'resource_id',
          p ->> 'client_key', p ->> 'idempotency_key', p -> 'params', p ->> 'params_hash', (p ->> 'correlation_id')::uuid,
          coalesce(p ->> 'recovery', 'reexecute'), coalesce((p ->> 'max_attempts')::int, 3))
  on conflict (org_id, idempotency_key) do nothing
  returning * into v;
  if v.intent_id is not null then
    v_ins := true;
    perform action_gateway.audit(v.org_id, 'intent_opened', v.agent_id, v.intent_id, v.action, v.capability, v.tier, null, v.correlation_id,
                                 jsonb_build_object('resource_type', v.resource_type, 'params_hash', v.params_hash));
  else
    select * into v from action_gateway.action_intents where org_id = v_org and idempotency_key = p ->> 'idempotency_key';
  end if;
  return jsonb_build_object('inserted', v_ins, 'intent', action_gateway.intent_json(v));
end
$fn$;

create function public.action_gateway_intent_get(p_intent_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $fn$
  select jsonb_build_object(
    'intent', action_gateway.intent_json(i),
    'authorization', (select jsonb_build_object('authorization_id', a.authorization_id, 'grant_id', a.grant_id, 'policy_id', a.policy_id, 'policy_version', a.policy_version,
                        'approval_id', a.approval_id, 'approved_by', a.approved_by, 'sponsor_user_id', a.sponsor_user_id, 'decided_at', a.decided_at)
                        from action_gateway.action_authorizations a where a.intent_id = i.intent_id),
    'outcome', (select jsonb_build_object('status', o.status, 'code', o.code, 'result', o.result, 'attempt', o.attempt, 'recorded_at', o.recorded_at)
                  from action_gateway.action_outcomes o where o.intent_id = i.intent_id))
    from action_gateway.action_intents i
   where i.intent_id = p_intent_id and i.org_id = action_gateway.request_org()
$fn$;

create function public.action_gateway_refuse(p_intent_id uuid, p_code text, p_detail jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $fn$
declare i action_gateway.action_intents%rowtype;
begin
  select * into i from action_gateway.action_intents where intent_id = p_intent_id and org_id = action_gateway.request_org() for update;
  if i.intent_id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if i.state not in ('received', 'awaiting_approval', 'authorized') then return jsonb_build_object('ok', false, 'reason', 'not_refusable', 'intent', action_gateway.intent_json(i)); end if;
  return action_gateway.finish_intent(i.intent_id, 'refused', p_code, coalesce(p_detail, '{}'::jsonb));
end
$fn$;

create function public.action_gateway_expire(p_intent_id uuid, p_code text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $fn$
declare i action_gateway.action_intents%rowtype;
begin
  select * into i from action_gateway.action_intents where intent_id = p_intent_id and org_id = action_gateway.request_org() for update;
  if i.intent_id is null or i.state <> 'awaiting_approval' then return jsonb_build_object('ok', false, 'reason', 'not_expirable'); end if;
  return action_gateway.finish_intent(i.intent_id, 'expired', p_code, '{}'::jsonb);
end
$fn$;

create function public.action_gateway_await_approval(p_intent_id uuid, p_approval_id text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $fn$
declare i action_gateway.action_intents%rowtype;
begin
  select * into i from action_gateway.action_intents where intent_id = p_intent_id and org_id = action_gateway.request_org() for update;
  if i.intent_id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if i.state = 'awaiting_approval' and i.approval_id = p_approval_id then return jsonb_build_object('ok', true, 'intent', action_gateway.intent_json(i)); end if;
  if i.state <> 'received' then return jsonb_build_object('ok', false, 'reason', 'not_received', 'intent', action_gateway.intent_json(i)); end if;
  update action_gateway.action_intents set state = 'awaiting_approval', approval_id = p_approval_id where intent_id = i.intent_id returning * into i;
  perform action_gateway.audit(i.org_id, 'approval_requested', i.agent_id, i.intent_id, i.action, i.capability, i.tier, null, i.correlation_id, jsonb_build_object('approval_id', p_approval_id));
  return jsonb_build_object('ok', true, 'intent', action_gateway.intent_json(i));
end
$fn$;

create function public.action_gateway_authorize(p_intent_id uuid, p_credential_digest text, p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $fn$
declare i action_gateway.action_intents%rowtype; v_admit jsonb;
begin
  select * into i from action_gateway.action_intents where intent_id = p_intent_id and org_id = action_gateway.request_org() for update;
  if i.intent_id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  -- idempotent: a concurrent duplicate of the same request finds it authorized, executing or finished
  if i.state in ('authorized', 'executing') or action_gateway.is_terminal(i.state) then
    return jsonb_build_object('ok', true, 'replayed', true, 'intent', action_gateway.intent_json(i));
  end if;
  -- standing-grant ADMISSION: a refusal (exhausted / suspended / expired / out of scope / outside the envelope) is a
  -- recorded refused outcome, and a cap hit is counted against the grant (auto-suspension at the threshold)
  v_admit := action_gateway.grant_admit((p ->> 'grant_id')::uuid, i.intent_id, nullif(p ->> 'approval_id', ''));
  if not coalesce((v_admit ->> 'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'refused', true, 'code', v_admit ->> 'code',
                              'outcome', action_gateway.finish_intent(i.intent_id, 'refused', v_admit ->> 'code', jsonb_build_object('stage', 'grant')));
  end if;
  perform set_config('action_gateway.presented_digest', coalesce(p_credential_digest, ''), true);
  insert into action_gateway.action_authorizations (intent_id, org_id, agent_id, capability, tier, grant_id, policy_id, policy_version, approval_required, approval_id, evidence)
  values (i.intent_id, i.org_id, i.agent_id, i.capability, i.tier, (p ->> 'grant_id')::uuid, p ->> 'policy_id', p ->> 'policy_version',
          coalesce((p ->> 'approval_required')::boolean, false), nullif(p ->> 'approval_id', ''), coalesce(p -> 'evidence', '{}'::jsonb));
  perform set_config('action_gateway.presented_digest', '', true);
  update action_gateway.action_intents set state = 'authorized' where intent_id = i.intent_id returning * into i;
  perform action_gateway.audit(i.org_id, 'authorized', i.agent_id, i.intent_id, i.action, i.capability, i.tier, null, i.correlation_id,
                               jsonb_build_object('policy_id', p ->> 'policy_id', 'policy_version', p ->> 'policy_version', 'approval_id', nullif(p ->> 'approval_id', '')));
  return jsonb_build_object('ok', true, 'replayed', false, 'intent', action_gateway.intent_json(i));
end
$fn$;

create function public.action_gateway_claim(p_intent_id uuid, p_worker text, p_lease_seconds integer)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $fn$
declare
  i action_gateway.action_intents%rowtype;
  v_token uuid := gen_random_uuid();
  v_secs integer := least(greatest(coalesce(p_lease_seconds, 60), 1), 300);
  v_other uuid;
  v_reclaim boolean;
begin
  select * into i from action_gateway.action_intents where intent_id = p_intent_id and org_id = action_gateway.request_org() for update;
  if i.intent_id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if i.state = 'executing' and i.lease_until > clock_timestamp() then return jsonb_build_object('ok', false, 'reason', 'lease_live', 'lease_until', i.lease_until); end if;
  if i.state not in ('authorized', 'executing') then return jsonb_build_object('ok', false, 'reason', 'not_claimable', 'state', i.state); end if;
  if i.state = 'executing' and i.recovery <> 'reexecute' then return jsonb_build_object('ok', false, 'reason', 'not_reexecutable'); end if;
  if i.attempt >= i.max_attempts then return jsonb_build_object('ok', false, 'reason', 'attempts_exhausted'); end if;
  v_reclaim := i.state = 'executing';
  begin
    update action_gateway.action_intents
       set state = 'executing', attempt = attempt + 1, lease_owner = p_worker, lease_token = v_token, lease_until = clock_timestamp() + make_interval(secs => v_secs)
     where intent_id = i.intent_id
    returning * into i;
  exception when unique_violation then
    select o.intent_id into v_other from action_gateway.action_intents o
     where o.org_id = i.org_id and o.resource_type = i.resource_type and o.resource_id = i.resource_id and o.state = 'executing' limit 1;
    return jsonb_build_object('ok', false, 'reason', 'resource_busy', 'holder_intent_id', v_other,
                              'holder_expired', coalesce((select o.lease_until <= clock_timestamp() from action_gateway.action_intents o where o.intent_id = v_other), false));
  end;
  perform action_gateway.audit(i.org_id, case when v_reclaim then 'reclaimed' else 'claimed' end, i.agent_id, i.intent_id, i.action, i.capability, i.tier, null, i.correlation_id,
                               jsonb_build_object('attempt', i.attempt, 'lease_seconds', v_secs));
  return jsonb_build_object('ok', true, 'lease_token', v_token, 'attempt', i.attempt, 'lease_until', i.lease_until, 'reclaimed', v_reclaim);
end
$fn$;

-- completion of an action whose execution is NOT a database domain write (drafts, reports)
create function public.action_gateway_complete(p_intent_id uuid, p_lease_token uuid, p_status text, p_code text, p_result jsonb)
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
  if i.action in ('set_thread_hold', 'create_operator_task', 'update_operator_task', 'create_research_job', 'request_property_valuation') then
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

-- an executing intent whose lease expired and that may not be re-executed (or ran out of attempts):
-- a VISIBLE failure, never a silent retry
create function public.action_gateway_mark_unknown(p_intent_id uuid, p_code text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $fn$
declare i action_gateway.action_intents%rowtype;
begin
  select * into i from action_gateway.action_intents where intent_id = p_intent_id and org_id = action_gateway.request_org() for update;
  if i.intent_id is null or i.state <> 'executing' or i.lease_until > clock_timestamp() then return jsonb_build_object('ok', false, 'reason', 'not_markable'); end if;
  if i.recovery = 'reexecute' and i.attempt < i.max_attempts then return jsonb_build_object('ok', false, 'reason', 'reexecutable'); end if;
  return action_gateway.finish_intent(i.intent_id, 'outcome_unknown', coalesce(p_code, 'LEASE_EXPIRED_OUTCOME_UNKNOWN'), jsonb_build_object('attempt', i.attempt, 'recovery', i.recovery));
end
$fn$;

create function public.action_gateway_recoverable(p_limit integer default 20)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $fn$
  select coalesce(jsonb_agg(action_gateway.intent_json(i) order by i.lease_until), '[]'::jsonb)
    from (select * from action_gateway.action_intents
           where org_id = action_gateway.request_org() and state = 'executing' and lease_until <= clock_timestamp()
           order by lease_until limit least(greatest(coalesce(p_limit, 20), 1), 100)) i
$fn$;

create function public.action_gateway_audit_append(p jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $fn$
declare v_org uuid := action_gateway.request_org();
begin
  if v_org is null then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_NO_TENANT'; end if;
  perform action_gateway.audit(v_org, p ->> 'event_type', nullif(p ->> 'agent_id', ''), nullif(p ->> 'intent_id', '')::uuid, nullif(p ->> 'action', ''),
                               nullif(p ->> 'capability', ''), nullif(p ->> 'tier', '')::smallint, nullif(p ->> 'code', ''), nullif(p ->> 'correlation_id', '')::uuid,
                               coalesce(p -> 'detail', '{}'::jsonb));
end
$fn$;

-- the approval request for ONE of this gateway's intents (the existing operator approval path decides it)
create function public.action_gateway_approval_request(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $fn$
declare i action_gateway.action_intents%rowtype;
begin
  if p ->> 'capability_id' is distinct from 'agent_actions.authorize_action' or (p ->> 'capability_version') is distinct from '1' then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_APPROVAL_CAPABILITY: only agent_actions.authorize_action v1 is filed by the gateway';
  end if;
  select * into i from action_gateway.action_intents where intent_id = (p -> 'target' ->> 'intent_id')::uuid and org_id = action_gateway.request_org();
  if i.intent_id is null or i.state not in ('received', 'awaiting_approval') or (p ->> 'org_id')::uuid is distinct from i.org_id
     or (p -> 'intended_change' ->> 'params_hash') is distinct from i.params_hash or (p -> 'intended_change' ->> 'agent_id') is distinct from i.agent_id then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_APPROVAL_TARGET: the approval must bind an open intent of this org and its exact parameters';
  end if;
  return agent.capability_approval_insert(p);
end
$fn$;

create function public.action_gateway_approval_get(p_approval_id text)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $fn$
  select to_jsonb(a) - 'summary' from agent.approval_request a
   where a.approval_id = p_approval_id and a.org_id = action_gateway.request_org() and a.capability_id = 'agent_actions.authorize_action'
$fn$;

-- report-only reconciliation: the EXISTING operations read (agent.ops_pipeline_facts), nothing written
create function public.action_gateway_pipeline_facts(p_after uuid default null, p_limit integer default 200)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $fn$
  select coalesce(agent.ops_pipeline_facts(p_after, least(greatest(coalesce(p_limit, 200), 1), 500)), '[]'::jsonb)
$fn$;

-- an agent-scope operator task of this org (update_operator_task resolves against it)
create function public.action_gateway_work_item_get(p_work_item_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $fn$
  select jsonb_build_object('work_item_id', w.work_item_id, 'scope', w.scope, 'kind', w.kind, 'state', w.state, 'severity', w.severity, 'priority', w.priority,
                            'subject_type', w.subject_type, 'subject_id', w.subject_id, 'due_at', w.due_at, 'source_job_id', w.source_job_id, 'created_at', w.created_at)
    from agent.ops_work_item w
   where w.work_item_id = p_work_item_id and w.scope = 'agent' and w.org_id = action_gateway.request_org()
$fn$;

-- ───────────────────────────────────────────── 8. principal lookup + domain writes (SECURITY DEFINER) ──
-- digest → principal (no enumeration: the role cannot SELECT agent_principals)
create function public.action_gateway_principal(p_credential_digest text)
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

-- the AI reply policy row (the shadow gate the draft service reads). public.conversation_ai_reply_policy is
-- SERVICE-ROLE ONLY by design (#3: RLS forced, no policies); this STABLE read hands the gateway that ONE row
-- and nothing else, so the table keeps its ACL. Drafting fails closed (kill switch engaged) without it.
create function public.action_gateway_reply_policy()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select to_jsonb(p) from public.conversation_ai_reply_policy p where p.id = 1
$fn$;

-- set_thread_hold (T2, SET only): the ONE hold authority (public.automation_holds). Parameters come
-- from the authorized intent. Idempotent per thread (one active agent hold key); release stays human.
create function public.action_gateway_dw_thread_hold_set(p_intent_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare b jsonb; i action_gateway.action_intents%rowtype; v_thread uuid; v_key text; v_hold uuid; v_existing boolean := false; v_reason text;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['set_thread_hold']);
  if b ? 'refused' then return b -> 'outcome'; end if;
  i := jsonb_populate_record(null::action_gateway.action_intents, b -> 'intent');
  -- a deterministic refusal by the domain (a CHECK, a trigger) is recorded as a FAILED outcome in the same
  -- transaction: the intent never stays executing on an error the database already knows
  begin
    v_thread := (i.params ->> 'thread_id')::uuid;
    v_reason := i.params ->> 'reason_code';
    select t.thread_key into v_key from public.inbox_thread_state t where t.id = v_thread for share;
    if v_key is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'THREAD_NOT_FOUND', '{}'::jsonb); end if;
    insert into public.automation_holds (hold_key, hold_type, thread_key, inbox_thread_id, blocked_capabilities, reason, set_by, approval_ref, metadata)
    values ('agent_hold:' || v_thread::text, 'operator_hold', v_key, v_thread,
            array['offer_acceptance','offer_write','closing_case_create','stage_advance','auto_reply','ai_action','follow_up','campaign','workflow','outbound_send','recovery']::text[],
            'agent_hold:' || v_reason, 'agent:' || i.agent_id, 'action_intent:' || i.intent_id::text,
            jsonb_build_object('source', 'action_gateway', 'intent_id', i.intent_id, 'agent_id', i.agent_id, 'reason_code', v_reason,
                               'note', i.params ->> 'note', 'release', 'an operator releases it in the hold registry (agents cannot release holds)'))
    on conflict (hold_key) where released_at is null do nothing
    returning id into v_hold;
    if v_hold is null then
      select h.id into v_hold from public.automation_holds h where h.hold_key = 'agent_hold:' || v_thread::text and h.released_at is null;
      v_existing := true;
    end if;
    return action_gateway.finish_intent(i.intent_id, 'succeeded', case when v_existing then 'ALREADY_HELD' else 'HOLD_SET' end,
                                        jsonb_build_object('hold_id', v_hold, 'thread_id', v_thread, 'already_held', v_existing, 'reason_code', v_reason));
  exception when others then
    return action_gateway.finish_intent(i.intent_id, 'failed', 'DOMAIN_WRITE_FAILED', jsonb_build_object('sqlstate', sqlstate));
  end;
end
$fn$;

-- create_operator_task / update_operator_task (T1): agent.ops_work_item, scope 'agent' only
create function public.action_gateway_dw_operator_task(p_intent_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare b jsonb; i action_gateway.action_intents%rowtype; w agent.ops_work_item%rowtype; v_id uuid; v_notes jsonb;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['create_operator_task', 'update_operator_task']);
  if b ? 'refused' then return b -> 'outcome'; end if;
  i := jsonb_populate_record(null::action_gateway.action_intents, b -> 'intent');
  -- a deterministic refusal by the domain (a CHECK, a trigger) is recorded as a FAILED outcome in the same
  -- transaction: the intent never stays executing on an error the database already knows
  begin
    if i.action = 'create_operator_task' then
      insert into agent.ops_work_item (org_id, scope, kind, dedupe_key, severity, escalated, title, subject_type, subject_id, detail, priority, due_at, source_job_id)
      values (i.org_id, 'agent', 'agent_task', 'agent:task:' || i.intent_id::text, coalesce(i.params ->> 'severity', 'info'), false, i.params ->> 'title',
              i.params ->> 'subject_type', nullif(i.params ->> 'subject_id', ''),
              jsonb_build_object('source', 'action_gateway', 'agent_id', i.agent_id, 'intent_id', i.intent_id, 'notes', coalesce(i.params -> 'notes', '[]'::jsonb)),
              coalesce((i.params ->> 'priority')::int, 0), (i.params ->> 'due_at')::timestamptz, 'action_intent:' || i.intent_id::text)
      on conflict (org_id, dedupe_key) do nothing
      returning work_item_id into v_id;
      if v_id is null then select work_item_id into v_id from agent.ops_work_item where org_id = i.org_id and dedupe_key = 'agent:task:' || i.intent_id::text; end if;
      return action_gateway.finish_intent(i.intent_id, 'succeeded', 'TASK_CREATED', jsonb_build_object('work_item_id', v_id));
    end if;
    select * into w from agent.ops_work_item where work_item_id = (i.params ->> 'work_item_id')::uuid and org_id = i.org_id and scope = 'agent' for update;
    if w.work_item_id is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'TASK_NOT_FOUND', '{}'::jsonb); end if;
    if w.state not in ('open', 'acknowledged') then return action_gateway.finish_intent(i.intent_id, 'refused', 'TASK_CLOSED', jsonb_build_object('work_item_id', w.work_item_id, 'state', w.state)); end if;
    v_notes := coalesce(w.detail -> 'notes', '[]'::jsonb) || coalesce(i.params -> 'notes', '[]'::jsonb);
    if jsonb_array_length(v_notes) > 20 then v_notes := (select coalesce(jsonb_agg(x order by n), '[]'::jsonb) from jsonb_array_elements(v_notes) with ordinality t(x, n) where n > jsonb_array_length(v_notes) - 20); end if;
    update agent.ops_work_item set
      priority = coalesce((i.params ->> 'priority')::int, priority),
      due_at = case when i.params ? 'due_at' then (i.params ->> 'due_at')::timestamptz else due_at end,
      detail = jsonb_set(detail, '{notes}', v_notes, true),
      state = case when i.params ->> 'state' = 'resolved' then 'resolved' else state end,
      resolved_at = case when i.params ->> 'state' = 'resolved' then clock_timestamp() else resolved_at end,
      resolved_by = case when i.params ->> 'state' = 'resolved' then 'auto:agent_gateway' else resolved_by end,
      last_seen_at = clock_timestamp(), updated_at = clock_timestamp()
     where work_item_id = w.work_item_id;
    return action_gateway.finish_intent(i.intent_id, 'succeeded', 'TASK_UPDATED', jsonb_build_object('work_item_id', w.work_item_id, 'state', coalesce(nullif(i.params ->> 'state', ''), w.state)));
  exception when others then
    return action_gateway.finish_intent(i.intent_id, 'failed', 'DOMAIN_WRITE_FAILED', jsonb_build_object('sqlstate', sqlstate));
  end;
end
$fn$;

-- create_research_job / request_property_valuation (T1): the R2 runtime (agent.runtime_enqueue), ONLY the
-- two read-only research kinds, accountable to the agent's human sponsor, idempotent per intent
create function public.action_gateway_dw_runtime_enqueue(p_intent_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare b jsonb; i action_gateway.action_intents%rowtype; v_kind text; r jsonb; v_input jsonb; v_sponsor text;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['create_research_job', 'request_property_valuation']);
  if b ? 'refused' then return b -> 'outcome'; end if;
  i := jsonb_populate_record(null::action_gateway.action_intents, b -> 'intent');
  -- a deterministic refusal by the domain (a CHECK, a trigger) is recorded as a FAILED outcome in the same
  -- transaction: the intent never stays executing on an error the database already knows
  begin
    v_sponsor := b ->> 'sponsor_user_id';
    v_kind := i.params ->> 'runtime_kind';
    if not ((i.action = 'create_research_job' and v_kind = 'mission.research') or (i.action = 'request_property_valuation' and v_kind = 'property.research')) then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'RUNTIME_KIND_NOT_ALLOWED', '{}'::jsonb);
    end if;
    v_input := coalesce(i.params -> 'runtime_input', '{}'::jsonb) || jsonb_build_object('action_intent_id', i.intent_id, 'requested_via', 'action_gateway');
    r := agent.runtime_enqueue(v_kind, encode(sha256(convert_to('action_gateway:' || i.intent_id::text, 'UTF8')), 'hex'), v_input, v_sponsor,
                               least(greatest(coalesce((i.params ->> 'priority')::int, 100), 1), 1000), 3,
                               least(greatest(coalesce((i.params ->> 'budget_usd')::numeric, 0), 0), 2.5), false, null);
    if coalesce((r ->> 'ok')::boolean, false) is not true then
      return action_gateway.finish_intent(i.intent_id, 'failed', upper(coalesce(r ->> 'reason', 'ENQUEUE_REFUSED')), '{}'::jsonb);
    end if;
    return action_gateway.finish_intent(i.intent_id, 'succeeded', case when coalesce((r ->> 'deduped')::boolean, false) then 'JOB_DEDUPED' else 'JOB_ENQUEUED' end,
                                        jsonb_build_object('job_id', r ->> 'job_id', 'job_state', r ->> 'state', 'deduped', coalesce((r ->> 'deduped')::boolean, false), 'runtime_kind', v_kind));
  exception when others then
    return action_gateway.finish_intent(i.intent_id, 'failed', 'DOMAIN_WRITE_FAILED', jsonb_build_object('sqlstate', sqlstate));
  end;
end
$fn$;

-- ───────────────────────────────────────────── 9. self-check (privilege introspection) ──
-- THE SUPABASE pg_net PLATFORM EXCEPTION (docs/SUPABASE-PG-NET-POSTURE.md). Owner-reviewed 2026-10-22: an
-- explicit, pinned, tested exception with compensating controls, every one of which must hold, or the
-- self-check refuses exactly as before.
--   Supabase: "Revoking access to pg_net objects has no effect"
--   https://supabase.com/docs/guides/troubleshooting/revoking-access-to-pg_net-objects-has-no-effect-0bbc16
--   pg_net is created by supabase_admin, which owns schema net and its objects; postgres cannot revoke, a
--   per-project grant change is unsupported, and removing the PUBLIC table grants breaks pg_net and pg_cron.
-- The exception APPLIES only when ALL of these hold (otherwise status 'not_applied', its reasons are reported,
-- and the net objects count through PUBLIC as before: the same findings as without the exception):
--   * extension pg_net exists, owned by supabase_admin; schema net is owned by supabase_admin;
--   * EVERY object in schema net (relations, functions, types, operators, collations, conversions, operator
--     classes / families, text search objects, statistics) is owned by supabase_admin AND is a member of
--     extension pg_net (pg_depend deptype 'e');
--   * every ACL entry on net (schema, relations, columns, functions, types; a NULL ACL is the PostgreSQL
--     default) comes from grantor supabase_admin, carries no grant option, and is IN the fingerprint below.
-- When it applies, the compensating controls are hard findings (platform_exception_control_*):
--   (a) the role is NOLOGIN, NOINHERIT, not BYPASSRLS, a member of no role;
--   (b) net / extensions / cron are not in authenticator's pgrst.db_schemas role setting (absent: recorded as
--       exposed_schemas_from_dashboard_unverified_in_sql; the server's live probe (c) is then the proof);
--   (c) the server's boot probe (PostgREST Accept-Profile / Content-Profile: net → PGRST106; GraphQL: unknown
--       field) — reported here as live_exposure_probe_required, enforced by the MCP servers;
--   (d) the role's own search_path setting exists and excludes net / extensions / cron;
--   (e) the egress rule stays exactly as strict for every function OUTSIDE the exception (wrappers included);
--   (f) the role holds CREATE nowhere (the existing schema_create / database_create findings).
-- A SECURITY DEFINER function in net is never excepted from the definer rule.
create function action_gateway.platform_egress_exceptions(p_role oid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $fn$
declare
  r oid := p_role;
  pe jsonb;
begin
  -- lc-platform-exception:block-begin (the SAME block is inlined in public.lc_mcp_reader_self_check, #25; a test pins it)
  <<platform_exception>>
  declare
  -- lc-platform-exception:fingerprint-version
  fp_version constant text := 'supabase_pg_net_default_acl.v1';
  -- lc-platform-exception:fingerprint (kind|object|grantee|privilege). REVIEWED CONSTANT: a change is a new
  -- fingerprint version, reviewed by the owner. Sources: the Supabase doc above (PUBLIC: USAGE on net, all
  -- privileges on the net tables and sequences, EXECUTE on net.http_*; USAGE on net also to postgres, anon,
  -- authenticated, service_role); the platform's pg_net access grant (USAGE on net and EXECUTE on the http
  -- entry points to supabase_functions_admin, postgres, anon, authenticated, service_role); the PostgreSQL
  -- default ACL of every other pg_net function (EXECUTE to PUBLIC) and of every type (USAGE to PUBLIC: no data
  -- and no egress privilege, so types are matched by '*').
  fingerprint constant text[] := array[
    'schema|net|PUBLIC|USAGE', 'schema|net|postgres|USAGE', 'schema|net|anon|USAGE', 'schema|net|authenticated|USAGE',
    'schema|net|service_role|USAGE', 'schema|net|supabase_functions_admin|USAGE',
    'table|net.http_request_queue|PUBLIC|SELECT', 'table|net.http_request_queue|PUBLIC|INSERT', 'table|net.http_request_queue|PUBLIC|UPDATE',
    'table|net.http_request_queue|PUBLIC|DELETE', 'table|net.http_request_queue|PUBLIC|TRUNCATE', 'table|net.http_request_queue|PUBLIC|REFERENCES',
    'table|net.http_request_queue|PUBLIC|TRIGGER', 'table|net.http_request_queue|PUBLIC|MAINTAIN',
    'table|net._http_response|PUBLIC|SELECT', 'table|net._http_response|PUBLIC|INSERT', 'table|net._http_response|PUBLIC|UPDATE',
    'table|net._http_response|PUBLIC|DELETE', 'table|net._http_response|PUBLIC|TRUNCATE', 'table|net._http_response|PUBLIC|REFERENCES',
    'table|net._http_response|PUBLIC|TRIGGER', 'table|net._http_response|PUBLIC|MAINTAIN',
    'sequence|net.http_request_queue_id_seq|PUBLIC|USAGE', 'sequence|net.http_request_queue_id_seq|PUBLIC|SELECT', 'sequence|net.http_request_queue_id_seq|PUBLIC|UPDATE',
    'function|net.http_get|PUBLIC|EXECUTE', 'function|net.http_post|PUBLIC|EXECUTE', 'function|net.http_delete|PUBLIC|EXECUTE',
    'function|net.http_get|postgres|EXECUTE', 'function|net.http_get|anon|EXECUTE', 'function|net.http_get|authenticated|EXECUTE',
    'function|net.http_get|service_role|EXECUTE', 'function|net.http_get|supabase_functions_admin|EXECUTE',
    'function|net.http_post|postgres|EXECUTE', 'function|net.http_post|anon|EXECUTE', 'function|net.http_post|authenticated|EXECUTE',
    'function|net.http_post|service_role|EXECUTE', 'function|net.http_post|supabase_functions_admin|EXECUTE',
    'function|net.http_delete|postgres|EXECUTE', 'function|net.http_delete|anon|EXECUTE', 'function|net.http_delete|authenticated|EXECUTE',
    'function|net.http_delete|service_role|EXECUTE', 'function|net.http_delete|supabase_functions_admin|EXECUTE',
    'function|net._await_response|PUBLIC|EXECUTE', 'function|net._urlencode_string|PUBLIC|EXECUTE',
    'function|net._encode_url_with_params_array|PUBLIC|EXECUTE', 'function|net._http_collect_response|PUBLIC|EXECUTE',
    'function|net.http_collect_response|PUBLIC|EXECUTE', 'function|net.worker_restart|PUBLIC|EXECUTE',
    'function|net.wait_until_running|PUBLIC|EXECUTE', 'function|net.wake|PUBLIC|EXECUTE', 'function|net.check_worker_is_up|PUBLIC|EXECUTE',
    'type|*|PUBLIC|USAGE'];
  forbidden constant text[] := array['net', 'extensions', 'cron'];
  v_net oid := to_regnamespace('net')::oid;
  v_admin oid;
  v_ext record;
  v_auth oid;
  reasons text[] := '{}';
  objects text[] := '{}';
  acl_seen text[] := '{}';
  controls jsonb := 'null'::jsonb;
  notes text[] := '{}';
  ctl text[] := '{}';
  exc_rel oid[] := '{}';
  exc_fn oid[] := '{}';
  applied boolean;
  o record;
  e record;
  s record;
  k text;
  g text;
  v_bad text[];
  v_found boolean;
  begin
  if v_net is null then
    -- no pg_net here (a disposable / non-Supabase database): nothing is excepted, nothing changes
    pe := jsonb_build_object('platform_exceptions', '[]'::jsonb, 'excepted_relations', '[]'::jsonb, 'excepted_functions', '[]'::jsonb, 'findings', '[]'::jsonb);
    exit platform_exception;
  end if;
  select oid into v_admin from pg_roles where rolname = 'supabase_admin';
  select obj.oid, obj.extowner, obj.extversion into v_ext from pg_extension obj where obj.extname = 'pg_net';
  if v_admin is null then reasons := reasons || 'owner_role_supabase_admin_missing'::text; end if;
  if v_ext.oid is null then reasons := reasons || 'extension_pg_net_missing'::text;
  elsif v_ext.extowner is distinct from v_admin then reasons := reasons || ('extension_owner:' || pg_get_userbyid(v_ext.extowner)); end if;

  -- every object in schema net: owner supabase_admin, member of extension pg_net
  for o in
    select 'pg_namespace'::regclass cls, n.oid, 'schema'::text kind, 'net'::text name, n.nspowner own, n.nspacl acl, 'n'::"char" dk from pg_namespace n where n.oid = v_net
    union all select 'pg_class'::regclass, c.oid, case c.relkind when 'S' then 'sequence' when 'v' then 'view' when 'm' then 'materialized_view' when 'f' then 'foreign_table' else 'table' end,
                     'net.' || c.relname, c.relowner, c.relacl, case c.relkind when 'S' then 's' else 'r' end::"char"
                from pg_class c where c.relnamespace = v_net and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    union all select 'pg_proc'::regclass, p.oid, 'function', 'net.' || p.proname, p.proowner, p.proacl, 'f'::"char" from pg_proc p where p.pronamespace = v_net
    union all select 'pg_type'::regclass, t.oid, 'type', 'net.' || t.typname, t.typowner, t.typacl, 'T'::"char" from pg_type t where t.typnamespace = v_net
    union all select 'pg_operator'::regclass, obj.oid, 'operator', 'net.' || obj.oprname, obj.oprowner, null::aclitem[], null::"char" from pg_operator obj where obj.oprnamespace = v_net
    union all select 'pg_collation'::regclass, obj.oid, 'collation', 'net.' || obj.collname, obj.collowner, null, null from pg_collation obj where obj.collnamespace = v_net
    union all select 'pg_conversion'::regclass, obj.oid, 'conversion', 'net.' || obj.conname, obj.conowner, null, null from pg_conversion obj where obj.connamespace = v_net
    union all select 'pg_opclass'::regclass, obj.oid, 'operator_class', 'net.' || obj.opcname, obj.opcowner, null, null from pg_opclass obj where obj.opcnamespace = v_net
    union all select 'pg_opfamily'::regclass, obj.oid, 'operator_family', 'net.' || obj.opfname, obj.opfowner, null, null from pg_opfamily obj where obj.opfnamespace = v_net
    union all select 'pg_ts_config'::regclass, obj.oid, 'text_search_configuration', 'net.' || obj.cfgname, obj.cfgowner, null, null from pg_ts_config obj where obj.cfgnamespace = v_net
    union all select 'pg_ts_dict'::regclass, obj.oid, 'text_search_dictionary', 'net.' || obj.dictname, obj.dictowner, null, null from pg_ts_dict obj where obj.dictnamespace = v_net
    union all select 'pg_statistic_ext'::regclass, obj.oid, 'statistics', 'net.' || obj.stxname, obj.stxowner, null, null from pg_statistic_ext obj where obj.stxnamespace = v_net
    order by 3, 4, 2
  loop
    objects := objects || (o.kind || ':' || o.name);
    if o.own is distinct from v_admin then reasons := reasons || ('owner:' || o.kind || ':' || o.name || ':' || pg_get_userbyid(o.own)); end if;
    if v_ext.oid is null or not exists (select 1 from pg_depend d where d.classid = o.cls and d.objid = o.oid and d.objsubid = 0
                                          and d.refclassid = 'pg_catalog.pg_extension'::regclass and d.refobjid = v_ext.oid and d.deptype = 'e') then
      reasons := reasons || ('not_extension_member:' || o.kind || ':' || o.name);
    end if;
    if o.kind = 'table' or o.kind = 'sequence' then exc_rel := exc_rel || o.oid; end if;
    if o.kind = 'function' then exc_fn := exc_fn || o.oid; end if;
    if o.dk is not null then
      for e in select a.grantor, a.grantee, a.privilege_type, a.is_grantable from aclexplode(coalesce(o.acl, acldefault(o.dk, o.own))) a loop
        continue when e.grantee = o.own and e.grantor = o.own; -- the owner's own rights
        g := case when e.grantee = 0 then 'PUBLIC' else pg_get_userbyid(e.grantee) end;
        k := o.kind || '|' || o.name || '|' || g || '|' || e.privilege_type;
        acl_seen := acl_seen || k;
        if e.grantor is distinct from v_admin then reasons := reasons || ('acl_grantor:' || k || ':' || pg_get_userbyid(e.grantor)); end if;
        if e.is_grantable then reasons := reasons || ('acl_grant_option:' || k); end if;
        -- types are matched by '*' (their only privilege is USAGE: no data, no egress)
        if not ((o.kind || '|' || case when o.kind = 'type' then '*' else o.name end || '|' || g || '|' || e.privilege_type) = any (fingerprint)) then
          reasons := reasons || ('acl_outside_fingerprint:' || k);
        end if;
      end loop;
    end if;
  end loop;
  -- column-level grants on net relations: none is in the fingerprint
  for e in select 'column|net.' || c.relname || '.' || a.attname || '|' || case when ae.grantee = 0 then 'PUBLIC' else pg_get_userbyid(ae.grantee) end || '|' || ae.privilege_type k
             from pg_class c join pg_attribute a on a.attrelid = c.oid cross join lateral aclexplode(a.attacl) ae
            where c.relnamespace = v_net and a.attacl is not null and not a.attisdropped loop
    acl_seen := acl_seen || e.k;
    reasons := reasons || ('acl_outside_fingerprint:' || e.k);
  end loop;
  applied := coalesce(array_length(reasons, 1), 0) = 0;

  if applied then
    -- (a) the role: NOLOGIN, NOINHERIT, not BYPASSRLS, member of no role
    select array_remove(array[case when rolcanlogin then 'canlogin' end, case when rolinherit then 'inherit' end, case when rolbypassrls then 'bypassrls' end, case when rolsuper then 'superuser' end], null)
      into v_bad from pg_roles where oid = r;
    v_bad := coalesce(v_bad, array['role_missing']) || array(select 'member_of:' || mr.rolname from pg_auth_members m join pg_roles mr on mr.oid = m.roleid where m.member = r order by 1);
    foreach k in array v_bad loop ctl := ctl || ('platform_exception_control_a:' || k); end loop;
    controls := jsonb_build_object('a_role_posture', coalesce(array_length(v_bad, 1), 0) = 0);
    -- (b) authenticator's exposed schemas (role-setting override of the dashboard configuration)
    select oid into v_auth from pg_roles where rolname = 'authenticator';
    v_found := false;
    if v_auth is null then
      ctl := ctl || 'platform_exception_control_b:authenticator_missing'::text;
    else
      for s in select substr(c, length('pgrst.db_schemas=') + 1) v from pg_db_role_setting drs cross join lateral unnest(drs.setconfig) c
                where drs.setrole = v_auth and drs.setdatabase in (0, (select oid from pg_database where datname = current_database())) and c like 'pgrst.db\_schemas=%' loop
        v_found := true;
        for k in select lower(btrim(item, ' "')) from unnest(string_to_array(s.v, ',')) item loop
          if k = any (forbidden) then ctl := ctl || ('platform_exception_control_b:exposed_schema:' || k); end if;
        end loop;
      end loop;
    end if;
    if not v_found then notes := notes || 'exposed_schemas_from_dashboard_unverified_in_sql'::text; end if;
    controls := controls || jsonb_build_object('b_exposed_schemas', case when v_auth is null then 'failed' when not v_found then 'unverified_in_sql'
                                                                        when exists (select 1 from unnest(ctl) c where c like 'platform_exception_control_b:%') then 'failed' else 'verified' end);
    -- (c) the live probe is the MCP server's (Accept-Profile / Content-Profile: net → PGRST106; GraphQL: unknown field)
    controls := controls || jsonb_build_object('c_live_exposure_probe', 'required');
    -- (d) the role's own search_path setting exists and excludes net / extensions / cron
    v_found := false;
    for s in select substr(c, length('search_path=') + 1) v from pg_db_role_setting drs cross join lateral unnest(drs.setconfig) c
              where drs.setrole = r and drs.setdatabase in (0, (select oid from pg_database where datname = current_database())) and c like 'search\_path=%' loop
      v_found := true;
      for k in select lower(btrim(item, ' "')) from unnest(string_to_array(s.v, ',')) item loop
        if k = any (forbidden) then ctl := ctl || ('platform_exception_control_d:search_path_includes:' || k); end if;
      end loop;
    end loop;
    if not v_found then ctl := ctl || 'platform_exception_control_d:search_path_unset'::text; end if;
    controls := controls || jsonb_build_object('d_role_search_path', v_found and not exists (select 1 from unnest(ctl) c where c like 'platform_exception_control_d:%'));
    -- (e) the egress rule outside the exception is the caller's (unchanged); (f) CREATE nowhere (existing findings)
    controls := controls || jsonb_build_object('e_egress_rule_outside_exception', 'enforced',
      'f_no_create', not exists (select 1 from pg_namespace n where n.nspname !~ '^pg_(toast|temp)' and has_schema_privilege(r, n.oid, 'CREATE'))
                     and not has_database_privilege(r, current_database(), 'CREATE'));
  end if;

  pe := jsonb_build_object(
    'platform_exceptions', jsonb_build_array(jsonb_build_object(
      'id', 'supabase_pg_net',
      'fingerprint_version', fp_version,
      'status', case when applied then 'applied' else 'not_applied' end,
      'reasons', to_jsonb(reasons),
      'owner', 'supabase_admin',
      'extension', 'pg_net',
      'extension_version', v_ext.extversion,
      'objects', to_jsonb(objects),
      'acl', to_jsonb(acl_seen),
      'controls', controls,
      'notes', to_jsonb(notes),
      'live_exposure_probe_required', applied,
      'doc', 'https://supabase.com/docs/guides/troubleshooting/revoking-access-to-pg_net-objects-has-no-effect-0bbc16')),
    'excepted_relations', to_jsonb(case when applied then exc_rel else '{}'::oid[] end),
    'excepted_functions', to_jsonb(case when applied then exc_fn else '{}'::oid[] end),
    'findings', to_jsonb(ctl));
  end platform_exception;
  -- lc-platform-exception:block-end
  return pe;
end
$fn$;
comment on function action_gateway.platform_egress_exceptions(oid) is 'Action Gateway: the pinned Supabase pg_net platform exception (fingerprint supabase_pg_net_default_acl.v1) + its compensating controls. Read by self_check; docs/SUPABASE-PG-NET-POSTURE.md.';

-- lc-indirect-egress:block-begin  (SYNCED, byte-identical in #25 lc_mcp_reader and #26 action_gateway; scripts/db/sync-platform-exception-block.mjs pins it)
-- THE PINNED PLATFORM ALLOWLISTS of the indirect-egress rule (docs/SUPABASE-PG-NET-POSTURE.md §4b). REVIEWED CONSTANTS:
-- a change is a new version, reviewed by the owner. Each allowlist excepts ONLY the exact objects it pins, and ONLY when
-- every pin holds; any deviation -> status not_applied, reasons listed, and those objects are findings exactly as before.
-- Every OTHER dynamic-SQL function and every OTHER egress event trigger stays a finding. Both self-checks report the
-- result as platform_allowlists (never silently).
--   supabase_postgis_dynamic_sql.v1   the PostGIS 3.3.7 management functions whose plpgsql bodies run EXECUTE
--     (AddGeometryColumn, DropGeometryColumn, DropGeometryTable, UpdateGeometrySRID, Populate_Geometry_Columns,
--     ST_FindExtent, PostGIS_Extensions_Upgrade and the long-transaction set LockRow / UnlockRows / CheckAuth /
--     Enable- / DisableLongTransactions; every overload of those names). WHY this is safe for a Data-API role:
--     they are SECURITY INVOKER (they run with the CALLER's privileges, never the owner's); their dynamic SQL is built
--     from quote_ident / format('%I') identifiers and catalog lookups, not from a caller-supplied statement; they are
--     platform-owned extension members (owner supabase_admin, extension postgis), so postgres cannot change their
--     bodies or revoke the platform default; anon and authenticated can already call them today by that default;
--     and the role holding them has no write privilege, no sequence privilege and no CREATE anywhere (hard findings
--     of the same self-check), so whatever they would execute fails on permissions as the role itself.
--     Pins: extension postgis, version 3.3.7, owned by supabase_admin, in schema public; each function a member of it,
--     owned by supabase_admin, SECURITY INVOKER, a plain function in the extension schema, its ACL only the platform
--     default (grantor supabase_admin, no grant option, grantees PUBLIC / postgres / anon / authenticated /
--     service_role); the exact signatures below.
--   supabase_pg_net_access_event_trigger.v1   event trigger issue_pg_net_access -> extensions.grant_pg_net_access().
--     Its body only matches the egress pattern because it re-GRANTs / ALTERs net.http_* when pg_net is created. WHY
--     this is safe: it fires only on CREATE EXTENSION, which needs CREATE on the database (a hard finding for the role:
--     database_create, schema_create), and its function is SECURITY INVOKER. Pins: name, event ddl_command_end, tags
--     exactly {CREATE EXTENSION}, owner supabase_admin, function extensions.grant_pg_net_access() owned by
--     supabase_admin, SECURITY INVOKER, plpgsql, returning event_trigger.
create or replace function public.lc_egress_platform_allowlists()
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $fn$
declare
  -- lc-egress-allowlist:postgis-version
  pg_version constant text := 'supabase_postgis_dynamic_sql.v1';
  pg_ext_version constant text := '3.3.7';
  -- lc-egress-allowlist:postgis-signatures (every overload of the 12 names in PostGIS 3.3.7: postgis.sql.in + long_xact.sql.in)
  pg_sigs constant text[] := array[
    'public.addgeometrycolumn(character varying,character varying,character varying,character varying,integer,character varying,integer,boolean)',
    'public.addgeometrycolumn(character varying,character varying,character varying,integer,character varying,integer,boolean)',
    'public.addgeometrycolumn(character varying,character varying,integer,character varying,integer,boolean)',
    'public.checkauth(text,text,text)', 'public.checkauth(text,text)',
    'public.disablelongtransactions()', 'public.enablelongtransactions()',
    'public.dropgeometrycolumn(character varying,character varying,character varying,character varying)',
    'public.dropgeometrycolumn(character varying,character varying,character varying)',
    'public.dropgeometrycolumn(character varying,character varying)',
    'public.dropgeometrytable(character varying,character varying,character varying)',
    'public.dropgeometrytable(character varying,character varying)', 'public.dropgeometrytable(character varying)',
    'public.lockrow(text,text,text,text,timestamp without time zone)', 'public.lockrow(text,text,text,text)',
    'public.lockrow(text,text,text)', 'public.lockrow(text,text,text,timestamp without time zone)',
    'public.populate_geometry_columns(boolean)', 'public.populate_geometry_columns(oid,boolean)',
    'public.postgis_extensions_upgrade()',
    'public.st_findextent(text,text,text)', 'public.st_findextent(text,text)',
    'public.unlockrows(text)',
    'public.updategeometrysrid(character varying,character varying,character varying,character varying,integer)',
    'public.updategeometrysrid(character varying,character varying,character varying,integer)',
    'public.updategeometrysrid(character varying,character varying,integer)'];
  pg_grantees constant text[] := array['PUBLIC', 'postgres', 'anon', 'authenticated', 'service_role'];
  -- lc-egress-allowlist:event-trigger-version
  et_version constant text := 'supabase_pg_net_access_event_trigger.v1';
  v_admin oid;
  v_ext record;
  v_et record;
  v_fn record;
  reasons text[];
  objects text[];
  absent text[];
  fn_oids oid[] := '{}';
  et_oids oid[] := '{}';
  out_list jsonb := '[]'::jsonb;
  s text;
  o oid;
  a record;
  g text;
begin
  select oid into v_admin from pg_roles where rolname = 'supabase_admin';

  -- (1) supabase_postgis_dynamic_sql
  reasons := '{}'; objects := '{}'; absent := '{}';
  select e.oid, e.extversion, e.extowner, e.extnamespace into v_ext from pg_extension e where e.extname = 'postgis';
  if v_ext.oid is null then
    out_list := out_list || jsonb_build_array(jsonb_build_object('id', 'supabase_postgis_dynamic_sql', 'version', pg_version, 'status', 'not_present',
      'rule', 'dynamic_sql_function', 'reasons', '[]'::jsonb, 'objects', '[]'::jsonb));
  else
    if v_admin is null then reasons := reasons || 'owner_role_supabase_admin_missing'::text; end if;
    if v_ext.extversion is distinct from pg_ext_version then reasons := reasons || ('extension_version:' || v_ext.extversion); end if;
    if v_ext.extowner is distinct from v_admin then reasons := reasons || ('extension_owner:' || pg_get_userbyid(v_ext.extowner)); end if;
    if v_ext.extnamespace is distinct from 'public'::regnamespace::oid then reasons := reasons || ('extension_schema:' || v_ext.extnamespace::regnamespace::text); end if;
    foreach s in array pg_sigs loop
      o := to_regprocedure(s);
      if o is null then absent := absent || s; continue; end if;
      select p.oid, p.proowner, p.prosecdef, p.prokind, p.pronamespace, p.proacl into v_fn from pg_proc p where p.oid = o;
      if not exists (select 1 from pg_depend d where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = o and d.objsubid = 0
                       and d.refclassid = 'pg_catalog.pg_extension'::regclass and d.refobjid = v_ext.oid and d.deptype = 'e') then
        reasons := reasons || ('not_extension_member:' || s);
      end if;
      if v_fn.proowner is distinct from v_admin then reasons := reasons || ('owner:' || s || ':' || pg_get_userbyid(v_fn.proowner)); end if;
      if v_fn.prosecdef then reasons := reasons || ('security_definer:' || s); end if;
      if v_fn.prokind <> 'f' then reasons := reasons || ('not_a_function:' || s); end if;
      if v_fn.pronamespace is distinct from v_ext.extnamespace then reasons := reasons || ('schema:' || s); end if;
      for a in select x.grantor, x.grantee, x.privilege_type, x.is_grantable from aclexplode(coalesce(v_fn.proacl, acldefault('f', v_fn.proowner))) x loop
        continue when a.grantee = v_fn.proowner and a.grantor = v_fn.proowner;
        g := case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end;
        if a.grantor is distinct from v_admin then reasons := reasons || ('acl_grantor:' || s || ':' || g || ':' || pg_get_userbyid(a.grantor)); end if;
        if a.is_grantable then reasons := reasons || ('acl_grant_option:' || s || ':' || g); end if;
        if not (g = any (pg_grantees)) or a.privilege_type <> 'EXECUTE' then reasons := reasons || ('acl_outside_default:' || s || ':' || g || ':' || a.privilege_type); end if;
      end loop;
      objects := objects || o::regprocedure::text;
      fn_oids := fn_oids || o;
    end loop;
    if coalesce(array_length(reasons, 1), 0) > 0 then fn_oids := '{}'; end if;
    out_list := out_list || jsonb_build_array(jsonb_build_object('id', 'supabase_postgis_dynamic_sql', 'version', pg_version,
      'status', case when coalesce(array_length(reasons, 1), 0) = 0 then 'applied' else 'not_applied' end,
      'rule', 'dynamic_sql_function', 'reasons', to_jsonb(reasons),
      'extension', 'postgis', 'extension_version', v_ext.extversion, 'extension_owner', pg_get_userbyid(v_ext.extowner),
      'extension_schema', v_ext.extnamespace::regnamespace::text, 'objects', to_jsonb(objects), 'absent', to_jsonb(absent)));
  end if;

  -- (2) supabase_pg_net_access_event_trigger
  reasons := '{}';
  select et.oid, et.evtevent, et.evttags, et.evtowner, et.evtfoid, et.evtenabled into v_et from pg_event_trigger et where et.evtname = 'issue_pg_net_access';
  if v_et.oid is null then
    out_list := out_list || jsonb_build_array(jsonb_build_object('id', 'supabase_pg_net_access_event_trigger', 'version', et_version, 'status', 'not_present',
      'rule', 'event_trigger_egress', 'reasons', '[]'::jsonb, 'objects', '[]'::jsonb));
  else
    if v_admin is null then reasons := reasons || 'owner_role_supabase_admin_missing'::text; end if;
    if v_et.evtevent is distinct from 'ddl_command_end' then reasons := reasons || ('event:' || v_et.evtevent); end if;
    if v_et.evttags is distinct from array['CREATE EXTENSION']::text[] then reasons := reasons || ('tags:' || coalesce(array_to_string(v_et.evttags, ','), 'ALL')); end if;
    if v_et.evtowner is distinct from v_admin then reasons := reasons || ('owner:' || pg_get_userbyid(v_et.evtowner)); end if;
    -- the function is matched in the catalog (schema extensions, the pinned name, no arguments): a name lookup would need
    -- USAGE on schema extensions, which the role does not hold, and this body must never contain the
    -- callee-name-then-parenthesis shape the call-graph walk matches
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where p.oid = v_et.evtfoid and n.nspname = 'extensions' and p.proname = 'grant_pg_net_access' and p.pronargs = 0) then
      reasons := reasons || ('function:' || v_et.evtfoid::regprocedure::text);
    end if;
    select p.proowner, p.prosecdef, l.lanname, p.prorettype into v_fn from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = v_et.evtfoid;
    if v_fn.proowner is distinct from v_admin then reasons := reasons || ('function_owner:' || pg_get_userbyid(v_fn.proowner)); end if;
    if v_fn.prosecdef then reasons := reasons || 'function_security_definer'::text; end if;
    if v_fn.lanname is distinct from 'plpgsql' then reasons := reasons || ('function_language:' || v_fn.lanname); end if;
    if v_fn.prorettype is distinct from 'pg_catalog.event_trigger'::regtype::oid then reasons := reasons || 'function_not_event_trigger'::text; end if;
    if coalesce(array_length(reasons, 1), 0) = 0 then et_oids := array[v_et.oid]; end if;
    out_list := out_list || jsonb_build_array(jsonb_build_object('id', 'supabase_pg_net_access_event_trigger', 'version', et_version,
      'status', case when coalesce(array_length(reasons, 1), 0) = 0 then 'applied' else 'not_applied' end,
      'rule', 'event_trigger_egress', 'reasons', to_jsonb(reasons), 'enabled', v_et.evtenabled::text,
      'objects', jsonb_build_array('event:issue_pg_net_access -> ' || v_et.evtfoid::regprocedure::text)));
  end if;

  return jsonb_build_object('allowlists', out_list, 'excepted_function_oids', to_jsonb(fn_oids), 'excepted_event_trigger_oids', to_jsonb(et_oids));
end
$fn$;
comment on function public.lc_egress_platform_allowlists() is 'Egress hardening: the pinned, versioned platform allowlists of the indirect-egress rule (PostGIS 3.3.7 dynamic-SQL management functions; the pg_net access event trigger). Each applies only when every pin holds. Reported by both self-checks as platform_allowlists. docs/SUPABASE-PG-NET-POSTURE.md §4b.';
-- The bounded transitive-reachability half of the egress rule (docs/SUPABASE-PG-NET-POSTURE.md §4a). It walks the
-- pg_proc call graph BACKWARDS from the egress leaves (comment-stripped prosrc name-resolution; cost ~|bad| x |procs|)
-- and reports, for a NOLOGIN Data-API role r, every INDIRECT path to egress the per-function body grep misses:
--   indirect_egress_function:<fn>   a function r can EXECUTE (incl. allowlisted SECURITY DEFINER entry points /
--     domain writers, judged by their owner's reach) that TRANSITIVELY reaches schema net / pg_net / http / dblink /
--     postgres_fdw / an untrusted language / a PUBLIC side-effect (lo_* / pg_notify / pg_logical_emit_message);
--   dynamic_sql_function:<fn>       a reachable sql/plpgsql function whose body runs dynamic SQL (plpgsql EXECUTE)
--     -> it can reach net.* through PUBLIC's pg_net grants; a finding unless allowlisted with a reason;
--   egress_trigger:<table>:<trigger> -> <fn>   a trigger (incl. Supabase Database Webhooks supabase_functions.http_request
--     and any pg_net-calling trigger) on a table r can INSERT/UPDATE/DELETE/TRUNCATE whose function reaches egress;
--   event_trigger_egress:<event> -> <fn>   an event trigger whose function reaches egress;
--   cron_schema_access:<detail>     USAGE on schema cron (pg_cron); with it, also cron.job access and each cron.* EXECUTE.
--     A cron object is reachable only through USAGE on its schema (the same rule every other check uses: a privilege
--     counts when the role can also USE the schema), so PUBLIC's SELECT on cron.job without USAGE is not a path;
--     USAGE itself stays a HARD finding;
--   dangerous_role_membership:<role>   membership in pg_execute_server_program / pg_read_server_files /
--     pg_write_server_files (COPY TO/FROM PROGRAM and server-file egress; superuser is caught by attr_superuser);
--   egress_definer_view:<view>      an owner-rights (security_invoker=false) view r can SELECT that depends on an egress function.
-- net-schema / pg_net-member functions are NOT roots here (platform internals; judged by the direct rule + the
-- pg_net exception). This function is called by BOTH self-checks AND the frozen strict references, so a 'not
-- applied' exception still reports exactly the same indirect findings. Each line is a HARD finding.
-- The ONLY exceptions are the pinned platform allowlists of public.lc_egress_platform_allowlists() (above): the
-- exact PostGIS 3.3.7 dynamic-SQL members and the pg_net access event trigger, each only while every pin holds.
create or replace function public.lc_reachable_egress_indirect(p_role oid)
returns text[]
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $fn$
declare
  r oid := p_role;
  findings text[] := '{}';
  nl text := chr(10);
  -- lc-indirect-egress:dynamic-sql-allowlist (sig|reason). REVIEWED CONSTANT: a reachable function that runs dynamic
  -- SQL (plpgsql EXECUTE) is an indirect-egress finding (it can reach net.* through PUBLIC's pg_net grants) unless it
  -- is listed HERE with a reason. Empty = strict.
  dyn_allow constant text[] := array[]::text[];
  bad oid[];       -- every function that transitively reaches an egress leaf (sql/plpgsql call graph)
  leaves oid[];    -- the direct egress leaves themselves
  al jsonb := public.lc_egress_platform_allowlists();
  al_fn oid[] := array(select (jsonb_array_elements_text(al -> 'excepted_function_oids'))::oid);
  al_evt oid[] := array(select (jsonb_array_elements_text(al -> 'excepted_event_trigger_oids'))::oid);
  x record;
begin
  -- the call graph is walked BACKWARDS from the egress leaves (a small frontier) so the cost is ~|bad| x |procs|,
  -- never |procs|^2. prosrc is comment-stripped once. Caller->callee is a word-boundary name match in the body.
  with recursive
  procs as (
    select p.oid, p.proname, p.prolang, p.pronamespace, p.prorettype,
           regexp_replace(p.prosrc, '--[^'||nl||']*', '', 'g') src, l.lanname, l.lanpltrusted
      from pg_proc p join pg_language l on l.oid = p.prolang join pg_namespace pn on pn.oid = p.pronamespace
     where p.prokind in ('f','p') and pn.nspname not in ('pg_catalog','information_schema') and pn.nspname !~ '^pg_(toast|temp)'
  ),
  leaf as (
    select pr.oid from procs pr join pg_namespace n on n.oid = pr.pronamespace
     where n.nspname = 'net'
        or exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
                    where d.classid = 'pg_proc'::regclass and d.objid = pr.oid and d.refclassid = 'pg_extension'::regclass
                      and d.deptype = 'e' and e.extname in ('pg_net','http','dblink','postgres_fdw'))
        or pr.proname ~* '^(http|http_[a-z_]+|dblink[a-z_]*)$'
        or (not pr.lanpltrusted and pr.lanname not in ('c','internal'))
        or (pr.lanname in ('sql','plpgsql') and pr.src ~* '\m(net\.http_[a-z_]+|http_(get|post|put|patch|delete|head|request)|dblink[a-z_]*|lo_(create|creat|from_bytea|put|import|export|unlink)|lowrite|pg_notify|pg_logical_emit_message)[[:space:]]*\(')
  ),
  bad(oid) as (
    select oid from leaf
    union
    select caller.oid
      from bad b join procs callee on callee.oid = b.oid
      join procs caller on caller.lanname in ('sql','plpgsql') and caller.oid <> b.oid
           and length(callee.proname) > 2
           and position(callee.proname in caller.src) > 0
           and caller.src ~* ('\m' || callee.proname || '[[:space:]]*\(')
  )
  select coalesce(array_agg(distinct oid), '{}'), coalesce((select array_agg(oid) from leaf), '{}')
    into bad, leaves from bad;

  -- (1) functions the role can EXECUTE that reach egress only INDIRECTLY (their own body is not a direct leaf)
  for x in
    select p.oid::regprocedure::text s
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname not in ('pg_catalog','information_schema','net') and p.prokind in ('f','p')
       and p.prorettype not in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
       and has_schema_privilege(r, n.oid, 'USAGE') and has_function_privilege(r, p.oid, 'EXECUTE')
       and p.oid = any (bad) and not (p.oid = any (leaves))
       and not exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
                        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.refclassid = 'pg_extension'::regclass
                          and d.deptype = 'e' and e.extname in ('pg_net','http','dblink','postgres_fdw'))
  loop findings := findings || ('indirect_egress_function:' || x.s); end loop;

  -- (2) dynamic SQL (plpgsql EXECUTE) in a function the role can execute: a finding unless allowlisted
  for x in
    select p.oid::regprocedure::text s
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
     where n.nspname not in ('pg_catalog','information_schema','net') and l.lanname in ('sql','plpgsql') and p.prokind in ('f','p')
       and p.prorettype not in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
       and has_schema_privilege(r, n.oid, 'USAGE') and has_function_privilege(r, p.oid, 'EXECUTE')
       and not exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
                        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.refclassid = 'pg_extension'::regclass
                          and d.deptype = 'e' and e.extname in ('pg_net','http','dblink','postgres_fdw'))
       and regexp_replace(p.prosrc, '--[^'||nl||']*', '', 'g') ~* '\mexecute[[:space:]]'
       and not (p.oid::regprocedure::text = any (select split_part(a, '|', 1) from unnest(dyn_allow) a))
       and not (p.oid = any (al_fn))  -- pinned supabase_postgis_dynamic_sql allowlist (only while every pin holds)
  loop findings := findings || ('dynamic_sql_function:' || x.s); end loop;

  -- (3) triggers (incl. Supabase Database Webhooks supabase_functions.http_request and pg_net triggers) on a table
  --     the role can INSERT/UPDATE/DELETE/TRUNCATE whose function reaches egress
  for x in
    select t.tgrelid::regclass::text || ':' || t.tgname || ' -> ' || t.tgfoid::regprocedure::text s
      from pg_trigger t
     where not t.tgisinternal and t.tgfoid = any (bad)
       and has_schema_privilege(r, (select c.relnamespace from pg_class c where c.oid = t.tgrelid), 'USAGE')
       and (has_table_privilege(r, t.tgrelid, 'INSERT') or has_table_privilege(r, t.tgrelid, 'UPDATE')
            or has_table_privilege(r, t.tgrelid, 'DELETE') or has_table_privilege(r, t.tgrelid, 'TRUNCATE'))
  loop findings := findings || ('egress_trigger:' || x.s); end loop;

  -- (4) event triggers whose function reaches egress (except the pinned supabase_pg_net_access_event_trigger)
  for x in
    select 'event:' || et.evtname || ' -> ' || et.evtfoid::regprocedure::text s from pg_event_trigger et where et.evtfoid = any (bad) and not (et.oid = any (al_evt))
  loop findings := findings || ('event_trigger_egress:' || x.s); end loop;

  -- (5) pg_cron: the role must have no USAGE on schema cron. Every cron object is reachable only through that USAGE
  --     (a relation / function grant without it cannot be exercised), so the object grants are reported with it.
  if to_regnamespace('cron') is not null and has_schema_privilege(r, 'cron', 'USAGE') then
    findings := findings || 'cron_schema_access:usage'::text;
    if to_regclass('cron.job') is not null and (has_table_privilege(r, 'cron.job', 'SELECT') or has_table_privilege(r, 'cron.job', 'INSERT')
       or has_table_privilege(r, 'cron.job', 'UPDATE') or has_table_privilege(r, 'cron.job', 'DELETE')) then findings := findings || 'cron_schema_access:cron.job'::text; end if;
    for x in select p.oid::regprocedure::text s from pg_proc p where p.pronamespace = 'cron'::regnamespace and has_function_privilege(r, p.oid, 'EXECUTE')
    loop findings := findings || ('cron_schema_access:execute:' || x.s); end loop;
  end if;

  -- (6) COPY TO/FROM PROGRAM and server files need superuser or these roles; a NOLOGIN Data-API role must hold none
  for x in select g.rolname from pg_auth_members m join pg_roles g on g.oid = m.roleid
            where m.member = r and g.rolname in ('pg_execute_server_program','pg_read_server_files','pg_write_server_files')
  loop findings := findings || ('dangerous_role_membership:' || x.rolname); end loop;

  -- (7) owner-rights (security_invoker=false) views the role can SELECT whose definition depends on an egress function
  for x in
    select format('%I.%I', n.nspname, c.relname) q
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'v' and coalesce(array_to_string(c.reloptions, ',') ~* 'security_invoker=(true|on|1)', false) = false
       and has_schema_privilege(r, n.oid, 'USAGE') and has_table_privilege(r, c.oid, 'SELECT')
       and exists (select 1 from pg_depend d
                    where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_proc'::regclass and d.refobjid = any (bad)
                      and d.objid in (select oid from pg_rewrite where ev_class = c.oid))
  loop findings := findings || ('egress_definer_view:' || x.q); end loop;

  return findings;
end
$fn$;
comment on function public.lc_reachable_egress_indirect(oid) is 'Egress hardening: bounded transitive reachability (call graph, triggers, event triggers, cron, dangerous memberships, owner-rights views) to net/pg_net/http/dblink/side-effects for a Data-API role. Read by action_gateway.self_check and lc_mcp_reader_self_check. docs/SUPABASE-PG-NET-POSTURE.md.';
-- lc-indirect-egress:block-end
revoke all on function public.lc_reachable_egress_indirect(oid) from public, anon, authenticated, service_role;
grant execute on function public.lc_reachable_egress_indirect(oid) to lc_action_gateway;
revoke all on function public.lc_egress_platform_allowlists() from public, anon, authenticated, service_role;
grant execute on function public.lc_egress_platform_allowlists() to lc_action_gateway;

create function action_gateway.self_check(p_role name default 'lc_action_gateway')
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
    'action_gateway.grant_admit(uuid,uuid,text)','action_gateway.grant_note_failure(uuid,text)','action_gateway.grant_execution_refusal(uuid)'];
  -- lc-action-inventory:entry-points (SECURITY INVOKER)
  entry text[] := array['public.action_gateway_controls()','public.action_gateway_intent_open(jsonb)','public.action_gateway_intent_get(uuid)',
    'public.action_gateway_refuse(uuid,text,jsonb)','public.action_gateway_expire(uuid,text)','public.action_gateway_await_approval(uuid,text)',
    'public.action_gateway_authorize(uuid,text,jsonb)','public.action_gateway_claim(uuid,text,integer)','public.action_gateway_complete(uuid,uuid,text,text,jsonb)',
    'public.action_gateway_mark_unknown(uuid,text)','public.action_gateway_recoverable(integer)','public.action_gateway_audit_append(jsonb)',
    'public.action_gateway_approval_request(jsonb)','public.action_gateway_approval_get(text)','public.action_gateway_pipeline_facts(uuid,integer)',
    'public.action_gateway_work_item_get(uuid)','public.action_gateway_self_check()'];
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
  -- bounded transitive reachability: indirect / dynamic-SQL / trigger / event-trigger / cron / membership / view egress paths the per-function grep misses (HARD findings)
  findings := findings || public.lc_reachable_egress_indirect(r);

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
                                   'platform_exceptions', pe -> 'platform_exceptions',
                                   'platform_allowlists', public.lc_egress_platform_allowlists() -> 'allowlists', 'generated_at', clock_timestamp());
end
$fn$;
comment on function action_gateway.self_check(name) is 'Action Gateway: privilege introspection of lc_action_gateway (writes only the gateway bookkeeping, definer allowlist, no egress, read inventory). The apply refuses unless ok.';

create function public.action_gateway_self_check()
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $fn$ select action_gateway.self_check(current_user) $fn$;

-- ───────────────────────────────────────────── 10. privileges + RLS ─────────
-- revoke everything new from everyone first (Supabase default privileges grant new functions / tables
-- to anon, authenticated and service_role), then grant by name
do $$
declare f record; t record;
begin
  for f in select p.oid::regprocedure::text sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'action_gateway' or (n.nspname = 'public' and p.proname like 'action\_gateway\_%') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
  for t in select format('%I.%I', n.nspname, c.relname) q, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'action_gateway' and c.relkind in ('r', 'S') loop
    execute format('revoke all on %s %s from public, anon, authenticated, service_role', case when t.relkind = 'S' then 'sequence' else 'table' end, t.q);
  end loop;
end $$;

grant usage on schema action_gateway to lc_action_gateway, service_role, authenticated;
grant usage on schema agent to lc_action_gateway;
grant execute on function action_gateway.read_inventory(), action_gateway.request_org(), action_gateway.tier_label(smallint), action_gateway.control_refusal(text, smallint),
  action_gateway.intent_transition_ok(text, text), action_gateway.is_terminal(text), action_gateway.intent_json(action_gateway.action_intents),
  action_gateway.audit(uuid, text, text, uuid, text, text, smallint, text, uuid, jsonb), action_gateway.finish_intent(uuid, text, text, jsonb),
  action_gateway.self_check(name), action_gateway.platform_egress_exceptions(oid), action_gateway.grant_admit(uuid, uuid, text), action_gateway.grant_note_failure(uuid, text),
  action_gateway.grant_execution_refusal(uuid), action_gateway.standing_t2_actions() to lc_action_gateway;
grant execute on function public.action_gateway_controls(), public.action_gateway_intent_open(jsonb), public.action_gateway_intent_get(uuid),
  public.action_gateway_refuse(uuid, text, jsonb), public.action_gateway_expire(uuid, text), public.action_gateway_await_approval(uuid, text),
  public.action_gateway_authorize(uuid, text, jsonb), public.action_gateway_claim(uuid, text, integer), public.action_gateway_complete(uuid, uuid, text, text, jsonb),
  public.action_gateway_mark_unknown(uuid, text), public.action_gateway_recoverable(integer), public.action_gateway_audit_append(jsonb),
  public.action_gateway_approval_request(jsonb), public.action_gateway_approval_get(text), public.action_gateway_pipeline_facts(uuid, integer),
  public.action_gateway_work_item_get(uuid), public.action_gateway_self_check(), public.action_gateway_principal(text), public.action_gateway_reply_policy(),
  public.action_gateway_dw_thread_hold_set(uuid, uuid), public.action_gateway_dw_operator_task(uuid, uuid), public.action_gateway_dw_runtime_enqueue(uuid, uuid)
  to lc_action_gateway;
-- the existing domain functions the invoker wrappers call (definer, allowlisted in the self-check)
grant execute on function agent.capability_approval_insert(jsonb), agent.ops_pipeline_facts(uuid, integer), agent.payload_is_clean(jsonb),
  agent.payload_violation(jsonb, text), agent.payload_string_violation(text, text, integer), agent.payload_norm_key(text), agent.payload_b64_decode(text),
  public.automation_hold_for(text, uuid, text, uuid, text, text) to lc_action_gateway;

-- gateway bookkeeping: insert rows; update only the intent lifecycle columns; read own org
grant select, insert on action_gateway.action_intents, action_gateway.action_authorizations, action_gateway.action_outcomes, action_gateway.action_audit_events to lc_action_gateway;
grant update (state, attempt, lease_owner, lease_token, lease_until, result_code, approval_id, updated_at, finished_at) on action_gateway.action_intents to lc_action_gateway;
-- the operator approval path (API, agent_api) reads intents to render and decide approval cards
grant usage on schema action_gateway to agent_api;
grant select on action_gateway.action_intents to agent_api;
-- owners administer principals and grants (service_role tooling or the SQL editor)
grant select, insert, update on action_gateway.agent_principals, action_gateway.capability_grants to service_role;
grant select on action_gateway.action_intents, action_gateway.action_authorizations, action_gateway.action_outcomes, action_gateway.action_audit_events to service_role;
grant select on action_gateway.action_intents, action_gateway.action_authorizations, action_gateway.action_outcomes, action_gateway.action_audit_events to authenticated;

alter table action_gateway.agent_principals enable row level security;
alter table action_gateway.capability_grants enable row level security;
alter table action_gateway.action_intents enable row level security;
alter table action_gateway.action_authorizations enable row level security;
alter table action_gateway.action_outcomes enable row level security;
alter table action_gateway.action_audit_events enable row level security;
alter table action_gateway.agent_principals force row level security;
alter table action_gateway.capability_grants force row level security;
alter table action_gateway.action_intents force row level security;
alter table action_gateway.action_authorizations force row level security;
alter table action_gateway.action_outcomes force row level security;
alter table action_gateway.action_audit_events force row level security;
alter table action_gateway.grant_events enable row level security;
alter table action_gateway.grant_events force row level security;
grant select on action_gateway.grant_events to service_role, authenticated;
create policy service_role_select on action_gateway.grant_events for select to service_role using (true);
create policy operator_read on action_gateway.grant_events for select to authenticated using (agent.can_read_org(org_id));
-- the gateway role: its tenant only (the JWT lc_org claim)
create policy lc_action_gateway_tenant on action_gateway.action_intents for all to lc_action_gateway
  using (org_id = action_gateway.request_org()) with check (org_id = action_gateway.request_org());
create policy lc_action_gateway_tenant on action_gateway.action_authorizations for all to lc_action_gateway
  using (org_id = action_gateway.request_org()) with check (org_id = action_gateway.request_org());
create policy lc_action_gateway_tenant on action_gateway.action_outcomes for all to lc_action_gateway
  using (org_id = action_gateway.request_org()) with check (org_id = action_gateway.request_org());
create policy lc_action_gateway_tenant on action_gateway.action_audit_events for all to lc_action_gateway
  using (org_id = action_gateway.request_org()) with check (org_id = action_gateway.request_org());
-- SINGLE-TENANT API role (same S4 gate as the agent_api policies): read intents for approval cards
create policy agent_api_select on action_gateway.action_intents for select to agent_api using (true);
create policy service_role_all on action_gateway.agent_principals for all to service_role using (true) with check (true);
create policy service_role_all on action_gateway.capability_grants for all to service_role using (true) with check (true);
create policy service_role_select on action_gateway.action_intents for select to service_role using (true);
create policy service_role_select on action_gateway.action_authorizations for select to service_role using (true);
create policy service_role_select on action_gateway.action_outcomes for select to service_role using (true);
create policy service_role_select on action_gateway.action_audit_events for select to service_role using (true);
create policy operator_read on action_gateway.action_intents for select to authenticated using (agent.can_read_org(org_id));
create policy operator_read on action_gateway.action_authorizations for select to authenticated using (agent.can_read_org(org_id));
create policy operator_read on action_gateway.action_outcomes for select to authenticated using (agent.can_read_org(org_id));
create policy operator_read on action_gateway.action_audit_events for select to authenticated using (agent.can_read_org(org_id));

-- agent reads (org-scoped): the gateway's own approvals, the sponsor membership check, agent-scope tasks
grant select on agent.approval_request, agent.operator_membership, agent.ops_work_item to lc_action_gateway;
create policy lc_action_gateway_select on agent.approval_request for select to lc_action_gateway
  using (org_id = action_gateway.request_org() and capability_id = 'agent_actions.authorize_action');
create policy lc_action_gateway_select on agent.operator_membership for select to lc_action_gateway using (org_id = action_gateway.request_org());
create policy lc_action_gateway_select on agent.ops_work_item for select to lc_action_gateway using (org_id = action_gateway.request_org() and scope = 'agent');

-- the read inventory (public). RLS is on for these tables in production (operator lockdown); without a
-- policy the role would read ZERO rows (a silent wrong answer, not a denial)
do $$
declare t text;
begin
  foreach t in array array_remove(action_gateway.read_inventory(), 'system_control') loop
    execute format('grant select on public.%I to lc_action_gateway', t);
    execute format('create policy lc_action_gateway_select on public.%I for select to lc_action_gateway using (true)', t);
  end loop;
end $$;
-- system_control: a KEY ALLOWLIST (the gateway's own switches + the keys the draft / context path reads)
grant select (key, value) on public.system_control to lc_action_gateway;
create policy lc_action_gateway_select on public.system_control for select to lc_action_gateway
  using (key in ('action_gateway_enabled', 'action_gateway_tiers', 'action_gateway_killed_capabilities',
                 'ai_conversation_company_identity', 'ai_conversation_send_enabled', 'ai_conversation_send_policy',
                 'queue_emergency_stop_at', 'agent_mode'));

-- ───────────────────────────────────────────── 11. the apply refuses unless the role is exactly this ──
do $$
declare v jsonb;
begin
  v := action_gateway.self_check('lc_action_gateway');
  if not coalesce((v ->> 'ok')::boolean, false) then
    raise exception 'action_gateway: self-check refused the role: %', v -> 'findings';
  end if;
  if agent.ops_scope_of_kind('conversation.turn') is distinct from 'conversation' then raise exception 'postcondition: ops scope map changed'; end if;
end $$;
