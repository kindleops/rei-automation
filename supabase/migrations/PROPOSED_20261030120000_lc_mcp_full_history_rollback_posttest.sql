-- POSTTEST of the rollback of PROPOSED_20261030120000_lc_mcp_full_history.sql. DISPOSABLE DATABASE ONLY.
-- Read-only; ends in ROLLBACK. Proves both functions are back to their 1.1 definitions (bounds 1..365 and 1..1095,
-- window 0 refused) with the reader's EXECUTE intact.
begin;
do $$
declare fails text[] := '{}'; f text;
begin
  if position('window must be 1..365 days' in (select prosrc from pg_proc where oid = 'public.lc_mcp_conversation_worklist(text,integer,text,timestamptz,uuid,integer)'::regprocedure)) = 0 then fails := fails || 'worklist not restored'::text; end if;
  if position('window must be 1..1095 days' in (select prosrc from pg_proc where oid = 'public.lc_mcp_lead_conversation(text,uuid,integer,timestamptz,text,integer)'::regprocedure)) = 0 then fails := fails || 'conversation not restored'::text; end if;
  begin
    execute 'set local role lc_mcp_reader';
    perform public.lc_mcp_conversation_worklist('recent_inbound', 0, null, null, null, 5);
    execute 'reset role';
    fails := fails || 'worklist window 0 still accepted'::text;
  exception when sqlstate '22023' then execute 'reset role'; end;
  foreach f in array array['public.lc_mcp_conversation_worklist(text,integer,text,timestamptz,uuid,integer)', 'public.lc_mcp_lead_conversation(text,uuid,integer,timestamptz,text,integer)'] loop
    if not has_function_privilege('lc_mcp_reader', f, 'EXECUTE') then fails := fails || ('reader cannot execute ' || f); end if;
  end loop;
  if cardinality(fails) > 0 then raise exception 'ROLLBACK POSTTEST FAILED: %', array_to_string(fails, '; '); end if;
  raise notice 'ROLLBACK POSTTEST OK: the 1.1 bounds are back';
end $$;
rollback;
