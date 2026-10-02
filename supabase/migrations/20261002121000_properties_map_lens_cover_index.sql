-- =============================================================================
-- Map 8.2 — covering index for the property lenses (Radar, Territory, Opportunity …)
-- STATUS: PROPOSED (not applied). Apply with the owner present.
-- NON-TRANSACTIONAL: CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
--   Run each statement on its own (MCP execute_sql, one call per statement), NOT via
--   apply_migration / `supabase db push`, which wrap the file in a transaction.
-- Then record the version by hand if the migration history is kept in step.
-- =============================================================================
--
-- WHY
--   Radar is ambient: the dashboard reads it only below z10 (useMapLens.ts), i.e.
--   regional and national viewports that cover most of the 169,801 geocoded rows.
--   With the bbox fix (20261002120000) the predicate uses the index, but every
--   matching row still needs a heap fetch for its value column: ~12 s cold at
--   national zoom. Carrying the lens value columns in the index makes the scan
--   index-only (properties is 123,062 / 123,064 pages all-visible):
--   measured 664 ms national with the lat/lng-only index (enable_bitmapscan=off).
--
-- WHAT
--   btree (latitude, longitude) INCLUDE (property_id, every value the property
--   branch of get_map_lens_points reads), partial on geocoded rows.
--   Estimated size ≈ 25–30 MB (170K entries × ~110 bytes + btree overhead).
--   Build time: one pass over a 961 MB heap, ~20–60 s CONCURRENTLY; no write lock.
--
-- ALSO (optional, owner decision): properties carries three identical btree
--   (latitude, longitude) indexes. idx_properties_latitude_longitude has 0 scans
--   since stats reset (pg_stat_user_indexes, 2026-10-02); dropping it saves writes.
--   Left commented out on purpose.
--
-- ROLLBACK
--   drop index concurrently if exists public.idx_properties_map_lens_cover;
-- =============================================================================

create index concurrently if not exists idx_properties_map_lens_cover
  on public.properties using btree (latitude, longitude)
  include (property_id, equity_percent, estimated_value, year_built, structured_motivation_score,
           tag_distress_score, total_loan_balance, tax_delinquent)
  where latitude is not null and longitude is not null;

analyze public.properties;

-- optional:
-- drop index concurrently if exists public.idx_properties_latitude_longitude;
