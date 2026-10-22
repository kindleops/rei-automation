-- ─── preflight_pending_template_scope_mismatch_READONLY.sql ────────────────────────────────
-- READ-ONLY PRODUCTION PREFLIGHT (2026-10-22, hotfix/template-scope-replies). NOT RUN BY ITS
-- AUTHOR: no production credential was used. The owner runs it under an APPROVED, ROLE-ENFORCED
-- read-only credential (BEGIN READ ONLY alone is not the safety boundary — the role is).
--
-- Question 1 (the list to review / pause): which PENDING send_queue rows carry a template whose
-- property_type_scope (or wording) does not describe the row's property?
--   - single-family scope ("single_family,residential", "Single Family") on anything but a
--     single-family home (840901 / 840902 class);
--   - a unit-specific scope (Duplex / Triplex / Fourplex / 5+ Units) on a property whose units are
--     not that count — including multi-family with units_count 0 / 1 / NULL (213841 class);
--   - unit wording ("units", "apartments", "building", "multifamily") on a property without a KNOWN
--     2+ unit count;
--   - commercial / storage / retail scope or wording on a residential property, and residential
--     scope (Any Residential / Residential / missing) on a commercial or land property.
-- The property group below is a SQL approximation of canonicalPropertyGroupOf() in
-- apps/api/src/lib/domain/templates/template-asset-compatibility.js (the authority after the
-- hotfix is the JS send-time guard, which re-judges every row before transport). Every row is a
-- CANDIDATE for a person to read.
--
-- Question 2 (Defect 3 evidence): for property 2131479286 (+1281…5725), what the inbound /
-- outbound / audit rows carried, and which approved S2 / S3 rows exist per scope.
--
-- Load: pending rows only (a few thousand at most), one join each to properties (PK) and
-- sms_templates (template_id). statement_timeout 60s. Run off-hours, serially.
--
-- Columns read (all read by production code today): send_queue(id, queue_status, is_locked,
-- property_id, selected_template_id, template_id, metadata, scheduled_for, to_phone_number,
-- use_case_template, message_body, created_at, sent_at); properties(property_id, property_type,
-- property_class, units_count, asset_subclass, is_self_storage, is_commercial_retail,
-- building_square_feet, total_bedrooms, year_built); sms_templates(template_id, use_case,
-- stage_code, language, property_type_scope, allowed_property_groups, prohibited_property_groups,
-- template_body, is_active, safe_for_auto_reply, reply_mode); message_events(id, direction,
-- property_id, from_phone_number, created_at); inbound_intelligence_audit(source_event_id,
-- canonical_intent, execution_blocked_reason, human_review_status, metadata, created_at).

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';

-- ── Q1. Pending rows whose template scope mismatches the property ──────────────────────────
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
SELECT *
  FROM judged
 WHERE mismatch_reason IS NOT NULL
 ORDER BY scheduled_for NULLS LAST, queue_row_id
 LIMIT 2000;

-- Q1 summary (same predicate), for the pause decision.
-- (Re-run the WITH above with this final SELECT instead, or wrap it in a view in a scratch session:)
--   SELECT mismatch_reason, template_id, count(*) FROM judged WHERE mismatch_reason IS NOT NULL
--    GROUP BY 1, 2 ORDER BY 3 DESC;

-- ── Q2. Defect 3 evidence: property 2131479286 (+1281…5725, Commercial / Other) ─────────────
SELECT property_id, property_type, property_class, units_count, asset_class, asset_subclass, original_property_type
  FROM public.properties WHERE property_id = '2131479286';

SELECT id, queue_status, sent_at, property_id, selected_template_id, template_id, use_case_template,
       left(message_body, 140) AS body
  FROM public.send_queue
 WHERE property_id = '2131479286'
 ORDER BY created_at DESC LIMIT 20;

SELECT id, direction, property_id, from_phone_number, created_at, left(message_body, 80) AS body
  FROM public.message_events
 WHERE property_id = '2131479286'
 ORDER BY created_at DESC LIMIT 20;

-- The audit row for the "Yes" (source_event_id = the inbound message_events.id above).
SELECT a.source_event_id, a.canonical_intent, a.universal_stage, a.granular_stage, a.execution_blocked_reason,
       a.human_review_status, a.metadata->'selected_template' AS selected_template,
       a.metadata->'context_resolution' AS context_resolution, a.created_at
  FROM public.inbound_intelligence_audit a
 WHERE a.source_event_id IN (
         SELECT id::text FROM public.message_events WHERE property_id = '2131479286' AND direction = 'inbound')
 ORDER BY a.created_at DESC LIMIT 5;

-- Does an APPROVED commercial S2 interest row exist? (If not, a commercial "Yes" correctly holds
-- for a person after the hotfix — the binding flow never skips S2 to S3.)
SELECT use_case, language, property_type_scope, template_id, is_active, safe_for_auto_reply, reply_mode,
       allowed_property_groups, left(template_body, 100) AS body
  FROM public.sms_templates
 WHERE use_case IN ('consider_selling', 'seller_asking_price')
   AND is_active
   AND safe_for_auto_reply
 ORDER BY use_case, language, property_type_scope NULLS FIRST, template_id;

ROLLBACK;
