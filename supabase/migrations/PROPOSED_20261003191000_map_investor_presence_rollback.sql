-- ROLLBACK for PROPOSED_20261003191000_map_investor_presence.sql.
-- Both objects are new (nothing pre-existing is replaced), so rollback is a drop.
-- The API keeps working after rollback: it reads the same rows over its direct
-- Postgres connection (slower without the covering index).
DROP FUNCTION IF EXISTS public.get_map_investor_presence(double precision, double precision, double precision, double precision, double precision, date);
DROP INDEX IF EXISTS public.mv_map_market_sales_geo_presence;
