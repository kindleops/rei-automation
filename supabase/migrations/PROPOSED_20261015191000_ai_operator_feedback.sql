-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- LeadCommand 8.5.19 — OPERATOR FEEDBACK + EVALUATION SETS (owner directive
-- 2026-10-15, "8.5.16 NATIVE AI CONVERSATION ENGINE", Phase 10).
--
-- APPLY IN ONE TRANSACTION (no BEGIN/COMMIT here; the runner / psql wraps it):
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261015191000_ai_operator_feedback.sql
-- Tested ONLY on a disposable PostgreSQL:
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id ai_operator_feedback
--
-- WHAT IT CREATES (no existing table is altered):
--   public.ai_operator_feedback  APPEND-ONLY record of what happened to every AI draft:
--                                generated / approved / rejected / edited (with operator notes),
--                                the seller's response, negotiation and acquisition outcomes.
--                                Linked to the 8.5.16 AI message record by ai_message_id
--                                (public.ai_generated_messages.id — no FK: that table ships in
--                                8.5.16) and/or the conversation decision id.
--   public.ai_eval_sets          immutable, versioned, held-out evaluation sets built from
--                                REVIEWED feedback only (name + version unique, content hash).
--
-- Nothing here changes production behaviour: no trigger, view or function reads these
-- tables to send, route or re-prompt. Prompt / playbook changes remain versioned PRs.
-- Masked text only (CHECK refuses a phone-shaped digit run or an email). RLS enabled +
-- forced, NO policies ⇒ backend (service_role) only; service_role is insert/select only.
-- ════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table public.ai_operator_feedback (
  feedback_id        uuid primary key default gen_random_uuid(),
  contract_version   text not null default 'ai-feedback.v1' check (contract_version = 'ai-feedback.v1'),
  kind               text not null check (kind in (
                       'draft_generated', 'draft_approved', 'draft_rejected', 'draft_edited', 'operator_note',
                       'seller_response', 'negotiation_outcome', 'acquisition_outcome')),
  ai_message_id      text check (ai_message_id is null or length(ai_message_id) between 1 and 120),
  decision_id        text check (decision_id is null or length(decision_id) between 1 and 160),
  thread_ref         text check (thread_ref is null or thread_ref ~ '^thr_[a-p]{12}$'),
  property_id        text check (property_id is null or length(property_id) <= 80),
  operator_id        text check (operator_id is null or length(operator_id) between 1 and 80),
  draft_text_masked  text check (draft_text_masked is null or length(draft_text_masked) <= 640),
  final_text_masked  text check (final_text_masked is null or length(final_text_masked) <= 640),
  note_masked        text check (note_masked is null or length(note_masked) <= 1000),
  labels             jsonb not null default '{}'::jsonb check (jsonb_typeof(labels) = 'object' and octet_length(labels::text) <= 4000),
  outcome            jsonb not null default '{}'::jsonb check (jsonb_typeof(outcome) = 'object' and octet_length(outcome::text) <= 4000),
  model              text check (model is null or length(model) <= 80),
  cost_usd           numeric(10,6) check (cost_usd is null or cost_usd >= 0),
  idempotency_key    text not null unique check (length(idempotency_key) between 8 and 200),
  created_at         timestamptz not null default now(),
  constraint ai_operator_feedback_linked check (ai_message_id is not null or decision_id is not null),
  constraint ai_operator_feedback_reviewer check (kind not in ('draft_approved', 'draft_rejected', 'draft_edited', 'operator_note') or operator_id is not null),
  constraint ai_operator_feedback_edit_has_text check (kind <> 'draft_edited' or final_text_masked is not null),
  constraint ai_operator_feedback_masked check (
        coalesce(draft_text_masked, '') !~ '[0-9]{3}[^0-9]{0,4}[0-9]{3}[^0-9]{0,4}[0-9]{4}'
    and coalesce(final_text_masked, '') !~ '[0-9]{3}[^0-9]{0,4}[0-9]{3}[^0-9]{0,4}[0-9]{4}'
    and coalesce(note_masked, '')       !~ '[0-9]{3}[^0-9]{0,4}[0-9]{3}[^0-9]{0,4}[0-9]{4}'
    and coalesce(draft_text_masked, '') !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
    and coalesce(final_text_masked, '') !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
    and coalesce(note_masked, '')       !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  )
);
create index ai_operator_feedback_message_idx on public.ai_operator_feedback (ai_message_id, created_at) where ai_message_id is not null;
create index ai_operator_feedback_decision_idx on public.ai_operator_feedback (decision_id, created_at) where decision_id is not null;
create index ai_operator_feedback_kind_idx on public.ai_operator_feedback (kind, created_at desc);
comment on table public.ai_operator_feedback is 'AI draft feedback (8.5.19): append-only. Linked to ai_generated_messages.id (8.5.16) and/or the decision id. Read by the evaluation-set builder only; never by any send / routing / prompt path.';

create table public.ai_eval_sets (
  eval_set_id        text primary key check (eval_set_id ~ '^evalset_[a-z0-9_]{1,40}_v[0-9]{1,4}$'),
  name               text not null check (name ~ '^[a-z0-9_]{1,40}$'),
  version            integer not null check (version between 1 and 9999),
  builder_version    text not null check (length(builder_version) between 1 and 60),
  seed               text not null check (length(seed) between 1 and 80),
  holdout_fraction   numeric(4,3) not null check (holdout_fraction > 0 and holdout_fraction < 1),
  item_count         integer not null check (item_count >= 0),
  manifest           jsonb not null check (jsonb_typeof(manifest) = 'object' and octet_length(manifest::text) <= 2000000),
  content_hash       text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_by         text not null check (length(created_by) between 1 and 80),
  created_at         timestamptz not null default now(),
  constraint ai_eval_sets_name_version_key unique (name, version),
  constraint ai_eval_sets_id_matches check (eval_set_id = 'evalset_' || name || '_v' || version::text)
);
comment on table public.ai_eval_sets is 'Versioned, held-out evaluation sets (8.5.19) built deterministically from REVIEWED operator feedback. Immutable: a change is a new version.';

create or replace function public.ai_feedback_immutable_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception '% is append-only (% refused)', tg_table_name, tg_op using errcode = 'check_violation';
end
$$;

create trigger ai_operator_feedback_immutable before update or delete on public.ai_operator_feedback
  for each row execute function public.ai_feedback_immutable_guard();
create trigger ai_operator_feedback_no_truncate before truncate on public.ai_operator_feedback
  for each statement execute function public.ai_feedback_immutable_guard();
create trigger ai_eval_sets_immutable before update or delete on public.ai_eval_sets
  for each row execute function public.ai_feedback_immutable_guard();
create trigger ai_eval_sets_no_truncate before truncate on public.ai_eval_sets
  for each statement execute function public.ai_feedback_immutable_guard();

alter table public.ai_operator_feedback enable row level security;
alter table public.ai_operator_feedback force row level security;
alter table public.ai_eval_sets enable row level security;
alter table public.ai_eval_sets force row level security;
revoke all on public.ai_operator_feedback, public.ai_eval_sets from public, anon, authenticated, service_role;
grant select, insert on public.ai_operator_feedback, public.ai_eval_sets to service_role;
revoke all on function public.ai_feedback_immutable_guard() from public, anon, authenticated;
