-- ---------------------------------------------------------------------------
-- Backend certification pass (2026-08-25): close the in-flight dedupe window.
--
-- uq_send_queue_active_dedupe_key covered only
--   ('queued','ready','runnable','scheduled','pending','paused',
--    'paused_after_hours'),
-- so the moment a row transitioned to 'processing' (claimed, mid-send) its
-- dedupe_key left the index and a concurrent writer could insert a second
-- live row with the same key. The only backstop was a non-transactional
-- 24-hour message_events content scan (limit 10) inside the processor.
--
-- This migration extends the partial index to every ACTIVE status the code
-- can write ('processing','approved','approval','held','sending'), after
-- defusing any pre-existing collisions the old window allowed: for each
-- dedupe_key with more than one row in the NEW status set, every row except
-- the newest is renamed '<key>:dupe_defused:<id>' (metadata records the
-- original) so the index build cannot fail and the duplicates stay visible.
-- ---------------------------------------------------------------------------

BEGIN;

WITH active_dupes AS (
  SELECT id,
         dedupe_key,
         row_number() OVER (
           PARTITION BY dedupe_key
           ORDER BY created_at DESC NULLS LAST, id DESC
         ) AS rn
  FROM public.send_queue
  WHERE sent_at IS NULL
    AND dedupe_key IS NOT NULL
    AND queue_status IN (
      'queued','ready','runnable','scheduled','pending','paused',
      'paused_after_hours','processing','approved','approval','held','sending'
    )
)
UPDATE public.send_queue sq
SET dedupe_key = sq.dedupe_key || ':dupe_defused:' || sq.id,
    metadata = COALESCE(sq.metadata, '{}'::jsonb) || jsonb_build_object(
      'dedupe_key_original', sq.dedupe_key,
      'dedupe_defused_at', now(),
      'dedupe_defused_reason', 'active_dedupe_index_extension_20260825'
    )
FROM active_dupes d
WHERE sq.id = d.id
  AND d.rn > 1;

DROP INDEX IF EXISTS public.uq_send_queue_active_dedupe_key;

CREATE UNIQUE INDEX uq_send_queue_active_dedupe_key
  ON public.send_queue (dedupe_key)
  WHERE sent_at IS NULL
    AND queue_status IN (
      'queued','ready','runnable','scheduled','pending','paused',
      'paused_after_hours','processing','approved','approval','held','sending'
    )
    AND dedupe_key IS NOT NULL;

-- Production audit 2026-08-26: the ENTIRE 20260428 harden set is absent from
-- the live database (broken migration history) — including provider-message
-- uniqueness. Zero existing collisions verified read-only before this ships;
-- the idempotent-send short-circuit and delivery reconciliation currently
-- rely on application-level checks alone without it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_send_queue_provider_message_id
  ON public.send_queue (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

COMMIT;
