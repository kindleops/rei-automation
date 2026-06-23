BEGIN;

-- Canonical markets: prefer market_region (operating market), fall back to raw market label.
CREATE OR REPLACE VIEW public.v_entity_graph_markets AS
SELECT
  COALESCE(NULLIF(TRIM(market_region), ''), TRIM(market)) AS market_key,
  COALESCE(NULLIF(TRIM(market_region), ''), TRIM(market)) AS canonical_market,
  MAX(TRIM(market)) AS sample_locality,
  MAX(TRIM(property_address_state)) AS state,
  COUNT(*)::bigint AS property_count
FROM public.properties
WHERE COALESCE(NULLIF(TRIM(market_region), ''), NULLIF(TRIM(market), '')) IS NOT NULL
GROUP BY COALESCE(NULLIF(TRIM(market_region), ''), TRIM(market));

-- Zips inherit canonical market from the same precedence.
CREATE OR REPLACE VIEW public.v_entity_graph_zips AS
SELECT
  TRIM(COALESCE(property_address_zip, property_zip)) AS zip,
  COALESCE(NULLIF(TRIM(market_region), ''), TRIM(market)) AS market,
  COUNT(*)::bigint AS property_count
FROM public.properties
WHERE COALESCE(property_address_zip, property_zip) IS NOT NULL
  AND TRIM(COALESCE(property_address_zip, property_zip)) <> ''
GROUP BY TRIM(COALESCE(property_address_zip, property_zip)),
         COALESCE(NULLIF(TRIM(market_region), ''), TRIM(market));

COMMIT;