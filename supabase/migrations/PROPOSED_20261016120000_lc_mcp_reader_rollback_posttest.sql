-- POSTTEST of the rollback of PROPOSED_20261016120000_lc_mcp_reader.sql. DISPOSABLE
-- DATABASE ONLY: run by scripts/db/run-migration-test.mjs, never against production.
-- It is read-only and ends in ROLLBACK. Together with the runner's fingerprint
-- comparison, it proves the rollback removed exactly the migration's objects and left
-- every other role, grant and policy alone.
begin;
do $$
declare problems text[] := '{}';
begin
  if exists (select 1 from pg_roles where rolname = 'lc_mcp_reader') then problems := problems || 'role lc_mcp_reader still exists'::text; end if;
  if exists (select 1 from pg_policy where polname = 'lc_mcp_reader_select') then problems := problems || 'a lc_mcp_reader_select policy remains'::text; end if;
  if to_regprocedure('public.lc_mcp_reader_self_check(text[],text[],name)') is not null then problems := problems || 'lc_mcp_reader_self_check remains'::text; end if;
  if to_regprocedure('public.lc_mcp_operator_role(uuid,uuid)') is not null then problems := problems || 'lc_mcp_operator_role remains'::text; end if;
  -- untouched neighbours
  if not pg_has_role('authenticator', 'authenticated', 'SET') or not pg_has_role('authenticator', 'service_role', 'SET') then problems := problems || 'authenticator lost an existing membership'::text; end if;
  if not exists (select 1 from pg_policy where polname = 'operator_read' and polrelid = 'public.properties'::regclass) then problems := problems || 'an unrelated policy was dropped'::text; end if;
  if not has_function_privilege('service_role', 'public.entity_graph_property_records(text)', 'EXECUTE') then problems := problems || 'service_role lost EXECUTE on entity_graph_property_records'::text; end if;
  if not has_table_privilege('service_role', 'public.properties', 'SELECT') then problems := problems || 'service_role lost SELECT on properties'::text; end if;
  if array_length(problems, 1) > 0 then raise exception 'rollback posttest: %', array_to_string(problems, '; '); end if;
  raise notice 'rollback posttest: only the migration''s objects are gone';
end $$;
rollback;
