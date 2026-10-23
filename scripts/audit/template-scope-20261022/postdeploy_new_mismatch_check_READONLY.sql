-- ─── postdeploy_new_mismatch_check_READONLY.sql ─────────────────────────────────────────────
-- READ-ONLY. Run AFTER the template-scope hotfix (hotfix/template-scope-prod) is live and the first
-- feeder cycle has run. It writes nothing. NOT RUN BY ITS AUTHOR. The owner runs it under an approved,
-- role-enforced read-only credential.
--
-- The predicate is the one in the owner's 2026-10-23 pause watcher
-- (prod-template-scope-pause/watch_pause.sql), copied VERBATIM. That watcher has already run
-- against production. It uses scheduled_for_utc, and it covers ownership_check rows that are
-- queued / scheduled, unlocked and unsent. Two filters are added:
--   created_at >= :deploy_at   only rows the NEW build wrote (set it to the deploy completion time)
--   the paused rows (public._bk_tplscope_pause_20261023) are excluded; they are not pending anyway
-- PASS = Q1 returns 0 rows. Q2 is context: what the new build queued since the deploy, by template.
--
-- Usage: psql ... -v deploy_at="'2026-10-23T15:00:00Z'" -f postdeploy_new_mismatch_check_READONLY.sql
-- (in an SQL editor, replace :deploy_at with the timestamp literal.)

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';

-- Q1. NEW mismatches (expect 0 rows)
WITH pending AS (
  SELECT q.id, q.queue_status, q.is_locked, q.property_id, q.to_phone_number, q.scheduled_for_utc AS scheduled_for,
         q.use_case_template, q.metadata->>'campaign_id' AS campaign_id,
         COALESCE(NULLIF(q.selected_template_id, ''), NULLIF(q.template_id, ''), NULLIF(q.metadata->>'selected_template_id', '')) AS template_id,
         q.message_body
    FROM public.send_queue q
   WHERE q.queue_status IN ('queued', 'scheduled')
     AND COALESCE(q.is_locked, false) = false AND q.sent_at IS NULL AND q.provider_message_id IS NULL
     AND q.use_case_template = 'ownership_check'
     AND q.created_at >= (:deploy_at)::timestamptz
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
SELECT queue_row_id, mismatch_reason, template_id, property_id, property_group, units_count, scheduled_for, message_preview
  FROM judged
 WHERE mismatch_reason IS NOT NULL
   AND mismatch_reason NOT IN ('property_record_missing', 'template_row_missing')
   AND queue_row_id::text NOT IN (SELECT queue_row_id FROM public._bk_tplscope_pause_20261023)
 ORDER BY scheduled_for NULLS LAST, queue_row_id;

-- Q2. What the new build queued since the deploy (ownership_check), by template and status.
SELECT COALESCE(NULLIF(q.selected_template_id, ''), NULLIF(q.template_id, '')) AS template_id, q.queue_status, count(*)
  FROM public.send_queue q
 WHERE q.use_case_template = 'ownership_check'
   AND q.created_at >= (:deploy_at)::timestamptz
 GROUP BY 1, 2 ORDER BY 3 DESC;

-- Q3. Send-time guard outcomes since the deploy (refused = blocked template_asset_incompatible).
SELECT q.guard_reason, q.queue_status, count(*)
  FROM public.send_queue q
 WHERE q.updated_at >= (:deploy_at)::timestamptz
   AND q.guard_reason = 'template_asset_incompatible'
 GROUP BY 1, 2;

ROLLBACK;
