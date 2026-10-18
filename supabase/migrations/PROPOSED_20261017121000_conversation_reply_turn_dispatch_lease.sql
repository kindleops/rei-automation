-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- rc-8.5.21 — OWNER DIRECTIVE: "No worker, sender or agent may independently produce a duplicate
-- response to the same inbound turn." Fixes the double-dispatch race found by the 8-worker PG test:
-- a worker whose claim was refused because the turn was already DECIDED took the crash-recovery
-- path and dispatched again, because nothing recorded that a dispatch was in flight or done.
--
--   1. DISPATCH LEASE on public.conversation_reply_turns (dispatch_state / dispatch_worker /
--      dispatch_lease_until / dispatch_attempts / dispatched_at). conversation_reply_turn_finalize
--      (re-created, same body + the lease) hands the claimant the lease atomically with the decision.
--   2. conversation_reply_turn_dispatch_claim: the ONE recovery entry. Allowed only when the lease
--      has EXPIRED (DB clock) and the dispatch has no terminal outcome; a live lease returns
--      live_dispatch + retry_after_ms (the caller reschedules, never dispatches); bounded attempts,
--      then dispatch_state dead_letter.
--   3. conversation_reply_turn_dispatch_done: the lease holder records dispatched / deferred /
--      released (a transient failure: the lease is expired at once so a retry may recover).
--   4. DB BACKSTOP: unique index send_queue_ai_turn_uq — at most ONE ai_generated send_queue row per
--      conversation turn (metadata.turn.turn_id, stamped by the R3 executor). A second enqueue
--      fails at the database whatever the code does. (Per inbound: ai_generated_messages
--      inbound_message_id / queue_key and send_queue queue_key are already unique.)
--   5. agent.runtime_finish(text, uuid, text, jsonb, jsonb, integer): a 6-arg wrapper of the
--      unchanged 5-arg function that sets next_attempt_at = now + retry_after_seconds on a retry,
--      so a loser's job is rescheduled for "lease remaining + jitter", not finished.
-- Arms nothing, sends nothing; every new function is service_role-only (runtime_finish 6-arg as the
-- 5-arg: agent_api + service_role).
-- ORDER: after PROPOSED_20261016120000_conversation_reply_turns.sql, PROPOSED_20261015130000
-- (message_origin) and PROPOSED_20261012140000_intel_runtime.sql.
--   psql "$DB" -v ON_ERROR_STOP=1 -f PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease.sql
-- Rollback: PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regclass('public.conversation_reply_turns') is null then raise exception 'precondition: conversation_reply_turns (PROPOSED_20261016120000) missing'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'conversation_reply_turns' and column_name = 'dispatch_state') then
    raise exception 'precondition: already applied (dispatch_state exists)';
  end if;
  if to_regprocedure('agent.runtime_finish(text,uuid,text,jsonb,jsonb)') is null then raise exception 'precondition: agent.runtime_finish (intel_runtime) missing'; end if;
  if to_regprocedure('agent.runtime_finish(text,uuid,text,jsonb,jsonb,integer)') is not null then raise exception 'precondition: runtime_finish 6-arg already exists'; end if;
  if to_regclass('public.send_queue') is null then raise exception 'precondition: send_queue missing'; end if;
  if to_regclass('public.send_queue_ai_turn_uq') is not null then raise exception 'precondition: send_queue_ai_turn_uq already exists'; end if;
  if exists (select 1 from public.send_queue where metadata ->> 'message_origin' = 'ai_generated' and (metadata -> 'turn' ->> 'turn_id') is not null
              group by metadata -> 'turn' ->> 'turn_id' having count(*) > 1) then
    raise exception 'precondition: duplicate ai_generated send_queue rows for one turn exist — review them before the backstop';
  end if;
end $$;

alter table public.conversation_reply_turns
  add column dispatch_state text check (dispatch_state is null or dispatch_state in ('in_flight', 'dispatched', 'deferred', 'dead_letter')),
  add column dispatch_worker text check (dispatch_worker is null or dispatch_worker ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  add column dispatch_lease_until timestamptz,
  add column dispatch_attempts integer not null default 0 check (dispatch_attempts between 0 and 100),
  add column dispatched_at timestamptz;
comment on column public.conversation_reply_turns.dispatch_lease_until is
  'rc-8.5.21: the dispatch lease. While it is in the future only dispatch_worker may dispatch; recovery (conversation_reply_turn_dispatch_claim) requires it expired.';

create or replace function public.conversation_reply_turn_finalize(
  p_turn_id uuid, p_token uuid, p_version integer, p_outcome text, p_result jsonb default null,
  p_reserve boolean default false, p_reply_origin text default null)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  t public.conversation_reply_turns%rowtype;
  v_id text;
  v_key text;
  v_conflict text;
begin
  if p_outcome is null or p_outcome !~ '^[a-z0-9_:.-]{1,80}$' then return jsonb_build_object('ok', false, 'reason', 'outcome_invalid'); end if;
  if p_reserve and (p_reply_origin is null or p_reply_origin not in ('template', 'ai_generated', 'operator_manual')) then
    return jsonb_build_object('ok', false, 'reason', 'reply_origin_required');
  end if;
  select * into t from public.conversation_reply_turns where turn_id = p_turn_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'turn_not_found'); end if;
  if t.state <> 'claimed' or t.claim_token is distinct from p_token or t.version <> p_version then
    -- a decision for a revoked claim / older version: its draft is STALE and is discarded
    update public.conversation_reply_turns set stale_drafts = stale_drafts + 1, updated_at = now() where turn_id = p_turn_id;
    return jsonb_build_object('ok', false, 'reason', case when t.version <> p_version then 'stale_version' else 'claim_revoked' end,
                              'state', t.state, 'version', t.version);
  end if;
  if p_reserve then
    begin
      foreach v_id in array t.inbound_ids loop
        v_key := null;
        insert into public.idempotency_ledger (scope, key, claim_token, status, summary, metadata, started_at)
        values ('inbound_reply', v_id, p_token, 'processing', 'conversation_reply_turn',
                jsonb_build_object('engine', 'conversation_reply_turn', 'turn_id', p_turn_id, 'turn_version', p_version, 'reply_origin', p_reply_origin), now())
        on conflict (scope, key) do update
           set claim_token = excluded.claim_token, status = 'processing', summary = excluded.summary, metadata = excluded.metadata,
               attempts = public.idempotency_ledger.attempts + 1, started_at = now(), failed_at = null, last_error = null, updated_at = now()
         where public.idempotency_ledger.status = 'failed'   -- only a FAILED reservation is reclaimable
        returning key into v_key;
        if v_key is null then
          v_conflict := v_id;
          raise exception using errcode = 'P0001', message = 'conversation_reply_turn:inbound_already_reserved';
        end if;
      end loop;
    exception when raise_exception then
      -- every reservation taken above is rolled back with this block (all or none)
      update public.conversation_reply_turns
         set state = 'answered_elsewhere', close_reason = 'inbound_reply_reserved_by_other', outcome = 'answered_elsewhere',
             claim_token = null, claimed_by = null, lease_until = null, closed_at = now(), updated_at = now()
       where turn_id = p_turn_id;
      return jsonb_build_object('ok', true, 'reserved', false, 'state', 'answered_elsewhere', 'conflict_inbound_id', v_conflict);
    end;
  end if;
  -- rc-8.5.21 (owner directive: no duplicate response to the same inbound turn): a reserved
  -- (reply-bearing) decision hands the claimant the DISPATCH LEASE atomically, for as long as its
  -- claim lease. Only an EXPIRED dispatch lease lets another worker recover the dispatch
  -- (conversation_reply_turn_dispatch_claim); a live one makes every other worker defer.
  update public.conversation_reply_turns
     set state = 'decided', outcome = p_outcome, result = p_result, reply_origin = case when p_reserve then p_reply_origin else null end,
         reserved_inbound_ids = case when p_reserve then inbound_ids else null end,
         dispatch_state = case when p_reserve then 'in_flight' else null end,
         dispatch_worker = case when p_reserve then t.claimed_by else null end,
         dispatch_lease_until = case when p_reserve then now() + greatest(coalesce(t.lease_until - t.claimed_at, interval '120 seconds'), interval '10 seconds') else null end,
         dispatch_attempts = case when p_reserve then 1 else 0 end,
         dispatched_at = null,
         claim_token = null, claimed_by = null, lease_until = null, closed_at = now(), updated_at = now()
   where turn_id = p_turn_id
   returning * into t;
  return jsonb_build_object('ok', true, 'reserved', p_reserve, 'state', t.state, 'inbound_ids', to_jsonb(t.inbound_ids));
end
$$;

create or replace function public.conversation_reply_turn_dispatch_claim(p_turn_id uuid, p_version integer, p_worker text, p_lease_seconds integer default 120, p_max_attempts integer default 3)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $fn$
declare t public.conversation_reply_turns%rowtype;
begin
  if p_worker is null or p_worker !~ '^[A-Za-z0-9_.:-]{1,80}$' then return jsonb_build_object('ok', false, 'reason', 'worker_invalid'); end if;
  select * into t from public.conversation_reply_turns where turn_id = p_turn_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'turn_not_found'); end if;
  if t.version = p_version and t.dispatch_state in ('dispatched', 'deferred') then return jsonb_build_object('ok', false, 'reason', 'dispatch_done', 'dispatch_state', t.dispatch_state); end if;
  if t.version = p_version and t.dispatch_state = 'dead_letter' then return jsonb_build_object('ok', false, 'reason', 'dead_letter'); end if;
  if t.state <> 'decided' or t.reply_origin is distinct from 'ai_generated' or t.version <> p_version
     or coalesce(t.result ->> 'send_status', '') <> 'dispatch_pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_dispatchable', 'state', t.state, 'version', t.version);
  end if;
  if t.dispatch_lease_until is not null and t.dispatch_lease_until > clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'live_dispatch', 'dispatch_worker', t.dispatch_worker,
                              'retry_after_ms', ceil(extract(epoch from (t.dispatch_lease_until - clock_timestamp())) * 1000)::bigint);
  end if;
  if t.dispatch_attempts >= least(greatest(coalesce(p_max_attempts, 3), 1), 20) then
    update public.conversation_reply_turns set dispatch_state = 'dead_letter', dispatch_lease_until = null, updated_at = now() where turn_id = p_turn_id;
    return jsonb_build_object('ok', false, 'reason', 'attempts_exhausted', 'attempts', t.dispatch_attempts);
  end if;
  update public.conversation_reply_turns
     set dispatch_state = 'in_flight', dispatch_worker = p_worker,
         dispatch_lease_until = clock_timestamp() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 10), 900)),
         dispatch_attempts = dispatch_attempts + 1, updated_at = now()
   where turn_id = p_turn_id returning * into t;
  return jsonb_build_object('ok', true, 'token', t.result ->> 'reservation_token', 'version', t.version, 'attempt', t.dispatch_attempts,
                            'thread_key', t.thread_key, 'inbound_ids', to_jsonb(coalesce(t.reserved_inbound_ids, t.inbound_ids)), 'latest_inbound_id', t.latest_inbound_id,
                            'persona_name', t.persona_name, 'sender_number', t.sender_number, 'lease_until', t.dispatch_lease_until);
end
$fn$;

create or replace function public.conversation_reply_turn_dispatch_done(p_turn_id uuid, p_version integer, p_worker text, p_outcome text)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $fn$
declare t public.conversation_reply_turns%rowtype;
begin
  if p_outcome is null or p_outcome not in ('dispatched', 'deferred', 'released') then return jsonb_build_object('ok', false, 'reason', 'outcome_invalid'); end if;
  select * into t from public.conversation_reply_turns where turn_id = p_turn_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'turn_not_found'); end if;
  if t.version <> p_version or t.dispatch_worker is distinct from p_worker or t.dispatch_state is distinct from 'in_flight' then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost', 'dispatch_state', t.dispatch_state, 'version', t.version);
  end if;
  if p_outcome = 'dispatched' then
    update public.conversation_reply_turns
       set dispatch_state = 'dispatched', dispatched_at = clock_timestamp(), dispatch_lease_until = null,
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object('send_status', 'dispatched'), updated_at = now()
     where turn_id = p_turn_id;
  elsif p_outcome = 'deferred' then
    update public.conversation_reply_turns set dispatch_state = 'deferred', dispatch_lease_until = null, updated_at = now() where turn_id = p_turn_id;
  else
    -- a transient failure: expire the lease now so a retried job may recover the dispatch
    update public.conversation_reply_turns set dispatch_lease_until = clock_timestamp(), updated_at = now() where turn_id = p_turn_id;
  end if;
  return jsonb_build_object('ok', true, 'outcome', p_outcome);
end
$fn$;

revoke all on function public.conversation_reply_turn_dispatch_claim(uuid, integer, text, integer, integer) from public, anon, authenticated;
revoke all on function public.conversation_reply_turn_dispatch_done(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.conversation_reply_turn_dispatch_claim(uuid, integer, text, integer, integer) to service_role;
grant execute on function public.conversation_reply_turn_dispatch_done(uuid, integer, text, text) to service_role;

-- the DB backstop: one ai_generated send_queue row per conversation turn
create unique index send_queue_ai_turn_uq on public.send_queue ((metadata -> 'turn' ->> 'turn_id'))
  where metadata ->> 'message_origin' = 'ai_generated' and (metadata -> 'turn' ->> 'turn_id') is not null;

-- a retry with a caller-chosen delay (the 5-arg function is unchanged and does the transition)
create or replace function agent.runtime_finish(p_job_id text, p_token uuid, p_outcome text, p_result jsonb, p_error jsonb, p_retry_after_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $fn$
declare r jsonb; v_next timestamptz;
begin
  r := agent.runtime_finish(p_job_id, p_token, p_outcome, p_result, p_error);
  if p_outcome = 'retry' and p_retry_after_seconds is not null and coalesce((r ->> 'ok')::boolean, false)
     and not coalesce((r ->> 'idempotent')::boolean, false) and r ->> 'state' = 'retrying' then
    update agent.research_job set next_attempt_at = clock_timestamp() + make_interval(secs => least(greatest(p_retry_after_seconds, 1), 3600))
     where job_id = p_job_id and state = 'retrying' returning next_attempt_at into v_next;
    r := r || jsonb_build_object('next_attempt_at', v_next, 'retry_after_seconds', least(greatest(p_retry_after_seconds, 1), 3600));
  end if;
  return r;
end
$fn$;
revoke all on function agent.runtime_finish(text, uuid, text, jsonb, jsonb, integer) from public, anon, authenticated;
grant execute on function agent.runtime_finish(text, uuid, text, jsonb, jsonb, integer) to agent_api, service_role;

do $$
begin
  if to_regprocedure('public.conversation_reply_turn_dispatch_claim(uuid,integer,text,integer,integer)') is null
     or to_regprocedure('public.conversation_reply_turn_dispatch_done(uuid,integer,text,text)') is null
     or to_regprocedure('agent.runtime_finish(text,uuid,text,jsonb,jsonb,integer)') is null
     or to_regclass('public.send_queue_ai_turn_uq') is null then
    raise exception 'postcondition: dispatch lease objects missing';
  end if;
  if position('dispatch_lease_until' in pg_get_functiondef('public.conversation_reply_turn_finalize(uuid,uuid,integer,text,jsonb,boolean,text)'::regprocedure)) = 0 then
    raise exception 'postcondition: finalize must hand out the dispatch lease';
  end if;
end $$;
commit;
