-- PROPOSED — NOT APPLIED. OWNER APPROVAL REQUIRED. PREREQUISITE for any
-- Seller Autopilot v2 number (the writer fails closed without this table).
--
-- negotiation_quotes: every number put to a seller, with its evidence, and a
-- NEGOTIATION ANCHOR kept apart from a FORMAL OFFER (seller_offers). An anchor
-- ("as-is sales nearby are around $X" / "we'd need to be around $X") is never
-- written as the active formal offer; a formal offer keeps its seller_offers
-- version AND gets a quote row linked by seller_offer_id.
--
-- Writer: apps/api/src/lib/domain/seller-flow/negotiation-quotes.js
-- Reader: Deal Intelligence decision surface ("Anchor $185K quoted 10-06 (rule: above_max)").
-- Additive; no existing table changes. Rollback: drop table public.negotiation_quotes.

begin;
set local lock_timeout = '5s';

create table if not exists public.negotiation_quotes (
  id                          uuid primary key default gen_random_uuid(),
  quote_key                   text not null unique,              -- idempotency: <inbound event>:<template>
  quote_type                  text not null check (quote_type in ('anchor', 'formal_offer', 'confirm_basics_no_number')),
  amount                      numeric,
  max_offer_at_quote          numeric,                            -- engine effective_authorized_ceiling at quote time
  recommended_offer_at_quote  numeric,
  engine                      text not null default 'acquisition_decision_engine',
  engine_version              text,
  score_snapshot_id           text,
  score_computed_at           timestamptz,
  decision_tier               text,
  rule_branch                 text not null,                      -- e.g. lowest_nearby_as_is_comp | average_of_3_lowest_non_outlier_comps | above_max | legacy_comp_anchor
  comp_ids                    text[] not null default '{}',
  comp_prices                 numeric[] not null default '{}',
  asking_price                numeric,
  language                    text,
  template_id                 text,
  use_case                    text,
  send_queue_key              text,                               -- send_queue.queue_key of the message that carried it
  inbound_message_event_id    text,
  thread_key                  text not null,
  property_id                 text,
  master_owner_id             text,
  opportunity_id              text,
  seller_offer_id             text,                               -- formal offers only
  evidence                    jsonb not null default '{}'::jsonb,
  quoted_at                   timestamptz not null default now(),
  created_at                  timestamptz not null default now(),
  constraint negotiation_quotes_amount_by_type check (
    (quote_type = 'confirm_basics_no_number' and amount is null)
    or (quote_type <> 'confirm_basics_no_number' and amount > 0 and max_offer_at_quote > 0 and amount <= max_offer_at_quote)
  )
);

create index if not exists negotiation_quotes_property_quoted_idx on public.negotiation_quotes (property_id, quoted_at desc);
create index if not exists negotiation_quotes_thread_quoted_idx on public.negotiation_quotes (thread_key, quoted_at desc);

alter table public.negotiation_quotes enable row level security;
revoke all on public.negotiation_quotes from anon, authenticated;
grant select, insert, update on public.negotiation_quotes to service_role;

commit;

-- POSTCHECK (read-only):
--   select count(*) from public.negotiation_quotes;   -- 0
--   select conname from pg_constraint where conrelid = 'public.negotiation_quotes'::regclass;
