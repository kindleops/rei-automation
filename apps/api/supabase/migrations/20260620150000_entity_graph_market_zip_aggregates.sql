BEGIN;

-- Base market aggregates grouped by trusted canonical field (market_region preferred).
CREATE OR REPLACE VIEW public.v_entity_graph_market_aggregates AS
SELECT
  COALESCE(NULLIF(TRIM(market_region), ''), NULLIF(TRIM(market), '')) AS market_key,
  COALESCE(NULLIF(TRIM(market_region), ''), NULLIF(TRIM(market), '')) AS canonical_market,
  MAX(TRIM(market)) AS sample_locality,
  MAX(TRIM(property_address_state)) AS state,
  COUNT(*)::bigint AS property_count,
  COUNT(DISTINCT NULLIF(TRIM(master_owner_id), ''))::bigint AS owner_count,
  ROUND(AVG(final_acquisition_score)::numeric, 2) AS avg_acquisition_score,
  COUNT(*) FILTER (WHERE COALESCE(equity_percent, 0) >= 50)::bigint AS high_equity_count,
  COUNT(*) FILTER (WHERE COALESCE(tax_delinquent, false) = true OR COALESCE(active_lien, false) = true)::bigint AS distressed_count
FROM public.properties
WHERE COALESCE(NULLIF(TRIM(market_region), ''), NULLIF(TRIM(market), '')) IS NOT NULL
GROUP BY 1, 2;

CREATE OR REPLACE FUNCTION public.entity_graph_market_distinct_count()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::bigint
  FROM public.v_entity_graph_market_aggregates;
$$;

CREATE OR REPLACE FUNCTION public.entity_graph_browse_markets(
  p_offset integer,
  p_limit integer,
  p_ascending boolean DEFAULT false
)
RETURNS TABLE(
  market_key text,
  canonical_market text,
  sample_locality text,
  state text,
  property_count bigint,
  owner_count bigint,
  people_count bigint,
  reachable_phones bigint,
  reachable_emails bigint,
  reachable_contacts bigint,
  contact_coverage_pct numeric,
  avg_acquisition_score numeric,
  high_equity_count bigint,
  distressed_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH market_base AS (
    SELECT
      COALESCE(NULLIF(TRIM(p.market_region), ''), NULLIF(TRIM(p.market), '')) AS mk,
      COUNT(*)::bigint AS property_count,
      COUNT(DISTINCT NULLIF(TRIM(p.master_owner_id), ''))::bigint AS owner_count,
      ROUND(AVG(p.final_acquisition_score)::numeric, 2) AS avg_acquisition_score,
      COUNT(*) FILTER (WHERE COALESCE(p.equity_percent, 0) >= 50)::bigint AS high_equity_count,
      COUNT(*) FILTER (WHERE COALESCE(p.tax_delinquent, false) = true OR COALESCE(p.active_lien, false) = true)::bigint AS distressed_count,
      MAX(TRIM(p.market)) AS sample_locality,
      MAX(TRIM(p.property_address_state)) AS state
    FROM public.properties p
    WHERE COALESCE(NULLIF(TRIM(p.market_region), ''), NULLIF(TRIM(p.market), '')) IS NOT NULL
    GROUP BY 1
  ),
  market_people AS (
    SELECT
      COALESCE(NULLIF(TRIM(p.market_region), ''), NULLIF(TRIM(p.market), '')) AS mk,
      COUNT(DISTINCT pr.prospect_id)::bigint AS people_count
    FROM public.properties p
    INNER JOIN public.prospects pr ON pr.master_owner_id = p.master_owner_id
    WHERE COALESCE(NULLIF(TRIM(p.market_region), ''), NULLIF(TRIM(p.market), '')) IS NOT NULL
      AND p.master_owner_id IS NOT NULL
      AND TRIM(p.master_owner_id) <> ''
    GROUP BY 1
  ),
  market_phones AS (
    SELECT
      COALESCE(NULLIF(TRIM(p.market_region), ''), NULLIF(TRIM(p.market), '')) AS mk,
      COUNT(DISTINCT ph.phone_id)::bigint AS reachable_phones
    FROM public.properties p
    INNER JOIN public.phones ph ON ph.master_owner_id = p.master_owner_id
    WHERE COALESCE(NULLIF(TRIM(p.market_region), ''), NULLIF(TRIM(p.market), '')) IS NOT NULL
      AND p.master_owner_id IS NOT NULL
      AND TRIM(p.master_owner_id) <> ''
      AND ph.wrong_number_at IS NULL
      AND COALESCE(ph.contact_score_final, 0) > 0
    GROUP BY 1
  ),
  market_emails AS (
    SELECT
      COALESCE(NULLIF(TRIM(p.market_region), ''), NULLIF(TRIM(p.market), '')) AS mk,
      COUNT(DISTINCT em.email_id)::bigint AS reachable_emails
    FROM public.properties p
    INNER JOIN public.emails em ON em.master_owner_id = p.master_owner_id
    WHERE COALESCE(NULLIF(TRIM(p.market_region), ''), NULLIF(TRIM(p.market), '')) IS NOT NULL
      AND p.master_owner_id IS NOT NULL
      AND TRIM(p.master_owner_id) <> ''
      AND COALESCE(em.contact_score_final, 0) > 0
    GROUP BY 1
  )
  SELECT
    mb.mk AS market_key,
    mb.mk AS canonical_market,
    mb.sample_locality,
    mb.state,
    mb.property_count,
    mb.owner_count,
    COALESCE(mp.people_count, 0)::bigint AS people_count,
    COALESCE(mph.reachable_phones, 0)::bigint AS reachable_phones,
    COALESCE(me.reachable_emails, 0)::bigint AS reachable_emails,
    (COALESCE(mph.reachable_phones, 0) + COALESCE(me.reachable_emails, 0))::bigint AS reachable_contacts,
    CASE
      WHEN mb.owner_count > 0 THEN ROUND(((COALESCE(mph.reachable_phones, 0) + COALESCE(me.reachable_emails, 0))::numeric / mb.owner_count::numeric) * 100, 1)
      ELSE NULL
    END AS contact_coverage_pct,
    mb.avg_acquisition_score,
    mb.high_equity_count,
    mb.distressed_count
  FROM market_base mb
  LEFT JOIN market_people mp ON mp.mk = mb.mk
  LEFT JOIN market_phones mph ON mph.mk = mb.mk
  LEFT JOIN market_emails me ON me.mk = mb.mk
  ORDER BY
    CASE WHEN p_ascending THEN mb.property_count END ASC NULLS LAST,
    CASE WHEN NOT p_ascending THEN mb.property_count END DESC NULLS LAST
  OFFSET GREATEST(p_offset, 0)
  LIMIT GREATEST(p_limit, 1);
$$;

CREATE OR REPLACE FUNCTION public.entity_graph_browse_zips(
  p_offset integer,
  p_limit integer,
  p_ascending boolean DEFAULT true
)
RETURNS TABLE(
  zip text,
  market text,
  property_count bigint,
  owner_count bigint,
  people_count bigint,
  reachable_phones bigint,
  reachable_emails bigint,
  reachable_contacts bigint,
  contact_coverage_pct numeric,
  avg_acquisition_score numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH zip_base AS (
    SELECT
      TRIM(COALESCE(p.property_address_zip, p.property_zip)) AS z,
      MAX(COALESCE(NULLIF(TRIM(p.market_region), ''), NULLIF(TRIM(p.market), ''))) AS market,
      COUNT(*)::bigint AS property_count,
      COUNT(DISTINCT NULLIF(TRIM(p.master_owner_id), ''))::bigint AS owner_count,
      ROUND(AVG(p.final_acquisition_score)::numeric, 2) AS avg_acquisition_score
    FROM public.properties p
    WHERE COALESCE(p.property_address_zip, p.property_zip) IS NOT NULL
      AND TRIM(COALESCE(p.property_address_zip, p.property_zip)) <> ''
    GROUP BY 1
  ),
  zip_people AS (
    SELECT
      TRIM(COALESCE(p.property_address_zip, p.property_zip)) AS z,
      COUNT(DISTINCT pr.prospect_id)::bigint AS people_count
    FROM public.properties p
    INNER JOIN public.prospects pr ON pr.master_owner_id = p.master_owner_id
    WHERE COALESCE(p.property_address_zip, p.property_zip) IS NOT NULL
      AND TRIM(COALESCE(p.property_address_zip, p.property_zip)) <> ''
      AND p.master_owner_id IS NOT NULL
    GROUP BY 1
  ),
  zip_phones AS (
    SELECT
      TRIM(COALESCE(p.property_address_zip, p.property_zip)) AS z,
      COUNT(DISTINCT ph.phone_id)::bigint AS reachable_phones
    FROM public.properties p
    INNER JOIN public.phones ph ON ph.master_owner_id = p.master_owner_id
    WHERE COALESCE(p.property_address_zip, p.property_zip) IS NOT NULL
      AND TRIM(COALESCE(p.property_address_zip, p.property_zip)) <> ''
      AND p.master_owner_id IS NOT NULL
      AND ph.wrong_number_at IS NULL
      AND COALESCE(ph.contact_score_final, 0) > 0
    GROUP BY 1
  ),
  zip_emails AS (
    SELECT
      TRIM(COALESCE(p.property_address_zip, p.property_zip)) AS z,
      COUNT(DISTINCT em.email_id)::bigint AS reachable_emails
    FROM public.properties p
    INNER JOIN public.emails em ON em.master_owner_id = p.master_owner_id
    WHERE COALESCE(p.property_address_zip, p.property_zip) IS NOT NULL
      AND TRIM(COALESCE(p.property_address_zip, p.property_zip)) <> ''
      AND p.master_owner_id IS NOT NULL
      AND COALESCE(em.contact_score_final, 0) > 0
    GROUP BY 1
  )
  SELECT
    zb.z AS zip,
    zb.market,
    zb.property_count,
    zb.owner_count,
    COALESCE(zp.people_count, 0)::bigint AS people_count,
    COALESCE(zph.reachable_phones, 0)::bigint AS reachable_phones,
    COALESCE(ze.reachable_emails, 0)::bigint AS reachable_emails,
    (COALESCE(zph.reachable_phones, 0) + COALESCE(ze.reachable_emails, 0))::bigint AS reachable_contacts,
    CASE
      WHEN zb.owner_count > 0 THEN ROUND(((COALESCE(zph.reachable_phones, 0) + COALESCE(ze.reachable_emails, 0))::numeric / zb.owner_count::numeric) * 100, 1)
      ELSE NULL
    END AS contact_coverage_pct,
    zb.avg_acquisition_score
  FROM zip_base zb
  LEFT JOIN zip_people zp ON zp.z = zb.z
  LEFT JOIN zip_phones zph ON zph.z = zb.z
  LEFT JOIN zip_emails ze ON ze.z = zb.z
  ORDER BY
    CASE WHEN p_ascending THEN zb.z END ASC NULLS LAST,
    CASE WHEN NOT p_ascending THEN zb.z END DESC NULLS LAST
  OFFSET GREATEST(p_offset, 0)
  LIMIT GREATEST(p_limit, 1);
$$;

COMMIT;