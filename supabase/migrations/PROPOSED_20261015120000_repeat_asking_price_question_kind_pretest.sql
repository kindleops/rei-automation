-- PRETEST for PROPOSED_20261015120000_repeat_asking_price_question_kind.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Read-only prerequisite checks: the live trigger + function the migration replaces exist,
-- and the tables / columns its new body reads are present.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id repeat_asking_price_question_kind
\set ON_ERROR_STOP on
do $$
begin
  if to_regprocedure('public.block_repeat_asking_price()') is null then
    raise exception 'pretest(repeat_asking_price): public.block_repeat_asking_price() missing — the migration replaces the live body';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_block_repeat_asking_price' and tgrelid = 'public.send_queue'::regclass and not tgisinternal) then
    raise exception 'pretest(repeat_asking_price): trigger trg_block_repeat_asking_price on public.send_queue missing';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'send_queue'
       and column_name in ('thread_key','queue_status','use_case_template','metadata','paused_reason','sent_at','delivered_at','updated_at','created_at')) <> 9 then
    raise exception 'pretest(repeat_asking_price): send_queue lacks a column the guard reads';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'message_events'
       and column_name in ('thread_key','direction','event_timestamp','received_at','created_at')) <> 5 then
    raise exception 'pretest(repeat_asking_price): message_events lacks a column the S3 follow-up rule reads';
  end if;
  raise notice 'pretest(repeat_asking_price): prerequisites OK';
end $$;
