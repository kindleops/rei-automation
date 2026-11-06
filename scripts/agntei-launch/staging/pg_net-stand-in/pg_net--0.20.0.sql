-- STAND-IN for pg_net 0.20.0 (staging only; see pg_net.control). Created by supabase_admin so every object is owned by
-- it and is a member of the extension, exactly as the platform exception in the gateway migration pins it.
\echo Use "CREATE EXTENSION pg_net" to load this file. \quit

create schema net;

create type net.http_method as enum ('GET', 'POST', 'DELETE');
create type net.request_status as enum ('PENDING', 'SUCCESS', 'ERROR');
create type net.http_response as (status_code integer, headers jsonb, body text);
create type net.http_response_result as (status net.request_status, message text, response net.http_response);

create table net.http_request_queue (
  id bigserial primary key,
  method text not null,
  url text not null,
  headers jsonb not null default '{}'::jsonb,
  body bytea,
  timeout_milliseconds integer not null default 5000
);
create table net._http_response (
  id bigint,
  status_code integer,
  content_type text,
  headers jsonb,
  content text,
  timed_out boolean,
  error_msg text,
  created timestamptz not null default now()
);

create function net._urlencode_string(string character varying) returns text language sql immutable as $$ select replace(replace(string, ' ', '%20'), '&', '%26') $$;
create function net._encode_url_with_params_array(url text, params_array text[]) returns text language sql immutable as $$ select url || case when coalesce(array_length(params_array, 1), 0) > 0 then '?' || array_to_string(params_array, '&') else '' end $$;
create function net.http_get(url text, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000) returns bigint language sql as $$ insert into net.http_request_queue (method, url, headers, timeout_milliseconds) values ('GET', url, headers, timeout_milliseconds) returning id $$;
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000) returns bigint language sql as $$ insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds) values ('POST', url, headers, convert_to(body::text, 'UTF8'), timeout_milliseconds) returning id $$;
create function net.http_delete(url text, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000) returns bigint language sql as $$ insert into net.http_request_queue (method, url, headers, timeout_milliseconds) values ('DELETE', url, headers, timeout_milliseconds) returning id $$;
create function net._await_response(request_id bigint) returns boolean language sql as $$ select exists (select 1 from net._http_response where id = request_id) $$;
create function net._http_collect_response(request_id bigint, async boolean default true) returns net.http_response_result language sql as $$ select row('PENDING'::net.request_status, 'stand-in: nothing is sent', null::net.http_response)::net.http_response_result $$;
create function net.http_collect_response(request_id bigint, async boolean default true) returns net.http_response_result language sql as $$ select net._http_collect_response(request_id, async) $$;
create function net.worker_restart() returns boolean language sql as $$ select true $$;
create function net.wait_until_running() returns void language sql as $$ select null::void $$;
create function net.wake() returns void language sql as $$ select null::void $$;
create function net.check_worker_is_up() returns void language sql as $$ select null::void $$;

-- the platform's grants (grantor: the creating role, supabase_admin)
grant usage on schema net to public, postgres, anon, authenticated, service_role, supabase_functions_admin;
grant all on table net.http_request_queue to public;
grant all on table net._http_response to public;
grant usage, select, update on sequence net.http_request_queue_id_seq to public;
grant execute on function net.http_get(text, jsonb, jsonb, integer) to postgres, anon, authenticated, service_role, supabase_functions_admin;
grant execute on function net.http_post(text, jsonb, jsonb, jsonb, integer) to postgres, anon, authenticated, service_role, supabase_functions_admin;
grant execute on function net.http_delete(text, jsonb, jsonb, integer) to postgres, anon, authenticated, service_role, supabase_functions_admin;
