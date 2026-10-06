-- PROPOSED rollback for PROPOSED_20261006150300_command_wall_displays.sql.
-- Drops the Command Wall registry; every paired display falls back to its pairing screen.
-- select cron.unschedule('command_wall_housekeeping');  -- only if it was scheduled
drop table if exists public.command_wall_audit;
drop table if exists public.command_wall_pairings;
drop table if exists public.command_wall_displays;
