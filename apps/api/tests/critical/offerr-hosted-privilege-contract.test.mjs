/**
 * Offerr hosted privilege contract — regression guard for the two privilege
 * mechanisms that hosted Supabase applies and a bare PostgreSQL container does
 * not.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * The Offerr migration originally contained only:
 *
 *   REVOKE ALL ON FUNCTION public.offerr_touch_updated_at() FROM PUBLIC;
 *
 * That is sufficient on stock PostgreSQL, where the only EXECUTE grant on a new
 * function is the implicit one to PUBLIC. It is NOT sufficient on hosted
 * Supabase, which additionally seeds
 *
 *   ALTER DEFAULT PRIVILEGES IN SCHEMA public
 *     GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
 *
 * Those materialise as EXPLICIT per-role grants, and revoking from PUBLIC does
 * not remove an explicit role grant. On the hosted preview branch the resulting
 * ACL was {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,
 * service_role=X/postgres} — anon and authenticated held EXECUTE on an internal
 * Offerr routine while every catalog check about *tables* passed.
 *
 * Requires OFFERR_VERIFY_DATABASE_URL pointing at a disposable database that
 * has had offerr-supabase-prereqs.sql (or hosted Supabase's own defaults), the
 * staging bootstrap, and the Offerr migration applied. Skips without it, the
 * same way the other database-backed Offerr contract suites do.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import pg from 'pg';

const DATABASE_URL = process.env.OFFERR_VERIFY_DATABASE_URL || '';
const SKIP = !DATABASE_URL;

test(
  'Offerr hosted privilege contract',
  { skip: SKIP ? 'OFFERR_VERIFY_DATABASE_URL not set' : false },
  async (t) => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    t.after(() => pool.end());

    await t.test('no offerr_* routine is executable by anon or authenticated', async () => {
      const { rows } = await pool.query(`
        SELECT p.proname,
               has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_exec,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed_exec,
               coalesce(p.proacl::text, '(default)') AS acl
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE '%offerr%'
      `);

      assert.ok(rows.length > 0, 'expected at least one offerr_* routine to exist');

      const leaking = rows.filter((r) => r.anon_exec || r.authed_exec);
      assert.deepEqual(
        leaking.map((r) => `${r.proname} ${r.acl}`),
        [],
        'anon/authenticated must hold no EXECUTE on any offerr_* routine. '
          + 'REVOKE ... FROM PUBLIC alone does not remove the explicit per-role '
          + 'grants that Supabase ALTER DEFAULT PRIVILEGES creates.',
      );
    });

    await t.test('the updated_at trigger function is owner-only', async () => {
      const { rows } = await pool.query(`
        SELECT coalesce(p.proacl::text, '(default)') AS acl
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'offerr_touch_updated_at'
      `);
      assert.equal(rows.length, 1, 'offerr_touch_updated_at must exist exactly once');

      const acl = rows[0].acl;
      // A non-default ACL that names no API role is what "owner-only" looks
      // like. '(default)' would mean the PUBLIC grant was never revoked at all.
      assert.notEqual(acl, '(default)', 'implicit PUBLIC EXECUTE grant was never revoked');
      for (const role of ['anon', 'authenticated', 'service_role']) {
        assert.ok(
          !acl.includes(`${role}=`),
          `${role} must not appear in the trigger function ACL, got ${acl}`,
        );
      }
    });

    await t.test('anon and authenticated hold zero privileges on offerr_* tables', async () => {
      const { rows } = await pool.query(`
        SELECT table_name, grantee, privilege_type
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name LIKE 'offerr%'
          AND grantee IN ('anon', 'authenticated', 'PUBLIC')
      `);
      assert.deepEqual(
        rows.map((r) => `${r.grantee}:${r.privilege_type} on ${r.table_name}`),
        [],
      );
    });

    await t.test('evaluations and events remain append-only for service_role', async () => {
      const { rows } = await pool.query(`
        SELECT table_name, privilege_type
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name IN ('offerr_evaluations', 'offerr_evaluation_events')
          AND grantee = 'service_role'
          AND privilege_type IN ('UPDATE', 'DELETE')
      `);
      assert.deepEqual(
        rows.map((r) => `${r.privilege_type} on ${r.table_name}`),
        [],
        'service_role must not be able to mutate a persisted evaluation or event',
      );
    });
  },
);
