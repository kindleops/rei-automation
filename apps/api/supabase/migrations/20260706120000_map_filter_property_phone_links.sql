-- Normalized execution bridge for property↔phone relationships.
-- Canonical sources: phones prospect/owner linkage + master_owners.joined_phone_ids_json.

CREATE TABLE IF NOT EXISTS public.map_filter_property_phone_links (
  property_id text NOT NULL,
  phone_id text NOT NULL,
  master_owner_id text,
  link_source text NOT NULL,
  is_primary_link boolean NOT NULL DEFAULT false,
  source_phone_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, phone_id)
);

CREATE INDEX IF NOT EXISTS idx_map_filter_phl_phone_property
  ON public.map_filter_property_phone_links (phone_id, property_id);

CREATE INDEX IF NOT EXISTS idx_map_filter_phl_master_owner
  ON public.map_filter_property_phone_links (master_owner_id);

COMMENT ON TABLE public.map_filter_property_phone_links IS
  'Derived execution index for map filter phone relationship predicates. '
  'Populated from canonical phones prospect/owner linkage paths.';

CREATE OR REPLACE FUNCTION public.rebuild_map_filter_property_phone_links()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  started timestamptz := clock_timestamp();
  inserted_count bigint;
  orphan_property_count bigint;
BEGIN
  TRUNCATE public.map_filter_property_phone_links;

  INSERT INTO public.map_filter_property_phone_links (
    property_id,
    phone_id,
    master_owner_id,
    link_source,
    is_primary_link,
    source_phone_updated_at
  )
  SELECT DISTINCT ON (property_id, phone_id)
    src.property_id,
    src.phone_id,
    src.master_owner_id,
    src.link_source,
    src.is_primary_link,
    src.source_phone_updated_at
  FROM (
    SELECT
      link.property_id,
      ph.phone_id,
      p.master_owner_id,
      'prospect_primary'::text AS link_source,
      COALESCE(ph.is_best_phone_for_owner, false) OR COALESCE(ph.is_best_phone_for_slot, false) AS is_primary_link,
      ph.updated_at AS source_phone_updated_at,
      1 AS link_rank
    FROM public.map_filter_property_prospect_links link
    INNER JOIN public.properties p ON p.property_id = link.property_id
    INNER JOIN public.phones ph ON ph.primary_prospect_id = link.prospect_id
    WHERE ph.phone_id IS NOT NULL AND trim(ph.phone_id) <> ''

    UNION ALL

    SELECT
      link.property_id,
      ph.phone_id,
      p.master_owner_id,
      'prospect_canonical'::text,
      COALESCE(ph.is_best_phone_for_owner, false) OR COALESCE(ph.is_best_phone_for_slot, false),
      ph.updated_at,
      2
    FROM public.map_filter_property_prospect_links link
    INNER JOIN public.properties p ON p.property_id = link.property_id
    INNER JOIN public.prospects pr ON pr.prospect_id = link.prospect_id
    INNER JOIN public.phones ph
      ON ph.canonical_prospect_id IS NOT NULL
     AND ph.canonical_prospect_id = pr.canonical_prospect_id
     AND (ph.primary_prospect_id IS NULL OR ph.primary_prospect_id <> link.prospect_id)
    WHERE ph.phone_id IS NOT NULL AND trim(ph.phone_id) <> ''

    UNION ALL

    SELECT
      link.property_id,
      ph.phone_id,
      p.master_owner_id,
      'prospect_json'::text,
      COALESCE(ph.is_best_phone_for_owner, false) OR COALESCE(ph.is_best_phone_for_slot, false),
      ph.updated_at,
      3
    FROM public.map_filter_property_prospect_links link
    INNER JOIN public.properties p ON p.property_id = link.property_id
    INNER JOIN public.phones ph
      ON ph.linked_prospect_ids_json IS NOT NULL
     AND ph.linked_prospect_ids_json::jsonb ? link.prospect_id
     AND (ph.primary_prospect_id IS NULL OR ph.primary_prospect_id <> link.prospect_id)
    WHERE ph.phone_id IS NOT NULL AND trim(ph.phone_id) <> ''

    UNION ALL

    SELECT
      p.property_id,
      ph.phone_id,
      p.master_owner_id,
      'owner_direct'::text,
      COALESCE(ph.is_best_phone_for_owner, false) OR COALESCE(ph.is_best_phone_for_slot, false),
      ph.updated_at,
      4
    FROM public.properties p
    INNER JOIN public.phones ph
      ON ph.master_owner_id IS NOT NULL
     AND ph.master_owner_id = p.master_owner_id
    WHERE p.master_owner_id IS NOT NULL
      AND ph.phone_id IS NOT NULL AND trim(ph.phone_id) <> ''

    UNION ALL

    SELECT
      p.property_id,
      ph.phone_id,
      p.master_owner_id,
      'owner_joined_json'::text,
      COALESCE(ph.is_best_phone_for_owner, false) OR COALESCE(ph.is_best_phone_for_slot, false),
      ph.updated_at,
      5
    FROM public.properties p
    INNER JOIN public.master_owners mo ON mo.master_owner_id = p.master_owner_id
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(mo.joined_phone_ids_json, '[]'::jsonb)) AS phone_elem
    INNER JOIN public.phones ph ON ph.phone_id = trim(phone_elem)
    WHERE p.master_owner_id IS NOT NULL
      AND phone_elem IS NOT NULL AND trim(phone_elem) <> ''
  ) src
  ORDER BY property_id, phone_id, link_rank, source_phone_updated_at DESC NULLS LAST;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  SELECT COUNT(*)::bigint INTO orphan_property_count
  FROM public.map_filter_property_phone_links link
  WHERE NOT EXISTS (
    SELECT 1 FROM public.properties p WHERE p.property_id = link.property_id
  );

  RETURN jsonb_build_object(
    'inserted', inserted_count,
    'orphan_property_refs', orphan_property_count,
    'duration_ms', EXTRACT(EPOCH FROM (clock_timestamp() - started)) * 1000
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_map_filter_property_phone_links()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.map_filter_property_phone_links
    WHERE phone_id = OLD.phone_id;
    RETURN OLD;
  END IF;

  DELETE FROM public.map_filter_property_phone_links
  WHERE phone_id = NEW.phone_id;

  INSERT INTO public.map_filter_property_phone_links (
    property_id, phone_id, master_owner_id, link_source, is_primary_link, source_phone_updated_at
  )
  SELECT DISTINCT ON (property_id, phone_id)
    src.property_id,
    src.phone_id,
    src.master_owner_id,
    src.link_source,
    src.is_primary_link,
    src.source_phone_updated_at
  FROM (
    SELECT link.property_id, NEW.phone_id AS phone_id, p.master_owner_id,
      'prospect_primary'::text AS link_source,
      COALESCE(NEW.is_best_phone_for_owner, false) OR COALESCE(NEW.is_best_phone_for_slot, false) AS is_primary_link,
      NEW.updated_at AS source_phone_updated_at, 1 AS link_rank
    FROM public.map_filter_property_prospect_links link
    INNER JOIN public.properties p ON p.property_id = link.property_id
    WHERE NEW.primary_prospect_id IS NOT NULL AND NEW.primary_prospect_id = link.prospect_id

    UNION ALL

    SELECT link.property_id, NEW.phone_id, p.master_owner_id, 'prospect_canonical'::text,
      COALESCE(NEW.is_best_phone_for_owner, false) OR COALESCE(NEW.is_best_phone_for_slot, false),
      NEW.updated_at, 2
    FROM public.map_filter_property_prospect_links link
    INNER JOIN public.properties p ON p.property_id = link.property_id
    INNER JOIN public.prospects pr ON pr.prospect_id = link.prospect_id
    WHERE NEW.canonical_prospect_id IS NOT NULL
      AND NEW.canonical_prospect_id = pr.canonical_prospect_id
      AND (NEW.primary_prospect_id IS NULL OR NEW.primary_prospect_id <> link.prospect_id)

    UNION ALL

    SELECT link.property_id, NEW.phone_id, p.master_owner_id, 'prospect_json'::text,
      COALESCE(NEW.is_best_phone_for_owner, false) OR COALESCE(NEW.is_best_phone_for_slot, false),
      NEW.updated_at, 3
    FROM public.map_filter_property_prospect_links link
    INNER JOIN public.properties p ON p.property_id = link.property_id
    WHERE NEW.linked_prospect_ids_json IS NOT NULL
      AND NEW.linked_prospect_ids_json::jsonb ? link.prospect_id
      AND (NEW.primary_prospect_id IS NULL OR NEW.primary_prospect_id <> link.prospect_id)

    UNION ALL

    SELECT p.property_id, NEW.phone_id, p.master_owner_id, 'owner_direct'::text,
      COALESCE(NEW.is_best_phone_for_owner, false) OR COALESCE(NEW.is_best_phone_for_slot, false),
      NEW.updated_at, 4
    FROM public.properties p
    WHERE NEW.master_owner_id IS NOT NULL AND p.master_owner_id = NEW.master_owner_id

    UNION ALL

    SELECT p.property_id, NEW.phone_id, p.master_owner_id, 'owner_joined_json'::text,
      COALESCE(NEW.is_best_phone_for_owner, false) OR COALESCE(NEW.is_best_phone_for_slot, false),
      NEW.updated_at, 5
    FROM public.properties p
    INNER JOIN public.master_owners mo ON mo.master_owner_id = p.master_owner_id
    WHERE mo.joined_phone_ids_json IS NOT NULL
      AND mo.joined_phone_ids_json::jsonb ? NEW.phone_id
  ) src
  ORDER BY property_id, phone_id, link_rank, source_phone_updated_at DESC NULLS LAST
  ON CONFLICT (property_id, phone_id) DO UPDATE SET
    master_owner_id = EXCLUDED.master_owner_id,
    link_source = EXCLUDED.link_source,
    is_primary_link = EXCLUDED.is_primary_link,
    source_phone_updated_at = EXCLUDED.source_phone_updated_at,
    updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_map_filter_property_phone_links ON public.phones;

CREATE TRIGGER trg_sync_map_filter_property_phone_links
  AFTER INSERT OR UPDATE OF phone_id, primary_prospect_id, canonical_prospect_id,
    linked_prospect_ids_json, master_owner_id, is_best_phone_for_owner, is_best_phone_for_slot, updated_at
  OR DELETE
  ON public.phones
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_map_filter_property_phone_links();

-- Idempotent rebuild (requires prospect bridge populated first).
SELECT public.rebuild_map_filter_property_phone_links();