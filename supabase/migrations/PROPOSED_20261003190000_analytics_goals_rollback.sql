-- ROLLBACK for PROPOSED_20261003190000_analytics_goals.sql.
-- The table is new and nothing depends on it, so rollback is a drop (its
-- indexes and policy go with it). After rollback /api/cockpit/analytics/goals
-- answers goals_store_unavailable again and the dashboard keeps goals locally;
-- goal rows written while the table existed are lost (they are targets only —
-- no measured value was ever stored).
begin;
drop table if exists public.analytics_goals;
commit;
