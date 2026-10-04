-- PROPOSED — NOT APPLIED. Canonical scoring backfill support (2026-10-04).
--
-- Purpose: let apps/api/src/lib/acquisition/scoringBackfill.js run the
-- Acquisition Decision Engine over all ~171K properties overnight, throttled,
-- resumable and idempotent, so property_acquisition_scores coverage goes from
-- 170 rows to the full universe BEFORE the owner retires the Podio-era
-- properties.final_acquisition_score (which this migration does not touch).
--
-- Changes (all additive):
--   1. property_acquisition_scores.scoring_version text / scored_at timestamptz.
--      Stamped by the backfill on every row it writes ('ade@2.0.0+backfill.1').
--      Existing 170 rows stay NULL (operator / seller-flow runs; the backfill
--      skips them because their evidence.engine.version is already current).
--      Instant: nullable columns without defaults are metadata-only in PG 11+.
--   2. Index on scoring_version (table is 170 rows today; build is instant).
--   3. scoring_backfill_load_probe(): read-only DB load snapshot the runner
--      checks before EVERY chunk. Missing function => the runner pauses
--      (fails closed), it never scores blind.
--   4. Seeds system_control['acquisition_scoring_backfill'] = stopped.
--      Nothing runs until an operator calls action=start AND both env flags
--      (CRON_SCORING_BACKFILL_ENABLED, ACQUISITION_SCORING_BACKFILL_ENABLED)
--      are 'true'.
--
-- Storage note (measured 2026-10-03): today's rows average 82 KB of evidence
-- (rejected_comps ≈ 70%). The backfill writes COMPACT evidence (rejected comps
-- reduced to count + reason census); see the dry-run report for measured
-- bytes/row before approving.

BEGIN;

ALTER TABLE public.property_acquisition_scores
  ADD COLUMN IF NOT EXISTS scoring_version text,
  ADD COLUMN IF NOT EXISTS scored_at timestamptz;

COMMENT ON COLUMN public.property_acquisition_scores.scoring_version IS
  'Scoring formula version that wrote this row via the canonical backfill (e.g. ade@2.0.0+backfill.1). NULL = written by an operator / seller-flow engine run.';
COMMENT ON COLUMN public.property_acquisition_scores.scored_at IS
  'When the canonical backfill wrote this row. NULL for non-backfill runs (see computed_at).';

CREATE INDEX IF NOT EXISTS idx_property_acquisition_scores_scoring_version
  ON public.property_acquisition_scores (scoring_version);

CREATE OR REPLACE FUNCTION public.scoring_backfill_load_probe(p_long_running_seconds integer DEFAULT 20)
RETURNS TABLE (
  active_backends integer,
  long_running integer,
  lock_waits integer,
  total_backends integer,
  max_query_seconds numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    count(*) FILTER (WHERE a.state = 'active')::integer,
    count(*) FILTER (
      WHERE a.state = 'active'
        AND a.backend_type = 'client backend'
        AND now() - a.query_start > make_interval(secs => GREATEST(p_long_running_seconds, 1))
    )::integer,
    count(*) FILTER (WHERE a.wait_event_type = 'Lock')::integer,
    count(*)::integer,
    COALESCE(round(max(EXTRACT(EPOCH FROM now() - a.query_start)) FILTER (
      WHERE a.state = 'active' AND a.backend_type = 'client backend'
    )::numeric, 1), 0)
  FROM pg_stat_activity a
  WHERE a.datname = current_database()
    AND a.pid <> pg_backend_pid();
$$;

REVOKE ALL ON FUNCTION public.scoring_backfill_load_probe(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scoring_backfill_load_probe(integer) TO service_role;

INSERT INTO public.system_control (key, value, updated_at)
VALUES (
  'acquisition_scoring_backfill',
  '{"status":"stopped","scoring_version":"ade@2.0.0+backfill.1","cursor_property_id":null}',
  now()
)
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- Pause first (action=pause, or unset CRON_SCORING_BACKFILL_ENABLED), then:
--
-- BEGIN;
--   -- Optional: remove backfill-written rows (operator / seller-flow rows have
--   -- scoring_version NULL and are untouched). Batch it at scale:
--   --   DELETE FROM public.property_acquisition_scores
--   --    WHERE property_id IN (SELECT property_id FROM public.property_acquisition_scores
--   --                           WHERE scoring_version = 'ade@2.0.0+backfill.1' LIMIT 5000);
--   DROP FUNCTION IF EXISTS public.scoring_backfill_load_probe(integer);
--   DROP INDEX IF EXISTS public.idx_property_acquisition_scores_scoring_version;
--   ALTER TABLE public.property_acquisition_scores
--     DROP COLUMN IF EXISTS scored_at,
--     DROP COLUMN IF EXISTS scoring_version;
--   DELETE FROM public.system_control WHERE key = 'acquisition_scoring_backfill';
-- COMMIT;
--
-- NOTE: drop the columns only AFTER the backfill rows are deleted or the API is
-- rolled back; the backfill store refuses to write when the columns are absent
-- (migration_not_applied), but rows it already wrote keep compact evidence.
