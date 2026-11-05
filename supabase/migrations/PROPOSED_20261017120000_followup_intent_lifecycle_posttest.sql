-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261017120000_followup_intent_lifecycle.sql (P0 follow-up lifecycle).
-- Synthetic rows inside BEGIN … ROLLBACK (nothing persists). Proves on the real function and trigger bodies:
-- plan + same-transaction projection, supersede, the claim lease, the bind trigger (lease holder only,
-- nonempty body only), the sync trigger (claim / accept / delivery / failure / cancel from any path /
-- inbound supersede / ambiguous), the transition guard, re-materialization, the bounded reconcile retry,
-- the thread-state guard (live only), the no-empty-follow-up guard, the append-only audit, the views.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Expected last notice: "posttest(followup_intent_lifecycle): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;
do $$
declare
  r jsonb; i1 uuid; i2 uuid; tok uuid; q1 uuid; q2 uuid; v record; n int; e text; ok boolean;
  tk constant text := '+13125550901';
begin
  insert into public.inbox_thread_state (thread_key, follow_up_at) values (tk, null), ('+13125550902', null);
  insert into public.system_control (key, value) values ('followup_execution_mode', 'live') on conflict (key) do update set value = 'live';

  -- T1 plan → planned, projected in the same transaction, audited
  r := public.followup_intent_plan(jsonb_build_object('intent_key', 'pt:1', 'thread_key', tk, 'property_id', 'P1', 'kind', 'not_interested_nurture', 'intent', 'not_interested',
         'due_at', (now() - interval '1 minute')::text, 'writer', 'posttest', 'row_spec', jsonb_build_object('to_phone_number', tk)));
  i1 := (r->'intent'->>'id')::uuid;
  assert (r->>'ok')::boolean and (r->'intent'->>'state') = 'planned', 'T1 planned';
  assert (select follow_up_at from public.inbox_thread_state where thread_key = tk) = (select due_at from public.followup_intents where id = i1), 'T1 projected';
  assert (select count(*) from public.followup_intent_events where intent_id = i1 and to_state = 'planned') = 1, 'T1 audited';
  -- replay of the same key is idempotent
  assert (public.followup_intent_plan(jsonb_build_object('intent_key', 'pt:1', 'thread_key', tk, 'kind', 'not_interested_nurture', 'intent', 'not_interested', 'due_at', now()::text, 'writer', 'posttest'))->>'replay')::boolean, 'T1 replay';
  -- a non-executable record needs a reason; it is never projected
  begin perform public.followup_intent_plan(jsonb_build_object('intent_key', 'pt:x', 'thread_key', tk, 'kind', 'k', 'intent', 'i', 'due_at', now()::text, 'writer', 'w', 'state', 'not_executable')); ok := false;
  exception when others then ok := true; end;
  assert ok, 'T1 a non-executable without a reason is refused';

  -- T2 claim: a lease; a second claim gets nothing while the lease lives
  select lease_token into tok from public.followup_intent_claim('pt-worker', 5, 1800, 300, null) where id = i1;
  assert tok is not null, 'T2 claimed';
  assert not exists (select 1 from public.followup_intent_claim('pt-worker-2', 5, 1800, 300, null)), 'T2 a live lease is never stolen';

  -- T3 bind: empty body refused; wrong token refused; the lease holder binds → ready
  begin
    insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, metadata)
    values ('pt:q:empty', 'scheduled', ' ', tk, tk, 'followup', jsonb_build_object('followup_intent_id', i1, 'followup_materialize_token', tok)); ok := false;
  exception when others then get stacked diagnostics e = message_text; ok := e like 'FOLLOWUP_EMPTY_BODY%' or e like 'FOLLOWUP_INTENT: an empty message body%';
  end;
  assert ok, 'T3 empty body refused';
  begin
    insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, metadata)
    values ('pt:q:wrong', 'scheduled', 'Hi Dana, checking back on 12 Oak St.', tk, tk, 'followup', jsonb_build_object('followup_intent_id', i1, 'followup_materialize_token', gen_random_uuid())); ok := false;
  exception when others then get stacked diagnostics e = message_text; ok := e like 'FOLLOWUP_INTENT:%not materializing%';
  end;
  assert ok, 'T3 a stale / foreign lease is refused';
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, template_id, template_source, metadata)
  values ('pt:q:1', 'scheduled', 'Hi Dana, checking back on 12 Oak St.', tk, tk, 'followup', 't1', 'sms_templates', jsonb_build_object('followup_intent_id', i1, 'followup_materialize_token', tok))
  returning id into q1;
  select * into v from public.followup_intents where id = i1;
  assert v.state = 'ready' and v.send_queue_id = q1 and v.lease_token is null and v.template_id = 't1', 'T3 bound ready';

  -- T4 sync: claim → dispatched; accept → provider_accepted; delivered → delivered, projection cleared
  update public.send_queue set queue_status = 'processing', is_locked = true, lock_token = 'L' where id = q1;
  assert (select state from public.followup_intents where id = i1) = 'dispatched', 'T4 dispatched';
  update public.send_queue set queue_status = 'sent', sent_at = now(), provider_message_id = 'SMpt1', is_locked = false where id = q1;
  assert (select state from public.followup_intents where id = i1) = 'provider_accepted', 'T4 accepted';
  assert (select provider_message_id from public.followup_intents where id = i1) = 'SMpt1', 'T4 provider id';
  update public.send_queue set queue_status = 'delivered', delivered_at = now() where id = q1;
  select * into v from public.followup_intents where id = i1;
  assert v.state = 'delivered' and v.outcome = 'delivered' and v.next_action = 'await_reply' and v.closed_at is not null, 'T4 delivered';
  assert (select follow_up_at from public.inbox_thread_state where thread_key = tk) is null, 'T4 a delivered follow-up is not a scheduled date';
  -- terminal: a late failure is recorded, never applied; an illegal transition is refused
  update public.send_queue set failed_reason = 'late' where id = q1;
  assert (select state from public.followup_intents where id = i1) = 'delivered', 'T4 terminal is final';
  begin update public.followup_intents set state = 'planned' where id = i1; ok := false;
  exception when others then get stacked diagnostics e = message_text; ok := e like 'FOLLOWUP_INTENT_TRANSITION:%'; end;
  assert ok, 'T4 delivered → planned refused';

  -- T5 supersede by a newer plan (same thread × property × kind) cancels the older unsent row in the same txn
  r := public.followup_intent_plan(jsonb_build_object('intent_key', 'pt:2', 'thread_key', tk, 'property_id', 'P1', 'kind', 'seller_requested_callback', 'intent', 'seller_callback',
         'due_at', (now() - interval '1 minute')::text, 'writer', 'posttest'));
  i2 := (r->'intent'->>'id')::uuid;
  select lease_token into tok from public.followup_intent_claim('pt-worker', 5, 1800, 300, i2);
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, metadata)
  values ('pt:q:2', 'scheduled', 'Hi Dana, checking back as you asked.', tk, tk, 'followup', jsonb_build_object('followup_intent_id', i2, 'followup_materialize_token', tok)) returning id into q2;
  r := public.followup_intent_plan(jsonb_build_object('intent_key', 'pt:3', 'thread_key', tk, 'property_id', 'P1', 'kind', 'seller_requested_callback', 'intent', 'seller_callback',
         'due_at', (now() + interval '10 days')::text, 'writer', 'posttest'));
  assert (r->>'superseded')::int = 1, 'T5 superseded one';
  assert (select state from public.followup_intents where id = i2) = 'superseded', 'T5 older intent superseded';
  assert (select queue_status from public.send_queue where id = q2) = 'cancelled', 'T5 its unsent row cancelled';
  assert (select follow_up_at from public.inbox_thread_state where thread_key = tk) = (select due_at from public.followup_intents where intent_key = 'pt:3'), 'T5 projection moves to the live intent';

  -- T6 any-path cancel of a bound row (e.g. a STOP sweep) closes the intent; an inbound takeover supersedes
  select id into i2 from public.followup_intents where intent_key = 'pt:3';
  update public.followup_intents set next_attempt_at = now() where id = i2;
  begin
    -- due in 10 days: outside the lead window, not claimable
    assert not exists (select 1 from public.followup_intent_claim('pt-worker', 5, 1800, 300, i2)), 'T6 outside the lead window';
  end;
  select lease_token into tok from public.followup_intent_claim('pt-worker', 5, 864000 * 2, 300, i2);
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, metadata)
  values ('pt:q:3', 'scheduled', 'Hi Dana, checking back as you asked.', tk, tk, 'followup', jsonb_build_object('followup_intent_id', i2, 'followup_materialize_token', tok)) returning id into q2;
  update public.send_queue set queue_status = 'cancelled', metadata = metadata || '{"cancelled_by":"inbound_takeover"}'::jsonb where id = q2;
  select * into v from public.followup_intents where id = i2;
  assert v.state = 'superseded' and v.outcome = 'superseded', 'T6 an inbound takeover supersedes';
  assert (select follow_up_at from public.inbox_thread_state where thread_key = tk) is null, 'T6 nothing executable left';

  -- T7 failure classes: provably unsent ⇒ failed_before_accept (one bounded re-plan, after the 24 h window);
  --    ambiguous ⇒ failed_ambiguous (final)
  r := public.followup_intent_plan(jsonb_build_object('intent_key', 'pt:4', 'thread_key', tk, 'kind', 'k4', 'intent', 'not_interested', 'due_at', (now() - interval '1 minute')::text, 'writer', 'posttest'));
  i1 := (r->'intent'->>'id')::uuid;
  select lease_token into tok from public.followup_intent_claim('pt-worker', 5, 1800, 300, i1);
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, metadata)
  values ('pt:q:4', 'scheduled', 'Hi Dana, checking back on 12 Oak St.', tk, tk, 'followup', jsonb_build_object('followup_intent_id', i1, 'followup_materialize_token', tok)) returning id into q1;
  update public.send_queue set queue_status = 'failed', failed_reason = 'SEND REJECTED BY PROVIDER - NO SID', metadata = metadata || '{"failure_bucket":"provider_rejected"}'::jsonb where id = q1;
  assert (select outcome from public.followup_intents where id = i1) = 'failed_before_accept', 'T7 provably unsent';
  assert (public.followup_intent_requeue_failed(i1, 'pt_retry', 'posttest')->>'ok')::boolean, 'T7 one re-plan';
  select * into v from public.followup_intents where id = i1;
  assert v.state = 'planned' and v.materialize_seq = 2 and v.next_attempt_at > now() + interval '23 hours', 'T7 after the duplicate window';
  update public.followup_intents set next_attempt_at = now() where id = i1;
  select lease_token into tok from public.followup_intent_claim('pt-worker', 5, 1800, 300, i1);
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, metadata)
  values ('pt:q:4b', 'scheduled', 'Hi Dana, checking back on 12 Oak St.', tk, tk, 'followup', jsonb_build_object('followup_intent_id', i1, 'followup_materialize_token', tok)) returning id into q1;
  update public.send_queue set queue_status = 'failed', failed_reason = 'SEND REJECTED BY PROVIDER - NO SID', metadata = metadata || '{"failure_bucket":"provider_rejected"}'::jsonb where id = q1;
  assert not (public.followup_intent_requeue_failed(i1, 'pt_retry', 'posttest')->>'ok')::boolean, 'T7 bounded: only one re-plan';
  r := public.followup_intent_plan(jsonb_build_object('intent_key', 'pt:5', 'thread_key', tk, 'kind', 'k5', 'intent', 'not_interested', 'due_at', (now() - interval '1 minute')::text, 'writer', 'posttest'));
  i2 := (r->'intent'->>'id')::uuid;
  select lease_token into tok from public.followup_intent_claim('pt-worker', 5, 1800, 300, i2);
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, metadata)
  values ('pt:q:5', 'scheduled', 'Hi Dana, checking back on 12 Oak St.', tk, tk, 'followup', jsonb_build_object('followup_intent_id', i2, 'followup_materialize_token', tok)) returning id into q2;
  update public.send_queue set queue_status = 'failed', failed_reason = 'SEND FAILED - NO SID', metadata = metadata || '{"failure_bucket":"provider_no_sid"}'::jsonb where id = q2;
  select * into v from public.followup_intents where id = i2;
  assert v.outcome = 'failed_ambiguous' and v.next_action = 'human_review_no_resend', 'T7 ambiguous';
  assert not (public.followup_intent_requeue_failed(i2, 'pt_retry', 'posttest')->>'ok')::boolean, 'T7 ambiguous is never re-planned';

  -- T8 re-materialize (template revoked at dispatch) while the row is claimed
  r := public.followup_intent_plan(jsonb_build_object('intent_key', 'pt:6', 'thread_key', '+13125550902', 'kind', 'k6', 'intent', 'not_interested', 'due_at', (now() - interval '1 minute')::text, 'writer', 'posttest'));
  i1 := (r->'intent'->>'id')::uuid;
  select lease_token into tok from public.followup_intent_claim('pt-worker', 5, 1800, 300, i1);
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, metadata)
  values ('pt:q:6', 'scheduled', 'Hi Dana, checking back on 12 Oak St.', '+13125550902', '+13125550902', 'followup', jsonb_build_object('followup_intent_id', i1, 'followup_materialize_token', tok)) returning id into q1;
  update public.send_queue set queue_status = 'processing' where id = q1;
  assert (public.followup_intent_rematerialize(i1, q1, 'template_revoked_rematerialize', 'posttest')->>'ok')::boolean, 'T8 re-plan';
  select * into v from public.followup_intents where id = i1;
  assert v.state = 'planned' and v.materialize_seq = 2 and v.send_queue_id is null, 'T8 planned, unbound';
  assert (select queue_status from public.send_queue where id = q1) = 'cancelled', 'T8 the claimed row is cancelled';
  begin update public.followup_intents set state = 'ready' where id = i1; ok := false; exception when others then ok := true; end;
  assert ok, 'T8 ready needs a bound row';

  -- T9 thread-state guard (live): a bare follow_up_at becomes a documented not_executable; off ⇒ inert
  update public.inbox_thread_state set follow_up_at = now() + interval '30 days' where thread_key = '+13125550902';
  assert (select follow_up_at from public.inbox_thread_state where thread_key = '+13125550902') = (select due_at from public.followup_intents where id = i1), 'T9 projection kept';
  assert exists (select 1 from public.followup_intents where thread_key = '+13125550902' and state = 'not_executable' and reason = 'bare_follow_up_at_write_without_intent'), 'T9 recorded';
  update public.system_control set value = 'off' where key = 'followup_execution_mode';
  update public.inbox_thread_state set follow_up_at = now() + interval '31 days' where thread_key = '+13125550902';
  assert (select follow_up_at from public.inbox_thread_state where thread_key = '+13125550902') > now() + interval '30 days', 'T9 off: inert';
  -- off: a legacy body-less follow-up row is still accepted (and still paused by the loader)
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, metadata)
  values ('pt:q:legacy', 'scheduled', '', tk, tk, 'followup', '{"deferred_message_resolution":true}'::jsonb);
  update public.system_control set value = 'live' where key = 'followup_execution_mode';
  begin
    insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, metadata)
    values ('pt:q:legacy2', 'scheduled', '', tk, tk, 'followup', '{"deferred_message_resolution":true}'::jsonb); ok := false;
  exception when others then get stacked diagnostics e = message_text; ok := e like 'FOLLOWUP_EMPTY_BODY%'; end;
  assert ok, 'T9 live: a claimable empty-body follow-up is refused from any writer';

  -- T10 audit is append-only; intents are never deleted; the views count states, never held as scheduled
  begin update public.followup_intent_events set reason = 'x' where intent_id = i1; ok := false; exception when others then ok := true; end;
  assert ok, 'T10 events immutable';
  begin delete from public.followup_intents where id = i1; ok := false; exception when others then ok := true; end;
  assert ok, 'T10 intents never deleted';
  select * into v from public.v_followup_intent_health;
  assert v.delivered >= 1 and v.failed >= 2 and v.failed_ambiguous >= 1 and v.not_executable >= 1 and v.superseded >= 2, 'T10 health counts';
  assert v.scheduled_executable = (select count(*) from public.followup_intents where state in ('planned', 'materializing', 'ready', 'dispatched')), 'T10 scheduled = executable only';
  assert exists (select 1 from public.v_followup_intent_reasons where reason = 'bare_follow_up_at_write_without_intent'), 'T10 reasons view';

  raise notice 'posttest(followup_intent_lifecycle): ALL OK (rolled back)';
end $$;
rollback;
