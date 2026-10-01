-- ─── Drawn map area → exact campaign cohort ───────────────────────────────
-- Owner (2026-09-30): "A drawn polygon should resolve the entire exact eligible
-- cohort server-side ... No arbitrary ordering, no silent truncation."
--
-- Before: get_map_area_summary returned `property_ids` as the first 5,000 rows
-- of the polygon in no defined order, and "Build campaign draft" targeted that
-- list (properties.property_id in [...]). An 18,400-property area became an
-- arbitrary 5,000-property campaign. The id list also travelled in the request
-- URL, so a list of a few thousand ids could not be sent at all.
--
-- After: the campaign stores the polygon itself (GeoJSON) as its filter, and
-- campaign_target_graph_in_area resolves it inside the database. Reach and
-- Build both read through it, so they read the same exact cohort, with every
-- other campaign filter, the deterministic order and paging applied on top.

-- The polygon as stored on a campaign: a GeoJSON Polygon in EPSG:4326. The one
-- definition of "the area" for the map's area card and the campaign cohort, so
-- the count the operator sees is the count the campaign reads. A self-crossing
-- drawing is repaired to its polygonal parts (a bow-tie becomes two triangles);
-- slivers and stray lines are dropped; a shape with no area comes back empty.
create or replace function public.map_area_polygon(p_area jsonb)
returns public.geometry
language sql
immutable
set search_path = public, extensions
as $$
  select public.st_collectionextract(
           public.st_makevalid(
             public.st_setsrid(public.st_geomfromgeojson(p_area::text), 4326)),
           3)
$$;

-- The polygon, refused when it has no area: a broken or collinear drawing
-- must never quietly become "no audience" or "everyone". "No area" is under
-- 1e-10 square degrees (about one square metre): points drawn along a line are
-- never exactly collinear in floating point, so a strict zero lets a sliver
-- through. The API refuses line-like drawings with the same floor first.
create or replace function public.map_area_checked(p_area jsonb)
returns public.geometry
language plpgsql
immutable
set search_path = public, extensions
as $$
declare
  poly public.geometry := public.map_area_polygon(p_area);
begin
  if poly is null or public.st_isempty(poly) or public.st_area(poly) < 1e-10 then
    raise exception using errcode = '22023', message = 'drawn area: empty or invalid polygon';
  end if;
  return poly;
end
$$;

-- Every campaign_target_graph row whose property lies inside the area. No
-- limit and no order of its own: callers order and page on top.
--
-- Plain SQL with no SET clause so Postgres inlines it into the caller's query:
-- the campaign's other filters, its order and its paging then run inside one
-- plan (bounding box on the (latitude, longitude) index, exact point-in-polygon
-- test, graph rows by property_id) instead of over a materialised copy of the
-- whole area. Every name is schema-qualified because there is no search_path.
-- Proven on production (rolled back) through the PostgREST call shape, against
-- full-scan ground truth: Miami 7,273, Houston 10,583, Minneapolis 3,620 and a
-- 512-vertex circle 9,598 rows, all exact; exact count 56-160 ms, each
-- 1,000-row page 39-122 ms. The polygon is built once per call (the OFFSET 0
-- subquery), not once per property.
create or replace function public.campaign_target_graph_in_area(p_area jsonb)
returns setof public.campaign_target_graph
language sql
stable
as $$
  select g.*
  from public.campaign_target_graph g
  where g.property_id in (
    select p.property_id::text
    from (select public.map_area_checked(p_area) as poly offset 0) a
    join public.properties p
      on p.latitude between public.st_ymin(a.poly)::numeric and public.st_ymax(a.poly)::numeric
     and p.longitude between public.st_xmin(a.poly)::numeric and public.st_xmax(a.poly)::numeric
     and public.st_contains(
           a.poly,
           public.st_setsrid(public.st_makepoint(p.longitude::double precision, p.latitude::double precision), 4326))
  )
$$;

-- Every property inside the area (the campaign's addressable universe), with
-- the same polygon, bounding box and point-in-polygon test as the audience.
create or replace function public.map_area_property_count(p_area jsonb)
returns bigint
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  poly public.geometry := public.map_area_checked(p_area);
  n bigint;
begin
  select count(*) into n
  from public.properties p
  where p.latitude between public.st_ymin(poly)::numeric and public.st_ymax(poly)::numeric
    and p.longitude between public.st_xmin(poly)::numeric and public.st_xmax(poly)::numeric
    and public.st_contains(
          poly,
          public.st_setsrid(public.st_makepoint(p.longitude::double precision, p.latitude::double precision), 4326));
  return n;
end
$$;

revoke all on function public.map_area_polygon(jsonb) from public, anon, authenticated;
revoke all on function public.map_area_checked(jsonb) from public, anon, authenticated;
revoke all on function public.campaign_target_graph_in_area(jsonb) from public, anon, authenticated;
revoke all on function public.map_area_property_count(jsonb) from public, anon, authenticated;
grant execute on function public.map_area_polygon(jsonb) to service_role;
grant execute on function public.map_area_checked(jsonb) to service_role;
grant execute on function public.campaign_target_graph_in_area(jsonb) to service_role;
grant execute on function public.map_area_property_count(jsonb) to service_role;

-- The map's area card: every aggregate is over the whole polygon (unchanged),
-- built by map_area_polygon like the cohort. `property_ids` stays only so the
-- dashboard that is live today keeps working until this release replaces it;
-- it is now deterministic (ordered by property_id) and labelled:
-- property_ids_sampled says it is not the cohort. Campaign targeting never
-- reads it.
create or replace function public.get_map_area_summary(p_ring jsonb)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public', 'extensions'
as $function$
DECLARE
  poly geometry;
  pts jsonb;
  x0 numeric;
  y0 numeric;
  x1 numeric;
  y1 numeric;
  result jsonb;
  sample_limit constant int := 5000;
BEGIN
  IF p_ring IS NULL OR jsonb_array_length(p_ring) < 3 THEN RETURN NULL; END IF;
  pts := p_ring;
  IF (pts -> 0) <> (pts -> (jsonb_array_length(pts) - 1)) THEN
    pts := pts || jsonb_build_array(pts -> 0);
  END IF;
  poly := public.map_area_polygon(jsonb_build_object('type', 'Polygon', 'coordinates', jsonb_build_array(pts)));
  IF poly IS NULL OR ST_IsEmpty(poly) OR ST_Area(poly) < 1e-10 THEN RETURN NULL; END IF;
  -- numeric bounds, like the cohort read: latitude/longitude are numeric, and a
  -- double-precision bound casts the column and skips its index.
  x0 := ST_XMin(poly)::numeric;
  y0 := ST_YMin(poly)::numeric;
  x1 := ST_XMax(poly)::numeric;
  y1 := ST_YMax(poly)::numeric;

  WITH inside AS (
    SELECT p.*
    FROM public.properties p
    WHERE p.latitude BETWEEN y0 AND y1
      AND p.longitude BETWEEN x0 AND x1
      AND ST_Contains(poly, ST_SetSRID(ST_MakePoint(p.longitude::double precision, p.latitude::double precision), 4326))
  ),
  contacted AS (
    SELECT DISTINCT sq.property_id::text AS pid FROM public.send_queue sq
    WHERE sq.property_id::text IN (SELECT property_id::text FROM inside)
  )
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM inside),
    'avg_equity_pct', (SELECT round(avg(equity_percent)::numeric, 1) FROM inside),
    'median_value', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY estimated_value) FROM inside WHERE estimated_value > 0),
    'total_value', (SELECT sum(estimated_value) FROM inside WHERE estimated_value > 0),
    'median_year_built', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY year_built) FROM inside WHERE year_built > 0),
    'avg_motivation', (SELECT round(avg(structured_motivation_score)::numeric, 0) FROM inside),
    'tax_delinquent', (SELECT count(*) FROM inside WHERE tax_delinquent),
    'free_clear', (SELECT count(*) FROM inside WHERE COALESCE(total_loan_balance, 0) = 0),
    'contacted', (SELECT count(*) FROM contacted),
    'types', (SELECT COALESCE(jsonb_agg(t ORDER BY t.n DESC), '[]'::jsonb) FROM (
                SELECT COALESCE(NULLIF(property_type, ''), 'Unknown') AS type, count(*) AS n FROM inside GROUP BY 1 ORDER BY 2 DESC LIMIT 6) t),
    'markets', (SELECT COALESCE(jsonb_agg(m ORDER BY m.n DESC), '[]'::jsonb) FROM (
                SELECT COALESCE(NULLIF(market, ''), 'Unknown') AS market, count(*) AS n FROM inside GROUP BY 1 ORDER BY 2 DESC LIMIT 4) m),
    'property_ids', (SELECT COALESCE(jsonb_agg(property_id::text ORDER BY property_id), '[]'::jsonb)
                     FROM (SELECT property_id FROM inside ORDER BY property_id LIMIT sample_limit) i),
    'property_ids_limit', sample_limit,
    'property_ids_sampled', (SELECT count(*) FROM inside) > sample_limit
  ) INTO result;
  RETURN result;
END;
$function$;

-- The dashboard calls this with the operator's session; an anonymous caller
-- has no business summarising property values.
revoke execute on function public.get_map_area_summary(jsonb) from public, anon;
grant execute on function public.get_map_area_summary(jsonb) to authenticated, service_role;
