-- =============================================================================
-- LeadCommand ACTION GATEWAY, Tier-3 (seller-facing) + Tier-4 (financial) family:
--   queue_authorized_reply · prepare_acquisition_offer · submit_offer_for_approval ·
--   execute_authorized_offer · record_seller_counteroffer
-- plus the R4 (persistence-layer ceiling) and R5 (durable send budget) fixes.
-- STATUS: PROPOSED. NOT APPLIED. Owner approval required; applied on its own.
-- OPTIONAL chain link #28, AFTER #26 (action_gateway) and #27 (action_gateway_t2): it extends #27's composable
-- extension registry by ROW (see "SELF-CHECK COMPOSITION" below) and never re-edits a body #27 owns.
-- Test (disposable PostgreSQL 17 ONLY, never production):
--   node scripts/db/run-migration-test.mjs --pg-bin <pg17 bin dir> --id action_gateway_t34
-- Rollback: PROPOSED_20261020110000_action_gateway_t34_rollback.sql
-- Design: docs/ACTION-MCP.md §8 (T3 / T4)
-- =============================================================================
--
-- THE SHAPE (owner directive 2026-10-19: "AGNTEI THINKS, COORDINATES AND ACTS. LEADCOMMAND ENFORCES
-- AUTHORITY AND EXECUTES."):
--   * the Action Gateway (lc_action_gateway, the MCP process) authorizes; it can still write NO business
--     table. A seller-facing / financial action's domain write is a HANDOFF: one SECURITY DEFINER function
--     that re-checks the production activation, the hold registry and the destination's suppression,
--     consumes the durable send budget (offers), enqueues ONE R2 runtime job accountable to the agent's
--     human sponsor and records a receipt — all in ONE transaction with the intent's outcome;
--   * LeadCommand's own worker (API, backend credentials) runs that job through the CANONICAL path
--     (decideAndCompose → validator → R3 / send policy → the canonical queue writer → the dispatcher for
--     replies; composeNegotiationReply → persistActiveOffer → the ledger → the canonical queue writer for
--     offers; recordSellerCounter for counters) and records the receipt. The job kinds
--     ONE kind, action_gateway.execute (the worker dispatches by the intent's action; the receipts sweep is the same
--     kind with input {sweep:'receipts'}), claims NOTHING until an operator arms + enables it in
--     agent.runtime_limits.kind_limits (born OFF).
--
-- WHAT IT CREATES
--   public.negotiation_send_authorization_uses   R5: the DURABLE send budget. One immutable row per priced
--                                                send, unique per (authorization, use_no) and per use_key.
--   public.negotiation_send_authorization_consume(id, use_key, amount)
--                                                R5: ONE transaction: lock the authorization row, re-check
--                                                it (revoked / not yet valid / expired / envelope not live /
--                                                amount above the ceiling), count the uses, insert the next
--                                                one or refuse send_budget_exhausted. Idempotent per use_key.
--   public.seller_offers_ceiling_guard()         R4: an OUTBOUND active offer needs an independent ceiling
--                                                (authorized_ceiling; the live envelope max for its scope)
--                                                and a price ≤ the lowest, unless metadata.ceiling_override
--                                                carries a complete HUMAN override (operator_id, reason ≥ 12,
--                                                approval_ref). The JS persistence layer refuses the same
--                                                first (seller-offer-authority.js#evaluateOfferCeiling).
--   action_gateway.seller_action_receipts        what LeadCommand did with a handed-off intent (requested →
--                                                executing → enqueued / recorded / held / refused / deferred
--                                                / failed → sent / outcome_unknown). A hold, a failure or an
--                                                unknown outcome raises ONE agent-scope operator work item.
--   public.lc_seller_action_receipt_record(…)    the receipt writer (service_role: LeadCommand's worker).
--   public.action_gateway_authorize_envelope     T4 authorization by an operator-authorized ENVELOPE REF
--                                                ('send_authorization:<uuid>'): the replaced
--                                                action_gateway.authorization_guard verifies it in the
--                                                database (scope = the intent's exact thread + property,
--                                                live envelope + send authorization, their human approval
--                                                records, amount ≤ send ceiling ≤ envelope max, budget left).
--   public.action_gateway_negotiation_state / _offer_authority
--                                                STABLE definer reads of the service-role-only negotiation
--                                                tables and the engine row (the tables keep their ACLs).
--   public.action_gateway_dw_handoff / _dw_offer_envelope
--                                                the lease-bound domain writes (parameters from the
--                                                authorized intent, never from the caller).
--   public.action_gateway_receipt_get            the gateway's read of its own receipts.
--   a key-allowlist policy on public.system_control for 'negotiation_send_enabled' (the negotiation
--   production activation; absent ⇒ OFF).
--
-- SELF-CHECK COMPOSITION (docs/ACTION-MCP.md §8.3, link #27): this link ADDS ROWS (link = its file name) to
--   action_gateway.extensions — its definer functions (kind definer_function), its invoker entry point
--   (entry_point) and its domain-write actions (domain_write_action: action_gateway_complete refuses a JS completion
--   for them). It never re-edits self_check / standing_t2_actions / action_gateway_complete. No T3 / T4 action is a
--   standing_t2_action (a standing grant alone never authorizes them). Its rollback deletes only its rows.
--   It DOES replace one #26 body, action_gateway.authorization_guard (the envelope-ref branch); #27 does not touch it
--   and this link's rollback restores #26's body verbatim.
--
-- WHAT MAKES THE APPLY ABORT (atomically): #26 or #27 (the extension registry) absent; this link already applied; a negotiation table
--   (PROPOSED_20261015190000 / _20261016161000), public.seller_offers (its price / ceiling / status /
--   direction / metadata / scope columns) or public.property_acquisition_scores missing; and ANY finding
--   of the composed self-check.

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ───────────────────────────────────────────── 1. prerequisites ─────────────
do $$
declare t text; c text; missing text[] := '{}';
begin
  if to_regnamespace('action_gateway') is null or to_regprocedure('action_gateway.self_check(name)') is null or to_regprocedure('action_gateway.authorization_guard()') is null then
    raise exception 'action_gateway_t34: link #26 (PROPOSED_20261019160000_action_gateway.sql) must be applied first';
  end if;
  if to_regclass('action_gateway.extensions') is null or to_regprocedure('action_gateway.extension_names(text)') is null then
    raise exception 'action_gateway_t34: link #27 (PROPOSED_20261020100000_action_gateway_t2.sql, the extension registry) must be applied first';
  end if;
  if to_regclass('action_gateway.seller_action_receipts') is not null or exists (select 1 from action_gateway.extensions where link = 'PROPOSED_20261020110000_action_gateway_t34') then
    raise exception 'action_gateway_t34: already applied';
  end if;
  foreach t in array array['public.negotiation_envelopes','public.negotiation_envelope_revocations','public.negotiation_offer_events',
      'public.negotiation_send_authorizations','public.negotiation_send_authorization_revocations','public.seller_offers',
      'public.property_acquisition_scores','public.inbox_thread_state','public.sms_suppression_list'] loop
    if to_regclass(t) is null then missing := missing || t; end if;
  end loop;
  if to_regprocedure('public.negotiation_immutable_guard()') is null then missing := missing || 'public.negotiation_immutable_guard()'::text; end if;
  if array_length(missing, 1) > 0 then raise exception 'action_gateway_t34: missing prerequisite(s): %', array_to_string(missing, ', '); end if;
  foreach c in array array['purchase_price','authorized_ceiling','status','direction','metadata','thread_key','property_id'] loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'seller_offers' and column_name = c) then
      raise exception 'action_gateway_t34: public.seller_offers.% is missing (the R4 ceiling guard reads it)', c;
    end if;
  end loop;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'property_acquisition_scores' and column_name = 'property_id') then
    raise exception 'action_gateway_t34: public.property_acquisition_scores.property_id is missing';
  end if;
end $$;

-- ───────────────────────────────────────────── 2. helpers (immutable, internal) ──
-- the property id an intent stores as a pid_ letter ref (agent.payload_is_clean never sees raw digits)
create function action_gateway.decode_property_ref(p_ref text)
returns text language sql immutable parallel safe set search_path = pg_catalog
as $fn$ select case when p_ref ~ '^pid_[g-p]{1,30}$' then translate(substr(p_ref, 5), 'ghijklmnop', '0123456789') else p_ref end $fn$;

-- the negotiation scope of (thread, property): same bytes as domain/negotiation/envelope.js#scopeKey
create function action_gateway.scope_key_of(p_thread_key text, p_property_id text)
returns text language sql immutable parallel safe set search_path = pg_catalog
as $fn$ select 'nscope_' || encode(sha256(convert_to(btrim(p_thread_key) || '|' || btrim(p_property_id), 'UTF8')), 'hex') $fn$;

-- the sealed thread ref: same bytes as domain/conversation-ai/pii.js#threadRef
create function action_gateway.thread_ref_of(p_thread_key text)
returns text language sql immutable parallel safe set search_path = pg_catalog
as $fn$ select 'thr_' || translate(left(encode(sha256(convert_to(coalesce(p_thread_key, ''), 'UTF8')), 'hex'), 12), '0123456789', 'ghijklmnop') $fn$;

-- the actions this link hands off, and the T4 action authorized by an envelope ref
create function action_gateway.t34_handoff_kind(p_action text)
returns text language sql immutable parallel safe set search_path = pg_catalog
-- ONE LeadCommand-side executor kind for every handed-off gateway action (shared with the T2 executor pattern;
-- the worker dispatches by the intent's action): never a second kind per tool
as $fn$ select case when p_action in ('queue_authorized_reply', 'execute_authorized_offer', 'record_seller_counteroffer') then 'action_gateway.execute' else null end $fn$;
create function action_gateway.envelope_actions()
returns text[] language sql immutable parallel safe set search_path = pg_catalog
as $fn$ select array['execute_authorized_offer']::text[] $fn$;

-- the registry capabilities each handed-off action exercises (holds/automation-hold.js capability map)
create function action_gateway.t34_hold_capabilities(p_action text)
returns text[] language sql immutable parallel safe set search_path = pg_catalog
as $fn$ select case p_action
  when 'queue_authorized_reply' then array['ai_action','auto_reply','outbound_send']
  when 'execute_authorized_offer' then array['ai_action','auto_reply','offer_write','outbound_send']
  when 'record_seller_counteroffer' then array['offer_write']
  else array['ai_action','auto_reply','offer_write','outbound_send','offer_acceptance','stage_advance'] end::text[] $fn$;

-- the PRODUCTION ACTIVATION of a handed-off action (system_control, absent ⇒ OFF): null = active, else the code.
-- Seller replies: the AI send kill switch + an enabled send policy (R3 re-reads both, plus its scope). Offers: the
-- negotiation send switch. Both: no queue emergency stop. Counters record the seller's own number (no activation).
create function action_gateway.t34_capability_refusal(p_action text)
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

-- ───────────────────────────────────────────── 3. R5: the durable send budget ──
create table public.negotiation_send_authorization_uses (
  use_id                uuid primary key default gen_random_uuid(),
  send_authorization_id uuid not null references public.negotiation_send_authorizations (send_authorization_id),
  use_no                integer not null check (use_no between 1 and 10),
  use_key               text not null unique check (use_key ~ '^[A-Za-z0-9_.:-]{8,120}$'),
  amount                numeric(14,2) not null check (amount > 0 and amount < 1000000000),
  created_at            timestamptz not null default clock_timestamp(),
  constraint negotiation_send_authorization_uses_no_key unique (send_authorization_id, use_no)
);
comment on table public.negotiation_send_authorization_uses is 'R5 (Action MCP audit): the DURABLE send budget of a negotiation send authorization. One immutable row per priced send; written only by negotiation_send_authorization_consume (one transaction, authorization row locked). PROPOSED_20261020110000_action_gateway_t34.sql';
create trigger negotiation_send_authorization_uses_immutable before update or delete on public.negotiation_send_authorization_uses
  for each row execute function public.negotiation_immutable_guard();
create trigger negotiation_send_authorization_uses_no_truncate before truncate on public.negotiation_send_authorization_uses
  for each statement execute function public.negotiation_immutable_guard();
alter table public.negotiation_send_authorization_uses enable row level security;
alter table public.negotiation_send_authorization_uses force row level security;

create function public.negotiation_send_authorization_consume(p_send_authorization_id uuid, p_use_key text, p_amount numeric)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare
  a public.negotiation_send_authorizations%rowtype;
  e public.negotiation_envelopes%rowtype;
  u public.negotiation_send_authorization_uses%rowtype;
  v_used integer;
begin
  if p_use_key is null or p_use_key !~ '^[A-Za-z0-9_.:-]{8,120}$' then return jsonb_build_object('ok', false, 'reason', 'use_key_invalid'); end if;
  if p_amount is null or not (p_amount > 0 and p_amount < 1000000000) then return jsonb_build_object('ok', false, 'reason', 'amount_invalid'); end if;
  -- the authorization row is the lock: concurrent senders on one authorization serialize HERE
  select * into a from public.negotiation_send_authorizations where send_authorization_id = p_send_authorization_id for update;
  if a.send_authorization_id is null then return jsonb_build_object('ok', false, 'reason', 'no_send_authorization'); end if;
  -- a retried send replays its OWN use (same key) instead of taking another
  select * into u from public.negotiation_send_authorization_uses where use_key = p_use_key;
  if u.use_id is not null then
    if u.send_authorization_id <> a.send_authorization_id then return jsonb_build_object('ok', false, 'reason', 'use_key_bound_to_another_authorization'); end if;
    return jsonb_build_object('ok', true, 'replayed', true, 'use_no', u.use_no, 'amount', u.amount);
  end if;
  if exists (select 1 from public.negotiation_send_authorization_revocations r where r.send_authorization_id = a.send_authorization_id) then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;
  if clock_timestamp() < a.valid_from then return jsonb_build_object('ok', false, 'reason', 'not_yet_valid'); end if;
  if clock_timestamp() >= a.expires_at then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  select * into e from public.negotiation_envelopes where envelope_id = a.envelope_id;
  if e.envelope_id is null or e.version <> a.envelope_version then return jsonb_build_object('ok', false, 'reason', 'envelope_mismatch'); end if;
  if exists (select 1 from public.negotiation_envelope_revocations r where r.envelope_id = e.envelope_id) then return jsonb_build_object('ok', false, 'reason', 'envelope_not_live:revoked'); end if;
  if exists (select 1 from public.negotiation_envelopes n where n.scope_key = e.scope_key and n.version > e.version) then return jsonb_build_object('ok', false, 'reason', 'envelope_not_live:superseded'); end if;
  if clock_timestamp() < e.valid_from or clock_timestamp() >= e.expires_at then return jsonb_build_object('ok', false, 'reason', 'envelope_not_live:expired'); end if;
  if p_amount > a.ceiling then return jsonb_build_object('ok', false, 'reason', 'amount_above_send_ceiling'); end if;
  if p_amount > e.max_price then return jsonb_build_object('ok', false, 'reason', 'amount_above_envelope_max'); end if;
  select count(*) into v_used from public.negotiation_send_authorization_uses where send_authorization_id = a.send_authorization_id;
  if v_used >= a.max_sends then return jsonb_build_object('ok', false, 'reason', 'send_budget_exhausted', 'used', v_used, 'max_sends', a.max_sends); end if;
  insert into public.negotiation_send_authorization_uses (send_authorization_id, use_no, use_key, amount)
  values (a.send_authorization_id, v_used + 1, p_use_key, p_amount) returning * into u;
  return jsonb_build_object('ok', true, 'replayed', false, 'use_no', u.use_no, 'remaining', a.max_sends - u.use_no);
end
$fn$;
comment on function public.negotiation_send_authorization_consume(uuid, text, numeric) is 'R5: consume ONE use of a negotiation send authorization in one transaction (row lock, re-check, count, insert). Idempotent per use_key. service_role + the gateway handoff only.';

-- ───────────────────────────────────────────── 4. R4: the ceiling at the persistence layer ──
create function public.seller_offers_ceiling_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  v_ov jsonb := case when jsonb_typeof(new.metadata -> 'ceiling_override') = 'object' then new.metadata -> 'ceiling_override' end;
  v_override boolean := false;
  v_env_max numeric;
  v_ceiling numeric;
begin
  -- a seller counter is the SELLER's number (acceptance has its own guard); a non-active row offers nothing
  if coalesce(new.direction, 'outbound') = 'inbound' or coalesce(new.status, 'active') <> 'active' then return new; end if;
  if tg_op = 'UPDATE' and new.purchase_price is not distinct from old.purchase_price and new.authorized_ceiling is not distinct from old.authorized_ceiling
     and new.status is not distinct from old.status and new.direction is not distinct from old.direction then
    return new;
  end if;
  v_override := v_ov is not null
    and length(btrim(coalesce(v_ov ->> 'operator_id', ''))) between 1 and 80
    and btrim(v_ov ->> 'operator_id') !~* '^(agt_|agent:|auto:|engine|system|model)'
    and length(btrim(coalesce(v_ov ->> 'reason', ''))) >= 12
    and length(btrim(coalesce(v_ov ->> 'approval_ref', ''))) >= 1;
  -- the LIVE negotiation envelope of the offer's scope (thread + property), when one exists
  if nullif(btrim(coalesce(new.thread_key, '')), '') is not null and nullif(btrim(coalesce(new.property_id, '')), '') is not null then
    select e.max_price into v_env_max
      from public.negotiation_envelopes e
     where e.scope_key = action_gateway.scope_key_of(new.thread_key, new.property_id)
       and not exists (select 1 from public.negotiation_envelope_revocations r where r.envelope_id = e.envelope_id)
       and e.valid_from <= clock_timestamp() and e.expires_at > clock_timestamp()
       and not exists (select 1 from public.negotiation_envelopes n where n.scope_key = e.scope_key and n.version > e.version)
     order by e.version desc limit 1;
  end if;
  v_ceiling := least(case when new.authorized_ceiling > 0 then new.authorized_ceiling end, v_env_max);
  if v_ceiling is null and not v_override then
    raise exception using errcode = 'P0001', message = 'SELLER_OFFER_CEILING_MISSING: an outbound active offer needs an independent ceiling (authorized_ceiling or a live envelope) or an audited operator override';
  end if;
  if new.purchase_price > v_ceiling and not v_override then
    raise exception using errcode = 'P0001', message = format('SELLER_OFFER_ABOVE_CEILING: %s exceeds the authorized ceiling %s without an audited operator override', new.purchase_price, v_ceiling);
  end if;
  return new;
end
$fn$;
comment on function public.seller_offers_ceiling_guard() is 'R4 (Action MCP audit; Hartford $315K): an outbound active seller offer needs an independent ceiling and a price at or below the lowest (frozen authorized_ceiling, the live envelope max) unless metadata.ceiling_override is a complete human override. PROPOSED_20261020110000_action_gateway_t34.sql';
create trigger seller_offers_ceiling_guard before insert or update of purchase_price, authorized_ceiling, status, direction on public.seller_offers
  for each row execute function public.seller_offers_ceiling_guard();

-- ───────────────────────────────────────────── 5. receipts ──────────────────
create table action_gateway.seller_action_receipts (
  intent_id             uuid primary key references action_gateway.action_intents (intent_id),
  org_id                uuid not null references agent.org (org_id),
  action                text not null check (action in ('queue_authorized_reply', 'execute_authorized_offer', 'record_seller_counteroffer')),
  runtime_kind          text not null check (runtime_kind = 'action_gateway.execute'),
  job_id                text check (job_id is null or job_id ~ '^mjob_[0-9a-f-]{36}$'),
  state                 text not null default 'requested' check (state in ('requested', 'executing', 'enqueued', 'recorded', 'held', 'refused', 'deferred', 'failed', 'sent', 'outcome_unknown')),
  code                  text check (code is null or code ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  queue_row_id          text check (queue_row_id is null or queue_row_id ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  send_authorization_id uuid,
  use_no                integer check (use_no is null or use_no between 1 and 10),
  detail                jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 4000 and agent.payload_is_clean(detail)),
  work_item_id          uuid,
  attempts              integer not null default 0 check (attempts between 0 and 20),
  created_at            timestamptz not null default clock_timestamp(),
  updated_at            timestamptz not null default clock_timestamp()
);
create index seller_action_receipts_open_idx on action_gateway.seller_action_receipts (org_id, state, updated_at) where state in ('requested', 'executing', 'enqueued');
comment on table action_gateway.seller_action_receipts is 'What LeadCommand did with a handed-off seller-facing / financial intent (T3 / T4). Written only by the handoff domain write and public.lc_seller_action_receipt_record (LeadCommand worker). A hold, a failure or an unknown outcome raises one agent-scope operator work item.';

create function action_gateway.receipt_transition_ok(p_from text, p_to text)
returns boolean language sql immutable parallel safe set search_path = pg_catalog
as $fn$
  select coalesce(case p_from
    when 'requested' then p_to in ('executing', 'held', 'refused', 'failed')
    when 'executing' then p_to in ('executing', 'enqueued', 'recorded', 'held', 'refused', 'deferred', 'failed', 'outcome_unknown')
    when 'enqueued'  then p_to in ('sent', 'failed', 'outcome_unknown', 'held')
    else false end, false)
$fn$;

create function action_gateway.receipt_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $fn$
begin
  if tg_op = 'DELETE' then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_APPEND_ONLY: receipts are never deleted'; end if;
  if tg_op = 'INSERT' then
    if new.state <> 'requested' then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_RECEIPT_BIRTH: a receipt is born requested'; end if;
    return new;
  end if;
  if (new.intent_id, new.org_id, new.action, new.runtime_kind, new.created_at) is distinct from (old.intent_id, old.org_id, old.action, old.runtime_kind, old.created_at) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_IMMUTABLE: a receipt''s intent / action / kind are immutable';
  end if;
  if new.state is distinct from old.state and not action_gateway.receipt_transition_ok(old.state, new.state) then
    raise exception using errcode = 'P0001', message = format('ACTION_GATEWAY_RECEIPT_TRANSITION: %s -> %s', old.state, new.state);
  end if;
  if new.state = old.state and old.state <> 'executing' then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_RECEIPT_FINAL: a final receipt never changes';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end
$fn$;
create trigger aa_receipt_guard before insert or update or delete on action_gateway.seller_action_receipts for each row execute function action_gateway.receipt_guard();
create trigger aa_no_truncate before truncate on action_gateway.seller_action_receipts for each statement execute function action_gateway.append_only_guard();

-- LeadCommand's worker records what it did. A hold / failure / unknown outcome (or a refusal after the request)
-- raises ONE agent-scope operator work item (an operator decides; nothing is retried silently).
create function public.lc_seller_action_receipt_record(p_intent_id uuid, p_job_id text, p_state text, p_code text, p_detail jsonb default '{}'::jsonb, p_queue_row_id text default null)
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
comment on function public.lc_seller_action_receipt_record(uuid, text, text, text, jsonb, text) is 'LeadCommand worker (service_role): record what happened to a handed-off T3 / T4 intent; holds / failures / unknown outcomes raise one agent-scope operator work item. Never callable by lc_action_gateway.';

-- LeadCommand's worker reads the handed-off intent it executes (schema action_gateway is not exposed over PostgREST):
-- the intent, its authorization (no credential, no digest), its outcome and its receipt.
create function public.lc_seller_action_load(p_intent_id uuid)
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
comment on function public.lc_seller_action_load(uuid) is 'LeadCommand worker (service_role): the handed-off intent + authorization + outcome + receipt it executes. Never callable by lc_action_gateway.';

-- the receipts LeadCommand's reconciler follows (enqueued rows whose dispatch outcome it records)
create function public.lc_seller_action_open_receipts(p_limit integer default 50)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select coalesce(jsonb_agg(to_jsonb(r) order by r.updated_at), '[]'::jsonb)
    from (select * from action_gateway.seller_action_receipts where state = 'enqueued' order by updated_at limit least(greatest(coalesce(p_limit, 50), 1), 200)) r
$fn$;

-- ───────────────────────────────────────────── 6. the envelope ref (T4) ─────
-- null = this ENVELOPE REF authorizes this intent NOW; else the refusal code. A ref is
-- 'send_authorization:<uuid>' (the intent binds it as params.send_permit_id: a key named *authorization* is a
-- credential key to agent.payload_is_clean): an operator-granted live send authorization riding a live envelope, BOTH backed
-- by an executed human approval record, for EXACTLY the intent's thread + property, the amount ≤ the send
-- ceiling ≤ the envelope max, with budget left (the budget itself is consumed at execution, R5).
create function action_gateway.envelope_ref_refusal(p_intent_id uuid, p_ref text)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  i action_gateway.action_intents%rowtype;
  a public.negotiation_send_authorizations%rowtype;
  e public.negotiation_envelopes%rowtype;
  v_tk text; v_pid text; v_amount numeric; v_sa uuid;
begin
  select * into i from action_gateway.action_intents where intent_id = p_intent_id;
  if i.intent_id is null then return 'INTENT_NOT_FOUND'; end if;
  if not (i.action = any (action_gateway.envelope_actions())) then return 'ENVELOPE_NOT_ALLOWED_FOR_ACTION'; end if;
  if p_ref is null or p_ref !~ '^send_authorization:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return 'ENVELOPE_REF_INVALID'; end if;
  v_sa := substr(p_ref, 20)::uuid;
  if (i.params ->> 'send_permit_id') is distinct from v_sa::text then return 'ENVELOPE_REF_NOT_BOUND_TO_INTENT'; end if;
  select t.thread_key into v_tk from public.inbox_thread_state t where t.id::text = i.params ->> 'thread_id';
  v_pid := action_gateway.decode_property_ref(i.params ->> 'property_ref');
  if v_tk is null or v_pid is null or i.resource_type <> 'thread' or i.resource_id is distinct from (i.params ->> 'thread_id') then return 'ENVELOPE_SCOPE_UNRESOLVED'; end if;
  v_amount := case when jsonb_typeof(i.params -> 'amount') = 'number' then (i.params ->> 'amount')::numeric end;
  if v_amount is null or v_amount <= 0 then return 'ENVELOPE_AMOUNT_INVALID'; end if;
  select * into a from public.negotiation_send_authorizations where send_authorization_id = v_sa;
  if a.send_authorization_id is null then return 'ENVELOPE_SEND_AUTHORIZATION_NOT_FOUND'; end if;
  if a.scope_key <> action_gateway.scope_key_of(v_tk, v_pid) or a.property_id <> v_pid or a.thread_ref <> action_gateway.thread_ref_of(v_tk) then return 'ENVELOPE_SCOPE_MISMATCH'; end if;
  if exists (select 1 from public.negotiation_send_authorization_revocations r where r.send_authorization_id = a.send_authorization_id) then return 'ENVELOPE_SEND_AUTHORIZATION_REVOKED'; end if;
  if clock_timestamp() < a.valid_from or clock_timestamp() >= a.expires_at then return 'ENVELOPE_SEND_AUTHORIZATION_EXPIRED'; end if;
  select * into e from public.negotiation_envelopes where envelope_id = a.envelope_id;
  if e.envelope_id is null or e.version <> a.envelope_version or e.scope_key <> a.scope_key then return 'ENVELOPE_MISMATCH'; end if;
  if exists (select 1 from public.negotiation_envelope_revocations r where r.envelope_id = e.envelope_id) then return 'ENVELOPE_REVOKED'; end if;
  if exists (select 1 from public.negotiation_envelopes n where n.scope_key = e.scope_key and n.version > e.version) then return 'ENVELOPE_SUPERSEDED'; end if;
  if clock_timestamp() < e.valid_from or clock_timestamp() >= e.expires_at then return 'ENVELOPE_EXPIRED'; end if;
  if v_amount > a.ceiling or v_amount > e.max_price then return 'ENVELOPE_AMOUNT_ABOVE_CEILING'; end if;
  if (select count(*) from public.negotiation_send_authorization_uses u where u.send_authorization_id = a.send_authorization_id and u.use_key <> 'gw:' || i.intent_id::text) >= a.max_sends then
    return 'ENVELOPE_SEND_BUDGET_EXHAUSTED';
  end if;
  -- the HUMAN approval records behind both grants (executed, approved, decided by an org member)
  if not exists (select 1 from agent.approval_request ap where ap.approval_id = a.approval_id and ap.org_id = i.org_id
                   and ap.capability_id = 'pipeline.prepare_negotiation_send_authorization' and ap.state = 'executed' and ap.decision = 'approve'
                   and exists (select 1 from agent.operator_membership m where m.org_id = ap.org_id and m.user_id = ap.decided_by)) then
    return 'ENVELOPE_SEND_AUTHORIZATION_APPROVAL_INVALID';
  end if;
  if not exists (select 1 from agent.approval_request ap where ap.approval_id = e.approval_id and ap.org_id = i.org_id
                   and ap.capability_id in ('pipeline.grant_negotiation_envelope', 'agent_actions.authorize_action') and ap.state = 'executed' and ap.decision = 'approve'
                   and exists (select 1 from agent.operator_membership m where m.org_id = ap.org_id and m.user_id = ap.decided_by)) then
    return 'ENVELOPE_APPROVAL_INVALID';
  end if;
  return null;
end
$fn$;

-- THE AUTHORIZATION GUARD, replaced: #26's body exactly, plus ONE branch — an envelope ref is accepted for the
-- envelope actions only, verified by envelope_ref_refusal, and counts as the per-use authority a standing grant
-- alone never is (T3 / T4). An approval and an envelope ref are never combined. The rollback restores #26's body.
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

-- ───────────────────────────────────────────── 7. entry points (SECURITY INVOKER) ──
-- T4 authorization by an envelope ref (the guard above verifies it; a refusal raises and the gateway records it)
create function public.action_gateway_authorize_envelope(p_intent_id uuid, p_credential_digest text, p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $fn$
declare i action_gateway.action_intents%rowtype; v_admit jsonb; v_ref text := nullif(p ->> 'envelope_ref', '');
begin
  select * into i from action_gateway.action_intents where intent_id = p_intent_id and org_id = action_gateway.request_org() for update;
  if i.intent_id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if i.state in ('authorized', 'executing') or action_gateway.is_terminal(i.state) then
    return jsonb_build_object('ok', true, 'replayed', true, 'intent', action_gateway.intent_json(i));
  end if;
  if v_ref is null or not (i.action = any (action_gateway.envelope_actions())) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_ENVELOPE_NOT_ALLOWED_FOR_ACTION';
  end if;
  -- standing-grant admission with the envelope ref as the per-use authority marker (verified by the guard below,
  -- in the same statement: an invalid ref raises and nothing of this transaction commits)
  v_admit := action_gateway.grant_admit((p ->> 'grant_id')::uuid, i.intent_id, v_ref);
  if not coalesce((v_admit ->> 'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'refused', true, 'code', v_admit ->> 'code',
                              'outcome', action_gateway.finish_intent(i.intent_id, 'refused', v_admit ->> 'code', jsonb_build_object('stage', 'grant')));
  end if;
  perform set_config('action_gateway.presented_digest', coalesce(p_credential_digest, ''), true);
  insert into action_gateway.action_authorizations (intent_id, org_id, agent_id, capability, tier, grant_id, policy_id, policy_version, approval_required, approval_id, envelope_ref, evidence)
  values (i.intent_id, i.org_id, i.agent_id, i.capability, i.tier, (p ->> 'grant_id')::uuid, p ->> 'policy_id', p ->> 'policy_version', false, null, v_ref, coalesce(p -> 'evidence', '{}'::jsonb));
  perform set_config('action_gateway.presented_digest', '', true);
  update action_gateway.action_intents set state = 'authorized' where intent_id = i.intent_id returning * into i;
  perform action_gateway.audit(i.org_id, 'authorized', i.agent_id, i.intent_id, i.action, i.capability, i.tier, null, i.correlation_id,
                               -- the ref's uuid under an id-named key (agent.payload_is_clean exempts a UUID from its phone-run rule only there)
                               jsonb_build_object('policy_id', p ->> 'policy_id', 'policy_version', p ->> 'policy_version', 'envelope_kind', split_part(v_ref, ':', 1), 'send_permit_id', split_part(v_ref, ':', 2)));
  return jsonb_build_object('ok', true, 'replayed', false, 'intent', action_gateway.intent_json(i));
end
$fn$;

-- (definer: the role holds no SELECT on the receipts table; the tenant claim scopes the one row)
create function public.action_gateway_receipt_get(p_intent_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select jsonb_build_object('intent_id', r.intent_id, 'action', r.action, 'runtime_kind', r.runtime_kind, 'job_id', r.job_id, 'state', r.state, 'code', r.code,
                            'queue_row_id', r.queue_row_id, 'use_no', r.use_no, 'work_item_id', r.work_item_id, 'attempts', r.attempts, 'detail', r.detail,
                            'created_at', r.created_at, 'updated_at', r.updated_at)
    from action_gateway.seller_action_receipts r
   where r.intent_id = p_intent_id and r.org_id = action_gateway.request_org()
$fn$;

-- ───────────────────────────────────────────── 8. definer reads (STABLE) ────
-- The negotiation tables are service-role only (RLS forced, no policies, #19 / #20); the gateway reads ONE scope's
-- state through this function and the tables keep their ACLs. Needs the tenant claim.
create function public.action_gateway_negotiation_state(p_thread_id uuid, p_property_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare v_tk text; v_scope text; e public.negotiation_envelopes%rowtype; a public.negotiation_send_authorizations%rowtype; v_latest integer;
begin
  if action_gateway.request_org() is null then return null; end if;
  select t.thread_key into v_tk from public.inbox_thread_state t where t.id = p_thread_id;
  if v_tk is null or nullif(btrim(coalesce(p_property_id, '')), '') is null then return null; end if;
  v_scope := action_gateway.scope_key_of(v_tk, p_property_id);
  select * into e from public.negotiation_envelopes where scope_key = v_scope order by version desc limit 1;
  select * into a from public.negotiation_send_authorizations where scope_key = v_scope order by created_at desc limit 1;
  v_latest := e.version;
  return jsonb_build_object(
    'scope_hash', substr(v_scope, 8), 'thread_ref', action_gateway.thread_ref_of(v_tk),
    'envelope', case when e.envelope_id is null then null else (to_jsonb(e) - 'underwriting' - 'granted_by') || jsonb_build_object(
      'revoked', exists (select 1 from public.negotiation_envelope_revocations r where r.envelope_id = e.envelope_id), 'latest_version', v_latest) end,
    'events', coalesce((select jsonb_agg(to_jsonb(ev) - 'justification' order by ev.seq) from (select * from public.negotiation_offer_events x where x.scope_key = v_scope order by x.seq limit 200) ev), '[]'::jsonb),
    'send_authorization', case when a.send_authorization_id is null then null else (to_jsonb(a) - 'granted_by') || jsonb_build_object(
      'revoked', exists (select 1 from public.negotiation_send_authorization_revocations r where r.send_authorization_id = a.send_authorization_id),
      'uses', (select count(*) from public.negotiation_send_authorization_uses u where u.send_authorization_id = a.send_authorization_id)) end,
    'read_at', clock_timestamp());
end
$fn$;

-- The Decision Engine's row for one property (property_acquisition_scores: RLS'd, not in the read inventory), the
-- projection planOffer / the economics read: everything but the heavy evidence document, plus the evidence parts
-- the offer plan reads (offer calculation, snapshot id, backfill marker, subject, selected comps).
create function public.action_gateway_offer_authority(p_property_id text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select case when action_gateway.request_org() is null then null else (
    select (to_jsonb(s) - 'evidence') || jsonb_build_object('evidence', jsonb_strip_nulls(jsonb_build_object(
             'offer_calculation', to_jsonb(s) -> 'evidence' -> 'offer_calculation', 'immutable_snapshot_id', to_jsonb(s) -> 'evidence' -> 'immutable_snapshot_id',
             'backfill', to_jsonb(s) -> 'evidence' -> 'backfill', 'engine', to_jsonb(s) -> 'evidence' -> 'engine', 'subject', to_jsonb(s) -> 'evidence' -> 'subject',
             'selected_comps', to_jsonb(s) -> 'evidence' -> 'selected_comps', 'decision_inputs', to_jsonb(s) -> 'evidence' -> 'decision_inputs')))
      from public.property_acquisition_scores s
     where s.property_id = p_property_id
     order by to_jsonb(s) ->> 'computed_at' desc nulls last
     limit 1) end
$fn$;

-- ───────────────────────────────────────────── 9. domain writes (SECURITY DEFINER) ──
-- THE HANDOFF of a seller-facing / financial / offer-history action to LeadCommand's canonical runtime. Parameters
-- come from the authorized intent. One transaction: re-check (activation, holds, destination suppression), consume
-- the durable send budget (offers, R5), enqueue ONE runtime job accountable to the human sponsor, the receipt,
-- the outcome. A deterministic refusal is a refused outcome; an unexpected error a failed one (nothing written).
create function public.action_gateway_dw_handoff(p_intent_id uuid, p_lease_token uuid)
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

-- submit_offer_for_approval, on the HUMAN approval: the operator-authorized negotiation envelope for EXACTLY the
-- intent's thread + property, the terms the human saw (the approval binds the parameter hash), the next version of
-- the scope; approval_id = the gateway approval, granted_by = the deciding operator.
create function public.action_gateway_dw_offer_envelope(p_intent_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare
  b jsonb; i action_gateway.action_intents%rowtype; v_auth action_gateway.action_authorizations%rowtype; v_tk text; v_pid text; v_scope text;
  v_prev public.negotiation_envelopes%rowtype; v_new public.negotiation_envelopes%rowtype; t jsonb; v_from timestamptz; v_exp timestamptz; v_days integer;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['submit_offer_for_approval']);
  if b ? 'refused' then return b -> 'outcome'; end if;
  i := jsonb_populate_record(null::action_gateway.action_intents, b -> 'intent');
  begin
    select * into v_auth from action_gateway.action_authorizations where intent_id = i.intent_id;
    if v_auth.approval_id is null or v_auth.approved_by is null then return action_gateway.finish_intent(i.intent_id, 'refused', 'APPROVAL_REQUIRED', '{}'::jsonb); end if;
    select t2.thread_key into v_tk from public.inbox_thread_state t2 where t2.id::text = i.params ->> 'thread_id';
    v_pid := action_gateway.decode_property_ref(i.params ->> 'property_ref');
    if v_tk is null or v_pid is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'SCOPE_UNRESOLVED', '{}'::jsonb); end if;
    v_scope := action_gateway.scope_key_of(v_tk, v_pid);
    if substr(v_scope, 8) is distinct from i.params ->> 'scope_hash' or action_gateway.thread_ref_of(v_tk) is distinct from i.params ->> 'thread_ref' then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'SCOPE_DRIFTED', '{}'::jsonb);
    end if;
    t := i.params -> 'terms';
    -- the validity window starts at the GRANT (the human decision may take hours): valid_from = now, expiry = now +
    -- the approved number of days (≤ 30, the table CHECK); the parameters (and their approved hash) stay time-free
    v_days := (t ->> 'expires_in_days')::int;
    if v_days is null or v_days not between 1 and 30 then return action_gateway.finish_intent(i.intent_id, 'refused', 'ENVELOPE_EXPIRY_INVALID', '{}'::jsonb); end if;
    v_from := clock_timestamp();
    v_exp := v_from + make_interval(days => v_days);
    perform pg_advisory_xact_lock(hashtextextended(v_scope, 19));
    select * into v_prev from public.negotiation_envelopes where scope_key = v_scope order by version desc limit 1;
    insert into public.negotiation_envelopes (scope_key, version, thread_ref, property_id, max_price, opening_price, max_moves, closing_window_min_days, closing_window_max_days,
                                              earnest_money_min, earnest_money_max, as_is, closing_costs_paid_by, valid_from, expires_at, granted_by, approval_id,
                                              supersedes_envelope_id, underwriting, underwriting_hash, envelope_hash)
    values (v_scope, coalesce(v_prev.version, 0) + 1, i.params ->> 'thread_ref', v_pid, (t ->> 'max_price')::numeric, nullif(t ->> 'opening_price', '')::numeric,
            coalesce((t ->> 'max_moves')::int, 3), (t ->> 'closing_window_min_days')::int, (t ->> 'closing_window_max_days')::int,
            (t ->> 'earnest_money_min')::numeric, (t ->> 'earnest_money_max')::numeric, coalesce((t ->> 'as_is')::boolean, true), t ->> 'closing_costs_paid_by',
            v_from, v_exp, v_auth.approved_by::text, v_auth.approval_id,
            v_prev.envelope_id, coalesce(i.params -> 'underwriting', '{}'::jsonb), i.params ->> 'underwriting_hash',
            -- a gateway-granted envelope's hash: sha256 over the scope, the approved parameter hash and the window
            encode(sha256(convert_to('negotiation.envelope.v1|action_gateway|' || v_scope || '|' || i.params_hash || '|' || v_from::text || '|' || v_exp::text, 'UTF8')), 'hex'))
    returning * into v_new;
    return action_gateway.finish_intent(i.intent_id, 'succeeded', 'ENVELOPE_GRANTED',
                                        jsonb_build_object('envelope_id', v_new.envelope_id, 'envelope_version', v_new.version, 'supersedes_version', v_prev.version,
                                                           'expires_at', v_new.expires_at, 'granted_by_id', v_auth.approved_by));
  exception when others then
    return action_gateway.finish_intent(i.intent_id, 'failed', 'DOMAIN_WRITE_FAILED', jsonb_build_object('sqlstate', sqlstate));
  end;
end
$fn$;

-- ───────────────────────────────────────────── 10. the extension registry rows (#27) ──
insert into action_gateway.extensions (kind, name, link, basis) values
  -- lc-action-inventory:t34-definer-functions
  ('definer_function', 'public.action_gateway_dw_handoff(uuid,uuid)', 'PROPOSED_20261020110000_action_gateway_t34', null),
  ('definer_function', 'public.action_gateway_dw_offer_envelope(uuid,uuid)', 'PROPOSED_20261020110000_action_gateway_t34', null),
  ('definer_function', 'public.action_gateway_negotiation_state(uuid,text)', 'PROPOSED_20261020110000_action_gateway_t34', null),
  ('definer_function', 'public.action_gateway_offer_authority(text)', 'PROPOSED_20261020110000_action_gateway_t34', null),
  ('definer_function', 'public.action_gateway_receipt_get(uuid)', 'PROPOSED_20261020110000_action_gateway_t34', null),
  -- lc-action-inventory:t34-entry-points (SECURITY INVOKER)
  ('entry_point', 'public.action_gateway_authorize_envelope(uuid,text,jsonb)', 'PROPOSED_20261020110000_action_gateway_t34', null),
  ('domain_write_action', 'queue_authorized_reply', 'PROPOSED_20261020110000_action_gateway_t34', null),
  ('domain_write_action', 'submit_offer_for_approval', 'PROPOSED_20261020110000_action_gateway_t34', null),
  ('domain_write_action', 'execute_authorized_offer', 'PROPOSED_20261020110000_action_gateway_t34', null),
  ('domain_write_action', 'record_seller_counteroffer', 'PROPOSED_20261020110000_action_gateway_t34', null);

-- ───────────────────────────────────────────── 11. privileges + RLS ─────────
do $$
declare f text;
begin
  foreach f in array array['action_gateway.decode_property_ref(text)', 'action_gateway.scope_key_of(text,text)', 'action_gateway.thread_ref_of(text)',
      'action_gateway.t34_handoff_kind(text)', 'action_gateway.envelope_actions()', 'action_gateway.t34_hold_capabilities(text)', 'action_gateway.t34_capability_refusal(text)',
      'public.negotiation_send_authorization_consume(uuid,text,numeric)', 'public.seller_offers_ceiling_guard()', 'action_gateway.receipt_transition_ok(text,text)',
      'action_gateway.receipt_guard()', 'public.lc_seller_action_receipt_record(uuid,text,text,text,jsonb,text)', 'action_gateway.envelope_ref_refusal(uuid,text)',
      'public.lc_seller_action_load(uuid)', 'public.lc_seller_action_open_receipts(integer)',
      'public.action_gateway_authorize_envelope(uuid,text,jsonb)', 'public.action_gateway_receipt_get(uuid)', 'public.action_gateway_negotiation_state(uuid,text)',
      'public.action_gateway_offer_authority(text)', 'public.action_gateway_dw_handoff(uuid,uuid)', 'public.action_gateway_dw_offer_envelope(uuid,uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
revoke all on public.negotiation_send_authorization_uses from public, anon, authenticated, service_role;
revoke all on action_gateway.seller_action_receipts from public, anon, authenticated, service_role;

-- the gateway role: its entry points, its definer reads / writes, the pure helpers they call
grant execute on function public.action_gateway_authorize_envelope(uuid, text, jsonb), public.action_gateway_receipt_get(uuid),
  public.action_gateway_negotiation_state(uuid, text), public.action_gateway_offer_authority(text),
  public.action_gateway_dw_handoff(uuid, uuid), public.action_gateway_dw_offer_envelope(uuid, uuid),
  action_gateway.envelope_actions() to lc_action_gateway;
-- the receipts: no grant to the gateway role (it reads its own through action_gateway_receipt_get)
alter table action_gateway.seller_action_receipts enable row level security;
alter table action_gateway.seller_action_receipts force row level security;
-- LeadCommand's worker (backend): records receipts, consumes the budget, reads both
grant execute on function public.lc_seller_action_receipt_record(uuid, text, text, text, jsonb, text), public.negotiation_send_authorization_consume(uuid, text, numeric),
  public.lc_seller_action_load(uuid), public.lc_seller_action_open_receipts(integer) to service_role;
grant select on public.negotiation_send_authorization_uses, action_gateway.seller_action_receipts to service_role;
create policy service_role_select on action_gateway.seller_action_receipts for select to service_role using (true);
grant select on action_gateway.seller_action_receipts to authenticated;
create policy operator_read on action_gateway.seller_action_receipts for select to authenticated using (agent.can_read_org(org_id));
-- the negotiation production activation key (absent ⇒ OFF): an ADDITIONAL permissive policy, #26's allowlist untouched
create policy lc_action_gateway_select_t34 on public.system_control for select to lc_action_gateway using (key in ('negotiation_send_enabled'));

-- ───────────────────────────────────────────── 12. the apply refuses unless the composed role check is ok ──
do $$
declare v jsonb;
begin
  v := action_gateway.self_check('lc_action_gateway');
  if not coalesce((v ->> 'ok')::boolean, false) then
    raise exception 'action_gateway_t34: self-check refused the role: %', v -> 'findings';
  end if;
  if not ('execute_authorized_offer' = any (action_gateway.extension_names('domain_write_action'))) or 'execute_authorized_offer' = any (action_gateway.standing_t2_actions()) then
    raise exception 'postcondition: the extension rows';
  end if;
  if action_gateway.scope_key_of('+15555550123', '227876842') !~ '^nscope_[0-9a-f]{64}$' or action_gateway.thread_ref_of('+15555550123') !~ '^thr_[a-p]{12}$' then
    raise exception 'postcondition: scope / thread ref helpers';
  end if;
end $$;
