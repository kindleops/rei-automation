-- Disposable-Postgres shim for agent persistence tests: the minimum of the
-- Supabase platform the migration relies on. NEVER run against Supabase itself
-- — these objects already exist there.
--   roles: anon, authenticated, service_role (BYPASSRLS), authenticator (login, for PostgREST)
--   auth.uid() from request.jwt.claim.sub / request.jwt.claims (PostgREST sets these)
--   Supabase-like DEFAULT PRIVILEGES, made deliberately WORSE than production:
--   global (all-schema) grants of tables/sequences/functions to anon + authenticated,
--   so the tests prove the migration's explicit revokes win.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges grant all on tables to anon, authenticated, service_role;
alter default privileges grant all on sequences to anon, authenticated, service_role;
alter default privileges grant execute on functions to anon, authenticated, service_role;
create schema if not exists graphql_public;  -- exposed by default on Supabase
grant usage on schema graphql_public to anon, authenticated, service_role;
