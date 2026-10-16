-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261016120000_conversation_turns_rollback.sql.
-- DISPOSABLE DATABASE ONLY. Read-only: the rollback removed every object the migration created.
\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public.conversation_turns') is not null
     or to_regprocedure('public.conversation_turn_open(text,text,timestamptz,timestamptz,jsonb,text,text)') is not null
     or to_regprocedure('public.conversation_turn_claim(uuid,integer,text,integer)') is not null
     or to_regprocedure('public.conversation_turn_finalize(uuid,uuid,integer,text,jsonb,boolean,text)') is not null
     or to_regprocedure('public.conversation_turn_cancel(text,text)') is not null
     or to_regprocedure('public.conversation_turn_reopen(uuid,text,timestamptz,jsonb)') is not null
     or to_regprocedure('public.conversation_turn_due(integer,integer)') is not null
     or to_regprocedure('agent.runtime_enqueue_event_at(text,text,jsonb,integer,timestamptz)') is not null then
    raise exception 'rollback posttest(conversation_turns): an object survived the rollback';
  end if;
  if to_regprocedure('agent.runtime_enqueue_event(text,text,jsonb,integer)') is null then
    raise exception 'rollback posttest(conversation_turns): the rollback removed agent.runtime_enqueue_event (not ours)';
  end if;
  raise notice 'rollback posttest(conversation_turns): clean';
end
$$;
