-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261017120000_conversation_reply_turn_dispatch_lease_rollback.sql.
-- DISPOSABLE DATABASE ONLY. Read-only: every object of the migration is gone, finalize is the
-- rc-8.5.20 body again and the 5-arg agent.runtime_finish is intact.
\set ON_ERROR_STOP on

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'conversation_reply_turns' and column_name like 'dispatch%')
     or to_regprocedure('agent.runtime_finish(text,uuid,text,jsonb,jsonb,integer)') is not null
     or to_regprocedure('public.conversation_reply_turn_dispatch_claim(uuid,integer,text,integer,integer)') is not null
     or to_regprocedure('public.conversation_reply_turn_dispatch_done(uuid,integer,text,text)') is not null
     or to_regclass('public.send_queue_ai_turn_uq') is not null then
    raise exception 'rollback posttest(conversation_reply_turn_dispatch_lease): an object survived the rollback';
  end if;
  if to_regprocedure('agent.runtime_finish(text,uuid,text,jsonb,jsonb)') is null then
    raise exception 'rollback posttest(conversation_reply_turn_dispatch_lease): the rollback removed the 5-arg agent.runtime_finish (not ours)';
  end if;
  if position('dispatch' in pg_get_functiondef('public.conversation_reply_turn_finalize(uuid,uuid,integer,text,jsonb,boolean,text)'::regprocedure)) > 0 then
    raise exception 'rollback posttest(conversation_reply_turn_dispatch_lease): finalize still carries the dispatch lease';
  end if;
  if not has_function_privilege('service_role', 'public.conversation_reply_turn_finalize(uuid,uuid,integer,text,jsonb,boolean,text)', 'execute')
     or has_function_privilege('anon', 'public.conversation_reply_turn_finalize(uuid,uuid,integer,text,jsonb,boolean,text)', 'execute') then
    raise exception 'rollback posttest(conversation_reply_turn_dispatch_lease): finalize grants not restored';
  end if;
  raise notice 'rollback posttest(conversation_reply_turn_dispatch_lease): all assertions OK';
end $$;
