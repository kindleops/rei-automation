-- ════════════════════════════════════════════════════════════════════════════
-- CANONICAL MARKET GEOGRAPHY — campaign audiences.
--
-- campaign_targets were materialised from the graph while it still carried
-- locality labels: 302 rows (297 blocked, 5 ready) read "Hialeah, FL",
-- "Long Beach, CA", "Tuscon, AZ"… Each resolves to exactly the market its
-- property now holds, so the target takes the property's canonical market.
-- Targets are an audience snapshot, not transport history — send_queue and
-- message_events keep their written labels and are derived at read time.
--
-- Idempotent (only rows that differ); every change logged with its old label.
-- ROLLBACK:
--   UPDATE campaign_targets t SET market = l.old_market
--   FROM canonical_market_backfill_log l
--   WHERE l.table_name = 'campaign_targets' AND l.row_id = t.id::text;
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.campaign_targets DISABLE TRIGGER trg_campaign_targets_updated_at;

INSERT INTO public.canonical_market_backfill_log (table_name, row_id, old_market, new_market_id, new_market, source)
SELECT 'campaign_targets', t.id::text, t.market, p.canonical_market_id, p.market, 'properties.canonical_market_id'
FROM public.campaign_targets t
JOIN public.properties p ON p.property_id = t.property_id
WHERE t.market IS NOT NULL
  AND p.market IS NOT NULL
  AND t.market IS DISTINCT FROM p.market
  AND NOT EXISTS (SELECT 1 FROM public.canonical_markets m WHERE m.display_name = t.market);

UPDATE public.campaign_targets t
SET market = p.market
FROM public.properties p
WHERE p.property_id = t.property_id
  AND t.market IS NOT NULL
  AND p.market IS NOT NULL
  AND t.market IS DISTINCT FROM p.market
  AND NOT EXISTS (SELECT 1 FROM public.canonical_markets m WHERE m.display_name = t.market);

ALTER TABLE public.campaign_targets ENABLE TRIGGER trg_campaign_targets_updated_at;
