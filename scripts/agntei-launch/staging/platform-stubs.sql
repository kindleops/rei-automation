-- Stand-ins for the Supabase platform pieces a production SCHEMA-ONLY dump refers to but a vanilla PostgreSQL 17 lacks,
-- shaped the way the gateway migration's self-check pins them (PROPOSED_20261019160000_action_gateway.sql: PostGIS in
-- public owned by supabase_admin at 3.3.7; pg_net as an extension owned by supabase_admin with the platform's grants).
-- Used only by scripts/agntei-launch/staging-rehearsal.mjs on a loopback staging server. No data, no secrets.
-- Roles anon / authenticated / service_role / authenticator and schema auth come from apps/api/tests/pg/supabase-shim.sql.
-- The pg_net stand-in extension files come from scripts/agntei-launch/staging/pg_net-stand-in (installed by the tool).

-- The test shim grants default privileges in EVERY schema ("deliberately worse than production"); the platform grants them
-- in public only (ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public ... TO anon, authenticated, service_role).
-- Staging uses the platform's scope, so a logical restore (the rollback step) re-creates the same ACLs the chain left.
alter default privileges revoke all on tables from anon, authenticated, service_role;
alter default privileges revoke all on sequences from anon, authenticated, service_role;
alter default privileges revoke execute on functions from anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- the platform roles the pins name (NOLOGIN: nothing can connect as them; the rehearsal guard checks that)
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then create role supabase_admin nologin superuser; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_functions_admin') then create role supabase_functions_admin nologin; end if;
end $$;

-- Supabase installs these extensions in schema "extensions" (list_extensions on production, 2026-11-05):
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists pg_stat_statements with schema extensions;
-- the platform grants USAGE on extensions to its API roles, never to PUBLIC (a role outside that set cannot reach pg_stat_statements)
grant usage on schema extensions to postgres, anon, authenticated, service_role;

-- PostGIS in public, owned by supabase_admin (as on production). Postgres.app ships 3.5.x; production pins 3.3.7 in the
-- allowlist supabase_postgis_dynamic_sql.v1, so the catalog version label is set to 3.3.7 here. This is a STAGING
-- DEVIATION recorded in the rehearsal evidence: the function inventory and grants are real, the version label is not.
set role supabase_admin;
create extension if not exists postgis with schema public;
reset role;
update pg_extension set extversion = '3.3.7' where extname = 'postgis' and extversion <> '3.3.7';
-- PostGIS 3.5 adds postgis_extensions_upgrade(text), which 3.3.7 (production) does not have: a role must not reach it
do $$ begin
  if to_regprocedure('public.postgis_extensions_upgrade(text)') is not null then revoke execute on function public.postgis_extensions_upgrade(text) from public; end if;
end $$;

-- pg_net as a real extension owned by supabase_admin (the stand-in records calls and sends nothing)
set role supabase_admin;
create extension if not exists pg_net;
reset role;

-- auth.users and auth.role(): production's public schema carries 13 foreign keys to auth.users(id) (billing, profiles,
-- organizations, operators, ...) and two policies call auth.role(); the test shim has auth.uid() only. No rows.
create table if not exists auth.users (id uuid primary key, email text, created_at timestamptz not null default now());
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
$$;
grant execute on function auth.role() to anon, authenticated, service_role;

-- supabase_functions (Supabase Database Webhooks): production's message_events carries the trigger
-- message_events_to_podio_sync AFTER INSERT -> supabase_functions.http_request(<vercel url>, 'POST', ...). The gateway
-- migration's egress self-check classifies that function as an egress leaf (its name) and reports any role that can
-- write a table it fires on; staging must carry it so the production-schema run judges the same facts. The stand-in has
-- the platform's shape (owner supabase_functions_admin, SECURITY DEFINER, enqueues through net.http_post, records the
-- hook) and, with the pg_net stand-in, every request stays in net.http_request_queue: nothing leaves.
create schema if not exists supabase_functions authorization supabase_functions_admin;
grant usage on schema supabase_functions to postgres, anon, authenticated, service_role;
set role supabase_functions_admin;
create table if not exists supabase_functions.hooks (id bigserial primary key, hook_table_id integer not null, hook_name text not null, created_at timestamptz not null default now(), request_id bigint);
create or replace function supabase_functions.http_request() returns trigger language plpgsql security definer set search_path to 'supabase_functions' as $f$
declare
  request_id bigint; payload jsonb; url text := TG_ARGV[0]::text; method text := TG_ARGV[1]::text;
  headers jsonb default '{}'::jsonb; params jsonb default '{}'::jsonb; timeout_ms integer default 1000;
begin
  if url is null or url = 'null' then raise exception 'url argument is missing'; end if;
  if method is null or method = 'null' then raise exception 'method argument is missing'; end if;
  if TG_ARGV[2] is null or TG_ARGV[2] = 'null' then headers = '{"Content-Type": "application/json"}'::jsonb; else headers = TG_ARGV[2]::jsonb; end if;
  if TG_ARGV[3] is null or TG_ARGV[3] = 'null' then params = '{}'::jsonb; else params = TG_ARGV[3]::jsonb; end if;
  if TG_ARGV[4] is null or TG_ARGV[4] = 'null' then timeout_ms = 1000; else timeout_ms = TG_ARGV[4]::integer; end if;
  case
    when method = 'GET' then select net.http_get(url, params, headers, timeout_ms) into request_id;
    when method = 'POST' then
      payload = jsonb_build_object('old_record', OLD, 'record', NEW, 'type', TG_OP, 'table', TG_TABLE_NAME, 'schema', TG_TABLE_SCHEMA);
      select net.http_post(url, payload, params, headers, timeout_ms) into request_id;
    else raise exception 'method argument % is invalid', method;
  end case;
  insert into supabase_functions.hooks (hook_table_id, hook_name, request_id) values (TG_RELID, TG_NAME, request_id);
  return new;
end $f$;
reset role;
grant all on table supabase_functions.hooks to postgres, anon, authenticated, service_role;
grant usage, select, update on sequence supabase_functions.hooks_id_seq to postgres, anon, authenticated, service_role;
grant execute on function supabase_functions.http_request() to postgres, anon, authenticated, service_role;

-- pg_cron (schema cron): the stand-in records schedules and runs nothing; its functions are not executable by PUBLIC
create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, nodename text default 'localhost', nodeport int default 5432, database text default current_database(), username text default current_user, active boolean default true);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint language plpgsql as $$
declare j bigint; begin
  select jobid into j from cron.job where jobname = job_name;
  if j is null then insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid into j;
  else update cron.job set schedule = cron.schedule.schedule, command = cron.schedule.command where jobid = j; end if;
  return j; end $$;
create or replace function cron.schedule(schedule text, command text) returns bigint language sql as $$ insert into cron.job (schedule, command) values (schedule, command) returning jobid $$;
create or replace function cron.unschedule(job_name text) returns boolean language sql as $$ delete from cron.job where jobname = job_name returning true $$;
create or replace function cron.unschedule(job_id bigint) returns boolean language sql as $$ delete from cron.job where jobid = job_id returning true $$;
create or replace function cron.alter_job(job_id bigint, schedule text default null, command text default null, database text default null, username text default null, active boolean default null) returns void language sql as $$ update cron.job set schedule = coalesce(alter_job.schedule, job.schedule), command = coalesce(alter_job.command, job.command), active = coalesce(alter_job.active, job.active) where jobid = job_id $$;
revoke execute on all functions in schema cron from public;
revoke usage on schema cron from public;

-- supabase_vault (schema vault): the stand-in stores nothing secret; it exists so definitions that name it compile.
create schema if not exists vault;
create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, description text default '', secret text, key_id uuid, nonce bytea, created_at timestamptz default now(), updated_at timestamptz default now());
create or replace view vault.decrypted_secrets as select id, name, description, secret, secret as decrypted_secret, key_id, nonce, created_at, updated_at from vault.secrets;
create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null) returns uuid language sql as $$ insert into vault.secrets (name, description, secret, key_id) values (new_name, new_description, new_secret, new_key_id) returning id $$;
revoke execute on all functions in schema vault from public;
revoke usage on schema vault from public;

-- graphql_public is exposed by default on Supabase (the shim creates it too); the Data API exposes public + graphql_public
create schema if not exists graphql_public;
alter role authenticator set pgrst.db_schemas = 'public, graphql_public';

-- pg_graphql stand-in: the Data API's /graphql/v1 resolves to graphql_public.graphql (PostgREST POST /rpc/graphql with
-- Content-Profile graphql_public). Production's pg_graphql does not reflect net, so every net collection is an unknown
-- field; the stand-in answers exactly that for every query. The platform's ACL on graphql_public: USAGE for the API roles,
-- never PUBLIC.
create or replace function graphql_public.graphql("operationName" text default null, query text default null, variables jsonb default null, extensions jsonb default null)
returns jsonb language plpgsql volatile as $g$
declare f text := coalesce(substring(coalesce(query, '') from '^\s*(?:query\s*)?\{\s*([A-Za-z_][A-Za-z0-9_]*)'), 'unknown');
begin
  return jsonb_build_object('data', null, 'errors', jsonb_build_array(jsonb_build_object('message', format('Unknown field "%s" on type "Query"', f))));
end $g$;
revoke usage on schema graphql_public from public;
grant usage on schema graphql_public to postgres, anon, authenticated, service_role;
grant execute on function graphql_public.graphql(text, text, jsonb, jsonb) to postgres, anon, authenticated, service_role;
