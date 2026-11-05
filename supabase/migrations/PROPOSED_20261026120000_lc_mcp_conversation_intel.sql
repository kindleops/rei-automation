-- =============================================================================
-- LeadCommand MCP 1.1: conversation and pipeline intelligence (read-only definer projections)
-- STATUS: PROPOSED. NOT APPLIED. Owner approval required; applied on its own, AFTER
--   PROPOSED_20261019150000_lc_mcp_reader.sql (the lc_mcp_reader role must exist).
-- Test (disposable PostgreSQL ONLY, never production):
--   node scripts/db/run-migration-test.mjs --pg-bin <pg bin dir> --id lc_mcp_conversation_intel
-- Rollback: PROPOSED_20261026120000_lc_mcp_conversation_intel_rollback.sql (drops exactly what this creates)
-- Design:   docs/LEADCOMMAND-CONVERSATION-INTELLIGENCE.md
-- =============================================================================
--
-- WHY. LeadCommand MCP 1.0 returned conversation METADATA only ("Seller message text is never
-- returned"), so the acquisition workforce could not read what sellers actually said: replies,
-- asking prices, objections, timelines, commitments, opt-outs. This adds four READ projections.
-- The role still holds NO privilege on message_events, send_queue or the holds registry: it sees
-- only what these functions return.
--
-- WHAT IT CREATES (each STABLE, SECURITY DEFINER, plpgsql, search_path = pg_catalog, fully
-- qualified, static SQL only — no dynamic SQL, no network — bounded inputs refused with 22023;
-- EXECUTE revoked from PUBLIC / anon / authenticated / service_role and granted to lc_mcp_reader only):
--
--   lc_mcp_lead_conversation(text, uuid, integer, timestamptz, text, integer)
--     ONE lead (property_id) or ONE inbox thread (thread id): its seller threads and a keyset page
--     of messages, newest first — direction, event type, the message TEXT (message_body, capped at
--     2000 characters), timestamps, delivery states, recorded classifications (opt-out, intent,
--     language), and how each row is attributed to the lead. Threads are found from every source that
--     links a phone to the lead (message_events.property_id, campaign_target_graph,
--     inbox_thread_state.property_id, contact_property_resolution); whether the property is on record;
--     rows the thread holds about ANOTHER property are counted, never returned. Per thread: the
--     suppression and eligibility INPUTS (sms_suppression_list, the thread's own flags, the phone
--     row, automation holds through public.automation_hold_for, the latest recorded opt-out), never
--     a verdict that would stand in for the send-time guard. The history state separates "no thread",
--     "empty", "missing" (the thread's counters say messages exist but none is on record) and
--     "outside the window". NEVER returned: a phone number, a thread key, a name, an email, the raw
--     provider payload (metadata.payload), hold ids / keys / reason text.
--   lc_mcp_conversation_worklist(text, integer, text, timestamptz, uuid, integer)
--     A keyset page of inbox threads in one category — unanswered_inbound, recent_inbound,
--     opted_out, identity_conflict, suppression_conflict (the opt-out record and the suppression list
--     disagree) — each VERIFIED against message_events (the latest event's real direction), with its
--     latest ≤ 3 inbound texts (≤ 600 characters each) and our latest outbound (≤ 400) as evidence, the lead's
--     pipeline labels, the Decision Engine presence / age and the suppression inputs. Plus the exact
--     category count.
--   lc_mcp_pipeline_counts(text, text, text, integer)
--     Exact lead counts from eg_property_facts grouped by ONE dimension (market, state,
--     conversation_stage, conversation_status, pipeline_stage, pipeline_status, sms_status), with
--     optional market / state filters, the top N groups and the remainder.
--   lc_mcp_conversation_signals(integer, text)
--     Exact counts over a window: threads with inbound, unanswered inbound, opted out, suppressed,
--     not contactable, suppression conflicts (either direction); inbound / opt-out / unknown-sender messages; phones linked to several
--     properties; properties with several threads; leads in conversation with no Decision Engine
--     score, or a score older than 30 days.
--
-- MESSAGE ORDER. Messages are ordered by created_at (the row's FIRST write), then id. An inbound
-- row's event_timestamp / received_at are rewritten by the handler's second pass with processing
-- time (handle-textgrid-inbound.js), so created_at is the truthful receipt order. Both are returned.
--
-- WHAT MAKES THE APPLY ABORT (atomically): lc_mcp_reader missing; any self-check finding for the
-- role with the extended function list (the same rules as the 1.0 apply: no write, CREATE, login,
-- membership, egress, exposed read outside the inventory, unexpected definer, volatile allowlisted RPC).
-- Sources the database does not have (contact_property_resolution, automation_hold_for) are skipped
-- at call time and reported as not available — never a reason for this apply to fail.

set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'lc_mcp_reader') then
    raise exception 'lc_mcp_conversation_intel: role lc_mcp_reader does not exist — apply PROPOSED_20261019150000_lc_mcp_reader.sql first';
  end if;
end
$$;

-- ------------------------------------------------------------ 1. one lead's conversation ----
create or replace function public.lc_mcp_lead_conversation(
  p_property_id text, p_thread_id uuid, p_window_days integer, p_before_at timestamptz, p_before_id text, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  lim integer := coalesce(p_limit, 30);
  win integer := coalesce(p_window_days, 365);
  since timestamptz;
  keys text[] := '{}';
  all_keys text[];
  subject_thread record;
  threads jsonb := '[]'::jsonb;
  msgs jsonb;
  page_n integer;
  ever_n integer;
  in_window_in integer; in_window_out integer;
  other_rows integer := 0;
  earliest timestamptz; latest timestamptz;
  counters_say integer := 0;
  history text;
  has_cpr boolean := pg_catalog.to_regclass('public.contact_property_resolution') is not null;
  has_holds boolean := pg_catalog.to_regprocedure('public.automation_hold_for(text,uuid,text,uuid,text,text)') is not null;
  k text; i integer := 0; t record; th jsonb; cpr jsonb; sup jsonb; ph jsonb; hl jsonb; oo timestamptz; mi integer; mo integer;
begin
  if (p_property_id is null) = (p_thread_id is null) then
    raise exception using errcode = '22023', message = 'lc_mcp_lead_conversation: give exactly one of property id or thread id';
  end if;
  if p_property_id is not null and p_property_id !~ '^[A-Za-z0-9_.:-]{1,64}$' then
    raise exception using errcode = '22023', message = 'lc_mcp_lead_conversation: property id out of bounds';
  end if;
  if lim < 1 or lim > 50 then raise exception using errcode = '22023', message = 'lc_mcp_lead_conversation: limit must be 1..50'; end if;
  if win < 1 or win > 1095 then raise exception using errcode = '22023', message = 'lc_mcp_lead_conversation: window must be 1..1095 days'; end if;
  if (p_before_at is null) <> (p_before_id is null) or length(coalesce(p_before_id, '')) > 64 then
    raise exception using errcode = '22023', message = 'lc_mcp_lead_conversation: cursor out of bounds';
  end if;
  since := pg_catalog.now() - pg_catalog.make_interval(days => win);

  -- The seller threads. A thread key is the seller's E.164 number: one thread per phone, across properties.
  if p_thread_id is not null then
    select s.thread_key, s.property_id into subject_thread from public.inbox_thread_state s where s.id = p_thread_id;
    if not found then return jsonb_build_object('subject_found', false); end if;
    if subject_thread.thread_key is not null then keys := array[subject_thread.thread_key]; end if;
  else
    -- from every source that links a seller phone to the lead. inbox_thread_state.property_id has no index in
    -- production (a bounded scan of one modest table, inside the role's 5 s statement_timeout); without it a lead
    -- whose only link is its thread row would read as "no thread"
    select coalesce(array_agg(distinct x.key), '{}') into all_keys from (
      (select m.thread_key as key from public.message_events m
        where m.property_id = p_property_id and m.thread_key is not null limit 200)
      union all
      (select g.canonical_e164 from public.campaign_target_graph g
        where g.property_id = p_property_id and g.canonical_e164 is not null limit 50)
      union all
      (select s.thread_key from public.inbox_thread_state s
        where s.property_id = p_property_id and s.thread_key is not null limit 20)
    ) x where x.key ~ '^\+[1-9][0-9]{7,14}$';
    if has_cpr then
      select coalesce(array_agg(distinct x.key), '{}') || all_keys into all_keys from (
        select r.contact_phone_e164 as key from public.contact_property_resolution r
         where r.property_id = p_property_id and r.contact_phone_e164 is not null limit 50) x
       where x.key ~ '^\+[1-9][0-9]{7,14}$';
      select coalesce(array_agg(distinct u), '{}') into all_keys from unnest(all_keys) u;
    end if;
    -- the ten most recently active first
    select coalesce(array_agg(q.key order by q.at desc nulls last, q.key), '{}') into keys from (
      select u as key, (select max(m.created_at) from public.message_events m where m.thread_key = u) as at
        from unnest(all_keys) u) q;
    keys := keys[1:10];
  end if;

  -- each thread: its row, how it links to the lead, and the suppression / eligibility INPUTS
  foreach k in array keys loop
    i := i + 1;
    select to_jsonb(s) as j, s.id, s.property_id, s.master_owner_id into t from public.inbox_thread_state s where s.thread_key = k;
    cpr := null;
    if has_cpr and p_property_id is not null then
      select jsonb_build_object('role', r.contact_property_role, 'rejected', r.rejected_at is not null,
                                'suppression_scope', to_jsonb(r)->>'suppression_scope') into cpr
        from public.contact_property_resolution r where r.property_id = p_property_id and r.contact_phone_e164 = k limit 1;
    end if;
    select jsonb_build_object(
        'active_rows', count(*) filter (where coalesce(x.is_active, false)),
        'global_rows', count(*) filter (where coalesce(x.is_active, false) and (to_jsonb(x)->>'sender_phone_e164') is null),
        'sender_scoped_rows', count(*) filter (where coalesce(x.is_active, false) and (to_jsonb(x)->>'sender_phone_e164') is not null),
        'types', coalesce(jsonb_agg(distinct x.suppression_type) filter (where coalesce(x.is_active, false) and x.suppression_type is not null), '[]'::jsonb))
      into sup from public.sms_suppression_list x where x.phone_e164 = k or x.phone_number = k;
    select coalesce(jsonb_agg(jsonb_build_object(
        'phone_type', to_jsonb(p)->>'phone_type', 'contact_status', to_jsonb(p)->>'phone_contact_status',
        'activity_status', to_jsonb(p)->>'activity_status', 'wrong_number_at', to_jsonb(p)->>'wrong_number_at')), '[]'::jsonb)
      into ph from (select * from public.phones p0 where p0.canonical_e164 = k limit 3) p;
    hl := null;
    if has_holds then
      select jsonb_build_object('active', count(*), 'categories', coalesce(jsonb_agg(distinct case
                when h.hold_type = 'permanent_exclusion' then 'permanent_exclusion'
                when h.reason = 'ownership_denial_property_unresolved' or h.hold_key like 'ownership_unresolved:%' then 'ownership_attribution_unresolved'
                else 'operator_hold' end), '[]'::jsonb),
              'blocked_capabilities', coalesce((select jsonb_agg(distinct c) from unnest(array_agg(h.blocked_capabilities)) c), '[]'::jsonb))
        into hl from public.automation_hold_for(k, t.id, coalesce(t.property_id, p_property_id), null::uuid, t.master_owner_id, null::text) h;
    end if;
    select max(m.created_at) into oo from public.message_events m
     where m.thread_key = k and (m.is_opt_out is true or lower(coalesce(m.detected_intent, '')) in ('opt_out', 'stop', 'property_do_not_contact'));
    select count(*) filter (where lower(m.direction) like 'in%'), count(*) filter (where lower(m.direction) like 'out%')
      into mi, mo from (select m0.direction from public.message_events m0 where m0.thread_key = k limit 5000) m;
    counters_say := counters_say + coalesce((t.j->>'inbound_count')::int, 0) + coalesce((t.j->>'outbound_count')::int, 0);
    th := jsonb_build_object(
      'handle', 'T' || i,
      'thread_id', t.id,
      'thread_row', t.id is not null,
      'thread_property', case when t.id is null then null
                              when t.property_id is null then 'none'
                              when p_property_id is not null and t.property_id = p_property_id then 'this'
                              when p_property_id is null then 'set' else 'other' end,
      'thread_property_id', case when p_property_id is null then t.property_id else null end,
      'status', t.j->>'status', 'automation_state', t.j->>'automation_state', 'latest_direction', t.j->>'latest_direction',
      'last_inbound_at', t.j->>'last_inbound_at', 'last_outbound_at', t.j->>'last_outbound_at',
      'counters', jsonb_build_object('inbound', t.j->'inbound_count', 'outbound', t.j->'outbound_count'),
      'events_on_record', jsonb_build_object('inbound', mi, 'outbound', mo, 'capped_at', 5000),
      'contact_property', cpr,
      'eligibility_inputs', jsonb_build_object(
        'suppression_list', sup,
        'thread_flags', jsonb_build_object('is_suppressed', t.j->'is_suppressed', 'contactability_status', t.j->>'contactability_status',
                                           'opt_out', t.j->'opt_out', 'wrong_number', t.j->'wrong_number', 'paused', (t.j->>'status') = 'paused_review'),
        'phone_rows', ph,
        'holds', hl,
        'holds_available', has_holds,
        'latest_opt_out_at', oo),
      'key_sha256', encode(sha256(convert_to(k, 'UTF8')), 'hex'));
    threads := threads || th;
  end loop;

  -- the page (newest first; the caller shows it oldest first)
  with page as (
    select m.*, to_jsonb(m) as j from public.message_events m
     where (m.thread_key = any(keys) or (m.thread_key is null and m.from_phone_number = any(keys)))
       and m.created_at >= since
       and (p_property_id is null or m.property_id is null or m.property_id = p_property_id)
       and (p_before_at is null or (m.created_at, m.id::text) < (p_before_at, p_before_id))
     order by m.created_at desc, m.id::text desc
     limit lim + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id::text,
      'thread', 'T' || coalesce(array_position(keys, coalesce(p.thread_key, p.from_phone_number)), 0),
      'direction', lower(p.direction),
      'event_type', p.j->>'event_type',
      'body', left(p.j->>'message_body', 2000),
      'body_chars', length(p.j->>'message_body'),
      'created_at', p.created_at,
      'event_timestamp', p.j->>'event_timestamp', 'received_at', p.j->>'received_at', 'sent_at', p.j->>'sent_at',
      'delivered_at', p.j->>'delivered_at', 'failed_at', p.j->>'failed_at',
      'delivery_status', p.j->>'delivery_status', 'provider_delivery_status', p.j->>'provider_delivery_status',
      'is_final_failure', p.j->'is_final_failure',
      'is_opt_out', p.j->'is_opt_out', 'detected_intent', p.j->>'detected_intent', 'language', p.j->>'language',
      'origin', p.j->'metadata'->>'message_origin',
      'attribution', case when p.property_id is null then (case when p.thread_key is null then 'phone' else 'thread' end)
                          when p_property_id is not null and p.property_id = p_property_id then 'property' else 'set' end,
      'property_id', case when p_property_id is null then p.property_id else null end)
      order by p.created_at desc, p.id::text desc), '[]'::jsonb), count(*)
    into msgs, page_n from page p;

  -- counts and the history state
  select count(*) filter (where lower(m.direction) like 'in%'), count(*) filter (where lower(m.direction) like 'out%')
    into in_window_in, in_window_out
    from (select m0.direction from public.message_events m0
           where (m0.thread_key = any(keys) or (m0.thread_key is null and m0.from_phone_number = any(keys)))
             and m0.created_at >= since and (p_property_id is null or m0.property_id is null or m0.property_id = p_property_id)
           limit 5000) m;
  if p_property_id is not null then
    select count(*) into other_rows from (select 1 from public.message_events m
      where m.thread_key = any(keys) and m.created_at >= since and m.property_id is not null and m.property_id <> p_property_id limit 5000) x;
  end if;
  select count(*), min(x.created_at), max(x.created_at) into ever_n, earliest, latest from (
    select m.created_at from public.message_events m
     where (m.thread_key = any(keys) or (m.thread_key is null and m.from_phone_number = any(keys)))
       and (p_property_id is null or m.property_id is null or m.property_id = p_property_id)
     limit 20000) x;
  history := case when cardinality(keys) = 0 then 'no_thread'
                  when ever_n = 0 and counters_say > 0 then 'missing'
                  when ever_n = 0 then 'empty'
                  when in_window_in + in_window_out = 0 then 'outside_window'
                  else 'present' end;

  return jsonb_build_object(
    'subject_found', true,
    'property_on_record', case when p_property_id is null then null
                               else exists (select 1 from public.properties x where x.property_id = p_property_id)
                                 or exists (select 1 from public.eg_property_facts x where x.property_id = p_property_id) end,
    'threads', threads,
    'threads_truncated', coalesce(cardinality(all_keys), 0) > cardinality(keys),
    'messages', case when page_n > lim then msgs - lim else msgs end,
    'has_more', page_n > lim,
    'window_days', win,
    'counts', jsonb_build_object('inbound_in_window', in_window_in, 'outbound_in_window', in_window_out, 'capped_at', 5000,
                                 'other_property_rows_in_window', other_rows),
    'history', jsonb_build_object('state', history, 'earliest_at', earliest, 'latest_at', latest, 'rows_on_record', ever_n, 'capped_at', 20000),
    'sources', jsonb_build_object('contact_property_resolution', has_cpr, 'automation_hold_for', has_holds),
    'as_of', pg_catalog.now());
end
$fn$;
comment on function public.lc_mcp_lead_conversation(text, uuid, integer, timestamptz, text, integer) is 'LeadCommand MCP 1.1: one lead''s (or one thread''s) seller conversation — threads, a keyset page of messages WITH text (untrusted content), delivery states, attribution, suppression / eligibility inputs, history state. Never phones, thread keys, names, emails, raw payloads or hold ids. Read-only. Executable by lc_mcp_reader only.';

-- ------------------------------------------------------------ 2. the conversation worklist ----
create or replace function public.lc_mcp_conversation_worklist(
  p_category text, p_window_days integer, p_market text, p_after_at timestamptz, p_after_id uuid, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  lim integer := coalesce(p_limit, 10);
  win integer := coalesce(p_window_days, 30);
  since timestamptz;
  total integer;
  rows_out jsonb := '[]'::jsonb;
  n integer := 0;
  has_holds boolean := pg_catalog.to_regprocedure('public.automation_hold_for(text,uuid,text,uuid,text,text)') is not null;
  r record; ev jsonb; lo jsonb; oo boolean; latest_dir text; latest_at timestamptz; last_out timestamptz; props integer; facts jsonb; score jsonb; sup jsonb; hl jsonb;
begin
  if p_category is null or p_category not in ('unanswered_inbound', 'recent_inbound', 'opted_out', 'identity_conflict', 'suppression_conflict') then
    raise exception using errcode = '22023', message = 'lc_mcp_conversation_worklist: unknown category';
  end if;
  if lim < 1 or lim > 25 then raise exception using errcode = '22023', message = 'lc_mcp_conversation_worklist: limit must be 1..25'; end if;
  if win < 1 or win > 365 then raise exception using errcode = '22023', message = 'lc_mcp_conversation_worklist: window must be 1..365 days'; end if;
  if (p_after_at is null) <> (p_after_id is null) then raise exception using errcode = '22023', message = 'lc_mcp_conversation_worklist: cursor out of bounds'; end if;
  if p_market is not null and length(p_market) > 60 then raise exception using errcode = '22023', message = 'lc_mcp_conversation_worklist: market out of bounds'; end if;
  since := pg_catalog.now() - pg_catalog.make_interval(days => win);

  select count(*) into total from public.inbox_thread_state s
    left join public.eg_property_facts f on f.property_id = s.property_id
   where s.last_inbound_at >= since and s.thread_key is not null
     and (p_market is null or f.market = p_market)
     and case p_category
           when 'unanswered_inbound' then (s.last_outbound_at is null or s.last_outbound_at < s.last_inbound_at)
                                          and not coalesce((to_jsonb(s)->>'opt_out')::boolean, false)
           when 'opted_out' then coalesce((to_jsonb(s)->>'opt_out')::boolean, false) or (to_jsonb(s)->>'contactability_status') = 'opted_out'
           when 'identity_conflict' then (select count(distinct m.property_id) from public.message_events m
                                           where m.thread_key = s.thread_key and m.created_at >= since and m.property_id is not null) > 1
           -- the opt-out record and the suppression list disagree (either direction)
           when 'suppression_conflict' then
             exists (select 1 from public.sms_suppression_list x where (x.phone_e164 = s.thread_key or x.phone_number = s.thread_key) and coalesce(x.is_active, false))
             is distinct from
             (coalesce((to_jsonb(s)->>'opt_out')::boolean, false) or (to_jsonb(s)->>'contactability_status') = 'opted_out'
              or exists (select 1 from public.message_events m where m.thread_key = s.thread_key and lower(m.direction) like 'in%' and m.is_opt_out is true))
           else true end;

  for r in
    select s.id, s.thread_key, s.property_id, s.master_owner_id, s.last_inbound_at, s.last_outbound_at, to_jsonb(s) as j
      from public.inbox_thread_state s
      left join public.eg_property_facts f on f.property_id = s.property_id
     where s.last_inbound_at >= since and s.thread_key is not null
       and (p_market is null or f.market = p_market)
       and (p_after_at is null or (s.last_inbound_at, s.id) < (p_after_at, p_after_id))
       and case p_category
             when 'unanswered_inbound' then (s.last_outbound_at is null or s.last_outbound_at < s.last_inbound_at)
                                            and not coalesce((to_jsonb(s)->>'opt_out')::boolean, false)
             when 'opted_out' then coalesce((to_jsonb(s)->>'opt_out')::boolean, false) or (to_jsonb(s)->>'contactability_status') = 'opted_out'
             when 'identity_conflict' then (select count(distinct m.property_id) from public.message_events m
                                             where m.thread_key = s.thread_key and m.created_at >= since and m.property_id is not null) > 1
             when 'suppression_conflict' then
               exists (select 1 from public.sms_suppression_list x where (x.phone_e164 = s.thread_key or x.phone_number = s.thread_key) and coalesce(x.is_active, false))
               is distinct from
               (coalesce((to_jsonb(s)->>'opt_out')::boolean, false) or (to_jsonb(s)->>'contactability_status') = 'opted_out'
                or exists (select 1 from public.message_events m where m.thread_key = s.thread_key and lower(m.direction) like 'in%' and m.is_opt_out is true))
             else true end
     order by s.last_inbound_at desc, s.id desc
     limit lim + 1
  loop
    n := n + 1;
    exit when n > lim;
    -- verified against the events themselves (the thread row's latest_* fields are a projection)
    select lower(m.direction), m.created_at into latest_dir, latest_at from public.message_events m
     where m.thread_key = r.thread_key order by m.created_at desc, m.id::text desc limit 1;
    select max(m.created_at) into last_out from public.message_events m where m.thread_key = r.thread_key and lower(m.direction) like 'out%';
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id::text, 'created_at', x.created_at, 'body', left(x.j->>'message_body', 600),
                                                 'detected_intent', x.j->>'detected_intent', 'is_opt_out', x.j->'is_opt_out', 'language', x.j->>'language',
                                                 'attribution', case when x.property_id is null then 'thread' when x.property_id = r.property_id then 'property' else 'other' end)
                              order by x.created_at desc), '[]'::jsonb)
      into ev from (select m.*, to_jsonb(m) as j from public.message_events m
                     where m.thread_key = r.thread_key and lower(m.direction) like 'in%' order by m.created_at desc limit 3) x;
    -- our latest outbound (what we last said or promised, and whether it was delivered)
    select jsonb_build_object('id', x.id::text, 'created_at', x.created_at, 'body', left(x.j->>'message_body', 400),
                              'delivery_status', x.j->>'delivery_status', 'provider_delivery_status', x.j->>'provider_delivery_status', 'origin', x.j->'metadata'->>'message_origin')
      into lo from (select m.*, to_jsonb(m) as j from public.message_events m
                     where m.thread_key = r.thread_key and lower(m.direction) like 'out%' order by m.created_at desc, m.id::text desc limit 1) x;
    select exists (select 1 from public.message_events m where m.thread_key = r.thread_key and lower(m.direction) like 'in%' and m.is_opt_out is true) into oo;
    select count(distinct m.property_id) into props from public.message_events m where m.thread_key = r.thread_key and m.created_at >= since and m.property_id is not null;
    select jsonb_build_object('market', f.market, 'conversation_stage', to_jsonb(f)->>'conversation_stage', 'conversation_status', to_jsonb(f)->>'conversation_status',
                              'pipeline_stage', to_jsonb(f)->>'pipeline_stage', 'pipeline_status', to_jsonb(f)->>'pipeline_status')
      into facts from public.eg_property_facts f where f.property_id = r.property_id;
    select jsonb_build_object('aos_score', to_jsonb(a)->'aos_score', 'decision_tier', to_jsonb(a)->>'decision_tier', 'computed_at', to_jsonb(a)->>'computed_at')
      into score from public.property_acquisition_scores a where a.property_id = r.property_id;
    select jsonb_build_object('active_rows', count(*) filter (where coalesce(x.is_active, false)),
                              'types', coalesce(jsonb_agg(distinct x.suppression_type) filter (where coalesce(x.is_active, false) and x.suppression_type is not null), '[]'::jsonb))
      into sup from public.sms_suppression_list x where x.phone_e164 = r.thread_key or x.phone_number = r.thread_key;
    hl := null;
    if has_holds then
      select jsonb_build_object('active', count(*)) into hl
        from public.automation_hold_for(r.thread_key, r.id, r.property_id, null::uuid, r.master_owner_id, null::text) h;
    end if;
    rows_out := rows_out || jsonb_build_object(
      'thread_id', r.id, 'property_id', r.property_id,
      'last_inbound_at', r.last_inbound_at, 'last_outbound_at', r.last_outbound_at,
      'verified', jsonb_build_object('latest_direction', latest_dir, 'latest_at', latest_at, 'last_outbound_at', last_out,
                                     'unanswered', latest_dir like 'in%'),
      'properties_in_window', props,
      'inbound', ev,
      'latest_outbound', lo,
      'lead', facts, 'decision_engine', score,
      'eligibility_inputs', jsonb_build_object('suppression_list', sup,
         'thread_flags', jsonb_build_object('is_suppressed', r.j->'is_suppressed', 'contactability_status', r.j->>'contactability_status',
                                            'opt_out', r.j->'opt_out', 'wrong_number', r.j->'wrong_number', 'paused', (r.j->>'status') = 'paused_review'),
         'opt_out_message_on_record', oo,
         'holds', hl, 'holds_available', has_holds),
      'cursor', jsonb_build_object('at', r.last_inbound_at, 'id', r.id));
  end loop;

  return jsonb_build_object('category', p_category, 'window_days', win, 'total', total,
                            'rows', rows_out, 'has_more', n > lim, 'as_of', pg_catalog.now());
end
$fn$;
comment on function public.lc_mcp_conversation_worklist(text, integer, text, timestamptz, uuid, integer) is 'LeadCommand MCP 1.1: a keyset page of inbox threads in one category (unanswered_inbound, recent_inbound, opted_out, identity_conflict), each verified against message_events, with its latest inbound texts (untrusted content) as evidence, lead labels, Decision Engine presence and suppression inputs; plus the exact category count. Never phones or thread keys. Read-only. Executable by lc_mcp_reader only.';

-- ------------------------------------------------------------ 3. exact lead counts ----
create or replace function public.lc_mcp_pipeline_counts(p_dimension text, p_market text, p_state text, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  lim integer := coalesce(p_limit, 25);
  total integer; nulls integer; groups jsonb; shown integer;
begin
  if p_dimension is null or p_dimension not in ('market', 'state', 'conversation_stage', 'conversation_status', 'pipeline_stage', 'pipeline_status', 'sms_status') then
    raise exception using errcode = '22023', message = 'lc_mcp_pipeline_counts: unknown dimension';
  end if;
  if lim < 1 or lim > 100 then raise exception using errcode = '22023', message = 'lc_mcp_pipeline_counts: limit must be 1..100'; end if;
  if (p_market is not null and length(p_market) > 60) or (p_state is not null and p_state !~ '^[A-Za-z]{2}$') then
    raise exception using errcode = '22023', message = 'lc_mcp_pipeline_counts: filter out of bounds';
  end if;
  with base as (
    select case p_dimension
             when 'market' then f.market
             when 'state' then to_jsonb(f)->>'property_address_state'
             when 'conversation_stage' then to_jsonb(f)->>'conversation_stage'
             when 'conversation_status' then to_jsonb(f)->>'conversation_status'
             when 'pipeline_stage' then to_jsonb(f)->>'pipeline_stage'
             when 'pipeline_status' then to_jsonb(f)->>'pipeline_status'
             when 'sms_status' then to_jsonb(f)->>'sms_status' end as g
      from public.eg_property_facts f
     where (p_market is null or f.market = p_market)
       and (p_state is null or upper(to_jsonb(f)->>'property_address_state') = upper(p_state))
  ), counted as (select b.g, count(*)::int as n from base b group by b.g)
  select (select coalesce(sum(c.n), 0)::int from counted c),
         (select coalesce(sum(c.n), 0)::int from counted c where c.g is null),
         (select coalesce(jsonb_agg(jsonb_build_object('value', x.g, 'n', x.n) order by x.n desc, x.g), '[]'::jsonb)
            from (select c.g, c.n from counted c where c.g is not null order by c.n desc, c.g limit lim) x),
         (select coalesce(sum(x.n), 0)::int from (select c.n from counted c where c.g is not null order by c.n desc, c.g limit lim) x)
    into total, nulls, groups, shown;
  return jsonb_build_object('dimension', p_dimension, 'total', total, 'not_set', nulls, 'groups', groups,
                            'other_groups_n', total - nulls - shown, 'as_of', pg_catalog.now());
end
$fn$;
comment on function public.lc_mcp_pipeline_counts(text, text, text, integer) is 'LeadCommand MCP 1.1: exact lead counts from eg_property_facts grouped by one dimension (market, state, conversation / pipeline stage and status, sms status), top N + remainder + not set. Read-only. Executable by lc_mcp_reader only.';

-- ------------------------------------------------------------ 4. conversation signals ----
create or replace function public.lc_mcp_conversation_signals(p_window_days integer, p_market text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  win integer := coalesce(p_window_days, 30);
  since timestamptz;
  threads jsonb; msgs jsonb; dup jsonb; scores jsonb;
begin
  if win < 1 or win > 365 then raise exception using errcode = '22023', message = 'lc_mcp_conversation_signals: window must be 1..365 days'; end if;
  if p_market is not null and length(p_market) > 60 then raise exception using errcode = '22023', message = 'lc_mcp_conversation_signals: market out of bounds'; end if;
  since := pg_catalog.now() - pg_catalog.make_interval(days => win);

  with t as (
    select s.*, to_jsonb(s) as j from public.inbox_thread_state s
      left join public.eg_property_facts f on f.property_id = s.property_id
     where s.last_inbound_at >= since and s.thread_key is not null and (p_market is null or f.market = p_market)
  )
  select jsonb_build_object(
      'with_inbound', count(*),
      'unanswered_inbound', count(*) filter (where (t.last_outbound_at is null or t.last_outbound_at < t.last_inbound_at)
                                                  and not coalesce((t.j->>'opt_out')::boolean, false)),
      'opted_out', count(*) filter (where coalesce((t.j->>'opt_out')::boolean, false) or (t.j->>'contactability_status') = 'opted_out'),
      'suppressed', count(*) filter (where coalesce((t.j->>'is_suppressed')::boolean, false)),
      'not_contactable', count(*) filter (where coalesce(t.j->>'contactability_status', 'contactable') <> 'contactable'),
      'without_property', count(*) filter (where t.property_id is null),
      -- suppression integrity: the opt-out record and the suppression list disagree
      'opt_out_without_active_suppression', count(*) filter (where (coalesce((t.j->>'opt_out')::boolean, false) or (t.j->>'contactability_status') = 'opted_out'
                                                  or exists (select 1 from public.message_events m where m.thread_key = t.thread_key and lower(m.direction) like 'in%' and m.is_opt_out is true))
                                                 and not exists (select 1 from public.sms_suppression_list x where (x.phone_e164 = t.thread_key or x.phone_number = t.thread_key) and coalesce(x.is_active, false))),
      'active_suppression_marked_contactable', count(*) filter (where coalesce(t.j->>'contactability_status', 'contactable') = 'contactable' and not coalesce((t.j->>'is_suppressed')::boolean, false)
                                                 and exists (select 1 from public.sms_suppression_list x where (x.phone_e164 = t.thread_key or x.phone_number = t.thread_key) and coalesce(x.is_active, false))))
    into threads from t;

  select jsonb_build_object(
      'inbound', count(*) filter (where lower(m.direction) like 'in%'),
      'inbound_opt_out', count(*) filter (where lower(m.direction) like 'in%' and m.is_opt_out is true),
      'inbound_unknown_sender', count(*) filter (where lower(m.direction) like 'in%' and m.thread_key is null),
      'outbound', count(*) filter (where lower(m.direction) like 'out%'))
    into msgs from public.message_events m
   where m.created_at >= since
     and (p_market is null or exists (select 1 from public.eg_property_facts f where f.property_id = m.property_id and f.market = p_market));

  select jsonb_build_object(
      'phones_on_several_properties', (select count(*) from (select g.canonical_e164 from public.campaign_target_graph g
                                         left join public.eg_property_facts f on f.property_id = g.property_id
                                        where g.canonical_e164 is not null and (p_market is null or f.market = p_market)
                                        group by g.canonical_e164 having count(distinct g.property_id) > 1) x),
      'threads_on_several_properties_in_window', (select count(*) from (select m.thread_key from public.message_events m
                                         where m.created_at >= since and m.thread_key is not null and m.property_id is not null
                                           and (p_market is null or exists (select 1 from public.eg_property_facts f where f.property_id = m.property_id and f.market = p_market))
                                         group by m.thread_key having count(distinct m.property_id) > 1) x))
    into dup;

  with leads as (
    select distinct s.property_id from public.inbox_thread_state s
      left join public.eg_property_facts f on f.property_id = s.property_id
     where s.last_inbound_at >= since and s.property_id is not null and (p_market is null or f.market = p_market)
  )
  select jsonb_build_object(
      'leads_in_conversation', count(*),
      'without_decision_engine', count(*) filter (where a.property_id is null),
      'decision_engine_older_than_30d', count(*) filter (where a.property_id is not null
                                                          and coalesce((to_jsonb(a)->>'computed_at')::timestamptz, '-infinity') < pg_catalog.now() - interval '30 days'))
    into scores from leads l left join public.property_acquisition_scores a on a.property_id = l.property_id;

  return jsonb_build_object('window_days', win, 'market', p_market, 'threads', threads, 'messages', msgs,
                            'identity', dup, 'decision_engine', scores, 'as_of', pg_catalog.now());
end
$fn$;
comment on function public.lc_mcp_conversation_signals(integer, text) is 'LeadCommand MCP 1.1: exact conversation and pipeline-integrity counts over a window (threads with inbound, unanswered, opted out, suppressed; inbound / opt-out / unknown-sender messages; phones on several properties; leads with no or stale Decision Engine score). Counts only. Read-only. Executable by lc_mcp_reader only.';

-- ------------------------------------------------------------ 5. grants + verification ----
revoke all on function public.lc_mcp_lead_conversation(text, uuid, integer, timestamptz, text, integer),
  public.lc_mcp_conversation_worklist(text, integer, text, timestamptz, uuid, integer),
  public.lc_mcp_pipeline_counts(text, text, text, integer),
  public.lc_mcp_conversation_signals(integer, text) from public, anon, authenticated, service_role;
grant execute on function public.lc_mcp_lead_conversation(text, uuid, integer, timestamptz, text, integer),
  public.lc_mcp_conversation_worklist(text, integer, text, timestamptz, uuid, integer),
  public.lc_mcp_pipeline_counts(text, text, text, integer),
  public.lc_mcp_conversation_signals(integer, text) to lc_mcp_reader;

do $$
declare
  -- lc-inventory:relations (unchanged: the 1.0 inventory)
  rels text[] := array['acquisition_opportunities','campaign_target_graph','campaign_targets','campaigns','census_geo_metrics','eg_buyer_index','eg_property_facts','emails','inbox_thread_state','master_owners','mi_geo_period_rollup','mi_rollup_builds','mv_map_market_sales','phones','preforeclosure_status_v2','probate_status','properties','property_acquisition_scores','prospects','sms_suppression_list'];
  -- lc-inventory:functions (the 1.0 functions + the four conversation intelligence reads)
  fns text[] := array['public.campaign_entity_contact_review_flags(text[])','public.entity_graph_property_records(text)','public.lc_mcp_action_center(uuid,text,boolean,uuid,integer)','public.lc_mcp_conversation_signals(integer,text)','public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)','public.lc_mcp_followup_intent_health()','public.lc_mcp_lead_conversation(text,uuid,integer,timestamp with time zone,text,integer)','public.lc_mcp_operator_role(uuid,uuid)','public.lc_mcp_ops_finding(uuid,text)','public.lc_mcp_ops_research_valuation_snapshot()','public.lc_mcp_pipeline_counts(text,text,text,integer)','public.lc_mcp_reader_self_check(text[],text[],name)','public.lc_mcp_thread_hold_status(uuid)'];
  rep jsonb;
begin
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if not coalesce((rep->>'ok')::boolean, false) then
    raise exception 'lc_mcp_conversation_intel: refused — the reader self-check reports %', rep->'findings';
  end if;
  raise notice 'lc_mcp_conversation_intel: self-check ok (% relations, % functions)', jsonb_array_length(rep->'relations'), jsonb_array_length(rep->'functions');
end
$$;
