-- POSTTEST for PROPOSED_20261027120000_action_gateway_ohg.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It runs in one transaction and ends in ROLLBACK. The runner proves the schema is unchanged afterwards.
--   A. the self-check (#27's registry-reading body) is ok; this link's 11 registry rows exist; the four actions are
--      standing T2 actions; the receipts CHECK accepts the two handed-off actions and the restore row holds #28's
--      original definition;
--   B. lc_action_gateway executes exactly the three new definer functions and reaches NEITHER the annotation ledger
--      nor the restore table; anon / authenticated execute nothing;
--   C. the ledger is append-only (update and delete refused by the database) and masked (a phone in a note is
--      refused by agent.payload_is_clean on the payload);
--   D. the domain write refuses an unknown intent / lease through dw_begin (the gateway's typed refusal); the two reads answer an
--      empty list for an unknown thread.
begin;

do $$
declare v jsonb; d text;
begin
  v := action_gateway.self_check('lc_action_gateway');
  if not coalesce((v ->> 'ok')::boolean, false) then raise exception 'A: composed self-check not ok: %', v -> 'findings'; end if;
  if (select count(*) from action_gateway.extensions where link = 'PROPOSED_20261027120000_action_gateway_ohg') <> 11 then raise exception 'A: this link''s extension rows'; end if;
  if not (action_gateway.standing_t2_actions() @> array['set_lead_temperature', 'update_lead_status', 'record_conversation_note', 'record_seller_statement']) then raise exception 'A: the four actions are not standing T2 actions'; end if;
  if (select count(*) from action_gateway.extensions where link = 'PROPOSED_20261027120000_action_gateway_ohg' and kind = 'standing_t2_action' and basis is null) <> 0 then raise exception 'A: a standing action without a basis'; end if;
  select pg_get_constraintdef(oid) into d from pg_constraint where conrelid = 'action_gateway.seller_action_receipts'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''queue_authorized_reply''%';
  if d !~ 'set_lead_temperature' or d !~ 'update_lead_status' or d !~ 'queue_authorized_reply' then raise exception 'A: the receipts action CHECK was not widened: %', d; end if;
  if (select count(*) from action_gateway.ohg_restore) <> 2 or (select value from action_gateway.ohg_restore where key = 'receipts_action_check_def') ~ 'set_lead_temperature' then raise exception 'A: the restore rows'; end if;
end $$;

-- B
do $$
declare f text;
begin
  foreach f in array array['public.action_gateway_dw_ohg(uuid,uuid)', 'public.action_gateway_reply_status(uuid,integer)', 'public.action_gateway_annotations(uuid,integer)'] loop
    if not has_function_privilege('lc_action_gateway', f, 'EXECUTE') then raise exception 'B: the role cannot execute %', f; end if;
    if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE') then raise exception 'B: anon / authenticated can execute %', f; end if;
  end loop;
  foreach f in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if has_table_privilege('lc_action_gateway', 'action_gateway.lead_annotations', f) then raise exception 'B: the role reaches lead_annotations (%)', f; end if;
    if has_table_privilege('lc_action_gateway', 'action_gateway.ohg_restore', f) then raise exception 'B: the role reaches ohg_restore (%)', f; end if;
    if has_table_privilege('anon', 'action_gateway.lead_annotations', f) or has_table_privilege('authenticated', 'action_gateway.lead_annotations', f) then raise exception 'B: anon / authenticated reach lead_annotations'; end if;
  end loop;
  if has_function_privilege('lc_action_gateway', 'public.lc_seller_action_load(uuid)', 'EXECUTE') then raise exception 'B: the role can execute the worker load'; end if;
end $$;

-- C: append-only + masked
do $$
declare
  org uuid := '00000000-0000-4000-8000-00000000ee29'; owner_u uuid := '1a2ee0ff-0000-4000-8000-0000000000e1'; op_u uuid := '1a2ee0ff-0000-4000-8000-0000000000e2';
  i uuid; i2 uuid; a uuid; th uuid := gen_random_uuid();
begin
  insert into agent.org (org_id, name) values (org, 'posttest ohg');
  insert into agent.operator_membership (org_id, user_id, role, added_by) values (org, owner_u, 'owner', 'posttest'), (org, op_u, 'operator', 'posttest');
  insert into action_gateway.agent_principals (agent_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, created_by)
  values ('agt_posttest_ohg', org, 'posttest', op_u, repeat('e2', 32), now() + interval '10 days', 2, owner_u);
  insert into action_gateway.action_intents (org_id, agent_id, action, capability, tier, resource_type, resource_id, client_key, idempotency_key, params, params_hash, correlation_id, recovery)
  values (org, 'agt_posttest_ohg', 'record_conversation_note', 'acquisitions.record_conversation_note', 2, 'thread', th::text, 'posttest-ohg-1', repeat('a', 64), '{}', repeat('0', 64), gen_random_uuid(), 'reexecute')
  returning intent_id into i;
  insert into action_gateway.action_intents (org_id, agent_id, action, capability, tier, resource_type, resource_id, client_key, idempotency_key, params, params_hash, correlation_id, recovery)
  values (org, 'agt_posttest_ohg', 'record_conversation_note', 'acquisitions.record_conversation_note', 2, 'thread', th::text, 'posttest-ohg-2', repeat('b', 64), '{}', repeat('1', 64), gen_random_uuid(), 'reexecute')
  returning intent_id into i2;
  insert into action_gateway.lead_annotations (org_id, intent_id, agent_id, thread_id, thread_key, property_id, kind, class, note, payload)
  values (org, i, 'agt_posttest_ohg', th, '+15555550129', '990001029', 'objection', 'note', 'Seller says the roof was replaced in 2019 and will not go below asking', '{"kind": "objection"}')
  returning annotation_id into a;
  begin
    update action_gateway.lead_annotations set note = 'edited' where annotation_id = a;
    raise exception 'C: an annotation was updated';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    delete from action_gateway.lead_annotations where annotation_id = a;
    raise exception 'C: an annotation was deleted';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    insert into action_gateway.lead_annotations (org_id, intent_id, agent_id, thread_id, thread_key, kind, class, note, payload)
    values (org, i2, 'agt_posttest_ohg', th, '+15555550129', 'context', 'note', 'call me', '{"kind": "context", "phone": "312-555-0161"}');
    raise exception 'C: a payload carrying a phone number was stored';
  exception when check_violation then null;
  end;
  begin
    insert into action_gateway.lead_annotations (org_id, intent_id, agent_id, thread_id, thread_key, kind, class, note, payload)
    values (org, i2, 'agt_posttest_ohg', th, '+15555550129', 'not_a_kind', 'note', 'x', '{}');
    raise exception 'C: an unknown kind was stored';
  exception when check_violation then null;
  end;
  if (select count(*) from action_gateway.lead_annotations where thread_id = th) <> 1 then raise exception 'C: ledger count'; end if;
  -- D
  begin
    perform public.action_gateway_dw_ohg(gen_random_uuid(), gen_random_uuid());
    raise exception 'D: the domain write accepted an unknown intent';
  exception when raise_exception then if sqlerrm not like 'ACTION_GATEWAY_INTENT_NOT_FOUND%' then raise; end if;
  end;
  if public.action_gateway_reply_status(gen_random_uuid(), 10) <> '[]'::jsonb then raise exception 'D: reply status of an unknown thread'; end if;
  if public.action_gateway_annotations(gen_random_uuid(), 10) <> '[]'::jsonb then raise exception 'D: annotations of an unknown thread'; end if;
  if jsonb_array_length(public.action_gateway_annotations(th, 10)) <> 1 or (public.action_gateway_annotations(th, 10) -> 0) ? 'payload' then raise exception 'D: annotations read'; end if;
  raise notice 'posttest ohg: A-D ok';
end $$;

rollback;
