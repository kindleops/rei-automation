-- POSTTEST for PROPOSED_20261029090000_ai_generated_outbound.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- One transaction ending in ROLLBACK (the runner proves the schema is unchanged afterwards):
--   A. an agent_outbound record (no inbound, queue_key agent_message:<uuid>) is accepted;
--   B. every reply invariant still binds a reply record (inbound required, its queue / idempotency keys, its outcome and
--      categories), and an outbound record can never carry an inbound or a reply category.
begin;
do $$
declare u uuid := gen_random_uuid(); ok boolean;
  ins text := 'insert into public.ai_generated_messages (queue_key, idempotency_key, inbound_message_id, thread_ref, recipient_ref, message_body, body_sha256, decision_id, decision_outcome, model, playbook_version, prompt_version, context_version, validation, ledger_snapshot_hash, authorization_scope, approval_state, generated_at, record_version, record_kind) values ($1, $2, $3, ''tr:' || repeat('a', 64) || ''', ''ph:' || repeat('b', 64) || ''', ''Hi there'', encode(sha256(convert_to(''Hi there'', ''UTF8'')), ''hex''), ''d'', $4, ''m'', ''p'', ''p'', ''c'', ''{"status":"validated"}'', ''' || repeat('c', 64) || ''', jsonb_build_object(''policy_hash'', ''x'', ''scope_match'', ''thread_keys'', ''category'', $5::text), ''policy_authorized'', now(), ''v'', $6)';
begin
  execute ins using 'agent_message:' || u, 'agent_message_intent:' || u, null::text, 'AI_GENERATED_OUTBOUND', 'first_touch', 'agent_outbound';
  -- B: each refused
  begin execute ins using 'agent_message:' || u || 'x', 'agent_message_intent:' || u, 'in-1', 'AI_GENERATED_OUTBOUND', 'first_touch', 'agent_outbound'; ok := true; exception when check_violation then ok := false; end;
  if ok then raise exception 'B: an outbound record with an inbound was accepted'; end if;
  begin execute ins using 'agent_message:' || gen_random_uuid(), 'agent_message_intent:x', null::text, 'AI_GENERATED_OUTBOUND', 'next_missing_fact', 'agent_outbound'; ok := true; exception when check_violation then ok := false; end;
  if ok then raise exception 'B: an outbound record with a reply category was accepted'; end if;
  begin execute ins using 'ai_conversation:x', 'inbound_reply:x', null::text, 'AI_GENERATED_REPLY', 'next_missing_fact', 'reply'; ok := true; exception when check_violation then ok := false; end;
  if ok then raise exception 'B: a reply record without an inbound was accepted'; end if;
  begin execute ins using 'ai_conversation:y', 'inbound_reply:y', 'y', 'AI_GENERATED_OUTBOUND', 'next_missing_fact', 'reply'; ok := true; exception when check_violation then ok := false; end;
  if ok then raise exception 'B: a reply record with the outbound outcome was accepted'; end if;
  execute ins using 'ai_conversation:z', 'inbound_reply:z', 'z', 'AI_GENERATED_REPLY', 'next_missing_fact', 'reply';
  raise notice 'posttest: outbound records accepted, every reply invariant intact';
end $$;
rollback;
