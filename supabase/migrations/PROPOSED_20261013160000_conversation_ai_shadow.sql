-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- Conversation Engine 2.0 — R1 (understanding) + R2 (composition) SHADOW storage.
--
-- APPLY IN ONE TRANSACTION (no BEGIN/COMMIT here so the pretest can wrap it):
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261013160000_conversation_ai_shadow.sql
-- Run PROPOSED_20261013160000_conversation_ai_shadow_pretest.sql first.
-- Rollback: PROPOSED_20261013160000_conversation_ai_shadow_rollback.sql
--
-- WHAT IT CREATES (nothing else is touched; no existing table is altered):
--   public.conversation_ai_reply_policy      one row, the AI reply POLICY. Separate
--                                            from template auto-reply approval.
--                                            Seeded OFF: enabled=false, shadow_enabled=false,
--                                            kill_switch_engaged=true.
--   public.conversation_ai_shadow_decisions  one row per inbound message id (unique
--                                            idempotency_key). send_status can ONLY be
--                                            'not_sent_shadow' (CHECK). No foreign key into
--                                            send_queue; nothing reads this table to send.
-- Both tables: RLS enabled + forced, NO policies ⇒ only the service role (backend)
-- reads/writes; anon/authenticated get nothing. Masked text only (CHECK refuses a
-- phone-shaped digit run or an email in the message / draft columns).
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.conversation_ai_reply_policy (
  id                    smallint primary key default 1 check (id = 1),
  policy_version        text not null default 'conv-ai.policy.v1',
  enabled               boolean not null default false,
  shadow_enabled        boolean not null default false,
  kill_switch_engaged   boolean not null default true,
  scopes                jsonb not null default '{"market_ids":[],"campaign_ids":[],"asset_classes":["sfr"]}'::jsonb,
  allowed_categories    text[] not null default array['ownership_confirmed','who_is_this','interested','conditional_interest','not_interested','asking_price_provided','asks_offer','condition_disclosed','price_and_condition','acknowledgement'],
  never_categories      text[] not null default array['opt_out','hostile_or_legal','wrong_number','ownership_denied','counter_or_negotiation','multi_property'],
  models                jsonb not null default '{"default":"family:haiku@5.5","escalation":"family:sonnet@5.5"}'::jsonb,
  frequency             jsonb not null default '{"max_ai_replies_per_thread_per_day":1,"max_ai_replies_per_thread_total":4,"min_minutes_between_ai_replies":60,"max_ai_replies_per_day_global":0}'::jsonb,
  stage_bounds          jsonb not null default '{"min":"S1_ownership","max":"S4_condition"}'::jsonb,
  hours                 jsonb not null default '{"start_local_hour":8,"end_local_hour":21,"recipient_local":true}'::jsonb,
  budgets               jsonb not null default '{"daily_usd":0,"per_decision_max_usd":0.02,"monthly_usd":0}'::jsonb,
  min_confidence        numeric(4,3) not null default 0.850 check (min_confidence between 0 and 1),
  require_human_approval_for_money boolean not null default true check (require_human_approval_for_money),
  updated_at            timestamptz not null default now(),
  updated_by            text,
  -- R1/R2 have no send path: the row may not claim one is open
  constraint conversation_ai_policy_no_send_in_r1_r2 check (enabled = false)
);

insert into public.conversation_ai_reply_policy (id) values (1) on conflict (id) do nothing;

create table if not exists public.conversation_ai_shadow_decisions (
  id                    uuid primary key default gen_random_uuid(),
  idempotency_key       text not null unique check (idempotency_key ~ '^conv-ai:v1:.+$'),
  inbound_message_id    text not null,
  thread_ref            text check (thread_ref is null or thread_ref ~ '^thr_[a-p]{12}$'),
  property_ids          text[] not null default '{}',
  record_version        text not null default 'conv-ai.shadow.v1',
  contract_version      text not null,
  outcome               text not null check (outcome in ('NO_RESPONSE','UPDATE_ONLY','REPLY_CANDIDATE','ESCALATE_TO_SONNET','NEEDS_REVIEW','SUPPRESS')),
  intent                text not null,
  path                  text not null,
  models                text[] not null default '{}',
  validation_status     text not null check (validation_status in ('validated_draft','rejected_with_reasons','not_applicable')),
  validation_reasons    text[] not null default '{}',
  seller_message_masked text,
  draft_text            text,
  record                jsonb not null,
  cost_usd              numeric(10,6) not null default 0 check (cost_usd >= 0),
  latency_ms            integer check (latency_ms is null or latency_ms >= 0),
  send_status           text not null default 'not_sent_shadow' check (send_status = 'not_sent_shadow'),
  created_at            timestamptz not null default now(),
  constraint conversation_ai_shadow_masked check (
        coalesce(seller_message_masked, '') !~ '[0-9]{3}[^0-9]{0,4}[0-9]{3}[^0-9]{0,4}[0-9]{4}'
    and coalesce(draft_text, '')            !~ '[0-9]{3}[^0-9]{0,4}[0-9]{3}[^0-9]{0,4}[0-9]{4}'
    and coalesce(seller_message_masked, '') !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
    and coalesce(draft_text, '')            !~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  ),
  constraint conversation_ai_shadow_key_matches check (idempotency_key = 'conv-ai:v1:' || inbound_message_id)
);

create index if not exists conversation_ai_shadow_created_idx on public.conversation_ai_shadow_decisions (created_at desc);
create index if not exists conversation_ai_shadow_thread_idx on public.conversation_ai_shadow_decisions (thread_ref, created_at desc);
create index if not exists conversation_ai_shadow_outcome_idx on public.conversation_ai_shadow_decisions (outcome, created_at desc);

alter table public.conversation_ai_reply_policy enable row level security;
alter table public.conversation_ai_reply_policy force row level security;
alter table public.conversation_ai_shadow_decisions enable row level security;
alter table public.conversation_ai_shadow_decisions force row level security;
revoke all on public.conversation_ai_reply_policy from anon, authenticated;
revoke all on public.conversation_ai_shadow_decisions from anon, authenticated;

comment on table public.conversation_ai_shadow_decisions is 'Conversation Engine 2.0 R1/R2 shadow decisions. One row per inbound message. Never sent (send_status CHECK). Masked text only.';
comment on table public.conversation_ai_reply_policy is 'AI reply policy (separate from template auto-reply approval). enabled is CHECK-pinned false in R1/R2.';
