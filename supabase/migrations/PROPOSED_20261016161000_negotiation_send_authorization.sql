-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- LeadCommand 8.5.21 part B — a SEPARATE authorization for LIVE negotiation SENDING.
--
-- An envelope (public.negotiation_envelopes, 8.5.19) is the authority to NEGOTIATE inside
-- a ceiling. It is NOT permission to put a number in front of a seller. Owner rule
-- (8.5.21): "No financial offer is sent because an opening was computed. Live negotiation
-- sending needs its own distinct authorization (envelope + a separate send authorization)."
--
-- public.negotiation_send_authorizations — one IMMUTABLE grant, by a named operator through
-- its OWN approval record (capability pipeline.prepare_negotiation_send_authorization; the
-- approval id must differ from the envelope's), scoped to:
--   scope        the same thread + property as the envelope (scope_key / thread_ref / property_id)
--   envelope     envelope_id + envelope_version (a superseded or revoked envelope voids it)
--   ceiling      the most any SENT amount may be (≤ the envelope max price)
--   terms        the exact allowed terms (closing window, earnest money, as-is, closing costs)
--                + terms_hash; a send with other terms is outside the authorization
--   max_sends    how many priced messages it covers (1..10)
--   expiry       ≤ 7 days and never after the envelope expires
-- public.negotiation_send_authorization_revocations — append-only revocation.
-- Both: RLS enabled + forced, NO policies ⇒ service_role only; UPDATE / DELETE / TRUNCATE refused.
-- Nothing here sends: the negotiation composer (domain/negotiation/negotiation-composer.js)
-- refuses to render a priced draft unless a live envelope AND a live send authorization exist.
--
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261016161000_negotiation_send_authorization.sql
-- ORDER: after PROPOSED_20261015190000_negotiation_authority.sql.
-- Pretest:  PROPOSED_20261016161000_negotiation_send_authorization_pretest.sql
-- Posttest: PROPOSED_20261016161000_negotiation_send_authorization_posttest.sql
-- Rollback: PROPOSED_20261016161000_negotiation_send_authorization_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table public.negotiation_send_authorizations (
  send_authorization_id uuid primary key default gen_random_uuid(),
  contract_version      text not null default 'negotiation.send_authorization.v1' check (contract_version = 'negotiation.send_authorization.v1'),
  scope_key             text not null check (scope_key ~ '^nscope_[0-9a-f]{64}$'),
  thread_ref            text not null check (thread_ref ~ '^thr_[a-p]{12}$'),
  property_id           text not null check (length(property_id) between 1 and 80),
  envelope_id           uuid not null references public.negotiation_envelopes (envelope_id),
  envelope_version      integer not null check (envelope_version between 1 and 1000),
  ceiling               numeric(14,2) not null check (ceiling > 0 and ceiling < 1000000000),
  terms                 jsonb not null check (jsonb_typeof(terms) = 'object' and octet_length(terms::text) <= 2000),
  terms_hash            text not null check (terms_hash ~ '^[0-9a-f]{64}$'),
  max_sends             integer not null default 1 check (max_sends between 1 and 10),
  valid_from            timestamptz not null default now(),
  expires_at            timestamptz not null,
  granted_by            text not null check (length(granted_by) between 1 and 80),
  approval_id           text not null unique check (approval_id ~ '^apr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  authorization_hash    text not null check (authorization_hash ~ '^[0-9a-f]{64}$'),
  created_at            timestamptz not null default now(),
  constraint negotiation_send_authorizations_expiry check (expires_at > valid_from and expires_at <= valid_from + interval '7 days')
);
create index negotiation_send_authorizations_scope_idx on public.negotiation_send_authorizations (scope_key, created_at desc);
create index negotiation_send_authorizations_envelope_idx on public.negotiation_send_authorizations (envelope_id);
comment on table public.negotiation_send_authorizations is 'Live negotiation SEND authority (8.5.21): distinct from the envelope grant. Immutable; written only after its own approved agent.approval_request (capability pipeline.prepare_negotiation_send_authorization).';

create table public.negotiation_send_authorization_revocations (
  send_authorization_id uuid primary key references public.negotiation_send_authorizations (send_authorization_id),
  revoked_by            text not null check (length(revoked_by) between 1 and 80),
  reason                text not null check (length(reason) between 3 and 240),
  created_at            timestamptz not null default now()
);
comment on table public.negotiation_send_authorization_revocations is 'Append-only: a send authorization that no longer authorizes sending.';

create or replace function public.negotiation_send_authorization_insert_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare env record;
begin
  select e.*, (r.envelope_id is not null) as revoked into env
    from public.negotiation_envelopes e left join public.negotiation_envelope_revocations r on r.envelope_id = e.envelope_id
   where e.envelope_id = new.envelope_id;
  if env.envelope_id is null then raise exception 'envelope not found' using errcode = 'foreign_key_violation'; end if;
  if env.scope_key <> new.scope_key or env.thread_ref <> new.thread_ref or env.property_id <> new.property_id then
    raise exception 'send authorization scope must equal the envelope scope' using errcode = 'check_violation';
  end if;
  if env.version <> new.envelope_version then raise exception 'envelope version mismatch' using errcode = 'check_violation'; end if;
  if env.revoked then raise exception 'envelope revoked' using errcode = 'check_violation'; end if;
  if exists (select 1 from public.negotiation_envelopes n where n.scope_key = env.scope_key and n.version > env.version) then
    raise exception 'envelope superseded' using errcode = 'check_violation';
  end if;
  if new.ceiling > env.max_price then raise exception 'send ceiling above the envelope max price' using errcode = 'check_violation'; end if;
  if new.expires_at > env.expires_at then raise exception 'send authorization outlives its envelope' using errcode = 'check_violation'; end if;
  if new.approval_id = env.approval_id then raise exception 'a send authorization needs its own approval (not the envelope approval)' using errcode = 'check_violation'; end if;
  return new;
end
$$;

create trigger negotiation_send_authorizations_insert_guard before insert on public.negotiation_send_authorizations
  for each row execute function public.negotiation_send_authorization_insert_guard();
create trigger negotiation_send_authorizations_immutable before update or delete on public.negotiation_send_authorizations
  for each row execute function public.negotiation_immutable_guard();
create trigger negotiation_send_authorizations_no_truncate before truncate on public.negotiation_send_authorizations
  for each statement execute function public.negotiation_immutable_guard();
create trigger negotiation_send_authorization_revocations_immutable before update or delete on public.negotiation_send_authorization_revocations
  for each row execute function public.negotiation_immutable_guard();
create trigger negotiation_send_authorization_revocations_no_truncate before truncate on public.negotiation_send_authorization_revocations
  for each statement execute function public.negotiation_immutable_guard();

alter table public.negotiation_send_authorizations enable row level security;
alter table public.negotiation_send_authorizations force row level security;
alter table public.negotiation_send_authorization_revocations enable row level security;
alter table public.negotiation_send_authorization_revocations force row level security;
revoke all on public.negotiation_send_authorizations, public.negotiation_send_authorization_revocations from public, anon, authenticated, service_role;
grant select, insert on public.negotiation_send_authorizations, public.negotiation_send_authorization_revocations to service_role;
revoke all on function public.negotiation_send_authorization_insert_guard() from public, anon, authenticated;
