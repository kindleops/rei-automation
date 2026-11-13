-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST: the live six-value CHECK is back (the runner also compares the
-- schema fingerprint). Read-only. DISPOSABLE DATABASE ONLY.
do $$
declare def text;
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c
   where c.conrelid = 'public.contact_property_resolution'::regclass and c.conname = 'contact_property_resolution_contact_property_role_check';
  assert def is not null and position('ownership_declined_unverified' in def) = 0, 'rb: the live six-value role CHECK restored';
end $$;
