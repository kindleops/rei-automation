-- lc-fixture: setup
-- DISPOSABLE DATABASE ONLY. The two live CHECK constraints of public.contact_property_resolution
-- (apps/api/supabase/migrations/20260912000000_contact_property_resolution.sql, inline CHECKs ⇒ these
-- auto names), added to the table created by campaign_target_graph_live_functions_baseline.sql, which
-- models only its columns / keys. Needed by PROPOSED_20261017100000 (it replaces the role CHECK).
-- Applied by scripts/db/run-migration-test.mjs as setup; never against Supabase.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.contact_property_resolution'::regclass and conname = 'contact_property_resolution_contact_property_role_check') then
    alter table public.contact_property_resolution add constraint contact_property_resolution_contact_property_role_check
      check (contact_property_role is null or contact_property_role in (
      'unknown', 'confirmed_owner', 'not_owner', 'former_owner',
      'referral_source', 'suppressed'
    ));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.contact_property_resolution'::regclass and conname = 'contact_property_resolution_suppression_scope_check') then
    alter table public.contact_property_resolution add constraint contact_property_resolution_suppression_scope_check
      check (suppression_scope is null or suppression_scope in ('contact_property_pair', 'channel_compliance'));
  end if;
end $$;
