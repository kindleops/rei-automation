-- PROPOSED ONLY — PRETEST for PROPOSED_20261013160000_conversation_ai_shadow.sql. Changes NOTHING.
--   psql "$DB" -v ON_ERROR_STOP=1 -f supabase/migrations/PROPOSED_20261013160000_conversation_ai_shadow_pretest.sql
-- BEGIN → apply → assert schema + constraints + RLS + rollback file → ROLLBACK.
-- Expected last notice: "pretest(conversation_ai_shadow): ALL OK (rolled back)".
\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public.conversation_ai_shadow_decisions') is not null or to_regclass('public.conversation_ai_reply_policy') is not null then
    raise exception 'pretest(conversation_ai_shadow): tables already exist — reconcile first';
  end if;
  if not exists (select 1 from pg_proc where proname = 'gen_random_uuid') then
    raise exception 'pretest(conversation_ai_shadow): gen_random_uuid() unavailable';
  end if;
  raise notice 'pretest(conversation_ai_shadow): prerequisites OK';
end
$$;

begin;
\ir PROPOSED_20261013160000_conversation_ai_shadow.sql

do $$
declare ok boolean;
begin
  -- policy seeded OFF
  if not exists (select 1 from public.conversation_ai_reply_policy where id = 1 and enabled = false and shadow_enabled = false and kill_switch_engaged = true) then
    raise exception 'assert: policy row seeded off';
  end if;
  -- enabled=true is refused in R1/R2
  begin
    update public.conversation_ai_reply_policy set enabled = true where id = 1;
    raise exception 'assert: enabled=true must be refused';
  exception when check_violation then null;
  end;
  -- a second policy row is refused
  begin
    insert into public.conversation_ai_reply_policy (id) values (2);
    raise exception 'assert: second policy row must be refused';
  exception when check_violation then null;
  end;
  -- a valid shadow row inserts
  insert into public.conversation_ai_shadow_decisions (idempotency_key, inbound_message_id, thread_ref, contract_version, outcome, intent, path, validation_status, seller_message_masked, draft_text, record)
  values ('conv-ai:v1:pretest-1', 'pretest-1', 'thr_ghijklmnopab', 'conv-ai.decision.v1', 'REPLY_CANDIDATE', 'asks_offer', 'haiku', 'validated_draft', 'whats your offer •••-••47', 'How is the condition overall?', '{}'::jsonb);
  -- idempotency: the same inbound id is refused
  begin
    insert into public.conversation_ai_shadow_decisions (idempotency_key, inbound_message_id, contract_version, outcome, intent, path, validation_status, record)
    values ('conv-ai:v1:pretest-1', 'pretest-1', 'v', 'NO_RESPONSE', 'unclear', 'haiku', 'not_applicable', '{}'::jsonb);
    raise exception 'assert: duplicate inbound must be refused';
  exception when unique_violation then null;
  end;
  -- send_status can only be not_sent_shadow
  begin
    insert into public.conversation_ai_shadow_decisions (idempotency_key, inbound_message_id, contract_version, outcome, intent, path, validation_status, record, send_status)
    values ('conv-ai:v1:pretest-2', 'pretest-2', 'v', 'NO_RESPONSE', 'unclear', 'haiku', 'not_applicable', '{}'::jsonb, 'sent');
    raise exception 'assert: send_status other than not_sent_shadow must be refused';
  exception when check_violation then null;
  end;
  -- an unmasked phone is refused
  begin
    insert into public.conversation_ai_shadow_decisions (idempotency_key, inbound_message_id, contract_version, outcome, intent, path, validation_status, record, seller_message_masked)
    values ('conv-ai:v1:pretest-3', 'pretest-3', 'v', 'NO_RESPONSE', 'unclear', 'haiku', 'not_applicable', '{}'::jsonb, 'call me 612-555-0147');
    raise exception 'assert: phone-shaped text must be refused';
  exception when check_violation then null;
  end;
  -- key must match the inbound id
  begin
    insert into public.conversation_ai_shadow_decisions (idempotency_key, inbound_message_id, contract_version, outcome, intent, path, validation_status, record)
    values ('conv-ai:v1:other', 'pretest-4', 'v', 'NO_RESPONSE', 'unclear', 'haiku', 'not_applicable', '{}'::jsonb);
    raise exception 'assert: mismatched idempotency key must be refused';
  exception when check_violation then null;
  end;
  -- RLS on + forced, no policies
  select bool_and(relrowsecurity and relforcerowsecurity) into ok from pg_class where oid in ('public.conversation_ai_shadow_decisions'::regclass, 'public.conversation_ai_reply_policy'::regclass);
  if not ok then raise exception 'assert: RLS enabled + forced'; end if;
  if exists (select 1 from pg_policies where tablename in ('conversation_ai_shadow_decisions','conversation_ai_reply_policy')) then
    raise exception 'assert: no RLS policies (service role only)';
  end if;
  if has_table_privilege('anon', 'public.conversation_ai_shadow_decisions', 'select') or has_table_privilege('authenticated', 'public.conversation_ai_shadow_decisions', 'select') then
    raise exception 'assert: anon/authenticated have no select';
  end if;
  -- nothing references these tables and they reference nothing (no send path by FK)
  if exists (select 1 from pg_constraint where contype = 'f' and (conrelid in ('public.conversation_ai_shadow_decisions'::regclass, 'public.conversation_ai_reply_policy'::regclass) or confrelid in ('public.conversation_ai_shadow_decisions'::regclass, 'public.conversation_ai_reply_policy'::regclass))) then
    raise exception 'assert: no foreign keys in or out';
  end if;
  raise notice 'pretest(conversation_ai_shadow): apply assertions OK';
end
$$;

-- the rollback file drops exactly what was created
\ir PROPOSED_20261013160000_conversation_ai_shadow_rollback.sql
do $$
begin
  if to_regclass('public.conversation_ai_shadow_decisions') is not null or to_regclass('public.conversation_ai_reply_policy') is not null then
    raise exception 'assert: rollback removed both tables';
  end if;
  raise notice 'pretest(conversation_ai_shadow): ALL OK (rolled back)';
end
$$;
rollback;
