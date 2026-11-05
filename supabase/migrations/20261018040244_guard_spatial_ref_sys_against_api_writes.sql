-- ════════════════════════════════════════════════════════════════════════════
-- APPLIED IN PRODUCTION 2026-10-18T04:02:43Z (recorded version 20261018040244). DO NOT RE-APPLY.
-- lc-applied-in-production: true
--
-- This file is a RECORD of production history, not a migration to run. No chain, deploy plan, migration test or
-- deploy tool applies it: scripts/db/applied-in-production.mjs registers it, scripts/db/run-migration-test.mjs
-- refuses it, and tests/critical/applied-in-production-history.test.mjs pins all of that.
--
--   source:  a Claude Code session in the Prominent Cash Offer website project
--            (/Users/ryankindle/v0-v0realestatelandingsitemain, transcript session 0310cd0a), through the Supabase MCP
--            tool apply_migration, on the LeadCommand production project, after an interactive approval recorded in
--            that session at 2026-10-18T04:01:39Z ("Apply now"). Production migration history records this version
--            (Supabase list_migrations, read-only, 2026-10-20). It was never committed to this repository.
--
--   EFFECT:  EFFECTIVE. public.block_api_role_writes() (plpgsql, search_path '', not SECURITY DEFINER,
--            EXECUTE revoked from public / anon / authenticated) raises 42501 when current_user is anon or
--            authenticated; two statement-level triggers on public.spatial_ref_sys call it
--            (spatial_ref_sys_api_write_guard: insert / update / delete; spatial_ref_sys_api_truncate_guard:
--            truncate). Verified by the applying session (04:09Z, re-tested 07:27Z): anon REST DELETE / INSERT
--            refused 42501, SELECT works, 8500 rows intact, ST_Transform works, 2 guard triggers. The supabase_admin
--            write grants still exist; the durable fix is a Supabase support request (security plan SEC-02).
--
--   ROLLBACK: the applied SQL's comment lists it (drop both triggers, then the function). Running it RE-OPENS
--            anonymous writes to PostGIS's coordinate-system table: owner approval only, never automatic.
--
-- The SQL between the markers is BYTE-IDENTICAL to the applied statement (sha256 937f0dc1f6e850a1eb0f8b83dc76c093619793774fe2b8d55b35d27d743cccb1).
-- ════════════════════════════════════════════════════════════════════════════
-- ===== BEGIN APPLIED SQL (verbatim) =====
-- Security incident fix (approved 2026-10-17). The API roles (anon, authenticated) hold write grants on
-- PostGIS's spatial_ref_sys issued by supabase_admin, which the postgres role cannot revoke. A statement-level
-- guard refuses writes made as those roles; reads are untouched, and admin/service roles are unaffected.
-- Rollback:
--   DROP TRIGGER IF EXISTS spatial_ref_sys_api_write_guard ON public.spatial_ref_sys;
--   DROP TRIGGER IF EXISTS spatial_ref_sys_api_truncate_guard ON public.spatial_ref_sys;
--   DROP FUNCTION IF EXISTS public.block_api_role_writes();
create or replace function public.block_api_role_writes() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'writes to %.% are not permitted for API roles', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  return null;
end
$$;
revoke all on function public.block_api_role_writes() from public, anon, authenticated;

create trigger spatial_ref_sys_api_write_guard before insert or update or delete on public.spatial_ref_sys
  for each statement execute function public.block_api_role_writes();
create trigger spatial_ref_sys_api_truncate_guard before truncate on public.spatial_ref_sys
  for each statement execute function public.block_api_role_writes();
-- ===== END APPLIED SQL =====
