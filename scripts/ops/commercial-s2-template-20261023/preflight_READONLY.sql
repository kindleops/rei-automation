-- ─── preflight_READONLY.sql ─────────────────────────────────────────────────────────────────
-- Commercial S2 "consider selling" template, 2026-10-23. READ-ONLY. It writes nothing.
-- NOT RUN BY ITS AUTHOR: no production credential was used. The owner runs it under an
-- approved, role-enforced read-only credential. BEGIN READ ONLY on its own is not the safety
-- boundary. The role is.
--
-- It answers the questions PROPOSED_insert.sql and PROPOSED_activate.sql depend on:
--   P1  do the sms_templates columns the insert writes exist?
--   P2  how are the existing ACTIVE English S2 consider_selling rows configured
--       (safe_for_auto_reply, reply_mode, identity_contact_mode, stage_label, scope, metrics)?
--       The insert copies safe_for_auto_reply / identity_contact_mode / stage_label from them.
--   P3  does a commercial S2 row already exist (any language, active or not)?
--   P4  is the template_id free?
--   P5  how do the existing first-touch / S2 rows handle STOP language, and is any company
--       name / {{company_name}}-style token in use anywhere in the catalog?
--   P6  ranking exposure (see PROPOSED_activate.sql): on a thread whose property cannot be
--       recovered and whose context has no scope label, the legacy scope filter admits every
--       row. A new row has NULL success_rate / usage_count, so it ranks BELOW any row that
--       carries either metric, and ABOVE (by updated_at) rows that carry neither.
--   P7  what the deployed queue processor is running (activation requires the hotfix build).

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- P1. Columns the insert writes (expect 22 rows; any missing column fails the insert's guard).
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'sms_templates'
   AND column_name IN ('template_id', 'template_name', 'use_case', 'language', 'template_body',
                       'english_translation', 'variables', 'is_active', 'safe_for_auto_reply',
                       'reply_mode', 'identity_contact_mode', 'property_type_scope',
                       'allowed_property_groups', 'prohibited_property_groups', 'stage_code',
                       'stage_label', 'is_first_touch', 'is_follow_up', 'minimal_fallback',
                       'quarantine_state', 'metadata', 'updated_at')
 ORDER BY column_name;

-- P1b. CHECK constraints on sms_templates (reply_mode / quarantine_state vocabularies).
SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'public.sms_templates'::regclass AND contype = 'c'
 ORDER BY conname;

-- P2. Active English S2 consider_selling rows (the family the new row joins).
SELECT template_id, stage_code, stage_label, property_type_scope, allowed_property_groups,
       prohibited_property_groups, is_active, safe_for_auto_reply, reply_mode, identity_contact_mode,
       is_first_touch, is_follow_up, minimal_fallback, quarantine_state, success_rate, usage_count,
       updated_at, left(template_body, 140) AS body
  FROM public.sms_templates
 WHERE lower(use_case) = 'consider_selling' AND language = 'English' AND stage_code = 'S2'
 ORDER BY is_active DESC, template_id;

-- P2b. The values the insert copies (it refuses unless safe_for_auto_reply is unanimous).
SELECT count(*)                                   AS active_s2_auto_reply_rows,
       array_agg(DISTINCT safe_for_auto_reply)    AS safe_for_auto_reply_values,
       array_agg(DISTINCT identity_contact_mode)  AS identity_contact_mode_values,
       array_agg(DISTINCT stage_label)            AS stage_label_values,
       array_agg(DISTINCT reply_mode)             AS reply_mode_values
  FROM public.sms_templates
 WHERE lower(use_case) = 'consider_selling' AND language = 'English' AND stage_code = 'S2'
   AND is_active
   AND (reply_mode IS NULL OR lower(reply_mode) IN ('', 'auto', 'auto_reply'));

-- P3. Any commercial-scoped S2 / consider_selling row already present?
SELECT template_id, language, stage_code, property_type_scope, is_active, safe_for_auto_reply,
       reply_mode, left(template_body, 120) AS body
  FROM public.sms_templates
 WHERE lower(use_case) = 'consider_selling'
   AND (lower(COALESCE(property_type_scope, '')) ~ '(commercial|office|industrial|warehouse|hotel|motel|retail|strip|storage)'
        OR allowed_property_groups && ARRAY['self_storage','retail','office','industrial','hotel_motel','mobile_home_park','other_commercial']::text[])
 ORDER BY language, template_id;

-- P4. The proposed template_id (expect 0 rows; template_id has no unique index).
SELECT template_id, is_active, left(template_body, 160) AS body
  FROM public.sms_templates
 WHERE template_id = 'lc-s2-consider-com-en-01';

-- P5. STOP / opt-out wording and company tokens across the catalog.
SELECT use_case, stage_code, language, is_active, count(*) AS rows_with_stop_language
  FROM public.sms_templates
 WHERE template_body ~* '(reply|text)\s+stop'
 GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4;

SELECT count(*) FILTER (WHERE is_active AND lower(use_case) = 'ownership_check')                      AS active_first_touch_rows,
       count(*) FILTER (WHERE is_active AND lower(use_case) = 'ownership_check'
                          AND template_body ~* '(reply|text)\s+stop')                                    AS active_first_touch_with_stop,
       count(*) FILTER (WHERE template_body ~* '\{\{\s*(company|company_name|brand|brand_name|business_name|org_name)\s*\}\}') AS rows_with_company_token,
       count(*) FILTER (WHERE template_body ~* '\{\{\s*first_name\s*\}\}')                             AS rows_with_bare_first_name_token
  FROM public.sms_templates;

-- P5b. The Commercial (Other) scope convention in use today (allowed / prohibited lists).
SELECT property_type_scope, allowed_property_groups, prohibited_property_groups, count(*) AS n,
       count(*) FILTER (WHERE is_active) AS active
  FROM public.sms_templates
 WHERE property_type_scope ILIKE 'commercial%'
 GROUP BY 1, 2, 3 ORDER BY n DESC;

-- P6. Ranking exposure: active English S2 consider_selling auto-reply rows that carry a metric.
--     PROPOSED_activate.sql refuses unless at least one residential-admitting row does.
SELECT count(*) FILTER (WHERE success_rate IS NOT NULL OR usage_count IS NOT NULL) AS rows_with_metric,
       count(*) FILTER (WHERE success_rate IS NULL AND usage_count IS NULL)          AS rows_without_metric
  FROM public.sms_templates
 WHERE lower(use_case) = 'consider_selling' AND language = 'English' AND stage_code = 'S2'
   AND is_active AND safe_for_auto_reply
   AND lower(COALESCE(property_type_scope, '')) !~ '(commercial|office|industrial|warehouse|hotel|motel|retail|strip|storage|land|vacant)';

-- P7. What the queue processor is executing (activation requires the hotfix build, not 6ff4a24a).
SELECT key, value, updated_at
  FROM public.system_control
 WHERE key IN ('queue_processor_last_build_sha', 'queue_processor_last_deploy_sha', 'queue_processor_heartbeat_at')
 ORDER BY key;

ROLLBACK;
