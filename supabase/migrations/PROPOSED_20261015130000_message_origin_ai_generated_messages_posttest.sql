-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261015130000_message_origin_ai_generated_messages.sql.
-- Runs after the runner applied the migration to a DISPOSABLE database. No transaction
-- control, no includes; it removes the send_queue rows it inserts (AI records cannot be
-- deleted: the rollback drops their table). Never run against production.
-- Expected last notice: "posttest(message_origin_ai_generated_messages): ALL OK".
do $$
declare
  v_body text := 'Thanks for confirming. Would you consider selling it?';
  v_sha text := encode(sha256(convert_to('Thanks for confirming. Would you consider selling it?', 'UTF8')), 'hex');
  v_id uuid;
  v_row public.send_queue%rowtype;
  v_n int;
  ok boolean;
begin
  -- ── existing producers are untouched: a campaign-shaped row (no origin) stores exactly what was given
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, template_id, selected_template_id, use_case_template, source, template_source, thread_key)
  values ('pt:campaign:1', 'queued', 'Hi Sam, do you still own 12 Elm?', '+15555550101', '+15555550199', 'tmpl-own-1', 'tmpl-own-1', 'ownership_check', 'campaign_launch_execution', 'sms_templates', '+15555550101')
  returning * into v_row;
  if v_row.message_origin is not null or v_row.template_id <> 'tmpl-own-1' or v_row.selected_template_id <> 'tmpl-own-1' or v_row.queue_status <> 'queued' or v_row.message_body <> 'Hi Sam, do you still own 12 Elm?' then
    raise exception 'assert: a legacy (origin NULL) template row is stored unchanged';
  end if;
  update public.send_queue set message_body = 'Hi Sam, do you still own 12 Elm St?' where queue_key = 'pt:campaign:1';  -- template rotation still allowed
  insert into public.send_queue (queue_key, message_body, to_phone_number, message_origin, template_id) values ('pt:template:1', 'Hi', '+15555550101', 'template', 'tmpl-1');
  insert into public.send_queue (queue_key, message_body, to_phone_number, message_origin, template_source) values ('pt:manual:1', 'Operator typed this', '+15555550101', 'operator_manual', 'manual_composer');
  begin
    insert into public.send_queue (queue_key, message_body, to_phone_number, message_origin) values ('pt:bad:1', 'x', '+15555550101', 'ai_written');
    raise exception 'assert: unknown origin must be refused';
  exception when check_violation then null;
  end;

  -- ── no template masquerade, on ANY origin
  begin
    insert into public.send_queue (queue_key, message_body, to_phone_number, template_id) values ('pt:mask:1', 'x', '+15555550101', 'ai-msg:0123456789abcdef0123456789abcdef');
    raise exception 'assert: ai-msg template id must be refused';
  exception when check_violation then null;
  end;

  -- ── ai_generated needs its immutable record
  begin
    insert into public.send_queue (queue_key, message_body, to_phone_number, message_origin) values ('ai_conversation:evt-1', v_body, '+15555550101', 'ai_generated');
    raise exception 'assert: ai_generated without a record must be refused';
  exception when check_violation then null;
  end;
  insert into public.ai_generated_messages (queue_key, idempotency_key, inbound_message_id, thread_ref, recipient_ref, message_body, body_sha256, decision_id, decision_outcome, model, playbook_version, prompt_version, context_version, validation, ledger_snapshot_hash, authorization_scope, approval_state, generated_at, record_version)
  values ('ai_conversation:evt-1', 'inbound_reply:evt-1', 'evt-1', 'tr:' || repeat('a', 64), 'ph:' || repeat('c', 64), v_body, v_sha, 'conv-ai:v1:evt-1', 'AI_GENERATED_REPLY', 'claude-haiku-5-5', 'playbook.v1', 'compose.v1', 'conv-ai.context.v1',
          '{"status":"validated"}', repeat('b', 64), '{"policy_hash":"x","scope_match":"thread_keys","category":"next_missing_fact"}', 'policy_authorized', now(), 'ai-generated-message.v1')
  returning id into v_id;
  begin
    insert into public.send_queue (queue_key, message_body, to_phone_number, message_origin, template_id) values ('ai_conversation:evt-1', v_body, '+15555550101', 'ai_generated', 'tmpl-1');
    raise exception 'assert: ai_generated with a template id must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.send_queue (queue_key, message_body, to_phone_number, message_origin) values ('ai_conversation:evt-1', 'Thanks. What is your lowest price?', '+15555550101', 'ai_generated');
    raise exception 'assert: ai_generated body/record mismatch must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.send_queue (queue_key, message_body, to_phone_number, message_origin) values ('ai_conversation:evt-9', v_body, '+15555550101', 'ai_generated');
    raise exception 'assert: a record is bound to its own queue key';
  exception when check_violation then null;
  end;
  insert into public.send_queue (queue_key, message_body, to_phone_number, message_origin, source, thread_key) values ('ai_conversation:evt-1', v_body, '+15555550101', 'ai_generated', 'ai_conversation', '+15555550101');
  begin
    update public.send_queue set message_body = 'Thanks. Any repairs needed?' where queue_key = 'ai_conversation:evt-1';
    raise exception 'assert: an AI row body cannot be rewritten';
  exception when check_violation then null;
  end;
  begin
    update public.send_queue set template_id = 'tmpl-1' where queue_key = 'ai_conversation:evt-1';
    raise exception 'assert: an AI row cannot acquire a template id';
  exception when check_violation then null;
  end;
  update public.send_queue set queue_status = 'cancelled' where queue_key = 'ai_conversation:evt-1';  -- status changes still allowed

  -- ── record immutability + single use + integrity
  begin
    update public.ai_generated_messages set message_body = 'edited' where id = v_id;
    raise exception 'assert: update refused';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.ai_generated_messages where id = v_id;
    raise exception 'assert: delete refused';
  exception when insufficient_privilege then null;
  end;
  begin
    truncate public.ai_generated_messages cascade;
    raise exception 'assert: truncate refused';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ai_generated_messages (queue_key, idempotency_key, inbound_message_id, thread_ref, recipient_ref, message_body, body_sha256, decision_id, decision_outcome, model, playbook_version, prompt_version, context_version, validation, ledger_snapshot_hash, authorization_scope, approval_state, generated_at, record_version)
    values ('ai_conversation:evt-1', 'inbound_reply:evt-1', 'evt-1', 'tr:' || repeat('a', 64), 'ph:' || repeat('c', 64), v_body, v_sha, 'd', 'AI_GENERATED_REPLY', 'm', 'p', 'p', 'c', '{"status":"validated"}', repeat('b', 64), '{"policy_hash":"x","scope_match":"thread_keys","category":"next_missing_fact"}', 'policy_authorized', now(), 'v');
    raise exception 'assert: one record per inbound';
  exception when unique_violation then null;
  end;
  begin
    insert into public.ai_generated_messages (queue_key, idempotency_key, inbound_message_id, thread_ref, recipient_ref, message_body, body_sha256, decision_id, decision_outcome, model, playbook_version, prompt_version, context_version, validation, ledger_snapshot_hash, authorization_scope, approval_state, generated_at, record_version)
    values ('ai_conversation:evt-2', 'inbound_reply:evt-2', 'evt-2', 'tr:' || repeat('a', 64), 'ph:' || repeat('c', 64), 'Thanks ' || chr(8212) || ' any repairs?', encode(sha256(convert_to('Thanks ' || chr(8212) || ' any repairs?', 'UTF8')), 'hex'), 'd', 'AI_GENERATED_REPLY', 'm', 'p', 'p', 'c', '{"status":"validated"}', repeat('b', 64), '{"policy_hash":"x","scope_match":"thread_keys","category":"next_missing_fact"}', 'policy_authorized', now(), 'v');
    raise exception 'assert: em dash refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.ai_generated_messages (queue_key, idempotency_key, inbound_message_id, thread_ref, recipient_ref, message_body, body_sha256, decision_id, decision_outcome, model, playbook_version, prompt_version, context_version, validation, ledger_snapshot_hash, authorization_scope, approval_state, generated_at, record_version)
    values ('ai_conversation:evt-3', 'inbound_reply:evt-3', 'evt-3', 'tr:' || repeat('a', 64), 'ph:' || repeat('c', 64), 'Any repairs?', v_sha, 'd', 'AI_GENERATED_REPLY', 'm', 'p', 'p', 'c', '{"status":"validated"}', repeat('b', 64), '{"policy_hash":"x","scope_match":"thread_keys","category":"next_missing_fact"}', 'policy_authorized', now(), 'v');
    raise exception 'assert: body hash mismatch refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.ai_generated_messages (queue_key, idempotency_key, inbound_message_id, thread_ref, recipient_ref, message_body, body_sha256, decision_id, decision_outcome, model, playbook_version, prompt_version, context_version, validation, ledger_snapshot_hash, authorization_scope, approval_state, generated_at, record_version)
    values ('ai_conversation:evt-4', 'inbound_reply:evt-4', 'evt-4', 'tr:' || repeat('a', 64), 'ph:' || repeat('c', 64), 'Any repairs?', encode(sha256(convert_to('Any repairs?', 'UTF8')), 'hex'), 'd', 'AI_GENERATED_REPLY', 'm', 'p', 'p', 'c', '{"status":"validated"}', repeat('b', 64), '{"policy_hash":"x","scope_match":"thread_keys","category":"offer"}', 'policy_authorized', now(), 'v');
    raise exception 'assert: offer / money category refused';
  exception when check_violation then null;
  end;

  -- ── lifecycle events are append-only
  insert into public.ai_generated_message_events (ai_message_id, event_type, detail) values (v_id, 'queued', '{"queue_key":"ai_conversation:evt-1"}');
  insert into public.ai_generated_message_events (ai_message_id, event_type, provider_result) values (v_id, 'provider_accepted', '{"status":"accepted"}');
  begin
    update public.ai_generated_message_events set event_type = 'delivered' where ai_message_id = v_id;
    raise exception 'assert: event update refused';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ai_generated_message_events (ai_message_id, event_type) values (v_id, 'resent');
    raise exception 'assert: unknown event refused';
  exception when check_violation then null;
  end;

  -- ── access: RLS forced, no policies, no anon/authenticated grants
  select relrowsecurity and relforcerowsecurity into ok from pg_class where oid = 'public.ai_generated_messages'::regclass;
  if not ok then raise exception 'assert: RLS forced'; end if;
  select count(*) into v_n from pg_policies where tablename in ('ai_generated_messages', 'ai_generated_message_events');
  if v_n <> 0 then raise exception 'assert: no policies'; end if;
  if has_table_privilege('anon', 'public.ai_generated_messages', 'select') or has_table_privilege('authenticated', 'public.ai_generated_messages', 'insert') then raise exception 'assert: no client grants'; end if;

  -- the existing asking-price trigger still runs on AI rows (the AI use case carries asking_price)
  insert into public.send_queue (queue_key, message_body, to_phone_number, queue_status, use_case_template, thread_key) values ('pt:ask:sent', 'What price?', '+15555550102', 'sent', 'seller_asking_price', '+15555550102');
  insert into public.send_queue (queue_key, message_body, to_phone_number, queue_status, use_case_template, thread_key) values ('pt:ask:repeat', 'Price?', '+15555550102', 'queued', 'ai_seller_asking_price', '+15555550102') returning * into v_row;
  if v_row.queue_status <> 'cancelled' or v_row.paused_reason <> 'blocked_repeat_asking_price' then raise exception 'assert: repeat asking-price trigger still applies'; end if;

  delete from public.send_queue where queue_key like 'pt:%' or queue_key = 'ai_conversation:evt-1';
  raise notice 'posttest(message_origin_ai_generated_messages): ALL OK';
end
$$;
