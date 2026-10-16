-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261016120000_conversation_turns.sql: consolidation,
-- idempotency per inbound, version-checked claims, stale-draft refusal, the all-or-none
-- inbound_reply reservation (one reply per turn across origins), cancel, reopen, recovery
-- listing, the delayed runtime enqueue, constraints and grants.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- No includes; one BEGIN first and one ROLLBACK last: nothing it writes survives.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id conversation_turns
-- Expected last notice: "posttest(conversation_turns): all assertions OK".
\set ON_ERROR_STOP on
begin;

do $$
declare
  r jsonb; c jsonb; f jsonb;
  ta uuid; tb uuid; tc uuid; td uuid; te uuid; te2 uuid;
  tok uuid; tok_old uuid;
  n integer;
  past timestamptz := now() - interval '1 minute';
  future timestamptz := now() + interval '10 minutes';
  op text := 'a2ee0ffe-6f27-475b-a795-ee617c9472c6';
begin
  -- ── consolidation + idempotency per inbound ──
  r := public.conversation_turn_open('+15555550101', 'a1', now() - interval '5 minutes', past, '{"v":1}', 'Helen', '+15555550199');
  assert (r ->> 'created')::boolean and (r ->> 'version')::int = 1, 'open creates v1: ' || r::text;
  ta := (r ->> 'turn_id')::uuid;
  r := public.conversation_turn_open('+15555550101', 'a1', now() - interval '5 minutes', past);
  assert (r ->> 'deduped')::boolean and (r ->> 'version')::int = 1, 'a replayed inbound dedupes: ' || r::text;
  r := public.conversation_turn_open('+15555550101', 'a2', now() - interval '4 minutes', past);
  assert (r ->> 'extended')::boolean and (r ->> 'version')::int = 2 and (r ->> 'members')::int = 2, 'a second inbound joins: ' || r::text;
  r := public.conversation_turn_open('+15555550101', 'a3', now() - interval '3 minutes', future);
  assert (r ->> 'version')::int = 3 and (r ->> 'turn_id')::uuid = ta, 'a third inbound joins the SAME turn';
  select count(*) into n from public.conversation_turns where thread_key = '+15555550101';
  assert n = 1, '3 rapid inbounds = ONE turn';
  assert (select latest_inbound_id from public.conversation_turns where turn_id = ta) = 'a3', 'latest member tracked';
  assert (select persona_name || sender_number from public.conversation_turns where turn_id = ta) = 'Helen+15555550199', 'persona + sender kept on join';

  -- ── claim: version + due checks ──
  c := public.conversation_turn_claim(ta, 2, 'w1');
  assert c ->> 'reason' = 'stale_version', 'an older version never claims: ' || c::text;
  c := public.conversation_turn_claim(ta, 3, 'w1');
  assert c ->> 'reason' = 'not_due', 'not before due: ' || c::text;
  update public.conversation_turns set due_at = past where turn_id = ta;
  c := public.conversation_turn_claim(ta, 3, 'w1');
  assert (c ->> 'ok')::boolean, 'claim at due: ' || c::text;
  tok_old := (c ->> 'token')::uuid;
  c := public.conversation_turn_claim(ta, 3, 'w2');
  assert c ->> 'reason' = 'state_claimed', 'a second worker cannot claim the same turn: ' || c::text;

  -- ── a new inbound during the claim: claim revoked, the old draft is stale ──
  r := public.conversation_turn_open('+15555550101', 'a4', now() - interval '1 minute', past);
  assert (r ->> 'revoked_claim')::boolean and (r ->> 'version')::int = 4, 'join revokes the in-flight claim: ' || r::text;
  f := public.conversation_turn_finalize(ta, tok_old, 3, 'reply_candidate', '{}'::jsonb, true, 'ai_generated');
  assert not (f ->> 'ok')::boolean and f ->> 'reason' in ('stale_version', 'claim_revoked'), 'stale draft refused: ' || f::text;
  assert (select stale_drafts from public.conversation_turns where turn_id = ta) = 1, 'stale draft counted';
  select count(*) into n from public.idempotency_ledger where scope = 'inbound_reply' and key in ('a1', 'a2', 'a3', 'a4');
  assert n = 0, 'a stale draft reserves nothing';

  -- ── finalize with the reservation: every member, exactly once ──
  c := public.conversation_turn_claim(ta, 4, 'w1');
  tok := (c ->> 'token')::uuid;
  f := public.conversation_turn_finalize(ta, gen_random_uuid(), 4, 'reply_candidate', '{}'::jsonb, true, 'ai_generated');
  assert f ->> 'reason' = 'claim_revoked', 'a wrong token never finalizes';
  f := public.conversation_turn_finalize(ta, tok, 4, 'reply_candidate', '{"k":"v"}'::jsonb, true, null);
  assert f ->> 'reason' = 'reply_origin_required', 'a reservation names its origin';
  f := public.conversation_turn_finalize(ta, tok, 4, 'reply_candidate', '{"k":"v"}'::jsonb, true, 'ai_generated');
  assert (f ->> 'reserved')::boolean and f ->> 'state' = 'decided', 'finalize reserves: ' || f::text;
  select count(*) into n from public.idempotency_ledger where scope = 'inbound_reply' and key in ('a1', 'a2', 'a3', 'a4') and metadata ->> 'turn_id' = ta::text;
  assert n = 4, 'all four members reserved for this turn';
  f := public.conversation_turn_finalize(ta, tok, 4, 'reply_candidate', null, true, 'ai_generated');
  assert not (f ->> 'ok')::boolean, 'a decided turn cannot be finalized twice';
  r := public.conversation_turn_open('+15555550101', 'a5', now(), past);
  assert (r ->> 'created')::boolean and (r ->> 'turn_seq')::int = 2, 'a later inbound opens a NEW turn: ' || r::text;
  perform public.conversation_turn_cancel('+15555550101', 'posttest_cleanup');

  -- ── all or none: an inbound already answered by another origin ──
  insert into public.idempotency_ledger (scope, key, status, summary, metadata) values ('inbound_reply', 'b2', 'completed', 'template_auto_reply', '{"engine":"template"}');
  r := public.conversation_turn_open('+15555550102', 'b1', now() - interval '3 minutes', past); tb := (r ->> 'turn_id')::uuid;
  perform public.conversation_turn_open('+15555550102', 'b2', now() - interval '2 minutes', past);
  c := public.conversation_turn_claim(tb, 2, 'w1');
  f := public.conversation_turn_finalize(tb, (c ->> 'token')::uuid, 2, 'reply_candidate', null, true, 'ai_generated');
  assert not (f ->> 'reserved')::boolean and f ->> 'state' = 'answered_elsewhere' and f ->> 'conflict_inbound_id' = 'b2', 'another origin holds a member: ' || f::text;
  assert not exists (select 1 from public.idempotency_ledger where scope = 'inbound_reply' and key = 'b1'), 'all or none: b1 not left reserved';
  assert (select state from public.conversation_turns where turn_id = tb) = 'answered_elsewhere';

  -- ── a FAILED reservation is reclaimable ──
  insert into public.idempotency_ledger (scope, key, status, summary) values ('inbound_reply', 'c1', 'failed', 'template_auto_reply');
  r := public.conversation_turn_open('+15555550103', 'c1', now() - interval '2 minutes', past); tc := (r ->> 'turn_id')::uuid;
  c := public.conversation_turn_claim(tc, 1, 'w1');
  f := public.conversation_turn_finalize(tc, (c ->> 'token')::uuid, 1, 'reply_candidate', null, true, 'template');
  assert (f ->> 'reserved')::boolean, 'a failed reservation is reclaimed: ' || f::text;
  assert (select status from public.idempotency_ledger where scope = 'inbound_reply' and key = 'c1') = 'processing';
  -- a shadow decision reserves nothing
  r := public.conversation_turn_open('+15555550103', 'c2', now(), past);
  c := public.conversation_turn_claim((r ->> 'turn_id')::uuid, 1, 'w1');
  f := public.conversation_turn_finalize((r ->> 'turn_id')::uuid, (c ->> 'token')::uuid, 1, 'shadow_decided', null, false, null);
  assert not (f ->> 'reserved')::boolean and f ->> 'state' = 'decided';
  assert not exists (select 1 from public.idempotency_ledger where scope = 'inbound_reply' and key = 'c2'), 'shadow: no reservation';

  -- ── one open turn per thread ──
  r := public.conversation_turn_open('+15555550104', 'd1', now(), future); td := (r ->> 'turn_id')::uuid;
  begin
    insert into public.conversation_turns (thread_key, turn_seq, inbound_ids, latest_inbound_id, first_inbound_at, latest_inbound_at, due_at)
    values ('+15555550104', 9, array['dx'], 'dx', now(), now(), now());
    raise exception 'assert: a second open turn must be refused';
  exception when unique_violation then null; end;

  -- ── cancel is immediate ──
  r := public.conversation_turn_cancel('+15555550104', 'stop_request');
  assert (r ->> 'cancelled')::int = 1 and (select state from public.conversation_turns where turn_id = td) = 'cancelled', 'cancel: ' || r::text;
  r := public.conversation_turn_cancel('+15555550104', 'Bad Reason!');
  assert r ->> 'reason' = 'reason_invalid';

  -- ── reopen: release only our reservations; merge into an open turn ──
  r := public.conversation_turn_reopen(ta, 'reply_not_sent_pre_acceptance', past);
  assert (r ->> 'reopened')::boolean and (r ->> 'version')::int = 5, 'reopen: ' || r::text;
  select count(*) into n from public.idempotency_ledger where scope = 'inbound_reply' and key in ('a1', 'a2', 'a3', 'a4');
  assert n = 0, 'reopen released this turn''s reservations';
  r := public.conversation_turn_reopen(tb, 'x', past);
  assert r ->> 'reason' = 'state_answered_elsewhere', 'only a decided turn reopens';
  assert exists (select 1 from public.idempotency_ledger where scope = 'inbound_reply' and key = 'b2'), 'another origin''s reservation is never released';
  r := public.conversation_turn_open('+15555550105', 'e1', now() - interval '9 minutes', past); te := (r ->> 'turn_id')::uuid;
  c := public.conversation_turn_claim(te, 1, 'w1');
  perform public.conversation_turn_finalize(te, (c ->> 'token')::uuid, 1, 'reply_candidate', null, true, 'ai_generated');
  r := public.conversation_turn_open('+15555550105', 'e2', now(), future); te2 := (r ->> 'turn_id')::uuid;
  r := public.conversation_turn_reopen(te, 'reply_not_sent_pre_acceptance', past);
  assert (r ->> 'merged_into')::uuid = te2, 'reopen merges into the open turn: ' || r::text;
  assert (select inbound_ids @> array['e1', 'e2'] from public.conversation_turns where turn_id = te2), 'merged members';
  assert (select state from public.conversation_turns where turn_id = te) = 'superseded';

  -- ── recovery listing: overdue pending + expired claims ──
  update public.conversation_turns set due_at = now() - interval '10 minutes' where turn_id = ta;
  r := public.conversation_turn_due(50, 60);
  assert r @> jsonb_build_array(jsonb_build_object('turn_id', ta)), 'overdue pending listed: ' || r::text;
  c := public.conversation_turn_claim(ta, 5, 'w1');
  update public.conversation_turns set lease_until = now() - interval '1 second' where turn_id = ta;
  r := public.conversation_turn_due(50, 60);
  assert r @> jsonb_build_array(jsonb_build_object('turn_id', ta, 'state', 'claimed')), 'expired claim listed';
  c := public.conversation_turn_claim(ta, 5, 'w9');
  assert (c ->> 'ok')::boolean, 'an expired claim is reclaimable at the same version: ' || c::text;

  -- ── constraints ──
  begin
    perform public.conversation_turn_open('+15555550106', 'f1', now(), now(), '{}'::jsonb, 'Helen', '5551234');
    raise exception 'assert: a malformed sender number must be refused';
  exception when check_violation then null; end;
  r := public.conversation_turn_open('', 'f1', now(), now());
  assert r ->> 'reason' = 'thread_key_invalid';

  -- ── the delayed runtime enqueue ──
  r := agent.runtime_enqueue_event_at('conversation.turn', 'turn:x#v1', '{}'::jsonb, 100, now() + interval '9 minutes');
  assert r ->> 'reason' = 'kind_not_armed', 'unarmed kind refused: ' || r::text;
  update agent.runtime_limits set kind_limits = jsonb_build_object('conversation.turn', jsonb_build_object('enabled', false, 'armed_by', op)) where id = 1;
  r := agent.runtime_enqueue_event_at('conversation.turn', 'turn:x#v1', '{"turn_ref":"abc"}'::jsonb, 100, clock_timestamp() + interval '9 minutes');
  assert (r ->> 'ok')::boolean and not (r ->> 'deduped')::boolean, 'enqueued: ' || r::text;
  assert (select next_attempt_at > clock_timestamp() + interval '8 minutes' from agent.research_job where job_id = r ->> 'job_id'), 'next_attempt_at is the due time';
  r := agent.runtime_enqueue_event_at('conversation.turn', 'turn:x#v1', '{"turn_ref":"abc"}'::jsonb, 100, clock_timestamp() + interval '9 minutes');
  assert (r ->> 'deduped')::boolean, 'same turn version dedupes';
  r := agent.runtime_enqueue_event_at('conversation.turn', 'turn:x#v2', '{}'::jsonb, 100, clock_timestamp() + interval '3 days');
  assert r ->> 'reason' = 'not_before_too_far';
  r := agent.runtime_enqueue_event_at('conversation.turn', 'turn:x#v2', '{}'::jsonb, 100, null);
  assert r ->> 'reason' = 'not_before_required';

  -- ── grants ──
  assert not has_table_privilege('anon', 'public.conversation_turns', 'select'), 'anon cannot read turns';
  assert not has_table_privilege('authenticated', 'public.conversation_turns', 'select'), 'authenticated cannot read turns';
  assert has_function_privilege('service_role', 'public.conversation_turn_finalize(uuid,uuid,integer,text,jsonb,boolean,text)', 'execute');
  assert not has_function_privilege('anon', 'public.conversation_turn_open(text,text,timestamptz,timestamptz,jsonb,text,text)', 'execute');
  assert not has_function_privilege('authenticated', 'public.conversation_turn_cancel(text,text)', 'execute');
  assert has_function_privilege('agent_api', 'agent.runtime_enqueue_event_at(text,text,jsonb,integer,timestamptz)', 'execute');
  assert not has_function_privilege('anon', 'agent.runtime_enqueue_event_at(text,text,jsonb,integer,timestamptz)', 'execute');
  assert (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.conversation_turns'::regclass), 'RLS forced';

  raise notice 'posttest(conversation_turns): all assertions OK';
end
$$;

rollback;
