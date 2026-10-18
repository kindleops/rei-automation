-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY: never run against production.
-- No transaction control, no includes: read-only prerequisite checks.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id conversation_reply_turn_dispatch_lease
-- Expected last notice: "pretest(conversation_reply_turn_dispatch_lease): prerequisites OK".
\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public.conversation_reply_turns') is null
     or to_regprocedure('public.conversation_reply_turn_finalize(uuid,uuid,integer,text,jsonb,boolean,text)') is null then
    raise exception 'pretest(conversation_reply_turn_dispatch_lease): PROPOSED_20261016120000_conversation_reply_turns is not applied';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'conversation_reply_turns' and column_name like 'dispatch%') then
    raise exception 'pretest(conversation_reply_turn_dispatch_lease): dispatch columns already exist';
  end if;
  if position('dispatch_lease_until' in pg_get_functiondef('public.conversation_reply_turn_finalize(uuid,uuid,integer,text,jsonb,boolean,text)'::regprocedure)) > 0 then
    raise exception 'pretest(conversation_reply_turn_dispatch_lease): finalize already carries the dispatch lease';
  end if;
  if to_regprocedure('agent.runtime_finish(text,uuid,text,jsonb,jsonb)') is null then
    raise exception 'pretest(conversation_reply_turn_dispatch_lease): agent.runtime_finish (intel_runtime) missing';
  end if;
  if to_regprocedure('agent.runtime_finish(text,uuid,text,jsonb,jsonb,integer)') is not null
     or to_regprocedure('public.conversation_reply_turn_dispatch_claim(uuid,integer,text,integer,integer)') is not null
     or to_regprocedure('public.conversation_reply_turn_dispatch_done(uuid,integer,text,text)') is not null
     or to_regclass('public.send_queue_ai_turn_uq') is not null then
    raise exception 'pretest(conversation_reply_turn_dispatch_lease): an object of this migration already exists';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'send_queue' and column_name = 'metadata') then
    raise exception 'pretest(conversation_reply_turn_dispatch_lease): public.send_queue.metadata missing';
  end if;
  raise notice 'pretest(conversation_reply_turn_dispatch_lease): prerequisites OK';
end $$;
