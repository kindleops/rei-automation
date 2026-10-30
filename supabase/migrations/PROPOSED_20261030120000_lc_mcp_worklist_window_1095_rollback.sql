-- Rollback of PROPOSED_20261030120000_lc_mcp_worklist_window_1095.sql: lc_mcp_conversation_worklist refuses
-- windows over 365 days again (the definition from PROPOSED_20261026120000_lc_mcp_conversation_intel.sql).

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
