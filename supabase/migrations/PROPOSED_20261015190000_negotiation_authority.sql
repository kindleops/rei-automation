-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- LeadCommand 8.5.19 — NEGOTIATION AUTHORITY (owner directive 2026-10-15,
-- "8.5.16 NATIVE AI CONVERSATION ENGINE", Phase 8).
--
-- APPLY IN ONE TRANSACTION (no BEGIN/COMMIT here; the runner / psql wraps it):
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261015190000_negotiation_authority.sql
-- Tested ONLY on a disposable PostgreSQL:
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id negotiation_authority
-- Pretest:  PROPOSED_20261015190000_negotiation_authority_pretest.sql
-- Posttest: PROPOSED_20261015190000_negotiation_authority_posttest.sql
-- Rollback: PROPOSED_20261015190000_negotiation_authority_rollback.sql
--
-- WHAT IT CREATES (no existing table is altered; seller_offers stays THE formal
-- offer authority — the ledger below references its offer_id, it never copies it):
--
--   public.negotiation_envelopes            one VERSIONED, IMMUTABLE grant of negotiation
--                                           authority for ONE scope (thread + property):
--                                           max authorized price, opening price, allowed
--                                           terms (closing window, earnest money range,
--                                           as-is, who pays closing costs), move budget,
--                                           expiry, the granting operator and the approval
--                                           record (agent.approval_request id, capability
--                                           pipeline.grant_negotiation_envelope).
--                                           A change is a NEW version (supersedes the last);
--                                           UPDATE / DELETE / TRUNCATE are refused.
--   public.negotiation_envelope_revocations append-only: an envelope that is revoked.
--   public.negotiation_offer_events         the append-only negotiation LEDGER: every offer,
--                                           counteroffer, ask, acceptance, rejection with its
--                                           source (seller / engine / operator) and authority.
--                                           An ENGINE move must cite a live envelope of the
--                                           same scope and may never exceed its max price
--                                           (re-checked here, in the database).
--
-- PRIVACY: no phone numbers are stored. A scope is identified by
--   scope_key  = 'nscope_' || sha256(thread_key || '|' || property_id)   (computed by the app)
--   thread_ref = conversation-ai threadRef(thread_key)                    (thr_ + 12 letters)
-- All tables: RLS enabled + forced, NO policies ⇒ backend (service_role) only.
-- ════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ── envelopes ────────────────────────────────────────────────────────────────
create table public.negotiation_envelopes (
  envelope_id             uuid primary key default gen_random_uuid(),
  contract_version        text not null default 'negotiation.envelope.v1' check (contract_version = 'negotiation.envelope.v1'),
  scope_key               text not null check (scope_key ~ '^nscope_[0-9a-f]{64}$'),
  version                 integer not null check (version between 1 and 1000),
  thread_ref              text not null check (thread_ref ~ '^thr_[a-p]{12}$'),
  property_id             text not null check (length(property_id) between 1 and 80),
  opportunity_id          uuid,
  max_price               numeric(14,2) not null check (max_price > 0 and max_price < 1000000000),
  opening_price           numeric(14,2) check (opening_price is null or opening_price > 0),
  max_moves               integer not null default 3 check (max_moves between 1 and 10),
  closing_window_min_days integer not null check (closing_window_min_days between 1 and 365),
  closing_window_max_days integer not null check (closing_window_max_days between 1 and 365),
  earnest_money_min       numeric(12,2) not null check (earnest_money_min >= 0),
  earnest_money_max       numeric(12,2) not null check (earnest_money_max >= 0),
  as_is                   boolean not null default true,
  closing_costs_paid_by   text not null check (closing_costs_paid_by in ('buyer', 'seller', 'split')),
  valid_from              timestamptz not null default now(),
  expires_at              timestamptz not null,
  granted_by              text not null check (length(granted_by) between 1 and 80),
  approval_id             text not null unique check (approval_id ~ '^apr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  supersedes_envelope_id  uuid references public.negotiation_envelopes (envelope_id),
  underwriting            jsonb not null check (jsonb_typeof(underwriting) = 'object' and octet_length(underwriting::text) <= 16000),
  underwriting_hash       text not null check (underwriting_hash ~ '^[0-9a-f]{64}$'),
  envelope_hash           text not null check (envelope_hash ~ '^[0-9a-f]{64}$'),
  created_at              timestamptz not null default now(),
  constraint negotiation_envelopes_scope_version_key unique (scope_key, version),
  constraint negotiation_envelopes_opening_le_max check (opening_price is null or opening_price <= max_price),
  constraint negotiation_envelopes_window_order check (closing_window_max_days >= closing_window_min_days),
  constraint negotiation_envelopes_emd_order check (earnest_money_max >= earnest_money_min and earnest_money_max <= max_price),
  constraint negotiation_envelopes_expiry check (expires_at > valid_from and expires_at <= valid_from + interval '30 days'),
  constraint negotiation_envelopes_chain check ((version = 1) = (supersedes_envelope_id is null))
);
create index negotiation_envelopes_scope_idx on public.negotiation_envelopes (scope_key, version desc);
comment on table public.negotiation_envelopes is 'Negotiation authority (8.5.19): one immutable, versioned operator grant per scope (thread + property). A new grant is a new version; never updated or deleted. Written only after an approved agent.approval_request (capability pipeline.grant_negotiation_envelope).';

create table public.negotiation_envelope_revocations (
  envelope_id  uuid primary key references public.negotiation_envelopes (envelope_id),
  revoked_by   text not null check (length(revoked_by) between 1 and 80),
  reason       text not null check (length(reason) between 3 and 240),
  created_at   timestamptz not null default now()
);
comment on table public.negotiation_envelope_revocations is 'Append-only: an envelope that no longer grants authority. Never updated or deleted.';

-- ── ledger ───────────────────────────────────────────────────────────────────
create table public.negotiation_offer_events (
  event_id          uuid primary key default gen_random_uuid(),
  contract_version  text not null default 'negotiation.ledger.v1' check (contract_version = 'negotiation.ledger.v1'),
  scope_key         text not null check (scope_key ~ '^nscope_[0-9a-f]{64}$'),
  seq               integer not null check (seq >= 1),
  thread_ref        text not null check (thread_ref ~ '^thr_[a-p]{12}$'),
  property_id       text not null check (length(property_id) between 1 and 80),
  opportunity_id    uuid,
  event_type        text not null check (event_type in (
                      'seller_ask', 'seller_counter', 'seller_accept', 'seller_reject', 'seller_terms_request',
                      'our_anchor', 'our_offer', 'our_counter', 'our_final',
                      'withdrawn', 'expired', 'escalated')),
  actor             text not null check (actor in ('seller', 'engine', 'operator')),
  amount            numeric(14,2) check (amount is null or (amount > 0 and amount < 1000000000)),
  terms             jsonb not null default '{}'::jsonb check (jsonb_typeof(terms) = 'object' and octet_length(terms::text) <= 2000),
  authority         text not null check (authority in ('seller_stated', 'within_envelope', 'operator_direct', 'none')),
  envelope_id       uuid references public.negotiation_envelopes (envelope_id),
  operator_id       text check (operator_id is null or length(operator_id) between 1 and 80),
  quote_type        text check (quote_type is null or quote_type in ('FORMAL_OFFER', 'NEGOTIATION_ANCHOR', 'CONCESSION')),
  source_message_id text check (source_message_id is null or length(source_message_id) <= 120),
  seller_offer_id   text check (seller_offer_id is null or length(seller_offer_id) <= 160),
  justification     jsonb not null default '[]'::jsonb check (jsonb_typeof(justification) = 'array' and octet_length(justification::text) <= 4000),
  idempotency_key   text not null unique check (length(idempotency_key) between 8 and 200),
  created_at        timestamptz not null default now(),
  constraint negotiation_offer_events_scope_seq_key unique (scope_key, seq),
  constraint negotiation_offer_events_seller_authority check ((actor = 'seller') = (authority = 'seller_stated')),
  constraint negotiation_offer_events_engine_needs_envelope check (actor <> 'engine' or (authority = 'within_envelope' and envelope_id is not null)),
  constraint negotiation_offer_events_operator_named check (actor <> 'operator' or (operator_id is not null and authority in ('operator_direct', 'within_envelope'))),
  constraint negotiation_offer_events_envelope_authority check ((authority = 'within_envelope') = (envelope_id is not null)),
  constraint negotiation_offer_events_our_moves check (event_type not in ('our_anchor', 'our_offer', 'our_counter', 'our_final') or actor in ('engine', 'operator')),
  constraint negotiation_offer_events_seller_moves check (event_type not like 'seller\_%' or actor = 'seller'),
  constraint negotiation_offer_events_priced check (event_type not in ('seller_ask', 'seller_counter', 'our_anchor', 'our_offer', 'our_counter', 'our_final') or amount is not null)
);
create index negotiation_offer_events_scope_idx on public.negotiation_offer_events (scope_key, seq desc);
create index negotiation_offer_events_envelope_idx on public.negotiation_offer_events (envelope_id) where envelope_id is not null;
comment on table public.negotiation_offer_events is 'Negotiation ledger (8.5.19): append-only, gap-free per scope. Every move carries its source and authority. An engine move cites a live envelope of the same scope and never exceeds its max price (trigger). Formal offers link seller_offers.offer_id.';

-- ── guards ───────────────────────────────────────────────────────────────────
create or replace function public.negotiation_immutable_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception '% is append-only (% refused)', tg_table_name, tg_op using errcode = 'check_violation';
end
$$;

create or replace function public.negotiation_envelope_insert_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  prev record;
begin
  -- serialize grants for one scope (unique (scope_key, version) is the backstop)
  perform pg_advisory_xact_lock(hashtextextended(new.scope_key, 19));
  select envelope_id, version, thread_ref, property_id into prev
    from public.negotiation_envelopes where scope_key = new.scope_key order by version desc limit 1;
  if prev.envelope_id is null then
    if new.version <> 1 then raise exception 'first envelope of a scope is version 1' using errcode = 'check_violation'; end if;
  else
    if new.version <> prev.version + 1 or new.supersedes_envelope_id is distinct from prev.envelope_id then
      raise exception 'an envelope supersedes exactly the latest version of its scope' using errcode = 'check_violation';
    end if;
    if new.thread_ref <> prev.thread_ref or new.property_id <> prev.property_id then
      raise exception 'a scope never changes thread or property' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;

create or replace function public.negotiation_offer_event_insert_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  last_seq integer;
  env record;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.scope_key, 23));
  select coalesce(max(seq), 0) into last_seq from public.negotiation_offer_events where scope_key = new.scope_key;
  if new.seq <> last_seq + 1 then
    raise exception 'ledger seq must be % for this scope (got %)', last_seq + 1, new.seq using errcode = 'check_violation';
  end if;
  if new.envelope_id is not null then
    select e.*, (r.envelope_id is not null) as revoked into env
      from public.negotiation_envelopes e left join public.negotiation_envelope_revocations r on r.envelope_id = e.envelope_id
     where e.envelope_id = new.envelope_id;
    if env.envelope_id is null then raise exception 'envelope not found' using errcode = 'foreign_key_violation'; end if;
    if env.scope_key <> new.scope_key then raise exception 'envelope scope mismatch' using errcode = 'check_violation'; end if;
    if env.revoked then raise exception 'envelope revoked' using errcode = 'check_violation'; end if;
    if new.created_at < env.valid_from or new.created_at >= env.expires_at then raise exception 'envelope not live at event time' using errcode = 'check_violation'; end if;
    if exists (select 1 from public.negotiation_envelopes n where n.scope_key = env.scope_key and n.version > env.version) then
      raise exception 'envelope superseded' using errcode = 'check_violation';
    end if;
    if new.amount is not null and new.amount > env.max_price then
      raise exception 'amount above the envelope max price' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;

create trigger negotiation_envelopes_insert_guard before insert on public.negotiation_envelopes
  for each row execute function public.negotiation_envelope_insert_guard();
create trigger negotiation_envelopes_immutable before update or delete on public.negotiation_envelopes
  for each row execute function public.negotiation_immutable_guard();
create trigger negotiation_envelopes_no_truncate before truncate on public.negotiation_envelopes
  for each statement execute function public.negotiation_immutable_guard();
create trigger negotiation_envelope_revocations_immutable before update or delete on public.negotiation_envelope_revocations
  for each row execute function public.negotiation_immutable_guard();
create trigger negotiation_envelope_revocations_no_truncate before truncate on public.negotiation_envelope_revocations
  for each statement execute function public.negotiation_immutable_guard();
create trigger negotiation_offer_events_insert_guard before insert on public.negotiation_offer_events
  for each row execute function public.negotiation_offer_event_insert_guard();
create trigger negotiation_offer_events_immutable before update or delete on public.negotiation_offer_events
  for each row execute function public.negotiation_immutable_guard();
create trigger negotiation_offer_events_no_truncate before truncate on public.negotiation_offer_events
  for each statement execute function public.negotiation_immutable_guard();

-- ── access ───────────────────────────────────────────────────────────────────
alter table public.negotiation_envelopes enable row level security;
alter table public.negotiation_envelopes force row level security;
alter table public.negotiation_envelope_revocations enable row level security;
alter table public.negotiation_envelope_revocations force row level security;
alter table public.negotiation_offer_events enable row level security;
alter table public.negotiation_offer_events force row level security;
revoke all on public.negotiation_envelopes, public.negotiation_envelope_revocations, public.negotiation_offer_events from public, anon, authenticated, service_role;
grant select, insert on public.negotiation_envelopes, public.negotiation_envelope_revocations, public.negotiation_offer_events to service_role;
revoke all on function public.negotiation_immutable_guard() from public, anon, authenticated;
revoke all on function public.negotiation_envelope_insert_guard() from public, anon, authenticated;
revoke all on function public.negotiation_offer_event_insert_guard() from public, anon, authenticated;
