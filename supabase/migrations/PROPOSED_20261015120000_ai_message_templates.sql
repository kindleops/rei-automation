-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- 8.5.16 R3 — IMMUTABLE PER-MESSAGE AI TEMPLATE RECORDS (owner decision 2026-10-15):
--   "Preserve the existing sms_templates invariant. Support adaptive AI-written
--    messages using an immutable per-message template record, with provenance,
--    policy authorization, validation, and canonical send-queue execution."
--
-- One row per AI-written message. sms_templates-COMPATIBLE columns (template_id,
-- use_case, language, template_body, is_active, metadata) so the send_queue row can
-- carry template_id = selected_template_id = this record, but a SEPARATE table:
-- template selection reads public.sms_templates only, so a record can never be picked,
-- edited or reused by the template engine.
--
--   append-only      UPDATE / DELETE refused (row trigger), TRUNCATE refused (statement trigger)
--   one per message  unique template_id, unique inbound_message_id, unique queue_key
--   never selectable is_active = false (CHECK), template_kind = 'ai_message' (CHECK),
--                    template_id 'ai-msg:' prefix (CHECK), use_case 'ai_' prefix (CHECK)
--   body integrity   body_sha256 = sha256(template_body) (CHECK); draft_hash = body_sha256
--   validated        validator_verdict.status = 'validated_draft' (CHECK)
--   sealed thread    thread_ref 'tr:' + sha256(thread_key) — the key is never stored
--   provenance       model, decision_id, draft_hash, validator_verdict, ledger_snapshot_hash,
--                    policy_version, policy_authorization (policy key/version/hash, scope, category)
--   access           RLS enabled + forced, NO policies (service role only)
--
-- Nothing existing is altered. No send_queue change. Inserting a record sends nothing.
-- APPLY IN ONE TRANSACTION (no BEGIN/COMMIT here):
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261015120000_ai_message_templates.sql
-- Rollback: PROPOSED_20261015120000_ai_message_templates_rollback.sql
-- Proof: LOCAL DISPOSABLE DATABASE ONLY (apps/api/scripts/proof/local-pg-migration-proof.mjs);
-- never run this, its rollback or its fixtures against production.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.ai_message_templates (
  id                    uuid primary key default gen_random_uuid(),
  template_id           text not null unique check (template_id ~ '^ai-msg:[0-9a-f]{32}$'),
  template_kind         text not null default 'ai_message' check (template_kind = 'ai_message'),
  use_case              text not null check (use_case ~ '^ai_[a-z_]+$'),
  language              text not null default 'English' check (language = 'English'),
  template_body         text not null check (length(btrim(template_body)) between 1 and 320),
  body_sha256           text not null check (body_sha256 = encode(sha256(convert_to(template_body, 'UTF8')), 'hex')),
  is_active             boolean not null default false check (is_active = false),
  inbound_message_id    text not null unique check (length(btrim(inbound_message_id)) > 0),
  queue_key             text not null unique check (queue_key = 'ai_conversation:' || inbound_message_id),
  thread_ref            text not null check (thread_ref ~ '^tr:[0-9a-f]{64}$'),
  model                 text,
  decision_id           text not null check (length(btrim(decision_id)) > 0),
  draft_hash            text not null check (draft_hash = body_sha256),
  validator_verdict     jsonb not null check (validator_verdict->>'status' = 'validated_draft'),
  ledger_snapshot_hash  text not null check (ledger_snapshot_hash ~ '^[0-9a-f]{64}$'),
  policy_version        text not null check (length(btrim(policy_version)) > 0),
  policy_authorization  jsonb not null check (
                          policy_authorization ? 'policy_hash' and policy_authorization ? 'category'
                          and policy_authorization ? 'scope_match'
                          and policy_authorization->>'category' in ('next_missing_fact', 'identity_answer', 'not_interested_close')),
  record_version        text not null,
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

comment on table public.ai_message_templates is
  '8.5.16 R3: one IMMUTABLE sms_templates-compatible record per AI-written message (append-only; never selectable; owner 2026-10-15).';

create or replace function public.ai_message_templates_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'ai_message_templates is append-only: % refused', tg_op
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists ai_message_templates_no_update_delete on public.ai_message_templates;
create trigger ai_message_templates_no_update_delete
  before update or delete on public.ai_message_templates
  for each row execute function public.ai_message_templates_immutable();

drop trigger if exists ai_message_templates_no_truncate on public.ai_message_templates;
create trigger ai_message_templates_no_truncate
  before truncate on public.ai_message_templates
  for each statement execute function public.ai_message_templates_immutable();

alter table public.ai_message_templates enable row level security;
alter table public.ai_message_templates force row level security;
