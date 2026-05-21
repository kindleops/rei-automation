-- ============================================================
-- NEXUS INBOX PRIORITY CLASSIFIER — SAFE APPLY MIGRATION
-- Split into independent sections; run each section separately
-- in Supabase SQL Editor if needed, or run entire file at once.
--
-- SECTION 1: CREATE OR REPLACE FUNCTION
-- SECTION 2: DROP + RECREATE VIEW
-- SECTION 3: REGRESSION CHECKS
-- SECTION 4: FINAL SPOT-CHECK QUERY
-- ============================================================


-- ============================================================
-- SECTION 1: FUNCTION
-- Run this block first on its own if the view create fails.
-- ============================================================

create or replace function public.nexus_inbox_priority_classify(
  latest_direction       text,
  latest_message_body    text,
  pending_queue_count    integer default 0,
  is_archived            boolean default false,
  has_opt_out            boolean default false,
  is_suppressed          boolean default false
)
returns table (
  normalized_body       text,
  ui_intent             text,
  priority_bucket       text,
  show_in_priority_inbox boolean
)
language sql
stable
as $$
with normalized as (
  select
    -- raw lowercase (preserves punctuation for numeric regex)
    lower(coalesce(latest_message_body, '')) as raw_body_lower,

    -- body_norm: strip non-alphanumeric (including emojis, punctuation, newlines),
    -- lowercase, collapse whitespace, trim
    lower(
      trim(
        regexp_replace(
          coalesce(latest_message_body, ''),
          '[^a-zA-Z0-9áéíóúüñÁÉÍÓÚÜÑ]+',
          ' ',
          'g'
        )
      )
    ) as body_norm,

    -- body_pad: padded version of body_norm for safe phrase boundary matching
    (
      ' '
      || lower(
        trim(
          regexp_replace(
            coalesce(latest_message_body, ''),
            '[^a-zA-Z0-9áéíóúüñÁÉÍÓÚÜÑ]+',
            ' ',
            'g'
          )
        )
      )
      || ' '
    ) as body_pad
),
classify as (
  select
    n.body_norm as normalized_body,
    case

      -- -------------------------------------------------------
      -- A) Non-inbound: outbound_waiting
      --    Catches 'outbound', NULL, empty, anything not 'inbound'
      -- -------------------------------------------------------
      when lower(coalesce(latest_direction, '')) is distinct from 'inbound'
        then 'outbound_waiting'

      -- -------------------------------------------------------
      -- B) Hostile / legal / harassment / profanity
      --    Run BEFORE opt_out so combined messages get hostile label
      -- -------------------------------------------------------
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
        or n.body_pad like '% threatening %'
        or n.body_pad like '% threaten %'
        then 'hostile_or_legal'

      -- -------------------------------------------------------
      -- C) Opt-out / DNC / stop / remove
      --    body_pad ensures "stop" at start/end of normalized msg
      --    is caught without anchoring issues.
      -- -------------------------------------------------------
      when coalesce(has_opt_out, false)
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
        or n.body_pad like '% do not text or call %'
        or n.body_pad like '% dont text or call %'
        or n.body_pad like '% don t text or call %'
        or n.body_pad like '% text or call me again %'
        or n.body_pad like '% stop texting %'
        or n.body_pad like '% stop asking %'
        or n.body_pad like '% stop call %'
        or n.body_pad like '% stop calling %'
        or n.body_pad like '% nfs stop %'
        or n.body_pad like '% no thank you don t text %'
        or n.body_pad like '% no thank you dont text %'
        or n.body_pad like '% elimíname %'
        or n.body_pad like '% eliminame %'
        or n.body_pad like '% no me textees %'
        or n.body_pad like '% no me contactes %'
        then 'opt_out'

      -- -------------------------------------------------------
      -- D) Wrong person / wrong number
      -- -------------------------------------------------------
      when n.body_pad like '% wrong number %'
        or n.body_pad like '% wrong person %'
        or n.body_pad like '% not joshua %'
        or n.body_pad like '% not lisa %'
        or n.body_pad like '% this is not %'
        or n.body_pad like '% no soy %'
        or n.body_pad like '% equivocado %'
        or n.body_pad like '% numero equivocado %'
        then 'wrong_person'

      -- -------------------------------------------------------
      -- E) Not interested / not for sale / NFS
      -- -------------------------------------------------------
      when n.body_norm in ('no', 'nope')
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
        then 'not_interested'

      -- -------------------------------------------------------
      -- F) Price anchor
      --    Uses raw_body_lower for comma/period thousand separators
      --    Uses body_norm for space-separated and k/million forms
      -- -------------------------------------------------------
      when n.raw_body_lower ~ '(^| )\$?\d{1,3}([.,]\d{3})+( |$)'
        or n.body_norm ~ '(^| )\d{1,3} \d{3}( |$)'
        or n.body_norm ~ '(^| )\d+(\.\d+)? *(k|m|million)( |$)'
        or n.body_norm ~ '(^| )\d{6,8}( |$)'
        then 'price_anchor'

      -- -------------------------------------------------------
      -- G) Language switch
      -- -------------------------------------------------------
      when n.body_pad like '% english %'
        or n.body_pad like '% espanol %'
        or n.body_pad like '% español %'
        or n.body_pad like '% spanish %'
        then 'language_switch'

      -- -------------------------------------------------------
      -- H) Info request
      -- -------------------------------------------------------
      when n.body_pad like '% who are you %'
        or n.body_pad like '% who is this %'
        or n.body_pad like '% quien eres %'
        or n.body_pad like '% como encontraste %'
        or n.body_pad like '% how did you get my info %'
        or n.body_pad like '% why are you texting %'
        or n.body_pad like '% what company %'
        then 'info_request'

      -- -------------------------------------------------------
      -- I) Positive / potential interest
      -- -------------------------------------------------------
      when n.body_norm in ('yes', 'si', 'ok', 'okay')
        or n.body_pad like '% i do %'
        or n.body_pad like '% how can i help %'
        or n.body_pad like '% interested in selling %'
        or n.body_pad like '% i m interested %'
        or n.body_pad like '% i am interested %'
        then 'potential_interest'

      -- -------------------------------------------------------
      -- J) Fallback
      -- -------------------------------------------------------
      else 'needs_review'

    end as ui_intent
  from normalized n
),
buckets as (
  select
    c.normalized_body,
    c.ui_intent,
    case
      when c.ui_intent = 'outbound_waiting' then
        case when coalesce(pending_queue_count, 0) > 0 then 'queued' else 'normal' end
      when c.ui_intent in ('opt_out', 'hostile_or_legal') then 'suppressed'
      when c.ui_intent in ('wrong_person', 'not_interested') then 'hidden'
      else 'priority'
    end as priority_bucket,
    case
      when c.ui_intent in (
        'outbound_waiting', 'opt_out', 'hostile_or_legal',
        'wrong_person', 'not_interested'
      ) then false
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
    and lower(coalesce(latest_direction, '')) = 'inbound'
    and b.ui_intent not in (
      'opt_out', 'hostile_or_legal', 'wrong_person', 'not_interested'
    )
    and not coalesce(is_archived, false)
    and not coalesce(is_suppressed, false)
    and not coalesce(has_opt_out, false)
  ) as show_in_priority_inbox
from buckets b;
$$;


-- ============================================================
-- SECTION 2: VIEW — DROP + CREATE
--
-- NOTE: If any of the following dependent views exist in your
-- Supabase project, they must be dropped and recreated after
-- this block runs:
--   - nexus_thread_intelligence_v
--   - nexus_activity_feed_v
--   - any other nexus_* view selecting from nexus_inbox_threads_v
--
-- Use CREATE OR REPLACE VIEW for those dependents after this block.
-- ============================================================

drop view if exists public.nexus_thread_intelligence_v;
drop view if exists public.nexus_activity_feed_v;
drop view if exists public.nexus_inbox_threads_v;

create view public.nexus_inbox_threads_v as
with message_base as (
  select
    me.id,
    coalesce(me.event_timestamp, me.created_at)                          as message_ts,
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
    nullif(
      coalesce(
        me.canonical_e164,
        me.seller_phone,
        case
          when me.direction = 'inbound' then me.from_phone_number
          else me.to_phone_number
        end
      ), ''
    ) as seller_phone_key,
    nullif(
      coalesce(
        me.our_number,
        case
          when me.direction = 'inbound' then me.to_phone_number
          else me.from_phone_number
        end
      ), ''
    ) as our_number_key,
    case
      when nullif(
        coalesce(
          me.canonical_e164, me.seller_phone,
          case when me.direction = 'inbound' then me.from_phone_number else me.to_phone_number end
        ), ''
      ) is not null
        then 'phone:' || nullif(
          coalesce(
            me.canonical_e164, me.seller_phone,
            case when me.direction = 'inbound' then me.from_phone_number else me.to_phone_number end
          ), ''
        )
      when nullif(me.master_owner_id, '') is not null then 'owner:'    || me.master_owner_id
      when nullif(me.prospect_id, '')     is not null then 'prospect:' || me.prospect_id
      when nullif(me.property_id, '')     is not null then 'property:' || me.property_id
      else 'event:' || me.id::text
    end as thread_key
  from public.message_events me
),
ranked as (
  select
    mb.*,
    row_number() over (
      partition by mb.thread_key
      order by mb.message_ts desc, mb.id desc
    ) as rn
  from message_base mb
),
latest as (
  select
    r.thread_key,
    r.message_ts          as latest_message_at,
    r.direction           as latest_direction,
    r.message_body        as latest_message_body,
    r.is_opt_out          as latest_is_opt_out,
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
),
thread_rollup as (
  select
    mb.thread_key,
    count(*) filter (where mb.direction = 'inbound')  as inbound_message_count,
    count(*) filter (where mb.direction = 'outbound') as outbound_message_count,
    count(*) filter (
      where mb.direction = 'outbound'
        and lower(coalesce(mb.delivery_status, '')) in ('queued', 'pending', 'scheduled')
    )                                                 as pending_queue_count,
    max(mb.message_ts)                                as last_message_at
  from message_base mb
  group by mb.thread_key
)
select
  l.thread_key,
  l.latest_message_at,
  l.latest_direction,
  l.latest_message_body,
  c.normalized_body                                   as latest_message_body_normalized,
  l.seller_phone_key                                  as seller_phone,
  l.our_number_key                                    as our_number,
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
  end                                                 as status,
  case
    when c.ui_intent in ('opt_out', 'hostile_or_legal') then 'dnc_opt_out'
    else coalesce(nullif(ts.stage, ''), 'needs_response')
  end                                                 as stage,
  c.show_in_priority_inbox,
  coalesce(ts.is_archived, false)                     as is_archived,
  coalesce(ts.is_read, false)                         as is_read,
  coalesce(ts.is_pinned, false)                       as is_pinned,
  coalesce(
    ts.priority,
    case
      when c.priority_bucket = 'priority' then 'high'
      else 'normal'
    end
  )                                                   as thread_priority,
  ts.updated_at                                       as state_updated_at
from latest l
join   thread_rollup tr on tr.thread_key = l.thread_key
left join public.inbox_thread_state ts on ts.thread_key = l.thread_key
cross join lateral public.nexus_inbox_priority_classify(
  l.latest_direction,
  l.latest_message_body,
  tr.pending_queue_count,
  coalesce(ts.is_archived, false) or lower(coalesce(ts.status, '')) = 'archived',
  coalesce(l.latest_is_opt_out, false),
  lower(coalesce(ts.status, '')) = 'suppressed'
    or lower(coalesce(ts.stage,  '')) = 'dnc_opt_out'
) c;


-- ============================================================
-- SECTION 3: REGRESSION ASSERTIONS
-- Runs inline via function call; raises exception on mismatch.
-- Safe to skip or run separately.
-- ============================================================

do $$
declare
  v_failures jsonb;
begin
  with cases (label, dir, body, exp_intent, exp_bucket, exp_show) as (
    values
      ('STOP emoji',
       'inbound', 'STOP 🛑',
       'opt_out', 'suppressed', false),

      ('Please stop texting',
       'inbound', 'Please stop texting me.',
       'opt_out', 'suppressed', false),

      ('Please stop punctuated',
       'inbound', 'Please stop!!!!',
       'opt_out', 'suppressed', false),

      ('Stop asking',
       'inbound', 'Stop asking',
       'opt_out', 'suppressed', false),

      ('Stop + harassment + remove',
       'inbound', 'Please stop this is harassment please stop remove my name please stop',
       'hostile_or_legal', 'suppressed', false),

      ('STOP FUCKING',
       'inbound', 'STOP FUCKING TEXTUNG AND CALLING ME',
       'hostile_or_legal', 'suppressed', false),

      ('Multiline stop no-thanks',
       'inbound', E'Stop\n\nNo thank you. Don''t text or call me again',
       'opt_out', 'suppressed', false),

      ('NFS Stop',
       'inbound', 'NFS. Stop',
       'opt_out', 'suppressed', false),

      ('Stop call typo phrase',
       'inbound', 'No, it''s not for seal stop call, let''s start text.No',
       'opt_out', 'suppressed', false),

      ('English language switch',
       'inbound', 'English',
       'language_switch', 'priority', true),

      ('750 k price anchor',
       'inbound', '750 k ,',
       'price_anchor', 'priority', true),

      ('Wrong number',
       'inbound', 'Wrong number.',
       'wrong_person', 'hidden', false),

      ('Not interested in selling',
       'inbound', 'Yes its mine im not interested in selling',
       'not_interested', 'hidden', false),

      ('How can I help you',
       'inbound', 'How can I help you?',
       'potential_interest', 'priority', true),

      ('Outbound waiting',
       'outbound', 'Do you own this property?',
       'outbound_waiting', 'normal', false)
  ),
  evaluated as (
    select
      c.label,
      f.ui_intent,
      f.priority_bucket,
      f.show_in_priority_inbox,
      c.exp_intent,
      c.exp_bucket,
      c.exp_show
    from cases c
    cross join lateral public.nexus_inbox_priority_classify(
      c.dir, c.body, 0, false, false, false
    ) f
  ),
  mismatches as (
    select *
    from evaluated
    where ui_intent       <> exp_intent
       or priority_bucket <> exp_bucket
       or show_in_priority_inbox is distinct from exp_show
  )
  select jsonb_agg(to_jsonb(m.*))
  into v_failures
  from mismatches m;

  if v_failures is not null then
    raise exception 'nexus_inbox_priority_classify regression failures: %', v_failures;
  end if;

  raise notice 'All regression checks passed.';
end $$;


-- ============================================================
-- SECTION 4: FINAL SPOT-CHECK
-- Paste and run this line alone to confirm function is live:
-- ============================================================

select * from public.nexus_inbox_priority_classify('inbound', 'STOP 🛑', 0, false, false, false);
