-- Access-control proof for the two durability primitives.
--
-- Run against a DISPOSABLE local Postgres AFTER applying
--   supabase/migrations/20260831000000_durable_run_locks_and_idempotency_ledger.sql
-- TWICE, with the Supabase roles present:
--
--   psql -f scripts/proof/durable-state-access-control-proof.sql
--
-- Proves the migration is idempotent with respect to privileges: a re-run must
-- not restore PostgreSQL's default PUBLIC EXECUTE grant on the new functions.
--
-- Expected: every anon/authenticated statement raises "permission denied";
-- every service_role statement succeeds.

\set ON_ERROR_STOP off

\echo '=== ANON: RPC execution (expect DENIED) ==='
SET ROLE anon;
SELECT public.run_lock_force_release('x','y');
SELECT public.idempotency_complete('s','k');
SELECT public.run_lock_acquire('x', gen_random_uuid());
\echo '=== ANON: table mutation (expect DENIED) ==='
INSERT INTO public.run_locks(lock_key,lease_token,lease_until) VALUES ('hack',gen_random_uuid(),now()+interval '1h');
UPDATE public.idempotency_ledger SET status='completed';
DELETE FROM public.run_locks;
SELECT count(*) FROM public.run_locks;
RESET ROLE;

\echo ''
\echo '=== AUTHENTICATED: RPC execution (expect DENIED) ==='
SET ROLE authenticated;
SELECT public.run_lock_acquire('x', gen_random_uuid());
SELECT public.idempotency_begin('s','k', gen_random_uuid());
SELECT public.idempotency_purge_expired();
\echo '=== AUTHENTICATED: table mutation (expect DENIED) ==='
INSERT INTO public.idempotency_ledger(scope,key) VALUES ('hack','hack');
UPDATE public.run_locks SET status='released';
SELECT count(*) FROM public.idempotency_ledger;
RESET ROLE;

\echo ''
\echo '=== SERVICE_ROLE: intended execution (expect SUCCESS) ==='
SET ROLE service_role;
SELECT 'acquire  -> '||(public.run_lock_acquire('svc-lock', gen_random_uuid(), 'svc', 60000)->>'reason');
SELECT 'begin    -> '||(public.idempotency_begin('svc','evt-1', gen_random_uuid())->>'reason');
SELECT 'complete -> '||(public.idempotency_complete('svc','evt-1','done')->>'reason');
SELECT 'duplicate-> '||(public.idempotency_begin('svc','evt-1', gen_random_uuid())->>'reason');
SELECT 'force    -> '||(public.run_lock_force_release('svc-lock','manual')->>'reason');
SELECT 'purge    -> '||(public.idempotency_purge_expired()->>'ok');
RESET ROLE;

\echo ''
\echo '=== PRIVILEGE MATRIX (expect anon=f auth=f service=t for every row) ==='
SELECT p.proname
     ||' anon='||has_function_privilege('anon', p.oid, 'EXECUTE')::text
     ||' auth='||has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
     ||' service='||has_function_privilege('service_role', p.oid, 'EXECUTE')::text
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (p.proname LIKE 'run_lock%' OR p.proname LIKE 'idempotency%')
ORDER BY p.proname;
