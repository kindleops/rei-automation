-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease.sql.
-- Restores conversation_reply_turn_claim and conversation_reply_turn_finalize to the exact rc-8.5.20 bodies, drops the dispatch functions,
-- the backstop index, the runtime_finish 6-arg wrapper and the dispatch columns. REFUSES while a
-- dispatch is in flight under a live lease (finish or let it expire first).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'conversation_reply_turns' and column_name = 'dispatch_state') then
    raise exception 'rollback precondition: the migration is not applied';
  end if;
  if exists (select 1 from public.conversation_reply_turns where dispatch_state = 'in_flight' and dispatch_lease_until > clock_timestamp()) then
    raise exception 'rollback precondition: a dispatch is in flight under a live lease';
  end if;
end $$;
drop index if exists public.send_queue_ai_turn_uq;
drop function if exists agent.runtime_finish(text, uuid, text, jsonb, jsonb, integer);
drop function if exists public.conversation_reply_turn_dispatch_claim(uuid, integer, text, integer, integer);
drop function if exists public.conversation_reply_turn_dispatch_done(uuid, integer, text, text, jsonb);
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
revoke all on function public.conversation_reply_turn_claim(uuid, integer, text, integer) from public, anon, authenticated;
grant execute on function public.conversation_reply_turn_claim(uuid, integer, text, integer) to service_role;

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
revoke all on function public.conversation_reply_turn_finalize(uuid, uuid, integer, text, jsonb, boolean, text) from public, anon, authenticated;
grant execute on function public.conversation_reply_turn_finalize(uuid, uuid, integer, text, jsonb, boolean, text) to service_role;
alter table public.conversation_reply_turns
  drop column dispatch_state, drop column dispatch_worker, drop column dispatch_lease_until, drop column dispatch_attempts, drop column dispatched_at;
commit;
