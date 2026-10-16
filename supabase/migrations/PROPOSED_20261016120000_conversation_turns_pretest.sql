-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261016120000_conversation_turns.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- No transaction control, no includes: read-only prerequisite checks.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id conversation_turns
-- Expected last notice: "pretest(conversation_turns): prerequisites OK".
\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public.conversation_turns') is not null then
    raise exception 'pretest(conversation_turns): public.conversation_turns already exists — reconcile first';
  end if;
  if to_regprocedure('public.conversation_turn_open(text,text,timestamptz,timestamptz,jsonb,text,text)') is not null
     or to_regprocedure('public.conversation_turn_finalize(uuid,uuid,integer,text,jsonb,boolean,text)') is not null
     or to_regprocedure('agent.runtime_enqueue_event_at(text,text,jsonb,integer,timestamptz)') is not null then
    raise exception 'pretest(conversation_turns): a turn function already exists';
  end if;
  if to_regclass('public.idempotency_ledger') is null then
    raise exception 'pretest(conversation_turns): public.idempotency_ledger missing (durable run locks + idempotency ledger migration)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'idempotency_ledger' and column_name = 'metadata') then
    raise exception 'pretest(conversation_turns): idempotency_ledger.metadata missing';
  end if;
  if to_regprocedure('agent.runtime_enqueue_core(text,text,jsonb,text,text,text,integer,integer,numeric,boolean,bigint,timestamptz,timestamptz)') is null then
    raise exception 'pretest(conversation_turns): agent.runtime_enqueue_core missing (intel_runtime)';
  end if;
  if to_regclass('agent.runtime_limits') is null then
    raise exception 'pretest(conversation_turns): agent.runtime_limits missing (intel_runtime)';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') or not exists (select 1 from pg_roles where rolname = 'agent_api') then
    raise exception 'pretest(conversation_turns): role service_role / agent_api missing';
  end if;
  if not exists (select 1 from pg_proc where proname = 'hashtextextended') then
    raise exception 'pretest(conversation_turns): hashtextextended() unavailable';
  end if;
  raise notice 'pretest(conversation_turns): prerequisites OK';
end
$$;
