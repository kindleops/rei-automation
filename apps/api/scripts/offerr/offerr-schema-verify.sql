-- Offerr Evaluation Spine — schema verification suite.
--
-- Verifies that PROPOSED_20260729120000_offerr_evaluation_spine.sql produced
-- exactly the documented contract: tables, columns, constraints, indexes,
-- RLS, grants, trigger, and the default-disabled feature flag.
--
-- READ-ONLY except for the clearly-labelled behavioural probes in section 9,
-- which insert and then roll back inside an explicit transaction.
--
-- Usage (never against production):
--   psql "$OFFERR_VERIFY_DATABASE_URL" -v ON_ERROR_STOP=1 -f offerr-schema-verify.sql
--
-- Every check emits PASS or FAIL. A FAIL never aborts the run, so a single
-- pass produces the complete picture.

\pset pager off
\set ON_ERROR_STOP 0

CREATE OR REPLACE FUNCTION pg_temp.chk(label text, condition boolean)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN condition THEN 'PASS  ' ELSE 'FAIL  ' END || label;
$$;

\echo ''
\echo '=============================================================='
\echo ' 1. TABLES EXIST (and only the three Offerr tables)'
\echo '=============================================================='
SELECT pg_temp.chk('offerr_evaluation_requests exists',
  to_regclass('public.offerr_evaluation_requests') IS NOT NULL);
SELECT pg_temp.chk('offerr_evaluations exists',
  to_regclass('public.offerr_evaluations') IS NOT NULL);
SELECT pg_temp.chk('offerr_evaluation_events exists',
  to_regclass('public.offerr_evaluation_events') IS NOT NULL);
SELECT pg_temp.chk('exactly 3 offerr_* tables created (no extras)',
  (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'offerr%') = 3);
SELECT pg_temp.chk('offerr_touch_updated_at() function exists',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='offerr_touch_updated_at') = 1);
SELECT pg_temp.chk('exactly 1 offerr_* function created (no extras)',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'offerr%') = 1);

\echo ''
\echo '=============================================================='
\echo ' 2. COLUMN CONTRACT — types, nullability, defaults'
\echo '=============================================================='
SELECT table_name, ordinal_position AS pos, column_name, data_type,
       is_nullable AS nullable, column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name LIKE 'offerr%'
ORDER BY table_name, ordinal_position;

\echo '-- timestamp convention: every timestamp column must be timestamptz --'
SELECT pg_temp.chk('all offerr timestamp columns are timestamptz',
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name LIKE 'offerr%'
      AND data_type = 'timestamp without time zone'));
SELECT pg_temp.chk('all offerr PKs default to gen_random_uuid()',
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name LIKE 'offerr%'
      AND column_name='id' AND column_default LIKE 'gen_random_uuid()%') = 3);

\echo ''
\echo '=============================================================='
\echo ' 3. UNIQUENESS + CHECK CONSTRAINTS'
\echo '=============================================================='
SELECT pg_temp.chk('idempotency_key UNIQUE exists',
  EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname='offerr_eval_requests_idempotency_unique' AND contype='u'));
SELECT pg_temp.chk('(request_id, evaluation_version) UNIQUE exists',
  EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname='offerr_evaluations_request_version_unique' AND contype='u'));

\echo '-- resolution_status CHECK must accept exactly the 5 documented values --'
SELECT pg_temp.chk('resolution CHECK includes RESOLVED',
  pg_get_constraintdef(oid) LIKE '%RESOLVED%') FROM pg_constraint
  WHERE conname='offerr_eval_requests_resolution_check';
SELECT pg_temp.chk('resolution CHECK includes AMBIGUOUS',
  pg_get_constraintdef(oid) LIKE '%AMBIGUOUS%') FROM pg_constraint
  WHERE conname='offerr_eval_requests_resolution_check';
SELECT pg_temp.chk('resolution CHECK includes NOT_FOUND',
  pg_get_constraintdef(oid) LIKE '%NOT_FOUND%') FROM pg_constraint
  WHERE conname='offerr_eval_requests_resolution_check';
SELECT pg_temp.chk('resolution CHECK includes INVALID_INPUT',
  pg_get_constraintdef(oid) LIKE '%INVALID_INPUT%') FROM pg_constraint
  WHERE conname='offerr_eval_requests_resolution_check';
SELECT pg_temp.chk('resolution CHECK includes UNSUPPORTED',
  pg_get_constraintdef(oid) LIKE '%UNSUPPORTED%') FROM pg_constraint
  WHERE conname='offerr_eval_requests_resolution_check';

\echo '-- full constraint definitions --'
SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conrelid::regclass::text LIKE 'offerr%' AND contype IN ('c','u','f')
ORDER BY conrelid::regclass::text, conname;

\echo ''
\echo '=============================================================='
\echo ' 4. FOREIGN KEYS — targets and delete behaviour'
\echo '=============================================================='
SELECT conname, conrelid::regclass AS child, confrelid::regclass AS parent,
       CASE confdeltype WHEN 'a' THEN 'NO ACTION (refuses orphaning)'
                        WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                        WHEN 'n' THEN 'SET NULL' ELSE confdeltype::text END AS on_delete
FROM pg_constraint WHERE contype='f' AND conrelid::regclass::text LIKE 'offerr%'
ORDER BY conname;
SELECT pg_temp.chk('no Offerr FK cascades deletes (parent delete must be refused)',
  NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE contype='f' AND conrelid::regclass::text LIKE 'offerr%' AND confdeltype='c'));

\echo ''
\echo '=============================================================='
\echo ' 5. INDEXES'
\echo '=============================================================='
SELECT tablename, indexname, indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename LIKE 'offerr%' ORDER BY tablename, indexname;

SELECT pg_temp.chk('property lookup index (requests)',
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_offerr_eval_requests_property'));
SELECT pg_temp.chk('created_at operational index (requests)',
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_offerr_eval_requests_created'));
SELECT pg_temp.chk('evaluation lookup/version index',
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_offerr_evaluations_request'));
SELECT pg_temp.chk('evaluation property index',
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_offerr_evaluations_property'));
SELECT pg_temp.chk('evaluation outcome/created index',
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_offerr_evaluations_outcome_created'));
SELECT pg_temp.chk('event dedupe PARTIAL unique index',
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='uq_offerr_eval_events_dedupe_key'
    AND indexdef LIKE '%WHERE (dedupe_key IS NOT NULL)%'));
SELECT pg_temp.chk('event request index',
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_offerr_eval_events_request'));

\echo ''
\echo '=============================================================='
\echo ' 6. ROW LEVEL SECURITY'
\echo '=============================================================='
SELECT relname AS table_name, relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
FROM pg_class WHERE relname LIKE 'offerr%' AND relkind='r' ORDER BY relname;
SELECT pg_temp.chk('RLS enabled on all 3 Offerr tables',
  (SELECT count(*) FROM pg_class WHERE relname LIKE 'offerr%' AND relkind='r' AND relrowsecurity) = 3);

SELECT tablename, policyname, roles, cmd FROM pg_policies
WHERE schemaname='public' AND tablename LIKE 'offerr%' ORDER BY tablename;
SELECT pg_temp.chk('every Offerr policy targets service_role only',
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename LIKE 'offerr%' AND NOT (roles = '{service_role}')));

\echo ''
\echo '=============================================================='
\echo ' 7. GRANTS — anon/authenticated must have NOTHING'
\echo '=============================================================='
SELECT grantee, table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE table_schema='public' AND table_name LIKE 'offerr%'
  AND grantee IN ('anon','authenticated','service_role','PUBLIC')
GROUP BY grantee, table_name ORDER BY grantee, table_name;

SELECT pg_temp.chk('anon has ZERO privileges on Offerr tables',
  NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name LIKE 'offerr%' AND grantee='anon'));
SELECT pg_temp.chk('authenticated has ZERO privileges on Offerr tables',
  NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name LIKE 'offerr%' AND grantee='authenticated'));
SELECT pg_temp.chk('PUBLIC has ZERO privileges on Offerr tables',
  NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name LIKE 'offerr%' AND grantee='PUBLIC'));
SELECT pg_temp.chk('service_role can write requests (SELECT/INSERT/UPDATE/DELETE)',
  (SELECT count(DISTINCT privilege_type) FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='offerr_evaluation_requests'
      AND grantee='service_role'
      AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')) = 4);
SELECT pg_temp.chk('evaluations are append-only for service_role (no UPDATE/DELETE grant)',
  NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='offerr_evaluations'
      AND grantee='service_role' AND privilege_type IN ('UPDATE','DELETE')));
SELECT pg_temp.chk('events are append-only for service_role (no UPDATE/DELETE grant)',
  NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='offerr_evaluation_events'
      AND grantee='service_role' AND privilege_type IN ('UPDATE','DELETE')));

\echo '-- no Offerr data is reachable through a public RPC --'
SELECT pg_temp.chk('no public function exposes offerr internals to anon/authenticated',
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE '%offerr%'
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))));

\echo ''
\echo '=============================================================='
\echo ' 8. TRIGGER + FEATURE FLAG'
\echo '=============================================================='
SELECT tgname, tgrelid::regclass AS table_name, pg_get_triggerdef(oid) AS def
FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'offerr%';
SELECT pg_temp.chk('updated_at trigger exists on requests only',
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
    AND tgrelid::regclass::text LIKE 'offerr%') = 1);

SELECT key, value FROM public.system_control WHERE key='offerr_evaluation_enabled';
SELECT pg_temp.chk('offerr_evaluation_enabled seeded and DISABLED',
  (SELECT value FROM public.system_control WHERE key='offerr_evaluation_enabled') = 'false');

\echo ''
\echo '=============================================================='
\echo ' 9. BEHAVIOURAL PROBES'
\echo '=============================================================='
-- Each probe runs for real and records its own verdict. PL/pgSQL EXCEPTION
-- blocks (implicit savepoints) are used instead of psql \echo, because \echo
-- is a client meta-command that prints unconditionally and would report a
-- rejected-as-designed INSERT as if it had succeeded.
--
-- Run as the schema owner / an admin role: the cleanup at the end deletes the
-- probe rows, which service_role is (correctly) not granted on evaluations.

CREATE TEMP TABLE probe_results (seq serial, label text, passed boolean);

DO $probe$
DECLARE
  req_id  uuid := '11111111-1111-4111-8111-111111111111';
  touched timestamptz;
  created timestamptz;
BEGIN
  -- 9a. resolution_status CHECK rejects an out-of-vocabulary value
  BEGIN
    INSERT INTO public.offerr_evaluation_requests
      (idempotency_key, raw_submitted_address, normalized_submitted_address,
       spine_version, resolution_status)
    VALUES ('PROBE-BAD-STATUS','1 Probe St','1 probe st','probe','TOTALLY_BOGUS');
    INSERT INTO probe_results (label, passed)
      VALUES ('resolution CHECK rejects out-of-vocabulary status', false);
  EXCEPTION WHEN check_violation THEN
    INSERT INTO probe_results (label, passed)
      VALUES ('resolution CHECK rejects out-of-vocabulary status', true);
  END;

  -- seed parent row with a deliberately backdated updated_at so the trigger
  -- assertion is meaningful (now() is frozen within a transaction)
  INSERT INTO public.offerr_evaluation_requests
    (id, idempotency_key, raw_submitted_address, normalized_submitted_address,
     spine_version, resolution_status, created_at, updated_at)
  VALUES (req_id,'PROBE-DUP','1 Probe St','1 probe st','probe','RESOLVED',
          now() - interval '1 day', now() - interval '1 day');

  -- 9b. idempotency_key uniqueness is enforced
  BEGIN
    INSERT INTO public.offerr_evaluation_requests
      (idempotency_key, raw_submitted_address, normalized_submitted_address,
       spine_version, resolution_status)
    VALUES ('PROBE-DUP','2 Other St','2 other st','probe','RESOLVED');
    INSERT INTO probe_results (label, passed)
      VALUES ('idempotency_key UNIQUE rejects a duplicate key', false);
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO probe_results (label, passed)
      VALUES ('idempotency_key UNIQUE rejects a duplicate key', true);
  END;

  -- 9c. updated_at trigger fires on UPDATE
  UPDATE public.offerr_evaluation_requests SET source='probe-touch' WHERE id=req_id;
  SELECT updated_at, created_at INTO touched, created
    FROM public.offerr_evaluation_requests WHERE id=req_id;
  INSERT INTO probe_results (label, passed)
    VALUES ('updated_at trigger advances updated_at on UPDATE', touched > created);

  -- 9d. evaluation version uniqueness
  INSERT INTO public.offerr_evaluations
    (id, request_id, evaluation_version, outcome, seller_projection,
     internal_result, provenance, spine_version, computed_at)
  VALUES ('22222222-2222-4222-8222-222222222222', req_id, 1,'REVIEW_REQUIRED',
          '{}','{}','{}','probe', now());
  BEGIN
    INSERT INTO public.offerr_evaluations
      (request_id, evaluation_version, outcome, seller_projection,
       internal_result, provenance, spine_version, computed_at)
    VALUES (req_id, 1,'REVIEW_REQUIRED','{}','{}','{}','probe', now());
    INSERT INTO probe_results (label, passed)
      VALUES ('(request_id, evaluation_version) UNIQUE rejects a duplicate version', false);
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO probe_results (label, passed)
      VALUES ('(request_id, evaluation_version) UNIQUE rejects a duplicate version', true);
  END;

  -- 9e. version+1 re-evaluation IS allowed (immutable snapshot history)
  BEGIN
    INSERT INTO public.offerr_evaluations
      (request_id, evaluation_version, outcome, seller_projection,
       internal_result, provenance, spine_version, computed_at)
    VALUES (req_id, 2,'REVIEW_REQUIRED','{}','{}','{}','probe', now());
    INSERT INTO probe_results (label, passed)
      VALUES ('version+1 re-evaluation snapshot is accepted', true);
  EXCEPTION WHEN others THEN
    INSERT INTO probe_results (label, passed)
      VALUES ('version+1 re-evaluation snapshot is accepted', false);
  END;

  -- 9f. outcome CHECK rejects an unknown outcome
  BEGIN
    INSERT INTO public.offerr_evaluations
      (request_id, evaluation_version, outcome, seller_projection,
       internal_result, provenance, spine_version, computed_at)
    VALUES (req_id, 3,'MADE_UP_OUTCOME','{}','{}','{}','probe', now());
    INSERT INTO probe_results (label, passed)
      VALUES ('outcome CHECK rejects an unknown outcome', false);
  EXCEPTION WHEN check_violation THEN
    INSERT INTO probe_results (label, passed)
      VALUES ('outcome CHECK rejects an unknown outcome', true);
  END;

  -- 9g. unsafe parent deletion is REFUSED while children exist
  BEGIN
    DELETE FROM public.offerr_evaluation_requests WHERE id=req_id;
    INSERT INTO probe_results (label, passed)
      VALUES ('parent request delete REFUSED while evaluations reference it', false);
  EXCEPTION WHEN foreign_key_violation THEN
    INSERT INTO probe_results (label, passed)
      VALUES ('parent request delete REFUSED while evaluations reference it', true);
  END;

  -- 9h. event dedupe_key partial unique: duplicates blocked
  INSERT INTO public.offerr_evaluation_events (request_id, event_type, dedupe_key)
  VALUES (req_id,'probe.evt','PROBE-DEDUPE');
  BEGIN
    INSERT INTO public.offerr_evaluation_events (request_id, event_type, dedupe_key)
    VALUES (req_id,'probe.evt','PROBE-DEDUPE');
    INSERT INTO probe_results (label, passed)
      VALUES ('event dedupe_key UNIQUE rejects a duplicate', false);
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO probe_results (label, passed)
      VALUES ('event dedupe_key UNIQUE rejects a duplicate', true);
  END;

  -- 9i. multiple NULL dedupe_keys allowed (partial index scope)
  BEGIN
    INSERT INTO public.offerr_evaluation_events (request_id, event_type, dedupe_key)
    VALUES (req_id,'probe.evt', NULL);
    INSERT INTO public.offerr_evaluation_events (request_id, event_type, dedupe_key)
    VALUES (req_id,'probe.evt', NULL);
    INSERT INTO probe_results (label, passed)
      VALUES ('multiple NULL dedupe_keys allowed (partial index scope correct)', true);
  EXCEPTION WHEN others THEN
    INSERT INTO probe_results (label, passed)
      VALUES ('multiple NULL dedupe_keys allowed (partial index scope correct)', false);
  END;
END
$probe$;

SELECT pg_temp.chk(label, passed) FROM probe_results ORDER BY seq;

\echo '-- probe cleanup --'
DELETE FROM public.offerr_evaluation_events
  WHERE request_id='11111111-1111-4111-8111-111111111111';
DELETE FROM public.offerr_evaluations
  WHERE request_id='11111111-1111-4111-8111-111111111111';
DELETE FROM public.offerr_evaluation_requests
  WHERE idempotency_key LIKE 'PROBE-%';

SELECT pg_temp.chk('probe cleanup left zero probe rows',
  (SELECT count(*) FROM public.offerr_evaluation_requests
    WHERE idempotency_key LIKE 'PROBE-%') = 0
  AND (SELECT count(*) FROM public.offerr_evaluations
    WHERE spine_version='probe') = 0);

\echo ''
\echo '=============================================================='
\echo ' 10. SIDE-EFFECT SURFACE — Offerr created no execution objects'
\echo '=============================================================='
SELECT pg_temp.chk('migration created no view',
  NOT EXISTS (SELECT 1 FROM pg_views WHERE schemaname='public' AND viewname LIKE 'offerr%'));
SELECT pg_temp.chk('migration created no sequence',
  NOT EXISTS (SELECT 1 FROM pg_sequences WHERE schemaname='public' AND sequencename LIKE 'offerr%'));
SELECT pg_temp.chk('migration created no publication membership',
  NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE tablename LIKE 'offerr%'));
