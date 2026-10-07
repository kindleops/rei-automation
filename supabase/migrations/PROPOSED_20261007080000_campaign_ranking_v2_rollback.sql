-- ROLLBACK for PROPOSED_20261007080000_campaign_ranking_v2.sql (A2). Not applied.
-- Removes only what that file added; acquisition_score and every legacy
-- column/order are untouched, so builds fall back to the legacy order.
DROP FUNCTION IF EXISTS public.campaign_zip_discovery(text, text, text, integer);
DROP VIEW IF EXISTS public.v_campaign_zip_discovery_v1;
DROP FUNCTION IF EXISTS public.campaign_target_graph_project_rank_v2(text, integer);
DROP INDEX CONCURRENTLY IF EXISTS public.campaign_target_graph_rank_v2_idx;

BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
ALTER TABLE public.campaign_target_graph
  DROP COLUMN IF EXISTS campaign_rank_v2_at,
  DROP COLUMN IF EXISTS campaign_rank_v2_source,
  DROP COLUMN IF EXISTS campaign_rank_v2_priority,
  DROP COLUMN IF EXISTS campaign_rank_v2_score,
  DROP COLUMN IF EXISTS equity_class,
  DROP COLUMN IF EXISTS equity_known_pct,
  DROP COLUMN IF EXISTS contact_confidence,
  DROP COLUMN IF EXISTS matching_tag,
  DROP COLUMN IF EXISTS market_quality,
  DROP COLUMN IF EXISTS situation_score_version,
  DROP COLUMN IF EXISTS sell_p365,
  DROP COLUMN IF EXISTS forced_sale_pressure,
  DROP COLUMN IF EXISTS seller_situation,
  DROP COLUMN IF EXISTS opportunity_tier;
DROP VIEW IF EXISTS public.v_zip_market_quality_v1;
DROP FUNCTION IF EXISTS public.campaign_rank_v2_priority(numeric, numeric, numeric, numeric);
DROP FUNCTION IF EXISTS public.campaign_rank_v2_deal(numeric, text, numeric);
DROP FUNCTION IF EXISTS public.campaign_rank_v2_pressure(text, numeric, numeric, integer, numeric, numeric);
DROP FUNCTION IF EXISTS public.campaign_matching_tag_class(text, boolean);
DROP FUNCTION IF EXISTS public.campaign_rank_v2_contact(text, text, text, text, integer);
DROP FUNCTION IF EXISTS public.campaign_identity_tier(text, text);
DROP FUNCTION IF EXISTS public.campaign_equity_class(numeric, numeric, text);
DROP FUNCTION IF EXISTS public.campaign_equity_known_pct(numeric, numeric, text);
-- v2.0 signatures (if a v2.0 draft was ever applied)
DROP FUNCTION IF EXISTS public.campaign_rank_v2_priority(text, numeric, numeric);
DROP FUNCTION IF EXISTS public.campaign_rank_v2_score(numeric, numeric, integer, numeric, numeric, numeric, numeric, numeric);
DROP FUNCTION IF EXISTS public.campaign_rank_v2_contact(text, text, text);
COMMIT;
