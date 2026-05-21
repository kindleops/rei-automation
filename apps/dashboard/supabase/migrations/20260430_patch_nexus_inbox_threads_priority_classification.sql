-- Patch: deterministic inbox priority classification for UI
-- Scope: nexus_inbox_threads_v intent/priority/show_in_priority_inbox behavior

create or replace function public.nexus_inbox_priority_classify(
  p_latest_direction text,
  p_latest_message_body text,
  p_pending_queue_count integer,
  p_is_archived_thread boolean,
  p_is_suppressed_thread boolean,
  p_latest_is_opt_out boolean
)
returns table (
  normalized_body text,
  ui_intent text,
  priority_bucket text,
  show_in_priority_inbox boolean
)
language sql
stable
as $$
with normalized as (
  select
    lower(coalesce(p_latest_message_body, '')) as raw_body_lower,
    lower(
      trim(
        regexp_replace(
          coalesce(p_latest_message_body, ''),
          '[^a-z0-9áéíóúüñ]+',
          ' ',
          'gi'
        )
      )
    ) as body_norm,
    (
      ' '
      || lower(
        trim(
          regexp_replace(
            coalesce(p_latest_message_body, ''),
            '[^a-z0-9áéíóúüñ]+',
            ' ',
            'gi'
          )
        )
      )
      || ' '
    ) as body_pad,
    array_remove(
      regexp_split_to_array(
        lower(
          trim(
            regexp_replace(
              coalesce(p_latest_message_body, ''),
              '[^a-z0-9áéíóúüñ]+',
              ' ',
              'gi'
            )
          )
        ),
        '\s+'
      ),
      ''
    ) as body_words
), classify as (
  select
    n.body_norm as normalized_body,
    case
      -- A) outbound first
      when lower(coalesce(p_latest_direction, '')) is distinct from 'inbound' then 'outbound_waiting'

      -- B) hostile/legal before opt-out when both are present.
      when n.body_pad like '% harassment %'
        or n.body_pad like '% lawyer %'
        or n.body_pad like '% attorney %'
        or n.body_pad like '% legal %'
        or n.body_pad like '% lawsuit %'
        or n.body_pad like '% sue %'
        or n.body_pad like '% report you %'
        or n.body_pad like '% fucking %'
        or n.body_pad like '% fuck %'
        or n.body_pad like '% scam %'
        or n.body_pad like '% scumbag %'
      then 'hostile_or_legal'

      -- C) opt out / DNC (must run before not_interested and needs_review)
      when coalesce(p_latest_is_opt_out, false)
        or n.body_pad like '% stop %'
        or n.body_pad like '% unsubscribe %'
        or n.body_pad like '% remove me %'
        or n.body_pad like '% remove my name %'
        or n.body_pad like '% take me off %'
        or n.body_pad like '% do not text %'
        or n.body_pad like '% dont text %'
        or n.body_pad like '% don t text %'
        or n.body_pad like '% do not call %'
        or n.body_pad like '% dont call %'
        or n.body_pad like '% don t call %'
        or n.body_pad like '% text or call me again %'
        or n.body_pad like '% don t text or call %'
        or n.body_pad like '% do not text or call %'
        or n.body_pad like '% stop texting %'
        or n.body_pad like '% stop asking %'
        or n.body_pad like '% stop call %'
        or n.body_pad like '% stop calling %'
        or n.body_pad like '% nfs stop %'
        or n.body_pad like '% no thank you don t text %'
        or n.body_pad like '% no thank you dont text %'
        or n.body_pad like '% elimíname %'
        or n.body_pad like '% no me textees %'
        or n.body_pad like '% eliminame %'
        or n.body_pad like '% no me contactes %'
      then 'opt_out'

      -- D) wrong person / wrong number
      when n.body_pad like '% wrong number %'
        or n.body_pad like '% wrong person %'
        or n.body_pad like '% not joshua %'
        or n.body_pad like '% not lisa %'
        or n.body_pad like '% this is not %'
        or n.body_pad like '% no soy %'
        or n.body_pad like '% equivocado %'
        or n.body_pad like '% numero equivocado %'
      then 'wrong_person'

      -- E) not interested
      when (
        n.body_norm in ('no', 'nope')
        or n.body_pad like '% not interested %'
        or n.body_pad like '% not for sale %'
        or n.body_pad like '% nfs %'
        or n.body_pad like '% no thank you %'
        or n.body_pad like '% yes but not interested %'
        or n.body_pad like '% yes i do but not interested %'
        or n.body_pad like '% yes its mine im not interested %'
        or n.body_pad like '% not interested in selling %'
        or n.body_pad like '% not interested on selling %'
        or n.body_pad like '% i m not interested %'
        or n.body_pad like '% none of my properties are for sale %'
        or n.body_pad like '% no vendo %'
        or n.body_pad like '% no estoy interesado %'
        or n.body_pad like '% no i don t %'
        or n.body_pad like '% no i dont %'
      )
      then 'not_interested'

      -- F) info request / who are you
      when n.body_pad like '% who are you %'
        or n.body_pad like '% who is this %'
        or n.body_pad like '% quien eres %'
        or n.body_pad like '% q carlos eres %'
        or n.body_pad like '% como encontraste %'
        or n.body_pad like '% how did you get my info %'
        or n.body_pad like '% why are you texting %'
        or n.body_pad like '% what company %'
      then 'info_request'

      -- G) language switch
      when n.body_pad like '% english %'
        or n.body_pad like '% espanol %'
        or n.body_pad like '% spanish %'
      then 'language_switch'

      -- H) price anchor
      when n.raw_body_lower ~ '(^| )\$?\d{1,3}([.,]\d{3})+( |$)'
        or n.body_norm ~ '(^| )\d{1,3} \d{3}( |$)'
        or n.body_norm ~ '(^| )\d+(\.\d+)? *(k|m|million)( |$)'
        or n.body_norm ~ '(^| )\d{6,8}( |$)'
      then 'price_anchor'

      -- I) potential interest
      when n.body_norm in ('yes', 'si', 'ok', 'okay')
        or n.body_pad like '% i do %'
        or n.body_pad like '% how can i help %'
        or n.body_pad like '% co gi %'
      then 'potential_interest'

      -- J) fallback inbound
      else 'needs_review'
    end as ui_intent
  from normalized n
), buckets as (
  select
    c.normalized_body,
    c.ui_intent,
    case
      when c.ui_intent = 'outbound_waiting' then
        case when coalesce(p_pending_queue_count, 0) > 0 then 'queued' else 'normal' end
      when c.ui_intent in ('opt_out', 'hostile_or_legal') then 'suppressed'
      when c.ui_intent in ('wrong_person', 'not_interested') then 'hidden'
      else 'priority'
    end as priority_bucket,
    case
      when c.ui_intent = 'outbound_waiting' then false
      when c.ui_intent in ('opt_out', 'hostile_or_legal', 'wrong_person', 'not_interested') then false
      else true
    end as show_base
  from classify c
)
select
  b.normalized_body,
  b.ui_intent,
  b.priority_bucket,
  (
    b.show_base
    and lower(coalesce(p_latest_direction, '')) = 'inbound'
    and b.ui_intent not in ('opt_out', 'hostile_or_legal', 'wrong_person', 'not_interested')
    and not coalesce(p_is_archived_thread, false)
    and not coalesce(p_is_suppressed_thread, false)
    and not coalesce(p_latest_is_opt_out, false)
  ) as show_in_priority_inbox
from buckets b;
$$;

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
  from public.message_events me
), ranked as (
  select
    mb.*,
    row_number() over (partition by mb.thread_key order by mb.message_ts desc, mb.id desc) as rn
  from message_base mb
), latest as (
  select
    r.thread_key,
    r.message_ts as latest_message_at,
    r.direction as latest_direction,
    r.message_body as latest_message_body,
    r.is_opt_out as latest_is_opt_out,
    r.seller_phone_key,
    r.our_number_key,
    r.master_owner_id,
    r.prospect_id,
    r.property_id,
    r.market,
    r.market_id,
    r.property_address
  from ranked r
  where r.rn = 1
), thread_rollup as (
  select
    mb.thread_key,
    count(*) filter (where mb.direction = 'inbound') as inbound_message_count,
    count(*) filter (where mb.direction = 'outbound') as outbound_message_count,
    count(*) filter (
      where mb.direction = 'outbound'
        and lower(coalesce(mb.delivery_status, '')) in ('queued', 'pending', 'scheduled')
    ) as pending_queue_count,
    max(mb.message_ts) as last_message_at
  from message_base mb
  group by mb.thread_key
)
select
  l.thread_key,
  l.latest_message_at,
  l.latest_direction,
  l.latest_message_body,
  c.normalized_body as latest_message_body_normalized,
  l.seller_phone_key as seller_phone,
  l.our_number_key as our_number,
  l.master_owner_id,
  l.prospect_id,
  l.property_id,
  coalesce(nullif(l.market, ''), nullif(l.market_id, ''), 'unknown') as market,
  l.property_address,
  tr.inbound_message_count,
  tr.outbound_message_count,
  tr.pending_queue_count,
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
from latest l
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

-- Regression checks for intent/priority classification.
do $$
declare
  failures jsonb;
begin
  with cases as (
    select *
    from (values
      ('STOP emoji', 'inbound', 'STOP 🛑', 0, false, false, false, 'opt_out', 'suppressed', false),
      ('Please stop texting', 'inbound', 'Please stop texting me.', 0, false, false, false, 'opt_out', 'suppressed', false),
      ('Please stop punctuated', 'inbound', 'Please stop!!!!', 0, false, false, false, 'opt_out', 'suppressed', false),
      ('Stop asking', 'inbound', 'Stop asking', 0, false, false, false, 'opt_out', 'suppressed', false),
      ('Stop + harassment + remove', 'inbound', 'Please stop this is harassment please stop remove my name please stop', 0, false, false, false, 'hostile_or_legal', 'suppressed', false),
      ('STOP FUCKING', 'inbound', 'STOP FUCKING TEXTUNG AND CALLING ME', 0, false, false, false, 'hostile_or_legal', 'suppressed', false),
      ('Multiline stop no-thanks', 'inbound', E'Stop\n\nNo thank you. Don''t text or call me again', 0, false, false, false, 'opt_out', 'suppressed', false),
      ('NFS Stop', 'inbound', 'NFS. Stop', 0, false, false, false, 'opt_out', 'suppressed', false),
      ('Stop call typo phrase', 'inbound', 'No, it''s not for seal stop call, let''s start text.No', 0, false, false, false, 'opt_out', 'suppressed', false),
      ('Spanish remove accented', 'inbound', 'No elimíname de tu lista', 0, false, false, false, 'opt_out', 'suppressed', false),
      ('Outbound waiting normal', 'outbound', 'Do you own this property?', 0, false, false, false, 'outbound_waiting', 'normal', false),
      ('Language switch English', 'inbound', 'English', 0, false, false, false, 'language_switch', 'priority', true),
      ('Price anchor spaced k', 'inbound', '750 k ,', 0, false, false, false, 'price_anchor', 'priority', true),
      ('Potential interest help', 'inbound', 'How can I help you?', 0, false, false, false, 'potential_interest', 'priority', true),
      ('Wrong number hidden', 'inbound', 'Wrong number.', 0, false, false, false, 'wrong_person', 'hidden', false),
      ('Mine not interested selling', 'inbound', 'Yes its mine im not interested in selling', 0, false, false, false, 'not_interested', 'hidden', false)
    ) as t(label, latest_direction, body, pending_count, is_archived, is_suppressed, latest_is_opt_out, expected_intent, expected_bucket, expected_show)
  ), evaluated as (
    select
      c.label,
      f.ui_intent,
      f.priority_bucket,
      f.show_in_priority_inbox,
      c.expected_intent,
      c.expected_bucket,
      c.expected_show
    from cases c
    cross join lateral public.nexus_inbox_priority_classify(
      c.latest_direction,
      c.body,
      c.pending_count,
      c.is_archived,
      c.is_suppressed,
      c.latest_is_opt_out
    ) f
  ), mismatches as (
    select
      label,
      expected_intent,
      ui_intent,
      expected_bucket,
      priority_bucket,
      expected_show,
      show_in_priority_inbox
    from evaluated
    where ui_intent <> expected_intent
       or priority_bucket <> expected_bucket
       or show_in_priority_inbox is distinct from expected_show
  )
  select jsonb_agg(to_jsonb(m.*))
  into failures
  from mismatches m;

  if failures is not null then
    raise exception 'nexus_inbox_priority_classify regression failure: %', failures;
  end if;
end $$;