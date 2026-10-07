-- PROPOSED — NOT APPLIED (2026-10-07, composer filter audit).
--
-- 1. REHAB LEVEL IS WRONG IN THE AUDIENCE. Four graph build functions project
--      rehab_level = COALESCE(rehab_level, renovation_level_classification, building_condition)
--    so every property with no rehab level gets its BUILDING CONDITION as a rehab
--    level. Measured 2026-10-07 on the graph: rehab_level 'Average' 30,345,
--    'Unknown' 10,481, 'Fair' 6,597, 'Poor' 3,558, 'Good' 1,109 ... — values that
--    do not exist in public.properties.rehab_level (Structural 66,033, Full Rehab
--    50,207, Moderate 5,490, Cosmetic 2,247, Light 69, NULL 52,564). The Composer
--    offered "Rehab Level = Average" and counted 30k properties for it.
--    campaign_target_graph_enrich_rows (and the property source of
--    PROPOSED_20261007180000) already project the right thing:
--      COALESCE(rehab_level, renovation_level_classification).
--    This rewrites the one expression in each build function, asserting it is
--    found exactly once, so the next rebuild (and its stage rows, which
--    PROPOSED_20261007180000 §5 PREFERS over the graph's value) stops
--    re-introducing it.
--
-- 2. FACET KEYS. refresh_campaign_target_graph_facets has no key for four
--    option fields the builder offers (decision_tier, best_strategy,
--    building_quality, phone_type), so their pickers can never list values from
--    the snapshot. Added after rehab_level. (campaign_audience_field_values,
--    PROPOSED_20261007120000, already serves them exactly; this keeps the
--    snapshot fallback complete.)
--
-- Order: after PROPOSED_20261007180000 (it does not touch these functions, but
-- its §5 relies on stage rows being right). Then re-project 'property' rows
-- (reproject-backfill.mjs --sets=property) and refresh the facets once.
--
-- Locks: pg_proc rows only (CREATE OR REPLACE FUNCTION via EXECUTE). No table DDL.
-- Rollback: re-run the same DO block with the two strings swapped.

SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  v_fn text;
  v_def text;
  v_new text;
  v_bad_p constant text := $s$COALESCE(NULLIF(p.rehab_level, ''), NULLIF(p.renovation_level_classification, ''), NULLIF(p.building_condition, ''))$s$;
  v_good_p constant text := $s$COALESCE(NULLIF(p.rehab_level, ''), NULLIF(p.renovation_level_classification, ''))$s$;
  v_bad_f constant text := $s$COALESCE(NULLIF(f.rehab_level,''), NULLIF(f.renovation_level_classification,''), NULLIF(f.building_condition,''))$s$;
  v_good_f constant text := $s$COALESCE(NULLIF(f.rehab_level,''), NULLIF(f.renovation_level_classification,''))$s$;
  v_count integer;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.refresh_campaign_target_graph_stage_batch(uuid,integer,integer,text,text)',
    'public.refresh_campaign_target_graph_property_universe_batch(uuid,integer,integer,text,text)',
    'public.refresh_campaign_target_graph_fallback_batch(uuid,integer,integer,text,text)',
    'public.refresh_campaign_target_graph_seller_batch(uuid,integer,integer)'
  ] LOOP
    v_def := pg_get_functiondef(v_fn::regprocedure);
    v_count := (length(v_def) - length(replace(v_def, v_bad_p, ''))) / length(v_bad_p)
             + (length(v_def) - length(replace(v_def, v_bad_f, ''))) / length(v_bad_f);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'rehab_level fix: expected exactly 1 occurrence in %, found %', v_fn, v_count;
    END IF;
    v_new := replace(replace(v_def, v_bad_p, v_good_p), v_bad_f, v_good_f);
    EXECUTE v_new;
    RAISE NOTICE 'rehab_level fixed in %', v_fn;
  END LOOP;

  -- facet keys
  v_def := pg_get_functiondef('public.refresh_campaign_target_graph_facets()'::regprocedure);
  IF position($s$('properties.decision_tier'$s$ IN v_def) = 0 THEN
    IF position($s$('properties.rehab_level', g.rehab_level),$s$ IN v_def) = 0 THEN
      RAISE EXCEPTION 'facet keys: anchor not found in refresh_campaign_target_graph_facets';
    END IF;
    v_new := replace(v_def, $s$('properties.rehab_level', g.rehab_level),$s$, $s$('properties.rehab_level', g.rehab_level),
      ('properties.building_quality', g.building_quality),
      ('properties.decision_tier', g.decision_tier),
      ('properties.best_strategy', g.best_strategy),
      ('phones.phone_type', g.phone_type),$s$);
    EXECUTE v_new;
  END IF;
END
$migration$;

-- Verify (read-only, after a rebuild or a 'property' re-projection):
--   SELECT rehab_level, count(*) FROM campaign_target_graph GROUP BY 1 ORDER BY 2 DESC;
--     -- expect only Structural / Full Rehab / Moderate / Cosmetic / Light / NULL
--   SELECT count(*) FROM campaign_target_graph g JOIN properties p USING (property_id)
--    WHERE g.rehab_level IS DISTINCT FROM COALESCE(NULLIF(p.rehab_level,''), NULLIF(p.renovation_level_classification,''));
--     -- expect 0
