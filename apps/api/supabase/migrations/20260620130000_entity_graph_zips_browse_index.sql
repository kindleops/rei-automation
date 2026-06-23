BEGIN;

CREATE INDEX IF NOT EXISTS idx_properties_zip_trim
  ON public.properties (TRIM(COALESCE(property_address_zip, property_zip)));

CREATE OR REPLACE FUNCTION public.entity_graph_zip_distinct_count()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::bigint
  FROM (
    SELECT TRIM(COALESCE(property_address_zip, property_zip)) AS zip
    FROM public.properties
    WHERE COALESCE(property_address_zip, property_zip) IS NOT NULL
      AND TRIM(COALESCE(property_address_zip, property_zip)) <> ''
    GROUP BY 1
  ) s;
$$;

CREATE OR REPLACE FUNCTION public.entity_graph_browse_zips(
  p_offset integer,
  p_limit integer,
  p_ascending boolean DEFAULT true
)
RETURNS TABLE(zip text, market text, property_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    TRIM(COALESCE(property_address_zip, property_zip)) AS zip,
    MAX(TRIM(market)) AS market,
    COUNT(*)::bigint AS property_count
  FROM public.properties
  WHERE COALESCE(property_address_zip, property_zip) IS NOT NULL
    AND TRIM(COALESCE(property_address_zip, property_zip)) <> ''
  GROUP BY 1
  ORDER BY
    CASE WHEN p_ascending THEN TRIM(COALESCE(property_address_zip, property_zip)) END ASC NULLS LAST,
    CASE WHEN NOT p_ascending THEN TRIM(COALESCE(property_address_zip, property_zip)) END DESC NULLS LAST
  OFFSET GREATEST(p_offset, 0)
  LIMIT GREATEST(p_limit, 1);
$$;

COMMIT;