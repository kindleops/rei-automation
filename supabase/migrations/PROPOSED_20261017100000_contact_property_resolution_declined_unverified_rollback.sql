-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261017100000_contact_property_resolution_declined_unverified.sql.
-- Restores the live six-value role CHECK exactly. REFUSES while any row carries
-- 'ownership_declined_unverified' (roll back the writers / the historical correction first): dropping the
-- value under live rows would invalidate them.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$
declare n int; def text;
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c
   where c.conrelid = 'public.contact_property_resolution'::regclass and c.conname = 'contact_property_resolution_contact_property_role_check';
  if def is null or position('ownership_declined_unverified' in def) = 0 then raise exception 'rollback precondition: the migration is not applied'; end if;
  select count(*) into n from public.contact_property_resolution where contact_property_role = 'ownership_declined_unverified';
  if n > 0 then raise exception 'rollback precondition: % row(s) carry ownership_declined_unverified; remove them first', n; end if;
end $$;
alter table public.contact_property_resolution drop constraint contact_property_resolution_contact_property_role_check;
alter table public.contact_property_resolution add constraint contact_property_resolution_contact_property_role_check
  check (contact_property_role is null or contact_property_role in (
      'unknown', 'confirmed_owner', 'not_owner', 'former_owner',
      'referral_source', 'suppressed'
    ));
commit;
