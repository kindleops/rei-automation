-- =============================================================================
-- Buyer Match sales: mark the frozen recently-sold import LEGACY + zip read index
-- STATUS: PROPOSED (not applied). Apply with the owner present.
-- =============================================================================
--
-- WHY
--   Buyer Match (engine comps, the workspace comp panel, the buyer-command purchase
--   feed) now reads current canonical sales through ONE server adapter:
--   apps/api/src/lib/domain/buyer-match/buyer-match-sales.js -> public.mv_map_market_sales
--   (deduplicated comp_private.comp_canonical_transactions + the engine pool's MLS
--   closes; refreshed daily by pg_cron refresh_map_market_sales).
--   public.recently_sold_properties (55,893 rows, latest sale_date 2026-02-06, 30,791
--   rows with no positive price) is frozen and no longer a Buyer Match source. The one
--   remaining code reader is underwriting's fallback in acquisitionDecisionEngine.js,
--   which stays until a separate side-by-side comparison is run (allowlisted in
--   apps/api/tests/unit/buyer-match-sales-legacy-guard.test.mjs).
--
-- 1. Comments only (metadata; no data change, no lock beyond a brief catalog lock).
-- 2. The adapter's zip fallback (subjects with no coordinates) is a parallel seq scan
--    of the 665K-row MV today (~580 ms, EXPLAIN 2026-10-03). This index makes it an
--    index range scan. The geo path (the common one) already uses
--    mv_map_market_sales_geo (~6 ms warm). CREATE INDEX on the MV blocks REFRESH
--    (not reads) for its few seconds; do not apply during the 10:07 UTC refresh.
--
-- ROLLBACK:
--   comment on table public.recently_sold_properties is null;
--   comment on view public.recently_sold_properties_computed is null;
--   drop index if exists public.mv_map_market_sales_zip_sold_on;
-- POST-APPLY CHECK:
--   select obj_description('public.recently_sold_properties'::regclass);
--   explain select comp_id from public.mv_map_market_sales
--     where zip = '75044' and sold_on >= current_date - 730 and price > 0
--     order by sold_on desc limit 500;   -- expect Index Scan using mv_map_market_sales_zip_sold_on
-- =============================================================================

comment on table public.recently_sold_properties is
  'LEGACY (frozen 2026-02-06; 55,893 rows). Not a sales source for Buyer Match or any new code: read current canonical sales via public.mv_map_market_sales (server adapter apps/api/src/lib/domain/buyer-match/buyer-match-sales.js). Remaining reader: underwriting fallback in acquisitionDecisionEngine.js, pending a side-by-side comparison. A repo test fails on any new reference.';

comment on view public.recently_sold_properties_computed is
  'LEGACY: derived from the frozen public.recently_sold_properties (ends 2026-02-06). Do not read; use public.mv_map_market_sales.';

create index if not exists mv_map_market_sales_zip_sold_on
  on public.mv_map_market_sales (zip, sold_on desc);
