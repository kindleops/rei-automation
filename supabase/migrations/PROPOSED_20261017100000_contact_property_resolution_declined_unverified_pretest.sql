-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261017100000_contact_property_resolution_declined_unverified.sql.
-- Read-only. DISPOSABLE DATABASE ONLY.
do $$
declare def text;
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c
   where c.conrelid = 'public.contact_property_resolution'::regclass and c.conname = 'contact_property_resolution_contact_property_role_check';
  assert def is not null, 'pretest: the live role CHECK exists';
  assert position('ownership_declined_unverified' in def) = 0, 'pretest: not applied yet';
  assert not exists (select 1 from public.contact_property_resolution where contact_property_role = 'ownership_declined_unverified'), 'pretest: no declined rows';
end $$;
