BEGIN;

CREATE OR REPLACE VIEW public.v_entity_graph_markets AS
SELECT
  TRIM(market) AS market_key,
  COUNT(*)::bigint AS property_count
FROM public.properties
WHERE market IS NOT NULL AND TRIM(market) <> ''
GROUP BY TRIM(market);

CREATE OR REPLACE VIEW public.v_entity_graph_zips AS
SELECT
  TRIM(COALESCE(property_address_zip, property_zip)) AS zip,
  MAX(TRIM(market)) AS market,
  COUNT(*)::bigint AS property_count
FROM public.properties
WHERE COALESCE(property_address_zip, property_zip) IS NOT NULL
  AND TRIM(COALESCE(property_address_zip, property_zip)) <> ''
GROUP BY TRIM(COALESCE(property_address_zip, property_zip));

COMMIT;