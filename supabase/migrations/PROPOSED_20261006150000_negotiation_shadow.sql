-- PROPOSED — NOT APPLIED. OWNER APPROVAL REQUIRED.
--
-- negotiation_shadow: the SHADOW signal-based negotiation opening
-- (NEGOTIATION_SIGNAL_OPENING, default OFF, shadow only). One row per
-- evaluation of an S3+ conversation or an offer-ready property: opening,
-- walk-away, fair floor, every signal with value / contribution / mode, the
-- planned ladder and the next move. NEVER sent; deliberately a separate table
-- from negotiation_quotes so a shadow number can never satisfy the Autopilot
-- v2 "monetary sends need a quote row" gate.
--
-- Writer (pure row builder): apps/api/src/lib/domain/seller-flow/negotiation-signal-shadow.js
-- Until applied, scripts/ops/negotiation-signal-opening-shadow.mjs writes the
-- same rows to a local JSONL file only.
-- Additive; no existing table changes. Rollback: drop table public.negotiation_shadow.

begin;
set local lock_timeout = '5s';

create table if not exists public.negotiation_shadow (
  id                         uuid primary key default gen_random_uuid(),
  shadow_key                 text not null unique,     -- <config_version>:<subject>:<thread|property>:<date>
  quote_type                 text not null default 'shadow_opening' check (quote_type = 'shadow_opening'),
  subject_kind               text not null check (subject_kind in ('s3_plus_conversation', 'offer_ready_property')),
  thread_key                 text,
  property_id                text not null,
  master_owner_id            text,
  seller_stage               text,
  offer_ready                boolean,                  -- lib/acquisition/offerReadiness.js verdict at evaluation
  offer_ready_reason         text,
  status                     text not null check (status in ('ok', 'hold')),
  reason                     text,
  opening                    numeric,
  walk_away                  numeric,
  max_offer_at_eval          numeric,                  -- engine effective_authorized_ceiling (MAO)
  recommended_offer_at_eval  numeric,
  fair_floor                 numeric,
  as_is_value                numeric,
  spread                     numeric,
  raw_spread                 numeric,
  latest_seller_ask          numeric,
  ask_position               text,
  signals                    jsonb not null default '[]'::jsonb,
  ladder                     jsonb not null default '[]'::jsonb,
  next_move                  jsonb,
  state                      text,
  market                     text,
  asset_class                text,
  engine_version             text not null,
  config_version             text not null,
  score_snapshot_id          text,
  score_computed_at          timestamptz,
  would_send                 boolean not null default false check (would_send = false),
  evaluated_at               timestamptz not null default now(),
  created_at                 timestamptz not null default now(),
  constraint negotiation_shadow_bounds check (
    status = 'hold'
    or (opening > 0 and opening <= walk_away and walk_away <= max_offer_at_eval and opening >= fair_floor)
  )
);

create index if not exists negotiation_shadow_property_idx on public.negotiation_shadow (property_id, evaluated_at desc);
create index if not exists negotiation_shadow_thread_idx on public.negotiation_shadow (thread_key, evaluated_at desc);

alter table public.negotiation_shadow enable row level security;
revoke all on public.negotiation_shadow from anon, authenticated;
grant select, insert, update on public.negotiation_shadow to service_role;

commit;

-- POSTCHECK (read-only):
--   select count(*) from public.negotiation_shadow;   -- 0
