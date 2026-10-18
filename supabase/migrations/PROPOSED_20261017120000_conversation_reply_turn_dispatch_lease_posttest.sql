-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261017120000_conversation_reply_turn_dispatch_lease.sql:
-- the finalize hands out the dispatch lease; recovery is refused under a live lease (with a DB-clock
-- retry_after_ms), refused after a terminal outcome, allowed only after expiry; the attempts budget
-- dead-letters; the send_queue backstop refuses a second ai_generated row for one turn; the 6-arg
-- runtime_finish reschedules a retry at the caller's delay; grants.
-- DISPOSABLE DATABASE ONLY: never run against production.
-- No includes; one BEGIN first and one ROLLBACK last: nothing it writes survives.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id conversation_reply_turn_dispatch_lease
-- Expected last notice: "posttest(conversation_reply_turn_dispatch_lease): all assertions OK".
\set ON_ERROR_STOP on
begin;

do $$
declare
  r jsonb; c jsonb; f jsonb;
  ta uuid; tb uuid; tok uuid; jid text; jtok uuid;
  n integer;
  past timestamptz := now() - interval '1 minute';
  tid text := 'turn-' || gen_random_uuid()::text;
  op text := 'a2ee0ffe-6f27-475b-a795-ee617c9472c6';
begin
  -- ── a reserved decision hands the claimant the lease ──
  r := public.conversation_reply_turn_open('+15555550301', 'dl1', now() - interval '5 minutes', past);
  ta := (r ->> 'turn_id')::uuid;
  c := public.conversation_reply_turn_claim(ta, 1, 'leader', 60);
  tok := (c ->> 'token')::uuid;
  f := public.conversation_reply_turn_finalize(ta, tok, 1, 'reply:x', jsonb_build_object('send_status', 'dispatch_pending', 'reservation_token', tok), true, 'ai_generated');
  assert (f ->> 'ok')::boolean and (f ->> 'reserved')::boolean, 'finalize reserves: ' || f::text;
  assert (select dispatch_state = 'in_flight' and dispatch_worker = 'leader' and dispatch_attempts = 1
                 and dispatch_lease_until > clock_timestamp() + interval '50 seconds' from public.conversation_reply_turns where turn_id = ta),
         'the finalize hands the claimant the dispatch lease';

  -- ── a loser under a LIVE lease never dispatches ──
  r := public.conversation_reply_turn_dispatch_claim(ta, 1, 'loser', 60, 3);
  assert not (r ->> 'ok')::boolean and r ->> 'reason' = 'live_dispatch', 'live lease refuses recovery: ' || r::text;
  assert (r ->> 'retry_after_ms')::bigint between 50000 and 60000, 'retry_after_ms is the lease remaining (DB clock): ' || r::text;
  assert (select dispatch_worker = 'leader' and dispatch_attempts = 1 from public.conversation_reply_turns where turn_id = ta), 'a refused loser changes nothing';
  -- only the holder records an outcome
  r := public.conversation_reply_turn_dispatch_done(ta, 1, 'loser', 'dispatched');
  assert r ->> 'reason' = 'lease_lost', 'a non-holder cannot record: ' || r::text;
  r := public.conversation_reply_turn_dispatch_done(ta, 1, 'leader', 'dispatched');
  assert (r ->> 'ok')::boolean, 'the holder records dispatched';
  assert (select dispatch_state = 'dispatched' and dispatched_at is not null and result ->> 'send_status' = 'dispatched' from public.conversation_reply_turns where turn_id = ta), 'dispatched is terminal';
  -- a terminal outcome refuses recovery even after expiry
  update public.conversation_reply_turns set dispatch_lease_until = now() - interval '1 hour' where turn_id = ta;
  r := public.conversation_reply_turn_dispatch_claim(ta, 1, 'loser', 60, 3);
  assert r ->> 'reason' = 'dispatch_done', 'no recovery after a terminal outcome: ' || r::text;

  -- ── leader crash before dispatch: recovery ONLY after expiry, then the budget dead-letters ──
  r := public.conversation_reply_turn_open('+15555550302', 'dl2', now() - interval '5 minutes', past);
  tb := (r ->> 'turn_id')::uuid;
  c := public.conversation_reply_turn_claim(tb, 1, 'leader', 60);
  tok := (c ->> 'token')::uuid;
  perform public.conversation_reply_turn_finalize(tb, tok, 1, 'reply:x', jsonb_build_object('send_status', 'dispatch_pending', 'reservation_token', tok), true, 'ai_generated');
  r := public.conversation_reply_turn_dispatch_claim(tb, 1, 'rec1', 60, 3);
  assert r ->> 'reason' = 'live_dispatch', 'live: ' || r::text;
  update public.conversation_reply_turns set dispatch_lease_until = clock_timestamp() - interval '1 second' where turn_id = tb;
  r := public.conversation_reply_turn_dispatch_claim(tb, 1, 'rec1', 60, 3);
  assert (r ->> 'ok')::boolean and (r ->> 'token')::uuid = tok and (r ->> 'attempt')::int = 2, 'an expired lease is recovered with the SAME reservation token: ' || r::text;
  r := public.conversation_reply_turn_dispatch_claim(tb, 1, 'rec2', 60, 3);
  assert r ->> 'reason' = 'live_dispatch', 'the recoverer now holds a live lease: ' || r::text;
  r := public.conversation_reply_turn_dispatch_claim(tb, 2, 'rec2', 60, 3);
  assert r ->> 'reason' = 'not_dispatchable', 'a wrong version never recovers: ' || r::text;
  -- released (transient failure) expires the lease at once
  r := public.conversation_reply_turn_dispatch_done(tb, 1, 'rec1', 'released');
  assert (r ->> 'ok')::boolean, 'release';
  r := public.conversation_reply_turn_dispatch_claim(tb, 1, 'rec2', 60, 3);
  assert (r ->> 'ok')::boolean and (r ->> 'attempt')::int = 3, 'a released lease is recoverable: ' || r::text;
  perform public.conversation_reply_turn_dispatch_done(tb, 1, 'rec2', 'released');
  r := public.conversation_reply_turn_dispatch_claim(tb, 1, 'rec3', 60, 3);
  assert r ->> 'reason' = 'attempts_exhausted', 'the attempts budget is bounded: ' || r::text;
  assert (select dispatch_state from public.conversation_reply_turns where turn_id = tb) = 'dead_letter', 'exhaustion dead-letters the dispatch';
  r := public.conversation_reply_turn_dispatch_claim(tb, 1, 'rec3', 60, 3);
  assert r ->> 'reason' = 'dead_letter', 'dead letter is terminal: ' || r::text;
  r := public.conversation_reply_turn_dispatch_done(tb, 1, 'rec2', 'bogus');
  assert r ->> 'reason' = 'outcome_invalid', 'outcome vocabulary is closed';

  -- ── a shadow (unreserved) decision carries no lease ──
  r := public.conversation_reply_turn_open('+15555550303', 'dl3', now() - interval '5 minutes', past);
  c := public.conversation_reply_turn_claim((r ->> 'turn_id')::uuid, 1, 'w', 60);
  perform public.conversation_reply_turn_finalize((r ->> 'turn_id')::uuid, (c ->> 'token')::uuid, 1, 'shadow:x', '{"send_status":"not_sent_shadow"}'::jsonb, false, null);
  assert (select dispatch_state is null and dispatch_lease_until is null from public.conversation_reply_turns where turn_id = (r ->> 'turn_id')::uuid), 'shadow decisions hold no lease';

  -- ── the DB backstop: one ai_generated send_queue row per turn ──
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, metadata) values ('dl-a', 'queued', 'dispatch lease posttest', '+15555550399', jsonb_build_object('message_origin', 'ai_generated', 'turn', jsonb_build_object('turn_id', tid, 'version', 1)));
  begin
    insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, metadata) values ('dl-b', 'queued', 'dispatch lease posttest', '+15555550399', jsonb_build_object('message_origin', 'ai_generated', 'turn', jsonb_build_object('turn_id', tid, 'version', 2)));
    raise exception 'backstop: a second ai_generated row for the same turn was accepted';
  exception when unique_violation then null;
  end;
  -- other origins / rows without a turn are untouched by the index
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, metadata) values ('dl-c', 'queued', 'dispatch lease posttest', '+15555550399', jsonb_build_object('message_origin', 'template', 'turn', jsonb_build_object('turn_id', tid)));
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, metadata) values ('dl-d', 'queued', 'dispatch lease posttest', '+15555550399', jsonb_build_object('message_origin', 'ai_generated'));
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, metadata) values ('dl-e', 'queued', 'dispatch lease posttest', '+15555550399', jsonb_build_object('message_origin', 'ai_generated'));

  -- ── runtime_finish 6-arg: a retry at the caller's delay; the 5-arg is unchanged ──
  update agent.runtime_limits set kind_limits = jsonb_build_object('conversation.turn', jsonb_build_object('enabled', true, 'armed_by', op)) where id = 1;
  r := agent.runtime_enqueue_event_at('conversation.turn', 'dl:retry', '{}'::jsonb, 100, clock_timestamp());
  jid := r ->> 'job_id';
  assert jid is not null, 'enqueue: ' || r::text;
  update agent.runtime_limits set runtime_enabled = true, emergency_stop = false where id = 1;
  update agent.research_job set max_attempts = 2 where job_id = jid;
  c := agent.runtime_claim('w', 1, array['conversation.turn']);
  assert c -> 'claimed' -> 0 ->> 'job_id' = jid, 'claim: ' || c::text;
  jtok := (c -> 'claimed' -> 0 ->> 'lease_token')::uuid;
  r := agent.runtime_finish(jid, jtok, 'retry', null, '{"code":"DEFERRED_LIVE_DISPATCH"}'::jsonb, 45);
  assert (r ->> 'ok')::boolean and r ->> 'state' = 'retrying' and (r ->> 'retry_after_seconds')::int = 45, '6-arg retry: ' || r::text;
  assert (select next_attempt_at between clock_timestamp() + interval '40 seconds' and clock_timestamp() + interval '50 seconds' from agent.research_job where job_id = jid), 'next_attempt_at = now + retry-after';
  -- exhaustion still dead-letters (the budget is the job's max_attempts)
  update agent.research_job set next_attempt_at = clock_timestamp() - interval '1 second' where job_id = jid;
  c := agent.runtime_claim('w', 1, array['conversation.turn']);
  jtok := (c -> 'claimed' -> 0 ->> 'lease_token')::uuid;
  assert (c -> 'claimed' -> 0 ->> 'attempt')::int = 2, 'second attempt: ' || c::text;
  r := agent.runtime_finish(jid, jtok, 'retry', null, '{"code":"DEFERRED_LIVE_DISPATCH"}'::jsonb, 45);
  assert r ->> 'state' = 'dead_letter', 'the retry budget dead-letters: ' || r::text;

  -- ── grants ──
  assert has_function_privilege('service_role', 'public.conversation_reply_turn_dispatch_claim(uuid,integer,text,integer,integer)', 'execute');
  assert has_function_privilege('service_role', 'public.conversation_reply_turn_dispatch_done(uuid,integer,text,text)', 'execute');
  assert not has_function_privilege('anon', 'public.conversation_reply_turn_dispatch_claim(uuid,integer,text,integer,integer)', 'execute');
  assert not has_function_privilege('authenticated', 'public.conversation_reply_turn_dispatch_done(uuid,integer,text,text)', 'execute');
  assert has_function_privilege('agent_api', 'agent.runtime_finish(text,uuid,text,jsonb,jsonb,integer)', 'execute');
  assert not has_function_privilege('anon', 'agent.runtime_finish(text,uuid,text,jsonb,jsonb,integer)', 'execute');
  raise notice 'posttest(conversation_reply_turn_dispatch_lease): all assertions OK';
end $$;

rollback;
