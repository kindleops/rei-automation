-- LOCAL DISPOSABLE DB ONLY. After the rollback: nothing remains.
do $$
begin
  if to_regclass('public.ai_message_templates') is not null then raise exception 'assert: table dropped'; end if;
  if exists (select 1 from pg_proc where proname = 'ai_message_templates_immutable') then raise exception 'assert: function dropped'; end if;
  raise notice 'local-proof(ai_message_templates rollback): ALL OK';
end
$$;
