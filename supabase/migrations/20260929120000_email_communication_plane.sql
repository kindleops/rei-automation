-- EMAIL COMMAND — communication control plane, canonical schema.
--
-- Builds ON the provisioned email tables instead of adding a fifth design:
--   email_queue       = the ONE outbound store. One row = one LOGICAL outbound
--                       communication (queue_key). Transport retries reuse the
--                       row (retry_count); a business follow-up is a NEW row.
--   email_events      = provider event ledger (delivered/bounce/open/…).
--   email_suppression = address-level suppression.
-- New:
--   email_threads           = conversation identity + entity links + operator
--                             state (needs-you, takeover, read) + projection.
--   email_inbound_messages  = received mail (dedupe on provider/Message-ID).
--   email_attachments       = the document store for email files (none existed).
--
-- Email owns TRANSPORT truth only. Seller stage, closing state, lifecycle and
-- settlement stay with their authorities; nothing here writes them.

-- ── threads ────────────────────────────────────────────────────────────────
create table if not exists public.email_threads (
  id uuid primary key default gen_random_uuid(),
  thread_key text not null unique,
  category text not null default 'other'
    check (category in ('seller','title','buyer','lender','attorney','agent','vendor','internal','unresolved','other')),
  counterparty_email text,
  counterparty_name text,
  counterparty_role text,
  brand_key text,
  sender_key text,
  subject text,
  master_owner_id text,
  prospect_id text,
  property_id text,
  opportunity_id uuid,
  closing_case_id text,
  buyer_id text,
  title_company_id text,
  -- The seller's SMS conversation (inbox_thread_state.thread_key). Seller email
  -- and SMS share ONE brain: facts/stage key on owner+property, and the seller
  -- orchestrator is invoked with this key so follow-up cancellation, lead state
  -- and notifications land on the same conversation.
  sms_thread_key text,
  -- Channel preference the seller expressed ('email' | 'sms'), with evidence.
  contact_preference text check (contact_preference in ('email','sms')),
  resolution_status text not null default 'resolved'
    check (resolution_status in ('resolved','ambiguous','unresolved')),
  resolution_method text,
  resolution_candidates jsonb not null default '[]'::jsonb,
  automation_state text not null default 'active'
    check (automation_state in ('active','paused','taken_over','completed','failed')),
  taken_over_by text,
  taken_over_at timestamptz,
  takeover_reason text,
  needs_operator boolean not null default false,
  needs_code text,
  needs_reason text,
  needs_since timestamptz,
  operator_read_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_message_at timestamptz,
  last_message_direction text check (last_message_direction in ('inbound','outbound')),
  last_message_preview text,
  inbound_count integer not null default 0,
  outbound_count integer not null default 0,
  attachment_count integer not null default 0,
  root_message_id text,
  reply_token text not null unique default encode(extensions.gen_random_bytes(9), 'hex'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_threads_takeover_has_actor
    check (automation_state <> 'taken_over' or (taken_over_by is not null and taken_over_at is not null)),
  constraint email_threads_needs_has_reason
    check (not needs_operator or (needs_code is not null and needs_since is not null))
);
create index if not exists email_threads_last_message_idx on public.email_threads (last_message_at desc nulls last);
create index if not exists email_threads_needs_idx on public.email_threads (needs_since) where needs_operator;
create index if not exists email_threads_owner_idx on public.email_threads (master_owner_id) where master_owner_id is not null;
create index if not exists email_threads_property_idx on public.email_threads (property_id) where property_id is not null;
create index if not exists email_threads_sms_idx on public.email_threads (sms_thread_key) where sms_thread_key is not null;
create index if not exists email_threads_closing_idx on public.email_threads (closing_case_id) where closing_case_id is not null;
create index if not exists email_threads_counterparty_idx on public.email_threads (lower(counterparty_email));
alter table public.email_threads enable row level security;

-- ── outbound: extend the provisioned queue ─────────────────────────────────
alter table public.email_queue
  add column if not exists thread_id uuid references public.email_threads(id),
  add column if not exists source text,
  add column if not exists source_ref text,
  add column if not exists action_key text,
  add column if not exists sequence integer,
  add column if not exists message_id_header text,
  add column if not exists in_reply_to text,
  add column if not exists references_header text,
  add column if not exists html_body text,
  add column if not exists text_body text,
  add column if not exists from_name text,
  add column if not exists reply_to_email text,
  add column if not exists brand_key text,
  add column if not exists sender_key text,
  add column if not exists approval_status text not null default 'not_required',
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz,
  add column if not exists reason jsonb not null default '{}'::jsonb,
  add column if not exists revalidated_at timestamptz,
  add column if not exists cancel_reason text,
  add column if not exists superseded_by uuid,
  add column if not exists attempt_started_at timestamptz,
  add column if not exists requested_by text;

do $$ begin
  alter table public.email_queue add constraint email_queue_status_check check (queue_status in (
    'draft','awaiting_approval','scheduled','pending_send','sending','sent','delivered',
    'bounced','failed','cancelled','superseded','no_send','skipped'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.email_queue add constraint email_queue_approval_check
    check (approval_status in ('not_required','required','approved','rejected'));
exception when duplicate_object then null; end $$;
do $$ begin
  -- A message needing approval cannot be dispatchable until approved.
  alter table public.email_queue add constraint email_queue_approval_gate
    check (approval_status not in ('required','rejected') or queue_status in ('draft','awaiting_approval','cancelled','superseded'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.email_queue add constraint email_queue_cancel_has_reason
    check (queue_status not in ('cancelled','superseded') or cancel_reason is not null);
exception when duplicate_object then null; end $$;
create unique index if not exists email_queue_message_id_header_uidx
  on public.email_queue (message_id_header) where message_id_header is not null;
create index if not exists email_queue_dispatch_idx
  on public.email_queue (coalesce(scheduled_for, created_at)) where queue_status in ('pending_send','scheduled');
create index if not exists email_queue_thread_idx on public.email_queue (thread_id, created_at);
create index if not exists email_queue_source_idx on public.email_queue (source, source_ref);
create index if not exists email_queue_provider_msg_idx on public.email_queue (provider_message_id) where provider_message_id is not null;

-- ── inbound ────────────────────────────────────────────────────────────────
create table if not exists public.email_inbound_messages (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  provider text not null default 'brevo',
  provider_message_id text,
  message_id_header text,
  in_reply_to text,
  references_headers text[] not null default '{}',
  from_email text not null,
  from_name text,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  reply_token text,
  subject text,
  text_body text,
  html_body text,
  reply_text text,
  signature_text text,
  received_at timestamptz not null default now(),
  thread_id uuid references public.email_threads(id),
  resolution_method text,
  resolution_confidence numeric,
  processing_status text not null default 'received'
    check (processing_status in ('received','resolved','unresolved','classified','handled','needs_operator','ignored','failed')),
  classification jsonb not null default '{}'::jsonb,
  handled_at timestamptz,
  handled_by text,
  processing_error text,
  attachment_count integer not null default 0,
  headers jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists email_inbound_thread_idx on public.email_inbound_messages (thread_id, received_at);
create index if not exists email_inbound_status_idx on public.email_inbound_messages (processing_status, received_at);
create index if not exists email_inbound_from_idx on public.email_inbound_messages (lower(from_email));
create index if not exists email_inbound_msgid_idx on public.email_inbound_messages (message_id_header) where message_id_header is not null;
alter table public.email_inbound_messages enable row level security;

-- ── attachments (document store for email files) ──────────────────────────
create table if not exists public.email_attachments (
  id uuid primary key default gen_random_uuid(),
  attachment_key text not null unique,
  inbound_message_id uuid references public.email_inbound_messages(id),
  queue_id uuid references public.email_queue(id),
  thread_id uuid references public.email_threads(id),
  filename text,
  content_type text,
  size_bytes bigint,
  sha256 text,
  storage_bucket text,
  storage_path text,
  provider_download_token text,
  fetch_status text not null default 'pending'
    check (fetch_status in ('pending','stored','failed','too_large','blocked')),
  doc_type text,
  classification_confidence numeric,
  classification_method text,
  review_state text not null default 'unclassified'
    check (review_state in ('unclassified','auto_classified','needs_review','reviewed','rejected')),
  routed_entity_type text,
  routed_entity_id text,
  routed_at timestamptz,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint email_attachments_one_parent check (num_nonnulls(inbound_message_id, queue_id) = 1),
  -- Routing a file to a business object needs a human or a confident classifier.
  constraint email_attachments_routing_trusted
    check (routed_entity_id is null or review_state in ('auto_classified','reviewed'))
);
create index if not exists email_attachments_thread_idx on public.email_attachments (thread_id);
create index if not exists email_attachments_review_idx on public.email_attachments (review_state) where review_state = 'needs_review';
alter table public.email_attachments enable row level security;

insert into storage.buckets (id, name, public)
values ('email-attachments', 'email-attachments', false)
on conflict (id) do nothing;

-- ── events: thread link ────────────────────────────────────────────────────
alter table public.email_events add column if not exists thread_id uuid;
create index if not exists email_events_to_email_idx on public.email_events (lower(to_email));
create index if not exists email_events_queue_idx on public.email_events (queue_id);

-- ── seller identity by address ──────────────────────────────────────────────
-- Inbound seller email resolves address → master_owner. The only existing
-- index leads with master_key, so an address lookup scanned 165k rows.
-- 7,346 addresses are shared by more than one owner: resolution treats those
-- as ambiguous unless exactly one of the owners has a live conversation.
create index if not exists emails_email_normalized_idx on public.emails (email_normalized);

-- ── thread projection maintenance ──────────────────────────────────────────
-- The thread row carries last-activity fields so the list is one bounded read
-- (no per-thread N+1). Maintained here so every writer — processor, webhook,
-- manual send — keeps it true without remembering to.
create or replace function public.email_thread_touch_outbound() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.thread_id is null then return new; end if;
  if new.queue_status in ('sent','delivered')
     and (tg_op = 'INSERT' or old.queue_status is distinct from new.queue_status)
     and (tg_op = 'INSERT' or old.queue_status not in ('sent','delivered')) then
    update public.email_threads t set
      last_outbound_at = greatest(coalesce(t.last_outbound_at, 'epoch'), coalesce(new.sent_at, now())),
      last_message_at = greatest(coalesce(t.last_message_at, 'epoch'), coalesce(new.sent_at, now())),
      last_message_direction = case when coalesce(new.sent_at, now()) >= coalesce(t.last_message_at, 'epoch') then 'outbound' else t.last_message_direction end,
      last_message_preview = case when coalesce(new.sent_at, now()) >= coalesce(t.last_message_at, 'epoch')
        then left(regexp_replace(coalesce(new.text_body, new.email_body, ''), '\s+', ' ', 'g'), 200) else t.last_message_preview end,
      outbound_count = t.outbound_count + 1,
      root_message_id = coalesce(t.root_message_id, new.message_id_header),
      updated_at = now()
    where t.id = new.thread_id;
  end if;
  return new;
end $$;
drop trigger if exists email_queue_thread_touch on public.email_queue;
create trigger email_queue_thread_touch after insert or update of queue_status on public.email_queue
  for each row execute function public.email_thread_touch_outbound();

create or replace function public.email_thread_touch_inbound() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.thread_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.thread_id is not distinct from new.thread_id then return new; end if;
  update public.email_threads t set
    last_inbound_at = greatest(coalesce(t.last_inbound_at, 'epoch'), new.received_at),
    last_message_at = greatest(coalesce(t.last_message_at, 'epoch'), new.received_at),
    last_message_direction = case when new.received_at >= coalesce(t.last_message_at, 'epoch') then 'inbound' else t.last_message_direction end,
    last_message_preview = case when new.received_at >= coalesce(t.last_message_at, 'epoch')
      then left(regexp_replace(coalesce(new.reply_text, new.text_body, ''), '\s+', ' ', 'g'), 200) else t.last_message_preview end,
    inbound_count = t.inbound_count + 1,
    attachment_count = t.attachment_count + new.attachment_count,
    updated_at = now()
  where t.id = new.thread_id;
  return new;
end $$;
drop trigger if exists email_inbound_thread_touch on public.email_inbound_messages;
create trigger email_inbound_thread_touch after insert or update of thread_id on public.email_inbound_messages
  for each row execute function public.email_thread_touch_inbound();

-- ── claim: one dispatcher, no double send ──────────────────────────────────
-- Claims due rows with SKIP LOCKED and moves them to 'sending' atomically.
-- A row stuck in 'sending' is NEVER re-claimed: the provider may have accepted
-- it (the SMS duplicate-send lesson). email_queue_reap_stuck() moves it to
-- failed/transport_outcome_unknown for an operator instead.
create or replace function public.email_queue_claim(p_limit integer, p_worker text, p_now timestamptz default now())
returns setof public.email_queue
language plpgsql set search_path = public, pg_temp as $$
begin
  return query
  with due as (
    select q.id from public.email_queue q
    where q.queue_status in ('pending_send','scheduled')
      and coalesce(q.scheduled_for, q.created_at) <= p_now
      and (q.next_retry_at is null or q.next_retry_at <= p_now)
      and q.approval_status in ('not_required','approved')
    order by coalesce(q.send_priority, 5), coalesce(q.scheduled_for, q.created_at)
    limit greatest(1, least(p_limit, 100))
    for update skip locked
  )
  update public.email_queue q set
    queue_status = 'sending',
    is_locked = true,
    locked_at = p_now,
    lock_token = p_worker,
    attempt_started_at = p_now,
    updated_at = p_now
  from due where q.id = due.id
  returning q.*;
end $$;

create or replace function public.email_queue_reap_stuck(p_older_than interval default interval '15 minutes')
returns integer language plpgsql set search_path = public, pg_temp as $$
declare n integer;
begin
  update public.email_queue set
    queue_status = 'failed',
    failed_reason = 'transport_outcome_unknown',
    is_locked = false,
    updated_at = now()
  where queue_status = 'sending' and attempt_started_at < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end $$;

insert into public.system_control (key, value)
values ('email_automation_enabled', 'true')
on conflict (key) do nothing;
