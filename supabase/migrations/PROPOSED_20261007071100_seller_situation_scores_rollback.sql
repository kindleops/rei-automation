-- PROPOSED ROLLBACK for PROPOSED_20261007071100_seller_situation_scores.sql.
-- Drops only the objects that migration created. Pause the runner first
-- (scripts/ops/seller-situation-backfill.mjs pause) so no chunk is mid-write.
BEGIN;
DROP TABLE IF EXISTS public.seller_situation_score_failures;
DROP TABLE IF EXISTS public.seller_situation_evidence_codes;
DROP TABLE IF EXISTS public.seller_situation_evidence_sources;
DROP TABLE IF EXISTS public.seller_situation_scores;
DELETE FROM public.system_control WHERE key IN ('seller_scoring_raw_facts', 'seller_situation_scoring_backfill');
COMMIT;
