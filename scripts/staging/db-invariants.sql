-- Scheduling + seller-portal invariants, executed on the real staging Postgres.
-- Every check records PASS/FAIL; all test rows are tagged and removed at the end.
-- Run: supabase db query --linked --workdir <staging link dir> -f scripts/staging/db-invariants.sql

SELECT staging_guard.assert_staging();

CREATE TEMP TABLE cert_result (check_name text, pass boolean, detail text);
CREATE TEMP TABLE cert_ids (k text PRIMARY KEY, id uuid);

DO $$
DECLARE
  person uuid; p_type uuid; t_type uuid; a1 uuid; a2 uuid; moved uuid; err text;
  ins text := 'INSERT INTO scheduling_appointments (brand_key, event_type_id, resource_id, start_at, end_at, block_start_at, block_end_at, source) VALUES ($1,$2,$3,$4,$5,$6,$7,''db_invariants'') RETURNING id';
BEGIN
  INSERT INTO scheduling_resources (display_name, timezone, environment) VALUES ('DB invariants (fixture)', 'America/New_York', 'test') RETURNING id INTO person;
  INSERT INTO cert_ids VALUES ('person', person);
  SELECT id INTO p_type FROM scheduling_event_types WHERE brand_key = 'prominent_cash_offer' AND type_key = 'offer_review';
  INSERT INTO scheduling_event_types (brand_key, type_key, name, duration_minutes, environment) VALUES ('second_brand_test', 'cert_' || substr(md5(random()::text), 1, 8), 'Cert', 30, 'test') RETURNING id INTO t_type;
  INSERT INTO cert_ids VALUES ('t_type', t_type);

  EXECUTE ins INTO a1 USING 'prominent_cash_offer', p_type, person, '2031-01-06T18:00Z'::timestamptz, '2031-01-06T18:30Z'::timestamptz, '2031-01-06T18:00Z'::timestamptz, '2031-01-06T18:40Z'::timestamptz;
  BEGIN
    EXECUTE ins INTO a2 USING 'second_brand_test', t_type, person, '2031-01-06T18:35Z'::timestamptz, '2031-01-06T19:05Z'::timestamptz, '2031-01-06T18:35Z'::timestamptz, '2031-01-06T19:05Z'::timestamptz;
    INSERT INTO cert_result VALUES ('cross-brand overlap (incl. buffer) rejected', false, 'inserted');
  EXCEPTION WHEN exclusion_violation THEN
    INSERT INTO cert_result VALUES ('cross-brand overlap (incl. buffer) rejected', true, '23P01');
  END;

  EXECUTE ins INTO a2 USING 'second_brand_test', t_type, person, '2031-01-06T18:40Z'::timestamptz, '2031-01-06T19:10Z'::timestamptz, '2031-01-06T18:40Z'::timestamptz, '2031-01-06T19:10Z'::timestamptz;
  INSERT INTO cert_result VALUES ('adjacent blocks do not conflict', a2 IS NOT NULL, null);

  UPDATE scheduling_appointments SET status = 'cancelled' WHERE id = a2;
  EXECUTE ins INTO a2 USING 'second_brand_test', t_type, person, '2031-01-06T18:40Z'::timestamptz, '2031-01-06T19:10Z'::timestamptz, '2031-01-06T18:40Z'::timestamptz, '2031-01-06T19:10Z'::timestamptz;
  INSERT INTO cert_result VALUES ('cancelling releases the time', a2 IS NOT NULL, null);

  BEGIN
    PERFORM scheduling_reschedule_appointment(a1, NULL, jsonb_build_object('start_at','2031-01-06T18:50Z','end_at','2031-01-06T19:20Z','block_start_at','2031-01-06T18:50Z','block_end_at','2031-01-06T19:20Z'), 'cert');
    INSERT INTO cert_result VALUES ('reschedule into taken time fails, original intact', false, 'moved');
  EXCEPTION WHEN exclusion_violation THEN
    INSERT INTO cert_result SELECT 'reschedule into taken time fails, original intact', status = 'scheduled' AND version = 1, status || ' v' || version FROM scheduling_appointments WHERE id = a1;
  END;

  moved := scheduling_reschedule_appointment(a1, 1, jsonb_build_object('start_at','2031-01-07T15:00Z','end_at','2031-01-07T15:30Z','block_start_at','2031-01-07T15:00Z','block_end_at','2031-01-07T15:40Z'), 'cert');
  INSERT INTO cert_result SELECT 'reschedule into free time is atomic and linked',
    (SELECT status = 'rescheduled' AND rescheduled_to_id = moved FROM scheduling_appointments WHERE id = a1)
    AND (SELECT status = 'scheduled' AND rescheduled_from_id = a1 FROM scheduling_appointments WHERE id = moved), null;

  BEGIN
    PERFORM scheduling_reschedule_appointment(moved, 9, jsonb_build_object('start_at','2031-01-08T15:00Z','end_at','2031-01-08T15:30Z','block_start_at','2031-01-08T15:00Z','block_end_at','2031-01-08T15:30Z'), 'cert');
    INSERT INTO cert_result VALUES ('stale version refused', false, 'moved');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO cert_result VALUES ('stale version refused', SQLERRM LIKE '%appointment_version_conflict%', SQLERRM);
  END;

  BEGIN
    INSERT INTO ops_operator_permissions (user_id, permission, granted_by) VALUES (gen_random_uuid(), 'scheduling.admin', 'cert');
    INSERT INTO cert_result VALUES ('permission requires an allowlisted operator', false, 'inserted');
  EXCEPTION WHEN foreign_key_violation THEN
    INSERT INTO cert_result VALUES ('permission requires an allowlisted operator', true, '23503');
  END;

  BEGIN
    INSERT INTO seller_portal_grants (identity_id, opportunity_id, granted_via) VALUES (gen_random_uuid(), gen_random_uuid(), 'intake_email_match');
    INSERT INTO cert_result VALUES ('grants reference real identities and opportunities', false, 'inserted');
  EXCEPTION WHEN foreign_key_violation THEN
    INSERT INTO cert_result VALUES ('grants reference real identities and opportunities', true, '23503');
  END;
END $$;

-- Least privilege for the API roles PostgREST uses.
DO $$
DECLARE r text; t text; ok boolean; e text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH t IN ARRAY ARRAY['scheduling_appointments', 'scheduling_calendar_connections', 'scheduling_resources', 'seller_portal_sessions', 'seller_portal_identities', 'seller_portal_login_codes', 'seller_portal_messages', 'seller_portal_document_shares', 'ops_operator_permissions'] LOOP
      ok := NOT has_table_privilege(r, format('public.%I', t), 'SELECT') AND NOT has_table_privilege(r, format('public.%I', t), 'INSERT');
      INSERT INTO cert_result VALUES (format('%s has no access to %s', r, t), ok, null);
    END LOOP;
    INSERT INTO cert_result VALUES (format('%s cannot call scheduling_reschedule_appointment', r), NOT has_function_privilege(r, 'public.scheduling_reschedule_appointment(uuid,integer,jsonb,text)', 'EXECUTE'), null);
    INSERT INTO cert_result VALUES (format('%s cannot call staging_identity', r), NOT has_function_privilege(r, 'public.staging_identity()', 'EXECUTE'), null);
  END LOOP;
  INSERT INTO cert_result VALUES ('RLS on every new table',
    NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND (relname LIKE 'scheduling\_%' OR relname LIKE 'seller\_portal\_%' OR relname = 'ops_operator_permissions') AND NOT relrowsecurity), null);
  INSERT INTO cert_result VALUES ('exclusion constraint present', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduling_appointments_no_overlap' AND contype = 'x'), null);
END $$;

-- Cleanup: nothing from this run survives.
DELETE FROM scheduling_appointment_events WHERE appointment_id IN (SELECT id FROM scheduling_appointments WHERE source = 'db_invariants' OR created_by = 'cert');
DELETE FROM scheduling_appointments WHERE resource_id = (SELECT id FROM cert_ids WHERE k = 'person');
DELETE FROM scheduling_event_types WHERE id = (SELECT id FROM cert_ids WHERE k = 't_type');
DELETE FROM scheduling_resources WHERE id = (SELECT id FROM cert_ids WHERE k = 'person');

SELECT check_name, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, detail FROM cert_result ORDER BY pass, check_name;
