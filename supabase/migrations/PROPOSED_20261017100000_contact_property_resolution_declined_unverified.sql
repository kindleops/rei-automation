-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- rc-8.5.21 — OWNER DECISION 2026-10-17 (supersedes 831df6cd): a polite "No thanks" to OUR ownership
-- question is declined engagement with ownership UNVERIFIED. It is recorded as a property × contact
-- no-recontact HOLD in public.contact_property_resolution:
--   contact_property_role = 'ownership_declined_unverified', suppression_scope = 'contact_property_pair',
--   rejected_at = NULL (it is NOT a rejection and NOT a non-ownership fact).
-- The live role CHECK (contact_property_resolution_contact_property_role_check, from
-- apps/api/supabase/migrations/20260912000000_contact_property_resolution.sql) refuses that value, so
-- the writer (contact-resolution-repository.js recordContactOutcome) fails closed until this applies.
--
-- ONE change: the role CHECK gains 'ownership_declined_unverified'. Every existing value stays allowed;
-- no row is written or changed. The suppression_scope CHECK is unchanged.
-- ORDER: any time after the table exists; in the rc-8.5.21 chain after the 8.5.21-b files, before the
-- 2026-10-17 historical ownership correction (which preconditions on this value).
--   psql "$DB" -v ON_ERROR_STOP=1 -f PROPOSED_20261017100000_contact_property_resolution_declined_unverified.sql
-- Pretest:  PROPOSED_20261017100000_contact_property_resolution_declined_unverified_pretest.sql
-- Posttest: PROPOSED_20261017100000_contact_property_resolution_declined_unverified_posttest.sql
-- Rollback: PROPOSED_20261017100000_contact_property_resolution_declined_unverified_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
declare def text;
begin
  if to_regclass('public.contact_property_resolution') is null then raise exception 'precondition: public.contact_property_resolution missing'; end if;
  select pg_get_constraintdef(c.oid) into def from pg_constraint c
   where c.conrelid = 'public.contact_property_resolution'::regclass and c.conname = 'contact_property_resolution_contact_property_role_check';
  if def is null then raise exception 'precondition: contact_property_resolution_contact_property_role_check missing'; end if;
  if position('ownership_declined_unverified' in def) > 0 then raise exception 'precondition: already applied (the role CHECK allows ownership_declined_unverified)'; end if;
  if not (def like '%''unknown''%' and def like '%''confirmed_owner''%' and def like '%''not_owner''%' and def like '%''former_owner''%' and def like '%''referral_source''%' and def like '%''suppressed''%') then
    raise exception 'precondition: the role CHECK drifted from the live six values: %', def;
  end if;
end $$;

alter table public.contact_property_resolution drop constraint contact_property_resolution_contact_property_role_check;
alter table public.contact_property_resolution add constraint contact_property_resolution_contact_property_role_check
  check (contact_property_role is null or contact_property_role in (
    'unknown', 'confirmed_owner', 'not_owner', 'former_owner', 'referral_source', 'suppressed',
    'ownership_declined_unverified'
  ));
comment on constraint contact_property_resolution_contact_property_role_check on public.contact_property_resolution is
  'ownership_declined_unverified (owner 2026-10-17): a polite decline to the ownership question — a property × contact hold, ownership UNVERIFIED; never a rejection (rejected_at stays NULL).';

do $$
declare def text;
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c
   where c.conrelid = 'public.contact_property_resolution'::regclass and c.conname = 'contact_property_resolution_contact_property_role_check';
  if def is null or position('ownership_declined_unverified' in def) = 0 then raise exception 'postcondition: the role CHECK must allow ownership_declined_unverified'; end if;
end $$;
commit;
