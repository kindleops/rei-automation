-- Normalized execution bridge for property↔prospect relationships.
-- Canonical source remains prospects.linked_property_ids_json (not replaced).

CREATE TABLE IF NOT EXISTS public.map_filter_property_prospect_links (
  property_id text NOT NULL,
  prospect_id text NOT NULL,
  master_owner_id text NOT NULL,
  source_prospect_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, prospect_id)
);

CREATE INDEX IF NOT EXISTS idx_map_filter_ppl_prospect_property
  ON public.map_filter_property_prospect_links (prospect_id, property_id);

CREATE INDEX IF NOT EXISTS idx_map_filter_ppl_master_owner
  ON public.map_filter_property_prospect_links (master_owner_id);

COMMENT ON TABLE public.map_filter_property_prospect_links IS
  'Derived execution index for map filter prospect relationship predicates. '
  'Populated from prospects.linked_property_ids_json; canonical JSON field is unchanged.';

-- Idempotent full rebuild from canonical JSON source.
CREATE OR REPLACE FUNCTION public.rebuild_map_filter_property_prospect_links()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  started timestamptz := clock_timestamp();
  deleted_count bigint;
  inserted_count bigint;
  json_entries bigint;
  malformed_count bigint;
  orphan_property_count bigint;
BEGIN
  TRUNCATE public.map_filter_property_prospect_links;

  SELECT COUNT(*)::bigint INTO json_entries
  FROM public.prospects pr
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(pr.linked_property_ids_json, '[]'::jsonb)) AS elem
  WHERE elem IS NOT NULL AND trim(elem) <> '';

  SELECT COUNT(*)::bigint INTO malformed_count
  FROM public.prospects pr
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(pr.linked_property_ids_json, '[]'::jsonb)) AS elem
  WHERE elem IS NOT NULL AND trim(elem) <> ''
    AND NOT (trim(elem) ~ '^[0-9a-fA-F-]{8,}$');

  INSERT INTO public.map_filter_property_prospect_links (
    property_id,
    prospect_id,
    master_owner_id,
    source_prospect_updated_at
  )
  SELECT DISTINCT ON (property_id, prospect_id)
    trim(elem) AS property_id,
    pr.prospect_id,
    pr.master_owner_id,
    pr.updated_at
  FROM public.prospects pr
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(pr.linked_property_ids_json, '[]'::jsonb)) AS elem
  WHERE elem IS NOT NULL
    AND trim(elem) <> ''
    AND trim(elem) ~ '^[0-9a-fA-F-]{8,}$'
  ORDER BY property_id, prospect_id, pr.updated_at DESC NULLS LAST;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  SELECT COUNT(*)::bigint INTO orphan_property_count
  FROM public.map_filter_property_prospect_links link
  WHERE NOT EXISTS (
    SELECT 1 FROM public.properties p WHERE p.property_id = link.property_id
  );

  RETURN jsonb_build_object(
    'inserted', inserted_count,
    'json_entries', json_entries,
    'malformed', malformed_count,
    'orphan_property_refs', orphan_property_count,
    'duration_ms', EXTRACT(EPOCH FROM (clock_timestamp() - started)) * 1000
  );
END;
$$;

-- Incremental sync on prospect relationship changes.
CREATE OR REPLACE FUNCTION public.sync_map_filter_property_prospect_links()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.map_filter_property_prospect_links
    WHERE prospect_id = OLD.prospect_id;
    RETURN OLD;
  END IF;

  DELETE FROM public.map_filter_property_prospect_links
  WHERE prospect_id = NEW.prospect_id;

  INSERT INTO public.map_filter_property_prospect_links (
    property_id,
    prospect_id,
    master_owner_id,
    source_prospect_updated_at
  )
  SELECT DISTINCT ON (property_id, prospect_id)
    trim(elem) AS property_id,
    NEW.prospect_id,
    NEW.master_owner_id,
    NEW.updated_at
  FROM jsonb_array_elements_text(COALESCE(NEW.linked_property_ids_json, '[]'::jsonb)) AS elem
  WHERE elem IS NOT NULL
    AND trim(elem) <> ''
    AND trim(elem) ~ '^[0-9a-fA-F-]{8,}$'
  ON CONFLICT (property_id, prospect_id) DO UPDATE SET
    master_owner_id = EXCLUDED.master_owner_id,
    source_prospect_updated_at = EXCLUDED.source_prospect_updated_at,
    updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_map_filter_property_prospect_links ON public.prospects;

CREATE TRIGGER trg_sync_map_filter_property_prospect_links
  AFTER INSERT OR UPDATE OF linked_property_ids_json, master_owner_id OR DELETE
  ON public.prospects
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_map_filter_property_prospect_links();

-- Initial population (idempotent rebuild).
SELECT public.rebuild_map_filter_property_prospect_links();