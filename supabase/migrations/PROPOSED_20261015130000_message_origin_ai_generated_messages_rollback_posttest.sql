-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST: nothing of the migration remains and send_queue inserts
-- behave as before. No transaction control, no includes. DISPOSABLE DATABASE ONLY.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'send_queue' and column_name = 'message_origin') then raise exception 'assert: column dropped'; end if;
  if to_regclass('public.ai_generated_messages') is not null or to_regclass('public.ai_generated_message_events') is not null then raise exception 'assert: tables dropped'; end if;
  if exists (select 1 from pg_trigger where tgname = 'guard_send_queue_message_origin') then raise exception 'assert: trigger dropped'; end if;
  if exists (select 1 from pg_proc where proname in ('guard_send_queue_message_origin', 'ai_generated_messages_immutable')) then raise exception 'assert: functions dropped'; end if;
  raise notice 'rollback posttest(message_origin_ai_generated_messages): ALL OK';
end
$$;
