-- Rebuild Inbox Truth: Hydrated Views and Deduplication

-- 1. Create a view to dedupe message events
create or replace view public.deduped_message_events as
with ranked_messages as (
  select
    *,
    row_number() over (
      partition by coalesce(queue_id, id::text)
      order by
        case
          when delivery_status in ('delivered', 'sent') then 1
          when delivery_status in ('queued', 'pending', 'scheduled') then 2
          when delivery_status = 'failed' then 3
          else 4
        end,
        event_timestamp desc
    ) as rn
  from public.message_events
)
select *
from ranked_messages
where rn = 1;

-- 2. Update nexus_inbox_threads_v to use deduped messages and include counts
create or replace view public.nexus_inbox_threads_v as
with message_base as (
  select
    me.id,
    coalesce(me.event_timestamp, me.created_at) as message_ts,
    me.created_at,
    me.direction,
    me.message_body,
    me.delivery_status,
    me.is_opt_out,
    me.master_owner_id,
    me.prospect_id,
    me.property_id,
    me.market,
    me.market_id,
    me.property_address,
    nullif(coalesce(me.canonical_e164, me.seller_phone,
      case when me.direction = 'inbound' then me.from_phone_number else me.to_phone_number end), '') as seller_phone_key,
    nullif(coalesce(me.our_number,
      case when me.direction = 'inbound' then me.to_phone_number else me.from_phone_number end), '') as our_number_key,
    case
      when nullif(coalesce(me.canonical_e164, me.seller_phone,
        case when me.direction = 'inbound' then me.from_phone_number else me.to_phone_number end), '') is not null
      then 'phone:' || nullif(coalesce(me.canonical_e164, me.seller_phone,
        case when me.direction = 'inbound' then me.from_phone_number else me.to_phone_number end), '')
      when nullif(me.master_owner_id, '') is not null then 'owner:' || me.master_owner_id
      when nullif(me.prospect_id, '') is not null then 'prospect:' || me.prospect_id
      when nullif(me.property_id, '') is not null then 'property:' || me.property_id
      else 'event:' || me.id::text
    end as thread_key
  from public.deduped_message_events me
), thread_rollup as (
  select
    mb.thread_key,
    count(*) as message_count,
    count(*) filter (where mb.direction = 'inbound') as inbound_count,
    count(*) filter (where mb.direction = 'outbound') as outbound_count,
    count(*) filter (
      where mb.direction = 'outbound'
        and lower(coalesce(mb.delivery_status, '')) in ('queued', 'pending', 'scheduled')
    ) as pending_queue_count,
    max(mb.message_ts) as latest_message_at,
    max(mb.message_ts) filter (where mb.direction = 'inbound') as last_inbound_at,
    max(mb.message_ts) filter (where mb.direction = 'outbound') as last_outbound_at
  from message_base mb
  group by mb.thread_key
), latest_msg as (
  select distinct on (mb.thread_key)
    mb.thread_key,
    mb.direction as latest_direction,
    mb.message_body as latest_message_body,
    mb.is_opt_out as latest_is_opt_out,
    mb.seller_phone_key as seller_phone,
    mb.our_number_key as our_number,
    mb.master_owner_id,
    mb.prospect_id,
    mb.property_id,
    mb.market,
    mb.market_id,
    mb.property_address
  from message_base mb
  order by mb.thread_key, mb.message_ts desc, mb.id desc
)
select
  l.thread_key,
  tr.latest_message_at,
  l.latest_direction,
  l.latest_message_body,
  l.seller_phone,
  l.our_number,
  l.master_owner_id,
  l.prospect_id,
  l.property_id,
  coalesce(nullif(l.market, ''), nullif(l.market_id, ''), 'unknown') as market,
  l.property_address,
  tr.message_count,
  tr.inbound_count,
  tr.outbound_count,
  tr.pending_queue_count,
  tr.last_inbound_at,
  tr.last_outbound_at,
  -- Unread count calculation
  (
    select count(*)
    from message_base mb2
    where mb2.thread_key = l.thread_key
      and mb2.direction = 'inbound'
      and (ts.last_read_at is null or mb2.message_ts > ts.last_read_at)
  ) as unread_count,
  c.ui_intent,
  c.priority_bucket,
  case
    when c.ui_intent in ('opt_out', 'hostile_or_legal') then 'suppressed'
    else coalesce(nullif(ts.status, ''), 'open')
  end as status,
  case
    when c.ui_intent in ('opt_out', 'hostile_or_legal') then 'dnc_opt_out'
    else coalesce(nullif(ts.stage, ''), 'needs_response')
  end as stage,
  c.show_in_priority_inbox as show_in_priority_inbox,
  coalesce(ts.is_archived, false) as is_archived,
  coalesce(ts.is_read, false) as is_read,
  coalesce(ts.is_pinned, false) as is_pinned,
  coalesce(ts.priority,
    case
      when c.priority_bucket = 'priority' then 'high'
      when c.priority_bucket = 'queued' then 'normal'
      else 'normal'
    end
  ) as thread_priority,
  ts.updated_at as state_updated_at
from latest_msg l
join thread_rollup tr
  on tr.thread_key = l.thread_key
left join public.inbox_thread_state ts
  on ts.thread_key = l.thread_key
cross join lateral public.nexus_inbox_priority_classify(
  l.latest_direction,
  l.latest_message_body,
  tr.pending_queue_count,
  coalesce(ts.is_archived, false) or lower(coalesce(ts.status, '')) = 'archived',
  lower(coalesce(ts.status, '')) = 'suppressed' or lower(coalesce(ts.stage, '')) = 'dnc_opt_out',
  coalesce(l.latest_is_opt_out, false)
) c;

-- 3. Create inbox_threads_hydrated view
create or replace view public.inbox_threads_hydrated as
select
  nt.*,
  p.property_address_full,
  p.property_type,
  p.estimated_value,
  p.cash_offer,
  p.final_acquisition_score,
  p.structured_motivation_score as priority_score,
  mo.display_name as owner_name,
  mo.owner_type_guess as owner_type,
  pr.first_name as prospect_first_name,
  pr.last_name as prospect_last_name,
  -- Map categories for easier filtering
  case
    when nt.show_in_priority_inbox then 'hot_leads'
    when nt.stage = 'needs_response' then 'new_inbound'
    when nt.priority_bucket = 'suppressed' then 'dnc_opt_out'
    when nt.priority_bucket = 'hidden' then 'cold_no_response'
    when nt.outbound_count > 0 and nt.inbound_count = 0 then 'outbound_active'
    else 'automated'
  end as inbox_category
from public.nexus_inbox_threads_v nt
left join public.properties p on p.property_id::text = nt.property_id
left join public.master_owners mo on mo.master_owner_id::text = nt.master_owner_id
left join public.prospects pr on pr.prospect_id::text = nt.prospect_id;

-- 4. Create inbox_chat_timeline_hydrated view
create or replace view public.inbox_chat_timeline_hydrated as
select
  me.*,
  case
    when nullif(coalesce(me.canonical_e164, me.seller_phone,
      case when me.direction = 'inbound' then me.from_phone_number else me.to_phone_number end), '') is not null
    then 'phone:' || nullif(coalesce(me.canonical_e164, me.seller_phone,
      case when me.direction = 'inbound' then me.from_phone_number else me.to_phone_number end), '')
    when nullif(me.master_owner_id, '') is not null then 'owner:' || me.master_owner_id
    when nullif(me.prospect_id, '') is not null then 'prospect:' || me.prospect_id
    when nullif(me.property_id, '') is not null then 'property:' || me.property_id
    else 'event:' || me.id::text
  end as thread_key
from public.deduped_message_events me;

-- 5. Create inbox_category_counts view
create or replace view public.inbox_category_counts as
select
  inbox_category,
  count(*) as count
from public.inbox_threads_hydrated
group by inbox_category;

-- 6. Update inbox_threads_hydrated to include new columns from state
create or replace view public.inbox_threads_hydrated as
select
  nt.*,
  ts.automation_status,
  ts.follow_up_at,
  ts.agent_id,
  ts.persona_id,
  ts.is_hot_lead,
  p.property_address_full,
  p.property_type,
  p.estimated_value,
  p.cash_offer,
  p.final_acquisition_score,
  p.structured_motivation_score as priority_score,
  p.city as property_city,
  p.state as property_state,
  p.zip_code as property_zip,
  mo.display_name as owner_name,
  mo.owner_type_guess as owner_type,
  pr.first_name as prospect_first_name,
  pr.last_name as prospect_last_name,
  -- Map categories for easier filtering
  case
    when nt.show_in_priority_inbox or ts.is_hot_lead then 'hot_leads'
    when nt.stage = 'needs_response' then 'new_inbound'
    when nt.stage = 'dnc_opt_out' or nt.status = 'suppressed' then 'dnc_opt_out'
    when nt.priority_bucket = 'hidden' then 'cold_no_response'
    when nt.outbound_count > 0 and nt.inbound_count = 0 then 'outbound_active'
    else 'automated'
  end as inbox_category
from public.nexus_inbox_threads_v nt
left join public.inbox_thread_state ts on ts.thread_key = nt.thread_key
left join public.properties p on p.property_id::text = nt.property_id
left join public.master_owners mo on mo.master_owner_id::text = nt.master_owner_id
left join public.prospects pr on pr.prospect_id::text = nt.prospect_id;
