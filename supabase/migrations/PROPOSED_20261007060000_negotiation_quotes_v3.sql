-- PROPOSED — NOT APPLIED. OWNER APPROVAL REQUIRED. Apply AFTER
-- PROPOSED_20261006120000_negotiation_quotes.sql and
-- PROPOSED_20261007042000_negotiation_quotes_observed_offer.sql.
--
-- NEGOTIATION ENGINE v3 (owner brief §49–50): every number is logged BEFORE
-- send with the full plan context, and a failed write blocks the send
-- (apps/api/src/lib/domain/negotiation-v3/quote-log.js logQuoteThenSend).
--   quote_type 'concession'  a ladder step after the anchor (≠ formal offer)
--   quote_type 'no_number'   a negotiation turn that deliberately carried no number
-- New columns: target / autonomous limit / fair floor at quote time, previous
-- LC amount, per-unit range + unit count (MF), negotiation engine + config
-- versions, seller-situation score_version, language branch, situation /
-- market / condition evidence, human approval.
-- DB invariant (automated rows): amount ≤ autonomous_limit_at_quote ≤ max_offer_at_quote,
-- unless a human approved it (approved_by). Additive. Rollback: _rollback.sql.

begin;
set local lock_timeout = '5s';

alter table public.negotiation_quotes
  add column if not exists target_at_quote            numeric,
  add column if not exists autonomous_limit_at_quote  numeric,
  add column if not exists fair_floor_at_quote        numeric,
  add column if not exists previous_lc_amount         numeric,
  add column if not exists unit_count                 integer check (unit_count is null or unit_count >= 2),
  add column if not exists per_unit_low               numeric,
  add column if not exists per_unit_high              numeric,
  add column if not exists negotiation_engine_version text,
  add column if not exists negotiation_config_version text,
  add column if not exists score_version              text,      -- seller-situation model (never a price input)
  add column if not exists language_branch            text,      -- numbers | comps | per_unit | creative | unrealistic_close | confirm_basics | discovery
  add column if not exists condition_evidence         jsonb not null default '{}'::jsonb,
  add column if not exists situation_evidence         jsonb not null default '{}'::jsonb,
  add column if not exists market_evidence            jsonb not null default '{}'::jsonb,
  add column if not exists approved_by                text,      -- operator who approved a number above the autonomous limit
  add column if not exists approved_at                timestamptz;

alter table public.negotiation_quotes drop constraint if exists negotiation_quotes_quote_type_check;
alter table public.negotiation_quotes add constraint negotiation_quotes_quote_type_check
  check (quote_type in ('anchor', 'concession', 'formal_offer', 'confirm_basics_no_number', 'no_number', 'observed_offer'));

alter table public.negotiation_quotes drop constraint if exists negotiation_quotes_amount_by_type;
alter table public.negotiation_quotes add constraint negotiation_quotes_amount_by_type check (
  (quote_type in ('confirm_basics_no_number', 'no_number') and amount is null)
  or (quote_type = 'observed_offer' and amount > 0)
  or (quote_type in ('anchor', 'concession', 'formal_offer') and amount > 0 and max_offer_at_quote > 0 and amount <= max_offer_at_quote)
);

-- Autonomy bound: an automated v3 number never exceeds the autonomous limit
-- recorded with it unless a human approved it. Rows without the v3 columns
-- (Autopilot v2 writer) are unaffected.
alter table public.negotiation_quotes drop constraint if exists negotiation_quotes_autonomous_bound;
alter table public.negotiation_quotes add constraint negotiation_quotes_autonomous_bound check (
  autonomous_limit_at_quote is null
  or amount is null
  or approved_by is not null
  or (amount <= autonomous_limit_at_quote and autonomous_limit_at_quote <= max_offer_at_quote)
);

commit;

-- POSTCHECK (read-only):
--   select conname from pg_constraint where conrelid = 'public.negotiation_quotes'::regclass order by 1;
--   select count(*) filter (where quote_type in ('concession','no_number')) from public.negotiation_quotes;  -- 0
