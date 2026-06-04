-- Chunked backfill for campaign_target_graph filter columns.
--
-- The previous full-table backfill updated extra_data on every row to fire
-- trg_campaign_target_graph_filter_columns. These batch functions keep that
-- trigger-based derivation, but only for graph_id cursor windows with missing
-- derived filter values.

CREATE OR REPLACE FUNCTION public.backfill_campaign_target_graph_filter_columns_batch(
  batch_limit integer DEFAULT 5000,
  after_graph_id text DEFAULT NULL
)
RETURNS TABLE(
  rows_selected integer,
  rows_updated integer,
  next_after_graph_id text,
  has_more boolean,
  elapsed_ms integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_started_at timestamptz := clock_timestamp();
  v_limit integer := LEAST(GREATEST(COALESCE(batch_limit, 5000), 1), 50000);
BEGIN
  WITH ranked AS (
    SELECT
      g.graph_id,
      row_number() OVER (ORDER BY g.graph_id) AS rn
    FROM public.campaign_target_graph g
    WHERE (after_graph_id IS NULL OR g.graph_id > after_graph_id)
      AND g.extra_data IS NOT NULL
      AND (
        g.units_count IS NULL
        OR g.tax_delinquent IS NULL
        OR g.active_lien IS NULL
        OR NULLIF(g.property_flags_text, '') IS NULL
        OR NULLIF(g.building_condition, '') IS NULL
        OR NULLIF(g.owner_type, '') IS NULL
        OR g.is_corporate_owner IS NULL
        OR g.out_of_state_owner IS NULL
        OR NULLIF(g.gender, '') IS NULL
        OR NULLIF(g.marital_status, '') IS NULL
        OR NULLIF(g.net_asset_value, '') IS NULL
        OR NULLIF(g.buying_power, '') IS NULL
        OR g.email_eligible IS NULL
      )
    ORDER BY g.graph_id
    LIMIT v_limit + 1
  ),
  selected AS (
    SELECT r.graph_id
    FROM ranked r
    WHERE r.rn <= v_limit
    ORDER BY r.graph_id
  ),
  updated AS (
    UPDATE public.campaign_target_graph g
    SET extra_data = g.extra_data
    FROM selected s
    WHERE g.graph_id = s.graph_id
    RETURNING g.graph_id
  )
  SELECT
    (SELECT COUNT(*)::integer FROM selected),
    (SELECT COUNT(*)::integer FROM updated),
    (SELECT s.graph_id FROM selected s ORDER BY s.graph_id DESC LIMIT 1),
    EXISTS (SELECT 1 FROM ranked r WHERE r.rn > v_limit)
  INTO rows_selected, rows_updated, next_after_graph_id, has_more;

  elapsed_ms := GREATEST(0, floor(EXTRACT(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer);
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.backfill_campaign_target_graph_stage_filter_columns_batch(
  batch_limit integer DEFAULT 5000,
  after_graph_id text DEFAULT NULL
)
RETURNS TABLE(
  rows_selected integer,
  rows_updated integer,
  next_after_graph_id text,
  has_more boolean,
  elapsed_ms integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_started_at timestamptz := clock_timestamp();
  v_limit integer := LEAST(GREATEST(COALESCE(batch_limit, 5000), 1), 50000);
BEGIN
  WITH ranked AS (
    SELECT
      g.graph_id,
      row_number() OVER (ORDER BY g.graph_id) AS rn
    FROM public.campaign_target_graph_stage g
    WHERE (after_graph_id IS NULL OR g.graph_id > after_graph_id)
      AND g.extra_data IS NOT NULL
      AND (
        g.units_count IS NULL
        OR g.tax_delinquent IS NULL
        OR g.active_lien IS NULL
        OR NULLIF(g.property_flags_text, '') IS NULL
        OR NULLIF(g.building_condition, '') IS NULL
        OR NULLIF(g.owner_type, '') IS NULL
        OR g.is_corporate_owner IS NULL
        OR g.out_of_state_owner IS NULL
        OR NULLIF(g.gender, '') IS NULL
        OR NULLIF(g.marital_status, '') IS NULL
        OR NULLIF(g.net_asset_value, '') IS NULL
        OR NULLIF(g.buying_power, '') IS NULL
        OR g.email_eligible IS NULL
      )
    ORDER BY g.graph_id
    LIMIT v_limit + 1
  ),
  selected AS (
    SELECT r.graph_id
    FROM ranked r
    WHERE r.rn <= v_limit
    ORDER BY r.graph_id
  ),
  updated AS (
    UPDATE public.campaign_target_graph_stage g
    SET extra_data = g.extra_data
    FROM selected s
    WHERE g.graph_id = s.graph_id
    RETURNING g.graph_id
  )
  SELECT
    (SELECT COUNT(*)::integer FROM selected),
    (SELECT COUNT(*)::integer FROM updated),
    (SELECT s.graph_id FROM selected s ORDER BY s.graph_id DESC LIMIT 1),
    EXISTS (SELECT 1 FROM ranked r WHERE r.rn > v_limit)
  INTO rows_selected, rows_updated, next_after_graph_id, has_more;

  elapsed_ms := GREATEST(0, floor(EXTRACT(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer);
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_campaign_target_graph_filter_columns_batch(integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backfill_campaign_target_graph_stage_filter_columns_batch(integer, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.backfill_campaign_target_graph_filter_columns_batch(integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.backfill_campaign_target_graph_stage_filter_columns_batch(integer, text) TO service_role;
