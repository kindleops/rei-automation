-- ROLLBACK for PROPOSED_20261007090000_ranking_shadow_support.sql (migration (a)).
-- Drops ONLY the objects (a) created. No existing table is touched; nothing
-- reads these objects for ordering, so rollback cannot change any campaign order.
DROP INDEX CONCURRENTLY IF EXISTS public.campaign_test_cohort_members_property_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.campaign_test_cohort_members_arm_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.campaign_rank_shadow_version_priority_idx;
BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
DROP VIEW IF EXISTS public.v_property_deal_outcome_v1;
DROP VIEW IF EXISTS public.v_property_first_touch_v1;
DROP TABLE IF EXISTS public.campaign_test_checkpoints;
DROP TABLE IF EXISTS public.campaign_test_cohort_members;
DROP TABLE IF EXISTS public.campaign_test_cohorts;
DROP TABLE IF EXISTS public.campaign_rank_shadow;
COMMIT;
