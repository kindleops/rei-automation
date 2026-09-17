-- Preserve properties.master_owner_id against null-overwriting upserts.
--
-- ROOT CAUSE
-- supabase/functions/rei-import/index.ts normalises every properties row with:
--
--     if (table === "properties") {
--       ...
--       if (!row.master_owner_id) row.master_owner_id = null;
--     }
--
-- and then upserts with:
--
--     supabase.from(table).upsert(chunk, { onConflict: "upsert_key",
--                                          ignoreDuplicates: false })
--
-- `ignoreDuplicates: false` is update-on-conflict. So any re-import whose
-- payload omits master_owner_id does not merely fail to set the link — it
-- ACTIVELY OVERWRITES an existing link with NULL. This is an eraser, not a gap.
--
-- No application code writes public.properties at all; this edge function is the
-- only writer, which is why the damage is uniform and silent.
--
-- PRODUCTION EVIDENCE (2026-08-17, read-only)
--   cohort     properties   reverse_ptr_set   owner_side_claims   recoverable
--   2026-04       116,217            33,701             116,054        82,377
--   2026-05         7,829             7,829                   0             0
--   2026-07             2                 2                   2             0
--   2026-08        45,749                 0                  29            29
--
-- The May cohort proves the pipeline CAN populate the pointer. The April cohort
-- is the erased population. The August cohort arrived with no owner data on
-- either side — a separate ingestion-completeness problem, not this defect.
--
-- CANONICAL CONTRACT
-- master_owners.joined_property_ids_json is authoritative for ownership
-- (124,203 links over 124,140 distinct properties, matching the 124,046-row
-- graph). properties.master_owner_id is a denormalised REVERSE POINTER. The
-- authoritative side must never be silently contradicted by an omission on the
-- denormalised side.
--
-- WHY A TRIGGER RATHER THAN AN IMPORTER PATCH
-- Fixing only the importer would leave the invariant dependent on payload shape.
-- PostgREST upserts a JSON array using the UNION of keys across the batch, so a
-- single row carrying master_owner_id reintroduces NULL for every row that
-- omits it. The database is the only boundary that can hold this invariant for
-- all writers, present and future. The importer is corrected too, but the
-- trigger is what makes the guarantee.
--
-- SEMANTICS
--   * NULL over non-NULL  -> preserved (treated as "not supplied")
--   * value over value    -> applied (a real relink, including merges)
--   * value over NULL     -> applied (a new link)
--   * INSERT              -> untouched; a genuinely new property may be NULL
--
-- Deliberate unlinking is still possible, but must be explicit:
--     SET LOCAL app.allow_owner_unlink = 'on';
-- Owner merge/split/dedupe paths that intend to clear a pointer set that flag,
-- which also makes the intent visible in any audit of the session.
--
-- Idempotent: re-running this migration replaces the function and trigger.

CREATE OR REPLACE FUNCTION public.preserve_property_master_owner_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only intervene when an existing link would be erased by an omission.
  IF NULLIF(NEW.master_owner_id, '') IS NULL
     AND NULLIF(OLD.master_owner_id, '') IS NOT NULL
  THEN
    -- Explicit, opt-in unlink for merge/split/dedupe. current_setting with
    -- missing_ok=true returns NULL rather than raising when unset.
    IF COALESCE(current_setting('app.allow_owner_unlink', true), 'off') = 'on' THEN
      RETURN NEW;
    END IF;

    NEW.master_owner_id := OLD.master_owner_id;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.preserve_property_master_owner_id() IS
  'Keeps properties.master_owner_id from being erased by upserts that omit it. '
  'Set app.allow_owner_unlink=on for deliberate unlinking (owner merge/split).';

DROP TRIGGER IF EXISTS trg_preserve_property_master_owner_id ON public.properties;

CREATE TRIGGER trg_preserve_property_master_owner_id
  BEFORE UPDATE ON public.properties
  FOR EACH ROW
  EXECUTE FUNCTION public.preserve_property_master_owner_id();
