-- POSTTEST for PROPOSED_20261030120000_lc_mcp_full_history.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production. One transaction, ends in ROLLBACK.
-- Seeds: mcp/leadcommand-mcp/migrations/test/lc_mcp_conversation_intel_emulation.sql (synthetic; P5's only messages are
-- older than 365 days). Every call runs AS lc_mcp_reader. It proves:
--   A. the worklist reads every thread on record with window 0, keyset-paged (pages of 1 cover the total exactly once),
--      and its total is at least the 365-day total; windows 1..36500 still work; -1 and 36501 are refused (22023);
--   B. the conversation reads P5 (outside a 365-day window) with window 0; 365 still says outside_window; -1 refused;
--   C. privileges unchanged: lc_mcp_reader can EXECUTE both, PUBLIC cannot; both STABLE SECURITY DEFINER,
--      search_path = pg_catalog.
begin;
do $$
declare
  fails text[] := '{}'; c jsonb; c2 jsonb; t_all int; t_365 int; seen int := 0; pages int := 0; cur_at timestamptz; cur_id uuid; f text;
begin
  -- A
  execute 'set local role lc_mcp_reader';
  c := public.lc_mcp_conversation_worklist('recent_inbound', 0, null, null, null, 25);
  c2 := public.lc_mcp_conversation_worklist('recent_inbound', 365, null, null, null, 25);
  execute 'reset role';
  t_all := (c->>'total')::int; t_365 := (c2->>'total')::int;
  if t_all is null or t_all < t_365 or (c->>'window_days')::int <> 0 then fails := fails || format('A: all=%s 365=%s', t_all, t_365); end if;
  loop
    pages := pages + 1;
    execute 'set local role lc_mcp_reader';
    c2 := public.lc_mcp_conversation_worklist('recent_inbound', 0, null, cur_at, cur_id, 1);
    execute 'reset role';
    seen := seen + jsonb_array_length(c2->'rows');
    exit when not (c2->>'has_more')::boolean or pages > 100;
    cur_at := (c2->'rows'->-1->'cursor'->>'at')::timestamptz; cur_id := (c2->'rows'->-1->'cursor'->>'id')::uuid;
  end loop;
  if seen <> t_all then fails := fails || format('A: paged %s of %s', seen, t_all); end if;
  foreach f in array array['1', '36500'] loop
    begin
      execute 'set local role lc_mcp_reader';
      perform public.lc_mcp_conversation_worklist('recent_inbound', f::int, null, null, null, 5);
      execute 'reset role';
    exception when others then execute 'reset role'; fails := fails || format('A: window %s refused: %s', f, sqlerrm); end;
  end loop;
  foreach f in array array['-1', '36501'] loop
    begin
      execute 'set local role lc_mcp_reader';
      perform public.lc_mcp_conversation_worklist('recent_inbound', f::int, null, null, null, 5);
      execute 'reset role';
      fails := fails || format('A: window %s accepted', f);
    exception when sqlstate '22023' then execute 'reset role'; end;
  end loop;
  -- B
  execute 'set local role lc_mcp_reader';
  c := public.lc_mcp_lead_conversation('P5', null, 0, null, null, 10);
  c2 := public.lc_mcp_lead_conversation('P5', null, 365, null, null, 10);
  execute 'reset role';
  if c#>>'{history,state}' in ('outside_window', 'missing', 'no_thread') or jsonb_array_length(coalesce(c->'messages', '[]')) = 0 then fails := fails || ('B: P5 all history ' || coalesce(c#>>'{history,state}', 'null')); end if;
  if c2#>>'{history,state}' is distinct from 'outside_window' then fails := fails || ('B: P5 at 365 ' || coalesce(c2#>>'{history,state}', 'null')); end if;
  begin
    execute 'set local role lc_mcp_reader';
    perform public.lc_mcp_lead_conversation('P5', null, -1, null, null, 10);
    execute 'reset role';
    fails := fails || 'B: window -1 accepted'::text;
  exception when sqlstate '22023' then execute 'reset role'; end;
  -- C
  foreach f in array array['public.lc_mcp_conversation_worklist(text,integer,text,timestamptz,uuid,integer)', 'public.lc_mcp_lead_conversation(text,uuid,integer,timestamptz,text,integer)'] loop
    if not has_function_privilege('lc_mcp_reader', f, 'EXECUTE') then fails := fails || ('C: reader cannot execute ' || f); end if;
    if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = f::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') then fails := fails || ('C: PUBLIC can execute ' || f); end if;
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef and p.provolatile = 's' and p.proconfig @> array['search_path=pg_catalog']) then fails := fails || ('C: definer / stable / search_path ' || f); end if;
  end loop;
  if cardinality(fails) > 0 then raise exception 'POSTTEST FAILED: %', array_to_string(fails, ' | '); end if;
  raise notice 'POSTTEST OK: full-history worklist (% threads, % pages of 1) and conversation; bounds; privileges', t_all, pages;
end $$;
rollback;
