-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261015130000_message_origin_ai_generated_messages.sql.
-- Read-only prerequisite checks; changes nothing. No transaction control, no includes.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id message_origin_ai_generated_messages
do $$
begin
  if to_regclass('public.send_queue') is null then raise exception 'pretest: public.send_queue missing'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'send_queue' and column_name = 'message_origin') then
    raise exception 'pretest: send_queue.message_origin already exists — reconcile first';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'send_queue' and column_name = 'selected_template_id')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'send_queue' and column_name = 'template_key') then
    raise exception 'pretest: send_queue template columns missing';
  end if;
  if to_regclass('public.ai_generated_messages') is not null or to_regclass('public.ai_generated_message_events') is not null then
    raise exception 'pretest: AI message tables already exist — reconcile first';
  end if;
  if not exists (select 1 from pg_proc where proname = 'sha256') then raise exception 'pretest: sha256() unavailable'; end if;
  raise notice 'pretest(message_origin_ai_generated_messages): prerequisites OK';
end
$$;
