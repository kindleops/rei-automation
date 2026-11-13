-- DISPOSABLE-TEST EMULATION of Supabase's pg_net 0.20.x object set (see pg_net.control). Every function
-- is SQL / plpgsql with the real signature; none can reach a network (there is no worker and no C code).
-- The ACLs follow https://supabase.com/docs/guides/troubleshooting/revoking-access-to-pg_net-objects-has-no-effect-0bbc16
-- (PUBLIC: USAGE on net, all privileges on the net tables and sequences, EXECUTE on the functions); the
-- platform's extra USAGE grants (postgres, anon, authenticated, service_role) are made by the fixture AS
-- supabase_admin after CREATE EXTENSION, as the platform does.
\echo Use "CREATE EXTENSION pg_net" to load this file. \quit

create schema net;

create type net.request_status as enum ('PENDING', 'SUCCESS', 'ERROR');

create unlogged table net.http_request_queue (
  id bigserial not null,
  method text not null,
  url text not null,
  headers jsonb not null,
  body bytea,
  timeout_milliseconds integer not null
);

create unlogged table net._http_response (
  id bigint,
  status_code integer,
  content_type text,
  headers jsonb,
  content text,
  timed_out boolean,
  error_msg text,
  created timestamptz not null default now()
);
create index _http_response_created_idx on net._http_response (created);

create type net.http_response as (status_code integer, headers jsonb, body text);
create type net.http_response_result as (status net.request_status, message text, response net.http_response);

create function net._urlencode_string(string varchar) returns text
  language sql immutable strict as $f$ select replace(string::text, ' ', '%20') $f$;

create function net._encode_url_with_params_array(url text, params_array text[]) returns text
  language sql immutable strict as $f$ select url || case when cardinality(params_array) > 0 then '?' || array_to_string(params_array, '&') else '' end $f$;

create function net.http_get(url text, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
  returns bigint language plpgsql volatile parallel safe as $f$
declare request_id bigint;
begin
  insert into net.http_request_queue (method, url, headers, timeout_milliseconds) values ('GET', url, headers, timeout_milliseconds) returning id into request_id;
  return request_id;
end $f$;

create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000)
  returns bigint language plpgsql volatile parallel safe as $f$
declare request_id bigint;
begin
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds) values ('POST', url, headers, convert_to(body::text, 'UTF8'), timeout_milliseconds) returning id into request_id;
  return request_id;
end $f$;

create function net.http_delete(url text, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000, body jsonb default null)
  returns bigint language plpgsql volatile parallel safe as $f$
declare request_id bigint;
begin
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds) values ('DELETE', url, headers, convert_to(body::text, 'UTF8'), timeout_milliseconds) returning id into request_id;
  return request_id;
end $f$;

create function net._await_response(request_id bigint) returns boolean
  language sql volatile parallel safe strict as $f$ select exists (select 1 from net._http_response r where r.id = request_id) $f$;

create function net._http_collect_response(request_id bigint, async boolean default true) returns net.http_response_result
  language sql volatile parallel safe strict as $f$
  select row(case when r.id is null then 'PENDING' else 'SUCCESS' end, '', row(r.status_code, r.headers, r.content)::net.http_response)::net.http_response_result
    from (select 1) one left join net._http_response r on r.id = request_id $f$;

create function net.http_collect_response(request_id bigint, async boolean default true) returns net.http_response_result
  language sql volatile parallel safe strict as $f$ select net._http_collect_response(request_id, async) $f$;

create function net.worker_restart() returns boolean language sql as $f$ select true $f$;
create function net.wait_until_running() returns void language sql as $f$ select $f$;
create function net.wake() returns void language sql as $f$ select $f$;

grant usage on schema net to public;
grant all on all tables in schema net to public;
grant all on all sequences in schema net to public;
