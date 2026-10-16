-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261016120000_conversation_reply_turns_rollback.sql.
-- DISPOSABLE DATABASE ONLY. Read-only: the rollback removed every object the migration created,
-- and the unrelated legacy public.conversation_turns (scripts/db/fixtures/legacy_conversation_turns_baseline.sql) is intact.
\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public.conversation_reply_turns') is not null
     or to_regprocedure('public.conversation_reply_turn_open(text,text,timestamptz,timestamptz,jsonb,text,text)') is not null
     or to_regprocedure('public.conversation_reply_turn_claim(uuid,integer,text,integer)') is not null
     or to_regprocedure('public.conversation_reply_turn_finalize(uuid,uuid,integer,text,jsonb,boolean,text)') is not null
     or to_regprocedure('public.conversation_reply_turn_cancel(text,text)') is not null
     or to_regprocedure('public.conversation_reply_turn_reopen(uuid,text,timestamptz,jsonb)') is not null
     or to_regprocedure('public.conversation_reply_turn_due(integer,integer)') is not null
     or to_regprocedure('agent.runtime_enqueue_event_at(text,text,jsonb,integer,timestamptz)') is not null then
    raise exception 'rollback posttest(conversation_reply_turns): an object survived the rollback';
  end if;
  if to_regprocedure('agent.runtime_enqueue_event(text,text,jsonb,integer)') is null then
    raise exception 'rollback posttest(conversation_reply_turns): the rollback removed agent.runtime_enqueue_event (not ours)';
  end if;
  -- the unrelated LEGACY public.conversation_turns survives the rollback untouched
  if to_regclass('public.conversation_turns') is null then
    raise exception 'rollback posttest(conversation_reply_turns): the rollback removed the LEGACY public.conversation_turns (not ours)';
  end if;
  if (select string_agg(format('%s %s %s', column_name, data_type, is_nullable), ',' order by column_name collate "C")
        from information_schema.columns where table_schema = 'public' and table_name = 'conversation_turns')
     is distinct from 'channel character varying NO,confidence_score double precision YES,content text YES,created_at timestamp with time zone YES,'
                      'direction character varying NO,handled_by character varying NO,id uuid NO,intent_detected character varying YES,metadata jsonb YES,thread_id uuid NO' then
    raise exception 'rollback posttest(conversation_reply_turns): the legacy public.conversation_turns column set changed';
  end if;
  if (select count(*) from public.conversation_turns where id in ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a3')) <> 3
     or (select count(*) from pg_policies where schemaname = 'public' and tablename = 'conversation_turns') <> 2
     or (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'conversation_turns' and indexname in ('idx_conv_turns_thread_id', 'idx_conv_turns_created_at')) <> 2 then
    raise exception 'rollback posttest(conversation_reply_turns): the legacy public.conversation_turns rows / policies / indexes changed';
  end if;
  raise notice 'rollback posttest(conversation_reply_turns): clean';
end
$$;
