-- PROPOSED (NOT APPLIED) 2026-10-17. P0: ONE follow-up execution lifecycle (owner directive 2026-10-17).
-- Rollback: PROPOSED_20261017120000_followup_intent_lifecycle_rollback.sql
--
-- THE DEFECT THIS CLOSES. Every deferred follow-up was written to send_queue with an EMPTY body
-- ("deferred_message_resolution"); the queue loader pauses an empty body before any claim
-- (sms-engine.js shouldRunSendQueueRow → paused_invalid_queue_row / missing_message_body), and the
-- template render only ran after a claim that therefore never happened: 0 deferred follow-ups
-- delivered in 120 days. inbox_thread_state.follow_up_at was written by seven writers with no link to
-- any execution record. The dispatch-time empty-body prohibition is KEPT exactly as it is: a follow-up
-- is MATERIALIZED (rendered, validated, re-checked) BEFORE it becomes a claimable send_queue row.
--
-- WHAT THIS CREATES
--   public.followup_intents          ONE durable record per follow-up (thread × property × kind × due;
--                                    intent_key unique). States:
--                                      planned → materializing → ready (a NONEMPTY send-ready send_queue
--                                      row exists) → dispatched → provider_accepted → delivered | failed
--                                    plus not_executable{reason} · cancelled{reason} · superseded{reason}
--                                    · held{reason}. A reason is REQUIRED for every non-success state.
--   public.followup_intent_events    append-only audit of every insert and state transition (trigger).
--   followup_intent_plan(jsonb)              the ONE writer API (planned | not_executable | held);
--                                            supersedes the older live intent of the same thread ×
--                                            property × kind; projects follow_up_at in the SAME txn.
--   followup_intent_claim(...)               materialization claim: due − lead window, FOR UPDATE SKIP
--                                            LOCKED, a lease token; expired leases are reclaimed; an
--                                            exhausted attempt budget becomes a visible `failed`.
--   followup_intent_transition(...)          lease-holder CAS for a materialization outcome (retry with
--                                            backoff, not_executable, held, superseded, cancelled, failed).
--   followup_intent_rematerialize(...)       dispatch found the template revoked: back to planned
--                                            (materialize_seq + 1) and the old row cancelled, audited.
--   followup_intent_close_for_thread(jsonb)  cancel / supersede the live intents of a thread (fresh
--                                            inbound, STOP, operator) and their unsent rows, same txn.
--   followup_intent_project(text)            inbox_thread_state.follow_up_at := min(due_at) of the
--                                            thread's EXECUTABLE intents (planned/materializing/ready/
--                                            dispatched); a held / not_executable / failed date is never
--                                            projected as a scheduled action.
--   send_queue triggers                      AFTER INSERT: a row carrying metadata.followup_intent_id is
--                                            accepted only from the intent's current lease holder, with a
--                                            NONEMPTY body, and binds the intent → ready in the same txn.
--                                            AFTER UPDATE: every status change (claim, provider accept,
--                                            delivery callback, failure, cancel from ANY path, pause)
--                                            reconciles the intent and follow_up_at in the same txn.
--   inbox_thread_state guard trigger         only while system_control.followup_execution_mode = 'live':
--                                            a bare follow_up_at write (no intent) is recorded as a
--                                            not_executable intent ('bare_follow_up_at_write_without_intent')
--                                            and follow_up_at stays the projection. Absent / off / dry_run:
--                                            the trigger does nothing (born OFF).
--   v_followup_intent_health / v_followup_intent_reasons   monitoring counts (security_invoker).
--
-- BORN OFF. Nothing writes an intent until system_control.followup_execution_mode = 'live' (absent = off)
-- and the app code routes its writers here; the send_queue triggers act only on rows that carry
-- metadata.followup_intent_id (none exist before then); the thread-state guard reads the same mode key.
-- No schedule is created. The legacy public.conversation_turns and agent.runtime_limits are untouched.
--
-- Own transaction; preconditions RAISE, so a failed assertion aborts the commit.
begin;

do $$
begin
  if to_regclass('public.followup_intents') is not null then raise exception 'precondition: public.followup_intents already exists'; end if;
  if to_regclass('public.followup_intent_events') is not null then raise exception 'precondition: public.followup_intent_events already exists'; end if;
  if to_regclass('public.send_queue') is null or to_regclass('public.inbox_thread_state') is null or to_regclass('public.system_control') is null then
    raise exception 'precondition: send_queue / inbox_thread_state / system_control must exist';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inbox_thread_state' and column_name = 'follow_up_at') then
    raise exception 'precondition: inbox_thread_state.follow_up_at missing';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'inbox_thread_state' and indexdef ilike 'CREATE UNIQUE INDEX%(thread_key)') then
    raise exception 'precondition: inbox_thread_state.thread_key must be unique (projection target)';
  end if;
  if (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) <> 3 then
    raise exception 'precondition: roles anon / authenticated / service_role must exist';
  end if;
  if to_regprocedure('public.is_ops_operator()') is null then raise exception 'precondition: public.is_ops_operator() missing (RLS policy pattern)'; end if;
  if exists (select 1 from pg_trigger where not tgisinternal and tgname like '%followup_intent%') then raise exception 'precondition: follow-up intent triggers already exist'; end if;
end $$;

-- ── the intent record ───────────────────────────────────────────────────────
create table public.followup_intents (
  id                  uuid primary key default gen_random_uuid(),
  intent_key          text not null,
  thread_key          text not null,
  property_id         text,
  master_owner_id     text,
  prospect_id         text,
  kind                text not null,
  intent              text not null,
  use_case            text,
  due_at              timestamptz not null,
  state               text not null default 'planned',
  reason              text,
  writer              text not null,
  row_spec            jsonb not null default '{}'::jsonb,
  attempts            integer not null default 0,
  max_attempts        integer not null default 6,
  next_attempt_at     timestamptz not null default now(),
  lease_token         uuid,
  lease_until         timestamptz,
  leased_by           text,
  materialize_seq     integer not null default 1,
  send_queue_id       uuid,
  send_queue_key      text,
  template_id         text,
  template_source     text,
  provider_message_id text,
  outcome             text,
  next_action         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  closed_at           timestamptz,
  constraint followup_intents_intent_key_key unique (intent_key),
  constraint followup_intents_state_check check (state in ('planned', 'materializing', 'ready', 'dispatched', 'provider_accepted',
    'delivered', 'failed', 'not_executable', 'cancelled', 'superseded', 'held')),
  constraint followup_intents_text_present check (btrim(intent_key) <> '' and btrim(thread_key) <> '' and btrim(kind) <> '' and btrim(intent) <> '' and btrim(writer) <> ''),
  constraint followup_intents_reason_required check (state not in ('failed', 'not_executable', 'cancelled', 'superseded', 'held') or btrim(coalesce(reason, '')) <> ''),
  constraint followup_intents_row_bound check (state not in ('ready', 'dispatched', 'provider_accepted', 'delivered') or send_queue_id is not null),
  constraint followup_intents_lease_present check (state <> 'materializing' or (lease_token is not null and lease_until is not null)),
  constraint followup_intents_attempts_bounded check (attempts >= 0 and max_attempts between 1 and 20)
);
comment on table public.followup_intents is
  'P0 2026-10-17. ONE durable follow-up execution record per thread x property x kind x due. inbox_thread_state.follow_up_at is its projection. A follow-up becomes a claimable send_queue row only after materialization (rendered, validated, nonempty).';
-- one LIVE follow-up per thread × property × kind (a newer plan supersedes the older one)
-- (a row already being dispatched is not "live" here: the dispatch owns it, a newer plan may coexist)
create unique index uq_followup_intents_live on public.followup_intents (thread_key, coalesce(property_id, ''), kind)
  where state in ('planned', 'materializing', 'ready', 'held');
create index ix_followup_intents_claim on public.followup_intents (next_attempt_at, due_at) where state in ('planned', 'materializing');
create index ix_followup_intents_thread on public.followup_intents (thread_key, state);
create unique index uq_followup_intents_send_queue on public.followup_intents (send_queue_id) where send_queue_id is not null;

create table public.followup_intent_events (
  id            bigint generated always as identity primary key,
  intent_id     uuid not null references public.followup_intents (id),
  occurred_at   timestamptz not null default clock_timestamp(),
  from_state    text,
  to_state      text not null,
  reason        text,
  actor         text not null,
  send_queue_id uuid,
  detail        jsonb not null default '{}'::jsonb
);
comment on table public.followup_intent_events is 'P0 2026-10-17. Append-only audit: every follow-up intent insert and state transition.';
create index ix_followup_intent_events_intent on public.followup_intent_events (intent_id, occurred_at);

-- ── transition rules + audit ────────────────────────────────────────────────
create function public.followup_intent_transition_allowed(p_from text, p_to text) returns boolean
language sql immutable set search_path = public, pg_temp as $fn$
  select p_from = p_to or case p_from
    when 'planned'           then p_to in ('materializing', 'not_executable', 'held', 'cancelled', 'superseded', 'failed')
    when 'materializing'     then p_to in ('planned', 'ready', 'not_executable', 'held', 'cancelled', 'superseded', 'failed')
    when 'ready'             then p_to in ('dispatched', 'provider_accepted', 'delivered', 'failed', 'planned', 'held', 'cancelled', 'superseded')
    -- dispatched → planned only through followup_intent_rematerialize (the guard requires the row unbound)
    when 'dispatched'        then p_to in ('ready', 'planned', 'provider_accepted', 'delivered', 'failed', 'held', 'cancelled', 'superseded')
    when 'provider_accepted' then p_to in ('delivered', 'failed')
    when 'held'              then p_to in ('planned', 'ready', 'dispatched', 'not_executable', 'cancelled', 'superseded')
    -- a failure before the provider accepted (no provider id) may be re-planned by the bounded reconcile
    -- retry, or re-claimed when the processor requeues the same row; after an accept it is final
    when 'failed'            then p_to in ('planned', 'ready', 'dispatched')
    else false  -- delivered / not_executable / cancelled / superseded are terminal
  end
$fn$;

create function public.followup_intents_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'FOLLOWUP_INTENT_APPEND_ONLY: intents are closed with a reason, never deleted';
  end if;
  if tg_op = 'UPDATE' then
    if new.intent_key <> old.intent_key or new.thread_key <> old.thread_key or new.kind <> old.kind or new.due_at <> old.due_at or new.created_at <> old.created_at then
      raise exception using errcode = 'P0001', message = format('FOLLOWUP_INTENT_IMMUTABLE: identity of intent %s cannot change', old.id);
    end if;
    if not public.followup_intent_transition_allowed(old.state, new.state) then
      raise exception using errcode = 'P0001', message = format('FOLLOWUP_INTENT_TRANSITION: %s -> %s refused (intent %s)', old.state, new.state, old.id);
    end if;
    if old.state = 'failed' and new.state <> 'failed' and coalesce(old.outcome, '') in ('failed_after_accept', 'failed_ambiguous') then
      raise exception using errcode = 'P0001', message = format('FOLLOWUP_INTENT_TRANSITION: a failure after (or possibly after) provider acceptance is final (intent %s)', old.id);
    end if;
    if old.state in ('ready', 'dispatched') and new.state = 'planned' and new.send_queue_id is not null then
      raise exception using errcode = 'P0001', message = format('FOLLOWUP_INTENT_TRANSITION: re-planning intent %s requires unbinding its row (followup_intent_rematerialize)', old.id);
    end if;
    new.updated_at := now();
    if new.state in ('delivered', 'not_executable', 'cancelled', 'superseded') and new.closed_at is null then new.closed_at := now(); end if;
  end if;
  return new;
end $fn$;

create function public.followup_intents_audit() returns trigger
language plpgsql set search_path = public, pg_temp as $fn$
begin
  -- every insert, state change, row (re)binding, re-materialization and lease (re)claim is audited
  if tg_op = 'INSERT' or new.state is distinct from old.state or new.send_queue_id is distinct from old.send_queue_id
     or new.materialize_seq is distinct from old.materialize_seq or (new.lease_token is not null and new.lease_token is distinct from old.lease_token) then
    insert into public.followup_intent_events (intent_id, from_state, to_state, reason, actor, send_queue_id, detail)
    values (new.id, case when tg_op = 'UPDATE' then old.state end, new.state, new.reason,
            coalesce(nullif(current_setting('lc.followup_actor', true), ''), current_user::text), new.send_queue_id,
            jsonb_build_object('attempts', new.attempts, 'materialize_seq', new.materialize_seq, 'outcome', new.outcome, 'next_action', new.next_action,
                               'writer', new.writer, 'next_attempt_at', new.next_attempt_at));
  end if;
  return null;
end $fn$;

create function public.followup_intent_events_append_only() returns trigger
language plpgsql set search_path = public, pg_temp as $fn$
begin
  raise exception using errcode = 'P0001', message = 'FOLLOWUP_INTENT_APPEND_ONLY: followup_intent_events rows are immutable';
end $fn$;

create trigger a_followup_intents_guard before update or delete on public.followup_intents for each row execute function public.followup_intents_guard();
create trigger z_followup_intents_audit after insert or update on public.followup_intents for each row execute function public.followup_intents_audit();
create trigger a_followup_intent_events_append_only before update or delete on public.followup_intent_events for each row execute function public.followup_intent_events_append_only();

-- ── projection: follow_up_at is derived, never set alone ────────────────────
create function public.followup_intent_project(p_thread_key text) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v timestamptz;
begin
  select min(due_at) into v from public.followup_intents
   where thread_key = p_thread_key and state in ('planned', 'materializing', 'ready', 'dispatched');
  perform set_config('lc.followup_projection', 'on', true);
  update public.inbox_thread_state set follow_up_at = v where thread_key = p_thread_key and follow_up_at is distinct from v;
  perform set_config('lc.followup_projection', '', true);
  return v;
end $fn$;

-- cancel the unsent send_queue row of an intent being closed (same transaction)
create function public.followup_intent_cancel_row(p_send_queue_id uuid, p_reason text, p_actor text, p_include_claimed boolean default false) returns integer
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare n integer;
begin
  if p_send_queue_id is null then return 0; end if;
  update public.send_queue
     set queue_status = 'cancelled', is_locked = false, locked_at = null, lock_token = null,
         guard_status = 'blocked', guard_reason = p_reason, updated_at = now(),
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('skip_reason', p_reason, 'cancellation_reason', p_reason,
                      'cancelled_by', p_actor, 'cancelled_at', now(), 'final_queue_status', 'cancelled')
   where id = p_send_queue_id and sent_at is null and nullif(btrim(coalesce(provider_message_id, '')), '') is null
     and (queue_status in ('queued', 'pending', 'approved', 'ready', 'scheduled', 'paused', 'paused_after_hours', 'paused_automation_hold', 'held', 'approval')
          -- the dispatch gate holds the claim of THIS row while it re-plans it (no provider evidence)
          or (p_include_claimed and queue_status in ('processing', 'sending')));
  get diagnostics n = row_count;
  return n;
end $fn$;

-- ── the ONE writer API ──────────────────────────────────────────────────────
-- p: intent_key, thread_key, property_id, master_owner_id, prospect_id, kind, intent, use_case, due_at,
--    writer, row_spec, state ('planned' | 'not_executable' | 'held'), reason, actor, max_attempts
create function public.followup_intent_plan(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_state text := coalesce(nullif(btrim(p->>'state'), ''), 'planned');
  v_thread text := nullif(btrim(p->>'thread_key'), '');
  v_key text := nullif(btrim(p->>'intent_key'), '');
  v_kind text := nullif(btrim(p->>'kind'), '');
  v_due timestamptz := (p->>'due_at')::timestamptz;
  v_row public.followup_intents;
  v_old record;
  v_superseded integer := 0;
begin
  if v_thread is null or v_key is null or v_kind is null or v_due is null or nullif(btrim(p->>'intent'), '') is null or nullif(btrim(p->>'writer'), '') is null then
    raise exception using errcode = 'P0001', message = 'FOLLOWUP_INTENT_PLAN: intent_key, thread_key, kind, intent, due_at and writer are required';
  end if;
  if v_state not in ('planned', 'not_executable', 'held') then
    raise exception using errcode = 'P0001', message = format('FOLLOWUP_INTENT_PLAN: a writer may record planned / not_executable / held, not %s', v_state);
  end if;
  if v_state <> 'planned' and btrim(coalesce(p->>'reason', '')) = '' then
    raise exception using errcode = 'P0001', message = 'FOLLOWUP_INTENT_PLAN: a non-executable or held follow-up needs an actionable reason';
  end if;
  perform set_config('lc.followup_actor', coalesce(nullif(p->>'actor', ''), p->>'writer'), true);
  -- serialize every intent write of one thread (plan / supersede / close / project)
  perform pg_advisory_xact_lock(hashtextextended('followup_intent:' || v_thread, 0));

  select * into v_row from public.followup_intents where intent_key = v_key;
  if found then
    return jsonb_build_object('ok', true, 'replay', true, 'intent', to_jsonb(v_row), 'follow_up_at', public.followup_intent_project(v_thread));
  end if;

  if v_state in ('planned', 'held') then
    for v_old in
      select id, state, send_queue_id from public.followup_intents
       where thread_key = v_thread and coalesce(property_id, '') = coalesce(p->>'property_id', '') and kind = v_kind
         and state in ('planned', 'materializing', 'ready', 'dispatched', 'held')
       for update
    loop
      if v_old.state = 'dispatched' then continue; end if; -- mid-send: the dispatch owns it
      update public.followup_intents set state = 'superseded', reason = 'superseded_by_newer_plan', lease_token = null, lease_until = null, next_action = 'none'
       where id = v_old.id;
      perform public.followup_intent_cancel_row(v_old.send_queue_id, 'followup_superseded_by_newer_plan', 'followup_intent_plan');
      v_superseded := v_superseded + 1;
    end loop;
  end if;

  insert into public.followup_intents (intent_key, thread_key, property_id, master_owner_id, prospect_id, kind, intent, use_case, due_at, state, reason,
                                       writer, row_spec, next_attempt_at, max_attempts, next_action)
  values (v_key, v_thread, nullif(p->>'property_id', ''), nullif(p->>'master_owner_id', ''), nullif(p->>'prospect_id', ''), v_kind, p->>'intent',
          nullif(p->>'use_case', ''), v_due, v_state, nullif(p->>'reason', ''), p->>'writer', coalesce(p->'row_spec', '{}'::jsonb), now(),
          coalesce((p->>'max_attempts')::int, 6), case v_state when 'planned' then 'materialize' when 'held' then 'operator_review' else 'none' end)
  returning * into v_row;

  return jsonb_build_object('ok', true, 'replay', false, 'superseded', v_superseded, 'intent', to_jsonb(v_row), 'follow_up_at', public.followup_intent_project(v_thread));
end $fn$;

-- ── materialization claim ───────────────────────────────────────────────────
create function public.followup_intent_claim(p_worker text, p_limit integer default 25, p_lead_seconds integer default 1800,
                                             p_lease_seconds integer default 300, p_intent_id uuid default null)
returns setof public.followup_intents
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v_thread text;
begin
  perform set_config('lc.followup_actor', 'materializer:' || coalesce(nullif(p_worker, ''), 'unknown'), true);
  -- an exhausted attempt budget is a visible failure, never an endless silent retry
  for v_thread in
    update public.followup_intents
       set state = 'failed', reason = 'materialization_attempts_exhausted', outcome = 'failed_before_accept', next_action = 'operator_review',
           lease_token = null, lease_until = null
     where (state = 'planned' or (state = 'materializing' and lease_until < now()))
       and attempts >= max_attempts and (p_intent_id is null or id = p_intent_id)
    returning thread_key
  loop
    perform public.followup_intent_project(v_thread);
  end loop;

  return query
  with c as (
    select id from public.followup_intents
     where ((state = 'planned' and next_attempt_at <= now() and due_at <= now() + make_interval(secs => greatest(0, p_lead_seconds)))
         or (state = 'materializing' and lease_until < now()))
       and attempts < max_attempts
       and (p_intent_id is null or id = p_intent_id)
     order by due_at, id
     limit greatest(1, least(coalesce(p_limit, 25), 200))
     for update skip locked
  )
  update public.followup_intents f
     set state = 'materializing', lease_token = gen_random_uuid(), lease_until = now() + make_interval(secs => greatest(30, p_lease_seconds)),
         leased_by = p_worker, attempts = f.attempts + 1,
         reason = case when f.state = 'materializing' then 'lease_expired_reclaimed' else 'claimed_for_materialization' end
    from c where f.id = c.id
  returning f.*;
end $fn$;

-- lease-holder CAS. p_to: planned (retry / deferral) | not_executable | held | superseded | cancelled | failed
create function public.followup_intent_transition(p_id uuid, p_token uuid, p_to text, p_reason text,
                                                  p_retry_at timestamptz default null, p_refund_attempt boolean default false,
                                                  p_detail jsonb default '{}'::jsonb, p_actor text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v public.followup_intents;
begin
  if p_to not in ('planned', 'not_executable', 'held', 'superseded', 'cancelled', 'failed') then
    raise exception using errcode = 'P0001', message = format('FOLLOWUP_INTENT_TRANSITION: %s is not a materialization outcome', p_to);
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception using errcode = 'P0001', message = 'FOLLOWUP_INTENT_TRANSITION: an actionable reason is required';
  end if;
  perform set_config('lc.followup_actor', coalesce(nullif(p_actor, ''), 'materializer'), true);
  update public.followup_intents
     set state = p_to, reason = p_reason, lease_token = null, lease_until = null,
         next_attempt_at = case when p_to = 'planned' then coalesce(p_retry_at, now() + interval '15 minutes') else next_attempt_at end,
         attempts = case when p_to = 'planned' and p_refund_attempt then greatest(0, attempts - 1) else attempts end,
         outcome = case when p_to = 'failed' then 'failed_before_accept' else outcome end,
         next_action = case p_to when 'planned' then 'materialize' when 'held' then 'operator_review' when 'failed' then 'operator_review' else 'none' end,
         row_spec = case when p_detail <> '{}'::jsonb then row_spec || jsonb_build_object('last_materialization', p_detail) else row_spec end
   where id = p_id and state = 'materializing' and lease_token = p_token
  returning * into v;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;
  perform public.followup_intent_project(v.thread_key);
  return jsonb_build_object('ok', true, 'intent', to_jsonb(v));
end $fn$;

-- dispatch-time: the bound template was revoked ⇒ back to planned (new materialization), old row cancelled
create function public.followup_intent_rematerialize(p_id uuid, p_send_queue_id uuid, p_reason text, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v public.followup_intents;
begin
  if btrim(coalesce(p_reason, '')) = '' then raise exception using errcode = 'P0001', message = 'FOLLOWUP_INTENT_REMATERIALIZE: reason required'; end if;
  perform set_config('lc.followup_actor', coalesce(nullif(p_actor, ''), 'dispatch_gate'), true);
  update public.followup_intents
     set state = 'planned', reason = p_reason, send_queue_id = null, send_queue_key = null, template_id = null, template_source = null,
         materialize_seq = materialize_seq + 1, attempts = 0, next_attempt_at = now(), next_action = 'materialize'
   where id = p_id and send_queue_id = p_send_queue_id and state in ('ready', 'dispatched', 'held')
  returning * into v;
  if not found then return jsonb_build_object('ok', false, 'reason', 'intent_not_bound_to_row'); end if;
  perform public.followup_intent_cancel_row(p_send_queue_id, p_reason, coalesce(nullif(p_actor, ''), 'dispatch_gate'), true);
  perform public.followup_intent_project(v.thread_key);
  return jsonb_build_object('ok', true, 'intent', to_jsonb(v));
end $fn$;

-- reconcile: ONE bounded re-plan of a failure that happened BEFORE the provider accepted (no SID, not
-- ambiguous). A failure after (or possibly after) acceptance is never re-planned (duplicate text risk).
create function public.followup_intent_requeue_failed(p_id uuid, p_reason text, p_actor text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v public.followup_intents;
begin
  if btrim(coalesce(p_reason, '')) = '' then raise exception using errcode = 'P0001', message = 'FOLLOWUP_INTENT_REQUEUE: reason required'; end if;
  perform set_config('lc.followup_actor', coalesce(nullif(p_actor, ''), 'reconcile'), true);
  update public.followup_intents
     set state = 'planned', reason = p_reason, send_queue_id = null, send_queue_key = null, template_id = null, template_source = null,
         -- after the dispatcher's 24 h identical-body duplicate window (the failed attempt is an outbound event)
         materialize_seq = materialize_seq + 1, attempts = 0, next_attempt_at = now() + interval '24 hours 5 minutes', outcome = null, next_action = 'materialize',
         row_spec = row_spec || jsonb_build_object('reconcile_retries', coalesce((row_spec->>'reconcile_retries')::int, 0) + 1)
   where id = p_id and state = 'failed' and coalesce(outcome, '') = 'failed_before_accept'
     and coalesce((row_spec->>'reconcile_retries')::int, 0) < 1
  returning * into v;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_retryable'); end if;
  perform public.followup_intent_project(v.thread_key);
  return jsonb_build_object('ok', true, 'intent', to_jsonb(v));
end $fn$;

-- close the live intents of a thread. p: thread_key, state ('cancelled' | 'superseded'), reason, actor,
--   property_id (only that property), kinds (text[]: only those kinds), keep_kinds (text[]: spare those),
--   created_before (only intents planned before this instant — a slow older inbound never closes a newer plan)
create function public.followup_intent_close_for_thread(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_thread text := nullif(btrim(p->>'thread_key'), '');
  v_state text := coalesce(nullif(p->>'state', ''), 'cancelled');
  v_reason text := nullif(btrim(p->>'reason'), '');
  v_before timestamptz := nullif(p->>'created_before', '')::timestamptz;
  v record;
  n integer := 0;
  r integer := 0;
begin
  if v_thread is null or v_reason is null then raise exception using errcode = 'P0001', message = 'FOLLOWUP_INTENT_CLOSE: thread_key and reason required'; end if;
  if v_state not in ('cancelled', 'superseded') then raise exception using errcode = 'P0001', message = 'FOLLOWUP_INTENT_CLOSE: state must be cancelled or superseded'; end if;
  perform set_config('lc.followup_actor', coalesce(nullif(p->>'actor', ''), 'followup_intent_close'), true);
  perform pg_advisory_xact_lock(hashtextextended('followup_intent:' || v_thread, 0));
  for v in
    select id, send_queue_id from public.followup_intents
     where thread_key = v_thread and state in ('planned', 'materializing', 'ready', 'held')
       and (nullif(p->>'property_id', '') is null or property_id = p->>'property_id')
       and (p->'kinds' is null or jsonb_typeof(p->'kinds') <> 'array' or kind in (select jsonb_array_elements_text(p->'kinds')))
       and (p->'keep_kinds' is null or jsonb_typeof(p->'keep_kinds') <> 'array' or kind not in (select jsonb_array_elements_text(p->'keep_kinds')))
       and (v_before is null or created_at < v_before)
     for update
  loop
    update public.followup_intents set state = v_state, reason = v_reason, lease_token = null, lease_until = null, next_action = 'none' where id = v.id;
    r := r + public.followup_intent_cancel_row(v.send_queue_id, v_reason, coalesce(nullif(p->>'actor', ''), 'followup_intent_close'));
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'closed', n, 'rows_cancelled', r, 'follow_up_at', public.followup_intent_project(v_thread));
end $fn$;

-- ── send_queue ⇄ intent, same transaction, any path ─────────────────────────
create function public.followup_intent_bind_send_queue() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v public.followup_intents; v_id uuid;
begin
  begin
    v_id := (new.metadata->>'followup_intent_id')::uuid;
  exception when others then
    raise exception using errcode = 'P0001', message = 'FOLLOWUP_INTENT: metadata.followup_intent_id is not a uuid';
  end;
  select * into v from public.followup_intents where id = v_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('FOLLOWUP_INTENT: unknown intent %s', v_id);
  end if;
  if btrim(coalesce(new.message_body, '')) = '' then
    raise exception using errcode = 'P0001', message = format('FOLLOWUP_INTENT: an empty message body is refused (intent %s)', v_id);
  end if;
  if v.state <> 'materializing' or v.lease_token is null or v.lease_token::text is distinct from (new.metadata->>'followup_materialize_token') then
    raise exception using errcode = 'P0001', message = format('FOLLOWUP_INTENT: intent %s is not materializing under this lease (state %s)', v_id, v.state);
  end if;
  perform set_config('lc.followup_actor', coalesce(nullif(current_setting('lc.followup_actor', true), ''), 'materializer'), true);
  update public.followup_intents
     set state = 'ready', reason = 'materialized', send_queue_id = new.id, send_queue_key = new.queue_key,
         template_id = coalesce(new.template_id, new.selected_template_id), template_source = new.template_source,
         lease_token = null, lease_until = null, next_action = 'dispatch'
   where id = v_id;
  perform public.followup_intent_project(v.thread_key);
  return null;
end $fn$;

create function public.followup_intent_sync_send_queue() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v public.followup_intents;
  v_id uuid;
  s text := lower(coalesce(new.queue_status, ''));
  v_to text;
  v_reason text;
  v_accepted boolean := new.sent_at is not null or nullif(btrim(coalesce(new.provider_message_id, new.textgrid_message_id, '')), '') is not null;
  -- PROVABLY UNSENT only on the dispatcher's own evidence (the provider rejected it / the request was
  -- refused or never connected). Anything else without a SID MAY have been sent (timeout, no-SID accept,
  -- unparseable answer): failed_ambiguous, never re-sent automatically.
  v_unsent boolean := lower(coalesce(new.metadata->>'no_sid_ambiguous_send', new.metadata->>'ambiguous_send', '')) <> 'true'
                      and (coalesce(new.metadata->>'failure_bucket', '') in ('provider_rejected', 'local_refusal', 'provider_connect_failed')
                           or coalesce(new.failed_reason, '') ~* '(REJECTED BY PROVIDER|REFUSED BEFORE REQUEST|connect_failed_before_request)');
  v_outcome text;
begin
  begin v_id := (new.metadata->>'followup_intent_id')::uuid; exception when others then return null; end;
  select * into v from public.followup_intents where id = v_id for update;
  if not found then return null; end if;
  if v.send_queue_id is distinct from new.id then
    insert into public.followup_intent_events (intent_id, from_state, to_state, reason, actor, send_queue_id, detail)
    values (v.id, v.state, v.state, 'unbound_row_status_' || s, 'send_queue_sync', new.id, jsonb_build_object('queue_status', s));
    return null;
  end if;

  if new.delivered_at is not null or s = 'delivered' then
    v_to := 'delivered';
  elsif s like 'failed%' or s in ('undelivered', 'invalid_number', 'carrier_blocked') then
    v_to := 'failed';
  elsif s = 'sent' or v_accepted then
    v_to := 'provider_accepted';
  elsif s in ('processing', 'sending') then
    v_to := 'dispatched';
  elsif s like 'blocked_sender%' then
    v_to := 'held';  -- no eligible sender for this thread: a routing fix, not the seller's decision
  elsif s in ('cancelled', 'canceled', 'skipped', 'expired', 'suppressed') or s like 'blocked%' then
    v_to := 'cancelled';
  elsif s like 'paused%' or s in ('held', 'approval', 'pending_approval') then
    v_to := 'held';
  elsif s in ('queued', 'pending', 'approved', 'ready', 'scheduled') then
    v_to := 'ready';
  elsif s = '' then
    v_to := v.state;
  else
    -- any other terminal queue verdict (duplicate_blocked, …): the row will not send; never a silent limbo
    v_to := 'cancelled';
  end if;
  v_reason := coalesce(nullif(btrim(new.failed_reason), ''), nullif(btrim(new.guard_reason), ''), nullif(btrim(new.paused_reason), ''),
                       nullif(btrim(new.metadata->>'cancellation_reason'), ''), nullif(btrim(new.metadata->>'skip_reason'), ''), 'queue_status_' || s);

  -- a fresh inbound (inbound takeover, any path) SUPERSEDES the follow-up; it did not fail
  if v_to = 'cancelled' and (lower(coalesce(new.metadata->>'superseded_by_newer_inbound', '')) = 'true' or coalesce(new.metadata->>'cancelled_by', '') = 'inbound_takeover'
      or v_reason ~* '^(superseded|cancelled_followup_on_inbound_reply)') then
    v_to := 'superseded';
  end if;
  v_outcome := case when v_to = 'failed' then case when v_accepted then 'failed_after_accept' when v_unsent then 'failed_before_accept' else 'failed_ambiguous' end end;

  if v_to = v.state then
    if v_to = 'provider_accepted' and v.provider_message_id is null and v_accepted then
      update public.followup_intents set provider_message_id = coalesce(new.provider_message_id, new.textgrid_message_id) where id = v.id;
    end if;
    return null;
  end if;
  if not public.followup_intent_transition_allowed(v.state, v_to) or (v.state = 'failed' and coalesce(v.outcome, '') in ('failed_after_accept', 'failed_ambiguous')) then
    -- a late or out-of-order provider event on a closed intent: recorded, never re-opened
    insert into public.followup_intent_events (intent_id, from_state, to_state, reason, actor, send_queue_id, detail)
    values (v.id, v.state, v.state, 'late_row_status_' || s, 'send_queue_sync', new.id, jsonb_build_object('queue_status', s, 'would_be', v_to));
    return null;
  end if;
  perform set_config('lc.followup_actor', 'send_queue_sync', true);
  update public.followup_intents
     set state = v_to,
         reason = case v_to when 'ready' then 'row_requeued' when 'dispatched' then 'claimed_by_queue_runner' when 'provider_accepted' then 'provider_accepted'
                           when 'delivered' then 'delivered' else v_reason end,
         provider_message_id = coalesce(provider_message_id, nullif(btrim(coalesce(new.provider_message_id, new.textgrid_message_id, '')), '')),
         outcome = case v_to when 'delivered' then 'delivered' when 'provider_accepted' then 'provider_accepted'
                             when 'failed' then v_outcome
                             when 'cancelled' then 'cancelled' when 'superseded' then 'superseded' when 'held' then 'held' else outcome end,
         next_action = case v_to when 'delivered' then 'await_reply' when 'provider_accepted' then 'await_delivery'
                                 when 'failed' then case when v_outcome = 'failed_before_accept' then 'bounded_retry_or_review' else 'human_review_no_resend' end
                                 when 'held' then 'operator_review' when 'cancelled' then 'none' when 'ready' then 'dispatch' else next_action end
   where id = v.id;
  perform public.followup_intent_project(v.thread_key);
  return null;
end $fn$;

create trigger zz_followup_intent_bind after insert on public.send_queue
  for each row when (new.metadata ? 'followup_intent_id') execute function public.followup_intent_bind_send_queue();
create trigger zz_followup_intent_sync after update of queue_status, delivered_at, sent_at, provider_message_id, textgrid_message_id, failed_reason on public.send_queue
  for each row when (new.metadata ? 'followup_intent_id') execute function public.followup_intent_sync_send_queue();
-- at most ONE live send_queue row per intent (exactly-once backstop under any race)
create unique index uq_send_queue_followup_intent_live on public.send_queue ((metadata->>'followup_intent_id'))
  where metadata ? 'followup_intent_id' and sent_at is null and queue_status in ('queued', 'pending', 'approved', 'ready', 'scheduled', 'processing', 'sending');

-- ── no claimable empty-body FOLLOW-UP row, from any writer (only while live) ──
-- The loader's pre-claim empty-body pause (sms-engine shouldRunSendQueueRow) is unchanged; while the
-- lifecycle is live a body-less follow-up is refused at the source instead of becoming a dead row.
create function public.followup_no_empty_claimable_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v_mode text;
begin
  if btrim(coalesce(new.message_body, '')) <> '' then return new; end if;
  if lower(coalesce(new.queue_status, '')) not in ('queued', 'pending', 'approved', 'ready', 'scheduled', 'processing', 'sending') then return new; end if;
  select lower(btrim(value)) into v_mode from public.system_control where key = 'followup_execution_mode';
  if v_mode is distinct from 'live' then return new; end if;
  raise exception using errcode = 'P0001', message = 'FOLLOWUP_EMPTY_BODY: a follow-up row is never claimable without a rendered body; plan it through followup_intent_plan()';
end $fn$;
create trigger zz_followup_no_empty_claimable before insert or update of queue_status, message_body on public.send_queue
  for each row when (lower(coalesce(new.type, '')) = 'followup' or lower(coalesce(new.message_type, '')) = 'followup' or coalesce(new.metadata->>'deferred_message_resolution', '') = 'true')
  execute function public.followup_no_empty_claimable_guard();

-- ── follow_up_at guard (only while followup_execution_mode = 'live') ────────
create function public.followup_thread_state_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v_mode text; v_proj timestamptz;
begin
  if coalesce(current_setting('lc.followup_projection', true), '') = 'on' then return new; end if;
  if tg_op = 'UPDATE' and new.follow_up_at is not distinct from old.follow_up_at then return new; end if;
  if tg_op = 'INSERT' and new.follow_up_at is null then return new; end if;
  select lower(btrim(value)) into v_mode from public.system_control where key = 'followup_execution_mode';
  if v_mode is distinct from 'live' then return new; end if;
  if new.follow_up_at is not null and nullif(btrim(coalesce(new.thread_key, '')), '') is not null then
    perform set_config('lc.followup_actor', 'thread_state_guard', true);
    insert into public.followup_intents (intent_key, thread_key, property_id, master_owner_id, prospect_id, kind, intent, due_at, state, reason, writer, next_action)
    values ('bare:' || new.thread_key || ':' || to_char(new.follow_up_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), new.thread_key, new.property_id,
            new.master_owner_id, null, 'bare_date', 'unknown', new.follow_up_at, 'not_executable', 'bare_follow_up_at_write_without_intent',
            coalesce(nullif(current_setting('lc.followup_writer', true), ''), 'unattributed_thread_state_write'), 'writer_must_use_followup_intent_plan')
    on conflict (intent_key) do nothing;
  end if;
  select min(due_at) into v_proj from public.followup_intents
   where thread_key = new.thread_key and state in ('planned', 'materializing', 'ready', 'dispatched');
  new.follow_up_at := v_proj;
  return new;
end $fn$;
create trigger zz_followup_thread_state_guard before insert or update of follow_up_at on public.inbox_thread_state
  for each row execute function public.followup_thread_state_guard();

-- ── monitoring ──────────────────────────────────────────────────────────────
create view public.v_followup_intent_health with (security_invoker = true) as
select
  count(*) filter (where state in ('planned', 'materializing', 'ready', 'dispatched'))                    as scheduled_executable,
  count(*) filter (where state = 'planned')                                                               as planned,
  count(*) filter (where state = 'planned' and due_at < now())                                            as planned_overdue,
  count(*) filter (where state = 'planned' and attempts > 0)                                              as retrying,
  count(*) filter (where state = 'materializing')                                                         as materializing,
  count(*) filter (where state = 'materializing' and lease_until < now())                                 as materializing_stale,
  count(*) filter (where state = 'ready')                                                                 as ready,
  count(*) filter (where state = 'ready' and due_at < now() - interval '6 hours')                         as ready_overdue,
  count(*) filter (where state = 'dispatched')                                                            as dispatched,
  count(*) filter (where state = 'dispatched' and updated_at < now() - interval '1 hour')                 as dispatched_stale,
  count(*) filter (where state = 'provider_accepted')                                                     as provider_accepted,
  count(*) filter (where state = 'provider_accepted' and updated_at < now() - interval '6 hours')         as accepted_unconfirmed,
  count(*) filter (where state = 'delivered')                                                             as delivered,
  count(*) filter (where state = 'failed')                                                                as failed,
  count(*) filter (where state = 'failed' and outcome = 'failed_after_accept')                            as failed_after_accept,
  count(*) filter (where state = 'failed' and outcome = 'failed_ambiguous')                               as failed_ambiguous,
  count(*) filter (where state = 'not_executable')                                                        as not_executable,
  count(*) filter (where state = 'not_executable' and updated_at > now() - interval '24 hours')           as not_executable_24h,
  count(*) filter (where state = 'held')                                                                  as held,
  count(*) filter (where state = 'cancelled')                                                             as cancelled,
  count(*) filter (where state = 'superseded')                                                            as superseded,
  now()                                                                                                   as computed_at
from public.followup_intents;
comment on view public.v_followup_intent_health is 'P0 2026-10-17. Follow-up lifecycle counts. scheduled_executable never includes held / not_executable / failed.';

create view public.v_followup_intent_reasons with (security_invoker = true) as
select state, kind, coalesce(reason, '') as reason, writer, count(*)::int as n, min(due_at) as earliest_due, max(updated_at) as last_change
  from public.followup_intents
 where state in ('not_executable', 'held', 'failed', 'cancelled', 'superseded') or (state = 'planned' and attempts > 0)
 group by state, kind, coalesce(reason, ''), writer;
comment on view public.v_followup_intent_reasons is 'P0 2026-10-17. Every non-success follow-up outcome, by actionable reason and writer.';

-- ── access ──────────────────────────────────────────────────────────────────
alter table public.followup_intents enable row level security;
alter table public.followup_intent_events enable row level security;
revoke all on public.followup_intents, public.followup_intent_events from public, anon, authenticated, service_role;
grant select, insert, update on public.followup_intents to service_role;
grant select, insert on public.followup_intent_events to service_role;
grant select on public.followup_intents, public.followup_intent_events to authenticated;
create policy ops_operator_read on public.followup_intents for select to authenticated using ((select public.is_ops_operator()));
create policy ops_operator_read on public.followup_intent_events for select to authenticated using ((select public.is_ops_operator()));
revoke all on public.v_followup_intent_health, public.v_followup_intent_reasons from public, anon;
grant select on public.v_followup_intent_health, public.v_followup_intent_reasons to authenticated, service_role;

revoke all on function public.followup_intent_plan(jsonb), public.followup_intent_claim(text, integer, integer, integer, uuid),
  public.followup_intent_transition(uuid, uuid, text, text, timestamptz, boolean, jsonb, text), public.followup_intent_rematerialize(uuid, uuid, text, text),
  public.followup_intent_close_for_thread(jsonb), public.followup_intent_project(text), public.followup_intent_cancel_row(uuid, text, text, boolean),
  public.followup_intent_requeue_failed(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.followup_intent_plan(jsonb), public.followup_intent_claim(text, integer, integer, integer, uuid),
  public.followup_intent_transition(uuid, uuid, text, text, timestamptz, boolean, jsonb, text), public.followup_intent_rematerialize(uuid, uuid, text, text),
  public.followup_intent_close_for_thread(jsonb), public.followup_intent_project(text), public.followup_intent_requeue_failed(uuid, text, text) to service_role;
revoke all on function public.followup_intents_guard(), public.followup_intents_audit(), public.followup_intent_events_append_only(), public.followup_no_empty_claimable_guard(),
  public.followup_intent_bind_send_queue(), public.followup_intent_sync_send_queue(), public.followup_thread_state_guard() from public, anon, authenticated;

-- ── postconditions ──────────────────────────────────────────────────────────
do $$
begin
  if (select count(*) from pg_trigger where not tgisinternal and tgname in ('zz_followup_intent_bind', 'zz_followup_intent_sync', 'zz_followup_thread_state_guard',
      'a_followup_intents_guard', 'z_followup_intents_audit', 'a_followup_intent_events_append_only', 'zz_followup_no_empty_claimable')) <> 7 then
    raise exception 'postcondition: follow-up intent triggers missing';
  end if;
  if exists (select 1 from public.followup_intents) then raise exception 'postcondition: born empty'; end if;
  if exists (select 1 from public.system_control where key = 'followup_execution_mode' and lower(btrim(value)) = 'live') then
    raise notice 'NOTE: followup_execution_mode is already live; the thread-state guard is active immediately';
  end if;
end $$;
commit;
