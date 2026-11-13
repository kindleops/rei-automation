-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- 8.5.16 — NATIVE AI CONVERSATION ENGINE: the UNIFIED MESSAGE-ORIGIN CONTRACT
-- (owner directive 2026-10-15: "LeadCommand AI is not a template picker." "An
-- AI-generated message must not masquerade as a template." "template_id should be
-- required only for template-originated messages.")
--
--   send_queue.message_origin  'template' | 'ai_generated' | 'operator_manual'
--     NULL on every existing row and on every row written by an existing producer
--     (campaigns, auto-reply, follow-ups, inbox …): NULL is read as the LEGACY
--     derivation (operator_manual for manual composer sends, template otherwise),
--     so no existing writer, row or campaign changes by a single byte.
--     CHECK is NOT VALID (no table scan / rewrite; new rows are checked).
--
--   public.ai_generated_messages  ONE immutable record per AI-generated message,
--     linked to its queue row by queue_key (unique on both sides). NO template_id
--     column: an AI message is not a template. Carries the exact text + sha256,
--     provenance (decision / job id, model, playbook + prompt + context versions,
--     validation result, ledger snapshot hash, idempotency key, generation time,
--     cost / tokens, audit refs), the authorisation (policy scope + approval
--     state) and SEALED identities (thread, property, contact, sender, recipient
--     as sha256 refs; no phone number or thread key is stored).
--     UPDATE / DELETE / TRUNCATE refused. RLS forced, no policies.
--
--   public.ai_generated_message_events  APPEND-ONLY lifecycle of a record:
--     queued (queue row id + queue time), provider_accepted / provider_failed
--     (provider result), delivered / undelivered (final delivery state),
--     cancelled / held. Never updated, never deleted.
--
--   trigger guard_send_queue_message_origin (BEFORE INSERT OR UPDATE OF the
--     origin / template / body / key columns): for message_origin='ai_generated'
--     the row must carry NO template id and its body hash must equal an existing
--     ai_generated_messages record with the same queue_key; ANY row carrying an
--     'ai-msg:' template id is refused (no template masquerade). Every other row
--     (message_origin NULL / template / operator_manual) passes untouched.
--
-- APPLY IN ONE TRANSACTION (no BEGIN/COMMIT here):
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261015130000_message_origin_ai_generated_messages.sql
-- Rollback: PROPOSED_20261015130000_message_origin_ai_generated_messages_rollback.sql
-- Test: DISPOSABLE DATABASE ONLY —
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id message_origin_ai_generated_messages
-- ════════════════════════════════════════════════════════════════════════════

-- 1. the origin column (nullable, no default: metadata-only change, no rewrite)
alter table public.send_queue add column if not exists message_origin text;
alter table public.send_queue drop constraint if exists send_queue_message_origin_check;
alter table public.send_queue add constraint send_queue_message_origin_check
  check (message_origin is null or message_origin in ('template', 'ai_generated', 'operator_manual')) not valid;

-- 2. the immutable AI message record
create table if not exists public.ai_generated_messages (
  id                    uuid primary key default gen_random_uuid(),
  message_origin        text not null default 'ai_generated' check (message_origin = 'ai_generated'),
  queue_key             text not null unique check (queue_key = 'ai_conversation:' || inbound_message_id),
  idempotency_key       text not null unique check (idempotency_key = 'inbound_reply:' || inbound_message_id),
  inbound_message_id    text not null unique check (length(btrim(inbound_message_id)) > 0),
  thread_ref            text not null check (thread_ref ~ '^tr:[0-9a-f]{64}$'),
  property_ref          text check (property_ref is null or property_ref ~ '^pr:[0-9a-f]{64}$'),
  contact_ref           text check (contact_ref is null or contact_ref ~ '^ct:[0-9a-f]{64}$'),
  recipient_ref         text not null check (recipient_ref ~ '^ph:[0-9a-f]{64}$'),
  sender_ref            text check (sender_ref is null or sender_ref ~ '^ph:[0-9a-f]{64}$'),
  message_body          text not null check (length(btrim(message_body)) between 1 and 320),
  body_sha256           text not null check (body_sha256 = encode(sha256(convert_to(message_body, 'UTF8')), 'hex')),
  decision_id           text not null check (length(btrim(decision_id)) > 0),
  job_id                text,
  decision_outcome      text not null check (decision_outcome = 'AI_GENERATED_REPLY'),
  model                 text not null check (length(btrim(model)) > 0),
  playbook_version      text not null check (length(btrim(playbook_version)) > 0),
  prompt_version        text not null check (length(btrim(prompt_version)) > 0),
  context_version       text not null check (length(btrim(context_version)) > 0),
  validation            jsonb not null check (validation->>'status' = 'validated'),
  ledger_snapshot_hash  text not null check (ledger_snapshot_hash ~ '^[0-9a-f]{64}$'),
  authorization_scope   jsonb not null check (
                          authorization_scope ? 'policy_hash' and authorization_scope ? 'scope_match'
                          and authorization_scope->>'category' in ('next_missing_fact', 'identity_answer', 'not_interested_close', 'clarification')),
  approval_state        text not null check (approval_state in ('policy_authorized', 'operator_approved')),
  generated_at          timestamptz not null,
  cost_usd              numeric(10, 6) not null default 0 check (cost_usd >= 0),
  input_tokens          integer check (input_tokens is null or input_tokens >= 0),
  output_tokens         integer check (output_tokens is null or output_tokens >= 0),
  audit_refs            jsonb not null default '{}'::jsonb,
  record_version        text not null,
  created_at            timestamptz not null default now(),
  -- the playbook's hardest style rule is a schema rule too: no em dash, no en dash
  constraint ai_generated_messages_no_dashes check (position(chr(8212) in message_body) = 0 and position(chr(8211) in message_body) = 0)
);
comment on table public.ai_generated_messages is
  '8.5.16: one IMMUTABLE record per AI-generated message (origin ai_generated; not a template; append-only; owner 2026-10-15).';

create table if not exists public.ai_generated_message_events (
  id                 bigint generated always as identity primary key,
  ai_message_id      uuid not null references public.ai_generated_messages (id),
  event_type         text not null check (event_type in ('queued', 'provider_accepted', 'provider_failed', 'delivered', 'undelivered', 'cancelled', 'held')),
  queue_row_id       uuid,
  provider_result    jsonb,
  delivery_state     text,
  detail             jsonb not null default '{}'::jsonb,
  occurred_at        timestamptz not null default now()
);
create index if not exists ai_generated_message_events_message_idx on public.ai_generated_message_events (ai_message_id, occurred_at);

create or replace function public.ai_generated_messages_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception '% is append-only: % refused', tg_table_name, tg_op using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists ai_generated_messages_no_update_delete on public.ai_generated_messages;
create trigger ai_generated_messages_no_update_delete before update or delete on public.ai_generated_messages
  for each row execute function public.ai_generated_messages_immutable();
drop trigger if exists ai_generated_messages_no_truncate on public.ai_generated_messages;
create trigger ai_generated_messages_no_truncate before truncate on public.ai_generated_messages
  for each statement execute function public.ai_generated_messages_immutable();
drop trigger if exists ai_generated_message_events_no_update_delete on public.ai_generated_message_events;
create trigger ai_generated_message_events_no_update_delete before update or delete on public.ai_generated_message_events
  for each row execute function public.ai_generated_messages_immutable();
drop trigger if exists ai_generated_message_events_no_truncate on public.ai_generated_message_events;
create trigger ai_generated_message_events_no_truncate before truncate on public.ai_generated_message_events
  for each statement execute function public.ai_generated_messages_immutable();

alter table public.ai_generated_messages enable row level security;
alter table public.ai_generated_messages force row level security;
alter table public.ai_generated_message_events enable row level security;
alter table public.ai_generated_message_events force row level security;
revoke all on public.ai_generated_messages, public.ai_generated_message_events from anon, authenticated;

-- 3. the origin guard on send_queue (no-op for every non-AI row)
create or replace function public.guard_send_queue_message_origin()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(new.template_id, '') ~ '^ai-msg:' or coalesce(new.selected_template_id, '') ~ '^ai-msg:' or coalesce(new.template_key, '') ~ '^ai-msg:' then
    raise exception 'send_queue_ai_template_masquerade_refused' using errcode = 'check_violation';
  end if;
  if new.message_origin = 'ai_generated' then
    if nullif(btrim(coalesce(new.template_id, '')), '') is not null or nullif(btrim(coalesce(new.selected_template_id, '')), '') is not null then
      raise exception 'send_queue_ai_generated_must_not_carry_template_id' using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.ai_generated_messages m
       where m.queue_key = new.queue_key
         and m.body_sha256 = encode(sha256(convert_to(new.message_body, 'UTF8')), 'hex')
    ) then
      raise exception 'send_queue_ai_generated_requires_immutable_record' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists guard_send_queue_message_origin on public.send_queue;
create trigger guard_send_queue_message_origin
  before insert or update of message_origin, template_id, selected_template_id, template_key, message_body, queue_key
  on public.send_queue
  for each row execute function public.guard_send_queue_message_origin();
