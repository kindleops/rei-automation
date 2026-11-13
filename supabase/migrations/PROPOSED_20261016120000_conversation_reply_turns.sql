-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- LeadCommand 8.5.20 part A — the 24/7 EVENT-DRIVEN CONVERSATION ENGINE: durable,
-- consolidated reply TURNS (owner directive "AUTONOMOUS ACQUISITION OPERATING SYSTEM",
-- Phases 1A + 3 + 12, conversation side).
--
-- Requires (applied first): apps/api/supabase/migrations/20260831000000_durable_run_locks_and_idempotency_ledger.sql
-- (public.idempotency_ledger), PROPOSED_20261012140000_intel_runtime.sql (agent runtime),
-- PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql and
-- PROPOSED_20261013161000_conversation_decide_event_budget.sql (the event budget clamp
-- this file's runtime_enqueue_event_at repeats).
--
-- APPLY IN ONE TRANSACTION (no BEGIN/COMMIT here):
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261016120000_conversation_reply_turns.sql
-- Tested ONLY on a disposable PostgreSQL:
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id conversation_reply_turns
-- Pretest:  PROPOSED_20261016120000_conversation_reply_turns_pretest.sql
-- Posttest: PROPOSED_20261016120000_conversation_reply_turns_posttest.sql
-- Rollback: PROPOSED_20261016120000_conversation_reply_turns_rollback.sql
--
-- WHAT IT CREATES (no existing table or function body is altered; it arms NOTHING):
--
--   public.conversation_reply_turns        ONE row per reply TURN of a thread: the seller inbounds
--                                    it answers (members, consolidated), its VERSION (bumped by
--                                    every inbound that joins it: a draft for an older version
--                                    is stale), the planned due time (3–40 min, the delay
--                                    planner), the claim, and the outcome. At most ONE open
--                                    (pending / claimed) turn per thread (partial unique index).
--   public.conversation_reply_turn_open     join the open turn (version + 1, re-planned due, any claim
--                                    REVOKED, any draft invalidated) or open a new one; an
--                                    inbound already in a turn dedupes (idempotent per inbound).
--   public.conversation_reply_turn_claim    one worker claims a DUE turn at the exact version (lease);
--                                    an expired lease is reclaimable; a stale version is refused.
--   public.conversation_reply_turn_finalize the claimant closes its turn. With p_reserve (a reply will
--                                    be queued) it reserves EVERY member inbound in
--                                    public.idempotency_ledger scope 'inbound_reply' — the
--                                    reservation the template engine and the R3 executor share —
--                                    ALL OR NONE: one already held by another origin ⇒ the turn
--                                    is 'answered_elsewhere' and nothing is reserved. Exactly one
--                                    reply per resolved turn, whichever worker / origin.
--   public.conversation_reply_turn_cancel   cancel the open turn of a thread NOW (a stop request, an
--                                    operator take-over): no delay.
--   public.conversation_reply_turn_reopen   a reply that NEVER reached the provider: release its
--                                    reservations and re-decide (merged into the open turn when
--                                    one exists). Never used after acceptance / uncertain ack.
--   public.conversation_reply_turn_due      restart recovery: overdue pending turns and expired claims.
--   agent.runtime_enqueue_event_at    agent.runtime_enqueue_event + a NOT-BEFORE time (clamped to
--                                    ≤ 2 days ahead): the turn job's next_attempt_at IS the due
--                                    time — durable scheduling, never an in-process timer.
--
-- PRIVACY: thread_key is the seller phone (as in public.send_queue). RLS enabled + forced, NO
-- policies ⇒ backend (service_role) only; the functions are granted to service_role only.
-- Runtime job payloads never carry it (letter-encoded turn ids only; agent.payload_is_clean).
--
-- NAME COLLISION AVOIDED: production already has an UNRELATED legacy public.conversation_turns
-- (phase-3, 10 columns: id, thread_id, direction, channel, content, intent_detected,
-- confidence_score, handled_by, created_at, metadata; read by conversationMemoryService.js; listed
-- in operator_lockdown). Every object here is named conversation_reply_turn* and this file never
-- creates, alters, drops or reads it — except the read-only catalog guard below, which records its
-- column set before the DDL and aborts the transaction if it differs afterwards.
-- ════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  perform set_config('lc.legacy_conversation_turns_shape',
    (select coalesce(string_agg(format('%s %s %s', column_name, data_type, is_nullable), ',' order by column_name collate "C"), '<absent>')
       from information_schema.columns where table_schema = 'public' and table_name = 'conversation_turns'),
    false);
end
$$;

create table public.conversation_reply_turns (
  turn_id              uuid primary key default gen_random_uuid(),
  thread_key           text not null check (length(thread_key) between 1 and 64),
  turn_seq             integer not null check (turn_seq between 1 and 100000),
  state                text not null default 'pending'
                       check (state in ('pending', 'claimed', 'decided', 'answered_elsewhere', 'cancelled', 'superseded', 'held')),
  version              integer not null default 1 check (version between 1 and 1000),
  inbound_ids          text[] not null check (cardinality(inbound_ids) between 1 and 50),
  latest_inbound_id    text not null check (length(latest_inbound_id) between 1 and 80),
  first_inbound_at     timestamptz not null,
  latest_inbound_at    timestamptz not null,
  due_at               timestamptz,
  plan                 jsonb not null default '{}'::jsonb check (jsonb_typeof(plan) = 'object' and pg_column_size(plan) <= 8192),
  persona_name         text check (persona_name is null or persona_name ~ '^[A-Za-z][A-Za-z''-]{0,39}$'),
  sender_number        text check (sender_number is null or sender_number ~ '^\+1[0-9]{10}$'),
  stale_drafts         integer not null default 0 check (stale_drafts >= 0),
  claim_token          uuid,
  claimed_by           text check (claimed_by is null or claimed_by ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  claimed_version      integer,
  claimed_at           timestamptz,
  lease_until          timestamptz,
  outcome              text check (outcome is null or outcome ~ '^[a-z0-9_:.-]{1,80}$'),
  reply_origin         text check (reply_origin is null or reply_origin in ('template', 'ai_generated', 'operator_manual')),
  result               jsonb check (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 16384)),
  reserved_inbound_ids text[],
  close_reason         text check (close_reason is null or close_reason ~ '^[a-z0-9_:.-]{1,120}$'),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  closed_at            timestamptz,
  constraint conversation_reply_turns_seq_uq unique (thread_key, turn_seq),
  constraint conversation_reply_turns_latest_member check (latest_inbound_id = any (inbound_ids)),
  constraint conversation_reply_turns_claim_shape check ((state = 'claimed') = (claim_token is not null)),
  constraint conversation_reply_turns_open_due check (state not in ('pending', 'claimed') or due_at is not null),
  constraint conversation_reply_turns_closed_at check ((state in ('pending', 'claimed')) = (closed_at is null)),
  constraint conversation_reply_turns_reserved_subset check (reserved_inbound_ids is null or reserved_inbound_ids <@ inbound_ids)
);
comment on table public.conversation_reply_turns is
  'rc-8.5.20: one consolidated reply TURN per thread at a time (members = the seller inbounds it answers). version bumps on every joining inbound (older drafts are stale); due_at = the 3–40 min delay planner; finalize reserves every member in idempotency_ledger scope inbound_reply (all or none) so exactly one reply goes out per resolved turn across origins. Backend only.';

create unique index conversation_reply_turns_one_open_uq on public.conversation_reply_turns (thread_key) where state in ('pending', 'claimed');
create index conversation_reply_turns_due_idx on public.conversation_reply_turns (due_at) where state = 'pending';
create index conversation_reply_turns_lease_idx on public.conversation_reply_turns (lease_until) where state = 'claimed';
create index conversation_reply_turns_members_idx on public.conversation_reply_turns using gin (inbound_ids);
create index conversation_reply_turns_thread_idx on public.conversation_reply_turns (thread_key, turn_seq desc);

alter table public.conversation_reply_turns enable row level security;
alter table public.conversation_reply_turns force row level security;
revoke all on public.conversation_reply_turns from public, anon, authenticated;
grant select, insert, update on public.conversation_reply_turns to service_role;

-- ── open / join ────────────────────────────────────────────────────────────
create or replace function public.conversation_reply_turn_open(
  p_thread_key text, p_inbound_id text, p_inbound_at timestamptz, p_due_at timestamptz,
  p_plan jsonb default '{}'::jsonb, p_persona_name text default null, p_sender_number text default null)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  t public.conversation_reply_turns%rowtype;
  v_was_claimed boolean;
  v_seq integer;
begin
  if p_thread_key is null or length(p_thread_key) not between 1 and 64 then return jsonb_build_object('ok', false, 'reason', 'thread_key_invalid'); end if;
  if p_inbound_id is null or length(p_inbound_id) not between 1 and 80 then return jsonb_build_object('ok', false, 'reason', 'inbound_id_invalid'); end if;
  if p_inbound_at is null or p_due_at is null then return jsonb_build_object('ok', false, 'reason', 'times_required'); end if;
  -- one writer per thread at a time (concurrent inbounds of the same seller serialize here)
  perform pg_advisory_xact_lock(hashtextextended('public.conversation_reply_turn:' || p_thread_key, 0));

  -- idempotent per inbound: a replayed / duplicate event changes nothing
  select * into t from public.conversation_reply_turns
   where thread_key = p_thread_key and p_inbound_id = any (inbound_ids)
   order by turn_seq desc limit 1;
  if found then
    return jsonb_build_object('ok', true, 'deduped', true, 'turn_id', t.turn_id, 'version', t.version, 'state', t.state, 'due_at', t.due_at);
  end if;

  select * into t from public.conversation_reply_turns
   where thread_key = p_thread_key and state in ('pending', 'claimed')
   for update;
  if found then
    v_was_claimed := t.state = 'claimed';
    update public.conversation_reply_turns
       set inbound_ids = inbound_ids || p_inbound_id,
           latest_inbound_id = case when p_inbound_at >= latest_inbound_at then p_inbound_id else latest_inbound_id end,
           latest_inbound_at = greatest(latest_inbound_at, p_inbound_at),
           first_inbound_at = least(first_inbound_at, p_inbound_at),
           version = version + 1,
           due_at = p_due_at,
           plan = coalesce(p_plan, '{}'::jsonb),
           persona_name = coalesce(p_persona_name, persona_name),
           sender_number = coalesce(p_sender_number, sender_number),
           -- the in-flight decision (if any) is for an older version: its claim is revoked and
           -- its draft can never be finalized (finalize checks token + version)
           state = 'pending', claim_token = null, claimed_by = null, claimed_version = null, claimed_at = null, lease_until = null,
           updated_at = now()
     where turn_id = t.turn_id
     returning * into t;
    return jsonb_build_object('ok', true, 'extended', true, 'turn_id', t.turn_id, 'version', t.version, 'state', t.state,
                              'due_at', t.due_at, 'members', cardinality(t.inbound_ids), 'revoked_claim', v_was_claimed);
  end if;

  select coalesce(max(turn_seq), 0) + 1 into v_seq from public.conversation_reply_turns where thread_key = p_thread_key;
  insert into public.conversation_reply_turns (thread_key, turn_seq, state, version, inbound_ids, latest_inbound_id, first_inbound_at, latest_inbound_at,
                                         due_at, plan, persona_name, sender_number)
  values (p_thread_key, v_seq, 'pending', 1, array[p_inbound_id], p_inbound_id, p_inbound_at, p_inbound_at,
          p_due_at, coalesce(p_plan, '{}'::jsonb), p_persona_name, p_sender_number)
  returning * into t;
  return jsonb_build_object('ok', true, 'created', true, 'turn_id', t.turn_id, 'version', t.version, 'state', t.state, 'due_at', t.due_at, 'turn_seq', t.turn_seq);
end
$$;

-- ── claim ──────────────────────────────────────────────────────────────────
create or replace function public.conversation_reply_turn_claim(p_turn_id uuid, p_version integer, p_worker text, p_lease_seconds integer default 120)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare t public.conversation_reply_turns%rowtype;
begin
  if p_worker is null or p_worker !~ '^[A-Za-z0-9_.:-]{1,80}$' then return jsonb_build_object('ok', false, 'reason', 'worker_invalid'); end if;
  select * into t from public.conversation_reply_turns where turn_id = p_turn_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'turn_not_found'); end if;
  if t.state = 'claimed' and t.lease_until < now() then
    -- an expired claim (worker died): the turn is due again, at the same version
    update public.conversation_reply_turns
       set state = 'pending', claim_token = null, claimed_by = null, claimed_version = null, claimed_at = null, lease_until = null, updated_at = now()
     where turn_id = p_turn_id returning * into t;
  end if;
  if t.state <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'state_' || t.state, 'version', t.version); end if;
  if t.version <> p_version then return jsonb_build_object('ok', false, 'reason', 'stale_version', 'version', t.version, 'due_at', t.due_at); end if;
  if t.due_at > now() then return jsonb_build_object('ok', false, 'reason', 'not_due', 'version', t.version, 'due_at', t.due_at); end if;
  update public.conversation_reply_turns
     set state = 'claimed', claim_token = gen_random_uuid(), claimed_by = p_worker, claimed_version = version, claimed_at = now(),
         lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 10), 900)), updated_at = now()
   where turn_id = p_turn_id
   returning * into t;
  return jsonb_build_object('ok', true, 'token', t.claim_token, 'version', t.version, 'thread_key', t.thread_key,
                            'inbound_ids', to_jsonb(t.inbound_ids), 'latest_inbound_id', t.latest_inbound_id, 'lease_until', t.lease_until,
                            'persona_name', t.persona_name, 'sender_number', t.sender_number);
end
$$;

-- ── finalize (the one-reply-per-turn point) ───────────────────────────────
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
  update public.conversation_reply_turns
     set state = 'decided', outcome = p_outcome, result = p_result, reply_origin = case when p_reserve then p_reply_origin else null end,
         reserved_inbound_ids = case when p_reserve then inbound_ids else null end,
         claim_token = null, claimed_by = null, lease_until = null, closed_at = now(), updated_at = now()
   where turn_id = p_turn_id
   returning * into t;
  return jsonb_build_object('ok', true, 'reserved', p_reserve, 'state', t.state, 'inbound_ids', to_jsonb(t.inbound_ids));
end
$$;

-- ── cancel (immediate: stop request / operator take-over) ─────────────────
create or replace function public.conversation_reply_turn_cancel(p_thread_key text, p_reason text)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare n integer;
begin
  if p_reason is null or p_reason !~ '^[a-z0-9_:.-]{1,120}$' then return jsonb_build_object('ok', false, 'reason', 'reason_invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended('public.conversation_reply_turn:' || coalesce(p_thread_key, ''), 0));
  update public.conversation_reply_turns
     set state = 'cancelled', close_reason = p_reason, claim_token = null, claimed_by = null, lease_until = null, closed_at = now(), updated_at = now()
   where thread_key = p_thread_key and state in ('pending', 'claimed');
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'cancelled', n);
end
$$;

-- ── reopen (a reply that never reached the provider) ──────────────────────
create or replace function public.conversation_reply_turn_reopen(p_turn_id uuid, p_reason text, p_due_at timestamptz, p_plan jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  t public.conversation_reply_turns%rowtype;
  o public.conversation_reply_turns%rowtype;
begin
  if p_reason is null or p_reason !~ '^[a-z0-9_:.-]{1,120}$' then return jsonb_build_object('ok', false, 'reason', 'reason_invalid'); end if;
  if p_due_at is null then return jsonb_build_object('ok', false, 'reason', 'due_at_required'); end if;
  select * into t from public.conversation_reply_turns where turn_id = p_turn_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'turn_not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended('public.conversation_reply_turn:' || t.thread_key, 0));
  select * into t from public.conversation_reply_turns where turn_id = p_turn_id for update;
  if t.state <> 'decided' then return jsonb_build_object('ok', false, 'reason', 'state_' || t.state); end if;
  -- release ONLY this turn's own reservations (never another origin's)
  delete from public.idempotency_ledger
   where scope = 'inbound_reply' and key = any (coalesce(t.reserved_inbound_ids, '{}'))
     and metadata ->> 'turn_id' = p_turn_id::text;
  select * into o from public.conversation_reply_turns where thread_key = t.thread_key and state in ('pending', 'claimed') for update;
  if found then
    -- a newer turn is open: it absorbs these inbounds and is re-decided once
    update public.conversation_reply_turns
       set inbound_ids = (select array_agg(distinct x order by x) from unnest(o.inbound_ids || t.inbound_ids) x),
           first_inbound_at = least(o.first_inbound_at, t.first_inbound_at),
           version = version + 1, due_at = least(due_at, p_due_at), state = 'pending', claim_token = null, claimed_by = null,
           claimed_version = null, claimed_at = null, lease_until = null, updated_at = now()
     where turn_id = o.turn_id returning * into o;
    update public.conversation_reply_turns set state = 'superseded', close_reason = p_reason, reserved_inbound_ids = null, updated_at = now() where turn_id = p_turn_id;
    return jsonb_build_object('ok', true, 'merged_into', o.turn_id, 'version', o.version, 'due_at', o.due_at);
  end if;
  update public.conversation_reply_turns
     set state = 'pending', version = version + 1, due_at = p_due_at, plan = coalesce(p_plan, '{}'::jsonb), outcome = null, result = null,
         reply_origin = null, reserved_inbound_ids = null, close_reason = p_reason, closed_at = null, updated_at = now()
   where turn_id = p_turn_id returning * into t;
  return jsonb_build_object('ok', true, 'reopened', true, 'turn_id', t.turn_id, 'version', t.version, 'due_at', t.due_at);
end
$$;

-- ── recovery listing ──────────────────────────────────────────────────────
create or replace function public.conversation_reply_turn_due(p_limit integer default 50, p_grace_seconds integer default 60)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('turn_id', turn_id, 'version', version, 'state', state, 'due_at', due_at) order by due_at), '[]'::jsonb)
    from (select turn_id, version, state, due_at from public.conversation_reply_turns
           where (state = 'pending' and due_at <= now() - make_interval(secs => greatest(coalesce(p_grace_seconds, 60), 0)))
              or (state = 'claimed' and lease_until < now())
           order by due_at
           limit least(greatest(coalesce(p_limit, 50), 1), 500)) x
$$;

revoke all on function public.conversation_reply_turn_open(text, text, timestamptz, timestamptz, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.conversation_reply_turn_claim(uuid, integer, text, integer) from public, anon, authenticated;
revoke all on function public.conversation_reply_turn_finalize(uuid, uuid, integer, text, jsonb, boolean, text) from public, anon, authenticated;
revoke all on function public.conversation_reply_turn_cancel(text, text) from public, anon, authenticated;
revoke all on function public.conversation_reply_turn_reopen(uuid, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.conversation_reply_turn_due(integer, integer) from public, anon, authenticated;
grant execute on function public.conversation_reply_turn_open(text, text, timestamptz, timestamptz, jsonb, text, text) to service_role;
grant execute on function public.conversation_reply_turn_claim(uuid, integer, text, integer) to service_role;
grant execute on function public.conversation_reply_turn_finalize(uuid, uuid, integer, text, jsonb, boolean, text) to service_role;
grant execute on function public.conversation_reply_turn_cancel(text, text) to service_role;
grant execute on function public.conversation_reply_turn_reopen(uuid, text, timestamptz, jsonb) to service_role;
grant execute on function public.conversation_reply_turn_due(integer, integer) to service_role;

-- ── delayed event enqueue (durable scheduling on the R2 runtime) ──────────
-- agent.runtime_enqueue_event (the event-budget version) + a NOT-BEFORE time. The runtime
-- claims a job only when next_attempt_at <= now(), so the job IS the scheduled reply.
create or replace function agent.runtime_enqueue_event_at(p_kind text, p_event_key text, p_input jsonb, p_priority integer, p_not_before timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare v_armed text; v_cap numeric;
begin
  if p_event_key is null or length(p_event_key) not between 1 and 200 then return jsonb_build_object('ok', false, 'reason', 'event_key_invalid'); end if;
  if p_not_before is null then return jsonb_build_object('ok', false, 'reason', 'not_before_required'); end if;
  if p_not_before > clock_timestamp() + interval '2 days' then return jsonb_build_object('ok', false, 'reason', 'not_before_too_far'); end if;
  select kind_limits -> p_kind ->> 'armed_by',
         least(greatest(coalesce(case when (kind_limits -> p_kind ->> 'event_budget_cap_usd') ~ '^[0-9]+(\.[0-9]+)?$'
                                      then (kind_limits -> p_kind ->> 'event_budget_cap_usd')::numeric end, 0), 0), 0.05)
    into v_armed, v_cap
    from agent.runtime_limits where id = 1;
  if v_armed is null then return jsonb_build_object('ok', false, 'reason', 'kind_not_armed'); end if;
  return agent.runtime_enqueue_core(p_kind, encode(sha256(convert_to('event:' || p_kind || ':' || p_event_key, 'UTF8')), 'hex'),
    p_input, v_armed, 'event', 'event:' || p_kind, p_priority, 3, v_cap, false, null, null, p_not_before);
end
$$;
revoke all on function agent.runtime_enqueue_event_at(text, text, jsonb, integer, timestamptz) from public, anon, authenticated;
grant execute on function agent.runtime_enqueue_event_at(text, text, jsonb, integer, timestamptz) to agent_api;

-- ── guard: the unrelated legacy public.conversation_turns is unchanged ─────
do $$
declare
  before_shape text := current_setting('lc.legacy_conversation_turns_shape', true);
  after_shape text;
begin
  select coalesce(string_agg(format('%s %s %s', column_name, data_type, is_nullable), ',' order by column_name collate "C"), '<absent>') into after_shape
    from information_schema.columns where table_schema = 'public' and table_name = 'conversation_turns';
  if before_shape is null or after_shape is distinct from before_shape then
    raise exception 'conversation_reply_turns: the legacy public.conversation_turns changed (% -> %) — aborting', before_shape, after_shape;
  end if;
end
$$;
