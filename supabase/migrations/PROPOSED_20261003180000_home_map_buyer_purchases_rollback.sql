-- ROLLBACK for PROPOSED_20261003180000_home_map_buyer_purchases.sql.
-- Both objects are new (nothing pre-existing is replaced), so rollback is a drop.
-- After rollback the Home Map "Buyer demand" lens returns available:false again.
DROP FUNCTION IF EXISTS public.home_map_buyer_purchases(date, date);
DROP INDEX IF EXISTS comp_private.mv_comp_market_evidence_buyer_date;
