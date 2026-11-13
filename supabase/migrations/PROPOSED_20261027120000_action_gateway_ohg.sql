-- =============================================================================
-- PROPOSED_20261027120000_action_gateway_ohg.sql — Operation Hidden Gold, Action Gateway link #29
-- STATUS: PROPOSED. Nothing is applied or activated by this file existing. Born OFF: the four actions become callable
-- only when an owner mints standing grants for their capabilities (acquisitions.*) and T2 is in action_gateway_tiers.
-- Tested on disposable PostgreSQL 17 only (scripts/db/run-migration-test.mjs --id action_gateway_ohg).
-- =============================================================================
-- What it adds, after links #26 (the gateway), #27 (T2 + the extension registry) and #28 (T3 / T4 + receipts):
--   1. action_gateway.lead_annotations — an append-only, attributed ledger of what agents record on a seller thread:
--      conversation intelligence (interest, objections, context, next steps, data conflicts, correction proposals) and
--      seller-stated facts BOUND to the inbound message that states them. Masked text only (the gateway cleans it;
--      agent.payload_is_clean is re-checked here). Never a pipeline field, never message text verbatim.
--   2. public.action_gateway_dw_ohg(uuid,uuid) — ONE lease-bound SECURITY DEFINER domain write for the family:
--        set_lead_temperature / update_lead_status → the hold registry (ai_action), then a HANDOFF: ONE runtime job of
--          the ONE executor kind action_gateway.execute (the same kind and receipt as link #28); LeadCommand's worker
--          runs the canonical lead-state registry (patchUniversalLeadState, change_source 'ai'). The receipt table's
--          action set is widened for these two (the only schema change to a #28 object; restored by the rollback).
--        record_conversation_note → an annotation (immediate, in this transaction).
--        record_seller_statement → the database verifies the inbound message is this thread's and inbound and, for a
--          price, that the amount is in the seller's words; then an annotation.
--      Authority: a standing grant (T2, reversible: registered below as standing_t2_action rows) or a per-use approval.
--   3. public.action_gateway_reply_status(uuid,integer) and public.action_gateway_annotations(uuid,integer) —
--      definer reads for the gateway role: the receipts of the replies agents queued on a thread joined to their
--      queue rows (queued ≠ sent ≠ delivered), and the annotations.
--   4. The #27 registry rows (definer functions, standing T2 actions with their basis, domain-write actions). The
--      self-check, standing_t2_actions() and action_gateway_complete bodies are NOT edited (the #27 rule).
-- Privileges: lc_action_gateway executes exactly the four functions; nothing else changes.
-- Rollback: PROPOSED_20261027120000_action_gateway_ohg_rollback.sql (refuses while an OHG intent or receipt is open).

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
begin
  if to_regnamespace('action_gateway') is null or to_regprocedure('action_gateway.dw_begin(uuid,uuid,text[])') is null then raise exception 'precondition: link #26 (action_gateway) is not applied'; end if;
  if to_regclass('action_gateway.extensions') is null then raise exception 'precondition: link #27 (the extension registry) is not applied'; end if;
  if to_regclass('action_gateway.seller_action_receipts') is null then raise exception 'precondition: link #28 (receipts) is not applied'; end if;
  if to_regclass('action_gateway.lead_annotations') is not null then raise exception 'precondition: this link is already applied'; end if;
  if to_regclass('public.inbox_thread_state') is null or to_regclass('public.message_events') is null or to_regclass('public.send_queue') is null then raise exception 'precondition: LeadCommand base tables missing'; end if;
end $$;

-- ───────────────────────────────────────────── 1. the annotation ledger ──
create table action_gateway.lead_annotations (
  annotation_id      uuid primary key default gen_random_uuid(),
  org_id             uuid not null references agent.org (org_id),
  intent_id          uuid not null references action_gateway.action_intents (intent_id),
  agent_id           text not null,
  thread_id          uuid not null,
  thread_key         text not null,
  property_id        text,
  kind               text not null check (kind in ('seller_interest','objection','context','next_step','data_conflict','correction_proposal','asking_price','timeline','condition','ownership','decision_maker')),
  class              text not null check (class in ('note','seller_statement')),
  inbound_message_id text,
  value              text check (value is null or length(value) <= 160),
  amount             numeric(14,2) check (amount is null or amount > 0),
  note               text check (note is null or length(note) <= 600),
  payload            jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 4000 and agent.payload_is_clean(payload)),
  created_at         timestamptz not null default clock_timestamp()
);
create index lead_annotations_thread_idx on action_gateway.lead_annotations (org_id, thread_id, created_at desc);
create unique index lead_annotations_intent_uq on action_gateway.lead_annotations (intent_id);
comment on table action_gateway.lead_annotations is 'Operation Hidden Gold: what agents record on a seller thread — conversation intelligence and seller-stated facts bound to the inbound message that states them. Append-only; written only by public.action_gateway_dw_ohg under an authorized intent; masked text only.';
-- append-only: no update, no delete (an annotation is corrected by a later annotation)
create function action_gateway.lead_annotations_immutable() returns trigger language plpgsql set search_path = pg_catalog as $fn$
begin raise exception 'lead_annotations is append-only' using errcode = '55000'; end $fn$;
create trigger lead_annotations_immutable before update or delete on action_gateway.lead_annotations for each row execute function action_gateway.lead_annotations_immutable();
alter table action_gateway.lead_annotations enable row level security;
revoke all on action_gateway.lead_annotations from public, anon, authenticated, service_role;

-- ───────────────────────────────────────────── 2. the receipts' action set (widened; restored by the rollback) ──
create table action_gateway.ohg_restore (key text primary key, value text not null);
revoke all on action_gateway.ohg_restore from public, anon, authenticated, service_role;
do $$
declare c record;
begin
  select conname, pg_get_constraintdef(oid) as def into c from pg_constraint
   where conrelid = 'action_gateway.seller_action_receipts'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''queue_authorized_reply''%' limit 1;
  if c.conname is null then raise exception 'precondition: the receipts action check is not where link #28 put it'; end if;
  insert into action_gateway.ohg_restore (key, value) values ('receipts_action_check_name', c.conname), ('receipts_action_check_def', c.def);
  execute format('alter table action_gateway.seller_action_receipts drop constraint %I', c.conname);
  execute format('alter table action_gateway.seller_action_receipts add constraint %I check (action in (''queue_authorized_reply'', ''execute_authorized_offer'', ''record_seller_counteroffer'', ''set_lead_temperature'', ''update_lead_status''))', c.conname);
end $$;

-- ───────────────────────────────────────────── 3. the domain write ──
create function public.action_gateway_dw_ohg(p_intent_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare
  b jsonb; i action_gateway.action_intents%rowtype; v_auth action_gateway.action_authorizations%rowtype;
  v_thread uuid; v_tk text; v_pid text; v_sponsor text; r jsonb; v_field text; v_to text; m record; v_digits text; v_body text; v_k text; v_id uuid; v_kind text;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['set_lead_temperature', 'update_lead_status', 'record_conversation_note', 'record_seller_statement']);
  if b ? 'refused' then return b -> 'outcome'; end if;
  i := jsonb_populate_record(null::action_gateway.action_intents, b -> 'intent');
  v_sponsor := b ->> 'sponsor_user_id';
  begin
    select * into v_auth from action_gateway.action_authorizations where intent_id = i.intent_id;
    -- authority: the standing grant the authorization admitted (T2, registered reversible) or a per-use approval
    if v_auth.authorization_id is null or (v_auth.grant_id is null and v_auth.approval_id is null) then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'STANDING_GRANT_OR_APPROVAL_REQUIRED', '{}'::jsonb);
    end if;
    v_thread := (i.params ->> 'thread_id')::uuid;
    select t.thread_key, t.property_id into v_tk, v_pid from public.inbox_thread_state t where t.id = v_thread for share;
    if v_tk is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'THREAD_NOT_FOUND', '{}'::jsonb); end if;

    if i.action in ('set_lead_temperature', 'update_lead_status') then
      -- THE hold registry: an active ai_action hold on the thread / property refuses (pipeline labels are automation)
      if exists (select 1 from public.automation_hold_for(v_tk, v_thread, v_pid, null, null, null) h
                  where coalesce(cardinality(h.blocked_capabilities), 0) = 0 or h.blocked_capabilities && array['ai_action']::text[]) then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'AUTOMATION_HOLD', jsonb_build_object('stage', 'execution'));
      end if;
      v_field := case when i.action = 'set_lead_temperature' then 'lead_temperature' else 'operational_status' end;
      v_to := i.params ->> v_field;
      if v_to is null or v_to = '' then return action_gateway.finish_intent(i.intent_id, 'refused', 'PARAMS_INVALID', '{}'::jsonb); end if;
      -- the handoff: ONE runtime job of the ONE executor kind, accountable to the human sponsor (as link #28)
      r := agent.runtime_enqueue('action_gateway.execute', encode(sha256(convert_to('action_gateway:' || i.intent_id::text, 'UTF8')), 'hex'),
                                 jsonb_build_object('action_intent_id', i.intent_id, 'requested_via', 'action_gateway'), v_sponsor, 40, 3, 0, false, null);
      if coalesce((r ->> 'ok')::boolean, false) is not true then
        raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_HANDOFF_ENQUEUE_REFUSED: ' || coalesce(r ->> 'reason', 'unknown');
      end if;
      insert into action_gateway.seller_action_receipts (intent_id, org_id, action, runtime_kind, job_id, state)
      values (i.intent_id, i.org_id, i.action, 'action_gateway.execute', r ->> 'job_id', 'requested')
      on conflict (intent_id) do nothing;
      return action_gateway.finish_intent(i.intent_id, 'succeeded', 'HANDOFF_QUEUED',
                                          jsonb_build_object('job_id', r ->> 'job_id', 'runtime_kind', 'action_gateway.execute', 'deduped', coalesce((r ->> 'deduped')::boolean, false),
                                                             'receipt', 'requested', 'field', v_field, 'to', v_to));
    elsif i.action = 'record_conversation_note' then
      v_kind := i.params ->> 'kind';
      insert into action_gateway.lead_annotations (org_id, intent_id, agent_id, thread_id, thread_key, property_id, kind, class, inbound_message_id, note, payload)
      values (i.org_id, i.intent_id, i.agent_id, v_thread, v_tk, v_pid, v_kind, 'note', nullif(i.params ->> 'evidence_message_id', ''), i.params ->> 'note',
              jsonb_build_object('kind', v_kind, 'evidence_message_id', nullif(i.params ->> 'evidence_message_id', '')))
      returning annotation_id into v_id;
      return action_gateway.finish_intent(i.intent_id, 'succeeded', 'ANNOTATION_RECORDED', jsonb_build_object('annotation_id', v_id, 'kind', v_kind, 'class', 'note'));
    else
      -- record_seller_statement: bound to the seller's own inbound message; a price must be in the seller's words
      select e.id, e.thread_key, e.direction, e.message_body into m from public.message_events e where e.id::text = (i.params ->> 'inbound_message_id') limit 1;
      if m.id is null or m.thread_key is distinct from v_tk or lower(coalesce(m.direction, '')) <> 'inbound' then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'STATEMENT_NOT_BOUND_TO_INBOUND', jsonb_build_object('inbound_message_id', i.params ->> 'inbound_message_id'));
      end if;
      v_kind := i.params ->> 'kind';
      if v_kind = 'asking_price' then
        if (i.params ->> 'amount') is null then return action_gateway.finish_intent(i.intent_id, 'refused', 'AMOUNT_REQUIRED', '{}'::jsonb); end if;
        v_digits := round((i.params ->> 'amount')::numeric)::bigint::text;
        v_body := regexp_replace(coalesce(m.message_body, ''), '[,\s$]', '', 'g');
        v_k := regexp_replace(v_digits, '000$', 'k');
        if position(v_digits in v_body) = 0 and (v_k = v_digits or v_body !~* (v_k || '(?![0-9])')) then
          return action_gateway.finish_intent(i.intent_id, 'refused', 'AMOUNT_NOT_IN_SELLER_WORDS', jsonb_build_object('amount', (i.params ->> 'amount')::numeric));
        end if;
      end if;
      insert into action_gateway.lead_annotations (org_id, intent_id, agent_id, thread_id, thread_key, property_id, kind, class, inbound_message_id, value, amount, note, payload)
      values (i.org_id, i.intent_id, i.agent_id, v_thread, v_tk, v_pid, v_kind, 'seller_statement', m.id::text, i.params ->> 'value', nullif(i.params ->> 'amount', '')::numeric, i.params ->> 'note',
              jsonb_build_object('kind', v_kind, 'inbound_message_id', m.id::text, 'bound', true))
      returning annotation_id into v_id;
      return action_gateway.finish_intent(i.intent_id, 'succeeded', 'STATEMENT_RECORDED', jsonb_build_object('annotation_id', v_id, 'kind', v_kind, 'class', 'seller_statement', 'inbound_message_id', m.id::text));
    end if;
  exception when others then
    return action_gateway.finish_intent(i.intent_id, 'failed', case when sqlerrm like 'ACTION_GATEWAY_HANDOFF_ENQUEUE_REFUSED%' then 'ENQUEUE_REFUSED' else 'DOMAIN_WRITE_FAILED' end,
                                        jsonb_build_object('sqlstate', sqlstate));
  end;
end
$fn$;
comment on function public.action_gateway_dw_ohg(uuid, uuid) is 'Operation Hidden Gold (link #29): the lease-bound domain write of the acquisitions family — lead-state handoffs (set_lead_temperature, update_lead_status) and annotations (record_conversation_note, record_seller_statement). Reads its parameters from the authorized intent only.';

-- ───────────────────────────────────────────── 4. the definer reads ──
create function public.action_gateway_reply_status(p_thread_id uuid, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select coalesce(jsonb_agg(x order by (x ->> 'created_at') desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'intent_id', i.intent_id, 'action', i.action, 'agent_id', i.agent_id, 'created_at', i.created_at, 'intent_state', i.state,
      'receipt_state', r.state, 'receipt_code', r.code, 'queue_row_id', r.queue_row_id,
      'queue_status', q.queue_status, 'scheduled_for', q.scheduled_for, 'sent_at', q.sent_at, 'delivered_at', q.delivered_at,
      'delivery_status', case when q.delivered_at is not null then 'delivered' when q.sent_at is not null or q.queue_status in ('sent', 'delivered') then 'sent' when q.id is null then null else 'not_sent' end,
      'failed_reason', q.failed_reason, 'provider_message_id', case when q.provider_message_id is null then null else 'present' end) as x
    from action_gateway.action_intents i
    left join action_gateway.seller_action_receipts r on r.intent_id = i.intent_id
    left join public.send_queue q on q.id::text = r.queue_row_id
    where (i.params ->> 'thread_id') = p_thread_id::text
      and i.action in ('queue_authorized_reply', 'execute_authorized_offer', 'set_lead_temperature', 'update_lead_status')
    order by i.created_at desc
    limit greatest(1, least(coalesce(p_limit, 20), 50))) s
$fn$;
create function public.action_gateway_annotations(p_thread_id uuid, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select coalesce(jsonb_agg(to_jsonb(a) - 'payload' order by a.created_at desc), '[]'::jsonb)
    from (select annotation_id, intent_id, agent_id, thread_id, kind, class, inbound_message_id, value, amount, note, created_at
            from action_gateway.lead_annotations where thread_id = p_thread_id order by created_at desc limit greatest(1, least(coalesce(p_limit, 50), 200))) a
$fn$;

-- ───────────────────────────────────────────── 5. the registry rows (#27) ──
-- The four actions are standing T2 actions with basis 'reversible' (the registry's vocabulary): a temperature or an
-- operational status set through the canonical registry is reverted by a later set (an operator lock is final and
-- refuses); an annotation is append-only and corrected by a later annotation; none of them is anything a seller sees.
insert into action_gateway.extensions (kind, name, link, basis) values
  ('definer_function', 'public.action_gateway_dw_ohg(uuid,uuid)', 'PROPOSED_20261027120000_action_gateway_ohg', null),
  ('definer_function', 'public.action_gateway_reply_status(uuid,integer)', 'PROPOSED_20261027120000_action_gateway_ohg', null),
  ('definer_function', 'public.action_gateway_annotations(uuid,integer)', 'PROPOSED_20261027120000_action_gateway_ohg', null),
  ('standing_t2_action', 'set_lead_temperature', 'PROPOSED_20261027120000_action_gateway_ohg', 'reversible'),
  ('standing_t2_action', 'update_lead_status', 'PROPOSED_20261027120000_action_gateway_ohg', 'reversible'),
  ('standing_t2_action', 'record_conversation_note', 'PROPOSED_20261027120000_action_gateway_ohg', 'reversible'),
  ('standing_t2_action', 'record_seller_statement', 'PROPOSED_20261027120000_action_gateway_ohg', 'reversible'),
  ('domain_write_action', 'set_lead_temperature', 'PROPOSED_20261027120000_action_gateway_ohg', null),
  ('domain_write_action', 'update_lead_status', 'PROPOSED_20261027120000_action_gateway_ohg', null),
  ('domain_write_action', 'record_conversation_note', 'PROPOSED_20261027120000_action_gateway_ohg', null),
  ('domain_write_action', 'record_seller_statement', 'PROPOSED_20261027120000_action_gateway_ohg', null);

-- ───────────────────────────────────────────── 6. privileges ──
do $$
declare f text;
begin
  foreach f in array array['public.action_gateway_dw_ohg(uuid,uuid)', 'public.action_gateway_reply_status(uuid,integer)', 'public.action_gateway_annotations(uuid,integer)', 'action_gateway.lead_annotations_immutable()'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'lc_action_gateway') then
    grant execute on function public.action_gateway_dw_ohg(uuid,uuid) to lc_action_gateway;
    grant execute on function public.action_gateway_reply_status(uuid,integer) to lc_action_gateway;
    grant execute on function public.action_gateway_annotations(uuid,integer) to lc_action_gateway;
  end if;
end $$;
