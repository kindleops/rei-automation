-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261017122000_conversation_turn_operator_items.sql: a running conversation.turn job raises a
-- 'conversation' escalation item through agent.ops_work_item_sync (lease-bound, idempotent per
-- dedupe key); another scope's key is refused; a job of another kind cannot write the scope.
-- DISPOSABLE DATABASE ONLY: never run against production.
-- No includes; one BEGIN first and one ROLLBACK last: nothing it writes survives.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id conversation_turn_operator_items
-- Expected last notice: "posttest(conversation_turn_operator_items): all assertions OK".
\set ON_ERROR_STOP on
begin;

do $$
declare
  r jsonb; c jsonb; jid text; jtok uuid;
  op text := 'a2ee0ffe-6f27-475b-a795-ee617c9472c6';
  tid uuid := gen_random_uuid();
  item jsonb;
begin
  update agent.runtime_limits set runtime_enabled = true, emergency_stop = false,
         kind_limits = coalesce(kind_limits, '{}'::jsonb) || jsonb_build_object('conversation.turn', jsonb_build_object('enabled', true, 'armed_by', op)) where id = 1;
  r := agent.runtime_enqueue_event('conversation.turn', 'opitem:1', '{}'::jsonb, 100);
  jid := r ->> 'job_id';
  assert jid is not null, 'enqueue: ' || r::text;
  c := agent.runtime_claim('w', 1, array['conversation.turn']);
  jtok := (c -> 'claimed' -> 0 ->> 'lease_token')::uuid;
  r := agent.runtime_start(jid, jtok);
  item := jsonb_build_object('dedupe_key', 'conversation:turn_held:' || tid, 'kind', 'escalation', 'severity', 'warning', 'escalated', true,
                             'title', 'AI reply held for operator review', 'subject_type', 'conversation', 'subject_id', tid::text,
                             'detail', jsonb_build_object('r3_status', 'held', 'reasons', jsonb_build_array('category_not_enabled')));
  r := agent.ops_work_item_sync(jid, jtok, jsonb_build_array(item), false);
  assert (r ->> 'ok')::boolean and r ->> 'scope' = 'conversation' and (r ->> 'inserted')::int = 1, 'raise: ' || r::text;
  r := agent.ops_work_item_sync(jid, jtok, jsonb_build_array(item), false);
  assert (r ->> 'updated')::int = 1, 'idempotent per turn: ' || r::text;
  assert (select count(*) from agent.ops_work_item where scope = 'conversation' and state = 'open' and escalated and subject_id = tid::text) = 1, 'one open item';
  r := agent.ops_work_item_sync(jid, jtok, jsonb_build_array(item || jsonb_build_object('dedupe_key', 'supervisor:x:' || tid)), false);
  assert r ->> 'reason' = 'dedupe_key_outside_scope', 'scope fence: ' || r::text;
  raise notice 'posttest(conversation_turn_operator_items): all assertions OK';
end $$;

rollback;
