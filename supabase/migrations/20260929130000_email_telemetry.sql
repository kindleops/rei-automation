-- EMAIL TELEMETRY + ENGAGEMENT ATTRIBUTION.
--
-- LeadCommand owns the permanent email history. Providers (Brevo first) are
-- adapters that translate their events into this ledger; replacing a
-- provider never touches history.
--
--   email_events            = the canonical, APPEND-ONLY event ledger. One row
--                             per fact ("open signal at 09:41"), never a
--                             mutable flag. Replays dedupe on event_key.
--   email_links             = tracked destinations, recorded at send time; the
--                             click redirect only ever goes to a stored URL
--                             (never an open redirect).
--   email_message_engagement / email_address_health /
--   email_touch_attribution  = DERIVED read models (views over the ledger).
--   email_metrics(...)      = server-side aggregation for Campaign Command /
--                             Analytics by campaign/template/sender/domain/
--                             lane/market, with explicit unique-vs-total.

-- ── lineage on the outbound message ────────────────────────────────────────
alter table public.email_queue
  add column if not exists lane text,
  add column if not exists origin text not null default 'automation',
  add column if not exists sending_domain text,
  add column if not exists provider text not null default 'brevo',
  add column if not exists campaign_id text,
  add column if not exists campaign_target_id text,
  add column if not exists sequence_id text,
  add column if not exists sequence_step integer,
  add column if not exists template_version text,
  add column if not exists subject_version text,
  add column if not exists opportunity_id uuid,
  add column if not exists closing_case_id text,
  add column if not exists buyer_id text,
  add column if not exists title_company_id text,
  add column if not exists tracking_token text;
do $$ begin
  alter table public.email_queue add constraint email_queue_lane_check
    check (lane is null or lane in ('acquisition','seller_conversation','transactional','closing','buyer','system','manual'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.email_queue add constraint email_queue_origin_check check (origin in ('automation','manual'));
exception when duplicate_object then null; end $$;
create unique index if not exists email_queue_tracking_token_uidx on public.email_queue (tracking_token) where tracking_token is not null;
create index if not exists email_queue_campaign_idx on public.email_queue (campaign_id, sent_at) where campaign_id is not null;

-- ── the ledger ─────────────────────────────────────────────────────────────
alter table public.email_events
  add column if not exists event_source text,
  add column if not exists provider text,
  add column if not exists provider_event_id text,
  add column if not exists event_at timestamptz,
  add column if not exists received_at timestamptz,
  add column if not exists recipient_email text,
  add column if not exists lane text,
  add column if not exists origin text,
  add column if not exists sender_key text,
  add column if not exists sending_domain text,
  add column if not exists campaign_id text,
  add column if not exists campaign_target_id text,
  add column if not exists sequence_id text,
  add column if not exists sequence_step integer,
  add column if not exists template_id text,
  add column if not exists template_version text,
  add column if not exists master_owner_id text,
  add column if not exists property_id text,
  add column if not exists opportunity_id uuid,
  add column if not exists closing_case_id text,
  add column if not exists buyer_id text,
  add column if not exists title_company_id text,
  add column if not exists link_id uuid,
  add column if not exists signal_class text,
  add column if not exists signal_confidence numeric,
  add column if not exists bounce_class text,
  add column if not exists reason text,
  add column if not exists raw_payload jsonb;

do $$ begin
  alter table public.email_events add constraint email_events_type_check check (event_type in (
    'queued','scheduled','sending','sent','accepted','delivered','open_signal','click','replied',
    'soft_bounce','hard_bounce','deferred','failed','invalid_address','blocked','unsubscribed','complaint',
    'suppressed','cancelled','superseded','automation_stopped','escalated','retry_scheduled'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.email_events add constraint email_events_signal_class_check
    check (signal_class is null or signal_class in ('likely_human','privacy_proxy','automated','unknown'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.email_events add constraint email_events_source_check check (event_source is null or event_source in (
    'dispatcher','provider_api','brevo_webhook','leadcommand_tracking_pixel','leadcommand_click_redirect',
    'cloudflare_inbound_email','brevo_inbound','manual_operator','import','system'));
exception when duplicate_object then null; end $$;

create index if not exists email_events_queue_type_idx on public.email_events (queue_id, event_type, event_at);
create index if not exists email_events_type_at_idx on public.email_events (event_type, event_at);
create index if not exists email_events_campaign_idx on public.email_events (campaign_id, event_type) where campaign_id is not null;
create index if not exists email_events_recipient_idx on public.email_events (lower(recipient_email), event_at);
create index if not exists email_events_owner_idx on public.email_events (master_owner_id, event_at) where master_owner_id is not null;
create index if not exists email_events_provider_msg_idx on public.email_events (provider, provider_message_id);

-- Events are historical facts: append-only. Only the raw debug payload may be
-- pruned later (retention); nothing else about an event can change.
create or replace function public.email_events_append_only() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'EMAIL_EVENTS_APPEND_ONLY: events are history and cannot be deleted';
  end if;
  if (to_jsonb(new) - 'raw_payload') is distinct from (to_jsonb(old) - 'raw_payload') then
    raise exception 'EMAIL_EVENTS_APPEND_ONLY: event % cannot be modified', old.event_key;
  end if;
  return new;
end $$;
drop trigger if exists email_events_append_only on public.email_events;
create trigger email_events_append_only before update or delete on public.email_events
  for each row execute function public.email_events_append_only();

-- ── tracked links ──────────────────────────────────────────────────────────
create table if not exists public.email_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  queue_id uuid not null references public.email_queue(id),
  link_index integer not null,
  destination_url text not null check (destination_url ~* '^(https?://|mailto:)'),
  label text,
  created_at timestamptz not null default now(),
  unique (queue_id, link_index)
);
alter table public.email_links enable row level security;

-- ── derived: per-message engagement (first/last/count from the ledger) ─────
create or replace view public.email_message_engagement as
select
  e.queue_id,
  min(e.event_at) filter (where e.event_type = 'sent')        as sent_at,
  min(e.event_at) filter (where e.event_type = 'accepted')    as accepted_at,
  min(e.event_at) filter (where e.event_type = 'delivered')   as delivered_at,
  min(e.event_at) filter (where e.event_type = 'open_signal') as first_open_at,
  max(e.event_at) filter (where e.event_type = 'open_signal') as last_open_at,
  count(*) filter (where e.event_type = 'open_signal')        as open_count,
  count(*) filter (where e.event_type = 'open_signal' and e.signal_class = 'likely_human') as human_open_count,
  count(*) filter (where e.event_type = 'open_signal' and e.signal_class = 'privacy_proxy') as proxy_open_count,
  min(e.event_at) filter (where e.event_type = 'click')       as first_click_at,
  max(e.event_at) filter (where e.event_type = 'click')       as last_click_at,
  count(*) filter (where e.event_type = 'click')              as click_count,
  count(*) filter (where e.event_type = 'click' and e.signal_class = 'likely_human') as human_click_count,
  min(e.event_at) filter (where e.event_type = 'replied')     as reply_at,
  min(e.event_at) filter (where e.event_type in ('hard_bounce','soft_bounce','invalid_address','blocked')) as bounce_at,
  bool_or(e.event_type in ('hard_bounce','invalid_address'))  as hard_bounced,
  min(e.event_at) filter (where e.event_type = 'unsubscribed') as unsubscribe_at,
  min(e.event_at) filter (where e.event_type = 'complaint')   as complaint_at,
  max(e.event_at)                                             as last_event_at
from public.email_events e
where e.queue_id is not null and e.direction = 'outbound'
group by e.queue_id;

-- ── derived: address health (one address, not the whole seller) ───────────
create or replace view public.email_address_health as
with ev as (
  select lower(coalesce(recipient_email, to_email)) as email_address,
    max(event_at) filter (where event_type = 'delivered') as last_delivered_at,
    max(event_at) filter (where event_type in ('hard_bounce','invalid_address')) as hard_bounce_at,
    max(event_at) filter (where event_type = 'soft_bounce') as last_soft_bounce_at,
    count(*) filter (where event_type = 'soft_bounce' and event_at > now() - interval '30 days') as soft_bounces_30d,
    max(event_at) filter (where event_type = 'unsubscribed') as unsubscribed_at,
    max(event_at) filter (where event_type = 'complaint') as complaint_at,
    max(event_at) filter (where event_type = 'replied') as last_reply_at
  from public.email_events
  where coalesce(recipient_email, to_email) is not null
  group by 1
)
select
  coalesce(ev.email_address, s.email_address) as email_address,
  case
    when ev.complaint_at is not null then 'complaint'
    when ev.unsubscribed_at is not null or s.reason in ('unsubscribe','opt_out','unsubscribed') then 'unsubscribed'
    when ev.hard_bounce_at is not null and (ev.last_delivered_at is null or ev.hard_bounce_at > ev.last_delivered_at) then 'hard_bounce'
    when s.is_active is true then 'suppressed'
    when ev.soft_bounces_30d > 0 and (ev.last_delivered_at is null or ev.last_soft_bounce_at > ev.last_delivered_at) then 'soft_bounce'
    when ev.last_delivered_at is not null or ev.last_reply_at is not null then 'healthy'
    else 'unknown'
  end as status,
  ev.last_delivered_at, ev.hard_bounce_at, ev.last_soft_bounce_at, coalesce(ev.soft_bounces_30d, 0) as soft_bounces_30d,
  ev.unsubscribed_at, ev.complaint_at, ev.last_reply_at,
  s.reason as suppression_reason, s.is_active as suppression_active
from ev
full join public.email_suppression s on s.email_address = ev.email_address;

-- ── derived: touch attribution per seller/property ─────────────────────────
-- first touch, reply-generating touch (the outbound a reply answered), last
-- touch — history is kept, not collapsed into "last email sent".
create or replace view public.email_touch_attribution as
with sent as (
  select q.master_owner_id, q.property_id, q.id as queue_id, q.campaign_id, q.sequence_step, q.template_id, q.template_version,
         q.sender_key, q.sending_domain, q.lane, q.sent_at
  from public.email_queue q
  where q.sent_at is not null and q.master_owner_id is not null
), replies as (
  select e.master_owner_id, e.property_id, min(e.event_at) as first_reply_at,
         (array_agg(e.queue_id order by e.event_at))[1] as reply_queue_id
  from public.email_events e
  where e.event_type = 'replied' and e.master_owner_id is not null
  group by 1, 2
)
select
  s.master_owner_id, s.property_id,
  (array_agg(s.queue_id order by s.sent_at))[1]        as first_touch_queue_id,
  min(s.sent_at)                                         as first_touch_at,
  (array_agg(s.campaign_id order by s.sent_at))[1]     as first_touch_campaign_id,
  (array_agg(s.queue_id order by s.sent_at desc))[1]   as last_touch_queue_id,
  max(s.sent_at)                                         as last_touch_at,
  count(*)                                               as touches,
  r.reply_queue_id                                       as reply_touch_queue_id,
  r.first_reply_at
from sent s
left join replies r on r.master_owner_id = s.master_owner_id and r.property_id is not distinct from s.property_id
group by s.master_owner_id, s.property_id, r.reply_queue_id, r.first_reply_at;

-- ── aggregation for Campaign Command / Analytics ───────────────────────────
-- Unique recipients vs total events are separate columns; each rate names
-- its denominator. Grouped by one dimension; bounded by time.
create or replace function public.email_metrics(
  p_dimension text,             -- 'campaign' | 'template' | 'sender' | 'domain' | 'lane' | 'provider' | 'sequence_step'
  p_from timestamptz,
  p_to timestamptz default now(),
  p_campaign_id text default null
) returns table (
  dim text, sent bigint, accepted bigint, delivered bigint,
  open_events bigint, unique_openers bigint, unique_human_openers bigint,
  click_events bigint, unique_clickers bigint, unique_human_clickers bigint,
  replies bigint, unique_responders bigint,
  hard_bounces bigint, soft_bounces bigint, failed bigint, unsubscribes bigint, complaints bigint
) language sql stable set search_path = public, pg_temp as $$
  with msgs as (
    select q.id, lower(q.to_email) as rcpt,
      case p_dimension
        when 'campaign' then q.campaign_id
        when 'template' then coalesce(q.template_id, '') || '@' || coalesce(q.template_version, '')
        when 'sender' then q.sender_key
        when 'domain' then q.sending_domain
        when 'lane' then q.lane
        when 'provider' then q.provider
        when 'sequence_step' then q.sequence_step::text
        else null end as dim
    from public.email_queue q
    where q.sent_at >= p_from and q.sent_at < p_to
      and (p_campaign_id is null or q.campaign_id = p_campaign_id)
  )
  select m.dim,
    count(distinct m.id)                                                                   as sent,
    count(distinct e.queue_id) filter (where e.event_type = 'accepted')                    as accepted,
    count(distinct e.queue_id) filter (where e.event_type = 'delivered')                   as delivered,
    count(e.id) filter (where e.event_type = 'open_signal')                                as open_events,
    count(distinct m.rcpt) filter (where e.event_type = 'open_signal')                     as unique_openers,
    count(distinct m.rcpt) filter (where e.event_type = 'open_signal' and e.signal_class = 'likely_human') as unique_human_openers,
    count(e.id) filter (where e.event_type = 'click')                                      as click_events,
    count(distinct m.rcpt) filter (where e.event_type = 'click')                           as unique_clickers,
    count(distinct m.rcpt) filter (where e.event_type = 'click' and e.signal_class = 'likely_human') as unique_human_clickers,
    count(e.id) filter (where e.event_type = 'replied')                                    as replies,
    count(distinct m.rcpt) filter (where e.event_type = 'replied')                         as unique_responders,
    count(distinct m.rcpt) filter (where e.event_type in ('hard_bounce','invalid_address')) as hard_bounces,
    count(distinct m.rcpt) filter (where e.event_type = 'soft_bounce')                     as soft_bounces,
    count(distinct m.id) filter (where e.event_type = 'failed')                            as failed,
    count(distinct m.rcpt) filter (where e.event_type = 'unsubscribed')                    as unsubscribes,
    count(distinct m.rcpt) filter (where e.event_type = 'complaint')                       as complaints
  from msgs m
  left join public.email_events e on e.queue_id = m.id
  group by m.dim;
$$;
