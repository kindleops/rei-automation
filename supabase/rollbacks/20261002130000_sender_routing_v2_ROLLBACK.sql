-- Rollback for 20261002130000_sender_routing_v2 (and its seed 20261002130100).
-- Safe at any time: with the tables gone the router's graph loader latches
-- "schema unavailable" and the legacy router keeps running unchanged.
-- textgrid_numbers metadata/registration_status written by the seed are left
-- in place (the legacy router does not read them); revert them by hand if wanted.
begin;
drop function if exists public.sender_routing_replace_market_routes(text, jsonb, text, text);
drop table if exists public.sender_routing_overrides;
drop table if exists public.market_sender_routes;
drop table if exists public.sender_pool_numbers;
drop table if exists public.sender_pools;
drop table if exists public.sender_routing_audit;
drop sequence if exists public.sender_routing_graph_version_seq;
drop function if exists public.sender_routing_touch_updated_at();
delete from public.system_control where key in ('sender_routing_v2_enabled', 'sender_routing_wake_apply', 'sender_routing_graph_writes');
commit;
