-- POSTTEST for PROPOSED_20261029090000_ai_generated_outbound.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- One transaction ending in ROLLBACK (the runner proves the schema is unchanged afterwards):
--   A. an agent_outbound record (no inbound, queue_key agent_message:<uuid>) is accepted;
--   B. every reply invariant still binds a reply record (inbound required, its queue / idempotency keys, its outcome and
--      categories), and an outbound record can never carry an inbound or a reply category;
--   C. an agent_text record (the agent's exact text, its author) is accepted with or without the inbound it answers; it
--      needs its author (employee + route) and its own keys / outcome / category; ONE answer per inbound across kinds;
--      no other kind carries an author.
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

do $$
declare u uuid := gen_random_uuid(); v uuid := gen_random_uuid(); w uuid := gen_random_uuid(); ok boolean;
  ins text := 'insert into public.ai_generated_messages (queue_key, idempotency_key, inbound_message_id, thread_ref, recipient_ref, message_body, body_sha256, decision_id, decision_outcome, model, playbook_version, prompt_version, context_version, validation, ledger_snapshot_hash, authorization_scope, approval_state, generated_at, record_version, record_kind, author_employee, author_attribution) values ($1, $2, $3, ''tr:' || repeat('a', 64) || ''', ''ph:' || repeat('b', 64) || ''', ''Hi there'', encode(sha256(convert_to(''Hi there'', ''UTF8'')), ''hex''), ''d'', $4, ''m'', ''p'', ''p'', ''c'', ''{"status":"validated"}'', ''' || repeat('c', 64) || ''', jsonb_build_object(''policy_hash'', ''x'', ''scope_match'', ''agent_text'', ''category'', $5::text), ''policy_authorized'', now(), ''v'', $6, $7, $8::jsonb)';
  attr text := '{"employee":"sterling","model":"m","provider":"p","route":"agntei.acquisitions","session_id":"s","turn_id":"t"}';
begin
  -- C: an initiated text (no inbound) and an answer (its inbound) are accepted
  execute ins using 'agent_text:' || u, 'agent_text_intent:' || u, null::text, 'AGENT_COMPOSED_TEXT', 'first_touch', 'agent_text', 'sterling', attr;
  execute ins using 'agent_text:' || v, 'agent_text_intent:' || v, 'in-c1', 'AGENT_COMPOSED_TEXT', 'reply', 'agent_text', 'sterling', attr;
  -- one answer per inbound, whatever the kind
  begin execute ins using 'agent_text:' || w, 'agent_text_intent:' || w, 'in-c1', 'AGENT_COMPOSED_TEXT', 'reply', 'agent_text', 'sterling', attr; ok := true; exception when unique_violation then ok := false; end;
  if ok then raise exception 'C: a second answer to one inbound was accepted'; end if;
  -- the author is required (employee + route), and must be the attribution's employee
  begin execute ins using 'agent_text:' || gen_random_uuid(), 'agent_text_intent:y', null::text, 'AGENT_COMPOSED_TEXT', 'followup', 'agent_text', null::text, null::text; ok := true; exception when check_violation then ok := false; end;
  if ok then raise exception 'C: an agent_text record without its author was accepted'; end if;
  begin execute ins using 'agent_text:' || gen_random_uuid(), 'agent_text_intent:y', null::text, 'AGENT_COMPOSED_TEXT', 'followup', 'agent_text', 'nova', attr; ok := true; exception when check_violation then ok := false; end;
  if ok then raise exception 'C: an author that is not the attribution''s employee was accepted'; end if;
  begin execute ins using 'agent_text:' || gen_random_uuid(), 'agent_text_intent:y', null::text, 'AGENT_COMPOSED_TEXT', 'followup', 'agent_text', 'sterling', '{"employee":"sterling"}'; ok := true; exception when check_violation then ok := false; end;
  if ok then raise exception 'C: an attribution without its route was accepted'; end if;
  -- its own outcome, category and keys
  begin execute ins using 'agent_text:' || gen_random_uuid(), 'agent_text_intent:z', null::text, 'AI_GENERATED_OUTBOUND', 'followup', 'agent_text', 'sterling', attr; ok := true; exception when check_violation then ok := false; end;
  if ok then raise exception 'C: an agent_text record with a composed-by-LeadCommand outcome was accepted'; end if;
  begin execute ins using 'agent_text:' || gen_random_uuid(), 'agent_text_intent:z', null::text, 'AGENT_COMPOSED_TEXT', 'next_missing_fact', 'agent_text', 'sterling', attr; ok := true; exception when check_violation then ok := false; end;
  if ok then raise exception 'C: an agent_text record with a reply category was accepted'; end if;
  begin execute ins using 'agent_message:' || gen_random_uuid(), 'agent_text_intent:z', null::text, 'AGENT_COMPOSED_TEXT', 'followup', 'agent_text', 'sterling', attr; ok := true; exception when check_violation then ok := false; end;
  if ok then raise exception 'C: an agent_text record under another kind''s queue key was accepted'; end if;
  -- no other kind carries an author
  begin execute ins using 'ai_conversation:w', 'inbound_reply:w', 'w', 'AI_GENERATED_REPLY', 'next_missing_fact', 'reply', 'sterling', attr; ok := true; exception when check_violation then ok := false; end;
  if ok then raise exception 'C: a reply record with an author was accepted'; end if;
  raise notice 'posttest: agent_text records carry their author and keep one answer per inbound';
end $$;
rollback;
