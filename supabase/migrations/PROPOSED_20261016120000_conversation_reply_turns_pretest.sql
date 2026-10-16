-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261016120000_conversation_reply_turns.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- No transaction control, no includes: read-only prerequisite checks.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id conversation_reply_turns
-- Expected last notice: "pretest(conversation_reply_turns): prerequisites OK".
--
-- LEGACY TABLE: production already has an UNRELATED legacy public.conversation_turns (10 columns,
-- phase-3 2026-05; conversationMemoryService.js). This migration never creates, alters or drops
-- it — its objects are all named conversation_reply_turn*. The test databases model it
-- (scripts/db/fixtures/legacy_conversation_turns_baseline.sql); this pretest asserts it is
-- present with exactly its 10 columns (names, types, nullability) BEFORE the apply and, in the
-- runner's second cycle, AFTER the rollback. The posttest asserts the same AFTER the apply and
-- the rollback posttest AFTER the rollback.
\set ON_ERROR_STOP on

do $$
declare
  legacy_expected constant text :=
    'channel character varying NO,confidence_score double precision YES,content text YES,created_at timestamp with time zone YES,'
    'direction character varying NO,handled_by character varying NO,id uuid NO,intent_detected character varying YES,metadata jsonb YES,thread_id uuid NO';
  legacy_actual text;
begin
  if to_regclass('public.conversation_turns') is null then
    raise exception 'pretest(conversation_reply_turns): the legacy public.conversation_turns is missing (the disposable DB must model it: scripts/db/fixtures/legacy_conversation_turns_baseline.sql)';
  end if;
  select string_agg(format('%s %s %s', column_name, data_type, is_nullable), ',' order by column_name collate "C") into legacy_actual
    from information_schema.columns where table_schema = 'public' and table_name = 'conversation_turns';
  if legacy_actual is distinct from legacy_expected then
    raise exception 'pretest(conversation_reply_turns): the legacy public.conversation_turns column set changed: %', legacy_actual;
  end if;
  if to_regclass('public.conversation_reply_turns') is not null then
    raise exception 'pretest(conversation_reply_turns): public.conversation_reply_turns already exists — reconcile first';
  end if;
  if to_regprocedure('public.conversation_reply_turn_open(text,text,timestamptz,timestamptz,jsonb,text,text)') is not null
     or to_regprocedure('public.conversation_reply_turn_claim(uuid,integer,text,integer)') is not null
     or to_regprocedure('public.conversation_reply_turn_finalize(uuid,uuid,integer,text,jsonb,boolean,text)') is not null
     or to_regprocedure('public.conversation_reply_turn_cancel(text,text)') is not null
     or to_regprocedure('public.conversation_reply_turn_reopen(uuid,text,timestamptz,jsonb)') is not null
     or to_regprocedure('public.conversation_reply_turn_due(integer,integer)') is not null
     or to_regprocedure('agent.runtime_enqueue_event_at(text,text,jsonb,integer,timestamptz)') is not null then
    raise exception 'pretest(conversation_reply_turns): a turn function already exists';
  end if;
  if to_regclass('public.idempotency_ledger') is null then
    raise exception 'pretest(conversation_reply_turns): public.idempotency_ledger missing (durable run locks + idempotency ledger migration)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'idempotency_ledger' and column_name = 'metadata') then
    raise exception 'pretest(conversation_reply_turns): idempotency_ledger.metadata missing';
  end if;
  if to_regprocedure('agent.runtime_enqueue_core(text,text,jsonb,text,text,text,integer,integer,numeric,boolean,bigint,timestamptz,timestamptz)') is null then
    raise exception 'pretest(conversation_reply_turns): agent.runtime_enqueue_core missing (intel_runtime)';
  end if;
  if to_regclass('agent.runtime_limits') is null then
    raise exception 'pretest(conversation_reply_turns): agent.runtime_limits missing (intel_runtime)';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') or not exists (select 1 from pg_roles where rolname = 'agent_api') then
    raise exception 'pretest(conversation_reply_turns): role service_role / agent_api missing';
  end if;
  if not exists (select 1 from pg_proc where proname = 'hashtextextended') then
    raise exception 'pretest(conversation_reply_turns): hashtextextended() unavailable';
  end if;
  raise notice 'pretest(conversation_reply_turns): prerequisites OK';
end
$$;
