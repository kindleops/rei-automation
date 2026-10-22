-- DISPOSABLE TEST FIXTURE (mcp/leadcommand-action-mcp/test/pg-net-exposure-e2e.test.mjs), never production.
-- A shape-only EMULATION of pg_graphql's resolver behind Supabase's /graphql/v1 route (the API gateway forwards it to
-- PostgREST POST /rpc/graphql with Content-Profile: graphql_public). Like pg_graphql it reflects ONLY the tables in
-- the schemas on the calling role's search_path that the role can SELECT; a top-level <table>Collection field (plain
-- or inflected name) of any other table answers pg_graphql's "Unknown field" error. It is NOT pg_graphql: it parses
-- just the first selected field, enough for the exposure probe's queries.
-- The lc roles may call it here (USAGE on graphql_public to PUBLIC): the probe then has a GraphQL answer to judge.
create or replace function graphql_public.graphql("operationName" text default null, query text default null, variables jsonb default null, extensions jsonb default null)
returns jsonb
language plpgsql
volatile
as $g$
declare
  f text;
  hit text;
begin
  f := substring(coalesce(query, '') from '^\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)');
  if f is null then
    return jsonb_build_object('data', null, 'errors', jsonb_build_array(jsonb_build_object('message', 'emulation: unsupported query')));
  end if;
  select format('%I.%I', n.nspname, c.relname) into hit
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = any (current_schemas(false)) and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and has_table_privilege(c.oid, 'SELECT')
     and f in (c.relname || 'Collection',
               lower(left(replace(initcap(replace(btrim(c.relname, '_'), '_', ' ')), ' ', ''), 1))
                 || substr(replace(initcap(replace(btrim(c.relname, '_'), '_', ' ')), ' ', ''), 2) || 'Collection')
   limit 1;
  if hit is not null then
    return jsonb_build_object('data', jsonb_build_object(f, jsonb_build_object('__typename', f || 'Connection')));
  end if;
  return jsonb_build_object('data', null, 'errors', jsonb_build_array(jsonb_build_object('message', format('Unknown field "%s" on type "Query"', f))));
end
$g$;
grant usage on schema graphql_public to public;
grant execute on function graphql_public.graphql(text, text, jsonb, jsonb) to public;
