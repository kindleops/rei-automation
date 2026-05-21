-- Cleanup the 16 remaining "other" format inbox_thread_state rows that
-- normalize_e164() could not handle in the prior migration (20260519000000).
--
-- These rows use formats like:
--   PODIO_ID:+from_phone:+to_phone      (e.g. 225372768:+17866052999:+18605733879)
--   mo_ID:PODIO_ID:+phone               (e.g. mo_c263...:282961514:+17024430728)
--   phone_property:+phone:PODIO_ID      (e.g. phone_property:+13175906511:250969961)
--   feed:SHA1HASH                        (e.g. feed:e272d270...)
--
-- Strategy:
--   For each stale row, extract the seller phone (any +1XXXXXXXXXX segment found via regex).
--   If the canonical row already exists → backup then DELETE the stale row.
--   If the canonical row does NOT exist → leave the row (do not guess which phone is canonical).
--
-- Safe to run multiple times (all operations are idempotent).

-- ── 0. Extend the existing backup table ───────────────────────────────────────────────────────
-- The backup table already exists from migration 20260519000000.
-- Capture these rows before any DELETE.
INSERT INTO public.inbox_thread_state_thread_key_repair_backup_20260519
  (thread_key, new_thread_key, master_owner_id, property_id, is_read, is_archived, updated_at, action, pattern)
SELECT
  stale.thread_key,
  -- Extract first +1XXXXXXXXXX segment found in the key
  (regexp_matches(stale.thread_key, '\+1[0-9]{10}', 'g'))[1] AS new_thread_key,
  stale.master_owner_id,
  stale.property_id,
  stale.is_read,
  stale.is_archived,
  stale.updated_at,
  'delete_other_format' AS action,
  CASE
    WHEN stale.thread_key LIKE 'feed:%'           THEN 'feed_hash'
    WHEN stale.thread_key LIKE 'phone_property:%' THEN 'phone_property_composite'
    WHEN stale.thread_key LIKE 'mo_%'             THEN 'mo_podio_phone_composite'
    ELSE                                               'podio_phone_phone_composite'
  END AS pattern
FROM public.inbox_thread_state stale
WHERE
  -- Not canonical E.164
  stale.thread_key !~ '^\+1[0-9]{10}$'
  -- Not already backed up under this action
  AND NOT EXISTS (
    SELECT 1 FROM public.inbox_thread_state_thread_key_repair_backup_20260519 b
    WHERE b.thread_key = stale.thread_key AND b.action = 'delete_other_format'
  )
  -- Canonical row already exists for the extracted phone
  AND (regexp_matches(stale.thread_key, '\+1[0-9]{10}', 'g'))[1] IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.inbox_thread_state canonical
    WHERE canonical.thread_key = (regexp_matches(stale.thread_key, '\+1[0-9]{10}', 'g'))[1]
  );

-- ── 1. Delete stale rows whose canonical row exists ───────────────────────────────────────────
DELETE FROM public.inbox_thread_state stale
WHERE
  -- Not canonical E.164
  stale.thread_key !~ '^\+1[0-9]{10}$'
  -- Can extract at least one +1XXXXXXXXXX phone
  AND (regexp_matches(stale.thread_key, '\+1[0-9]{10}', 'g'))[1] IS NOT NULL
  -- Canonical row already exists
  AND EXISTS (
    SELECT 1 FROM public.inbox_thread_state canonical
    WHERE canonical.thread_key = (regexp_matches(stale.thread_key, '\+1[0-9]{10}', 'g'))[1]
  );

-- ── 2. Report on rows that were NOT cleaned (no extractable phone or no canonical row) ────────
-- These remain in the table and require manual investigation.
-- Run this SELECT after the migration to see what's left:
--
-- SELECT thread_key, master_owner_id, updated_at
-- FROM public.inbox_thread_state
-- WHERE thread_key !~ '^\+1[0-9]{10}$';
