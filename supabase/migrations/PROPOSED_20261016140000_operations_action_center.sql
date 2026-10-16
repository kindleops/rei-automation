-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- LeadCommand 8.5.20 part C — historical opportunity recovery, Inbound Action Center,
-- pipeline reconciliation and the operations supervisor: their READ MODEL.
--
-- APPLY IN ONE TRANSACTION (no BEGIN/COMMIT inside, so the runner can wrap it):
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261016140000_operations_action_center.sql
-- Pretest:  PROPOSED_20261016140000_operations_action_center_pretest.sql
-- Posttest: PROPOSED_20261016140000_operations_action_center_posttest.sql
-- Rollback: PROPOSED_20261016140000_operations_action_center_rollback.sql
-- ORDER: after PROPOSED_20261012140000_intel_runtime.sql (R2 runtime, agent.runtime_leased),
--        PROPOSED_20261013120000_agent_capabilities.sql (agent.approval_request) and
--        PROPOSED_20261014120000_persistent_missions.sql.
--
-- WHAT IT ADDS (schema agent only; nothing in public is created, altered or written):
--   1. agent.conversation_action_state — one durable operational state per conversation
--      (inbox_thread_state.id): exactly one of nine states, owner, verified stage, next
--      action, due date, priority reason, evidence refs, pending approvals, lost flag.
--      Written ONLY by agent.ops_action_state_upsert, bound to the lease of a running
--      inbox.action_center runtime job.
--   2. agent.ops_work_item — durable review / remediation / escalation items (recovery,
--      lost conversations, pipeline mismatches, supervisor). Written ONLY by
--      agent.ops_work_item_sync (lease-bound, per scope) and agent.ops_work_item_decide
--      (a named operator acknowledges / resolves / dismisses / reopens).
--   3. Four READ functions (STABLE, SECURITY DEFINER, pinned search_path, bounded) over
--      public tables agent_api cannot read directly:
--        agent.ops_conversation_facts(after_at, after_id, limit)   ≤ 500 conversations with ≥ 1 inbound
--        agent.ops_pipeline_facts(after_id, limit)                 ≤ 500 live opportunities
--        agent.ops_supervisor_snapshot(now)                        one aggregate row
--        agent.ops_brief_facts(since, until)                       one aggregate row (ids ≤ 20 per list)
--      Their SQL is the exact text of apps/api/src/lib/agent/operations/operations-sql.js
--      (tests/critical/operations-sql-drift.test.mjs). No phone, name, address or message
--      body leaves them: a conversation is its inbox_thread_state.id.
--   4. agent.v_action_center_queue — the ACTIVE queue (state needs_attention).
-- Every jsonb column carries agent.payload_is_clean (no phones / bodies / credentials).
-- NOTHING here can send, queue, schedule or change a stage: there is no write to public.
-- ════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ── 1. action center read model ──────────────────────────────────────────────
create table agent.conversation_action_state (
  conversation_id uuid primary key,
  org_id uuid not null references agent.org(org_id),
  state text not null check (state in ('needs_attention', 'ai_handling', 'researching', 'negotiating', 'awaiting_operator_decision',
                                       'scheduled_follow_up', 'waiting_on_seller', 'resolved', 'suppressed_ineligible')),
  owner text not null check (owner ~ '^[a-z_]{2,30}$'),
  verified_stage text check (verified_stage is null or verified_stage ~ '^[a-z_]{2,40}$'),
  stage_verified boolean not null,
  stage_note text check (stage_note is null or stage_note ~ '^[a-z_]{2,80}$'),
  next_action text not null check (length(next_action) between 1 and 160 and agent.payload_is_clean(jsonb_build_object('next_action', next_action))),
  due_at timestamptz,
  priority_reason text not null check (length(priority_reason) between 1 and 300 and agent.payload_is_clean(jsonb_build_object('priority_reason', priority_reason))),
  evidence_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_refs) = 'array' and jsonb_array_length(evidence_refs) <= 20 and octet_length(evidence_refs::text) <= 4000 and agent.payload_is_clean(evidence_refs)),
  pending_approvals jsonb not null default '[]'::jsonb check (jsonb_typeof(pending_approvals) = 'array' and jsonb_array_length(pending_approvals) <= 10 and agent.payload_is_clean(jsonb_build_object('approval_ids', pending_approvals))),
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array' and jsonb_array_length(reasons) <= 12 and octet_length(reasons::text) <= 2000 and agent.payload_is_clean(reasons)),
  lost boolean not null default false,
  opportunity_id uuid,
  property_ref text check (property_ref is null or (length(property_ref) <= 40 and agent.payload_is_clean(jsonb_build_object('property_ref', property_ref)))),
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  derived_from jsonb not null default '{}'::jsonb check (jsonb_typeof(derived_from) = 'object' and octet_length(derived_from::text) <= 2000 and agent.payload_is_clean(derived_from)),
  state_since timestamptz not null,
  computed_at timestamptz not null,
  job_id text not null,
  version text not null check (version ~ '^[a-z][a-z0-9_.-]{1,40}$'),
  check (lost = false or state = 'needs_attention'),
  check (state not in ('scheduled_follow_up', 'negotiating') or due_at is not null)
);
create index conversation_action_state_state_due_idx on agent.conversation_action_state (state, due_at);
create index conversation_action_state_lost_idx on agent.conversation_action_state (computed_at desc) where lost;
create index conversation_action_state_opportunity_idx on agent.conversation_action_state (opportunity_id) where opportunity_id is not null;
comment on table agent.conversation_action_state is 'Inbound Action Center (8.5.20 C): one operational state per conversation (public.inbox_thread_state.id), derived from real events by the inbox.action_center runtime job. The unread flag, the inbox bucket and the archive flag are not inputs. Written only by agent.ops_action_state_upsert.';

create or replace view agent.v_action_center_queue with (security_barrier = true) as
  select * from agent.conversation_action_state where state = 'needs_attention';
comment on view agent.v_action_center_queue is 'The ACTIVE queue: conversations whose next action is neither assigned, scheduled nor completed.';

-- ── 2. work items ────────────────────────────────────────────────────────────
create table agent.ops_work_item (
  work_item_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agent.org(org_id),
  scope text not null check (scope in ('recovery', 'action_center', 'pipeline', 'supervisor')),
  kind text not null check (kind in ('recovery_research', 'recovery_followup', 'recovery_review', 'lost_conversation', 'pipeline_mismatch', 'remediation', 'escalation')),
  dedupe_key text not null check (dedupe_key ~ '^[a-z][a-z0-9_.:-]{2,120}$'),
  state text not null default 'open' check (state in ('open', 'acknowledged', 'resolved', 'dismissed')),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  escalated boolean not null default false,
  title text not null check (length(title) between 1 and 200 and agent.payload_is_clean(jsonb_build_object('title', title))),
  subject_type text not null check (subject_type in ('conversation', 'opportunity', 'system')),
  subject_id text check (subject_id is null or subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or subject_id ~ '^[a-z][a-z0-9_.:-]{1,80}$'),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 8000 and agent.payload_is_clean(detail)),
  priority integer not null default 0 check (priority between 0 and 1000),
  due_at timestamptz,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  seen_count integer not null default 1 check (seen_count >= 1),
  source_job_id text,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolved_by text check (resolved_by is null or resolved_by ~ '^auto:[a-z_]{2,40}$' or resolved_by ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (org_id, dedupe_key),
  check ((state in ('resolved', 'dismissed')) = (resolved_at is not null)),
  check (state <> 'acknowledged' or acknowledged_by is not null)
);
create index ops_work_item_open_idx on agent.ops_work_item (org_id, state, severity, priority desc) where state in ('open', 'acknowledged');
create index ops_work_item_subject_idx on agent.ops_work_item (subject_type, subject_id);
create index ops_work_item_resolved_idx on agent.ops_work_item (resolved_at desc) where resolved_at is not null;
comment on table agent.ops_work_item is 'Operations work items (8.5.20 C): recovery review items, lost conversations, pipeline mismatches, supervisor remediation and escalations. Durable, de-duplicated per (org, dedupe_key). A work item never sends anything; acting on one goes through the existing services and approvals.';

-- ── 3. lease-bound writers (runtime jobs only) ───────────────────────────────
create or replace function agent.ops_scope_of_kind(p_kind text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case p_kind when 'recovery.sweep' then 'recovery' when 'inbox.action_center' then 'action_center'
                     when 'pipeline.reconcile' then 'pipeline' when 'ops.supervisor' then 'supervisor' else null end
$$;

create or replace function agent.ops_action_state_upsert(p_job_id text, p_token uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare j agent.research_job%rowtype; r jsonb; v_n int := 0; v_changed int := 0; v_prev text;
begin
  j := agent.runtime_leased(p_job_id, p_token);
  if j.job_id is null or j.state <> 'running' then return jsonb_build_object('ok', false, 'reason', 'lease_lost'); end if;
  if j.kind <> 'inbox.action_center' then return jsonb_build_object('ok', false, 'reason', 'kind_not_allowed'); end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then return jsonb_build_object('ok', false, 'reason', 'rows_invalid'); end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    select state into v_prev from agent.conversation_action_state where conversation_id = (r ->> 'conversation_id')::uuid;
    insert into agent.conversation_action_state as s (conversation_id, org_id, state, owner, verified_stage, stage_verified, stage_note, next_action, due_at,
                                                      priority_reason, evidence_refs, pending_approvals, reasons, lost, opportunity_id, property_ref,
                                                      last_inbound_at, last_outbound_at, derived_from, state_since, computed_at, job_id, version)
    values ((r ->> 'conversation_id')::uuid, j.org_id, r ->> 'state', r ->> 'owner', r ->> 'verified_stage', coalesce((r ->> 'stage_verified')::boolean, false),
            r ->> 'stage_note', r ->> 'next_action', (r ->> 'due_at')::timestamptz, r ->> 'priority_reason', coalesce(r -> 'evidence_refs', '[]'::jsonb),
            coalesce(r -> 'pending_approvals', '[]'::jsonb), coalesce(r -> 'reasons', '[]'::jsonb), coalesce((r ->> 'lost')::boolean, false),
            (r ->> 'opportunity_id')::uuid, r ->> 'property_ref', (r ->> 'last_inbound_at')::timestamptz, (r ->> 'last_outbound_at')::timestamptz,
            coalesce(r -> 'derived_from', '{}'::jsonb), clock_timestamp(), clock_timestamp(), j.job_id, r ->> 'version')
    on conflict (conversation_id) do update set
      state = excluded.state, owner = excluded.owner, verified_stage = excluded.verified_stage, stage_verified = excluded.stage_verified,
      stage_note = excluded.stage_note, next_action = excluded.next_action, due_at = excluded.due_at, priority_reason = excluded.priority_reason,
      evidence_refs = excluded.evidence_refs, pending_approvals = excluded.pending_approvals, reasons = excluded.reasons, lost = excluded.lost,
      opportunity_id = excluded.opportunity_id, property_ref = excluded.property_ref, last_inbound_at = excluded.last_inbound_at,
      last_outbound_at = excluded.last_outbound_at, derived_from = excluded.derived_from,
      state_since = case when s.state = excluded.state then s.state_since else excluded.computed_at end,
      computed_at = excluded.computed_at, job_id = excluded.job_id, version = excluded.version;
    v_n := v_n + 1;
    if v_prev is distinct from (r ->> 'state') then v_changed := v_changed + 1; end if;
  end loop;
  perform agent.runtime_emit(j, 'job.step', j.lease_owner, jsonb_build_object('step', 'action_state_upsert', 'rows', v_n, 'changed', v_changed));
  return jsonb_build_object('ok', true, 'upserted', v_n, 'changed', v_changed);
end
$$;

create or replace function agent.ops_work_item_sync(p_job_id text, p_token uuid, p_items jsonb, p_close_missing boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare j agent.research_job%rowtype; v_scope text; r jsonb; v_ins int := 0; v_upd int := 0; v_reopen int := 0; v_res int := 0; v_state text; v_keys text[] := array[]::text[]; v_cnt int;
begin
  j := agent.runtime_leased(p_job_id, p_token);
  if j.job_id is null or j.state <> 'running' then return jsonb_build_object('ok', false, 'reason', 'lease_lost'); end if;
  v_scope := agent.ops_scope_of_kind(j.kind);
  if v_scope is null then return jsonb_build_object('ok', false, 'reason', 'kind_not_allowed'); end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then return jsonb_build_object('ok', false, 'reason', 'items_invalid'); end if;
  for r in select * from jsonb_array_elements(p_items) loop
    -- the dedupe key always carries the scope: one scope never touches another's items
    if (r ->> 'dedupe_key') !~ ('^' || v_scope || ':') then return jsonb_build_object('ok', false, 'reason', 'dedupe_key_outside_scope'); end if;
    if coalesce((r ->> 'resolve')::boolean, false) then
      update agent.ops_work_item set state = 'resolved', resolved_at = clock_timestamp(), resolved_by = 'auto:condition_cleared', updated_at = clock_timestamp()
       where org_id = j.org_id and dedupe_key = r ->> 'dedupe_key' and state in ('open', 'acknowledged');
      get diagnostics v_cnt = row_count; v_res := v_res + v_cnt;
      continue;
    end if;
    v_keys := v_keys || (r ->> 'dedupe_key');
    select state into v_state from agent.ops_work_item where org_id = j.org_id and dedupe_key = r ->> 'dedupe_key';
    if v_state is null then
      insert into agent.ops_work_item (org_id, scope, kind, dedupe_key, severity, escalated, title, subject_type, subject_id, detail, priority, due_at, source_job_id)
      values (j.org_id, v_scope, r ->> 'kind', r ->> 'dedupe_key', coalesce(r ->> 'severity', 'info'), coalesce((r ->> 'escalated')::boolean, false), r ->> 'title',
              r ->> 'subject_type', r ->> 'subject_id', coalesce(r -> 'detail', '{}'::jsonb), coalesce((r ->> 'priority')::int, 0), (r ->> 'due_at')::timestamptz, j.job_id);
      v_ins := v_ins + 1;
    else
      update agent.ops_work_item set
        kind = r ->> 'kind', severity = coalesce(r ->> 'severity', severity), escalated = coalesce((r ->> 'escalated')::boolean, escalated), title = r ->> 'title',
        detail = coalesce(r -> 'detail', detail), priority = coalesce((r ->> 'priority')::int, priority), due_at = (r ->> 'due_at')::timestamptz,
        last_seen_at = clock_timestamp(), seen_count = seen_count + 1, source_job_id = j.job_id, updated_at = clock_timestamp(),
        -- a condition that recurs after an AUTOMATIC resolution reopens; an operator's resolve / dismiss stands
        state = case when state = 'resolved' and resolved_by like 'auto:%' then 'open' else state end,
        resolved_at = case when state = 'resolved' and resolved_by like 'auto:%' then null else resolved_at end,
        resolved_by = case when state = 'resolved' and resolved_by like 'auto:%' then null else resolved_by end
       where org_id = j.org_id and dedupe_key = r ->> 'dedupe_key';
      if v_state = 'resolved' then v_reopen := v_reopen + 1; else v_upd := v_upd + 1; end if;
    end if;
  end loop;
  if p_close_missing then
    update agent.ops_work_item set state = 'resolved', resolved_at = clock_timestamp(), resolved_by = 'auto:condition_cleared', updated_at = clock_timestamp()
     where org_id = j.org_id and scope = v_scope and state in ('open', 'acknowledged') and not (dedupe_key = any (v_keys));
    get diagnostics v_cnt = row_count; v_res := v_res + v_cnt;
  end if;
  perform agent.runtime_emit(j, 'job.step', j.lease_owner, jsonb_build_object('step', 'work_item_sync', 'scope', v_scope, 'inserted', v_ins, 'updated', v_upd, 'reopened', v_reopen, 'resolved', v_res));
  return jsonb_build_object('ok', true, 'scope', v_scope, 'inserted', v_ins, 'updated', v_upd, 'reopened', v_reopen, 'resolved', v_res);
end
$$;

-- a NAMED operator acts on a work item (the API verified the session and membership)
create or replace function agent.ops_work_item_decide(p_work_item_id uuid, p_by text, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare w agent.ops_work_item%rowtype;
begin
  if not agent.runtime_is_named_operator(p_by) then return jsonb_build_object('ok', false, 'reason', 'by_not_named_operator'); end if;
  if p_action not in ('acknowledge', 'resolve', 'dismiss', 'reopen') then return jsonb_build_object('ok', false, 'reason', 'action_invalid'); end if;
  select * into w from agent.ops_work_item where work_item_id = p_work_item_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p_action = 'acknowledge' and w.state = 'open' then
    update agent.ops_work_item set state = 'acknowledged', acknowledged_by = p_by::uuid, acknowledged_at = clock_timestamp(), updated_at = clock_timestamp() where work_item_id = w.work_item_id;
  elsif p_action in ('resolve', 'dismiss') and w.state in ('open', 'acknowledged') then
    update agent.ops_work_item set state = case p_action when 'resolve' then 'resolved' else 'dismissed' end, resolved_at = clock_timestamp(), resolved_by = p_by, updated_at = clock_timestamp() where work_item_id = w.work_item_id;
  elsif p_action = 'reopen' and w.state in ('resolved', 'dismissed') then
    update agent.ops_work_item set state = 'open', resolved_at = null, resolved_by = null, acknowledged_by = null, acknowledged_at = null, updated_at = clock_timestamp() where work_item_id = w.work_item_id;
  else
    return jsonb_build_object('ok', false, 'reason', 'transition_invalid', 'state', w.state);
  end if;
  return jsonb_build_object('ok', true, 'work_item_id', w.work_item_id, 'from', w.state, 'action', p_action);
end
$$;

-- ── 4. bounded READ functions (exact text: apps/api/src/lib/agent/operations/operations-sql.js) ──
create or replace function agent.ops_conversation_facts(p_after_at timestamptz default null, p_after_id uuid default null, p_limit integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $fn$
begin
  return (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (
/*sql:conversation_facts*/
with thr as (
  select t.id, t.thread_key, t.canonical_e164, coalesce(t.updated_at, t.created_at, timestamptz 'epoch') as cursor_at,
         t.property_id, t.market, t.seller_stage, t.disposition, t.contactability_status,
         coalesce(t.is_suppressed, false) as is_suppressed, coalesce(t.is_archived, false) as is_archived, t.archive_reason,
         coalesce(t.is_read, false) as is_read, t.inbox_bucket, t.operational_status, t.lead_temperature,
         coalesce(t.is_hot_lead, false) as is_hot_lead, t.last_intent, nullif(btrim(t.next_action), '') as next_action,
         t.next_action_at, t.follow_up_at, t.snoozed_until, coalesce(t.manual_override, false) as manual_override
    from public.inbox_thread_state t
   where t.thread_key is not null
     and ($1::timestamptz is null
          or (coalesce(t.updated_at, t.created_at, timestamptz 'epoch'), t.id) > ($1::timestamptz, coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)))
     and exists (select 1 from public.message_events m0 where m0.thread_key = t.thread_key and m0.direction = 'inbound')
   order by coalesce(t.updated_at, t.created_at, timestamptz 'epoch'), t.id
   limit least(greatest(coalesce($3::int, 200), 1), 500)
)
select thr.id::text as conversation_id, thr.cursor_at::text as cursor_at, thr.property_id, thr.market, thr.seller_stage, thr.disposition,
       thr.contactability_status, thr.is_suppressed, thr.is_archived, thr.archive_reason, thr.is_read, thr.inbox_bucket,
       thr.operational_status, thr.lead_temperature, thr.is_hot_lead, thr.last_intent, thr.next_action, thr.next_action_at,
       thr.follow_up_at, thr.snoozed_until, thr.manual_override,
       ev.inbound_count, ev.first_inbound_at, ev.any_opt_out, ev.inbound_intents,
       li.last_inbound_id, li.last_inbound_at, li.last_inbound_intent, li.last_inbound_opt_out, li.last_inbound_language,
       lm.last_meaningful_id, lm.last_meaningful_at, lm.last_meaningful_intent,
       lo.last_outbound_id, lo.last_outbound_at, lo.last_outbound_delivery, lo.last_outbound_auto,
       coalesce(oa.outbound_after_inbound, 0) as outbound_after_inbound, coalesce(oa.delivered_after_inbound, 0) as delivered_after_inbound,
       coalesce(oa.failed_after_inbound, 0) as failed_after_inbound,
       sq.pending_count, sq.next_pending_at, sq.failed_internal_after_inbound, sq.failed_provider_after_inbound, sq.held_after_inbound,
       exists (select 1 from public.sms_suppression_list s where s.phone_e164 = thr.canonical_e164 and coalesce(s.is_active, true)) as suppression_listed,
       op.opportunity_id, op.opp_stage, op.opp_status, op.opp_temperature, op.opp_priority, op.opp_next_action, op.opp_next_action_due,
       op.opp_promotion_reason, op.opp_asking_price, op.opp_current_offer, op.opp_stage_entered_at, op.opp_last_activity_at,
       coalesce(so.offers_sent, 0) as offers_sent, so.last_offer_at,
       (op.opportunity_id is not null and exists (
          select 1 from public.closing_cases c
           where c.opportunity_id = op.opportunity_id::uuid
             and lower(coalesce(c.closing_status, '')) not in ('cancelled', 'canceled', 'voided', 'void', 'terminated', 'dead')
             and lower(coalesce(c.contract_status, '')) not in ('cancelled', 'canceled', 'voided', 'void', 'terminated', 'dead'))) as live_closing_case,
       coalesce(fu.followups_active, 0) as followups_active, fu.followup_next_at,
       pas.pas_id, pas.pas_computed_at, pas.valuation_mid, pas.investor_ceiling_mid, pas.investor_ceiling_high,
       pas.minimum_acceptable_offer, pas.recommended_cash_offer, pas.buyer_demand_score
  from thr
  left join lateral (
    select count(*)::int as inbound_count,
           min(coalesce(m.event_timestamp, m.received_at, m.created_at)) as first_inbound_at,
           coalesce(bool_or(coalesce(m.is_opt_out, false) or m.detected_intent = 'opt_out'), false) as any_opt_out,
           coalesce(array_agg(distinct m.detected_intent) filter (where coalesce(m.detected_intent, '') <> ''), array[]::text[]) as inbound_intents
      from public.message_events m
     where m.thread_key = thr.thread_key and m.direction = 'inbound'
  ) ev on true
  left join lateral (
    select m.id::text as last_inbound_id, coalesce(m.event_timestamp, m.received_at, m.created_at) as last_inbound_at,
           nullif(m.detected_intent, '') as last_inbound_intent, coalesce(m.is_opt_out, false) as last_inbound_opt_out,
           nullif(m.language, '') as last_inbound_language
      from public.message_events m
     where m.thread_key = thr.thread_key and m.direction = 'inbound'
     order by coalesce(m.event_timestamp, m.received_at, m.created_at) desc, m.id desc
     limit 1
  ) li on true
  left join lateral (
    select m.id::text as last_meaningful_id, coalesce(m.event_timestamp, m.received_at, m.created_at) as last_meaningful_at,
           nullif(m.detected_intent, '') as last_meaningful_intent
      from public.message_events m
     where m.thread_key = thr.thread_key and m.direction = 'inbound'
       and coalesce(m.detected_intent, '') not in ('reaction_only', 'acknowledgement')
     order by coalesce(m.event_timestamp, m.received_at, m.created_at) desc, m.id desc
     limit 1
  ) lm on true
  left join lateral (
    select m.id::text as last_outbound_id, coalesce(m.event_timestamp, m.sent_at, m.created_at) as last_outbound_at,
           lower(coalesce(nullif(m.delivery_status, ''), nullif(m.provider_delivery_status, ''), '')) as last_outbound_delivery,
           (coalesce(m.auto_reply_status, '') <> '') as last_outbound_auto
      from public.message_events m
     where m.thread_key = thr.thread_key and m.direction = 'outbound'
     order by coalesce(m.event_timestamp, m.sent_at, m.created_at) desc, m.id desc
     limit 1
  ) lo on true
  left join lateral (
    select count(*)::int as outbound_after_inbound,
           count(*) filter (where m.delivered_at is not null or lower(coalesce(m.delivery_status, '')) = 'delivered')::int as delivered_after_inbound,
           count(*) filter (where coalesce(m.is_final_failure, false) or lower(coalesce(m.delivery_status, '')) in ('failed', 'undelivered'))::int as failed_after_inbound
      from public.message_events m
     where m.thread_key = thr.thread_key and m.direction = 'outbound'
       and coalesce(m.event_timestamp, m.sent_at, m.created_at) > li.last_inbound_at
  ) oa on true
  left join lateral (
    select count(*) filter (where lower(q.queue_status) in ('scheduled', 'queued', 'pending', 'approved', 'ready', 'processing', 'sending'))::int as pending_count,
           min(coalesce(q.scheduled_for_utc, q.scheduled_for)) filter (where lower(q.queue_status) in ('scheduled', 'queued', 'pending', 'approved', 'ready', 'processing', 'sending')) as next_pending_at,
           count(*) filter (where lower(q.queue_status) in ('failed', 'failed_transport') and q.created_at > li.last_inbound_at and q.provider_message_id is null)::int as failed_internal_after_inbound,
           count(*) filter (where lower(q.queue_status) in ('failed', 'failed_transport') and q.created_at > li.last_inbound_at and q.provider_message_id is not null)::int as failed_provider_after_inbound,
           count(*) filter (where (lower(q.queue_status) like 'blocked%' or lower(q.queue_status) like 'paused%' or lower(q.queue_status) = 'duplicate_blocked') and q.created_at > li.last_inbound_at)::int as held_after_inbound
      from public.send_queue q
     where q.thread_key = thr.thread_key
  ) sq on true
  left join lateral (
    select o.id::text as opportunity_id, o.acquisition_stage as opp_stage, o.opportunity_status as opp_status, o.temperature as opp_temperature,
           o.priority as opp_priority, nullif(btrim(o.next_action), '') as opp_next_action, o.next_action_due as opp_next_action_due,
           nullif(btrim(o.promotion_reason), '') as opp_promotion_reason, o.asking_price as opp_asking_price, o.current_offer as opp_current_offer,
           o.stage_entered_at as opp_stage_entered_at, o.last_activity_at as opp_last_activity_at
      from public.acquisition_opportunities o
     where o.primary_thread_key = thr.thread_key
     order by (lower(coalesce(o.opportunity_status, '')) in ('active', 'nurture')) desc, o.updated_at desc nulls last
     limit 1
  ) op on true
  left join lateral (
    select count(*) filter (where s.sent_at is not null and lower(coalesce(s.status, '')) in ('active', 'accepted', 'sent', 'superseded'))::int as offers_sent,
           max(s.sent_at) as last_offer_at
      from public.seller_offers s
     where s.thread_key = thr.thread_key
  ) so on true
  left join lateral (
    select count(*)::int as followups_active, min(f.next_follow_up_at) as followup_next_at
      from public.seller_followup_state f
     where f.thread_key = thr.thread_key and f.resolved_at is null and f.status in ('active', 'due')
  ) fu on true
  left join lateral (
    select p.id::text as pas_id, p.computed_at as pas_computed_at, p.valuation_mid, p.investor_ceiling_mid, p.investor_ceiling_high,
           p.minimum_acceptable_offer, p.recommended_cash_offer, p.buyer_demand_score
      from public.property_acquisition_scores p
     where thr.property_id is not null and p.property_id = thr.property_id
     order by p.computed_at desc nulls last
     limit 1
  ) pas on true
 order by thr.cursor_at, thr.id
/*end*/
  ) r);
end
$fn$;

create or replace function agent.ops_pipeline_facts(p_after_id uuid default null, p_limit integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $fn$
begin
  return (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (
/*sql:pipeline_facts*/
select o.id::text as opportunity_id, o.acquisition_stage, o.opportunity_status, o.priority, o.temperature,
       nullif(btrim(o.next_action), '') as next_action, o.next_action_due, nullif(btrim(o.promotion_reason), '') as promotion_reason,
       nullif(btrim(o.blocker), '') as blocker, o.asking_price, o.current_offer, o.estimated_value, o.arv,
       o.stage_entered_at, o.last_activity_at, o.last_contact_at, o.updated_at, o.created_at, o.primary_property_id as property_id,
       o.market, o.approval_state, (nullif(btrim(o.assigned_operator), '') is not null) as has_assigned_operator, o.latest_intent,
       t.id::text as conversation_id, t.seller_stage as thread_stage, t.last_inbound_at as thread_last_inbound_at,
       t.last_outbound_at as thread_last_outbound_at, coalesce(t.is_suppressed, false) as thread_suppressed,
       t.contactability_status as thread_contactability,
       coalesce(so.offers, '[]'::jsonb) as offer_rows,
       exists (select 1 from public.closing_cases c
                where c.opportunity_id = o.id
                  and lower(coalesce(c.closing_status, '')) not in ('cancelled', 'canceled', 'voided', 'void', 'terminated', 'dead')
                  and lower(coalesce(c.contract_status, '')) not in ('cancelled', 'canceled', 'voided', 'void', 'terminated', 'dead')) as live_closing_case,
       pas.pas_id, pas.pas_computed_at
  from public.acquisition_opportunities o
  left join public.inbox_thread_state t on t.thread_key = o.primary_thread_key
  left join lateral (
    select jsonb_agg(jsonb_build_object('offer_id', s.id::text, 'status', s.status, 'sent_at', s.sent_at, 'purchase_price', s.purchase_price,
             'policy_version', s.policy_version, 'ade_snapshot_id', s.ade_snapshot_id, 'valuation_mid', s.valuation_mid,
             'authorized_ceiling', s.authorized_ceiling, 'offer_event', s.metadata -> 'offer_event') order by s.created_at desc) as offers
      from (select * from public.seller_offers s0 where s0.opportunity_id = o.id order by s0.created_at desc limit 20) s
  ) so on true
  left join lateral (
    select p.id::text as pas_id, p.computed_at as pas_computed_at
      from public.property_acquisition_scores p
     where o.primary_property_id is not null and p.property_id = o.primary_property_id
     order by p.computed_at desc nulls last
     limit 1
  ) pas on true
 where lower(coalesce(o.opportunity_status, '')) in ('active', 'nurture')
   and ($1::uuid is null or o.id > $1::uuid)
 order by o.id
 limit least(greatest(coalesce($2::int, 200), 1), 500)
/*end*/
  ) r);
end
$fn$;

create or replace function agent.ops_supervisor_snapshot(p_now timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $fn$
begin
  return (select to_jsonb(r) from (
/*sql:supervisor_snapshot*/
with p as (select coalesce($1::timestamptz, now()) as now),
q24 as (
  select count(*)::int as created,
         count(*) filter (where lower(q.queue_status) in ('failed', 'failed_transport'))::int as failed,
         count(*) filter (where lower(q.queue_status) in ('failed', 'failed_transport') and q.provider_message_id is null)::int as failed_internal,
         count(*) filter (where lower(q.queue_status) in ('failed', 'failed_transport') and q.provider_message_id is not null)::int as failed_provider,
         count(*) filter (where lower(q.queue_status) like 'blocked%' or lower(q.queue_status) = 'duplicate_blocked')::int as blocked,
         count(*) filter (where lower(q.queue_status) like 'paused%')::int as paused,
         count(*) filter (where lower(q.queue_status) in ('failed', 'failed_transport') and lower(coalesce(q.message_type, '')) in ('followup', 'follow-up', 'reengagement', 'nurture_not_interested', 'no_response_followup'))::int as followups_failed
    from public.send_queue q, p
   where q.created_at >= p.now - interval '24 hours'
),
qreasons as (
  select coalesce(jsonb_agg(jsonb_build_object('reason', r, 'count', n) order by n desc), '[]'::jsonb) as top
    from (select regexp_replace(lower(left(coalesce(nullif(q.failed_reason, ''), q.queue_status, 'unknown'), 40)), '[0-9]', '#', 'g') as r, count(*)::int as n
            from public.send_queue q, p
           where q.created_at >= p.now - interval '24 hours' and lower(q.queue_status) in ('failed', 'failed_transport')
           group by 1 order by 2 desc limit 5) x
),
overdue as (
  select count(*)::int as n from (
    select 1 from public.send_queue q, p
     where lower(q.queue_status) in ('scheduled', 'queued', 'pending', 'approved', 'ready', 'processing', 'sending')
       and coalesce(q.scheduled_for_utc, q.scheduled_for) < p.now - interval '15 minutes'
     limit 1000) s
),
del as (
  select count(*) filter (where q.sent_at >= p.now - interval '24 hours')::int as sent_24h,
         count(*) filter (where q.sent_at >= p.now - interval '24 hours' and (q.delivered_at is not null or lower(q.queue_status) = 'delivered'))::int as delivered_24h,
         count(*) filter (where q.sent_at >= p.now - interval '24 hours' and lower(q.queue_status) in ('failed', 'failed_transport', 'undelivered'))::int as failed_24h,
         count(*) filter (where q.sent_at >= p.now - interval '7 days')::int as sent_7d,
         count(*) filter (where q.sent_at >= p.now - interval '7 days' and (q.delivered_at is not null or lower(q.queue_status) = 'delivered'))::int as delivered_7d,
         count(*) filter (where q.sent_at >= p.now - interval '7 days' and lower(q.queue_status) in ('failed', 'failed_transport', 'undelivered'))::int as failed_7d,
         count(*) filter (where q.sent_at < p.now - interval '7 days')::int as sent_prev_7d,
         count(*) filter (where q.sent_at < p.now - interval '7 days' and (q.delivered_at is not null or lower(q.queue_status) = 'delivered'))::int as delivered_prev_7d
    from public.send_queue q, p
   where q.sent_at >= p.now - interval '14 days' and q.sent_at <= p.now
),
inb as (
  select count(*) filter (where coalesce(m.event_timestamp, m.created_at) >= p.now - interval '7 days')::int as inbound_7d,
         count(*) filter (where coalesce(m.event_timestamp, m.created_at) < p.now - interval '7 days')::int as inbound_prev_7d,
         count(*) filter (where coalesce(m.event_timestamp, m.created_at) >= p.now - interval '7 days' and (coalesce(m.is_opt_out, false) or m.detected_intent = 'opt_out'))::int as opt_out_7d,
         count(*) filter (where coalesce(m.event_timestamp, m.created_at) < p.now - interval '7 days' and (coalesce(m.is_opt_out, false) or m.detected_intent = 'opt_out'))::int as opt_out_prev_7d,
         count(*) filter (where coalesce(m.event_timestamp, m.created_at) >= p.now - interval '7 days' and m.detected_intent in ('seller_interested', 'latent_interest', 'asks_offer', 'asking_price_provided', 'asking_price_implausible', 'condition_disclosed', 'callback_requested', 'contract_requested', 'need_time', 'tenant_occupied'))::int as qualified_7d
    from public.message_events m, p
   where m.direction = 'inbound' and coalesce(m.event_timestamp, m.created_at) >= p.now - interval '14 days'
     and coalesce(m.event_timestamp, m.created_at) <= p.now
),
senders as (
  select count(*)::int as numbers,
         count(*) filter (where lower(coalesce(n.status, '')) = 'active')::int as active,
         count(*) filter (where n.cooling_until is not null and n.cooling_until > p.now)::int as cooling,
         count(*) filter (where n.spam_flagged_at is not null)::int as spam_flagged
    from public.textgrid_numbers n, p
),
sender_health as (
  select coalesce(jsonb_object_agg(h, c), '{}'::jsonb) as by_health_state
    from (select coalesce(nullif(n.health_state, ''), 'unknown') as h, count(*)::int as c from public.textgrid_numbers n group by 1) x
),
sender_rates as (
  select coalesce(jsonb_agg(jsonb_build_object('sender_id', sender_id, 'health_state', health_state, 'sent_7d', sent, 'failed_7d', failed, 'delivered_7d', delivered) order by sent desc), '[]'::jsonb) as rows,
         coalesce(sum(sent) filter (where sender_id is null), 0)::int as unmatched_sent
    from (select n.id::text as sender_id, n.health_state, count(*)::int as sent,
                 count(*) filter (where lower(q.queue_status) in ('failed', 'failed_transport', 'undelivered'))::int as failed,
                 count(*) filter (where q.delivered_at is not null or lower(q.queue_status) = 'delivered')::int as delivered
            from public.send_queue q cross join p
            left join public.textgrid_numbers n on n.phone_number = q.from_phone_number
           where q.sent_at >= p.now - interval '7 days' and q.sent_at <= p.now
           group by 1, 2 order by 3 desc limit 40) x
),
campaigns as (
  select coalesce(jsonb_agg(jsonb_build_object('campaign_id', campaign_id, 'status', status, 'delivered', delivered, 'threads', threads, 'replied_threads', replied, 'qualified_threads', qualified) order by delivered desc), '[]'::jsonb) as rows
    from (select q.campaign_id::text as campaign_id, c.status,
                 count(*) filter (where q.delivered_at is not null or lower(q.queue_status) = 'delivered')::int as delivered,
                 count(distinct q.thread_key) filter (where q.delivered_at is not null or lower(q.queue_status) = 'delivered')::int as threads,
                 count(distinct q.thread_key) filter (where exists (select 1 from public.message_events m where m.thread_key = q.thread_key and m.direction = 'inbound' and coalesce(m.event_timestamp, m.created_at) > q.sent_at))::int as replied,
                 count(distinct q.thread_key) filter (where exists (select 1 from public.message_events m where m.thread_key = q.thread_key and m.direction = 'inbound' and coalesce(m.event_timestamp, m.created_at) > q.sent_at and m.detected_intent in ('seller_interested', 'latent_interest', 'asks_offer', 'asking_price_provided', 'asking_price_implausible', 'condition_disclosed', 'callback_requested', 'contract_requested', 'need_time', 'tenant_occupied')))::int as qualified
            from public.send_queue q cross join p
            left join public.campaigns c on c.id = q.campaign_id
           where q.campaign_id is not null and q.sent_at >= p.now - interval '30 days' and q.sent_at <= p.now
           group by 1, 2 order by 3 desc limit 20) x
),
revenue as (
  select count(*) filter (where c.confirmed_gross_revenue is not null)::int as closings_with_revenue,
         count(*)::int as closing_cases,
         coalesce(sum(c.confirmed_gross_revenue), 0) as confirmed_gross_revenue
    from public.closing_cases c
),
pipe as (
  select count(*)::int as live,
         count(*) filter (where o.stage_entered_at is null or o.stage_entered_at < p.now - interval '14 days')::int as stagnant_14d,
         count(*) filter (where nullif(btrim(o.next_action), '') is null)::int as missing_next_action,
         count(*) filter (where o.next_action_due is null)::int as missing_due,
         count(*) filter (where o.next_action_due < p.now)::int as overdue,
         count(*) filter (where lower(coalesce(o.temperature, '')) = 'hot')::int as hot,
         count(*) filter (where lower(coalesce(o.temperature, '')) = 'hot' and (o.next_action_due is null or o.next_action_due < p.now))::int as hot_without_current_action,
         count(*) filter (where o.primary_property_id is not null and not exists (select 1 from public.property_acquisition_scores s where s.property_id = o.primary_property_id))::int as missing_valuation,
         count(*) filter (where o.acquisition_stage in ('asking_price', 'property_condition', 'offer'))::int as negotiations,
         count(*) filter (where o.acquisition_stage in ('asking_price', 'property_condition', 'offer') and (o.last_activity_at is null or o.last_activity_at < p.now - interval '7 days'))::int as negotiations_stalled_7d
    from public.acquisition_opportunities o, p
   where lower(coalesce(o.opportunity_status, '')) in ('active', 'nurture')
),
pipe_stage as (
  select coalesce(jsonb_object_agg(stage, jsonb_build_object('live', n, 'stagnant_14d', st)), '{}'::jsonb) as by_stage
    from (select coalesce(o.acquisition_stage, 'unknown') as stage, count(*)::int as n,
                 count(*) filter (where o.stage_entered_at is null or o.stage_entered_at < p.now - interval '14 days')::int as st
            from public.acquisition_opportunities o, p
           where lower(coalesce(o.opportunity_status, '')) in ('active', 'nurture') group by 1) x
),
fups as (
  select count(*) filter (where t.follow_up_at < p.now and not exists (
            select 1 from public.send_queue q where q.thread_key = t.thread_key and lower(q.queue_status) in ('scheduled', 'queued', 'pending', 'approved', 'ready', 'processing', 'sending')))::int as expired_followup_dates,
         count(*) filter (where t.follow_up_at >= p.now)::int as scheduled_followup_dates
    from public.inbox_thread_state t, p
   where t.follow_up_at is not null and not coalesce(t.is_suppressed, false)
     and coalesce(t.contactability_status, 'contactable') not in ('opted_out', 'do_not_text', 'do_not_contact', 'invalid_number')
),
fstate as (
  select count(*) filter (where f.next_follow_up_at < p.now)::int as due, count(*)::int as active
    from public.seller_followup_state f, p
   where f.resolved_at is null and f.status in ('active', 'due')
),
hot_threads as (
  select count(*)::int as n from public.inbox_thread_state t where coalesce(t.is_hot_lead, false) and not coalesce(t.is_suppressed, false)
)
select p.now as at,
       to_jsonb(q24) || jsonb_build_object('top_failure_reasons', qreasons.top, 'overdue_pending', overdue.n) as queue,
       to_jsonb(del) as delivery,
       to_jsonb(inb) as inbound,
       to_jsonb(senders) || jsonb_build_object('by_health_state', sender_health.by_health_state, 'rates_7d', sender_rates.rows, 'unmatched_sent_7d', sender_rates.unmatched_sent) as senders,
       campaigns.rows as campaigns_30d,
       to_jsonb(revenue) as revenue,
       to_jsonb(pipe) || jsonb_build_object('by_stage', pipe_stage.by_stage) as pipeline,
       to_jsonb(fups) || jsonb_build_object('followup_state_due', fstate.due, 'followup_state_active', fstate.active) as followups,
       hot_threads.n as hot_threads
  from p, q24, qreasons, overdue, del, inb, senders, sender_health, sender_rates, campaigns, revenue, pipe, pipe_stage, fups, fstate, hot_threads
/*end*/
  ) r);
end
$fn$;

create or replace function agent.ops_brief_facts(p_since timestamptz, p_until timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $fn$
begin
  return (select to_jsonb(r) from (
/*sql:brief_facts*/
with w as (select $1::timestamptz as since, coalesce($2::timestamptz, now()) as until),
offers as (
  select count(*)::int as n, coalesce(jsonb_agg(id) filter (where rn <= 20), '[]'::jsonb) as record_ids
    from (select s.id::text as id, row_number() over (order by s.created_at desc) as rn
            from public.seller_offers s, w where s.created_at >= w.since and s.created_at < w.until) x
),
offers_sent as (
  select count(*)::int as n from public.seller_offers s, w where s.sent_at >= w.since and s.sent_at < w.until
),
advanced as (
  select count(*)::int as n, coalesce(jsonb_agg(jsonb_build_object('opportunity_id', opportunity_id, 'from', previous_value, 'to', new_value)) filter (where rn <= 20), '[]'::jsonb) as rows
    from (select h.opportunity_id::text as opportunity_id, h.previous_value, h.new_value, row_number() over (order by h.created_at desc) as rn
            from public.acquisition_opportunity_history h, w
           where h.field_name = 'acquisition_stage' and h.created_at >= w.since and h.created_at < w.until
             and h.new_value in ('asking_price', 'property_condition', 'offer', 'formal_contract', 'disposition', 'under_contract', 'prepared_to_close')) x
),
followups as (
  select count(*)::int as n, coalesce(jsonb_agg(id) filter (where rn <= 20), '[]'::jsonb) as record_ids
    from (select q.id::text as id, row_number() over (order by q.delivered_at desc) as rn
            from public.send_queue q, w
           where q.delivered_at >= w.since and q.delivered_at < w.until
             and lower(coalesce(q.message_type, '')) in ('followup', 'follow-up', 'reengagement', 'nurture_not_interested', 'no_response_followup')) x
),
campaign_changes as (
  select count(*)::int as n, coalesce(jsonb_agg(jsonb_build_object('campaign_id', id, 'status', status, 'from', last_transition_from)) filter (where rn <= 20), '[]'::jsonb) as rows
    from (select c.id::text as id, c.status, c.last_transition_from, row_number() over (order by c.last_transition_at desc) as rn
            from public.campaigns c, w where c.last_transition_at >= w.since and c.last_transition_at < w.until) x
),
sender_changes as (
  select count(*)::int as n, coalesce(jsonb_agg(jsonb_build_object('sender_id', id, 'health_state', health_state)) filter (where rn <= 20), '[]'::jsonb) as rows
    from (select n.id::text as id, n.health_state, row_number() over (order by n.health_changed_at desc) as rn
            from public.textgrid_numbers n, w where n.health_changed_at >= w.since and n.health_changed_at < w.until) x
),
inbound as (
  select count(*)::int as n,
         count(*) filter (where m.detected_intent in ('seller_interested', 'latent_interest', 'asks_offer', 'asking_price_provided', 'asking_price_implausible', 'condition_disclosed', 'callback_requested', 'contract_requested', 'need_time', 'tenant_occupied'))::int as qualified
    from public.message_events m, w
   where m.direction = 'inbound' and coalesce(m.event_timestamp, m.created_at) >= w.since and coalesce(m.event_timestamp, m.created_at) < w.until
)
select w.since, w.until,
       jsonb_build_object('count', offers.n, 'record_ids', offers.record_ids, 'sent', offers_sent.n) as offers_prepared,
       jsonb_build_object('count', advanced.n, 'rows', advanced.rows) as negotiations_advanced,
       jsonb_build_object('count', followups.n, 'record_ids', followups.record_ids) as followups_completed,
       jsonb_build_object('count', campaign_changes.n, 'rows', campaign_changes.rows) as campaign_changes,
       jsonb_build_object('count', sender_changes.n, 'rows', sender_changes.rows) as sender_changes,
       jsonb_build_object('count', inbound.n, 'qualified', inbound.qualified) as inbound
  from w, offers, offers_sent, advanced, followups, campaign_changes, sender_changes, inbound
/*end*/
  ) r);
end
$fn$;

comment on function agent.ops_conversation_facts(timestamptz, uuid, integer) is 'Operations read model: ≤ 500 conversations with ≥ 1 inbound message, keyset on (updated_at, id). Ids only, no contact values or message text.';

-- ── 5. grants: revoke every new function from everyone, then grant by name ───
revoke all on function agent.ops_scope_of_kind(text), agent.ops_action_state_upsert(text, uuid, jsonb), agent.ops_work_item_sync(text, uuid, jsonb, boolean),
  agent.ops_work_item_decide(uuid, text, text), agent.ops_conversation_facts(timestamptz, uuid, integer), agent.ops_pipeline_facts(uuid, integer),
  agent.ops_supervisor_snapshot(timestamptz), agent.ops_brief_facts(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function agent.ops_action_state_upsert(text, uuid, jsonb), agent.ops_work_item_sync(text, uuid, jsonb, boolean),
  agent.ops_work_item_decide(uuid, text, text), agent.ops_conversation_facts(timestamptz, uuid, integer), agent.ops_pipeline_facts(uuid, integer),
  agent.ops_supervisor_snapshot(timestamptz), agent.ops_brief_facts(timestamptz, timestamptz) to agent_api, service_role;

alter table agent.conversation_action_state enable row level security;
alter table agent.ops_work_item enable row level security;
alter table agent.conversation_action_state force row level security;
alter table agent.ops_work_item force row level security;
revoke all on agent.conversation_action_state, agent.ops_work_item, agent.v_action_center_queue from public, anon, authenticated, service_role;
grant select on agent.conversation_action_state, agent.ops_work_item, agent.v_action_center_queue to agent_api, service_role;
create policy agent_api_select on agent.conversation_action_state for select to agent_api using (true);
create policy agent_api_select on agent.ops_work_item for select to agent_api using (true);
create policy service_role_select on agent.conversation_action_state for select to service_role using (true);
create policy service_role_select on agent.ops_work_item for select to service_role using (true);
