-- PROPOSED — NOT APPLIED (2026-10-07, composer filter audit). Owner applies, off-peak.
--
-- WHY: a Composer count with ONE filter and no market takes 3–8 s, and 9 of the
-- 73 offered filters crossed the 8 s PostgREST role timeout during the audit
-- (property_class 8.2 s; total_loan_balance, aos_score, decision_tier,
-- acquisition_confidence, transaction_probability_365, best_strategy,
-- matching_flags, person_flags_text -> statement timeout). The same filter inside
-- one market answers in 0.2–0.9 s (idx on market).
--
-- Measured (EXPLAIN ANALYZE, 2026-10-07 ~12:40Z):
--   heap 544 MB for 177k rows (2.1 KB/row: extra_data 750 B, blocker_flags 330 B),
--   30.8k dead tuples, visibility map 47,007 / 69,597 pages all-visible.
--   building_condition = 'Poor' (indexed): Index Scan + Filter (property_id IS NOT NULL)
--     -> 5,597 heap pages read, 2.9 s.  Without the IS NOT NULL qual the planner picks an
--     Index Only Scan, but 10,908 heap fetches (VM stale) still cost 3.3 s.
--   property_class = 'Commercial' (no index): Seq Scan of 69.6k pages, 3.6 s cold.
--
-- Every Composer count carries `property_id IS NOT NULL` (require_linked_property,
-- added whenever catalog filters are present). property_id is non-null on every
-- graph AND stage row today (0 / 176,605; 0 / 172,500). PostgreSQL 17 drops an
-- IS NOT NULL qual on a NOT NULL column, which turns these counts into index-only
-- scans; a fresh visibility map makes those index-only scans heap-free.
--
-- §1 property_id NOT NULL without a long lock: CHECK NOT VALID -> VALIDATE (SHARE
--    UPDATE EXCLUSIVE, writes continue) -> SET NOT NULL (uses the validated check,
--    no scan, brief ACCESS EXCLUSIVE) -> drop the check.
--    OWNER DECISION: a future build that inserts a row without a property would fail
--    instead of producing an unaddressable row. Every build path writes property_id today.
-- §2 single-column btree indexes on offered filter columns that have none
--    (CONCURRENTLY; run each statement on its own, outside a transaction).
-- §3 keep the visibility map fresh on this hot, rewritten table.
-- §4 one VACUUM (ANALYZE) after the person/property re-projection backfill finishes.
--
-- Expected: one-filter national counts from 3–8 s to well under 1 s
-- (verify with the EXPLAINs at the bottom).
--
-- Rollback: DROP INDEX CONCURRENTLY each §2 index; ALTER TABLE ... ALTER COLUMN
-- property_id DROP NOT NULL; ALTER TABLE ... RESET (autovacuum_*).

-- §1 ------------------------------------------------------------------------
SET lock_timeout = '3s';
ALTER TABLE public.campaign_target_graph
  ADD CONSTRAINT ctg_property_id_present CHECK (property_id IS NOT NULL) NOT VALID;
ALTER TABLE public.campaign_target_graph VALIDATE CONSTRAINT ctg_property_id_present;
ALTER TABLE public.campaign_target_graph ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE public.campaign_target_graph DROP CONSTRAINT ctg_property_id_present;
RESET lock_timeout;

-- §2 (each on its own; CONCURRENTLY cannot run inside a transaction block) -----
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_property_class ON public.campaign_target_graph (property_class);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_rehab_level ON public.campaign_target_graph (rehab_level);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_building_quality ON public.campaign_target_graph (building_quality);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_owner_type ON public.campaign_target_graph (owner_type);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_property_city ON public.campaign_target_graph (property_city);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_property_zip ON public.campaign_target_graph (property_zip);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_property_county_name ON public.campaign_target_graph (property_county_name);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_estimated_value ON public.campaign_target_graph (estimated_value);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_equity_percent ON public.campaign_target_graph (equity_percent);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_equity_amount ON public.campaign_target_graph (equity_amount);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_total_loan_balance ON public.campaign_target_graph (total_loan_balance);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_year_built ON public.campaign_target_graph (year_built);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_ownership_years ON public.campaign_target_graph (ownership_years);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_building_sqft ON public.campaign_target_graph (building_sqft);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_beds ON public.campaign_target_graph (beds);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_aos_score ON public.campaign_target_graph (aos_score) WHERE aos_score IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_decision_tier ON public.campaign_target_graph (decision_tier) WHERE decision_tier IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_gender ON public.campaign_target_graph (gender);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_age_bucket ON public.campaign_target_graph (age_bucket);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_income ON public.campaign_target_graph (income);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_marital_status ON public.campaign_target_graph (marital_status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_phone_type ON public.campaign_target_graph (phone_type);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_phone_owner ON public.campaign_target_graph (phone_owner);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_routing_tier ON public.campaign_target_graph (routing_tier);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_sender_market ON public.campaign_target_graph (sender_market);

-- §3 ------------------------------------------------------------------------
ALTER TABLE public.campaign_target_graph SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);

-- §4 (after the re-projection backfill) ---------------------------------------
-- VACUUM (ANALYZE) public.campaign_target_graph;

-- Verify (read-only):
--   EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM campaign_target_graph
--    WHERE property_id IS NOT NULL AND building_condition = 'Poor';
--     -- expect: Index Only Scan, Heap Fetches ~0, < 100 ms
--   EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM campaign_target_graph
--    WHERE property_id IS NOT NULL AND property_class = 'Commercial';
--     -- expect: Index Only Scan on idx_ctg_property_class
