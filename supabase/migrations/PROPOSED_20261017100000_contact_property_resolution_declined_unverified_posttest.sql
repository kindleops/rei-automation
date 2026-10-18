-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261017100000_contact_property_resolution_declined_unverified.sql.
-- Inside BEGIN … ROLLBACK. DISPOSABLE DATABASE ONLY.
\set ON_ERROR_STOP on
begin;
do $$
declare ok boolean;
begin
  -- the declined hold row: role ownership_declined_unverified, pair scope, rejected_at NULL
  insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role, rejected_at, suppression_scope)
  values ('P-MT-DECL', '+15550000771', 'ownership_declined_unverified', null, 'contact_property_pair');
  assert (select count(*) from public.contact_property_resolution where property_id = 'P-MT-DECL' and rejected_at is null) = 1, 'the declined hold is never a rejection';
  -- every live value still allowed, an unknown value still refused
  insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role) values
    ('P-MT-1', '+15550000772', 'unknown'), ('P-MT-2', '+15550000773', 'confirmed_owner'), ('P-MT-3', '+15550000774', 'not_owner'),
    ('P-MT-4', '+15550000775', 'former_owner'), ('P-MT-5', '+15550000776', 'referral_source'), ('P-MT-6', '+15550000777', 'suppressed');
  ok := false;
  begin insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role) values ('P-MT-X', '+15550000778', 'declined');
  exception when check_violation then ok := true; end;
  assert ok, 'an unlisted role is still refused';
  raise notice 'posttest(contact_property_resolution_declined_unverified): ALL OK (rolled back)';
end $$;
rollback;
