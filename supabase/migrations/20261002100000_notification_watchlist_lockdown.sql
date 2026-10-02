-- NOTIFICATION WATCHLIST LOCKDOWN — PROPOSED, NOT APPLIED (2026-10-02).
--
-- STATUS: proposal only. The lead applies it with the owner. Small and
-- independent: it can ship before the Signal Center migration
-- (PROPOSED_20261001131000_signal_center.sql repeats it idempotently).
--
-- PURPOSE
--   Close a world-writable table. public.notification_watchlist has anon-only
--   policies USING (true) for SELECT / INSERT / UPDATE / DELETE, and anon +
--   authenticated hold ALL grants (incl. TRUNCATE). Anyone with the public anon
--   key can read the watched sellers' phone numbers and rewrite or wipe the
--   list; signed-in operators (role `authenticated`, no policy) cannot use it.
--
-- AFTER
--   service_role only. Operators read and write through apps/api:
--     GET/POST/DELETE /api/cockpit/signals/watches   (ensureMutationAuth:
--     Worker session + OPS_ALLOWED_USER_IDS allowlist)
--   The dashboard (lib/data/watchlistData.ts) already uses those routes, so this
--   breaks no live path — the direct browser path it replaces returned nothing
--   for signed-in operators.
--
-- RLS: enabled; anon + authenticated: no policies, REVOKE ALL; service_role:
--   explicit ALL policy.
-- VOLUME: 3 rows. No data change.
-- LOCK RISK: DROP POLICY / REVOKE / CREATE POLICY take a brief ACCESS EXCLUSIVE
--   on a 3-row table with no server writer — milliseconds. lock_timeout 5s.
--
-- ROLLBACK (re-opens the hole — only if the API route is reverted too)
--   begin;
--   drop policy if exists "watchlist service role" on public.notification_watchlist;
--   create policy "anon read watchlist"   on public.notification_watchlist for select to anon using (true);
--   create policy "anon write watchlist"  on public.notification_watchlist for insert to anon with check (true);
--   create policy "anon update watchlist" on public.notification_watchlist for update to anon using (true) with check (true);
--   create policy "anon delete watchlist" on public.notification_watchlist for delete to anon using (true);
--   grant select, insert, update, delete on public.notification_watchlist to anon, authenticated;
--   commit;

begin;
set local lock_timeout = '5s';

alter table public.notification_watchlist enable row level security;

drop policy if exists "anon read watchlist"   on public.notification_watchlist;
drop policy if exists "anon write watchlist"  on public.notification_watchlist;
drop policy if exists "anon update watchlist" on public.notification_watchlist;
drop policy if exists "anon delete watchlist" on public.notification_watchlist;

revoke all on public.notification_watchlist from anon, authenticated;
grant select, insert, update, delete on public.notification_watchlist to service_role;

drop policy if exists "watchlist service role" on public.notification_watchlist;
create policy "watchlist service role" on public.notification_watchlist
  for all to service_role using (true) with check (true);

commit;
