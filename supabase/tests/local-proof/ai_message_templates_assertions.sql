-- LOCAL DISPOSABLE DB ONLY. Assertions for PROPOSED_20261015120000_ai_message_templates.sql.
-- No transaction control, no includes. Run after the migration by
-- apps/api/scripts/proof/local-pg-migration-proof.mjs. Expected last notice:
-- "local-proof(ai_message_templates): ALL OK".
do $$
declare
  v_body text := 'Thanks for confirming. Would you consider selling it?';
  v_sha text := encode(sha256(convert_to('Thanks for confirming. Would you consider selling it?', 'UTF8')), 'hex');
  v_n int;
begin
  insert into public.ai_message_templates (template_id, use_case, template_body, body_sha256, inbound_message_id, queue_key, thread_ref, model, decision_id, draft_hash, validator_verdict, ledger_snapshot_hash, policy_version, policy_authorization, record_version)
  values ('ai-msg:0123456789abcdef0123456789abcdef', 'ai_consider_selling', v_body, v_sha, 'evt-1', 'ai_conversation:evt-1', 'tr:' || repeat('a', 64), 'claude-haiku-5-5', 'conv-ai:v1:evt-1', v_sha,
          '{"status":"validated_draft"}', repeat('b', 64), 'conv-ai.send-policy.v1', '{"policy_hash":"x","category":"next_missing_fact","scope_match":"thread_keys"}', 'ai-message-record.v1');

  -- immutability: UPDATE refused
  begin
    update public.ai_message_templates set template_body = 'edited' where inbound_message_id = 'evt-1';
    raise exception 'assert: update must be refused';
  exception when insufficient_privilege then null;
  end;
  -- immutability: DELETE refused
  begin
    delete from public.ai_message_templates where inbound_message_id = 'evt-1';
    raise exception 'assert: delete must be refused';
  exception when insufficient_privilege then null;
  end;
  -- immutability: TRUNCATE refused
  begin
    truncate public.ai_message_templates;
    raise exception 'assert: truncate must be refused';
  exception when insufficient_privilege then null;
  end;
  -- one record per message: a second record for the same inbound is refused
  begin
    insert into public.ai_message_templates (template_id, use_case, template_body, body_sha256, inbound_message_id, queue_key, thread_ref, decision_id, draft_hash, validator_verdict, ledger_snapshot_hash, policy_version, policy_authorization, record_version)
    values ('ai-msg:ffffffffffffffffffffffffffffffff', 'ai_consider_selling', v_body, v_sha, 'evt-1', 'ai_conversation:evt-1', 'tr:' || repeat('a', 64), 'd', v_sha, '{"status":"validated_draft"}', repeat('b', 64), 'v', '{"policy_hash":"x","category":"next_missing_fact","scope_match":"thread_keys"}', 'v1');
    raise exception 'assert: duplicate inbound must be refused';
  exception when unique_violation then null;
  end;
  -- body hash must match the body
  begin
    insert into public.ai_message_templates (template_id, use_case, template_body, body_sha256, inbound_message_id, queue_key, thread_ref, decision_id, draft_hash, validator_verdict, ledger_snapshot_hash, policy_version, policy_authorization, record_version)
    values ('ai-msg:11111111111111111111111111111111', 'ai_consider_selling', 'a different body', v_sha, 'evt-2', 'ai_conversation:evt-2', 'tr:' || repeat('a', 64), 'd', v_sha, '{"status":"validated_draft"}', repeat('b', 64), 'v', '{"policy_hash":"x","category":"next_missing_fact","scope_match":"thread_keys"}', 'v1');
    raise exception 'assert: body/hash mismatch must be refused';
  exception when check_violation then null;
  end;
  -- never selectable: is_active = true refused
  begin
    insert into public.ai_message_templates (template_id, use_case, template_body, body_sha256, is_active, inbound_message_id, queue_key, thread_ref, decision_id, draft_hash, validator_verdict, ledger_snapshot_hash, policy_version, policy_authorization, record_version)
    values ('ai-msg:22222222222222222222222222222222', 'ai_consider_selling', v_body, v_sha, true, 'evt-3', 'ai_conversation:evt-3', 'tr:' || repeat('a', 64), 'd', v_sha, '{"status":"validated_draft"}', repeat('b', 64), 'v', '{"policy_hash":"x","category":"next_missing_fact","scope_match":"thread_keys"}', 'v1');
    raise exception 'assert: is_active=true must be refused';
  exception when check_violation then null;
  end;
  -- unvalidated draft refused; out-of-scope category refused; non-ai id refused
  begin
    insert into public.ai_message_templates (template_id, use_case, template_body, body_sha256, inbound_message_id, queue_key, thread_ref, decision_id, draft_hash, validator_verdict, ledger_snapshot_hash, policy_version, policy_authorization, record_version)
    values ('ai-msg:33333333333333333333333333333333', 'ai_consider_selling', v_body, v_sha, 'evt-4', 'ai_conversation:evt-4', 'tr:' || repeat('a', 64), 'd', v_sha, '{"status":"rejected_with_reasons"}', repeat('b', 64), 'v', '{"policy_hash":"x","category":"next_missing_fact","scope_match":"thread_keys"}', 'v1');
    raise exception 'assert: unvalidated must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.ai_message_templates (template_id, use_case, template_body, body_sha256, inbound_message_id, queue_key, thread_ref, decision_id, draft_hash, validator_verdict, ledger_snapshot_hash, policy_version, policy_authorization, record_version)
    values ('ai-msg:44444444444444444444444444444444', 'ai_consider_selling', v_body, v_sha, 'evt-5', 'ai_conversation:evt-5', 'tr:' || repeat('a', 64), 'd', v_sha, '{"status":"validated_draft"}', repeat('b', 64), 'v', '{"policy_hash":"x","category":"offer","scope_match":"thread_keys"}', 'v1');
    raise exception 'assert: money/offer category must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.ai_message_templates (template_id, use_case, template_body, body_sha256, inbound_message_id, queue_key, thread_ref, decision_id, draft_hash, validator_verdict, ledger_snapshot_hash, policy_version, policy_authorization, record_version)
    values ('tmpl-123', 'ai_consider_selling', v_body, v_sha, 'evt-6', 'ai_conversation:evt-6', 'tr:' || repeat('a', 64), 'd', v_sha, '{"status":"validated_draft"}', repeat('b', 64), 'v', '{"policy_hash":"x","category":"next_missing_fact","scope_match":"thread_keys"}', 'v1');
    raise exception 'assert: non ai-msg id must be refused';
  exception when check_violation then null;
  end;
  -- RLS forced, no policies
  select count(*) into v_n from pg_policies where tablename = 'ai_message_templates';
  if v_n <> 0 then raise exception 'assert: no RLS policies expected'; end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.ai_message_templates'::regclass) then raise exception 'assert: RLS forced'; end if;
  select count(*) into v_n from public.ai_message_templates;
  if v_n <> 1 then raise exception 'assert: exactly the one valid record, got %', v_n; end if;
  -- node's sha256Hex (apps/api ai-message-record.js) equals the DB CHECK for non-ASCII text
  if encode(sha256(convert_to('Got it — thanks. How’s the roof? 🙂', 'UTF8')), 'hex') <> '8831a9147aa4b92a7ccd6e6fa02832f3718dd736c4f2c299dc8536a329f8a55f' then
    raise exception 'assert: node/pg sha256 agree on utf-8';
  end if
;
  raise notice 'local-proof(ai_message_templates): ALL OK';
end
$$;
