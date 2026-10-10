-- PROPOSED ONLY — companion to PROPOSED_20261010120000_agent_s3_persistence.sql.
-- Run at release step C AFTER the migration, by the owner, with the password
-- supplied out of band (never committed; store it only as the Worker/container
-- secret AGENT_DATABASE_URL):
--   psql "$PROD_DB" -X -v ON_ERROR_STOP=1 -v agent_api_password="$(cat /secure/agent_api_pw)" -f this_file.sql
-- Supabase pooler user: agent_api.<project-ref>; the API connects with
--   AGENT_DATABASE_URL=postgresql://agent_api.<ref>:<pw>@<pooler-host>:6543/postgres?sslmode=verify-full
-- agent_api is NON-owner, NOINHERIT, NOBYPASSRLS; its rights are exactly the
-- grants + agent_api_* policies in the migration (no DELETE / TRUNCATE / DDL).
\if :{?agent_api_password}
\else
  \echo 'agent_api_password is required (-v agent_api_password=...)'
  \quit
\endif
alter role agent_api with login password :'agent_api_password' connection limit 10;
alter role agent_api set statement_timeout = '30s';
alter role agent_api set lock_timeout = '10s';
alter role agent_api set idle_in_transaction_session_timeout = '60s';
-- verify
select rolname, rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = 'agent_api';
