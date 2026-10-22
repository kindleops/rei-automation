-- ─── PROPOSED_pause_template_scope_mismatch_20261022.sql ───────────────────────────────────
-- PROPOSED — NOT EXECUTED. OWNER DECISION. A production write; it needs its own explicit
-- authorization (one prod write per authorization), run by the owner outside auto mode.
--
-- What it does: pauses the PENDING send_queue rows that preflight_pending_template_scope_mismatch
-- _READONLY.sql lists (same predicate, copied verbatim below), after snapshotting each full row
-- into public._bk_tplscope_pause_20261022. Nothing is deleted; no row other than the snapshotted
-- ones is touched; in-flight rows (is_locked / processing / sending) are never touched.
--
-- Run order: (1) run the READ-ONLY preflight and review its list; (2) set the expected count in
-- the guard below to the reviewed number; (3) run this file; (4) verify with the POSTCHECK;
-- (5) if needed, run the ROLLBACK section (separately authorized).
--
-- Status used: 'paused' (in the send_queue_status_check vocabulary since 20260504; never claimed
-- by the runner). The row's previous status and metadata live in the snapshot. When the hotfix is
-- deployed, the send-time asset guard refuses (or re-selects an asset-eligible template for) any
-- such row anyway; this pause is the containment until then.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public._bk_tplscope_pause_20261022 (
  queue_row_id      text PRIMARY KEY,
  previous_status   text NOT NULL,
  previous_metadata jsonb,
  mismatch_reason   text NOT NULL,
  template_id       text,
  property_id       text,
  property_group    text,
  row_snapshot      jsonb NOT NULL,
  paused_at         timestamptz NOT NULL DEFAULT now()
);

-- Snapshot (idempotent: a row already snapshotted keeps its FIRST snapshot).
INSERT INTO public._bk_tplscope_pause_20261022
       (queue_row_id, previous_status, previous_metadata, mismatch_reason, template_id, property_id, property_group, row_snapshot)
WITH pending AS (
  SELECT q.id, q.queue_status, q.is_locked, q.property_id, q.to_phone_number, q.scheduled_for,
         q.use_case_template, q.metadata->>'campaign_id' AS campaign_id,
         COALESCE(NULLIF(q.selected_template_id, ''), NULLIF(q.template_id, ''), NULLIF(q.metadata->>'selected_template_id', '')) AS template_id,
         q.message_body
    FROM public.send_queue q
   WHERE q.queue_status IN ('queued', 'scheduled', 'pending', 'ready', 'approved')
     AND COALESCE(q.is_locked, false) = false
),
prop AS (
  SELECT p.property_id,
         p.property_type, p.property_class, p.units_count, p.asset_subclass,
         lower(COALESCE(p.property_type, '')) AS pt,
         lower(COALESCE(p.property_class, '')) AS pc,
         lower(COALESCE(p.asset_subclass, '')) AS sub,
         (COALESCE(p.building_square_feet, 0) > 0 OR COALESCE(p.total_bedrooms, 0) > 0 OR COALESCE(p.year_built, 0) > 0) AS has_structure,
         p.is_self_storage, p.is_commercial_retail
    FROM public.properties p
   WHERE p.property_id IN (SELECT property_id FROM pending WHERE property_id IS NOT NULL)
),
grp AS (
  SELECT property_id, property_type, property_class, units_count, asset_subclass,
    CASE
      WHEN COALESCE(is_self_storage, false) OR sub ~ 'storage' OR pt ~ 'storage' THEN 'self_storage'
      WHEN COALESCE(is_commercial_retail, false) OR sub ~ '(retail|strip center|shopping)' OR pt ~ '(retail|strip center|shopping)' THEN 'retail'
      WHEN pt ~ '(single[ -]?family|\msfr\M|townho(use|me)|condo|mobile home|manufactured)' THEN 'sfr'
      WHEN pt ~ 'duplex' THEN 'duplex'
      WHEN pt ~ 'triplex' THEN 'triplex'
      WHEN pt ~ '(fourplex|quadplex|4[ -]?plex)' THEN 'fourplex'
      WHEN pt ~ '(multi[ -]?family|apartment|\munits?\M)' OR pc ~ 'multi[ -]?family' THEN
        CASE WHEN units_count = 2 THEN 'duplex' WHEN units_count = 3 THEN 'triplex' WHEN units_count = 4 THEN 'fourplex'
             WHEN units_count BETWEEN 5 AND 10 THEN 'small_multifamily' WHEN units_count > 10 THEN 'multifamily_5_plus'
             ELSE 'multifamily_units_unknown' END
      WHEN pt ~ '(vacant|land|\mlot\M|parcel|acre)' AND NOT has_structure THEN 'land'
      WHEN pc ~ 'residential' THEN
        CASE WHEN units_count = 1 THEN 'sfr' WHEN units_count = 2 THEN 'duplex' WHEN units_count = 3 THEN 'triplex'
             WHEN units_count = 4 THEN 'fourplex' WHEN units_count BETWEEN 5 AND 10 THEN 'small_multifamily'
             WHEN units_count > 10 THEN 'multifamily_5_plus' ELSE 'residential' END
      WHEN pc ~ '(commercial|industrial|exempt|agricult)' OR pt ~ '(commercial|office|industrial|warehouse|hotel|motel)' THEN 'other_commercial'
      WHEN pc ~ '(vacant|land)' AND NOT has_structure THEN 'land'
      ELSE 'unknown'
    END AS property_group
  FROM prop
),
tpl AS (
  SELECT t.template_id, t.use_case, t.stage_code, t.language, t.property_type_scope, t.allowed_property_groups,
         t.prohibited_property_groups, t.template_body,
    CASE
      WHEN lower(COALESCE(t.property_type_scope, '')) ~ 'storage' THEN 'storage'
      WHEN lower(COALESCE(t.property_type_scope, '')) ~ '(retail|strip)' THEN 'retail'
      WHEN lower(COALESCE(t.property_type_scope, '')) ~ '(commercial|office|industrial|warehouse|hotel|motel)' THEN 'commercial'
      WHEN lower(COALESCE(t.property_type_scope, '')) ~ '(\mland\M|vacant)' THEN 'land'
      WHEN lower(COALESCE(t.property_type_scope, '')) ~ '(5\+|five\s*\+)' THEN 'five_plus'
      WHEN lower(COALESCE(t.property_type_scope, '')) = 'duplex' THEN 'duplex'
      WHEN lower(COALESCE(t.property_type_scope, '')) = 'triplex' THEN 'triplex'
      WHEN lower(COALESCE(t.property_type_scope, '')) IN ('fourplex', 'quadplex') THEN 'fourplex'
      WHEN lower(COALESCE(t.property_type_scope, '')) ~ '(single[ _-]?family|\msfr\M)' THEN 'single_family'
      WHEN lower(COALESCE(t.property_type_scope, '')) ~ '(multi[ _-]?family|landlord)' THEN 'landlord_multifamily'
      ELSE 'generic_residential'
    END AS scope_kind,
    (lower(COALESCE(t.template_body, '')) ~ '(\{\{?\s*unit_count\s*\}?\}|\munits?\M|\munidades?\M|\mapartments?\M|\mapartamentos?\M|\mmulti[ -]?family\M|\mbuilding\M|\mduplex\M|\mtriplex\M|\mfourplex\M)') AS unit_words,
    (lower(COALESCE(t.template_body, '')) ~ '(self[ -]?storage|mini[ -]?storage|retail (center|propert|space|building)|strip (center|mall)|shopping center|commercial (property|building|real estate|space)|office building|warehouse|industrial (property|building))') AS commercial_words
    FROM public.sms_templates t
   WHERE t.template_id IN (SELECT template_id FROM pending WHERE template_id IS NOT NULL)
),
judged AS (
  SELECT q.id AS queue_row_id, q.queue_status, q.scheduled_for, q.campaign_id, q.use_case_template,
         q.to_phone_number, q.property_id, g.property_type, g.property_class, g.units_count, g.asset_subclass,
         g.property_group, q.template_id, t.property_type_scope, t.scope_kind, t.allowed_property_groups,
         t.unit_words, t.commercial_words, left(q.message_body, 160) AS message_preview,
    CASE
      WHEN g.property_group IS NULL THEN 'property_record_missing'
      WHEN t.template_id IS NULL THEN 'template_row_missing'
      WHEN t.scope_kind = 'single_family' AND g.property_group <> 'sfr' THEN 'single_family_scope_on_' || g.property_group
      WHEN t.scope_kind = 'five_plus' AND g.property_group NOT IN ('small_multifamily', 'multifamily_5_plus') THEN 'five_plus_scope_on_' || g.property_group
      WHEN t.scope_kind IN ('duplex', 'triplex', 'fourplex') AND g.property_group <> t.scope_kind THEN t.scope_kind || '_scope_on_' || g.property_group
      WHEN t.scope_kind IN ('storage', 'retail', 'commercial')
           AND g.property_group NOT IN ('self_storage', 'retail', 'office', 'industrial', 'hotel_motel', 'mobile_home_park', 'other_commercial') THEN t.scope_kind || '_scope_on_' || g.property_group
      WHEN t.scope_kind = 'land' AND g.property_group <> 'land' THEN 'land_scope_on_' || g.property_group
      WHEN t.scope_kind IN ('generic_residential', 'landlord_multifamily')
           AND g.property_group IN ('self_storage', 'retail', 'office', 'industrial', 'hotel_motel', 'mobile_home_park', 'other_commercial', 'land') THEN 'residential_scope_on_' || g.property_group
      WHEN t.commercial_words AND g.property_group NOT IN ('self_storage', 'retail', 'office', 'industrial', 'hotel_motel', 'mobile_home_park', 'other_commercial') THEN 'commercial_words_on_' || g.property_group
      WHEN t.unit_words AND g.property_group NOT IN ('duplex', 'triplex', 'fourplex', 'small_multifamily', 'multifamily_5_plus') THEN 'unit_words_on_' || g.property_group
      WHEN g.property_group IN ('residential', 'unknown') AND t.scope_kind <> 'generic_residential' THEN 'specific_scope_on_' || g.property_group
      WHEN g.property_group = 'multifamily_units_unknown' AND t.scope_kind NOT IN ('generic_residential', 'landlord_multifamily') THEN 'specific_scope_on_units_unknown'
      ELSE NULL
    END AS mismatch_reason
    FROM pending q
    LEFT JOIN grp g ON g.property_id = q.property_id
    LEFT JOIN tpl t ON t.template_id = q.template_id
)
SELECT j.queue_row_id::text, q.queue_status, q.metadata, j.mismatch_reason, j.template_id, j.property_id, j.property_group, to_jsonb(q)
  FROM judged j
  JOIN public.send_queue q ON q.id = j.queue_row_id
 WHERE j.mismatch_reason IS NOT NULL
   AND j.mismatch_reason NOT IN ('property_record_missing', 'template_row_missing')
ON CONFLICT (queue_row_id) DO NOTHING;

-- Guard: the snapshot must match the reviewed count. EDIT :expected before running.
DO $$
DECLARE n integer; expected integer := -1; -- ← set to the reviewed preflight count
BEGIN
  SELECT count(*) INTO n FROM public._bk_tplscope_pause_20261022 WHERE paused_at >= now() - interval '1 minute';
  IF expected < 0 OR n <> expected THEN
    RAISE EXCEPTION 'tplscope pause: snapshot has % rows, expected % — refusing (edit the expected count after review)', n, expected;
  END IF;
END $$;

-- Pause: only rows still pending and unlocked, and only the snapshotted ones.
UPDATE public.send_queue q
   SET queue_status = 'paused',
       updated_at   = now(),
       metadata     = COALESCE(q.metadata, '{}'::jsonb) || jsonb_build_object(
                        'tplscope_pause_20261022', jsonb_build_object(
                          'reason', b.mismatch_reason,
                          'previous_status', b.previous_status,
                          'property_group', b.property_group,
                          'template_id', b.template_id,
                          'paused_at', now(),
                          'source', 'PROPOSED_pause_template_scope_mismatch_20261022.sql'))
  FROM public._bk_tplscope_pause_20261022 b
 WHERE q.id::text = b.queue_row_id
   AND q.queue_status IN ('queued', 'scheduled', 'pending', 'ready', 'approved')
   AND COALESCE(q.is_locked, false) = false;

COMMIT;

-- ── POSTCHECK (read-only) ───────────────────────────────────────────────────────────────────
--   SELECT b.mismatch_reason, q.queue_status, count(*)
--     FROM public._bk_tplscope_pause_20261022 b JOIN public.send_queue q ON q.id::text = b.queue_row_id
--    GROUP BY 1, 2 ORDER BY 1, 2;

-- ── ROLLBACK (separately authorized; restores exactly what this file changed) ───────────────
-- Restores previous status + metadata ONLY for rows this file paused and nothing else has
-- touched since (still 'paused' and still carrying this file's stamp).
--
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- UPDATE public.send_queue q
--    SET queue_status = b.previous_status,
--        metadata     = b.previous_metadata,
--        updated_at   = now()
--   FROM public._bk_tplscope_pause_20261022 b
--  WHERE q.id::text = b.queue_row_id
--    AND q.queue_status = 'paused'
--    AND q.metadata ? 'tplscope_pause_20261022';
-- -- verify: SELECT count(*) FROM public.send_queue WHERE metadata ? 'tplscope_pause_20261022' AND queue_status = 'paused';  -- 0
-- COMMIT;
-- -- keep public._bk_tplscope_pause_20261022 until the owner approves dropping it.
